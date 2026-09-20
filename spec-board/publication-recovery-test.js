const assert = require('assert/strict')
const crypto = require('crypto')
const { createPublicationRecovery } = require('./publication-recovery')

const merge = 'a'.repeat(40)
const blob = 'b'.repeat(40)
const body = '# Published A\n\nReviewed text.\n'
const hash = crypto.createHash('sha256').update(body).digest('hex')
const file = text => ({ type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), size: Buffer.byteLength(text) })

function fixture (overrides = {}, options) {
  const routes = {
    '/repos/o/r/pulls/7': { number: 7, merged_at: '2026-01-01', merge_commit_sha: merge, head: { ref: '007-spec' }, base: { repo: { full_name: 'o/r' } } },
    '/repos/o/r/pulls/7/files?per_page=100&page=1': [{ filename: 'specs/007-spec.md', status: 'added' }, { filename: 'specs/README.md', status: 'modified' }],
    [`/repos/o/r/contents/specs/007-spec.md?ref=${merge}`]: file(body),
    ...overrides
  }
  const calls = []
  const gh = async (method, path) => {
    calls.push({ method, path })
    assert.equal(method, 'GET')
    assert.ok(Object.hasOwn(routes, path), `Unexpected GitHub request ${path}`)
    if (routes[path] instanceof Error) throw routes[path]
    return structuredClone(routes[path])
  }
  return { api: createPublicationRecovery(gh, options), calls, routes }
}

