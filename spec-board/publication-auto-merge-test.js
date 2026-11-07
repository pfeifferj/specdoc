'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { candidate, digest, publicationDocument } = require('./publication-candidate')
const { mergePolicy, createPublicationAutoMerge } = require('./publication-auto-merge')

function fixture (change = {}) {
  const base = 'a'.repeat(40), head = 'b'.repeat(40), tree = 'c'.repeat(40), directory = 'd'.repeat(40), blob = 'e'.repeat(40)
  const roles = change.roles || { approvers: ['42'], authors: ['42'], 'approvals-required': 1,
    'auto-merge': { method: 'merge', checks: [{ name: 'validate', 'app-id': 15368 }] } }
  const spec = { id: 'note', namespace: 'team/specs', title: 'A requirement', permission: 'editable', ownerSubject: '42', roles }
  const value = candidate(spec, 'Reviewed body.')
  const id = '11111111-2222-4333-8444-555555555555'
  const relations = { supersedes: null, dependsOn: [] }
  const document = publicationDocument('Reviewed body.', { format: 1, noteId: spec.id, namespace: spec.namespace, submission: id,
    candidate: value.hash, bodyHash: digest('Reviewed body.'), relations })
  const intent = { id, note_id: spec.id, namespace: spec.namespace, candidate_hash: value.hash, policy_hash: value.policy,
    document, document_hash: digest(document), relations, path: 'specs/001-requirement.md', base_sha: base,
    branch: 'specdoc/note-submission', base_branch: 'main', pr_number: 3 }
  const pr = { number: 3, state: 'open', draft: false, mergeable: true, mergeable_state: 'clean',
    body: `<!-- specdoc-intent:${id};candidate:${value.hash};note:note -->`,
    head: { ref: intent.branch, sha: head, repo: { full_name: 'team/specs' } },
    base: { ref: 'main', sha: base, repo: { full_name: 'team/specs' } } }
  const calls = [], authorizations = [], extras = []
  const comparison = { merge_base_commit: { sha: base }, status: 'ahead', total_commits: 1, commits: [{ sha: head }], files: [{ filename: intent.path, sha: blob, status: 'added' }] }
  const check = { id: 9, name: 'validate', head_sha: head, app: { id: 15368 }, status: 'completed', conclusion: 'success' }
  const state = { intent, pr, roles, candidate: value, authorized: true, extras, comparison, checks: [check], document,
    mode: '100644', treeTruncated: false, currentBase: base, putError: null, putCount: 0, readCount: 0, lockCount: 0,
    receipt: { body: document, state: 'merged', commit: 'f'.repeat(40), namespace: spec.namespace, base: 'main', number: 3, path: intent.path }, ...change }
  const gh = async (method, path, body) => {
    calls.push({ method, path, body })
    if (state.onRequest) state.onRequest(method, path)
    if (method === 'GET' && path === '/repos/team/specs/pulls/3') {
      state.readCount++
      if (state.onRead) state.onRead(state.readCount)
      return structuredClone(state.pr)
    }
    if (method === 'GET' && path === `/repos/team/specs/compare/${base}...${'1'.repeat(40)}?per_page=1`) return { merge_base_commit: { sha: base }, status: 'ahead' }
    if (method === 'GET' && path === `/repos/team/specs/compare/${base}...${'8'.repeat(40)}?per_page=1`) return {
      merge_base_commit: { sha: base }, files: state.hiddenFiles || [{ filename: 'secret.txt', status: 'added' }] }
    if (method === 'GET' && path.startsWith('/repos/team/specs/compare/')) {
      if (state.comparisons?.[path]) return state.comparisons[path]
      if (path.endsWith('?per_page=100')) return state.comparison
      const parent = state.headParents?.at(-1)?.sha || base
      if (path === `/repos/team/specs/compare/${parent}...${head}?per_page=1`) return {
        merge_base_commit: { sha: parent }, files: state.headFiles || state.comparison.files
      }
      throw new Error(`Unexpected comparison ${path}`)
    }
    if (method === 'GET' && path.startsWith('/repos/team/specs/commits/') && path.includes('/check-runs?')) {
      return { total_count: state.checks.length, check_runs: state.checks }
    }
    if (method === 'GET' && path === `/repos/team/specs/git/commits/${head}`) return { sha: head, tree: { sha: tree }, parents: state.headParents || [{ sha: base }] }
    if (method === 'GET' && path === `/repos/team/specs/git/commits/${'8'.repeat(40)}`) return { sha: '8'.repeat(40), tree: { sha: '9'.repeat(40) }, parents: [{ sha: base }] }
    if (method === 'GET' && path === `/repos/team/specs/git/commits/${base}`) return { sha: base, tree: { sha: base } }
    if (method === 'GET' && path === `/repos/team/specs/git/commits/${'1'.repeat(40)}`) return { sha: '1'.repeat(40), tree: { sha: state.destinationChanged ? tree : base } }
    if (method === 'GET' && path === `/repos/team/specs/git/trees/${base}`) return { sha: base, truncated: false, tree: [] }
    if (method === 'GET' && path === `/repos/team/specs/git/trees/${tree}`) return { sha: tree, truncated: state.treeTruncated,
      tree: [{ path: 'specs', sha: directory, type: 'tree', mode: '040000' }] }
    if (method === 'GET' && path === `/repos/team/specs/git/trees/${directory}`) return { sha: directory, truncated: false,
      tree: [{ path: '001-requirement.md', sha: blob, type: 'blob', mode: state.mode },
        { path: 'README.md', sha: '7'.repeat(40), type: 'blob', mode: '100644' }] }
    if (method === 'GET' && path === `/repos/team/specs/git/trees/${'9'.repeat(40)}`) return { sha: '9'.repeat(40), truncated: false,
      tree: [{ path: 'specs', sha: '6'.repeat(40), type: 'tree', mode: '040000' }] }
    if (method === 'GET' && path === `/repos/team/specs/git/trees/${'6'.repeat(40)}`) return { sha: '6'.repeat(40), truncated: false,
      tree: [{ path: 'README.md', sha: '5'.repeat(40), type: 'blob', mode: '100644' }] }
    if (method === 'GET' && path === `/repos/team/specs/git/blobs/${blob}`) return { sha: blob, encoding: 'base64', size: Buffer.byteLength(state.document), content: Buffer.from(state.document).toString('base64') }
    if (method === 'GET' && path === `/repos/team/specs/git/blobs/${'7'.repeat(40)}`) return { sha: '7'.repeat(40), encoding: 'base64', size: 3, content: Buffer.from('Map').toString('base64') }
    if (method === 'GET' && path === `/repos/team/specs/git/blobs/${'5'.repeat(40)}`) return { sha: '5'.repeat(40), encoding: 'base64', size: 7, content: Buffer.from('Old map').toString('base64') }
    if (method === 'PUT' && path === '/repos/team/specs/pulls/3/update-branch') {
      assert.equal(body.expected_head_sha, head)
      return { message: 'Updating pull request branch.' }
    }
    if (method === 'PUT' && path === '/repos/team/specs/pulls/3/merge') {
      state.putCount++
      assert.equal(body.sha, head)
      if (state.refusedMerge) throw state.refusedMerge
      state.pr.merged_at = '2026-11-07T12:00:00Z'
      state.pr.state = 'closed'
      if (state.putError) throw state.putError
      return { merged: true }
    }
    throw new Error(`Unexpected ${method} ${path}`)
  }
  const merge = createPublicationAutoMerge({ gh,
    withPublicationLock: async (id, task) => {
      assert.equal(id, 'note')
      state.lockCount++
      state.locked = true
      if (state.onLock) state.onLock()
      try { return await task() } finally { state.locked = false }
    },
    authorize: async (intent, evidence) => {
      authorizations.push(evidence)
      if (state.onAuthorize) state.onAuthorize(evidence)
      return { authorized: state.authorized, candidate: state.candidate, roles: state.roles }
    }, artifacts: async () => state.extras, recover: async () => state.receipt })
  return { state, calls, authorizations, merge: () => merge(state.intent, 'token') }
}

