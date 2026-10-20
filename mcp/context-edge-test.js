const assert = require('assert')
const { context, getSection } = require('./context')
const { bodyHash, sectionId } = require('./sections')

function fixture (documents, { scope = 'example/specs', repo = '/tmp/edge-repo', url = 'http://board.test' } = {}) {
  const docs = documents.map((doc, i) => ({
    id: String.fromCharCode(97 + i), title: 'Design detail', namespace: 'example/specs',
    status: 'approved', superseded: false, kind: 'feature', dependsOn: [], supersedes: null,
    specPath: `specs/${i}.md`, url: `${url}/${i}`, body: '', ...doc
  }))
  const ids = new Map(docs.flatMap(doc => [[doc.id, doc], [`spec:${doc.id}`, doc]]))
  const reads = []
  const ctx = {
    index: { repo }, log: { forFile: () => [] }, header: () => 'index test: specs current',
    specs: {
      url, scope, specs: docs,
      idOf: doc => `spec:${doc.id}`,
      resolve: id => ids.get(id) || null,
      document: async doc => {
        reads.push(doc.id)
        return { ...ids.get(doc.id), bytes: Buffer.byteLength(ids.get(doc.id).body) }
      }
    },
    specHit: id => ids.has(id) ? { type: 'spec', s: ids.get(id) } : null,
    resolve: id => ids.has(id) ? { type: 'spec', s: ids.get(id) } : null
  }
  return { ctx, docs, reads }
}

const noModel = async () => ({ scores: null, model: null, reason: 'disabled' })
const receipts = output => [...output.matchAll(/^receipt: ([a-f0-9]{64})$/gm)].map(m => m[1])

