'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const { previewBundle, previewFile } = require('../lib/context/preview')

const hash = value => createHash('sha256').update(value).digest('hex')
const original = '# Rules\n\nKeep the previously accepted scope.\n\n## Requirements\n\n- **FR-001**: Reject invalid input.\n- This condition also governs both requirements.\n- **FR-002**: Explain rejected input.\n\n```text\n- **FR-999**: This is an example.\n```\n'
const provider = '# Validation\n\n- **FR-001**: Validate supported fields.\n'
const reference = (source, label) => ({ source, selector: { label } })
const disposition = (label, source = 'rules') => ({ id: `${source}-${label}`, from: reference(source, label), disposition: 'amended', to: [reference(source, label)] })

function fixture (t, body = original) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-preview-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const repo = path.join(directory, 'repo')
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], {
    cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'rules.md'), body)
  fs.writeFileSync(path.join(repo, 'provider.md'), provider)
  git('add', '.')
  git('commit', '-qm', 'Declare fixture behavior')
  const revision = git('rev-parse', 'HEAD')
  const snapshot = file => ({ repository: repo, revision, path: file })
  const draft = path.join(directory, 'candidate.md')
  const candidate = text => {
    fs.writeFileSync(draft, text)
    return { file: draft, sha256: hash(text) }
  }
  const bundle = { schemaVersion: 1, title: 'Clarify input handling', inventory: { reviewed: true }, sources: [
    { id: 'rules', base: snapshot('rules.md'), candidate: candidate(body.replace('Reject invalid input.', 'Reject invalid or duplicate input.')) },
    { id: 'provider', base: snapshot('provider.md'), candidate: snapshot('provider.md') }
  ], obligations: [disposition('FR-001')] }
  return { directory, repo, git, revision, snapshot, candidate, bundle, draft }
}

test('a focused amendment keeps exact evidence and does not demand dispositions for unchanged providers', t => {
  const f = fixture(t)
  const before = fs.readFileSync(path.join(f.repo, 'rules.md'))
  const packet = previewBundle(f.bundle, f.directory, { require_valid: true, max_tokens: 12000 })
  assert.equal(packet.structurallyValid, true)
  assert.equal(packet.semanticPreservationVerified, false)
  assert.equal(packet.authorityVerified, false)
  assert.equal(packet.publicationAttempted, false)
  assert.equal(packet.identityScope, 'normalized-bundle-declaration')
  assert.deepEqual(packet.inventory.affectedLabels.map(item => `${item.source}:${item.label}`), ['rules:FR-001'])
  assert.ok(packet.inventory.recognized.some(item => item.source === 'provider' && item.label === 'FR-001'))
  assert.equal(packet.inventory.recognized.some(item => item.label === 'FR-999'), false)
  const excerpt = packet.excerpts.find(item => item.id === packet.obligations[0].from.evidence)
  assert.equal(excerpt.text, '- **FR-001**: Reject invalid input.\n')
  assert.equal(excerpt.sha256, hash(before))
  assert.match(packet.changes[0].diff, /-\- \*\*FR-001\*\*: Reject invalid input/)
  assert.match(packet.changes[0].diff, /\+\- \*\*FR-001\*\*: Reject invalid or duplicate input/)
  assert.deepEqual(fs.readFileSync(path.join(f.repo, 'rules.md')), before)
  assert.equal(f.git('status', '--porcelain'), '')
})

test('mixed-list removals need every affected disposition and prose inventory review is independent', t => {
  const f = fixture(t)
  f.bundle.sources[0].candidate = null
  f.bundle.obligations = []
  f.bundle.inventory.reviewed = false
  const packet = previewBundle(f.bundle, f.directory, { max_tokens: 12000 })
  assert.deepEqual(packet.inventory.uncovered.map(item => item.label), ['FR-001', 'FR-002'])
  assert.equal(packet.changes[0].kind, 'proposed-removal')
  assert.ok(packet.diagnostics.some(item => item.code === 'INVENTORY_NOT_REVIEWED'))
  assert.throws(() => previewBundle(f.bundle, f.directory, { require_valid: true, max_tokens: 12000 }), e => e.code === 'INVALID_CHANGE' && e.details.packet.structurallyValid === false)
  assert.equal(f.git('status', '--porcelain'), '')
})