test('merge policy is opt-in and requires explicit check names and App IDs', () => {
  assert.equal(mergePolicy({}), null)
  assert.equal(mergePolicy({ 'auto-merge': false }), null)
  for (const value of [true, {}, { method: 'merge', checks: [] }, { method: 'merge', checks: [{ name: 'validate' }] },
    { method: 'merge', checks: [{ name: 'validate', 'app-id': 1 }], bypass: true }]) {
    assert.throws(() => mergePolicy({ 'auto-merge': value }))
  }
})

test('merges only the reviewed head after two current authorization reads', async () => {
  const f = fixture()
  const result = await f.merge()
  assert.equal(result.state, 'merged')
  assert.equal(f.state.putCount, 1)
  assert.equal(f.state.lockCount, 1)
  assert.equal(f.authorizations.length, 2)
  assert.deepEqual(f.authorizations[1], { operation: 'merge', head: 'b'.repeat(40), checks: [{ id: 9, name: 'validate', appId: 15368, head: 'b'.repeat(40) }] })
})

test('disabled projects make no GitHub requests and redacted intents cannot run', async () => {
  const f = fixture({ roles: { approvers: ['42'], authors: ['42'], 'approvals-required': 1 } })
  assert.deepEqual(await f.merge(), { state: 'disabled' })
  assert.equal(f.calls.length, 0)
  const redacted = fixture()
  redacted.state.intent.redacted_at = '2026-11-07'
  await assert.rejects(redacted.merge(), /Invalid publication merge intent/)
  assert.equal(redacted.calls.length, 0)
})

