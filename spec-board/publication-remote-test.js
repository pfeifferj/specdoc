const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { Pool } = require('pg')
const { candidate, digest, publicationDocument } = require('./publication-candidate')

async function run () {
  process.env.GITHUB_TOKEN ||= 'remote-publication-test'
  const { openSpecPr, publishedBody } = require('./server')
  const priorFetch = global.fetch
  const priorQuery = Pool.prototype.query
  const spec = { id: 'note', namespace: 'o/r', title: 'Requirement', url: 'https://editor.test/note', category: '',
    content: '---\ntags: [spec, approved]\n---\nReviewed text.\n', permission: 'editable', ownerSubject: '10',
    roles: { authors: ['10'], approvers: [], 'approvals-required': 0, 'specs-dir': 'specs' }, supersedes: null, dependsOn: [] }
  const makeIntent = (source = spec, revision = 0, target = null) => {
    const id = crypto.randomUUID()
    const c = candidate(source, source.content)
    const body = publishedBody(source)
    const relations = { supersedes: source.supersedes, dependsOn: source.dependsOn }
    const document = publicationDocument(body, { format: 1, noteId: source.id, namespace: source.namespace, submission: id, candidate: c.hash, bodyHash: digest(body), relations })
    return { id, note_id: source.id, namespace: source.namespace, candidate_hash: c.hash, document, document_hash: digest(document),
      relations, spec: structuredClone(source), identities: { author: { name: 'Writer', email: 'writer@example.test' }, reviewers: [{ name: 'Reviewer', email: 'reviewer@example.test' }] },
      path: target, branch: `specdoc/${source.id}-${id}`, revision }
  }
  const files = new Map()
  const baseFiles = new Map()
  const refs = new Set()
  const pulls = []
  const calls = []
  const events = []
  let forceFile = null, assignmentLost = false, mapReads = 0
  const base = 'a'.repeat(40), head = 'b'.repeat(40), merge = 'c'.repeat(40)
  const ok = value => new Response(JSON.stringify(value), { status: 200 })
  const file = text => ({ encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64'), sha: 'blob' })
  const missing = () => new Response('{}', { status: 404 })
  Pool.prototype.query = async function (sql, values) {
    if (sql.startsWith('INSERT INTO spec_board_governance_events')) {
      events.push({ action: values[2], evidence: JSON.parse(values[3]) })
      return { rowCount: 1, rows: [] }
    }
    if (!sql.startsWith('UPDATE spec_board_publication_intents SET ')) mapReads++
    assert.match(sql, /^UPDATE spec_board_publication_intents SET /)
    return { rowCount: assignmentLost ? 0 : 1, rows: [] }
  }
  global.fetch = async (url, options) => {
    const u = new URL(url)
    const route = u.pathname
    const method = options.method
    const body = options.body && JSON.parse(options.body)
    calls.push({ route, method, body })
    if (method === 'GET' && route === '/repos/o/r') return ok({ default_branch: 'main', private: false })
    if (method === 'GET' && route === '/repos/o/r/git/ref/heads/main') return ok({ object: { sha: base } })
    if (method === 'GET' && route.startsWith('/repos/o/r/git/ref/heads/')) return ok({ object: { sha: head } })
    if (method === 'GET' && route === '/repos/o/r/contents/specs') return ok([{ type: 'file', name: '007-existing.md' }])
    if (method === 'GET' && route === '/repos/o/r/git/matching-refs/heads/') return ok([...refs].map(ref => ({ ref: 'refs/heads/' + ref })))
    if (method === 'GET' && route === '/repos/o/r/pulls') return ok(pulls.filter(p => `o:${p.head.ref}` === u.searchParams.get('head')))
    if (method === 'GET' && route === '/repos/o/r/pulls/7/files') return ok([{ filename: 'specs/007-existing.md' }])
    if (method === 'GET' && /^\/repos\/o\/r\/pulls\/\d+$/.test(route)) return ok(pulls.find(p => p.number === Number(route.split('/').pop())))
    if (method === 'POST' && route === '/repos/o/r/git/refs') {
      const ref = body.ref.replace('refs/heads/', '')
      if (refs.has(ref)) return new Response('{}', { status: 422 })
      refs.add(ref)
      return ok({})
    }
    if (method === 'GET' && route.startsWith('/repos/o/r/contents/')) {
      if (forceFile !== null) return ok(file(forceFile))
      const path = route.slice('/repos/o/r/contents/'.length)
      const text = u.searchParams.get('ref') === base && baseFiles.has(path) ? baseFiles.get(path) : files.get(path)
      return text === undefined ? missing() : ok(file(text))
    }
    if (method === 'PUT' && route.startsWith('/repos/o/r/contents/')) {
      files.set(route.slice('/repos/o/r/contents/'.length), Buffer.from(body.content, 'base64').toString())
      return ok({ commit: { sha: head } })
    }
    if (method === 'POST' && route === '/repos/o/r/pulls') {
      const pr = { number: 30 + pulls.length, state: 'open', body: body.body,
        head: { ref: body.head, repo: { full_name: 'o/r' }, sha: head }, base: { ref: body.base, repo: { full_name: 'o/r' } } }
      pulls.push(pr)
      return ok(pr)
    }
    throw new Error(`Unexpected GitHub request ${method} ${route}`)
  }
  try {
    await assert.rejects(openSpecPr(spec, ''), /immutable authorized publication intent/)
    assert.equal(calls.length, 0)
    assignmentLost = true
    await assert.rejects(openSpecPr(spec, '', {}, null, { intent: makeIntent() }), /assigned concurrently/)
    assert.ok(calls.every(call => call.method === 'GET'), 'a lost destination CAS must not write to GitHub')
    assignmentLost = false
    calls.length = 0
    const intent = makeIntent()
    const changedAfterClaim = { ...spec, title: 'Unapproved title', content: 'Unapproved content' }
    const opened = await openSpecPr(changedAfterClaim, '', {}, null, { intent })
    assert.equal(opened.path, 'specs/008-requirement.md')
    assert.equal(files.get(opened.path), intent.document, 'only the exact authorized bytes are sent')
    assert.ok(pulls[0].body.includes(`specdoc-intent:${intent.id};candidate:${intent.candidate_hash};note:note`))
    assert.ok(calls.find(c => c.method === 'PUT').body.message.includes(`Spec-Submission: ${intent.id}`))
    const initialWrites = calls.filter(call => call.method === 'PUT' && call.route.endsWith(opened.path)).length
    const reused = await openSpecPr(spec, '', {}, null, { intent })
    assert.equal(reused.number, opened.number)
    assert.equal(pulls.length, 1)
    assert.equal(calls.filter(call => call.method === 'PUT' && call.route.endsWith(opened.path)).length,
      initialWrites, 'retrying an identical publication cannot create an empty commit')
    const originalBody = pulls[0].body
    pulls[0].body = 'An unrelated PR with the same branch name'
    const before = calls.filter(c => c.method !== 'GET').length
    await assert.rejects(openSpecPr(spec, '', {}, null, { intent }), /does not match/)
    assert.equal(calls.filter(c => c.method !== 'GET').length, before)
    pulls[0].body = originalBody
    pulls[0].base.ref = 'unprotected'
    await assert.rejects(openSpecPr(spec, '', {}, null, { intent }), /does not match/)
    pulls[0].base.ref = 'main'
    pulls[0].merged_at = '2026-01-01'
    pulls[0].merge_commit_sha = merge
    pulls[0].state = 'closed'
    calls.length = 0
    const recovered = await openSpecPr(spec, '', {}, null, { intent })
    assert.equal(recovered.commit, merge)
    assert.equal(recovered.body, intent.document)
    assert.ok(calls.every(call => call.method === 'GET'), 'a verified merged candidate is never rewritten')
    forceFile = intent.document + 'tampered'
    await assert.rejects(openSpecPr(spec, '', {}, null, { intent }), /metadata|authorized candidate/)
    forceFile = null

    const revision = makeIntent(spec, 1, opened.path)
    calls.length = 0
    const revised = await openSpecPr(spec, '', {}, { n: 1, path: opened.path }, { intent: revision })
    assert.equal(revised.path, opened.path)
    assert.equal(files.get(opened.path), revision.document)
    assert.ok(calls.find(c => c.method === 'POST' && c.route.endsWith('/pulls')).body.title.includes('(rev 1)'))
    const revisionWrites = calls.filter(call => call.method === 'PUT' && call.route.endsWith(opened.path)).length
    assert.equal((await openSpecPr(spec, '', {}, { n: 1, path: opened.path }, { intent: revision })).number, revised.number)
    assert.equal(calls.filter(call => call.method === 'PUT' && call.route.endsWith(opened.path)).length,
      revisionWrites, 'revision recovery leaves the reviewed tree unchanged')
    pulls[1].state = 'closed'
    calls.length = 0
    const closed = await openSpecPr(spec, '', {}, { n: 1, path: opened.path }, { intent: revision })
    assert.equal(closed.state, 'closed')
    assert.equal(pulls.length, 2, 'a deliberately closed PR is not reopened by retry')
    assert.ok(calls.every(call => call.method === 'GET'))

    const duplicate = makeIntent({ ...spec, id: 'another-note' })
    const next = await openSpecPr(duplicate.spec, '', {}, null, { intent: duplicate })
    assert.equal(next.path, 'specs/009-requirement.md', 'same-title notes cannot adopt another note branch or path')

    const automated = makeIntent({ ...spec, id: 'automated', title: 'Independent publication',
      roles: { ...spec.roles, 'auto-merge': { method: 'merge', checks: [{ name: 'validate', 'app-id': 15368 }] } } })
    calls.length = 0
    await openSpecPr(automated.spec, '', {}, null, { intent: automated, specs: [automated.spec], state: new Map() })
    assert.equal(mapReads, 0, 'auto-merged publications do not read the shared generated map')
    assert.equal(calls.some(call => call.method === 'PUT' && call.route.endsWith('/README.md')), false,
      'concurrent auto-merged specs cannot conflict through a shared generated map')

    const oldPath = 'specs/007-existing.md'
    const oldDocument = '# Existing requirement\n\nOriginal text.\n'
    files.set(oldPath, oldDocument)
    baseFiles.set(oldPath, oldDocument)
    const replacement = makeIntent({ ...spec, id: 'replacement', supersedes: { ns: 'o/r', n: 7 } })
    const replacementPr = await openSpecPr(replacement.spec, '', {}, null, { intent: replacement })
    const stamp = `> **Superseded by o/r#${replacementPr.number}.**\n\n${oldDocument}`
    assert.equal(files.get(oldPath), stamp)
    assert.deepEqual(events.at(-1), { action: 'supersession-stamp-authorized', evidence: {
      namespace: 'o/r', submission: replacement.id, branch: replacement.branch, path: oldPath, documentHash: digest(stamp), source: base
    } })
    const beforeStampEvents = events.length
    files.set(oldPath, stamp + 'Unreviewed addition.\n')
    const beforeStampWrites = calls.filter(c => c.method === 'PUT' && c.route.endsWith(oldPath)).length
    await openSpecPr(replacement.spec, '', {}, null, { intent: replacement })
    assert.equal(events.length, beforeStampEvents, 'changed branch text cannot obtain a stamp receipt')
    assert.equal(calls.filter(c => c.method === 'PUT' && c.route.endsWith(oldPath)).length, beforeStampWrites)
    console.log('publication remote: immutable payloads, PR/path ownership, branch identity, merge verification and retries passed')
  } finally {
    global.fetch = priorFetch
    Pool.prototype.query = priorQuery
  }
}

module.exports = { run }
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1 })
