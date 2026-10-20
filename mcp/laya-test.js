const assert = require('assert')
const { rerank } = require('./laya')

const environment = new Map(['SPECDOC_LAYA_TIMEOUT_MS', 'SPECDOC_LAYA_MAX_CANDIDATES', 'SPECDOC_LAYA_BATCH_SIZE']
  .map(name => [name, process.env[name]]))
for (const name of environment.keys()) delete process.env[name]

const candidates = [
  { id: 'first', heading: 'Renewal', text: 'Preserve the lease during renewal.' },
  { id: 'second', heading: 'Backoff', text: 'Retry after a failed renewal.' }
]
let mode = 'ok'
const calls = []
const valid = count => ({ results: Array.from({ length: count }, (_, i) => ({
  model: 'laya-rl-agent',
  answers: { relevance: { type: 'noul', noul: i ? 0.9 : 0.2 } },
  usage: { truncated: false, state_tokens_dropped: 0, truncated_questions: [] }
})) })
const originalFetch = global.fetch
global.fetch = async (target, options) => {
  assert.strictEqual(options.redirect, 'error')
  assert.strictEqual(options.headers['content-type'], 'application/json')
  const input = JSON.parse(options.body)
  calls.push({ method: options.method, path: new URL(target).pathname, body: input })
  const { signal } = options
  if (mode === 'timeout') {
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  }
  if (mode === 'slow') {
    return new Promise((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer)
        reject(new DOMException('Aborted', 'AbortError'))
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort)
        resolve(new Response(JSON.stringify(valid(input.states.length))))
      }, 180)
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  if (mode === 'stream-timeout') {
    let abort
    return new Response(new ReadableStream({
      start (controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        abort = () => controller.error(new DOMException('Aborted', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
      },
      cancel () { signal.removeEventListener('abort', abort) }
    }))
  }
  if (mode === 'http-error') return new Response('busy', { status: 503 })
  if (mode === 'redirect') throw new TypeError('fetch failed: unexpected redirect')
  if (mode === 'oversize') {
    return new Response(new ReadableStream({
      start (controller) {
        controller.enqueue(new Uint8Array(130000))
        controller.enqueue(new Uint8Array(140000))
        controller.close()
      }
    }))
  }
  if (mode === 'declared-oversize') return new Response('x', { headers: { 'content-length': '300000' } })
  if (mode === 'malformed') return new Response('{broken')
  const output = valid(input.states.length)
  if (mode === 'missing-row') output.results.pop()
  if (mode === 'truncated') output.results[1].usage.truncated = true
  if (mode === 'missing-usage') delete output.results[1].usage
  if (mode === 'dropped') output.results[1].usage.state_tokens_dropped = 1
  if (mode === 'questions') output.results[1].usage.truncated_questions.push('relevance')
  if (mode === 'bad-questions') output.results[1].usage.truncated_questions = 'none'
  if (mode === 'missing-answer') delete output.results[1].answers.relevance
  if (mode === 'bad-type') output.results[1].answers.relevance.type = 'score'
  if (mode === 'string') output.results[1].answers.relevance.noul = '0.9'
  if (mode === 'null') output.results[1].answers.relevance.noul = null
  if (mode === 'negative') output.results[1].answers.relevance.noul = -0.1
  if (mode === 'too-high') output.results[1].answers.relevance.noul = 1.1
  return new Response(JSON.stringify(output), { headers: { 'content-type': 'application/json' } })
}

async function main () {
  const url = 'http://127.0.0.1:54321'
  const call = options => rerank('Fix renewal retries', candidates, { url, ...options })
  assert.deepStrictEqual(await call({ url: '' }), { scores: null, model: null, reason: 'disabled' })
  assert.strictEqual(calls.length, 0)
  for (const bad of ['https://example.com', 'http://127.0.0.1.example.com', 'file:///tmp/model',
    'http://user:secret@127.0.0.1', url + '?key=value', url + '#fragment', 'invalid']) {
    assert.strictEqual((await call({ url: bad })).reason, 'invalid local Laya URL')
  }
  assert.strictEqual(calls.length, 0)
  const result = await call({ model: 'english' })
  assert.deepStrictEqual([...result.scores], [['first', 0.2], ['second', 0.9]])
  assert.strictEqual(result.model, 'english')
  assert.deepStrictEqual(calls[0], {
    method: 'POST', path: '/v1/systemone/batch', body: {
      model: 'english',
      states: candidates.map(c => `Task:\nFix renewal retries\n\nSection: ${c.heading}\n${c.text}`),
      questions: { relevance: { type: 'noul', instructions: 'Does this section contain information useful for the task?' } },
      max_len: 512, batch_size: 8
    }
  })
  await call({ url: url + '/local/' })
  assert.strictEqual(calls.at(-1).path, '/local/v1/systemone/batch')

  const many = Array.from({ length: 20 }, (_, i) => ({ ...candidates[0], id: `candidate-${i}` }))
  const bounded = await rerank('Retry', [{ ...candidates[0], id: 'oversize', text: 'x'.repeat(6001) }, ...many], { url })
  assert.strictEqual(bounded.scores.size, 16)
  assert.ok(!bounded.scores.has('oversize'))
  assert.ok(!bounded.scores.has('candidate-16'))
  assert.strictEqual(calls.at(-1).body.states.length, 16)
  const limited = await rerank('Retry', many, { url, maxCandidates: 4, batchSize: 1, timeout: 60000 })
  assert.deepStrictEqual([...limited.scores.keys()], many.slice(0, 4).map(c => c.id))
  assert.strictEqual(calls.at(-1).body.states.length, 4)
  assert.strictEqual(calls.at(-1).body.batch_size, 1)
  assert.match(limited.reason, /^scored 4 candidates; 16 unscored; elapsed \d+ ms; batch_size=1$/)
  assert.ok((await call({ timeout: 5001 })).scores, 'an explicit diagnostic timeout can exceed five seconds')
  const before = calls.length
  assert.strictEqual((await rerank('x'.repeat(2001), candidates, { url })).scores, null)
  assert.strictEqual((await rerank('Retry', [{ ...candidates[0], text: 'x'.repeat(6001) }], { url })).scores, null)
  assert.strictEqual((await rerank('Retry', [candidates[0], candidates[0]], { url })).scores, null)
  assert.strictEqual((await call({ timeout: Infinity })).scores, null)
  assert.strictEqual(calls.length, before)
  const cancelled = new AbortController()
  cancelled.abort()
  assert.strictEqual((await call({ signal: cancelled.signal })).reason, 'cancelled')
  assert.strictEqual(calls.length, before)

  for (const bad of ['http-error', 'redirect', 'oversize', 'declared-oversize', 'malformed', 'missing-row',
    'truncated', 'missing-usage', 'dropped', 'questions', 'bad-questions', 'missing-answer', 'bad-type',
    'string', 'null', 'negative', 'too-high']) {
    mode = bad
    const failure = await call()
    assert.strictEqual(failure.scores, null, bad)
    assert.strictEqual(failure.model, null, bad)
  }
  for (const stalled of ['timeout', 'stream-timeout']) {
    mode = stalled
    const start = Date.now()
    assert.strictEqual((await call({ timeout: 100, batchSize: 1 })).reason, 'timeout (100 ms budget; 2 candidates; batch_size=1)')
    assert.ok(Date.now() - start < 1000, 'deadline includes streaming body reads')
  }
  mode = 'timeout'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 40)
  const cancelStarted = Date.now()
  assert.strictEqual((await call({ signal: controller.signal, timeout: 60000 })).reason, 'cancelled')
  assert.ok(Date.now() - cancelStarted < 1000, 'caller cancellation overrides the diagnostic timeout')
  clearTimeout(timer)

  const savedTimeout = process.env.SPECDOC_LAYA_TIMEOUT_MS
  try {
    mode = 'slow'
    process.env.SPECDOC_LAYA_TIMEOUT_MS = '100'
    assert.strictEqual((await call()).reason, 'timeout (100 ms budget; 2 candidates; batch_size=8)')
    process.env.SPECDOC_LAYA_TIMEOUT_MS = 'invalid'
    assert.ok((await call()).scores, 'invalid environment timeout falls back to 2000 ms')
    mode = 'ok'
    for (const value of ['-1', '0', '99', '60001', 'Infinity', 'NaN', '100.5', '']) {
      process.env.SPECDOC_LAYA_TIMEOUT_MS = value
      assert.ok((await call()).scores, `invalid environment timeout ${value} uses the default`)
    }
    for (const value of ['5001', '60000']) {
      process.env.SPECDOC_LAYA_TIMEOUT_MS = value
      assert.ok((await call()).scores, `environment timeout ${value} is supported`)
    }
    for (const value of [0, 99, 60001, 100.5, NaN]) {
      assert.strictEqual((await call({ timeout: value })).reason, 'invalid timeout')
    }
  } finally {
    if (savedTimeout === undefined) delete process.env.SPECDOC_LAYA_TIMEOUT_MS
    else process.env.SPECDOC_LAYA_TIMEOUT_MS = savedTimeout
  }

  const savedCandidates = process.env.SPECDOC_LAYA_MAX_CANDIDATES
  const savedBatch = process.env.SPECDOC_LAYA_BATCH_SIZE
  try {
    for (const [limit, size] of [[1, 1], [4, 2], [16, 8]]) {
      process.env.SPECDOC_LAYA_MAX_CANDIDATES = String(limit)
      process.env.SPECDOC_LAYA_BATCH_SIZE = String(size)
      const result = await rerank('Retry', many, { url })
      assert.deepStrictEqual([...result.scores.keys()], many.slice(0, limit).map(c => c.id))
      assert.strictEqual(calls.at(-1).body.batch_size, size)
    }
    for (const [name, maximum, field] of [
      ['SPECDOC_LAYA_MAX_CANDIDATES', 16, 'states'],
      ['SPECDOC_LAYA_BATCH_SIZE', 8, 'batch_size']
    ]) {
      for (const value of ['', '0', '-1', '1.5', String(maximum + 1), 'Infinity', 'invalid']) {
        process.env[name] = value
        await rerank('Retry', many, { url })
        const actual = calls.at(-1).body[field]
        assert.strictEqual(field === 'states' ? actual.length : actual, maximum, `invalid ${name}=${value} uses its bounded default`)
      }
      delete process.env[name]
    }
    const previousCalls = calls.length
    for (const [option, maximum, reason] of [
      ['maxCandidates', 16, 'invalid candidate limit'],
      ['batchSize', 8, 'invalid batch size']
    ]) {
      for (const value of [0, -1, 1.5, maximum + 1, Infinity, NaN]) {
        assert.strictEqual((await call({ [option]: value })).reason, reason)
      }
    }
    assert.strictEqual(calls.length, previousCalls, 'invalid explicit controls do not send a request')
  } finally {
    if (savedCandidates === undefined) delete process.env.SPECDOC_LAYA_MAX_CANDIDATES
    else process.env.SPECDOC_LAYA_MAX_CANDIDATES = savedCandidates
    if (savedBatch === undefined) delete process.env.SPECDOC_LAYA_BATCH_SIZE
    else process.env.SPECDOC_LAYA_BATCH_SIZE = savedBatch
  }
}

main().then(() => console.log('laya adapter ok (mock HTTP)'), error => { console.error(error); process.exitCode = 1 })
  .finally(() => {
    global.fetch = originalFetch
    for (const [name, value] of environment) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
