const assert = require('assert')
const { Context } = require('./server')
const { Specs } = require('./specs')
const { context, getSection } = require('./context')
const { bodyHash, sectionId } = require('./sections')

const spec = (id, body, extra = {}) => ({ id, namespace: 'netfyr/specs', title: `Document ${id}`, abstract: '',
  status: 'approved', kind: 'feature', superseded: false, dependsOn: [], supersedes: null,
  url: `https://board.test/${id}`, specPath: `specs/${id}.md`, body, ...extra })
const records = [
  spec('a', '# Behavior\n\nShared condition: during startup.\n\n## Address validation\n\nReject an invalid address unless it is explicitly marked tentative.\n\n## Logging\n\nLog state changes.\n'),
  spec('b', '# Performance\n\nMeasure throughput.\n\n## Retry limits\n\nRetry validation after a tentative address becomes ready.\n'),
  spec('old', '# Retired\n\nObsolete validation instructions.\n', { superseded: true }),
  spec('draft', '# Draft\n\nProposed validation behavior.\n', { status: 'draft' }),
  spec('foreign', '# Other\n\nUnrelated validation.\n', { namespace: 'other/specs' })
]

function fixture (docs = records, namespace = ['netfyr/specs']) {
  const ctx = new Context('/tmp/specdoc-context-fixture', 'http://board.test', namespace)
  ctx.specs = new Specs('http://board.test', namespace)
  ctx.specs.all = docs.map(({ body, ...s }) => s)
  ctx.specs.select()
  ctx.index.head = 'abcdef0'
  ctx.specs.fetchedAt = Date.now()
  ctx.log.forFile = () => []
  const reads = []
  ctx.specs.document = async s => {
    reads.push(s.id)
    const doc = docs.find(d => d.id === s.id)
    if (doc.error) throw new Error(doc.error)
    return { ...doc, bytes: Buffer.byteLength(JSON.stringify(doc)) }
  }
  return { ctx, reads }
}

