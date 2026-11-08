const crypto = require('crypto')
const { createFeedbackGitHub } = require('./feedback-github')
const { markdownPath } = require('./docs-followup-config')
const { validateProposal } = require('./docs-followup')

const fail = code => Object.assign(new Error('Documentation GitHub operation could not continue.'), { code })
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')
const blobHash = content => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex')
const pathOf = value => typeof value === 'string' && value.length <= 500 && !/[\\%\x00-\x1f\x7f]/.test(value) &&
  value.split('/').every(part => part && part !== '.' && part !== '..')
const repoOf = value => typeof value === 'string' && value.length <= 200 && /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/.test(value)
const marker = key => `<!-- specdoc-documentation:${key} -->`
const read = { metadata: 'read', contents: 'read', pull_requests: 'read' }
const write = { metadata: 'read', contents: 'write', pull_requests: 'write' }
const comment = { metadata: 'read', pull_requests: 'write' }

function createDocumentationGitHub ({ config, github, authenticate, signal, progress = () => {}, now = Date.now }) {
  if (!config || !repoOf(config.targetRepo) || typeof github !== 'function' || typeof authenticate !== 'function') throw fail('docs-config-invalid')
  let calls = 0
  let received = 0
  async function request (repo, method, path, body, permissions = read) {
    signal?.throwIfAborted()
    if (!repoOf(repo) || ++calls > 100) throw fail('incomplete')
    const auth = await authenticate(repo, permissions)
    if (!auth?.token || !Number.isSafeInteger(auth.botId) || auth.botId < 1 || !/^[a-z0-9-]+\[bot\]$/i.test(auth.botLogin || '')) throw fail('docs-app-unavailable')
    let result
    try { result = await github(method, path, body, auth.token, { signal }) } catch (error) {
      const safe = fail('docs-github-unavailable')
      safe.status = Number(error.status) || 0
      if ([403, 429].includes(safe.status) && Number.isSafeInteger(error.retryAt) && error.retryAt > now()) {
        safe.retryAt = Math.min(error.retryAt, now() + 86400000)
      }
      throw safe
    }
    signal?.throwIfAborted()
    received += Buffer.byteLength(JSON.stringify(result) || '')
    if (received > 4000000) throw fail('incomplete')
    progress()
    return result
  }
  const get = (repo, path) => request(repo, 'GET', `/repos/${repo}${path}`)
  async function optional (repo, path) {
    try { return await get(repo, path) } catch (error) { if (error.status === 404) return null; throw error }
  }
  async function publicRepo (repo) {
    const info = await get(repo, '')
    if (info?.private !== false || info.visibility !== 'public' || info.full_name?.toLowerCase() !== repo || info.archived || info.disabled) throw fail('docs-public-repository-required')
    return info
  }
  async function pages (repo, path, maximum = 300) {
    const all = []
    for (let page = 1; page <= Math.ceil(maximum / 100); page++) {
      const batch = await get(repo, `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      if (!Array.isArray(batch) || batch.length > 100) throw fail('incomplete')
      all.push(...batch)
      if (all.length > maximum) throw fail('incomplete')
      if (batch.length < 100) return all
    }
    throw fail('incomplete')
  }
  async function treeReader (repo, commit) {
    if (!sha(commit)) throw fail('incomplete')
    const root = await get(repo, `/git/commits/${commit}`)
    if (root?.sha !== commit || !sha(root.tree?.sha)) throw fail('incomplete')
    const trees = new Map()
    return async path => {
      if (!pathOf(path)) throw fail('incomplete')
      let tree = root.tree.sha
      const parts = path.split('/')
      for (let i = 0; i < parts.length; i++) {
        if (!trees.has(tree)) {
          const value = await get(repo, `/git/trees/${tree}`)
          if (value?.sha !== tree || value.truncated !== false || !Array.isArray(value.tree) ||
              new Set(value.tree.map(entry => entry.path)).size !== value.tree.length) throw fail('incomplete')
          trees.set(tree, value.tree)
        }
        const entry = trees.get(tree).find(entry => entry.path === parts[i])
        if (!entry) return null
        if (!sha(entry.sha)) throw fail('incomplete')
        if (i === parts.length - 1) return entry
        if (entry.type !== 'tree' || entry.mode !== '040000') throw fail('incomplete')
        tree = entry.sha
      }
    }
  }
  async function content (repo, entry) {
    if (entry?.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw fail('docs-evidence-unsupported')
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw fail('incomplete')
    if (entry.size > 100000) throw fail('docs-evidence-limit')
    const value = await get(repo, `/git/blobs/${entry.sha}`)
    if (value?.size > 100000) throw fail('docs-evidence-limit')
    if (value?.sha !== entry.sha || value.encoding !== 'base64' || typeof value.content !== 'string' ||
        !/^[A-Za-z0-9+/=\r\n]*$/.test(value.content)) throw fail('incomplete')
    const buffer = Buffer.from(value.content, 'base64')
    const text = buffer.toString('utf8')
    if (buffer.length !== value.size || value.size !== entry.size || blobHash(buffer) !== entry.sha) throw fail('incomplete')
    if (!Buffer.from(text).equals(buffer) || text.includes('\0')) throw fail('docs-evidence-unsupported')
    return text
  }
  function mergedIdentity (pr, repo, number) {
    const author = pr?.user
    const validLogin = author?.type === 'Bot' ? /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\[bot\])?$/ : /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/
    if (pr?.number !== number || pr.merged !== true || !sha(pr.merge_commit_sha) || !sha(pr.head?.sha) ||
        !Number.isFinite(Date.parse(pr.merged_at)) || pr.base?.repo?.full_name?.toLowerCase() !== repo ||
        typeof pr.base.ref !== 'string' || !pr.base.ref ||
        !Number.isSafeInteger(author?.id) || author.id < 1 || !['User', 'Bot'].includes(author.type) || !validLogin.test(author.login || '')) throw fail('incomplete')
    return [pr.number, pr.merge_commit_sha, pr.head.sha, pr.base.ref, pr.merged_at, author.id, author.login, author.type]
  }
  async function rejectGeneratedSource (repo, pr) {
    if (pr?.user?.type !== 'Bot' || !/<!-- specdoc-documentation:[a-f0-9]{64} -->/.test(pr.body || '')) return
    const auth = await authenticate(repo, read)
    if (pr.user.id === auth.botId) throw fail('docs-generated-source')
  }
  async function inspect (repo, number, { activatedAt, manual = false } = {}) {
    if (!repoOf(repo) || !Number.isSafeInteger(number) || number < 1) throw fail('incomplete')
    const info = await publicRepo(repo)
    const route = `/pulls/${number}`
    const pr = await get(repo, route)
    await rejectGeneratedSource(repo, pr)
    const identity = mergedIdentity(pr, repo, number)
    if (pr.base.ref !== info.default_branch) throw fail('docs-source-branch')
    if (!manual && activatedAt !== undefined) {
      if (!Number.isFinite(Date.parse(activatedAt))) throw fail('incomplete')
      if (Date.parse(pr.merged_at) < Date.parse(activatedAt)) throw fail('docs-before-activation')
    }
    if (!Number.isInteger(pr.changed_files) || pr.changed_files < 1) throw fail('incomplete')
    if (pr.changed_files > 32) throw fail('docs-evidence-limit')
    const changes = await pages(repo, `${route}/files`, 100)
    if (changes.length !== pr.changed_files || new Set(changes.map(file => file.filename)).size !== changes.length) throw fail('incomplete')
    const lookup = await treeReader(repo, pr.merge_commit_sha)
    const files = []
    for (const change of changes) {
      if (!pathOf(change.filename) || !['added', 'modified', 'removed', 'renamed'].includes(change.status) ||
          !Number.isInteger(change.additions) || !Number.isInteger(change.deletions)) throw fail('incomplete')
      if (typeof change.patch !== 'string') throw fail('docs-evidence-unsupported')
      const lines = change.patch.split('\n')
      if (lines.filter(line => line.startsWith('+')).length !== change.additions || lines.filter(line => line.startsWith('-')).length !== change.deletions) throw fail('docs-evidence-unsupported')
      const entry = await lookup(change.filename)
      if (change.status === 'removed') {
        if (entry) throw fail('incomplete')
        files.push({ path: change.filename, status: change.status, content: null, blob: null, patch: change.patch })
      } else {
        // PR patches describe the pre-merge diff; require their final blobs to match the merged tree.
        if (!entry || entry.sha !== change.sha) throw fail('docs-evidence-mismatch')
        if (change.status === 'renamed' && (!pathOf(change.previous_filename) || await lookup(change.previous_filename))) throw fail('incomplete')
        files.push({ path: change.filename, status: change.status, content: await content(repo, entry), blob: entry.sha,
          mode: entry.mode, patch: change.patch, ...(change.status === 'renamed' ? { previousPath: change.previous_filename } : {}) })
      }
    }
    const again = await get(repo, route)
    if (JSON.stringify(mergedIdentity(again, repo, number)) !== JSON.stringify(identity) || again.changed_files !== pr.changed_files) throw fail('incomplete')
    const result = { repo, number, mergeSha: pr.merge_commit_sha, headSha: pr.head.sha, baseBranch: pr.base.ref, mergedAt: pr.merged_at,
      author: { id: pr.user.id, login: pr.user.login, type: pr.user.type }, url: `https://github.com/${repo}/pull/${number}`, files, complete: true }
    if (Buffer.byteLength(JSON.stringify(result)) > 200000) throw fail('docs-evidence-limit')
    return { ...result, hash: hash(result) }
  }
  async function target () {
    const repo = config.targetRepo
    const info = await publicRepo(repo)
    if (typeof info.default_branch !== 'string' || !info.default_branch) throw fail('incomplete')
    const ref = await get(repo, `/git/ref/heads/${encodeURIComponent(info.default_branch)}`)
    if (ref?.object?.type !== 'commit' || !sha(ref.object.sha)) throw fail('incomplete')
    const lookup = await treeReader(repo, ref.object.sha)
    const files = []
    for (const path of config.paths.filter(path => !config.exclude.includes(path))) {
      if (!markdownPath(path)) throw fail('incomplete')
      const entry = await lookup(path)
      if (!entry) throw fail('incomplete')
      if (entry.mode !== '100644') throw fail('docs-evidence-unsupported')
      files.push({ path, blob: entry.sha, mode: entry.mode, content: await content(repo, entry) })
    }
    const result = { repo, commit: ref.object.sha, branch: info.default_branch, files, complete: true }
    if (!files.length) throw fail('incomplete')
    if (Buffer.byteLength(JSON.stringify(result)) > 100000) throw fail('docs-evidence-limit')
    return { ...result, hash: hash(result) }
  }
  async function discover (repo, { cursor, activatedAt }) {
    const activation = Date.parse(activatedAt)
    if (!Number.isFinite(activation)) throw fail('incomplete')
    let previous = cursor
    if (!previous || (previous.complete && Number(previous.nextAt) <= now())) {
      previous = { version: 1, repo, since: new Date(Math.max(activation, Number(previous?.watermark || activation) - 300000)).toISOString(),
        page: 1, startedAt: now(), watermark: Number(previous?.watermark || activation), reconcileAt: now() + 86400000, seen: {} }
    }
    const discovery = createFeedbackGitHub(async (method, path) => {
      const result = await request(repo, method, path)
      if (!path.startsWith(`/repos/${repo}/issues?`) || !Array.isArray(result)) return result
      // Keep page lengths and update timestamps intact for the discovery cursor.
      return result.map(item => item?.pull_request?.merged_at === null ? { ...item, pull_request: null } : item)
    }, { maxCalls: 5, now })
    const result = await discovery.discover(repo, previous)
    return { cursor: result.scan, complete: result.complete,
      items: result.items.map(({ number }) => ({ number })) }
  }
  function proposalDetails (intent) {
    const { source, baseline } = intent
    const allowed = config.paths.filter(path => !config.exclude.includes(path))
    if (!Array.isArray(intent.proposal?.edits) || intent.proposal.edits.some(edit => !allowed.includes(edit.path))) throw fail('docs-scope-changed')
    const proposal = validateProposal(intent.proposal, source, baseline,
      { ...config, paths: baseline.files.map(file => file.path), exclude: [] })
    if (!/^[a-f0-9]{64}$/.test(intent.key) || intent.sourceRepo !== source.repo || intent.number !== source.number ||
        intent.mergeSha !== source.mergeSha || intent.targetRepo !== baseline.repo || baseline.repo !== config.targetRepo) throw fail('incomplete')
    const repo = baseline.repo
    const branch = `specdoc/docs-${intent.key}`
    const title = `Update documentation for ${source.repo}#${source.number}`
    const message = `${title}\n\n${proposal.summary}\n\n${proposal.reason}\n\n${marker(intent.key)}`
    const body = `${proposal.summary}\n\n${proposal.reason}\n\nSource: ${source.url}\n\n${marker(intent.key)}`
    return { source, baseline, proposal, repo, branch, title, message, body }
  }
  async function proposalState (intent, details = proposalDetails(intent)) {
    const { baseline, proposal, repo, branch, title, message, body } = details
    const auth = await authenticate(repo, write)
    const stop = reason => ({ stage: 'stopped', reason })
    const prs = await pages(repo, `/pulls?state=all&head=${encodeURIComponent(repo.split('/')[0] + ':' + branch)}`, 100)
    if (prs.length > 1) return stop('docs-branch-collision')
    const pr = prs[0]
    if (pr && (pr.state !== 'open' || pr.user?.id !== auth.botId || pr.title !== title || pr.body !== body ||
        pr.head?.ref !== branch || pr.head?.repo?.full_name?.toLowerCase() !== repo || pr.base?.ref !== baseline.branch || pr.base?.repo?.full_name?.toLowerCase() !== repo)) return stop('docs-proposal-changed')
    const ref = await optional(repo, `/git/ref/heads/${encodeURIComponent(branch)}`)
    let commit = ref?.object?.sha
    if (ref && (ref.object.type !== 'commit' || !sha(commit))) return stop('docs-branch-changed')
    if (commit && commit !== baseline.commit) {
      const existing = await get(repo, `/commits/${commit}`)
      if (existing.sha !== commit || existing.author?.id !== auth.botId || existing.commit?.message !== message ||
          existing.commit?.verification?.verified !== true || existing.parents?.length !== 1 || existing.parents[0].sha !== baseline.commit ||
          existing.files?.length !== proposal.edits.length || existing.files.some(file => {
            const edit = proposal.edits.find(item => item.path === file.filename)
            return !edit || file.status !== 'modified' || file.sha !== blobHash(edit.content)
          })) return stop('docs-branch-changed')
    }
    if (pr && pr.head?.sha !== commit) return stop('docs-proposal-changed')
    if (intent.commit && commit !== intent.commit) return stop('docs-branch-changed')
    if (intent.prNumber && pr?.number !== intent.prNumber) return stop('docs-proposal-changed')
    return { pr, commit }
  }
  async function preflight ({ source, baseline, intent, notification = false }) {
    const sourceInfo = await publicRepo(source.repo)
    const info = await publicRepo(baseline.repo)
    const pr = await get(source.repo, `/pulls/${source.number}`)
    await rejectGeneratedSource(source.repo, pr)
    mergedIdentity(pr, source.repo, source.number)
    if (pr.base.ref !== sourceInfo.default_branch) throw fail('docs-source-branch')
    if (pr.merge_commit_sha !== source.mergeSha || pr.head.sha !== source.headSha || pr.user.id !== source.author.id ||
        pr.base.ref !== source.baseBranch || pr.user.login !== source.author.login || pr.user.type !== source.author.type) throw fail('docs-source-changed')
    const ref = await get(baseline.repo, `/git/ref/heads/${encodeURIComponent(baseline.branch)}`)
    if (info.default_branch !== baseline.branch || ref?.object?.type !== 'commit' || !sha(ref.object.sha)) throw fail('docs-target-changed')
    if (ref.object.sha !== baseline.commit) {
      if (!intent) throw fail('docs-target-changed')
      const comparison = await get(baseline.repo, `/compare/${baseline.commit}...${ref.object.sha}?per_page=1`)
      if (!['ahead', 'behind', 'diverged', 'identical'].includes(comparison?.status) ||
          comparison.base_commit?.sha !== baseline.commit || !sha(comparison.merge_base_commit?.sha)) throw fail('incomplete')
      if (comparison.status !== 'ahead' || comparison.merge_base_commit.sha !== baseline.commit) throw fail('docs-target-changed')
    }
    if (notification || ref.object.sha !== baseline.commit) {
      if (!intent) throw fail('docs-target-changed')
      const current = await proposalState(intent)
      if (current.stage === 'stopped') throw fail(current.reason)
      if (notification && !current.pr) throw fail('docs-proposal-removed')
    }
    return { ok: true }
  }
  async function advance (intent, { assertActive }) {
    const details = proposalDetails(intent)
    const { source, baseline, proposal, repo, branch, title, body } = details
    const stop = reason => ({ stage: 'stopped', reason })
    const mutate = async (destination, method, path, payload, permissions = write, notification = false) => {
      await preflight({ source, baseline, intent, notification })
      await assertActive()
      signal?.throwIfAborted()
      return request(destination, method, path, payload, permissions)
    }
    await preflight({ source, baseline, intent })
    const current = await proposalState(intent, details)
    if (current.stage === 'stopped') return current
    const { pr } = current
    let { commit } = current
    if (!commit) {
      if (intent.stage !== 'prepared') return stop('docs-branch-removed')
      await mutate(repo, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: baseline.commit })
      return { stage: 'branch', branch }
    }
    if (commit === baseline.commit) {
      if (!['prepared', 'branch'].includes(intent.stage) || pr) return stop('docs-branch-changed')
      const result = await mutate(repo, 'POST', '/graphql', {
        query: 'mutation($input: CreateCommitOnBranchInput!) { createCommitOnBranch(input: $input) { commit { oid } } }',
        variables: { input: { branch: { repositoryNameWithOwner: repo, branchName: branch }, expectedHeadOid: baseline.commit,
          message: { headline: title, body: `${proposal.summary}\n\n${proposal.reason}\n\n${marker(intent.key)}` },
          fileChanges: { additions: proposal.edits.map(edit => ({ path: edit.path, contents: Buffer.from(edit.content).toString('base64') })) } } }
      })
      commit = result?.data?.createCommitOnBranch?.commit?.oid
      if (result?.errors?.length || !sha(commit)) throw fail('docs-github-unavailable')
      return { stage: 'commit', branch, commit }
    }
    if (!pr) {
      if (!['prepared', 'branch', 'commit'].includes(intent.stage)) return stop('docs-proposal-removed')
      const created = await mutate(repo, 'POST', `/repos/${repo}/pulls`, { title, body, head: branch, base: baseline.branch })
      if (!Number.isSafeInteger(created?.number) || created.number < 1) throw fail('docs-github-unavailable')
      return { stage: 'pr', branch, commit, prNumber: created.number, prUrl: `https://github.com/${repo}/pull/${created.number}` }
    }
    const prUrl = `https://github.com/${repo}/pull/${pr.number}`
    const commentBody = `${source.author.type === 'Bot' ? 'A documentation update for this change is ready for review' : `@${source.author.login} a documentation update for this change is ready for your review`}: ${prUrl}\n\n${marker(intent.key)}`
    const comments = await pages(source.repo, `/issues/${source.number}/comments`, 300)
    const sourceAuth = await authenticate(source.repo, comment)
    const matches = comments.filter(item => item.user?.id === sourceAuth.botId && (item.body || '').includes(marker(intent.key)))
    if (matches.length > 1 || matches.some(item => item.body !== commentBody)) return stop('docs-comment-changed')
    if (matches.length) return { stage: 'complete', branch, commit, prNumber: pr.number, prUrl, commentId: matches[0].id }
    if (intent.commentId || intent.stage === 'comment') return stop('docs-comment-removed')
    if (source.author.type !== 'Bot' && !pr.requested_reviewers?.some(user => user.id === source.author.id)) {
      const reviews = await pages(repo, `/pulls/${pr.number}/reviews`, 300)
      if (!reviews.some(review => review.user?.id === source.author.id)) {
        try { await mutate(repo, 'POST', `/repos/${repo}/pulls/${pr.number}/requested_reviewers`, { reviewers: [source.author.login] }, write, true) } catch (error) {
          if (![403, 422].includes(error.status)) throw error
        }
      }
    }
    const created = await mutate(source.repo, 'POST', `/repos/${source.repo}/issues/${source.number}/comments`, { body: commentBody }, comment, true)
    if (!Number.isSafeInteger(created?.id) || created.id < 1) throw fail('docs-github-unavailable')
    return { stage: 'comment', branch, commit, prNumber: pr.number, prUrl, commentId: created.id }
  }
  return { discover, inspect, target, preflight, advance }
}

module.exports = { createDocumentationGitHub }