test('scope changes affect unchanged requirement text rather than passing as unrelated prose', t => {
  const f = fixture(t)
  f.bundle.sources[0].candidate = f.candidate(original.replace('previously accepted scope', 'new narrower scope'))
  f.bundle.obligations = []
  const packet = previewBundle(f.bundle, f.directory, { max_tokens: 12000 })
  assert.deepEqual(packet.inventory.affectedLabels.map(item => item.label), ['FR-001', 'FR-002'])
  assert.equal(packet.diagnostics.filter(item => item.code === 'UNASSIGNED_OBLIGATION').length, 2)
})

test('broad and overlapping line inventories cannot discharge several labeled obligations implicitly', t => {
  const f = fixture(t)
  f.bundle.sources[0].candidate = null
  f.bundle.obligations = [{ id: 'all', from: { source: 'rules', selector: { startLine: 1, endLine: 13 } }, disposition: 'withdrawn', to: [], rationale: 'Review removal.' }]
  let packet = previewBundle(f.bundle, f.directory, { max_tokens: 12000 })
  assert.ok(packet.diagnostics.some(item => item.code === 'MULTIPLE_LABEL_RANGE'))
  assert.equal(packet.inventory.uncovered.length, 2)
  f.bundle.sources[0].candidate = f.candidate(original.replace('Reject invalid input.', 'Reject duplicate input.'))
  f.bundle.obligations = [disposition('FR-001'), { id: 'overlap', from: { source: 'rules', selector: { startLine: 6, endLine: 7 } }, disposition: 'amended', to: [reference('rules', 'FR-001')] }]
  packet = previewBundle(f.bundle, f.directory, { max_tokens: 12000 })
  assert.ok(packet.diagnostics.some(item => item.code === 'DUPLICATE_OBLIGATION_COVERAGE'))
})

test('duplicate labels and disposition identities remain invalid rather than selecting an arbitrary item', t => {
  const f = fixture(t)
  f.bundle.sources[0].candidate = f.candidate(original.replace('FR-002', 'FR-001'))
  f.bundle.obligations.push({ ...disposition('FR-001'), id: 'another-record' })
  const packet = previewBundle(f.bundle, f.directory, { max_tokens: 12000 })
  assert.ok(packet.diagnostics.some(item => item.code === 'DUPLICATE_LABEL'))
  assert.ok(packet.diagnostics.some(item => item.code === 'SELECTOR_UNRESOLVED'))
  assert.ok(packet.diagnostics.some(item => item.code === 'DUPLICATE_DISPOSITION'))
  assert.equal(packet.structurallyValid, false)
})

test('missing and ambiguous capabilities are distinct from a connected but semantically unverified declaration', t => {
  const f = fixture(t)
  f.bundle.requires = [{ capability: 'document.decode', consumer: 'rules' }]
  let packet = previewBundle(f.bundle, f.directory, { max_tokens: 12000 })
  assert.ok(packet.diagnostics.some(item => item.code === 'MISSING_CAPABILITY'))
  f.bundle.provides = [{ capability: 'document.decode', ...reference('provider', 'FR-001') }]
  f.bundle.relations = [{ type: 'implementation', from: 'rules', to: 'provider' }]
  packet = previewBundle(f.bundle, f.directory, { require_valid: true, max_tokens: 12000 })
  assert.equal(packet.structurallyValid, true)
  assert.equal(packet.semanticPreservationVerified, false)
  assert.match(packet.excerpts.find(item => item.id === packet.provides[0].evidence).text, /Validate supported fields/)
  f.bundle.provides.push({ capability: 'document.decode', ...reference('rules', 'FR-001') })
  packet = previewBundle(f.bundle, f.directory, { max_tokens: 12000 })
  assert.ok(packet.diagnostics.some(item => item.code === 'AMBIGUOUS_CAPABILITY'))
  f.bundle.requires[0].provider = 'provider'
  assert.equal(previewBundle(f.bundle, f.directory, { require_valid: true, max_tokens: 12000 }).structurallyValid, true)
})

