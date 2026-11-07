'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { closePendingPublication } = require('./publication-replacement')
const { digest, publicationDocument } = require('./publication-candidate')

function fixture () {
  const id = '00000000-0000-4000-8000-000000000001'
  const metadata = { format: 1, noteId: 'note', namespace: 'team/specs', submission: id,
    candidate: digest('candidate'), bodyHash: digest('requirement'), relations: {} }
  const document = publicationDocument('requirement', metadata)
  const intent = { id, note_id: 'note', namespace: 'team/specs', candidate_hash: metadata.candidate,
    path: 'specs/001-requirement.md', branch: 'specdoc/note-intent', base_branch: 'main', pr_number: 1,
    document, document_hash: digest(document), relations: {} }
  const pr = { number: 1, state: 'open', head: { ref: intent.branch, sha: 'a'.repeat(40), repo: { full_name: 'team/specs' } },
    base: { ref: 'main', repo: { full_name: 'team/specs' } }, body: `<!-- specdoc-intent:${id};candidate:${metadata.candidate};note:note -->` }
  const calls = []
  let onClose = () => { pr.state = 'closed' }
  let content = document
  const gh = async (method, route) => {
    calls.push({ method, route })
    if (method === 'PATCH') { await onClose(); return pr }
    if (route.includes('/contents/')) return { encoding: 'base64', content: Buffer.from(content).toString('base64') }
    return structuredClone(pr)
  }
  const recover = async () => ({ state: 'merged', number: 1, namespace: intent.namespace, base: 'main',
    path: intent.path, commit: 'b'.repeat(40), body: document })
  return { intent, pr, calls, close: () => closePendingPublication(gh, recover, intent, 'fixture-token'),
    onClose: fn => { onClose = fn }, content: text => { content = text } }
}

test('replacement closes only its verified submission and retains the exact head', async () => {
  const f = fixture()
  const result = await f.close()
  assert.deepEqual(result.closed, { submission: f.intent.id, namespace: 'team/specs', number: 1, head: 'a'.repeat(40) })
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 1)
})

test('replacement verifies repository, marker, branch and document before closing', async () => {
  for (const mutate of [f => { f.pr.body = '' }, f => { f.pr.head.ref = 'other' },
    f => { f.pr.head.repo.full_name = 'attacker/specs' }, f => f.content('Unreviewed text')]) {
    const f = fixture()
    mutate(f)
    await assert.rejects(f.close(), /authorized submission/)
    assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0)
  }
})

test('lost close response recovers only a verified closed PR', async () => {
  const f = fixture()
  f.onClose(() => { f.pr.state = 'closed'; throw new Error('Connection lost') })
  assert.ok((await f.close()).closed)
  const failed = fixture()
  failed.onClose(() => { throw new Error('Connection lost') })
  await assert.rejects(failed.close(), /Connection lost/)
})

test('a merge before or during closing preserves the original publication', async () => {
  for (const before of [false, true]) {
    const f = fixture()
    if (before) f.pr.merged = true
    else f.onClose(() => { f.pr.state = 'closed'; f.pr.merged_at = '2026-11-07T00:00:00Z' })
    const result = await f.close()
    assert.equal(result.merged.number, 1)
    assert.equal(result.closed, undefined)
  }
})

test('a changed head or identity during closing cannot clear publication state', async () => {
  for (const mutate of [f => { f.pr.head.sha = 'b'.repeat(40) }, f => { f.pr.base.ref = 'other' }]) {
    const f = fixture()
    f.onClose(() => { f.pr.state = 'closed'; mutate(f) })
    await assert.rejects(f.close(), /changed while closing|does not match/)
  }
})

test('a previously closed submission is verified without another close request', async () => {
  const f = fixture()
  f.pr.state = 'closed'
  assert.ok((await f.close()).closed)
  assert.equal(f.calls.filter(c => c.method === 'PATCH').length, 0)
})

test('a closed unmerged PR can be superseded after its branch content changed', async () => {
  const f = fixture()
  f.pr.state = 'closed'
  f.content('A manual change to the abandoned branch')
  assert.ok((await f.close()).closed)
  assert.ok(f.calls.every(call => call.method === 'GET' && !call.route.includes('/contents/')))
})

test('a push racing the close can be reconciled after the PR is closed', async () => {
  const f = fixture()
  f.onClose(() => {
    f.pr.state = 'closed'
    f.pr.head.sha = 'c'.repeat(40)
    f.content('A racing branch change')
  })
  await assert.rejects(f.close(), /changed while closing/)
  assert.equal((await f.close()).closed.head, 'c'.repeat(40))
  assert.equal(f.calls.filter(call => call.method === 'PATCH').length, 1)
})
