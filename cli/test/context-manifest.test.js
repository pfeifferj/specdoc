'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { createManifest, loadManifest, manifestId } = require('../lib/context/manifest')
const { Context } = require('../lib/context/runtime')

process.env.SPECDOC_LAYA_URL = ''
const original = '# Address rules\n\nApply these rules during activation.\n\n## Requirements\n\n- **FR-001**: Reject invalid addresses and preserve the prior configuration.\n- **FR-002**: Explain the rejected value.\n'
function fixture (t, body = original) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specdoc-pinned-context-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(repo)
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  git('init', '-q')
  fs.writeFileSync(path.join(repo, 'requirements.md'), body)
  fs.writeFileSync(path.join(repo, 'lib.rs'), 'pub struct Address;\n')
  git('add', '.')
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Define address behavior')
  const config = { schemaVersion: 1, task: 'Implement address validation', implementation: { repository: repo, revision: 'HEAD', scope: ['lib.rs'] },
    selection: { requirementsComplete: true, dependenciesComplete: true }, sources: [{ id: 'addresses', namespace: 'example/specs', repository: repo,
      revision: 'HEAD', path: 'requirements.md', reference: 'example/specs#17', role: 'governing', authority: 'caller-selected-merged',
      requirements: [{ id: 'FR-001', sections: ['FR-001'] }], dependencies: [] }] }
  const save = manifest => {
    const file = path.join(dir, `${manifest.id}.json`)
    fs.writeFileSync(file, JSON.stringify(manifest))
    return file
  }
  const pin = () => save(createManifest(config))
  const context = file => new Context(repo, 'http://board.invalid', [], { manifest: file }).refresh()
  return { repo, dir, config, git, save, pin, context }
}

test('pinned authority stays on exact Git bytes when the board, selected branch and worktree advance', async t => {
  const f = fixture(t)
  const file = f.pin()
  const pinned = loadManifest(file)
  fs.writeFileSync(path.join(f.repo, 'requirements.md'), original.replace('Reject invalid addresses', 'Accept invalid addresses'))
  f.git('add', '.')
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Propose a different address behavior')
  fs.appendFileSync(path.join(f.repo, 'requirements.md'), '\nUncommitted proposal.\n')
  fs.writeFileSync(path.join(f.repo, 'scratch.rs'), 'pub struct Scratch;\n')
  const fetch = global.fetch
  global.fetch = async () => { throw new Error('Manifest retrieval must stay offline') }
  t.after(() => { global.fetch = fetch })
  const ctx = await f.context(file)
  const packet = await ctx.contextPacket({ task: 'address', require_complete: true, max_tokens: 3000 })
  assert.equal(packet.complete, true)
  assert.equal(packet.manifest.id, pinned.id)
  assert.equal(packet.sources[0].revision, pinned.sources[0].revision)
  assert.equal(packet.sources[0].blob, pinned.sources[0].blob)
  assert.equal(packet.authority.mergedAuthorityVerified, false)
  assert.equal(packet.freshness.baselineIsCurrentHead, false)
  assert.match(packet.freshness.implementationHead, /^[a-f0-9]{40}$/)
  assert.equal(packet.freshness.untrackedFiles, 1)
  assert.ok(packet.freshness.codeIndexCoverage.gaps.some(g => g.code === 'UNTRACKED_FILES_NOT_INDEXED'))
  assert.match(packet.text, /Reject invalid addresses/)
  assert.doesNotMatch(packet.text, /Accept invalid addresses|Uncommitted proposal/)
  assert.ok(packet.sources[0].requirements.some(r => r.id === 'FR-001' && packet.sections.some(s => s.number === r.sections[0] && s.required)))
  const ranges = new Map([...packet.supportingText.map(r => [r.id, r]), ...packet.sections.map(s => [s.rangeId, s])])
  for (const section of packet.sections) {
    const completeText = [...section.ancestors.map(id => ranges.get(id).text), section.text].join('\n')
    assert.match(completeText, /Apply these rules during activation/)
  }
})

test('declared missing dependencies and unconfirmed selections remain gaps, and strict mode refuses them', async t => {
  const f = fixture(t)
  f.config.sources[0].dependencies = ['recovery']
  f.config.selection.dependenciesComplete = false
  const file = f.pin()
  const ctx = await f.context(file)
  const packet = await ctx.contextPacket({ task: 'address', max_tokens: 3000 })
  assert.equal(packet.complete, false)
  assert.ok(packet.requiredGaps.some(g => g.code === 'MISSING_DEPENDENCY'))
  assert.ok(packet.requiredGaps.some(g => g.code === 'DEPENDENCY_SELECTION_UNCONFIRMED'))
  assert.match(packet.text, /Reject invalid addresses/)
  await assert.rejects(ctx.contextPacket({ task: 'address', require_complete: true, max_tokens: 3000 }), e => e.code === 'INCOMPLETE_CONTEXT' && e.details.packet.requiredGaps.length >= 2)
  f.config.sources[0].path = 'missing.md'
  assert.throws(() => createManifest(f.config), /Cannot read configured Git source/)
})

test('missing Git objects, changed manifest identity and hash-mismatched sources are rejected before selection', async t => {
  const f = fixture(t)
  const manifest = createManifest(f.config)
  const file = f.save(manifest)
  manifest.sources[0].sha256 = '0'.repeat(64)
  fs.writeFileSync(file, JSON.stringify(manifest))
  assert.throws(() => loadManifest(file), /identity/)
  manifest.id = manifestId(manifest)
  fs.writeFileSync(file, JSON.stringify(manifest))
  assert.throws(() => loadManifest(file), /hash mismatch/)
  manifest.sources[0].revision = '0'.repeat(40)
  manifest.id = manifestId(manifest)
  fs.writeFileSync(file, JSON.stringify(manifest))
  assert.throws(() => loadManifest(file), /Cannot read configured Git source/)
})

