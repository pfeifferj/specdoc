'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { Context } = require('../lib/context/runtime')
const { Trace } = require('../lib/context/trace')
const { implementsRefs, specPathRefs } = require('../lib/context/refs')

function fixture (t) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-trace-'))
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q')
  git('remote', 'add', 'origin', 'git@github.com:example/engine.git')
  const commit = (file, body) => {
    fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    fs.writeFileSync(path.join(repo, file), `${file}\n`)
    git('add', '--', file)
    git('commit', '-qm', body)
    return git('rev-parse', '--short', 'HEAD')
  }
  return { repo, git, commit }
}

const source = { id: 'lease-rules', namespace: 'example/requirements', repository: '/selected/requirements', revision: 'a'.repeat(40), path: 'core/201-lease.md', reference: 'example/requirements#83' }

test('Spec-only implementation history survives a later test-only completion', t => {
  const { repo, git, commit } = fixture(t)
  const implementation = commit('src/lease.rs', 'Implement lease renewal\n\nKeep state consistent.\n\nSpec: core/201-lease')
  const completion = commit('tests/lease.rs', 'Exercise renewal acceptance\n\nimplements example/requirements#83')
  const trace = new Trace(repo, [source]).refresh(git('rev-parse', 'HEAD'))
  assert.deepEqual(trace.forSpec({ namespace: source.namespace, pr: 83, specPath: source.path }).map(c => c.sha), [completion, implementation])
  assert.deepEqual(trace.forFile('src/lease.rs').map(c => c.sha), [implementation])
  assert.deepEqual(trace.forFile('tests/lease.rs')[0].refs.map(r => r.relation), ['implements'])
  assert.deepEqual(trace.forFile('src/lease.rs')[0].refs, [{ path: 'core/201-lease', relation: 'contributes_to', ns: source.namespace, specPath: source.path, sourceId: source.id, label: source.reference, n: 83, resolution: 'configured-source' }])
  assert.equal(trace.forSpec({ namespace: source.namespace, pr: 201 }).length, 0, 'filename digits never become the published issue number')
  assert.equal(trace.forSpec({ namespace: 'other/requirements', pr: 83, specPath: source.path }).length, 0)
})

test('unmapped and ambiguous paths stay visible without claiming a namespace or completion', t => {
  const { repo, git, commit } = fixture(t)
  commit('src/lease.rs', 'Contribute lease support\n\nSpec: core/201-lease\nSpec: core/202-clock.md')
  const head = git('rev-parse', 'HEAD')
  const trace = new Trace(repo).refresh(head)
  assert.equal(trace.commits.length, 1)
  assert.equal(trace.commits[0].refs.length, 2)
  assert.ok(trace.commits[0].refs.every(r => r.relation === 'contributes_to' && r.resolution === 'unresolved' && r.ns === null))
  assert.deepEqual(trace.namespaces(), [], 'a path cannot silently select the implementation origin namespace')
  assert.equal(trace.forSpec({ namespace: source.namespace, specPath: source.path }).length, 0)
  trace.configure([source]).refresh(head)
  assert.equal(trace.forSpec({ namespace: source.namespace, specPath: source.path }).length, 1, 'mapping changes invalidate the cache even when HEAD is unchanged')
  trace.configure([source, { ...source, namespace: 'other/requirements', reference: 'other/requirements#12' }]).refresh(head)
  assert.equal(trace.forSpec({ namespace: source.namespace, specPath: source.path }).length, 0)
  assert.match(trace.commits[0].refs[0].reason, /ambiguous/)
  assert.equal(trace.commits[0].refs[0].candidates.length, 2)
})

test('explicit source identifiers support specs without a published issue', t => {
  const { repo, git, commit } = fixture(t)
  const unnumbered = { ...source, reference: undefined }
  commit('src/lease.rs', 'Contribute lease support\n\nSpec: core/201-lease.md')
  const trace = new Trace(repo, [unnumbered]).refresh(git('rev-parse', 'HEAD'))
  assert.equal(trace.forSpec({ id: source.id, namespace: source.namespace, pr: null }).length, 1)
  assert.equal(trace.commits[0].refs[0].label, source.id)
  assert.equal(trace.commits[0].refs[0].n, undefined)
  trace.configure([{ ...source, reference: 'other/requirements#83' }]).refresh(git('rev-parse', 'HEAD'))
  assert.equal(trace.commits[0].refs[0].resolution, 'unresolved')
  assert.match(trace.commits[0].refs[0].reason, /namespace/)
})

test('a combined Spec and completion footer retains both separate relationships', t => {
  const { repo, git, commit } = fixture(t)
  const sha = commit('src/lease.rs', 'Implement and exercise renewal\n\nSpec: core/201-lease\nimplements example/requirements#83\nSigned-off-by: Person <p@example.test>')
  const trace = new Trace(repo, [source]).refresh(git('rev-parse', 'HEAD'))
  const record = trace.forFile('src/lease.rs').find(c => c.sha === sha)
  assert.deepEqual(record.refs.map(r => r.relation).sort(), ['contributes_to', 'implements'])
  assert.equal(record.refs.find(r => r.relation === 'contributes_to').label, source.reference)
  assert.deepEqual(specPathRefs('Subject\n\nimplements example/requirements#83\nSpec: core/201-lease'), [{ path: 'core/201-lease' }])
})