test('unregistered, pending, unsuccessful, wrong App and wrong-head checks cannot merge', async () => {
  for (const patch of [null, { status: 'in_progress' }, { conclusion: 'failure' }, { conclusion: 'neutral' },
    { conclusion: 'skipped' }, { app: { id: 99 } }, { head_sha: '0'.repeat(40) }]) {
    const f = fixture()
    f.state.checks = patch ? [{ ...f.state.checks[0], ...patch }] : []
    assert.deepEqual(await f.merge(), { state: 'waiting', reason: 'checks' })
    assert.equal(f.state.putCount, 0)
    assert.ok(f.calls.every(call => !call.path.includes('/git/')), 'pending CI does not repeatedly fetch commit trees and blobs')
  }
  const f = fixture()
  f.state.checks.push({ ...f.state.checks[0], id: 10, status: 'queued', conclusion: null })
  assert.equal((await f.merge()).state, 'waiting')
  assert.equal(f.state.putCount, 0)
})

test('stale candidate, policy, revoked approval and late revocation fail before merge', async () => {
  for (const mutate of [s => { s.authorized = false }, s => { s.candidate = { ...s.candidate, hash: '0'.repeat(64) } },
    s => { s.roles = { ...s.roles, 'approvals-required': 2 } }]) {
    const f = fixture()
    mutate(f.state)
    await assert.rejects(f.merge(), /approval or policy changed/)
    assert.equal(f.state.putCount, 0)
  }
  const f = fixture()
  f.state.onAuthorize = evidence => { if (evidence) f.state.authorized = false }
  await assert.rejects(f.merge(), /approval or policy changed/)
  assert.equal(f.state.putCount, 0)
})

test('PR identity and head changes cannot be merged', async () => {
  for (const mutate of [s => { s.pr.body = 'unrelated' }, s => { s.pr.base.ref = 'other' },
    s => { s.pr.head.repo.full_name = 'other/repo' }, s => { s.pr.number = 4 }]) {
    const f = fixture()
    mutate(f.state)
    await assert.rejects(f.merge(), /identity changed/)
    assert.equal(f.state.putCount, 0)
  }
  const f = fixture()
  f.state.onRead = count => { if (count === 2) f.state.pr.head.sha = '1'.repeat(40) }
  assert.deepEqual(await f.merge(), { state: 'waiting', reason: 'changed' })
  assert.equal(f.state.putCount, 0)
  const movedBase = fixture()
  movedBase.state.onRead = count => { if (count === 2) movedBase.state.pr.base.sha = '1'.repeat(40) }
  assert.deepEqual(await movedBase.merge(), { state: 'waiting', reason: 'changed' })
  assert.equal(movedBase.state.putCount, 0)
})

test('unapproved files, changed bytes, symlinks and incomplete trees fail closed', async () => {
  for (const mutate of [s => { s.comparison.files.push({ filename: '.github/workflows/ci.yml', status: 'added' }) },
    s => { s.document += 'tampered' }, s => { s.mode = '120000' }, s => { s.treeTruncated = true },
    s => { s.comparison.files[0].status = 'renamed' }, s => { s.comparison.merge_base_commit.sha = 'invalid' }]) {
    const f = fixture()
    mutate(f.state)
    await assert.rejects(f.merge(), /unauthorized|authorization|regular file|incomplete|branch history/, String(mutate))
    assert.equal(f.state.putCount, 0)
  }
})

