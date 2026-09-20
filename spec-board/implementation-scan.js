const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
const invalid = message => Object.assign(new Error(message), { code: 'implementation-scan' })
const cursorKey = repo => `implementation_scan:v1:${repo}`

function readCursor (value) {
  if (value == null) return { version: 1, head: null, scan: null }
  const cursor = typeof value === 'string' ? JSON.parse(value) : value
  if (!cursor || cursor.version !== 1 || (cursor.head !== null && !sha(cursor.head))) throw invalid('Invalid implementation scan cursor')
  const scan = cursor.scan
  if (scan && (!sha(scan.target) || !['full', 'compare'].includes(scan.mode) ||
    !Number.isSafeInteger(scan.page) || scan.page < 1 || !Number.isSafeInteger(scan.processed) || scan.processed < 0 ||
    !Number.isSafeInteger(scan.pageSize) || scan.pageSize < 1 || scan.pageSize > 100 ||
    !Number.isFinite(scan.startedAt) || (scan.mode === 'compare' && !sha(cursor.head)) ||
    (scan.total !== null && (!Number.isSafeInteger(scan.total) || scan.total < 0)))) throw invalid('Invalid pending implementation scan')
  return { ...cursor, scan: scan ? { ...scan } : null }
}

function commitsOf (rows, pageSize) {
  if (!Array.isArray(rows) || rows.length > pageSize) throw invalid('Invalid implementation commit page')
  const seen = new Set()
  return rows.map(row => {
    if (!sha(row?.sha) || typeof row.commit?.message !== 'string' || seen.has(row.sha)) throw invalid('Invalid or duplicate implementation commit')
    seen.add(row.sha)
    return { sha: row.sha, commit: { message: row.commit.message } }
  })
}

function createImplementationScanner ({ gh, load, commitPage, now = Date.now, maxPages = 2, pageSize = 100 }) {
  if (!Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw invalid('Invalid implementation scan budget')

  async function branchHead (root) {
    const info = await gh('GET', root)
    if (!info || typeof info.default_branch !== 'string' || !info.default_branch) throw invalid('Implementation default branch is unavailable')
    const ref = await gh('GET', `${root}/git/ref/heads/${encodeURIComponent(info.default_branch)}`)
    const target = ref?.object?.sha
    if (!sha(target)) throw invalid('Implementation branch head is unavailable')
    return target
  }

  async function scanRepository (repo) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw invalid('Invalid implementation repository')
    const root = `/repos/${repo}`
    let cursor = readCursor(await load(cursorKey(repo)))
    if (!cursor.scan) {
      const target = await branchHead(root)
      if (target === cursor.head) return { repo, head: cursor.head, pending: false, pages: 0, commits: 0 }
      cursor.scan = { target, mode: cursor.head ? 'compare' : 'full', page: 1, pageSize, processed: 0, total: null, startedAt: now() }
    }
    let pages = 0, count = 0
    while (cursor.scan && pages < maxPages) {
      const current = cursor.scan
      let commits, complete, total = current.total
      if (current.mode === 'compare') {
        let comparison
        try {
          comparison = await gh('GET', `${root}/compare/${cursor.head}...${current.target}?per_page=${current.pageSize}&page=${current.page}`)
        } catch (error) {
          if (error.status !== 404) throw error
        }
        pages++
        if (!comparison || ['behind', 'diverged'].includes(comparison.status)) {
          cursor = { ...cursor, scan: { ...current, mode: 'full', page: 1, processed: 0, total: null } }
          await commitPage(repo, [], cursor)
          continue
        }
        if (!['ahead', 'identical'].includes(comparison.status) || !Number.isSafeInteger(comparison.total_commits) || comparison.total_commits < 0 ||
          (comparison.base_commit?.sha && comparison.base_commit.sha !== cursor.head)) throw invalid('Invalid implementation comparison')
        total = comparison.total_commits
        if (current.total !== null && total !== current.total) throw invalid('Implementation comparison changed during pagination')
        commits = commitsOf(comparison.commits, current.pageSize)
        const offset = (current.page - 1) * current.pageSize
        if (offset > total || commits.length !== Math.min(current.pageSize, total - offset)) throw invalid('Implementation comparison is incomplete')
        complete = offset + commits.length === total
      } else {
        pages++
        let rows
        try {
          rows = await gh('GET', `${root}/commits?sha=${current.target}&per_page=${current.pageSize}&page=${current.page}`)
        } catch (error) {
          if (error.status !== 404) throw error
          const target = await branchHead(root)
          if (target === current.target) throw error
          cursor = { ...cursor, scan: { ...current, target, page: 1, processed: 0, total: null } }
          await commitPage(repo, [], cursor)
          continue
        }
        commits = commitsOf(rows, current.pageSize)
        if (current.page === 1 && !commits.length) throw invalid('Implementation history is unavailable')
        complete = commits.length < current.pageSize
      }
      const next = complete ? { version: 1, head: current.target, scan: null }
        : { ...cursor, scan: { ...current, page: current.page + 1, processed: current.processed + commits.length, total } }
      await commitPage(repo, commits, next)
      cursor = next
      count += commits.length
    }
    return { repo, head: cursor.head, pending: !!cursor.scan, target: cursor.scan?.target || cursor.head,
      startedAt: cursor.scan?.startedAt || null, pages, commits: count }
  }

  return { scanRepository }
}

module.exports = { createImplementationScanner, cursorKey, readCursor }
