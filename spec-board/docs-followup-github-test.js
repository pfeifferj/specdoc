const assert = require('node:assert/strict')
const test = require('node:test')
const crypto = require('crypto')
const { createDocumentationGitHub } = require('./docs-followup-github')

const blob = content => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex')
const clone = value => structuredClone(value)
const sha = character => character.repeat(40)
const config = { namespace: 'example/specs', targetRepo: 'example/docs', paths: ['guide.md'], exclude: [], bot: 'reviewer' }

function fixture () {
  const state = { mutations: [], requests: [], auth: [], branch: null, pr: null, comments: [], reviews: [], private: false,
    main: sha('b'), ancestor: true, denied: null, failAfter: null, asserted: 0, cancel: false }
  const texts = { 'src/first.rs': 'pub fn first() {}\n', 'src/second.rs': 'pub fn second() {}\n', 'guide.md': '# Guide\n' }
  const sourcePr = { number: 7, merged: true, merged_at: '2026-11-08T00:00:00Z', merge_commit_sha: sha('a'),
    head: { sha: sha('f') }, base: { ref: 'main', repo: { full_name: 'example/core' } }, user: { id: 12, login: 'contributor', type: 'User' }, changed_files: 2, body: 'A feature.' }
  const changes = ['src/first.rs', 'src/second.rs'].map(filename => ({ filename, status: 'added', sha: blob(texts[filename]),
    additions: 1, deletions: 0, patch: '+'.concat(texts[filename].trimEnd()) }))
  const trees = {
    [sha('1')]: [{ path: 'src', type: 'tree', mode: '040000', sha: sha('2') }],
    [sha('2')]: changes.map(file => ({ path: file.filename.split('/')[1], type: 'blob', mode: '100644', sha: file.sha, size: Buffer.byteLength(texts[file.filename]) })),
    [sha('3')]: [{ path: 'guide.md', type: 'blob', mode: '100644', sha: blob(texts['guide.md']), size: Buffer.byteLength(texts['guide.md']) }]
  }
  const authenticate = async (repo, permissions) => {
    state.auth.push({ repo, permissions })
    return { token: 'fixture-token', botId: 99, botLogin: 'example-app[bot]' }
  }
  const github = async (method, path, body, token) => {
    assert.equal(token, 'fixture-token')
    state.requests.push({ method, path })
    if (method !== 'GET') {
      assert.ok(state.asserted > state.mutations.length)
      if (state.denied) throw Object.assign(new Error('upstream body must stay private'), { status: state.denied, retryAt: state.retryAt })
      state.mutations.push({ method, path, body: clone(body) })
      let result
      if (path.endsWith('/git/refs')) { state.branch = body.sha; result = { object: { sha: body.sha } } }
      else if (path === '/graphql') {
        assert.equal(body.variables.input.expectedHeadOid, state.branch)
        state.branch = sha('c')
        const input = body.variables.input
        state.commit = { sha: state.branch, author: { id: 99 }, parents: [{ sha: sha('b') }],
          commit: { message: input.message.headline + '\n\n' + input.message.body, verification: { verified: true } },
          files: input.fileChanges.additions.map(file => ({ filename: file.path, status: 'modified', sha: blob(Buffer.from(file.contents, 'base64').toString()) })) }
        result = { data: { createCommitOnBranch: { commit: { oid: state.branch } } } }
      } else if (path.endsWith('/pulls')) {
        state.pr = { number: 20, state: 'open', title: body.title, body: body.body, user: { id: 99 },
          head: { ref: body.head, sha: state.branch, repo: { full_name: 'example/docs' } },
          base: { ref: body.base, repo: { full_name: 'example/docs' } }, requested_reviewers: [] }
        result = state.pr
      } else if (path.endsWith('/requested_reviewers')) {
        state.pr.requested_reviewers = [{ id: 12, login: body.reviewers[0] }]; result = state.pr
      } else if (path.endsWith('/comments')) {
        const item = { id: 80, user: { id: 99 }, body: body.body }; state.comments.push(item); result = item
      } else throw new Error('Unexpected write ' + path)
      if (state.failAfter === path) { state.failAfter = null; throw new Error('Connection lost after write') }
      return clone(result)
    }
    state.beforeRead?.(path)
    if (path === '/repos/example/core' || path === '/repos/example/docs') return { full_name: path.slice(7), private: state.private, visibility: state.private ? 'private' : 'public', default_branch: 'main' }
    if (path === '/repos/example/core/pulls/7' || path === '/repos/example/docs/pulls/7') return clone(sourcePr)
    if (path.includes('/pulls/7/files?')) return clone(changes)
    if (path === `/repos/example/core/git/commits/${sha('a')}`) return { sha: sha('a'), tree: { sha: sha('1') }, parents: [{ sha: sha('9') }] }
    if (path === `/repos/example/docs/git/commits/${sha('b')}`) return { sha: sha('b'), tree: { sha: sha('3') } }
    if (path.includes('/git/trees/')) { const id = path.split('/').at(-1); return { sha: id, truncated: false, tree: clone(trees[id]) } }
    if (path.includes('/git/blobs/')) {
      const id = path.split('/').at(-1)
      const content = Object.values(texts).find(text => blob(text) === id)
      return { sha: id, encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') }
    }
    if (path === '/repos/example/docs/git/ref/heads/main') return { object: { type: 'commit', sha: state.main } }
    if (path.startsWith(`/repos/example/docs/compare/${sha('b')}...`)) return { base_commit: { sha: sha('b') },
      merge_base_commit: { sha: state.ancestor ? sha('b') : sha('9') }, status: state.ancestor ? 'ahead' : 'diverged' }
    if (path.includes('/git/ref/heads/specdoc')) {
      if (!state.branch) throw Object.assign(new Error('missing'), { status: 404 })
      return { object: { type: 'commit', sha: state.branch } }
    }
    if (path.startsWith('/repos/example/docs/pulls?')) return state.pr ? [clone(state.pr)] : []
    if (path.startsWith('/repos/example/docs/commits/')) return clone(state.commit)
    if (path.includes('/issues/7/comments?')) return clone(state.comments)
    if (path.includes('/pulls/20/reviews?')) return clone(state.reviews)
    if (path.includes('/issues?')) return state.issuePages
      ? clone(state.issuePages[Number(new URL(path, 'https://api.github.com').searchParams.get('page')) - 1] || [])
      : [{ id: 50, number: 7, pull_request: { merged_at: sourcePr.merged_at }, body: '', updated_at: '2026-11-08T00:01:00Z' },
        { id: 51, number: 8, pull_request: { merged_at: sourcePr.merged_at }, body: '<!-- specdoc-documentation:abc -->', updated_at: '2026-11-08T00:02:00Z' }]
    throw new Error('Unexpected read ' + path)
  }
  const provider = (settings = config) => createDocumentationGitHub({ config: settings, github, authenticate, now: () => state.now || Date.parse('2026-11-08T01:00:00Z') })
  const assertActive = async () => { if (state.cancel) throw Object.assign(new Error('lease lost'), { code: 'docs-lease-lost' }); state.asserted++ }
  async function intent () {
    const api = provider()
    const source = await api.inspect('example/core', 7)
    const baseline = await api.target(config)
    return { key: 'd'.repeat(64), sourceRepo: source.repo, number: source.number, mergeSha: source.mergeSha,
      targetRepo: config.targetRepo, source, baseline, stage: 'prepared', proposal: {
        summary: 'Describe both new operations.', reason: 'Both operations are now available.',
        edits: [{ path: 'guide.md', beforeBlob: blob(texts['guide.md']),
          hunks: [{ find: texts['guide.md'], replace: '# Guide\n\nUse first and second.\n' }], content: '# Guide\n\nUse first and second.\n' }],
        evidence: [{ path: 'src/first.rs', quote: 'pub fn first() {}' }, { path: 'src/second.rs', quote: 'pub fn second() {}' }] } }
  }
  const advance = value => provider().advance(value, { assertActive })
  return { state, texts, sourcePr, changes, trees, provider, intent, advance }
}

test('multi-commit rebase uses every PR path at the final merged revision', async () => {
  const f = fixture()
  const source = await f.provider().inspect('example/core', 7)
  assert.deepEqual(source.files.map(file => file.path), ['src/first.rs', 'src/second.rs'])
  assert.equal(source.mergeSha, sha('a'))
  assert.ok(source.files.every(file => file.content.includes('pub fn')))
  assert.ok(!f.state.requests.some(request => request.path.includes(sha('9'))))
  f.changes[0].sha = sha('0')
  await assert.rejects(f.provider().inspect('example/core', 7), { code: 'docs-evidence-mismatch' })
})

test('release and stacked merges cannot update the default-branch documentation', async () => {
  for (const branch of ['release/1.x', 'feature/stack']) {
    const f = fixture()
    f.sourcePr.base.ref = branch
    await assert.rejects(f.provider().inspect('example/core', 7), { code: 'docs-source-branch' })
    assert.ok(!f.state.requests.some(request => request.path.includes('/files?') || request.path.includes('/git/')))
  }
  const f = fixture()
  const intent = await f.intent()
  f.sourcePr.base.ref = 'release/1.x'
  await assert.rejects(f.advance(intent), { code: 'docs-source-branch' })
  assert.equal(f.state.mutations.length, 0)
})

test('oversized tree entries stop before any blob download', async () => {
  for (const target of [false, true]) {
    const f = fixture()
    const entry = f.trees[sha(target ? '3' : '2')][0]
    entry.size = 100001
    await assert.rejects(target ? f.provider().target(config) : f.provider().inspect('example/core', 7), { code: 'docs-evidence-limit' })
    assert.ok(!f.state.requests.some(request => request.path.endsWith('/git/blobs/' + entry.sha)))
  }
})

test('missing patches, incomplete lists, nonregular docs and private repos defer', async () => {
  for (const change of [f => { delete f.changes[0].patch }, f => { f.sourcePr.changed_files = 3 },
    f => { f.changes[0].additions = 2 }, f => { f.state.private = true }]) {
    const f = fixture(); change(f)
    await assert.rejects(f.provider().inspect('example/core', 7))
  }
  for (const mode of ['120000', '160000', '100755']) {
    const f = fixture(); f.trees[sha('3')][0].mode = mode
    await assert.rejects(f.provider().target(config), { code: 'docs-evidence-unsupported' })
  }
})

test('old automatic PRs stop from metadata before fetching oversized evidence', async () => {
  const f = fixture()
  f.sourcePr.changed_files = 1000
  const options = { activatedAt: '2026-11-08T00:30:00Z', manual: false }
  await assert.rejects(f.provider().inspect('example/core', 7, options), { code: 'docs-before-activation' })
  assert.ok(!f.state.requests.some(request => /\/files\?|\/git\//.test(request.path)))
  await assert.rejects(f.provider().inspect('example/core', 7, { ...options, manual: true }), { code: 'docs-evidence-limit' })
})

test('discovery starts at activation and leaves marker authorship to source inspection', async () => {
  const f = fixture()
  const result = await f.provider().discover('example/core', { activatedAt: '2026-11-08T00:00:00Z' })
  assert.deepEqual(result.items, [{ number: 7 }, { number: 8 }])
  assert.ok(f.state.requests.some(request => request.path.includes('since=2026-11-08T00%3A00%3A00.000Z')))
})

test('unmerged discovery entries preserve pagination and can be discovered when later merged', async () => {
  const f = fixture()
  const activatedAt = '2026-11-08T00:00:00Z'
  const issue = (number, merged_at, updated_at = '2026-11-08T00:01:00Z') => ({ id: number, number,
    pull_request: { merged_at }, updated_at, state: number % 2 ? 'open' : 'closed' })
  f.state.issuePages = [Array.from({ length: 100 }, (_, i) => issue(i + 1, null)),
    [issue(101, '2026-11-08T00:01:00Z')]]
  const result = await f.provider().discover('example/core', { activatedAt })
  assert.deepEqual(result.items, [{ number: 101 }])
  assert.equal(result.complete, true)
  assert.ok(f.state.requests.some(request => request.path.includes('&page=2')), 'omitting unmerged work does not truncate a full page')
  f.state.now = Date.parse('2026-11-08T01:02:00Z')
  f.state.issuePages = [[issue(1, '2026-11-08T01:01:00Z', '2026-11-08T01:01:00Z')]]
  const merged = await f.provider().discover('example/core', { activatedAt, cursor: result.cursor })
  assert.deepEqual(merged.items, [{ number: 1 }], 'a later merge is collected instead of being recorded as no-change')
  f.state.issuePages = [[{ id: 200, number: 200, pull_request: {}, updated_at: '2026-11-08T01:01:00Z' }]]
  const unknown = await f.provider().discover('example/core', { activatedAt })
  assert.deepEqual(unknown.items, [{ number: 200 }], 'missing merge metadata requires authoritative source inspection')
})

test('merged bot-authored code receives a linked docs PR without requesting a bot review', async () => {
  const f = fixture()
  f.sourcePr.user = { id: 55, login: 'code-helper[bot]', type: 'Bot' }
  let intent = await f.intent()
  for (let i = 0; i < 5 && intent.stage !== 'complete'; i++) intent = { ...intent, ...await f.advance(intent) }
  assert.equal(intent.stage, 'complete')
  assert.equal(f.state.comments.length, 1)
  assert.equal(f.state.comments[0].body.split('\n')[0], 'A documentation update for this change is ready for review: https://github.com/example/docs/pull/20')
  assert.ok(!f.state.mutations.some(item => item.path.endsWith('/requested_reviewers')))
  assert.equal(f.state.pr.number, 20)
})

test('only the configured App can mark a source PR as generated documentation', async () => {
  const f = fixture()
  f.sourcePr.body = '<!-- specdoc-documentation:' + 'd'.repeat(64) + ' -->'
  assert.equal((await f.provider().inspect('example/core', 7)).number, 7, 'human-authored marker text cannot opt out')
  f.sourcePr.user = { id: 99, login: 'example-app[bot]', type: 'Bot' }
  await assert.rejects(f.provider().inspect('example/core', 7), { code: 'docs-generated-source' })
  f.sourcePr.base.repo.full_name = config.targetRepo
  await assert.rejects(f.provider().inspect(config.targetRepo, 7), { code: 'docs-generated-source' })
})

test('foreign marker comments cannot suppress the source author notification', async () => {
  const f = fixture()
  let intent = await f.intent()
  for (let i = 0; i < 3; i++) intent = { ...intent, ...await f.advance(intent) }
  f.state.comments.push({ id: 70, user: { id: 123 }, body: '<!-- specdoc-documentation:' + intent.key + ' -->' })
  intent = { ...intent, ...await f.advance(intent) }
  assert.equal(intent.stage, 'comment')
  assert.equal(f.state.comments.length, 2)
  assert.match(f.state.comments[1].body, /^@contributor /)
  intent = { ...intent, ...await f.advance(intent) }
  assert.equal(intent.stage, 'complete')
  assert.equal(f.state.comments.length, 2)
  f.state.comments[1].body += '\nHuman edit'
  assert.deepEqual(await f.advance(intent), { stage: 'stopped', reason: 'docs-comment-changed' })
})

test('signed atomic publication recovers lost acknowledgements without duplicate writes', async () => {
  const paths = ['/repos/example/docs/git/refs', '/graphql', '/repos/example/docs/pulls', '/repos/example/core/issues/7/comments']
  for (const [step, path] of paths.entries()) {
    const f = fixture()
    let intent = await f.intent()
    for (let i = 0; i < step; i++) intent = { ...intent, ...await f.advance(intent) }
    f.state.failAfter = path
    await assert.rejects(f.advance(intent), { code: 'docs-github-unavailable' })
    for (let i = 0; i < 5 && intent.stage !== 'complete'; i++) intent = { ...intent, ...await f.advance(intent) }
    assert.equal(intent.stage, 'complete')
    assert.equal(f.state.mutations.filter(item => item.path.endsWith('/git/refs')).length, 1)
    assert.equal(f.state.mutations.filter(item => item.path === '/graphql').length, 1)
    assert.equal(f.state.mutations.filter(item => item.path.endsWith('/pulls')).length, 1)
    assert.equal(f.state.comments.length, 1)
    assert.match(f.state.comments[0].body, /^@contributor /)
    assert.ok(f.state.auth.every(item => item.permissions.metadata === 'read'))
    assert.ok(!f.state.mutations.some(item => /merge|approve/.test(item.path)))
  }
})

test('human branch edits, closed or edited PRs, changed comments and lease loss stop publication', async () => {
  for (const action of [f => { f.state.commit.commit.message += '\nHuman edit' },
    f => { f.state.pr.state = 'closed' }, f => { f.state.pr.body += '\nHuman edit' }]) {
    const f = fixture(); let intent = await f.intent()
    for (let i = 0; i < 3; i++) intent = { ...intent, ...await f.advance(intent) }
    action(f)
    const before = f.state.mutations.length
    assert.equal((await f.advance(intent)).stage, 'stopped')
    assert.equal(f.state.mutations.length, before)
  }
  const f = fixture(); const intent = await f.intent(); f.state.cancel = true
  await assert.rejects(f.advance(intent), { code: 'docs-lease-lost' })
  assert.equal(f.state.mutations.length, 0)
  f.state.cancel = false; f.state.main = sha('e'); f.state.ancestor = false
  await assert.rejects(f.advance(intent), { code: 'docs-target-changed' })
  assert.equal(f.state.mutations.length, 0)
})

test('a prepared proposal survives ordinary target advances before its PR exists', async () => {
  for (const completedSteps of [0, 1, 2]) {
    const f = fixture()
    let intent = await f.intent()
    for (let i = 0; i < completedSteps; i++) intent = { ...intent, ...await f.advance(intent) }
    f.state.main = sha('e')
    await assert.rejects(f.provider().preflight({ source: intent.source, baseline: intent.baseline }), { code: 'docs-target-changed' },
      'model assessment still requires the analyzed docs to be current')
    for (let i = 0; i < 5 && intent.stage !== 'complete'; i++) intent = { ...intent, ...await f.advance(intent) }
    assert.equal(intent.stage, 'complete')
    assert.equal(f.state.pr.base.ref, 'main')
    assert.equal(f.state.commit.parents[0].sha, sha('b'), 'the proposed patch stays on its analyzed baseline')
    assert.equal(f.state.comments.length, 1)
  }
})

test('unrelated allowed paths cannot strand a prepared proposal but actual path revocation stops it', async () => {
  const f = fixture()
  let intent = await f.intent()
  const extra = { ...config, paths: [...config.paths, 'another.md'] }
  for (let i = 0; i < 5 && intent.stage !== 'complete'; i++) {
    intent = { ...intent, ...await f.provider(extra).advance(intent, { assertActive: async () => { f.state.asserted++ } }) }
  }
  assert.equal(intent.stage, 'complete')
  assert.equal(f.state.comments.length, 1)
  const before = f.state.mutations.length
  await assert.rejects(f.provider({ ...extra, exclude: ['guide.md'] }).advance(intent, { assertActive: async () => {} }), { code: 'docs-scope-changed' })
  assert.equal(f.state.mutations.length, before)
})

test('a moved target head permits notifications for the exact owned PR, including a lost PR response', async () => {
  for (const lostResponse of [false, true]) {
    const f = fixture()
    let intent = await f.intent()
    for (let i = 0; i < 2; i++) intent = { ...intent, ...await f.advance(intent) }
    if (lostResponse) {
      f.state.failAfter = '/repos/example/docs/pulls'
      await assert.rejects(f.advance(intent), { code: 'docs-github-unavailable' })
    } else intent = { ...intent, ...await f.advance(intent) }
    f.state.main = sha('e')
    assert.deepEqual(await f.provider().preflight({ source: intent.source, baseline: intent.baseline, intent }), { ok: true })
    for (let i = 0; i < 2; i++) intent = { ...intent, ...await f.advance(intent) }
    assert.equal(intent.stage, 'complete')
    assert.equal(f.state.comments.length, 1)
    assert.equal(f.state.mutations.filter(item => item.path.endsWith('/pulls')).length, 1)
    assert.equal(f.state.mutations.filter(item => item.path === '/graphql').length, 1)
  }
})

test('notifications recheck human changes to the docs PR after reading source comments', async () => {
  const f = fixture()
  let intent = await f.intent()
  for (let i = 0; i < 3; i++) intent = { ...intent, ...await f.advance(intent) }
  f.state.beforeRead = path => { if (path.includes('/issues/7/comments?')) f.state.pr.body += '\nHuman edit' }
  const before = f.state.mutations.length
  await assert.rejects(f.advance(intent), { code: 'docs-proposal-changed' })
  assert.equal(f.state.mutations.length, before)
})

test('rate limits retain a bounded retry time without copying the upstream response', async () => {
  for (const retryAt of [Date.parse('2026-11-08T02:00:00Z'), Date.parse('2026-11-12T00:00:00Z'), Infinity]) {
    const f = fixture(), intent = await f.intent()
    f.state.denied = 429
    f.state.retryAt = retryAt
    await assert.rejects(f.advance(intent), error => {
      assert.equal(error.code, 'docs-github-unavailable')
      assert.equal(error.status, 429)
      assert.ok(!error.message.includes('upstream body'))
      assert.equal(error.retryAt, Number.isSafeInteger(retryAt) ? Math.min(retryAt, Date.parse('2026-11-09T01:00:00Z')) : undefined)
      return true
    })
    assert.equal(f.state.mutations.length, 0)
  }
})