test('additional files need exact receipts bound to the same submission and branch', async () => {
  const f = fixture()
  f.state.comparison.files.push({ filename: 'specs/README.md', status: 'added', sha: '7'.repeat(40) })
  f.state.extras.push({ path: 'specs/README.md', documentHash: digest('Map'), namespace: 'team/specs', submission: f.state.intent.id, branch: f.state.intent.branch })
  assert.equal((await f.merge()).state, 'merged')
  const bad = fixture()
  bad.state.extras.push({ ...f.state.extras[0], branch: 'other' })
  await assert.rejects(bad.merge(), /artifact receipt/)
  assert.equal(bad.state.putCount, 0)
})

test('lost merge responses recover a matching receipt without repeating the merge', async () => {
  const f = fixture({ putError: new Error('Connection lost') })
  assert.equal((await f.merge()).state, 'merged')
  assert.equal((await f.merge()).state, 'merged')
  assert.equal(f.state.putCount, 1)
  const bad = fixture()
  bad.state.receipt = { ...bad.state.receipt, body: 'different' }
  await assert.rejects(bad.merge(), /could not be verified/)
})

test('closed PRs remain closed and unknown mergeability waits', async () => {
  const closed = fixture()
  closed.state.pr.state = 'closed'
  assert.deepEqual(await closed.merge(), { state: 'closed' })
  assert.equal(closed.state.putCount, 0)
  const unknown = fixture()
  unknown.state.pr.mergeable = null
  assert.deepEqual(await unknown.merge(), { state: 'waiting', reason: 'mergeability' })
  assert.equal(unknown.state.putCount, 0)
  const blocked = fixture()
  blocked.state.pr.mergeable_state = 'blocked'
  assert.deepEqual(await blocked.merge(), { state: 'waiting', reason: 'mergeability' })
  assert.equal(blocked.state.putCount, 0, 'a privileged service token must not merge a PR GitHub reports as blocked')
})

test('updates an unchanged destination after the base advances, then waits for new checks', async () => {
  const f = fixture()
  f.state.pr.base.sha = '1'.repeat(40)
  f.state.comparison.status = 'diverged'
  assert.deepEqual(await f.merge(), { state: 'waiting', reason: 'branch-updated' })
  assert.equal(f.state.putCount, 0)
  assert.ok(f.calls.some(call => call.path.endsWith('/update-branch')))
  assert.equal(f.authorizations[1].operation, 'update-branch')
  const changed = fixture({ destinationChanged: true })
  changed.state.pr.base.sha = '1'.repeat(40)
  changed.state.comparison.status = 'diverged'
  await assert.rejects(changed.merge(), /destination changed/)
  assert.ok(changed.calls.every(call => call.method === 'GET'))
})

test('a hidden intermediate file change is refused even when the final diff is authorized', async () => {
  const f = fixture()
  f.state.comparison.total_commits = 2
  f.state.comparison.commits.unshift({ sha: '8'.repeat(40) })
  await assert.rejects(f.merge(), /unauthorized file change/)
  assert.equal(f.state.putCount, 0)
})

test('commit history must be complete and include the checked head', async () => {
  for (const mutate of [s => { s.comparison.total_commits = 101 }, s => { s.comparison.commits = [] },
    s => { s.headParents = [] }]) {
    const f = fixture()
    mutate(f.state)
    await assert.rejects(f.merge(), /branch history|ancestry/)
    assert.equal(f.state.putCount, 0)
  }
})

test('old generated map commits require their own retained authorization hash', async () => {
  for (const retained of [true, false]) {
    const f = fixture()
    f.state.comparison.files.push({ filename: 'specs/README.md', status: 'added', sha: '7'.repeat(40) })
    f.state.comparison.total_commits = 2
    f.state.comparison.commits.unshift({ sha: '8'.repeat(40) })
    f.state.hiddenFiles = [{ filename: 'specs/README.md', status: 'added', sha: '5'.repeat(40) }]
    f.state.extras.push({ path: 'specs/README.md', documentHash: digest('Map'), previousHashes: retained ? [digest('Old map')] : [],
      namespace: 'team/specs', submission: f.state.intent.id, branch: f.state.intent.branch })
    if (retained) assert.equal((await f.merge()).state, 'merged')
    else {
      await assert.rejects(f.merge(), /differs from its authorization/)
      assert.equal(f.state.putCount, 0)
    }
  }
})