test('stale receipts never hide newly pinned requirements and old section anchors fail explicitly', async t => {
  const f = fixture(t)
  const firstFile = f.pin()
  const first = await (await f.context(firstFile)).contextPacket({ task: 'address', max_tokens: 3000 })
  fs.writeFileSync(path.join(f.repo, 'requirements.md'), original.replace('Reject invalid addresses', 'Reject invalid or duplicate addresses'))
  f.git('add', '.')
  f.git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Extend validation to duplicates')
  const secondFile = f.pin()
  const ctx = await f.context(secondFile)
  const packet = await ctx.contextPacket({ task: 'address', seen: first.receipts, require_complete: true, max_tokens: 3000 })
  assert.deepEqual(packet.freshness.staleReceipts, first.receipts)
  assert.equal(packet.held.length, 0)
  assert.match(packet.text, /Reject invalid or duplicate addresses/)
  await assert.rejects(ctx.get({ id: first.sections[0].id, max_tokens: 3000 }), /source changed/)
})

test('handoff and compaction reload the same manifest without inheriting another caller receipt cache', async t => {
  const f = fixture(t)
  const file = f.pin()
  const args = { task: 'address', max_tokens: 3000, require_complete: true }
  const first = await (await f.context(file)).contextPacket(args)
  const held = await (await f.context(file)).contextPacket({ ...args, seen: first.receipts })
  assert.equal(held.sections.length, 0)
  assert.equal(held.held.length, first.sections.length)
  assert.equal(held.complete, true)
  const receiver = await (await f.context(file)).contextPacket(args)
  assert.deepEqual(receiver.receipts, first.receipts)
  assert.deepEqual(receiver.sections, first.sections)
  assert.equal(receiver.held.length, 0)
  assert.deepEqual(receiver.manifest.implementation.scope, ['lib.rs'])
})

test('whole required sections omitted by budget remain machine-readable gaps until retrieved', async t => {
  const f = fixture(t, `# Requirements\n\n- **FR-001**: ${'Preserve validation evidence. '.repeat(300)}\n`)
  const ctx = await f.context(f.pin())
  const packet = await ctx.contextPacket({ task: 'validation', max_tokens: 600 })
  assert.equal(packet.sections.length, 0)
  assert.equal(packet.receipts.length, 0)
  assert.ok(packet.requiredGaps.some(g => g.code === 'REQUIRED_SECTION_OMITTED'))
  assert.ok(packet.omissions.some(o => o.required && o.code === 'SECTION_BUDGET'))
  assert.ok(Math.ceil(`${ctx.header()}\n\n${packet.text}`.length / 4) <= 600)
  await assert.rejects(ctx.contextPacket({ task: 'validation', max_tokens: 600, require_complete: true }), e => e.code === 'INCOMPLETE_CONTEXT')
  const complete = await ctx.contextPacket({ task: 'validation', max_tokens: 6000, require_complete: true })
  assert.equal(complete.sections.length, 1)
  assert.equal(complete.requiredGaps.length, 0)
  assert.equal(complete.complete, true)
})

test('CLI pin, structured query and strict errors work offline, and pin never overwrites a handoff manifest', async t => {
  const f = fixture(t)
  const config = path.join(f.dir, 'selection.json')
  const output = path.join(f.dir, 'task.json')
  fs.writeFileSync(config, JSON.stringify(f.config))
  const binary = path.resolve(__dirname, '../bin/specdoc.js')
  const run = args => spawnSync(process.execPath, [binary, ...args, '--format=json'], { encoding: 'utf8', env: { ...process.env, SPECDOC_CONFIG_DIR: path.join(f.dir, 'config'), SPECDOC_REPO: '', SPECDOC_NAMESPACE: '', SPECDOC_BOARD_URL: '', SPECDOC_URL: '', SPECDOC_EDITOR_URL: '' } })
  let result = run(['context', 'pin', '--config', config, '--output', output])
  assert.equal(result.status, 0, result.stderr)
  const id = JSON.parse(result.stdout).data.manifest.id
  result = run(['context', 'query', 'address', '--manifest', output, '--require-complete', '--max-tokens', '3000'])
  assert.equal(result.status, 0, result.stderr)
  const packet = JSON.parse(result.stdout).data
  assert.equal(packet.manifest.id, id)
  assert.equal(packet.kind, 'specdoc-context-packet')
  assert.equal(packet.complete, true)
  result = run(['context', 'get', packet.sections[0].id, '--manifest', output, '--max-tokens', '3000'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(JSON.parse(result.stdout).data.text, /Reject invalid addresses/)
  result = run(['context', 'query', 'address'])
  assert.equal(result.status, 2)
  assert.equal(JSON.parse(result.stderr).error.code, 'USAGE')
  assert.match(JSON.parse(result.stderr).error.message, /--board-url/)
  result = run(['context', 'pin', '--config', config, '--output', output])
  assert.notEqual(result.status, 0)
  assert.equal(loadManifest(output).id, id)
  f.config.sources[0].dependencies = ['missing']
  const incomplete = f.pin()
  result = run(['context', 'query', 'address', '--manifest', incomplete, '--require-complete', '--max-tokens', '3000'])
  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stderr).error.code, 'INCOMPLETE_CONTEXT')
  assert.ok(JSON.parse(result.stderr).error.details.packet.requiredGaps.some(g => g.code === 'MISSING_DEPENDENCY'))
})
