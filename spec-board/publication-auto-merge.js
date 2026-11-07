'use strict'

const { canonical, digest, policyHash, publicationMetadata, receiptMatches } = require('./publication-candidate')

const sha = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/.test(value)
const safePath = value => typeof value === 'string' && value.length <= 1024 && value.split('/').every(part => part && part !== '.' && part !== '..' && !/[\x00-\x1f\\]/.test(part))
const positive = value => Number.isSafeInteger(value) && value > 0

function mergePolicy (roles) {
  const value = roles && roles['auto-merge']
  if (value === undefined || value === false) return null
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['method', 'checks'].includes(key)) ||
      !['merge', 'squash', 'rebase'].includes(value.method) ||
      !Array.isArray(value.checks) || !value.checks.length || value.checks.length > 20) {
    throw new Error('auto-merge requires a merge method and named checks with App IDs')
  }
  const keys = new Set()
  for (const check of value.checks) {
    if (!check || Object.keys(check).some(key => !['name', 'app-id'].includes(key)) ||
        typeof check.name !== 'string' || !check.name.trim() || check.name.length > 200 ||
        /[\x00-\x1f]/.test(check.name) || !positive(check['app-id'])) throw new Error('Invalid auto-merge check')
    const key = `${check['app-id']}:${check.name}`
    if (keys.has(key)) throw new Error('Duplicate auto-merge check')
    keys.add(key)
  }
  return value
}

function assertIntent (intent) {
  const meta = publicationMetadata(intent && intent.document)
  if (!meta || intent.redacted_at || !safePath(intent.path) || !positive(intent.pr_number) || !sha(intent.base_sha) ||
      typeof intent.branch !== 'string' || !intent.branch || typeof intent.base_branch !== 'string' || !intent.base_branch ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(intent.namespace || '') || !safePath(intent.namespace) ||
      meta.noteId !== intent.note_id || meta.namespace !== intent.namespace || meta.submission !== intent.id ||
      meta.candidate !== intent.candidate_hash || digest(intent.document) !== intent.document_hash ||
      canonical(meta.relations) !== canonical(intent.relations)) throw new Error('Invalid publication merge intent')
}

function assertPr (pr, intent) {
  const marker = `<!-- specdoc-intent:${intent.id};candidate:${intent.candidate_hash};note:${intent.note_id} -->`
  if (!pr || pr.number !== intent.pr_number || !sha(pr.head?.sha) || !sha(pr.base?.sha) ||
      pr.head?.repo?.full_name?.toLowerCase() !== intent.namespace.toLowerCase() || pr.head.ref !== intent.branch ||
      pr.base?.repo?.full_name?.toLowerCase() !== intent.namespace.toLowerCase() || pr.base.ref !== intent.base_branch ||
      typeof pr.body !== 'string' || !pr.body.includes(marker)) throw new Error('Publication PR identity changed')
}

function assertAuthorization (current, intent) {
  if (!current || current.authorized !== true || current.candidate?.hash !== intent.candidate_hash ||
      current.candidate.policy !== intent.policy_hash || policyHash(current.roles) !== intent.policy_hash) {
    throw new Error('Publication approval or policy changed before merge')
  }
  return mergePolicy(current.roles)
}