test('a checked branch-update merge keeps its inherited base changes out of the publication diff', async () => {
  const f = fixture()
  f.state.pr.base.sha = '1'.repeat(40)
  f.state.comparison.merge_base_commit.sha = f.state.pr.base.sha
  f.state.headParents = [{ sha: 'a'.repeat(40) }, { sha: f.state.pr.base.sha }]
  assert.equal((await f.merge()).state, 'merged')
})

test('preflight permits discussion mutations and final locked authorization catches a new blocker', async () => {
  const f = fixture()
  f.state.onRequest = (method, path) => {
    if (path.includes('/git/')) {
      assert.equal(!!f.state.locked, false, 'remote history validation must not hold the note lock')
      f.state.authorized = false
    }
  }
  await assert.rejects(f.merge(), /approval or policy changed/)
  assert.equal(f.state.putCount, 0)
  assert.equal(f.state.lockCount, 1)
})

test('artifact and check changes during preflight prevent a grant', async () => {
  for (const kind of ['artifact', 'check']) {
    const f = fixture()
    f.state.onLock = () => {
      if (kind === 'artifact') f.state.extras.push({ path: 'specs/README.md', documentHash: digest('Map'),
        namespace: f.state.intent.namespace, submission: f.state.intent.id, branch: f.state.intent.branch })
      else f.state.checks[0].id++
    }
    assert.deepEqual(await f.merge(), { state: 'waiting', reason: kind === 'artifact' ? 'changed' : 'checks' })
    assert.equal(f.state.putCount, 0)
    assert.equal(f.authorizations.length, 1)
  }
})

test('empty branch commits and unrelated merge parents cannot reach the protected branch', async () => {
  const empty = fixture()
  empty.state.headFiles = []
  await assert.rejects(empty.merge(), /contains no authorized file change/)
  assert.equal(empty.state.putCount, 0)
  const unrelated = fixture()
  const parent = '3'.repeat(40)
  unrelated.state.headParents = [{ sha: 'a'.repeat(40) }, { sha: parent }]
  unrelated.state.comparisons = { [`/repos/team/specs/compare/${parent}...${'a'.repeat(40)}?per_page=1`]: {
    merge_base_commit: { sha: '4'.repeat(40) }, status: 'diverged'
  } }
  await assert.rejects(unrelated.merge(), /unrelated parent/)
  assert.equal(unrelated.state.putCount, 0)
})

test('repository protection refusals wait while transport and unexpected failures remain errors', async () => {
  const blocked = fixture({ refusedMerge: Object.assign(new Error('Merge refused'), { status: 405 }) })
  assert.deepEqual(await blocked.merge(), { state: 'waiting', reason: 'repository-policy' })
  assert.equal(blocked.state.putCount, 1)
  const failed = fixture({ refusedMerge: Object.assign(new Error('Transport failed'), { status: 503 }) })
  await assert.rejects(failed.merge(), /Transport failed/)
  assert.equal(failed.state.putCount, 1)
  for (const change of [pr => { pr.head.sha = '1'.repeat(40) }, pr => { pr.base.sha = '1'.repeat(40) },
    pr => { pr.state = 'closed' }]) {
    const changed = fixture({ refusedMerge: Object.assign(new Error('Merge refused'), { status: 405 }) })
    changed.state.onRead = count => { if (count === 3) change(changed.state.pr) }
    await assert.rejects(changed.merge(), /Merge refused/)
    assert.equal(changed.state.putCount, 1)
  }
})

test('a verified merge during preflight is recovered under the lock without a second merge', async () => {
  const f = fixture()
  f.state.onRead = count => {
    if (count === 2) {
      f.state.pr.state = 'closed'
      f.state.pr.merged_at = '2026-11-07T12:00:00Z'
    }
  }
  assert.equal((await f.merge()).state, 'merged')
  assert.equal(f.state.putCount, 0)
  assert.equal(f.state.lockCount, 1)
  assert.deepEqual(f.authorizations, [undefined, undefined])
})
