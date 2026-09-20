const assert = require('assert/strict')
const { createImplementationScanner, cursorKey, readCursor } = require('./implementation-scan')

const a = 'a'.repeat(40), b = 'b'.repeat(40), c = 'c'.repeat(40), d = 'd'.repeat(40)
const commit = (sha, message = 'ordinary change') => ({ sha, commit: { message, committer: { date: '2000-01-01T00:00:00Z' } } })
const clone = value => structuredClone(value)

function fixture ({ cursor, routes = {}, pageSize = 2, maxPages = 1 } = {}) {
  const stored = new Map([['last_commit_scan:o/r', '2026-01-01T00:00:00Z']])
  if (cursor) stored.set(cursorKey('o/r'), JSON.stringify(cursor))
  const calls = [], pages = [], processed = new Set()
  const responses = {
    '/repos/o/r': { default_branch: 'main' },
    '/repos/o/r/git/ref/heads/main': { object: { sha: d } },
    ...routes
  }
  let failCommit = false
  const gh = async (method, path) => {
    calls.push(path)
    assert.equal(method, 'GET')
    assert.ok(Object.hasOwn(responses, path), `Unexpected request ${path}`)
    if (responses[path] instanceof Error) throw responses[path]
    return clone(responses[path])
  }
  const deps = {
    gh, pageSize, maxPages, now: () => 12345,
    load: async key => stored.get(key),
    commitPage: async (repo, commits, next) => {
      if (failCommit) throw new Error('database unavailable')
      pages.push({ commits: clone(commits), next: clone(next) })
      for (const item of commits) processed.add(item.sha)
      stored.set(cursorKey(repo), JSON.stringify(next))
    }
  }
  return { stored, calls, pages, processed, responses, deps, scanner: createImplementationScanner(deps),
    fail: value => { failCommit = value }, current: () => readCursor(stored.get(cursorKey('o/r'))) }
}