test('Spec contributions require valid final trailers and preserve completion grammar', () => {
  assert.deepEqual(specPathRefs('Subject\n\nSpec: specs/alpha\nSpec: specs/beta.md\nSigned-off-by: Person <p@example.test>'), [{ path: 'specs/alpha' }, { path: 'specs/beta.md' }])
  assert.deepEqual(specPathRefs('Subject\r\n\r\nsPeC: specs/alpha\r\n'), [{ path: 'specs/alpha' }])
  for (const message of [
    'Spec: specs/alpha',
    'Subject\nSpec: specs/alpha',
    'Subject\n\nDiscussion mentions Spec: specs/alpha',
    'Subject\n\nSpec: specs/alpha\nthis is prose',
    'Subject\n\nSpec: specs/alpha\n\nFurther discussion.',
    ...['../outside', '/absolute', './relative', 'specs/../outside', 'specs//alpha', 'specs/alpha specs/beta', 'specs/alpha, specs/beta', 'https://example.test/spec.md', 'specs\\alpha'].map(v => `Subject\n\nSpec: ${v}`)
  ]) assert.deepEqual(specPathRefs(message), [], message)
  assert.deepEqual(implementsRefs('implements #12 and IMPLEMENTS other/specs#7', 'example/engine'), [{ ns: 'example/engine', n: 12 }, { ns: 'other/specs', n: 7 }])
  assert.deepEqual(implementsRefs('implements #12', ''), [{ ns: '', n: 12 }])
})

test('runtime separates contribution from completion and reports unresolved paths', t => {
  const { repo, git, commit } = fixture(t)
  const implementation = commit('src/lease.rs', 'Implement renewal\n\nSpec: core/201-lease')
  const completion = commit('tests/lease.rs', 'Exercise renewal\n\nimplements example/requirements#83')
  const ctx = new Context(repo, 'http://unused.example.test', [source.namespace])
  ctx.index.refresh()
  ctx.log.configure([source]).refresh(git('rev-parse', 'HEAD'))
  const spec = { id: source.id, namespace: source.namespace, specPath: source.path, pr: 83, title: 'Lease rules', status: 'approved' }
  ctx.specs.resolve = id => [source.reference, source.id].includes(id) ? spec : null
  ctx.specs.outside = () => null
  const trace = ctx.trace({ id: `spec:${source.reference}`, max_tokens: 2000 })
  assert.match(trace, /file-level commit references; not symbol attribution or requirement verification/)
  assert.match(trace, new RegExp(`commit:${implementation}[^\\n]+\\[contributes_to\\]`))
  assert.match(trace, new RegExp(`commit:${completion}[^\\n]+\\[implements\\]`))
  const implementationTrace = ctx.trace({ id: `commit:${implementation}`, max_tokens: 2000 })
  assert.match(implementationTrace, /contributes to spec:example\/requirements#83/)
  assert.doesNotMatch(implementationTrace, /implements spec:/)
  ctx.log.configure([]).refresh(git('rev-parse', 'HEAD'))
  assert.match(ctx.trace({ id: `commit:${implementation}`, max_tokens: 2000 }), /spec-path:core\/201-lease  \(unresolved: no configured source/)
})

test('board exploration maps Spec contributions from exact scoped path metadata and refreshes changed mappings', async t => {
  const { repo, commit } = fixture(t)
  commit('src/lease.rs', 'Implement renewal\n\nSpec: core/201-lease')
  const ctx = new Context(repo, 'http://unused.example.test', [source.namespace])
  let specPath = source.path
  ctx.specs.load = async function () {
    this.all = [{ id: source.id, namespace: source.namespace, specPath, pr: 83, title: 'Lease rules', status: 'approved', dependsOn: [], supersedes: null }]
    this.select()
    return this
  }
  await ctx.refresh()
  assert.deepEqual(ctx.log.forFile('src/lease.rs')[0].refs.map(r => r.relation), ['contributes_to'])
  assert.deepEqual(ctx.log.namespaces('implements'), [], 'board-derived contribution mappings do not silently change namespace inference')
  assert.match(ctx.trace({ id: `spec:${source.reference}`, max_tokens: 2000 }), /\[contributes_to\]/)
  assert.equal(ctx.log.forFile('src/lease.rs')[0].refs[0].label, source.reference)
  specPath = 'core/999-other.md'
  await ctx.refresh()
  assert.equal(ctx.log.forFile('src/lease.rs')[0].refs[0].resolution, 'unresolved')
  assert.equal(ctx.log.forSpec({ namespace: source.namespace, pr: 83, specPath }).length, 0)
})