async function main () {
  const buried = fixture([{ body: `# Timing\n\n${Array.from({ length: 100 }, (_, i) => `word${i}`).join(' ')}\n\nRetryneedle must be honored before expiration.\n` }])
  const buriedOutput = await context(buried.ctx, { task: 'retryneedle', max_tokens: 1500 }, { rerank: noModel })
  assert.match(buriedOutput, /Retryneedle must be honored/, 'terms late in a body remain discoverable')

  const chained = fixture([
    { id: 'a', body: '# Journal\n\nReplay durable state first.\n', dependsOn: ['c'] },
    { id: 'b', body: '# Retry\n\nRetryneedle controls recovery.\n', dependsOn: ['a'] },
    { id: 'c', body: '# Ownership\n\nOnly the journal owner may replay records.\n' }
  ])
  const chainOutput = await context(chained.ctx, { task: 'retryneedle', max_tokens: 5000 }, { rerank: noModel })
  assert.deepStrictEqual(chained.reads, ['a', 'b', 'c'])
  assert.match(chainOutput, /Only the journal owner may replay records\./, 'late promotion preserves transitive governing dependencies')
  assert.strictEqual(receipts(chainOutput).length, 3)

  const lateFailure = fixture([
    { id: 'a', body: '# Journal\n\nReplay durable state first.\n' },
    { id: 'b', body: '# Retry\n\nRetryneedle controls recovery.\n', dependsOn: ['a'] }
  ])
  const read = lateFailure.ctx.specs.document
  lateFailure.ctx.specs.document = async (doc, options) => {
    if (doc.id === 'a') throw new Error('source unavailable')
    return read(doc, options)
  }
  const failedDependency = await context(lateFailure.ctx, { task: 'retryneedle', max_tokens: 1500 }, { rerank: noModel })
  assert.match(failedDependency, /required gaps: 1/, 'a failed discovery becomes a required gap when promoted to a dependency')

  const delivery = fixture([{ id: 'a', body: '# Retry\n\nRetryneedle waits before retrying.\n' }])
  const first = await context(delivery.ctx, { task: 'retryneedle', max_tokens: 1500 }, { rerank: noModel })
  const seen = receipts(first)
  assert.strictEqual(seen.length, 1)
  const repeated = await context(delivery.ctx, { task: 'retryneedle', seen, max_tokens: 1500 }, { rerank: noModel })
  assert.doesNotMatch(repeated, /Retryneedle waits before retrying\./)
  assert.match(repeated, /1 already held/)
  assert.strictEqual(delivery.reads.length, 2, 'receipts do not bypass fresh source reads')

  delivery.docs[0].status = 'implemented'
  const changedStatus = await context(delivery.ctx, { task: 'retryneedle', seen, max_tokens: 1500 }, { rerank: noModel })
  assert.match(changedStatus, /Retryneedle waits before retrying\./)
  assert.notStrictEqual(receipts(changedStatus)[0], seen[0])
  delivery.ctx.index.repo = '/tmp/another-edge-repo'
  const changedRepo = await context(delivery.ctx, { task: 'retryneedle', seen: receipts(changedStatus), max_tokens: 1500 }, { rerank: noModel })
  assert.match(changedRepo, /Retryneedle waits before retrying\./)

  const id = sectionId('a', bodyHash(delivery.docs[0].body), 1)
  delivery.docs[0].body += 'The deadline still applies.\n'
  await assert.rejects(getSection(delivery.ctx, { id, max_tokens: 1500 }), /source changed/)

  const emptyScope = fixture([{ body: '# Retry\n\nRetryneedle is relevant.\n' }], { scope: 'all' })
  const unscoped = await context(emptyScope.ctx, { task: 'retryneedle', max_tokens: 1500 }, { rerank: noModel })
  assert.strictEqual(emptyScope.reads.length, 0)
  assert.match(unscoped, /automatic discovery disabled/)
  assert.doesNotMatch(unscoped, /Retryneedle is relevant\./)

  const oversized = fixture([{ body: `# Requirement\n\n${'Retryneedle cannot be skipped. '.repeat(300)}\n` }])
  const output = await context(oversized.ctx, { task: 'retryneedle', anchors: ['spec:a'], max_tokens: 500 }, { rerank: noModel })
  assert.strictEqual(receipts(output).length, 0)
  assert.doesNotMatch(output, /Retryneedle cannot be skipped\./)
  assert.match(output, /required gaps: 1/)
  assert.ok(Math.ceil(`${oversized.ctx.header()}\n\n${output}`.length / 4) <= 500)

  const paginated = fixture([{ id: 'many', body: Array.from({ length: 5 }, (_, i) =>
    `# Constraint ${i + 1}\n\n${'MTU configuration must preserve recovery. '.repeat(50)}\n`).join('\n') }])
  const pageArgs = { task: 'MTU', anchors: ['spec:many'], max_tokens: 500 }
  const held = []
  const expanded = new Set()
  let page = await context(paginated.ctx, pageArgs, { rerank: noModel })
  assert.match(page, /5 selected sections omitted/)
  assert.match(page, /; 2 more/)
  for (let i = 0; i < 5; i++) {
    const section = page.match(/omitted: (section:\S+)/)[1]
    assert.ok(!expanded.has(section), 'each page exposes a section not yet retrieved')
    expanded.add(section)
    const tooSmall = await getSection(paginated.ctx, { id: section, max_tokens: 500 })
    assert.match(tooSmall, /Nothing from the section was delivered/)
    assert.deepStrictEqual(receipts(tooSmall), [], 'omitted text must not receive a receipt')
    const complete = await getSection(paginated.ctx, { id: section, max_tokens: 2000 })
    assert.match(complete, /MTU configuration must preserve recovery\./)
    assert.strictEqual(receipts(complete).length, 1, 'expanded sections receive a receipt for subsequent context calls')
    assert.ok(Math.ceil(`${paginated.ctx.header()}\n\n${complete}`.length / 4) <= 2000)
    held.push(...receipts(complete))
    page = await context(paginated.ctx, { ...pageArgs, seen: held }, { rerank: noModel })
    assert.match(page, new RegExp(`${i + 1} already held`))
    assert.doesNotMatch(page, new RegExp(`(?:omitted: |, )${section} \\(required\\)`))
  }
  assert.strictEqual(expanded.size, 5)
  assert.match(page, /0 selected sections omitted; required gaps: 0/)

  const crowded = fixture([
    { id: 'target', title: 'Policy loading', dependsOn: ['base'], body: '# Policy loading\n\n## Requirements\n\n- **FR-001**: Directory discovery must skip hidden files and reject duplicate names.\n' },
    { id: 'base', title: 'Directory foundations', body: Array.from({ length: 12 }, (_, i) =>
      `## Foundation ${i}\n\n- **FR-${String(i + 1).padStart(3, '0')}**: ${'Preserve all configured startup conditions. '.repeat(6)}\n`).join('\n') }
  ])
  let modelCandidates = []
  const focused = await context(crowded.ctx, { task: 'Directory discovery hidden files duplicate names', max_tokens: 750 }, {
    rerank: async (task, candidates) => {
      modelCandidates = candidates
      return { scores: null, reason: 'disabled', model: null }
    }
  })
  assert.match(focused, /Directory discovery must skip hidden files/, 'task requirements precede dependencies matching only the document title')
  assert.match(focused, /required gaps: [1-9]/, 'unread dependency requirements remain explicit gaps')
  assert.ok(modelCandidates.every(c => !c.id.startsWith('section:base:')), 'dependency requirements still bypass the model')

  const shared = 'During recovery, keep the previous usable state until the replacement is ready.\n'.repeat(12)
  const siblings = fixture([{ body: `# Recovery\n\n${shared}\n## Retry\n\nRetryneedle must preserve the deadline.\n\n## Timeout\n\nRetryneedle must report a timeout.\n` }])
  const packet = await context(siblings.ctx, { task: 'Retryneedle', max_tokens: 1000 }, { rerank: noModel })
  assert.match(packet, /Retryneedle must preserve the deadline\./)
  assert.match(packet, /Retryneedle must report a timeout\./)
  assert.strictEqual(packet.split(shared).length - 1, 1, 'common source scope is printed once in a packet')
  assert.strictEqual(receipts(packet).length, 2, 'both full units have their complete source scope present')
  const siblingId = [...packet.matchAll(/^(section:\S+)/gm)][1][1]
  assert.match(await getSection(siblings.ctx, { id: siblingId, max_tokens: 1000 }), /During recovery, keep the previous usable state/, 'standalone get restores shared ancestors')
}

main().then(() => console.log('context edges ok'), error => { console.error(error); process.exitCode = 1 })