async function main () {
  {
    const f = fixture({ routes: {
      [`/repos/o/r/commits?sha=${d}&per_page=2&page=1`]: [commit(d), commit(c)],
      [`/repos/o/r/commits?sha=${d}&per_page=2&page=2`]: [commit(b, 'implements o/specs#7')]
    } })
    const first = await f.scanner.scanRepository('o/r')
    assert.equal(first.pending, true)
    assert.equal(f.current().head, null)
    assert.equal(f.current().scan.page, 2)
    assert.equal(f.current().scan.target, d)
    f.responses['/repos/o/r/git/ref/heads/main'].object.sha = a
    f.fail(true)
    await assert.rejects(f.scanner.scanRepository('o/r'), /database unavailable/)
    assert.equal(f.current().scan.page, 2, 'Failed page commit retains the previous durable cursor')
    assert.deepEqual([...f.processed], [d, c])
    f.fail(false)
    const resumed = await createImplementationScanner(f.deps).scanRepository('o/r')
    assert.equal(resumed.pending, false)
    assert.equal(f.current().head, d, 'Resumed scan retains its immutable target despite a changed branch')
    assert.deepEqual([...f.processed], [d, c, b])
    assert.equal(f.stored.get('last_commit_scan:o/r'), '2026-01-01T00:00:00Z')
    assert.ok(f.calls.every(path => !path.includes('since=')))
  }
  {
    const rows = [commit(d), ...Array.from({ length: 8 }, (_, i) => commit((i + 1).toString(16).padStart(40, '0'),
      i === 7 ? 'implements o/specs#99' : 'ordinary change'))]
    const routes = {}
    for (let page = 1; page <= 5; page++) routes[`/repos/o/r/commits?sha=${d}&per_page=2&page=${page}`] = rows.slice((page - 1) * 2, page * 2)
    const f = fixture({ routes })
    for (let tick = 0; tick < 4; tick++) {
      assert.equal((await createImplementationScanner(f.deps).scanRepository('o/r')).pending, true)
      assert.equal(f.current().head, null)
    }
    assert.equal((await f.scanner.scanRepository('o/r')).pending, false)
    assert.equal(f.processed.size, 9)
    assert.equal(f.pages.at(-1).commits[0].commit.message, 'implements o/specs#99', 'A backlog beyond repeated page budgets never skips older commits')
  }
  {
    const f = fixture({ cursor: { version: 1, head: a, scan: null }, routes: {
      [`/repos/o/r/compare/${a}...${d}?per_page=2&page=1`]: {
        status: 'ahead', total_commits: 3, base_commit: { sha: a },
        commits: [commit(b, 'implements o/specs#7'), commit(c)]
      },
      [`/repos/o/r/compare/${a}...${d}?per_page=2&page=2`]: {
        status: 'ahead', total_commits: 3, base_commit: { sha: a }, commits: [commit(d, 'Merge old branch')]
      }
    } })
    await f.scanner.scanRepository('o/r')
    assert.equal(f.current().head, a)
    assert.equal(f.pages[0].commits[0].commit.message, 'implements o/specs#7', 'Old-dated newly reachable side-branch commit is included')
    await f.scanner.scanRepository('o/r')
    assert.equal(f.current().head, d)
    const before = f.pages.length
    assert.equal((await f.scanner.scanRepository('o/r')).pages, 0)
    assert.equal(f.pages.length, before)
  }
  for (const response of [Object.assign(new Error('base missing'), { status: 404 }), { status: 'diverged' }, { status: 'behind' }]) {
    const f = fixture({ cursor: { version: 1, head: a, scan: null }, routes: {
      [`/repos/o/r/compare/${a}...${d}?per_page=2&page=1`]: response,
      [`/repos/o/r/commits?sha=${d}&per_page=2&page=1`]: [commit(d, 'implements o/specs#7')]
    } })
    assert.equal((await f.scanner.scanRepository('o/r')).pending, true)
    assert.equal(f.current().head, a)
    assert.equal(f.current().scan.mode, 'full')
    await f.scanner.scanRepository('o/r')
    assert.equal(f.current().head, d)
    assert.deepEqual([...f.processed], [d])
  }
  {
    const f = fixture({ routes: { [`/repos/o/r/commits?sha=${d}&per_page=2&page=1`]: [commit(d)] } })
    f.fail(true)
    await assert.rejects(f.scanner.scanRepository('o/r'), /database unavailable/)
    assert.equal(f.stored.has(cursorKey('o/r')), false)
    assert.equal(f.processed.size, 0)
    f.fail(false)
    await f.scanner.scanRepository('o/r')
    assert.equal(f.current().head, d)
    assert.equal(f.pages.length, 1)
  }
  {
    const f = fixture({ cursor: { version: 1, head: a, scan: null }, routes: {
      [`/repos/o/r/compare/${a}...${d}?per_page=2&page=1`]: { status: 'ahead', total_commits: 4, commits: [commit(d)] }
    } })
    await assert.rejects(f.scanner.scanRepository('o/r'), /incomplete/)
    assert.equal(f.current().head, a)
    assert.equal(f.pages.length, 0)
  }
  {
    const f = fixture({ cursor: { version: 1, head: a,
      scan: { target: c, mode: 'full', page: 2, pageSize: 2, processed: 2, total: null, startedAt: 100 } }, routes: {
      [`/repos/o/r/commits?sha=${c}&per_page=2&page=2`]: Object.assign(new Error('old head disappeared'), { status: 404 }),
      [`/repos/o/r/commits?sha=${d}&per_page=2&page=1`]: [commit(d)]
    } })
    await f.scanner.scanRepository('o/r')
    assert.equal(f.current().head, a)
    assert.equal(f.current().scan.target, d)
    assert.equal(f.current().scan.page, 1)
    assert.equal(f.current().scan.startedAt, 100)
    await f.scanner.scanRepository('o/r')
    assert.equal(f.current().head, d)
  }
  {
    const f = fixture({ routes: {
      [`/repos/o/r/commits?sha=${d}&per_page=2&page=1`]: Object.assign(new Error('unchanged target missing'), { status: 404 })
    } })
    await assert.rejects(f.scanner.scanRepository('o/r'), /unchanged target missing/)
    assert.equal(f.pages.length, 0, 'Unchanged missing target is an error, not completed reconciliation')
  }
  {
    const f = fixture({ routes: { [`/repos/o/r/commits?sha=${d}&per_page=2&page=1`]: [commit(d), commit(d)] } })
    await assert.rejects(f.scanner.scanRepository('o/r'), /duplicate/)
    assert.throws(() => readCursor({ version: 2, head: null, scan: null }), /cursor/)
    assert.throws(() => readCursor({ version: 1, head: a, scan: { target: d, mode: 'compare', page: 0 } }), /pending/)
  }
  console.log('implementation scan tests passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
