const assert = require('assert/strict')
const { test } = require('node:test')
const { EventEmitter } = require('events')
const { PassThrough } = require('stream')
const crypto = require('crypto')
const { endpoint, publicAddress, validatedLookup, modelRequest } = require('./model-client')
const { encryptSecret, decryptSecret } = require('./model-credentials')
const { WindowLimiter, BoundedCache, concurrencyLimit, boundedJson, monitoringAccess, webhookText } = require('./request-controls')

test('metadata rejects alias expansion and excessive nesting before later coercion', () => {
  const { frontmatter } = require('./server')
  assert.deepEqual(frontmatter('---\ntags: [spec]\nnamespace: team/specs\n---\nBody').meta.tags, ['spec'])
  assert.deepEqual(frontmatter('---\ntags: &tags [spec]\ncopy: *tags\n---\nBody').meta, {})
  assert.deepEqual(frontmatter('---\ntags: ' + '['.repeat(32) + 'spec' + ']'.repeat(32) + '\n---\nBody').meta, {})
})

test('model URL policy rejects local, ambiguous and unapproved destinations', () => {
  const origins = ['https://model.example', 'https://127.0.0.1', 'https://[::ffff:127.0.0.1]', 'http://127.0.0.1:8080']
  assert.equal(endpoint('https://model.example/api', { origins }).pathname, '/api')
  for (const url of ['http://model.example', 'https://evil.example', 'https://model.example/?secret=x',
    'https://user:password@model.example', 'https://model.example/#fragment', 'https://127.0.0.1', 'https://[::ffff:127.0.0.1]']) {
    assert.throws(() => endpoint(url, { origins }), /endpoint/i, url)
  }
  assert.equal(endpoint('http://127.0.0.1:8080', { origins, allowLoopback: true }).hostname, '127.0.0.1')
  for (const ip of ['0.0.0.0', '127.0.0.1', '10.2.3.4', '172.16.1.1', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '192.0.0.8', '192.88.99.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd00::1', 'febf::1', 'ff02::1', '::ffff:127.0.0.1', '64:ff9b::a00:1', '::7f00:1', '::a9fe:a9fe']) assert.equal(publicAddress(ip), false, ip)
  assert.equal(publicAddress('8.8.8.8'), true)
  assert.equal(publicAddress('2606:4700:4700::1111'), true)
})

test('every DNS answer is checked at connection time, including rebinding', async () => {
  let answers = [{ address: '8.8.8.8', family: 4 }]
  const lookup = validatedLookup({ lookup: async () => answers })
  const resolve = () => new Promise((resolve, reject) => lookup('model.example', { all: true }, (error, result) => error ? reject(error) : resolve(result)))
  assert.deepEqual(await resolve(), answers)
  answers = [...answers, { address: '::ffff:10.0.0.1', family: 6 }]
  await assert.rejects(resolve(), /private or special/)
  answers = [{ address: '127.0.0.1', family: 4 }]
  await assert.rejects(resolve(), /private or special/)
})

function transport (status, headers, body, inspect = () => {}) {
  return (url, options, callback) => {
    inspect(url, options)
    const req = new EventEmitter()
    req.setTimeout = () => {}
    req.destroy = () => {}
    req.end = () => queueMicrotask(() => {
      const res = new PassThrough()
      Object.assign(res, { statusCode: status, headers })
      callback(res)
      if (!res.destroyed) res.end(body)
    })
    return req
  }
}

test('model transport bounds declared/chunked bodies and rejects redirects and wrong shapes', async () => {
  const options = { origins: ['https://model.example'], maxBytes: 512, apiKey: 'key',
    request: transport(200, { 'content-type': 'application/json' }, JSON.stringify({ choices: [{ message: { content: '{"comments":[]}' } }] }), (url, opt) => {
      assert.equal(url.hostname, 'model.example')
      assert.equal(opt.agent, false)
      assert.equal(typeof opt.lookup, 'function')
      assert.equal(opt.headers.Authorization, 'Bearer key')
    }) }
  assert.deepEqual(await modelRequest('https://model.example', {}, options), { comments: [] })
  let developmentLookup
  await modelRequest('https://model.example', {}, { ...options, allowLoopback: true,
    lookup: async () => [{ address: '127.0.0.1', family: 4 }],
    request: transport(200, { 'content-type': 'application/json' }, JSON.stringify({ choices: [{ message: { content: '{}' } }] }),
      (url, opt) => { developmentLookup = opt.lookup }) })
  await assert.rejects(new Promise((resolve, reject) => developmentLookup('model.example', {},
    (error, address) => error ? reject(error) : resolve(address))), /private or special/, 'development loopback is restricted to numeric literal endpoints')
  for (const [status, headers, body, error] of [
    [302, { location: 'https://evil.example' }, '', /HTTP 302/],
    [200, { 'content-type': 'text/html' }, '{}', /must be JSON/],
    [200, { 'content-type': 'application/json', 'content-length': '10000' }, '', /byte limit/],
    [200, { 'content-type': 'application/json' }, 'x'.repeat(513), /byte limit/],
    [200, { 'content-type': 'application/json' }, '{}', /no message/]
  ]) await assert.rejects(modelRequest('https://model.example', {}, { ...options, request: transport(status, headers, body) }), error)
})

test('model credentials are authenticated and bound to bot identity', () => {
  const key = crypto.randomBytes(32)
  const sealed = encryptSecret('secret-value', 'reviewer', key)
  assert.ok(!sealed.includes('secret-value'))
  assert.equal(decryptSecret(sealed, 'reviewer', key), 'secret-value')
  assert.throws(() => decryptSecret(sealed, 'other-bot', key))
  assert.throws(() => decryptSecret(sealed, 'reviewer', crypto.randomBytes(32)))
  assert.throws(() => decryptSecret('plaintext', 'reviewer', key), /migration/)
})

test('saturation cannot reset existing limits and caches evict one entry', async () => {
  let time = 0
  const limiter = new WindowLimiter({ capacity: 2, now: () => time })
  assert.equal(limiter.take('one', 1), true)
  assert.equal(limiter.take('two', 1), true)
  assert.equal(limiter.take('three', 1), false)
  assert.equal(limiter.take('one', 1), false)
  time = 10001
  assert.equal(limiter.take('three', 1), true)
  const cache = new BoundedCache(2, 100, () => time)
  cache.set('a', 1); cache.set('b', 2); assert.equal(cache.get('a'), 1); cache.set('c', 3)
  assert.equal(cache.get('b'), undefined); assert.equal(cache.get('a'), 1)
  time += 101
  assert.equal(cache.get('a'), undefined)
  const run = concurrencyLimit(1)
  let release
  const first = run(() => new Promise(resolve => { release = resolve }))
  await assert.rejects(run(async () => {}), /capacity/)
  release(); await first
  await run(async () => {})
})

test('bounded editor replies, monitoring access and webhook text', async () => {
  assert.deepEqual(await boundedJson(new Response('{"a":1}')), { a: 1 })
  await assert.rejects(boundedJson(new Response('x'.repeat(101)), 100), /byte limit/)
  const token = 'a'.repeat(32)
  assert.equal(monitoringAccess({ headers: { authorization: `Bearer ${token}` } }, token), true)
  assert.equal(monitoringAccess({ headers: { authorization: `Bearer ${token}x` } }, token), false)
  assert.ok(!webhookText('@everyone <@123>\nunsafe').includes('@'))
  assert.ok(!webhookText('@everyone <@123>\nunsafe').includes('\n'))
})