async function main () {
  const { ctx, reads } = fixture()
  const args = { task: 'validate address', max_tokens: 1800 }
  const plain = await context(ctx, args)
  assert.match(plain, /Reject an invalid address unless/)
  assert.match(plain, /Shared condition: during startup/)
  assert.doesNotMatch(plain, /Log state changes|Obsolete|Proposed|Unrelated validation/)
  assert.deepStrictEqual(reads.sort(), ['a', 'b'])
  assert.ok(Math.ceil(`${ctx.header()}\n\n${plain}`.length / 4) <= args.max_tokens)
  const ids = [...plain.matchAll(/^(section:\S+)/gm)].map(m => m[1])
  assert.ok(ids.length)
  const receipt = [...plain.matchAll(/^receipt: ([a-f0-9]{64})$/gm)].map(m => m[1])
  assert.strictEqual(ids.length, receipt.length)
  assert.strictEqual(await context(ctx, args), plain, 'no server-wide suppression')
  const repeated = await context(ctx, { ...args, seen: receipt })
  assert.doesNotMatch(repeated, /Reject an invalid address unless/)
  assert.match(repeated, /already held/)
  assert.match(await getSection(ctx, { id: ids[0], max_tokens: 2000 }), /Reject an invalid address|Retry validation/)
  assert.match(await getSection(ctx, { id: ids[0], max_tokens: 50 }), /Nothing from the section was delivered/)
  assert.doesNotMatch(await getSection(ctx, { id: ids[0], max_tokens: 50 }), /receipt:/)

  const draft = await context(ctx, { task: 'unrelated', anchors: ['spec:draft'], max_tokens: 1800 })
  assert.match(draft, /Proposed validation behavior/)
  assert.match(draft, /draft;/)
  const foreign = await context(ctx, { task: 'nothing', anchors: ['spec:foreign'], max_tokens: 1800 })
  assert.match(foreign, /outside scope/)
  assert.match(foreign, /Unrelated validation/)
  await assert.rejects(context(ctx, { task: 'validation', anchors: ['spec:no-such-note'] }), /unknown anchor/)

  const pinnedId = sectionId('a', bodyHash(records[0].body), 2)
  let scored = []
  const ranked = await context(ctx, { task: 'validation', anchors: [pinnedId], max_tokens: 3000 }, {
    rerank: async (task, candidates) => {
      scored = candidates
      return { scores: new Map(candidates.map((c, i) => [c.id, i / candidates.length])), model: 'fixture', reason: 'test scores' }
    }
  })
  assert.ok(scored.every(c => c.id !== pinnedId), 'explicit sections bypass the model')
  assert.match(ranked, /laya: fixture/)
  const fallback = await context(ctx, args, { rerank: async () => { throw new Error('offline') } })
  assert.match(fallback, /lexical order retained/)
  assert.match(fallback, /Reject an invalid address/)

  const nativeTimeout = AbortSignal.timeout
  let readDeadline
  AbortSignal.timeout = () => {
    readDeadline = new AbortController()
    return readDeadline.signal
  }
  try {
    const slowRanking = await context(ctx, args, {
      rerank: async (task, candidates, { signal }) => {
        readDeadline.abort()
        assert.ok(readDeadline.signal.aborted, 'document read deadline elapsed after the documents were received')
        assert.ok(!signal?.aborted, 'finished document reads do not cancel a separately budgeted model call')
        return { scores: new Map(candidates.map(c => [c.id, 0.5])), model: 'fixture', reason: 'slow model' }
      }
    })
    assert.match(slowRanking, /laya: fixture; slow model/)
    assert.doesNotMatch(slowRanking, /selection deadline reached/)
  } finally { AbortSignal.timeout = nativeTimeout }

  const rankingCancellation = new AbortController()
  const cancelledRanking = await context(ctx, args, {
    signal: rankingCancellation.signal,
    rerank: async (task, candidates, { signal }) => {
      assert.strictEqual(signal, rankingCancellation.signal, 'caller cancellation still reaches the model')
      rankingCancellation.abort()
      assert.ok(signal.aborted)
      return { scores: null, model: null, reason: 'cancelled' }
    }
  })
  assert.match(cancelledRanking, /ranking: lexical; cancelled/)

  const readCancellation = new AbortController()
  const caller = new AbortController()
  const slowSource = fixture([spec('slow-source', '# Read deadline\n\nRequired context.\n')])
  slowSource.ctx.specs.document = async (s, { signal }) => {
    assert.notStrictEqual(signal, caller.signal, 'reads also need their own deadline')
    const pending = new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('read deadline')), { once: true }))
    readCancellation.abort()
    return pending
  }
  AbortSignal.timeout = () => readCancellation.signal
  try {
    const boundedReads = await context(slowSource.ctx, { task: 'context', anchors: ['spec:slow-source'] }, { signal: caller.signal })
    assert.match(boundedReads, /selection deadline reached/)
    assert.match(boundedReads, /required gaps: 1/)
    assert.ok(!caller.signal.aborted, 'a document timeout does not abort its caller')
  } finally { AbortSignal.timeout = nativeTimeout }

  const evidence = fixture([
    spec('requirement', '# Address\n\n## Requirements\n\n- **FR-001**: Address validation must preserve the previous configuration on failure.\n'),
    spec('background', '# Address history\n\nAddress validation has been discussed for several releases.\n')
  ])
  const preferred = await context(evidence.ctx, { task: 'address validation', max_tokens: 2000 }, {
    rerank: async (task, candidates) => ({ scores: new Map(candidates.map(c => [c.id, c.id.includes('background') ? 1 : 0])), model: 'fixture', reason: 'test scores' })
  })
  assert.ok(preferred.indexOf('Address validation must preserve') < preferred.indexOf('Address validation has been discussed'), 'optional model ranking cannot displace matching requirements with background text')

  const inherited = fixture([
    spec('target', '# Target\n\nAddress validation.\n', { dependsOn: ['base'] }),
    spec('base', '# Base\n\nKeep a recovery path.\n'),
    spec('noise', '# Noise\n\nAddress validation in unrelated tooling.\n')
  ])
  const protectedResult = await context(inherited.ctx, { task: 'address', anchors: ['spec:target'], max_docs: 2, max_tokens: 2000 })
  assert.deepStrictEqual(inherited.reads, ['target', 'base'], 'dependency fetches beat optional source reads')
  assert.match(protectedResult, /Keep a recovery path/)
  const cap = await context(inherited.ctx, { task: 'address', anchors: ['spec:target'], max_docs: 1, max_tokens: 1500 })
  assert.match(cap, /required source not read: spec:base/)
  assert.match(cap, /required gaps: 1/)

  const changed = fixture([spec('changed', '# Current\n\nvalidation\n')])
  changed.ctx.specs.document = async () => ({ ...spec('changed', '# Current\n\nvalidation\n', { status: 'draft' }), bytes: 50 })
  const current = await context(changed.ctx, { task: 'validation' })
  assert.doesNotMatch(current, /^receipt:/m)
  assert.match(current, /lifecycle changed/)

  const missing = fixture([spec('missing', '# Required\n\nAddress validation.\n', { dependsOn: ['outside/missing#9'] })])
  const unresolved = await context(missing.ctx, { task: 'address', anchors: ['spec:missing'] })
  assert.match(unresolved, /required gaps: 1/)
  assert.match(unresolved, /unresolved or outside-scope dependency/)

  const timed = fixture([spec('slow', '# Slow\n\nAddress validation.\n')])
  const controller = new AbortController()
  timed.ctx.specs.document = (s, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('deadline')), { once: true }))
  const timer = setTimeout(() => controller.abort(), 10)
  const expired = await context(timed.ctx, { task: 'address', anchors: ['spec:slow'] }, { signal: controller.signal })
  clearTimeout(timer)
  assert.match(expired, /selection deadline reached/)
  assert.match(expired, /required gaps: 1/)
  assert.doesNotMatch(expired, /receipt:/)

  const longDocs = [spec('huge', `# Large\n\n${'validation '.repeat(900)}`), spec('short', '# Small\n\nvalidation fits.\n')]
  const long = fixture(longDocs)
  const compact = await context(long.ctx, { task: 'validation', max_tokens: 1000 })
  assert.match(compact, /validation fits/)
  assert.match(compact, /omitted: section:huge/)
  assert.ok(Math.ceil(`${long.ctx.header()}\n\n${compact}`.length / 4) <= 1000)
  assert.ok(compact.length < longDocs.reduce((n, doc) => n + doc.body.length, 0) / 2, 'complete packet including receipts uses less than half the source text')

  const api = new Specs('http://board.test')
  const realFetch = global.fetch
  try {
    global.fetch = async () => new Response(JSON.stringify(records[0]))
    assert.strictEqual((await api.document(records[0])).body, records[0].body)
    global.fetch = async () => new Response(JSON.stringify({ ...records[0], id: 'forged' }))
    await assert.rejects(api.document(records[0]), /invalid document/)
    global.fetch = async () => new Response('x'.repeat(2048))
    await assert.rejects(api.document(records[0], { maxBytes: 128 }), /exceeds 128 bytes/)
    global.fetch = async () => new Response('{}', { status: 403 })
    await assert.rejects(api.document(records[0]), /HTTP 403/)
  } finally { global.fetch = realFetch }
}

main().then(() => console.log('context selector ok'), e => { console.error(e); process.exitCode = 1 })
