const crypto = require('crypto')
const { implementsRefs } = require('./refs')

const DAY = 86400000
const WINDOW = 30 * DAY
const SLOP = 5 * 60000
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)

function failure (code, message, retryable = false) {
  return Object.assign(new Error(message), { code, retryable })
}

function repository (repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repo) || repo.length > 200) {
    throw failure('invalid', 'Invalid GitHub repository')
  }
  return repo
}

function numberOf (number) {
  if (!Number.isSafeInteger(number) || number < 1) throw failure('invalid', 'Invalid pull request number')
  return number
}

function filePath (path) {
  if (typeof path !== 'string' || !path || path.length > 1000 || /[\\%\x00-\x1f\x7f]/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw failure('invalid', 'Invalid repository file path')
  }
  return path
}

const encodedPath = path => filePath(path).split('/').map(encodeURIComponent).join('/')
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value))

function createFeedbackGitHub (gh, options = {}) {
  const maxCalls = options.maxCalls ?? 24
  const maxPages = options.maxPages ?? 5
  const maxBytes = options.maxBytes ?? 200000
  const now = options.now || Date.now
  if (typeof gh !== 'function' || !Number.isInteger(maxCalls) || maxCalls < 0 || !Number.isInteger(maxPages) || maxPages < 1 || !Number.isInteger(maxBytes) || maxBytes < 1) {
    throw failure('invalid', 'Invalid feedback provider configuration')
  }
  let calls = 0
  const repos = new Map()

  async function get (path) {
    if (calls >= maxCalls) throw failure('budget', 'Feedback GitHub call budget exhausted', true)
    calls++
    try {
      return await gh('GET', path)
    } catch (error) {
      const status = Number(error.status) || null
      const inaccessible = [401, 403, 404, 410].includes(status)
      const out = failure(inaccessible ? 'inaccessible' : 'provider', `GitHub feedback request failed${status ? ` (${status})` : ''}`, !inaccessible || status === 403)
      if (status) out.status = status
      throw out
    }
  }

  function bounded (value, label) {
    if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) throw failure('incomplete', `${label} exceeds the feedback evidence byte limit`)
    return value
  }

  function textLimit (value, label) {
    if (typeof value === 'string' && (value.length > maxBytes || Buffer.byteLength(value, 'utf8') > maxBytes)) {
      throw failure('incomplete', `${label} exceeds the feedback evidence byte limit`)
    }
    return value
  }

  function selectFields (item, fields) {
    if (!item || typeof item !== 'object') throw failure('incomplete', 'Invalid GitHub feedback item', true)
    const out = {}
    for (const field of fields) {
      const value = item[field]
      if (value == null) continue
      if (!['string', 'number', 'boolean'].includes(typeof value)) throw failure('incomplete', 'Invalid GitHub feedback field', true)
      out[field] = textLimit(value, 'GitHub feedback text')
    }
    return out
  }

  function commentFields (item, fields) {
    const out = selectFields(item, ['id', 'body', 'created_at', 'updated_at', ...fields])
    if (typeof item.user?.login === 'string') out.user = { login: textLimit(item.user.login, 'GitHub feedback author') }
    return out
  }

  async function repoInfo (repo, refresh = false) {
    repository(repo)
    if (refresh) repos.delete(repo)
    if (!repos.has(repo)) {
      const info = await get(`/repos/${repo}`)
      if (!info || typeof info.private !== 'boolean' || (info.full_name && info.full_name.toLowerCase() !== repo.toLowerCase())) {
        throw failure('incomplete', 'GitHub repository visibility could not be confirmed', true)
      }
      repos.set(repo, info)
    }
    return repos.get(repo)
  }

  async function publicRepo (repo, refresh = false) {
    const info = await repoInfo(repo, refresh)
    return info.private === false && (!info.visibility || info.visibility === 'public')
  }

  async function requirePublic (repo) {
    if (!await publicRepo(repo)) throw failure('inaccessible', 'Feedback requires a public source repository')
  }

  async function preflight (repo) {
    await requirePublic(repo)
    for (const kind of ['issues', 'pulls']) {
      const items = await get(`/repos/${repo}/${kind}?state=all&per_page=1`)
      if (!Array.isArray(items) || items.length > 1) throw failure('incomplete', `GitHub ${kind} read access could not be confirmed`, true)
    }
    return { ok: true }
  }

  async function paged (path, label, select) {
    const items = []
    for (let page = 1; page <= maxPages; page++) {
      const batch = await get(`${path}?per_page=100&page=${page}`)
      if (!Array.isArray(batch) || batch.length > 100) throw failure('incomplete', `Invalid GitHub ${label} page`, true)
      items.push(...batch.map(select))
      bounded(items, label)
      if (batch.length < 100) return items
    }
    throw failure('incomplete', `${label} exceeds the feedback pagination limit`)
  }

  function uniqueEntries (items, label) {
    const entries = new Map()
    for (const item of items) {
      numberOf(item?.id)
      const previous = entries.get(item.id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(item)) throw failure('incomplete', `${label} changed during pagination`, true)
      entries.set(item.id, item)
    }
    return [...entries.values()]
  }

  async function discover (repo, previous = null) {
    repository(repo)
    const time = now()
    const fresh = () => ({ version: 1, repo, since: new Date(time - WINDOW).toISOString(), page: 1, startedAt: time, watermark: 0, reconcileAt: time + DAY, seen: {} })
    let scan = previous ? JSON.parse(JSON.stringify(previous)) : fresh()
    if (scan.version !== 1 || scan.repo !== repo || !date(scan.since) || !Number.isInteger(scan.page) || scan.page < 1 || scan.page > 10001 || !scan.seen || typeof scan.seen !== 'object' || Array.isArray(scan.seen)) {
      throw failure('invalid', 'Invalid feedback discovery cursor')
    }
    if (scan.complete) {
      if (Number(scan.nextAt) > time) return { items: [], scan, complete: true }
      const reconcile = !Number(scan.reconcileAt) || time >= Number(scan.reconcileAt)
      scan = {
        ...fresh(),
        since: new Date(reconcile ? time - WINDOW : Math.max(time - WINDOW, Number(scan.watermark || 0) - SLOP)).toISOString(),
        watermark: Number(scan.watermark || 0),
        reconcileAt: reconcile ? time + DAY : scan.reconcileAt
      }
    }
    await requirePublic(repo)
    const found = new Map()
    for (let n = 0; n < 2 && calls < maxCalls; n++) {
      const path = `/repos/${repo}/issues?state=all&sort=updated&direction=asc&since=${encodeURIComponent(scan.since)}&per_page=100&page=${scan.page}`
      const batch = await get(path)
      if (!Array.isArray(batch) || batch.length > 100) throw failure('incomplete', 'Invalid GitHub discovery page', true)
      const candidates = batch.map(item => {
        const selected = selectFields(item, ['id', 'number', 'updated_at'])
        selected.pull_request = !!item.pull_request
        if (selected.pull_request) {
          selected.body = typeof item.body === 'string' ? textLimit(item.body, 'Pull request description') : ''
        }
        return selected
      })
      bounded(candidates, 'Discovery page')
      for (const item of candidates) {
        if (!item || !Number.isSafeInteger(item.id) || item.id < 1 || !date(item.updated_at)) throw failure('incomplete', 'Invalid GitHub discovery item', true)
        const at = Date.parse(item.updated_at)
        scan.watermark = Math.max(Number(scan.watermark || 0), at)
        if (!item.pull_request) continue
        numberOf(item.number)
        const key = String(item.id)
        if (scan.seen[key] === item.updated_at) continue
        scan.seen[key] = item.updated_at
        found.set(item.number, { repo, number: item.number, body: typeof item.body === 'string' ? item.body : '', updatedAt: item.updated_at })
      }
      if (Object.keys(scan.seen).length > 10000) throw failure('incomplete', 'Feedback discovery sweep exceeds 10000 pull requests')
      scan.page++
      if (batch.length < 100) {
        scan.complete = true
        scan.nextAt = time + 60000
        scan.seen = {}
        return { items: [...found.values()], scan, complete: true }
      }
      if (scan.page > 10000) throw failure('incomplete', 'Feedback discovery sweep exceeds its page limit')
    }
    // The caller queues these rows and saves this cursor in one transaction.
    scan.complete = false
    return { items: [...found.values()], scan, complete: false }
  }

  function entry (item, kind, repo, number) {
    numberOf(item.id)
    if (typeof item.body !== 'string') throw failure('incomplete', 'GitHub review text is unavailable', true)
    const anchor = kind === 'review' ? `pullrequestreview-${item.id}` : kind === 'inline' ? `discussion_r${item.id}` : `issuecomment-${item.id}`
    return {
      id: `${kind}:${item.id}`,
      body: item.body,
      url: `https://github.com/${repo}/pull/${number}#${anchor}`,
      author: typeof item.user?.login === 'string' ? item.user.login : 'unknown',
      createdAt: item.created_at || item.submitted_at || null,
      updatedAt: item.updated_at || item.submitted_at || item.created_at || null,
      ...(kind === 'review' ? { state: item.state, commitId: item.commit_id || null } : {}),
      ...(kind === 'inline' ? {
        path: filePath(item.path),
        diffHunk: typeof item.diff_hunk === 'string' ? item.diff_hunk : '',
        commitId: item.commit_id || null,
        originalCommitId: item.original_commit_id || null,
        line: item.line ?? null,
        originalLine: item.original_line ?? null,
        side: item.side || null,
        reviewId: item.pull_request_review_id ?? null,
        replyTo: item.in_reply_to_id ? `inline:${item.in_reply_to_id}` : null
      } : {})
    }
  }

  async function evidence (repo, number) {
    repository(repo)
    numberOf(number)
    await requirePublic(repo)
    const path = `/repos/${repo}/pulls/${number}`
    const pr = bounded(await get(path), 'Pull request')
    if (pr?.merged_at === null && ['open', 'closed'].includes(pr.state) && sha(pr.head?.sha)) throw failure('unmerged', 'Feedback requires a merged pull request')
    if (!pr || !date(pr.merged_at) || !sha(pr.merge_commit_sha) || !sha(pr.head?.sha)) throw failure('ineligible', 'Feedback requires a merged pull request')
    if (pr.base?.repo?.full_name && pr.base.repo.full_name.toLowerCase() !== repo.toLowerCase()) throw failure('ineligible', 'Pull request belongs to a different repository')
    const body = typeof pr.body === 'string' ? pr.body : ''
    const links = [...new Map(implementsRefs(body, repo).map(ref => [`${ref.ns}#${ref.n}`, ref])).values()]
    if (!links.length) throw failure('ineligible', 'Pull request description has no implements reference')
    for (const link of links) { repository(link.ns); numberOf(link.n) }
    if (/^(?:[\w.-]+\/)?[\w.-]+$/.test(pr.head.ref || '') && /(?:^|\n)Spec note: https?:\/\/\S+\s*$/.test(body)) {
      throw failure('ineligible', 'Generated spec pull requests are excluded from feedback')
    }
    const reviews = uniqueEntries(await paged(`${path}/reviews`, 'Review summaries', item => commentFields(item, ['state', 'submitted_at', 'commit_id'])), 'Review summaries')
    const inline = uniqueEntries(await paged(`${path}/comments`, 'Inline review comments', item => commentFields(item,
      ['path', 'diff_hunk', 'commit_id', 'original_commit_id', 'line', 'original_line', 'side', 'pull_request_review_id', 'in_reply_to_id'])), 'Inline review comments')
    const discussion = uniqueEntries(await paged(`/repos/${repo}/issues/${number}/comments`, 'Pull request discussion', item => commentFields(item, [])), 'Pull request discussion')
    const changed = await paged(`${path}/files`, 'Changed files', item => selectFields(item, ['filename', 'patch', 'previous_filename', 'status', 'additions', 'deletions']))
    const groups = new Map()
    for (const review of reviews) {
      if (review.state === 'PENDING' || review.body == null || review.body === '') continue
      if (typeof review.body !== 'string') throw failure('incomplete', 'GitHub review text is unavailable', true)
      if (!review.body.trim()) continue
      const e = entry(review, 'review', repo, number)
      groups.set(e.id, { id: e.id, entries: [e] })
    }
    const comments = new Map(inline.map(item => [numberOf(item.id), item]))
    for (const item of inline) {
      let root = item
      const seen = new Set([item.id])
      while (root.in_reply_to_id) {
        if (seen.has(root.in_reply_to_id) || !comments.has(root.in_reply_to_id)) throw failure('incomplete', 'Inline review thread is missing its parent or contains a cycle')
        seen.add(root.in_reply_to_id)
        root = comments.get(root.in_reply_to_id)
      }
      const id = `inline:${root.id}`
      if (!groups.has(id)) groups.set(id, { id, entries: [] })
      groups.get(id).entries.push(entry(item, 'inline', repo, number))
    }
    for (const item of discussion) {
      if (typeof item.body !== 'string') throw failure('incomplete', 'GitHub discussion text is unavailable', true)
      if (!item.body.trim()) continue
      const e = entry(item, 'discussion', repo, number)
      groups.set(e.id, { id: e.id, entries: [e] })
    }
    const files = changed.map(file => {
      const path = filePath(file.filename)
      if (typeof file.patch !== 'string') throw failure('incomplete', 'A final changed-file patch is unavailable')
      let additions = 0
      let deletions = 0
      let inHunk = false
      for (const line of file.patch.split('\n')) {
        if (/^@@ /.test(line)) inHunk = true
        else if (inHunk && line.startsWith('+')) additions++
        else if (inHunk && line.startsWith('-')) deletions++
      }
      if ((Number.isInteger(file.additions) && file.additions !== additions) || (Number.isInteger(file.deletions) && file.deletions !== deletions)) {
        throw failure('incomplete', 'A final changed-file patch is truncated')
      }
      return { path, patch: file.patch, ...(file.previous_filename ? { previousPath: filePath(file.previous_filename) } : {}) }
    }).sort((a, b) => a.path.localeCompare(b.path))
    for (const group of groups.values()) group.entries.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')) || a.id.localeCompare(b.id))
    const result = bounded({ repo, number, headSha: pr.head.sha, mergeSha: pr.merge_commit_sha, mergedAt: pr.merged_at, body, links, groups: [...groups.values()].sort((a, b) => a.id.localeCompare(b.id)), files }, 'Review evidence')
    const after = await get(path)
    if (after?.head?.sha !== pr.head.sha || after?.merge_commit_sha !== pr.merge_commit_sha || (after?.body || '') !== body || after?.updated_at !== pr.updated_at) {
      throw failure('incomplete', 'Pull request changed while collecting review evidence', true)
    }
    return { ...result, hash: hash(JSON.stringify(result)) }
  }

  async function baseline (namespace, path, commit = null) {
    repository(namespace)
    filePath(path)
    if (!/\.md$/i.test(path)) throw failure('invalid', 'Feedback target must be a Markdown file')
    if (commit !== null && !sha(commit)) throw failure('invalid', 'Feedback spec commit must be a SHA')
    await requirePublic(namespace)
    if (commit === null) {
      const info = await repoInfo(namespace)
      if (typeof info.default_branch !== 'string' || !info.default_branch) throw failure('incomplete', 'Spec repository has no default branch')
      const head = await get(`/repos/${namespace}/commits/${encodeURIComponent(info.default_branch)}`)
      if (!sha(head?.sha)) throw failure('incomplete', 'Spec repository default-branch commit is unavailable', true)
      commit = head.sha
    }
    const file = await get(`/repos/${namespace}/contents/${encodedPath(path)}?ref=${commit}`)
    if (!file || file.type !== 'file' || file.encoding !== 'base64' || typeof file.content !== 'string' || !sha(file.sha)) {
      throw failure('incomplete', 'Canonical spec content is unavailable', true)
    }
    if (file.size > maxBytes || file.content.length > maxBytes * 2) throw failure('incomplete', 'Canonical spec exceeds the feedback byte limit')
    const encoded = file.content.replace(/\s/g, '')
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw failure('incomplete', 'Invalid canonical spec encoding')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.length > maxBytes || (Number.isInteger(file.size) && file.size !== bytes.length)) throw failure('incomplete', 'Canonical spec content is incomplete')
    let body
    try { body = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) } catch { throw failure('incomplete', 'Canonical spec is not UTF-8 Markdown') }
    if (body.includes('\0')) throw failure('incomplete', 'Canonical spec is not plain Markdown')
    return { commit, blob: file.sha, body, hash: hash(body), path }
  }

  async function mergedRevision (namespace, number, path) {
    repository(namespace)
    numberOf(number)
    filePath(path)
    await requirePublic(namespace)
    const route = `/repos/${namespace}/pulls/${number}`
    const pr = await get(route)
    if (!date(pr?.merged_at) || !sha(pr.merge_commit_sha) || pr.base?.repo?.full_name?.toLowerCase() !== namespace.toLowerCase()) return false
    const files = await paged(`${route}/files`, 'Revision changed files', item => selectFields(item, ['filename', 'status']))
    return files.some(file => file.filename === path && file.status !== 'removed')
  }

  return { discover, evidence, baseline, publicRepo, preflight, mergedRevision, get calls () { return calls }, get remaining () { return maxCalls - calls } }
}

module.exports = { createFeedbackGitHub }