function createPublicationAutoMerge ({ gh, withPublicationLock, authorize, artifacts, recover }) {
  async function branchComparison (intent, pr, token) {
    const comparison = await gh('GET', `/repos/${intent.namespace}/compare/${pr.base.sha}...${pr.head.sha}?per_page=100`, null, token)
    if (!sha(comparison.merge_base_commit?.sha) || !['ahead', 'diverged'].includes(comparison.status) ||
        !Array.isArray(comparison.files) || !comparison.files.length || comparison.files.length >= 300 ||
        !comparison.files.some(file => file.filename === intent.path) ||
        !Number.isSafeInteger(comparison.total_commits) || comparison.total_commits < 1 || comparison.total_commits > 100 ||
        !Array.isArray(comparison.commits) || comparison.commits.length !== comparison.total_commits) throw new Error('Publication branch history is not the authorized change')
    return comparison
  }

  async function filesMatch (intent, pr, token, comparison, extras) {
    const repo = `/repos/${intent.namespace}`
    if (!Array.isArray(extras) || extras.length > 20) throw new Error('Publication artifact receipts are incomplete')
    const expected = new Map([[intent.path, intent.document_hash]])
    const authorizedHashes = new Map([[intent.path, new Set([intent.document_hash])]])
    for (const item of extras) {
      if (!item || !safePath(item.path) || !/^[a-f0-9]{64}$/.test(item.documentHash || '') ||
          item.namespace !== intent.namespace || item.submission !== intent.id || item.branch !== intent.branch ||
          expected.has(item.path) || (item.previousHashes !== undefined && (!Array.isArray(item.previousHashes) || item.previousHashes.length > 200 ||
            item.previousHashes.some(hash => !/^[a-f0-9]{64}$/.test(hash))))) throw new Error('Invalid publication artifact receipt')
      expected.set(item.path, item.documentHash)
      authorizedHashes.set(item.path, new Set([item.documentHash, ...(item.previousHashes || [])]))
    }
    if (intent.base_sha !== pr.base.sha) {
      const ancestry = await gh('GET', `${repo}/compare/${intent.base_sha}...${pr.base.sha}?per_page=1`, null, token)
      if (ancestry.merge_base_commit?.sha !== intent.base_sha || !['ahead', 'identical'].includes(ancestry.status)) throw new Error('The publication base history changed')
    }
    const trees = new Map()
    const commits = new Map()
    const blobs = new Map()
    const commitAt = async commit => {
      if (!commits.has(commit)) {
        const object = await gh('GET', `${repo}/git/commits/${commit}`, null, token)
        if (object.sha !== commit || !sha(object.tree?.sha)) throw new Error('Publication commit tree is unavailable')
        commits.set(commit, object)
      }
      return commits.get(commit)
    }
    const entryAt = async (commit, path) => {
      let tree = (await commitAt(commit)).tree.sha
      const parts = path.split('/')
      for (let i = 0; i < parts.length; i++) {
        if (!trees.has(tree)) {
          const object = await gh('GET', `${repo}/git/trees/${tree}`, null, token)
          if (object.sha !== tree || object.truncated !== false || !Array.isArray(object.tree)) throw new Error('Publication file tree is incomplete')
          trees.set(tree, object.tree)
        }
        const entries = trees.get(tree).filter(entry => entry.path === parts[i])
        if (!entries.length) return null
        if (entries.length !== 1 || !sha(entries[0].sha)) throw new Error('Publication file tree is invalid')
        const entry = entries[0]
        if (i === parts.length - 1) return entry
        if (entry.type !== 'tree' || entry.mode !== '040000') throw new Error('Publication path is not a directory')
        tree = entry.sha
      }
    }
    const validateFiles = async (files, commit, final = false) => {
      if (!Array.isArray(files) || files.length >= 300) throw new Error('Publication commit file list is incomplete')
      if (!files.length) throw new Error('Publication commit contains no authorized file change')
      const paths = new Set()
      for (const file of files) {
        if (!expected.has(file.filename) || paths.has(file.filename) || !['added', 'modified'].includes(file.status) || file.previous_filename) {
          throw new Error('Publication branch contains an unauthorized file change')
        }
        paths.add(file.filename)
        const entry = await entryAt(commit, file.filename)
        if (!entry || entry.type !== 'blob' || entry.mode !== '100644' || entry.sha !== file.sha) throw new Error('Publication artifact is not a regular file')
        if (!blobs.has(entry.sha)) {
          const blob = await gh('GET', `${repo}/git/blobs/${entry.sha}`, null, token)
          if (blob.sha !== entry.sha || blob.encoding !== 'base64' || typeof blob.content !== 'string' ||
              !Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > 1024 * 1024 || blob.content.length > 2 * 1024 * 1024) throw new Error('Publication artifact is unavailable')
          blobs.set(entry.sha, digest(Buffer.from(blob.content, 'base64')))
        }
        const hash = blobs.get(entry.sha)
        if (final ? hash !== expected.get(file.filename) : !authorizedHashes.get(file.filename).has(hash)) throw new Error('Publication artifact differs from its authorization')
        if (final) {
          const original = await entryAt(intent.base_sha, file.filename)
          const current = await entryAt(pr.base.sha, file.filename)
          if ((original?.sha || null) !== (current?.sha || null) || (original?.mode || null) !== (current?.mode || null)) {
            throw new Error('The publication destination changed on the base branch')
          }
        }
      }
    }
    await validateFiles(comparison.files, pr.head.sha, true)
    const seen = new Set()
    for (const item of comparison.commits) {
      if (!sha(item.sha) || seen.has(item.sha)) throw new Error('Publication commit listing is invalid')
      seen.add(item.sha)
      const commit = await commitAt(item.sha)
      if (!Array.isArray(commit.parents) || commit.parents.length < 1 || commit.parents.length > 2 || commit.parents.some(parent => !sha(parent.sha))) throw new Error('Publication commit ancestry is invalid')
      const parent = commit.parents.at(-1).sha
      if (commit.parents.length === 2 && parent !== pr.base.sha) {
        const ancestry = await gh('GET', `${repo}/compare/${parent}...${pr.base.sha}?per_page=1`, null, token)
        if (ancestry.merge_base_commit?.sha !== parent || !['ahead', 'identical'].includes(ancestry.status)) throw new Error('Publication merge commit has an unrelated parent')
      }
      const changes = await gh('GET', `${repo}/compare/${parent}...${item.sha}?per_page=1`, null, token)
      if (changes.merge_base_commit?.sha !== parent) throw new Error('Publication commit ancestry changed')
      await validateFiles(changes.files, item.sha)
    }
    if (!seen.has(pr.head.sha)) throw new Error('Publication head is absent from its commit listing')
  }

  async function checksReady (intent, head, policy, token) {
    const selected = []
    for (const check of policy.checks) {
      const runs = []
      for (let page = 1; page <= 10; page++) {
        const result = await gh('GET', `/repos/${intent.namespace}/commits/${head}/check-runs?check_name=${encodeURIComponent(check.name)}&filter=latest&per_page=100&page=${page}`, null, token)
        if (!Array.isArray(result.check_runs) || !Number.isSafeInteger(result.total_count) || result.total_count < 0 || result.total_count > 1000) throw new Error('Publication check listing is incomplete')
        runs.push(...result.check_runs)
        if (runs.length >= result.total_count) break
        if (!result.check_runs.length || page === 10) throw new Error('Publication check listing is incomplete')
      }
      const matching = runs.filter(run => run.name === check.name && run.app?.id === check['app-id'] && run.head_sha === head)
      if (!matching.length || matching.some(run => !positive(run.id) || run.status !== 'completed' || run.conclusion !== 'success')) return null
      selected.push(...matching.map(run => ({ id: run.id, name: run.name, appId: run.app.id, head })))
    }
    return selected
  }

  const recoverMerge = async (intent, token) => {
    const result = await recover(intent, token)
    if (!receiptMatches(result, intent, intent.namespace, intent.note_id)) throw new Error('Merged publication could not be verified')
    return { state: 'merged', number: intent.pr_number, receipt: result }
  }

  return async function mergePublication (intent, token) {
    assertIntent(intent)
    const repo = `/repos/${intent.namespace}`
    const pull = `${repo}/pulls/${intent.pr_number}`
    const current = await authorize(intent)
    const policy = assertAuthorization(current, intent)
    if (!policy) return { state: 'disabled' }
    const pr = await gh('GET', pull, null, token)
    assertPr(pr, intent)
    if (pr.merged_at) return withPublicationLock(intent.note_id, async () => {
      assertAuthorization(await authorize(intent), intent)
      return recoverMerge(intent, token)
    })
    if (pr.state !== 'open') return { state: 'closed' }
    const comparison = await branchComparison(intent, pr, token)
    const upToDate = comparison.merge_base_commit.sha === pr.base.sha
    if (pr.draft || (upToDate && (pr.mergeable !== true || pr.mergeable_state !== 'clean'))) return { state: 'waiting', reason: 'mergeability' }
    const checks = upToDate ? await checksReady(intent, pr.head.sha, policy, token) : []
    if (!checks) return { state: 'waiting', reason: 'checks' }
    const extras = await artifacts(intent)
    const artifactVersion = canonical(extras)
    await filesMatch(intent, pr, token, comparison, extras)
    return withPublicationLock(intent.note_id, async () => {
      if (canonical(await artifacts(intent)) !== artifactVersion) return { state: 'waiting', reason: 'changed' }
      const refreshedChecks = upToDate ? await checksReady(intent, pr.head.sha, policy, token) : []
      if (!refreshedChecks || canonical(refreshedChecks) !== canonical(checks)) return { state: 'waiting', reason: 'checks' }
      const refreshed = await gh('GET', pull, null, token)
      assertPr(refreshed, intent)
      if (refreshed.merged_at) {
        assertAuthorization(await authorize(intent), intent)
        return recoverMerge(intent, token)
      }
      if (refreshed.state !== 'open') return { state: 'closed' }
      if (refreshed.head.sha !== pr.head.sha || refreshed.base.sha !== pr.base.sha || refreshed.draft ||
          (upToDate && (refreshed.mergeable !== true || refreshed.mergeable_state !== 'clean'))) return { state: 'waiting', reason: 'changed' }
      const freshPolicy = assertAuthorization(await authorize(intent, { operation: upToDate ? 'merge' : 'update-branch', head: pr.head.sha, checks }), intent)
      if (!freshPolicy || canonical(freshPolicy) !== canonical(policy)) throw new Error('Publication merge policy changed')
      let merged
      try {
        if (!upToDate) {
          await gh('PUT', `${pull}/update-branch`, { expected_head_sha: pr.head.sha }, token)
          return { state: 'waiting', reason: 'branch-updated' }
        }
        merged = await gh('PUT', `${pull}/merge`, { sha: pr.head.sha, merge_method: policy.method }, token)
      } catch (error) {
        const after = await gh('GET', pull, null, token)
        assertPr(after, intent)
        if (after.merged_at && after.head.sha === pr.head.sha) return recoverMerge(intent, token)
        if (error.status === 405 && after.state === 'open' && after.head.sha === pr.head.sha && after.base.sha === pr.base.sha) {
          return { state: 'waiting', reason: 'repository-policy' }
        }
        throw error
      }
      if (merged.merged !== true) return { state: 'waiting', reason: 'repository-policy' }
      return recoverMerge(intent, token)
    })
  }
}

module.exports = { mergePolicy, createPublicationAutoMerge }