test('typed cycles and historical supersession targets are not interchangeable implementation providers', t => {
  const f = fixture(t)
  f.bundle.relations = [{ type: 'normative', from: 'rules', to: 'provider' }, { type: 'normative', from: 'provider', to: 'rules' }]
  let packet = previewBundle(f.bundle, f.directory, { require_valid: true, max_tokens: 12000 })
  assert.ok(packet.diagnostics.some(item => item.code === 'RELATION_CYCLE' && item.severity === 'warning'))
  f.bundle.relations = f.bundle.relations.map(item => ({ ...item, type: 'implementation' }))
  assert.throws(() => previewBundle(f.bundle, f.directory, { require_valid: true, max_tokens: 12000 }), e => e.code === 'INVALID_CHANGE')
  f.bundle.sources[1].candidate = null
  f.bundle.obligations.push({ id: 'retire-validator', from: reference('provider', 'FR-001'), disposition: 'withdrawn', to: [], rationale: 'Proposed review decision only.' })
  f.bundle.relations = [{ type: 'supersedes', from: 'rules', to: 'provider' }]
  packet = previewBundle(f.bundle, f.directory, { require_valid: true, max_tokens: 12000 })
  assert.equal(packet.relations[0].to, 'provider')
  assert.equal(packet.publicationAttempted, false)
  f.bundle.relations[0].type = 'implementation'
  assert.ok(previewBundle(f.bundle, f.directory, { max_tokens: 12000 }).diagnostics.some(item => item.code === 'UNRESOLVED_RELATION'))
})

test('malformed and unresolved frontmatter relations retain diagnostics instead of disappearing', t => {
  const f = fixture(t)
  f.bundle.sources[0].base = null
  f.bundle.obligations = []
  f.bundle.sources[0].candidate = f.candidate('---\ndepends-on: provider\n---\n' + original)
  let packet = previewBundle(f.bundle, f.directory, { max_tokens: 12000 })
  assert.ok(packet.diagnostics.some(item => item.code === 'INVALID_RELATION' && item.location.field === 'depends-on'))
  f.bundle.sources[0].candidate = f.candidate('---\ndepends-on: [provider, missing, 17]\n---\n' + original)
  packet = previewBundle(f.bundle, f.directory, { max_tokens: 12000 })
  assert.ok(packet.relations.some(edge => edge.to === 'provider'))
  assert.ok(packet.diagnostics.some(item => item.code === 'UNRESOLVED_RELATION' && item.location.index === 1))
  assert.ok(packet.diagnostics.some(item => item.code === 'INVALID_RELATION' && item.location.index === 2))
  f.bundle.sources[0].candidate = f.candidate('---\ndepends-on: []\ndepends-on: [provider]\n---\n' + original)
  assert.ok(previewBundle(f.bundle, f.directory, { max_tokens: 12000 }).diagnostics.some(item => item.code === 'INVALID_FRONTMATTER'))
})

test('pinned bytes survive advanced HEAD and replacement refs while explicit currentRef drift blocks validity', t => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.repo, 'rules.md'), original.replace('Reject invalid input.', 'Accept every input.'))
  f.git('add', '.')
  f.git('commit', '-qm', 'Advance fixture baseline')
  const later = f.git('rev-parse', 'HEAD')
  f.git('replace', f.revision, later)
  let packet = previewBundle(f.bundle, f.directory, { require_valid: true, max_tokens: 12000 })
  assert.ok(packet.diagnostics.some(item => item.code === 'HEAD_DIFFERS'))
  assert.match(packet.excerpts.find(item => item.id === packet.obligations[0].from.evidence).text, /Reject invalid input/)
  assert.doesNotMatch(packet.excerpts.find(item => item.id === packet.obligations[0].from.evidence).text, /Accept every input/)
  f.bundle.sources[0].base.currentRef = 'HEAD'
  packet = previewBundle(f.bundle, f.directory, { max_tokens: 12000 })
  assert.ok(packet.diagnostics.some(item => item.code === 'BASE_REF_MOVED'))
  assert.equal(packet.structurallyValid, false)
})

