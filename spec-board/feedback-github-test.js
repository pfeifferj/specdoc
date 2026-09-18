const assert = require('assert')
const crypto = require('crypto')
const { createFeedbackGitHub } = require('./feedback-github')

const a = 'a'.repeat(40)
const b = 'b'.repeat(40)
const c = 'c'.repeat(40)
const day = 86400000
const at = Date.parse('2026-09-17T12:00:00Z')
const repo = 'owner/code'
const pr = {
  number: 7,
  body: 'implements owner/specs#12\nimplements #15\nimplements owner/specs#12',
  head: { sha: a, ref: 'retry-jitter' },
  base: { repo: { full_name: repo } },
  merge_commit_sha: b,
  merged_at: '2026-09-16T12:00:00Z',
  updated_at: '2026-09-17T10:00:00Z'
}
const root = {
  id: 21, body: 'Retries need jitter.', path: 'src/retry.js', diff_hunk: '@@ -1 +1 @@\n+retry()',
  commit_id: a, original_commit_id: c, line: 1, original_line: 1, side: 'RIGHT',
  pull_request_review_id: 10, created_at: '2026-09-15T12:00:00Z', updated_at: '2026-09-15T12:00:00Z', user: { login: 'reviewer' }
}
const reply = { ...root, id: 22, in_reply_to_id: 21, body: 'Added jitter and a bound.', created_at: '2026-09-15T13:00:00Z', user: { login: 'author' } }
const clone = value => JSON.parse(JSON.stringify(value))

function fixture (override = {}) {
  const routes = {
    [`/repos/${repo}`]: { full_name: repo, private: false, visibility: 'public', default_branch: 'main' },
    [`/repos/${repo}/pulls/7`]: pr,
    [`/repos/${repo}/pulls/7/reviews?per_page=100&page=1`]: [
      { id: 10, body: 'Please bound retries.', state: 'CHANGES_REQUESTED', submitted_at: '2026-09-15T12:00:00Z', commit_id: c, user: { login: 'reviewer' } },
      { id: 11, body: 'Unsubmitted private draft.', state: 'PENDING' }
    ],
    [`/repos/${repo}/pulls/7/comments?per_page=100&page=1`]: [reply, root],
    [`/repos/${repo}/issues/7/comments?per_page=100&page=1`]: [{ id: 31, body: 'The final patch fixes the bound.', created_at: '2026-09-16T11:00:00Z', user: { login: 'reviewer' }, html_url: 'https://attacker.invalid/' }],
    [`/repos/${repo}/pulls/7/files?per_page=100&page=1`]: [{ filename: 'src/retry.js', patch: '@@ -1 +1 @@\n-retry()\n+retry(jitter, 5)', status: 'modified' }],
    ...override
  }
  const calls = []
  const gh = async (method, path) => {
    calls.push({ method, path })
    assert.strictEqual(method, 'GET')
    assert.ok(Object.hasOwn(routes, path), `unexpected route ${path}`)
    const value = routes[path]
    if (value instanceof Error) throw value
    return clone(typeof value === 'function' ? value() : value)
  }
  return { gh, calls, routes }
}