async function main () {
  {
    const f = fixture()
    assert.deepEqual(await f.api.recover('o/r', 7, { specsDir: 'specs', publishedCommit: 'c'.repeat(40), publishedHash: 'unpublished-B' }), {
      number: 7, path: 'specs/007-spec.md', state: 'merged', commit: merge, revision: 0, body, hash
    })
    assert.ok(f.calls.every(call => !call.path.includes('ref=main')))
  }
  {
    const f = fixture()
    const result = await f.api.recover('o/r', 7, { path: 'specs/007-spec.md', publishedCommit: merge, publishedHash: 'submitted-newer-revision' })
    assert.equal(result.unchanged, true)
    assert.equal(result.hash, undefined)
    assert.equal(f.calls.length, 1, 'Known immutable merge does not reread or overwrite the submitted revision hash')
  }
  {
    const f = fixture({
      '/repos/o/r/pulls/7/files?per_page=100&page=1': [{ filename: 'specs/philosophy.md', status: 'added' }],
      [`/repos/o/r/contents/specs/philosophy.md?ref=${merge}`]: file(body)
    })
    f.routes['/repos/o/r/pulls/7'].head.ref = 'philosophy'
    const top = await f.api.recover('o/r', 7, { specsDir: 'specs', topLevel: true })
    assert.equal(top.path, 'specs/philosophy.md')
    f.routes['/repos/o/r/pulls/7'].head.ref = '007-spec-r2'
    f.routes[`/repos/o/r/contents/specs/007-spec/spec.md?ref=${merge}`] = file(body)
    const legacy = await f.api.recover('o/r', 7, { path: 'specs/007-spec/spec.md', revision: 2 })
    assert.equal(legacy.revision, 2)
    assert.equal(legacy.body, body)
  }
  {
    const f = fixture({
      '/repos/o/r/pulls/7/files?per_page=100&page=1': [{ filename: 'specs/007-spec/spec.md' }, { filename: 'specs/006-retired.md' }],
      [`/repos/o/r/contents/specs/007-spec/spec.md?ref=${merge}`]: file(body)
    })
    assert.equal((await f.api.recover('o/r', 7, { specsDir: 'specs' })).path, 'specs/007-spec/spec.md')
    f.routes['/repos/o/r/pulls/7'].head.ref = 'renamed'
    await assert.rejects(f.api.recover('o/r', 7, { specsDir: 'specs' }), /ambiguous/)
    await assert.rejects(f.api.recover('o/r', 7, { path: '../outside.md' }), /Invalid recorded/)
  }
  {
    const first = Array.from({ length: 100 }, (_, i) => ({ filename: `src/${i}.txt` }))
    const f = fixture({
      '/repos/o/r/pulls/7/files?per_page=100&page=1': first,
      '/repos/o/r/pulls/7/files?per_page=100&page=2': [{ filename: 'specs/007-spec.md' }]
    })
    assert.equal((await f.api.recover('o/r', 7, { specsDir: 'specs' })).hash, hash)
    await assert.rejects(fixture({ '/repos/o/r/pulls/7/files?per_page=100&page=1': first }, { maxFilePages: 1 }).api.recover('o/r', 7), /incomplete/)
  }
  {
    const f = fixture({
      [`/repos/o/r/contents/specs/007-spec.md?ref=${merge}`]: { encoding: 'none', sha: blob },
      [`/repos/o/r/git/blobs/${blob}`]: file(body)
    })
    assert.equal((await f.api.recover('o/r', 7, { path: 'specs/007-spec.md' })).body, body)
    f.routes[`/repos/o/r/git/blobs/${blob}`] = { encoding: 'base64', content: '/w==', size: 1 }
    await assert.rejects(f.api.recover('o/r', 7, { path: 'specs/007-spec.md' }), /UTF-8/)
    f.routes['/repos/o/r/pulls/7'].merge_commit_sha = 'main'
    await assert.rejects(f.api.recover('o/r', 7), /commit is unavailable/)
    f.routes['/repos/o/r/pulls/7'].merged_at = null
    assert.equal(await f.api.recover('o/r', 7), null)
  }

  process.env.GITHUB_TOKEN = 'publication-test-only'
  const { openSpecPr, recoverPublication } = require('./server')
  const originalFetch = global.fetch
  try {
    const calls = []
    const pr = { number: 7, state: 'closed', merged_at: '2026-01-01', merge_commit_sha: merge,
      head: { ref: '007-spec', repo: { full_name: 'o/r' } }, base: { repo: { full_name: 'o/r' } } }
    const revisionPr = { number: 8, state: 'open', merged_at: null, merge_commit_sha: 'c'.repeat(40) }
    global.fetch = async (url, options) => {
      const path = url.replace('https://api.github.com', '')
      calls.push({ method: options.method, path })
      assert.equal(options.method, 'GET', 'Merged PR recovery performs no external mutation')
      let value
      if (path === '/repos/o/r') value = { default_branch: 'main' }
      else if (path === '/repos/o/r/git/ref/heads/main') value = { object: { sha: 'c'.repeat(40) } }
      else if (path === '/repos/o/r/contents/specs?ref=main') value = []
      else if (path === '/repos/o/r/git/matching-refs/heads/') value = [{ ref: 'refs/heads/007-spec' }]
      else if (path.startsWith('/repos/o/r/pulls?state=all&head=')) value = [pr]
      else if (path === '/repos/o/r/pulls/7') value = pr
      else if (path === '/repos/o/r/pulls/8') value = revisionPr
      else if (path === '/repos/o/r/pulls/7/files?per_page=100&page=1') value = [{ filename: 'specs/007-spec.md' }]
      else if (path === `/repos/o/r/contents/specs/007-spec.md?ref=${merge}`) value = file(body)
      else if (path === `/repos/o/r/contents/specs/007-spec.md?ref=${'c'.repeat(40)}`) value = file('# Actual merged revision\n')
      else throw new Error('Unexpected request ' + path)
      return { ok: true, status: 200, headers: new Headers(), json: async () => structuredClone(value) }
    }
    const spec = { id: 'n', title: 'Spec', namespace: 'o/r', content: '# Unpublished B\n', roles: null }
    const initial = await openSpecPr(spec, '')
    assert.equal(initial.state, 'merged')
    assert.equal(initial.body, body)
    assert.equal(initial.hash, hash)
    pr.head.ref = '007-spec-r1'
    const revision = await openSpecPr(spec, '', {}, { n: 1, path: 'specs/007-spec.md' })
    assert.equal(revision.number, 7)
    assert.equal(revision.revision, 1)
    assert.ok(calls.length > 0)
    const previous = { namespace: 'o/r', pr_number: 7, spec_path: 'specs/007-spec.md', published_commit: merge,
      published_hash: 'submitted-newer-revision', revision: 1, revision_pr: 8 }
    calls.length = 0
    assert.equal(await recoverPublication({ ...spec, namespace: 'edited/wrong' }, previous), null)
    assert.deepEqual(calls.map(call => call.path), ['/repos/o/r/pulls/8'], 'An open revision keeps the known publication/submitted hash')
    revisionPr.merged_at = '2026-02-01'
    calls.length = 0
    const mergedRevision = await recoverPublication(spec, previous)
    assert.equal(mergedRevision.number, 8)
    assert.equal(mergedRevision.revision, 1)
    assert.equal(mergedRevision.body, '# Actual merged revision\n')
    assert.ok(!calls.some(call => call.path === '/repos/o/r/pulls/7'))
    const unchanged = await recoverPublication(spec, { ...previous, published_commit: revisionPr.merge_commit_sha })
    assert.equal(unchanged.unchanged, true)
    assert.equal(unchanged.hash, undefined)
    revisionPr.merged_at = null
    const legacy = await recoverPublication(spec, { ...previous, published_commit: null })
    assert.equal(legacy.number, 7)
    assert.equal(legacy.revision, 0)
    assert.equal(previous.revision, 1, 'Recovering the original baseline does not lower the pending revision counter')
  } finally { global.fetch = originalFetch }
  console.log('publication recovery tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