test('Git symlinks, candidate symlinks, unsafe paths, stale hashes and duplicate JSON keys fail before a preview', t => {
  const f = fixture(t)
  f.bundle.sources[0].candidate.sha256 = '0'.repeat(64)
  assert.throws(() => previewBundle(f.bundle, f.directory), e => e.code === 'INVALID_CHANGE_SOURCE' && /hash mismatch/.test(e.message))
  f.bundle.sources[0].candidate = f.candidate(original)
  f.bundle.sources[0].base.path = '../rules.md'
  assert.throws(() => previewBundle(f.bundle, f.directory), e => e.code === 'INVALID_CHANGE_SOURCE' && /Unsafe/.test(e.message))
  f.bundle.sources[0].base.path = 'rules.md'
  const link = path.join(f.directory, 'linked.md')
  fs.symlinkSync(f.draft, link)
  f.bundle.sources[0].candidate.file = link
  assert.throws(() => previewBundle(f.bundle, f.directory), e => e.code === 'INVALID_CHANGE_SOURCE' && /symlink/.test(e.message))
  f.bundle.sources[0].candidate.file = f.draft
  fs.symlinkSync('rules.md', path.join(f.repo, 'link.md'))
  f.git('add', 'link.md')
  f.git('commit', '-qm', 'Add fixture link')
  f.bundle.sources[0].base = { ...f.snapshot('link.md'), revision: f.git('rev-parse', 'HEAD') }
  assert.throws(() => previewBundle(f.bundle, f.directory), e => e.code === 'INVALID_CHANGE_SOURCE' && /regular Git file/.test(e.message))
  const config = path.join(f.directory, 'bundle.json')
  fs.writeFileSync(config, '{"schemaVersion":1,"requires":[{"capability":"needed"}],"requires":[]}')
  assert.throws(() => previewFile(config), e => e.code === 'INVALID_CHANGE_CONFIG' && /duplicated mapping key/.test(e.message))
  assert.throws(() => previewBundle({ ...f.bundle, sources: [] }, f.directory), e => e.code === 'INVALID_CHANGE_CONFIG')
})

test('stable rule versions exclude incidental excerpt pool ordering and declarations never imply conformance', t => {
  const f = fixture(t)
  f.bundle.rules = [{ id: 'separation', governing: reference('provider', 'FR-001'), type: 'forbid-relation', relation: 'implementation', from: ['rules'], to: ['provider'] }]
  const before = previewBundle(f.bundle, f.directory, { require_valid: true, max_tokens: 12000 })
  f.bundle.obligations.unshift({ ...disposition('FR-001', 'provider'), disposition: 'retained' })
  const after = previewBundle(f.bundle, f.directory, { require_valid: true, max_tokens: 12000 })
  assert.equal(after.ruleChecks[0].version, before.ruleChecks[0].version)
  assert.equal(after.ruleChecks[0].declarationOnly, true)
})

test('oversized recognized inventories reject before quadratic scope comparison or oversized output', t => {
  const f = fixture(t)
  f.bundle.sources[0].candidate = f.candidate('# Many requirements\n\n' + Array.from({ length: 513 }, (_, i) => `- **FR-${i + 1}**: Preserve value ${i}.\n`).join(''))
  assert.throws(() => previewBundle(f.bundle, f.directory, { max_tokens: 20000 }), e => e.code === 'INVALID_CHANGE_SOURCE' && /512 labeled obligations/.test(e.message))
})

test('preview budgets count complete success and strict-error envelopes without clipped findings', t => {
  const f = fixture(t)
  f.bundle.inventory.reviewed = false
  const packet = previewBundle(f.bundle, f.directory, { max_tokens: 12000 })
  const strict = { schemaVersion: 1, error: { code: 'INVALID_CHANGE', message: 'Change preview has unresolved structural findings; inspect diagnostics. This is not a semantic or approval verdict.', details: { packet } } }
  const minimum = Math.max(Math.ceil(JSON.stringify(strict).length / 4), Math.ceil(JSON.stringify({ schemaVersion: 1, data: packet }).length / 4))
  assert.throws(() => previewBundle(f.bundle, f.directory, { max_tokens: 500 }), e => e.code === 'BUDGET_TOO_SMALL' && e.details.minimumTokens === minimum && !e.details.packet)
  assert.throws(() => previewBundle(f.bundle, f.directory, { max_tokens: minimum - 1 }), e => e.code === 'BUDGET_TOO_SMALL')
  assert.throws(() => previewBundle(f.bundle, f.directory, { require_valid: true, max_tokens: minimum }), e => e.code === 'INVALID_CHANGE' && e.details.packet.diagnostics.length === packet.diagnostics.length)
})