async function main () {
  {
    const f = fixture()
    const api = createFeedbackGitHub(f.gh)
    const evidence = await api.evidence(repo, 7)
    assert.deepStrictEqual(evidence.links, [{ ns: 'owner/specs', n: 12 }, { ns: repo, n: 15 }])
    assert.strictEqual(evidence.headSha, a)
    assert.strictEqual(evidence.mergeSha, b)
    assert.deepStrictEqual(evidence.groups.map(g => g.id), ['discussion:31', 'inline:21', 'review:10'])
    assert.deepStrictEqual(evidence.groups[1].entries.map(e => e.id), ['inline:21', 'inline:22'])
    assert.strictEqual(evidence.groups[1].entries[0].originalCommitId, c)
    assert.strictEqual(evidence.groups[0].entries[0].url, `https://github.com/${repo}/pull/7#issuecomment-31`)
    assert.ok(!JSON.stringify(evidence).includes('Unsubmitted private draft'))
    assert.strictEqual(api.calls, 7)
    assert.strictEqual(api.remaining, 17)
    const reversed = fixture({ [`/repos/${repo}/pulls/7/comments?per_page=100&page=1`]: [root, reply] })
    assert.strictEqual((await createFeedbackGitHub(reversed.gh).evidence(repo, 7)).hash, evidence.hash)
    const edited = fixture({ [`/repos/${repo}/pulls/7/comments?per_page=100&page=1`]: [{ ...root, body: 'No jitter is needed.' }, reply] })
    assert.notStrictEqual((await createFeedbackGitHub(edited.gh).evidence(repo, 7)).hash, evidence.hash)
  }

  {
    const f = fixture({ [`/repos/${repo}`]: { private: true, visibility: 'private' } })
    await assert.rejects(createFeedbackGitHub(f.gh).evidence(repo, 7), e => e.code === 'inaccessible')
    assert.strictEqual(f.calls.length, 1)
    const hidden = fixture({ [`/repos/${repo}`]: Object.assign(new Error('secret credential and remote body'), { status: 404 }) })
    await assert.rejects(createFeedbackGitHub(hidden.gh).publicRepo(repo), e => e.code === 'inaccessible' && !e.message.includes('secret'))
    const unknown = fixture({ [`/repos/${repo}`]: {} })
    await assert.rejects(createFeedbackGitHub(unknown.gh).publicRepo(repo), e => e.code === 'incomplete')
    let privateRepo = false
    const changed = fixture({ [`/repos/${repo}`]: () => ({ private: privateRepo }) })
    const api = createFeedbackGitHub(changed.gh)
    assert.strictEqual(await api.publicRepo(repo), true)
    privateRepo = true
    assert.strictEqual(await api.publicRepo(repo, true), false)
    assert.strictEqual(api.calls, 2, 'visibility refresh uses the same call budget')
  }

  {
    const probes = {
      [`/repos/${repo}/issues?state=all&per_page=1`]: [],
      [`/repos/${repo}/pulls?state=all&per_page=1`]: [{ number: 7 }]
    }
    const f = fixture(probes)
    const api = createFeedbackGitHub(f.gh)
    assert.deepStrictEqual(await api.preflight(repo), { ok: true })
    assert.strictEqual(api.calls, 3)
    assert.ok(f.calls.every(call => !call.path.includes('/contents/')), 'source preflight needs no contents access')
    for (const kind of ['issues', 'pulls']) {
      const route = `/repos/${repo}/${kind}?state=all&per_page=1`
      const denied = fixture({ ...probes, [route]: Object.assign(new Error('private upstream detail'), { status: 403 }) })
      await assert.rejects(createFeedbackGitHub(denied.gh).preflight(repo), error => error.code === 'inaccessible' && error.status === 403 && !error.message.includes('private upstream'))
      const malformed = fixture({ ...probes, [route]: { message: 'scope unavailable' } })
      await assert.rejects(createFeedbackGitHub(malformed.gh).preflight(repo), error => error.code === 'incomplete' && error.retryable)
    }
    const privateRepo = fixture({ ...probes, [`/repos/${repo}`]: { private: true } })
    await assert.rejects(createFeedbackGitHub(privateRepo.gh).preflight(repo), error => error.code === 'inaccessible')
    assert.strictEqual(privateRepo.calls.length, 1)
    const budget = createFeedbackGitHub(fixture(probes).gh, { maxCalls: 2 })
    await assert.rejects(budget.preflight(repo), error => error.code === 'budget' && error.retryable)
  }

  {
    for (const body of ['', 'The commit has an implements trailer.']) {
      const f = fixture({ [`/repos/${repo}/pulls/7`]: { ...pr, body } })
      await assert.rejects(createFeedbackGitHub(f.gh).evidence(repo, 7), e => e.code === 'ineligible')
      assert.strictEqual(f.calls.length, 2)
    }
    for (const state of ['open', 'closed']) {
      const unmerged = fixture({ [`/repos/${repo}/pulls/7`]: { ...pr, merged_at: null, state } })
      await assert.rejects(createFeedbackGitHub(unmerged.gh).evidence(repo, 7), e => e.code === 'unmerged')
      assert.strictEqual(unmerged.calls.length, 2, 'unmerged pull requests do not fetch discussion or files')
    }
    for (const invalidPr of [{ ...pr, merged_at: null }, { merged_at: null, state: 'open' }, { ...pr, merged_at: 'invalid', state: 'closed' }]) {
      const malformed = fixture({ [`/repos/${repo}/pulls/7`]: invalidPr })
      await assert.rejects(createFeedbackGitHub(malformed.gh).evidence(repo, 7), e => e.code === 'ineligible')
    }
    const generated = fixture({ [`/repos/${repo}/pulls/7`]: { ...pr, head: { sha: a, ref: 'api/012-retry-r1' }, body: pr.body + '\nSpec note: https://specs.example/note' } })
    await assert.rejects(createFeedbackGitHub(generated.gh).evidence(repo, 7), e => e.code === 'ineligible')
    const principle = fixture({ [`/repos/${repo}/pulls/7`]: { ...pr, head: { sha: a, ref: 'project-principles-r4' }, body: pr.body + '\nSpec note: https://specs.example/principles' } })
    await assert.rejects(createFeedbackGitHub(principle.gh).evidence(repo, 7), e => e.code === 'ineligible')
    const numericCodeBranch = fixture({ [`/repos/${repo}/pulls/7`]: { ...pr, head: { sha: a, ref: 'api/012-retry-r1' } } })
    assert.strictEqual((await createFeedbackGitHub(numericCodeBranch.gh).evidence(repo, 7)).number, 7)
  }

  {
    const missing = fixture({ [`/repos/${repo}/pulls/7/comments?per_page=100&page=1`]: [reply] })
    await assert.rejects(createFeedbackGitHub(missing.gh).evidence(repo, 7), e => e.code === 'incomplete')
    const noPatch = fixture({ [`/repos/${repo}/pulls/7/files?per_page=100&page=1`]: [{ filename: 'src/retry.js' }] })
    await assert.rejects(createFeedbackGitHub(noPatch.gh).evidence(repo, 7), e => e.code === 'incomplete')
    const shortPatch = fixture({ [`/repos/${repo}/pulls/7/files?per_page=100&page=1`]: [{ filename: 'src/retry.js', patch: '@@ -1 +1 @@\n+retry()', additions: 20, deletions: 1 }] })
    await assert.rejects(createFeedbackGitHub(shortPatch.gh).evidence(repo, 7), e => e.code === 'incomplete' && /truncated/.test(e.message))
    const conflicting = fixture({ [`/repos/${repo}/pulls/7/comments?per_page=100&page=1`]: [root, { ...root, body: 'Changed while paginating.' }] })
    await assert.rejects(createFeedbackGitHub(conflicting.gh).evidence(repo, 7), e => e.code === 'incomplete' && e.retryable)
    let reads = 0
    const moving = fixture({ [`/repos/${repo}/pulls/7`]: () => ++reads === 1 ? pr : { ...pr, head: { ...pr.head, sha: c } } })
    await assert.rejects(createFeedbackGitHub(moving.gh).evidence(repo, 7), e => e.code === 'incomplete' && e.retryable)
    const capped = fixture({ [`/repos/${repo}/pulls/7/reviews?per_page=100&page=1`]: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, body: 'review', state: 'APPROVED' })) })
    await assert.rejects(createFeedbackGitHub(capped.gh, { maxPages: 1 }).evidence(repo, 7), e => e.code === 'incomplete' && /pagination/.test(e.message))
    await assert.rejects(createFeedbackGitHub(fixture().gh, { maxBytes: 100 }).evidence(repo, 7), e => e.code === 'incomplete')
    const limited = createFeedbackGitHub(fixture().gh, { maxCalls: 2 })
    await assert.rejects(limited.evidence(repo, 7), e => e.code === 'budget' && e.retryable)
    assert.strictEqual(limited.remaining, 0)
  }

  {
    const timestamp = '2026-09-17T10:00:00Z'
    const row = n => ({ id: n, number: n, body: 'implements owner/specs#12', updated_at: timestamp, pull_request: {} })
    const calls = []
    const gh = async (method, path) => {
      calls.push(path)
      if (path === `/repos/${repo}`) return { private: false }
      const url = new URL(path, 'https://api.github.com')
      assert.strictEqual(url.searchParams.get('since'), new Date(at - 30 * day).toISOString())
      assert.strictEqual(url.searchParams.get('sort'), 'updated')
      assert.strictEqual(url.searchParams.get('direction'), 'asc')
      const page = Number(url.searchParams.get('page'))
      if (page === 1) return Array.from({ length: 100 }, (_, i) => row(i + 1))
      if (page === 2) return Array.from({ length: 100 }, (_, i) => row(i + 100))
      if (page === 3) return [row(200)]
      throw new Error('unexpected page')
    }
    const first = await createFeedbackGitHub(gh, { now: () => at }).discover(repo)
    assert.strictEqual(first.complete, false)
    assert.strictEqual(first.items.length, 199, 'reordered duplicate is emitted once')
    assert.strictEqual(first.scan.page, 3)
    const persisted = JSON.stringify(first.scan)
    const second = await createFeedbackGitHub(gh, { now: () => at }).discover(repo, JSON.parse(persisted))
    assert.strictEqual(second.complete, true)
    assert.deepStrictEqual(second.items.map(i => i.number), [200])
    assert.strictEqual(JSON.stringify(first.scan), persisted, 'input cursor is not mutated')
    assert.strictEqual(second.scan.watermark, Date.parse(timestamp))
    const idle = await createFeedbackGitHub(() => { throw new Error('idle scan fetched') }, { now: () => at }).discover(repo, second.scan)
    assert.deepStrictEqual(idle.items, [])
    assert.strictEqual(idle.complete, true)
    const replay = []
    const reconcile = createFeedbackGitHub(async (method, path) => {
      if (path === `/repos/${repo}`) return { private: false }
      replay.push(path)
      return []
    }, { now: () => at + day })
    await reconcile.discover(repo, second.scan)
    assert.strictEqual(new URL(replay[0], 'https://api.github.com').searchParams.get('since'), new Date(at + day - 30 * day).toISOString())
  }

  {
    const since = encodeURIComponent(new Date(at - 30 * day).toISOString())
    const route = `/repos/${repo}/issues?state=all&sort=updated&direction=asc&since=${since}&per_page=100&page=`
    const rows = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, number: i + 1, updated_at: '2026-09-17T10:00:00Z',
      body: 'implements owner/specs#12', pull_request: {}, user: { avatar_url: 'x'.repeat(4000) }, labels: ['y'.repeat(4000)] }))
    assert.ok(Buffer.byteLength(JSON.stringify(rows)) > 200000)
    const f = fixture({ [route + '1']: rows, [route + '2']: [] })
    const result = await createFeedbackGitHub(f.gh, { now: () => at }).discover(repo)
    assert.strictEqual(result.complete, true)
    assert.strictEqual(result.items.length, 100, 'unneeded provider metadata does not exhaust the content budget')
    const oversized = fixture({ [route + '1']: [{ ...rows[0], body: 'x'.repeat(200001) }] })
    await assert.rejects(createFeedbackGitHub(oversized.gh, { now: () => at }).discover(repo), e => e.code === 'incomplete')
    const irrelevant = fixture({ [route + '1']: [{ ...rows[0], pull_request: undefined, body: 'x'.repeat(200001) }] })
    assert.deepStrictEqual((await createFeedbackGitHub(irrelevant.gh, { now: () => at }).discover(repo)).items, [])
    const reviews = fixture({
      [`/repos/${repo}/pulls/7/reviews?per_page=100&page=1`]: Array.from({ length: 100 }, (_, i) => ({ id: i + 100, body: 'Check retry ordering.', state: 'APPROVED', user: { login: 'reviewer', avatar_url: 'x'.repeat(4000) } })),
      [`/repos/${repo}/pulls/7/reviews?per_page=100&page=2`]: []
    })
    const evidence = await createFeedbackGitHub(reviews.gh).evidence(repo, 7)
    assert.strictEqual(evidence.groups.filter(g => g.id.startsWith('review:')).length, 100)
    const hugeReview = fixture({ [`/repos/${repo}/pulls/7/reviews?per_page=100&page=1`]: [{ id: 1, body: 'x'.repeat(200001), state: 'APPROVED' }] })
    await assert.rejects(createFeedbackGitHub(hugeReview.gh).evidence(repo, 7), e => e.code === 'incomplete')
  }

  {
    const source = fixture()
    const scan = { version: 1, repo, since: new Date(at - day).toISOString(), page: 3, seen: { 1: '2026-09-17T10:00:00Z' }, watermark: at - 1000 }
    source.routes[`/repos/${repo}/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(scan.since)}&per_page=100&page=3`] = Object.assign(new Error('bad gateway'), { status: 502 })
    const before = JSON.stringify(scan)
    await assert.rejects(createFeedbackGitHub(source.gh).discover(repo, scan), e => e.code === 'provider' && e.retryable)
    assert.strictEqual(JSON.stringify(scan), before, 'failed traversal retains the caller\'s cursor')
  }

  {
    const body = '# Retries\n\nR1: Bound retries.\n'
    const calls = []
    const gh = async (method, path) => {
      calls.push(path)
      if (path === '/repos/owner/specs') return { private: false, default_branch: 'stable/docs' }
      if (path === '/repos/owner/specs/commits/stable%2Fdocs') return { sha: b }
      if (path === `/repos/owner/specs/contents/specs/012-retry%20policy.md?ref=${b}`) return { type: 'file', encoding: 'base64', content: Buffer.from(body).toString('base64'), sha: c, size: Buffer.byteLength(body) }
      throw new Error('unexpected route')
    }
    const api = createFeedbackGitHub(gh)
    const baseline = await api.baseline('owner/specs', 'specs/012-retry policy.md')
    assert.deepStrictEqual(baseline, { commit: b, blob: c, body, hash: crypto.createHash('sha256').update(body).digest('hex'), path: 'specs/012-retry policy.md' })
    assert.strictEqual(calls.length, 3)
    assert.deepStrictEqual(await api.baseline('owner/specs', 'specs/012-retry policy.md', b), baseline)
    assert.strictEqual(calls.length, 4, 'pinned baselines reuse visibility and fetch only the requested content')
    assert.strictEqual(calls.filter(path => path.includes('/commits/')).length, 1)
    const pinned = await createFeedbackGitHub(gh).baseline('owner/specs', 'specs/012-retry policy.md', b)
    assert.deepStrictEqual(pinned, baseline)
    assert.strictEqual(calls.length, 6, 'a new pinned baseline still confirms repository visibility')
    assert.strictEqual(calls.filter(path => path.includes('/commits/')).length, 1)
    const invalid = createFeedbackGitHub(() => { throw new Error('unsafe input reached provider') })
    for (const target of ['../spec.md', '/spec.md', 'specs//spec.md', 'specs/%2e%2e/spec.md', 'specs\\spec.md', 'specs/spec.json']) {
      await assert.rejects(invalid.baseline('owner/specs', target), e => e.code === 'invalid')
    }
    for (const commit of ['', 'main', b + '?ref=main', 'z'.repeat(40), 12]) {
      await assert.rejects(invalid.baseline('owner/specs', 'specs/012-retry policy.md', commit), e => e.code === 'invalid')
    }
    await assert.rejects(invalid.publicRepo('owner/specs?secret=1'), e => e.code === 'invalid')
    await assert.rejects(invalid.evidence(repo, -1), e => e.code === 'invalid')
  }

  {
    const yes = fixture()
    assert.strictEqual(await createFeedbackGitHub(yes.gh).mergedRevision(repo, 7, 'src/retry.js'), true)
    assert.strictEqual(await createFeedbackGitHub(fixture().gh).mergedRevision(repo, 7, 'specs/missing.md'), false)
    const unmerged = fixture({ [`/repos/${repo}/pulls/7`]: { ...pr, merged_at: null } })
    assert.strictEqual(await createFeedbackGitHub(unmerged.gh).mergedRevision(repo, 7, 'src/retry.js'), false)
    const removed = fixture({ [`/repos/${repo}/pulls/7/files?per_page=100&page=1`]: [{ filename: 'src/retry.js', status: 'removed' }] })
    assert.strictEqual(await createFeedbackGitHub(removed.gh).mergedRevision(repo, 7, 'src/retry.js'), false)
  }

  console.log('feedback GitHub tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
