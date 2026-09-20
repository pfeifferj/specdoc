const crypto = require('crypto')

const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value)
const digest = body => crypto.createHash('sha256').update(body).digest('hex')
const unavailable = message => Object.assign(new Error(message), { code: 'publication-baseline' })
const safePath = value => typeof value === 'string' && value.length <= 1000 &&
  value.split('/').every(part => /^[\w.-]+$/.test(part) && part !== '.' && part !== '..')
const encodedPath = value => value.split('/').map(encodeURIComponent).join('/')

function createPublicationRecovery (gh, { maxFilePages = 10, maxBytes = 2 * 1024 * 1024 } = {}) {
  async function filePath (repo, number, pr, options, token) {
    if (options.path) {
      if (!safePath(options.path) || !options.path.endsWith('.md')) throw unavailable('Invalid recorded publication path')
      return options.path
    }
    const dir = options.specsDir || ''
    if (dir && !safePath(dir)) throw unavailable('Invalid publication directory')
    const prefix = dir ? dir + '/' : ''
    const files = []
    let complete = false
    for (let page = 1; page <= maxFilePages; page++) {
      const batch = await gh('GET', `${repo}/pulls/${number}/files?per_page=100&page=${page}`, null, token)
      if (!Array.isArray(batch) || batch.length > 100) throw unavailable('Invalid publication file listing')
      files.push(...batch)
      if (batch.length < 100) { complete = true; break }
    }
    if (!complete) throw unavailable('Publication file listing is incomplete')
    const candidates = [...new Set(files.filter(file => file.status !== 'removed' && safePath(file.filename) &&
      file.filename.startsWith(prefix) && file.filename.endsWith('.md') && !/(^|\/)readme\.md$/i.test(file.filename))
      .map(file => file.filename).filter(path => options.topLevel
        ? !path.slice(prefix.length).includes('/')
        : /(^|\/)\d+-[\w.-]+(?:\.md|\/spec\.md)$/.test(path)))]
    const branch = options.branch || pr.head?.ref || ''
    const stem = options.revision ? branch.replace(/-r\d+$/, '') : branch
    const matching = candidates.filter(path => path === `${prefix}${stem}.md` || path === `${prefix}${stem}/spec.md`)
    if (matching.length === 1) return matching[0]
    if (!matching.length && candidates.length === 1) return candidates[0]
    throw unavailable('Merged publication path is missing or ambiguous')
  }

  async function recover (namespace, number, options = {}, token) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(namespace) || !Number.isSafeInteger(number) || number < 1) throw unavailable('Invalid publication identity')
    const repo = `/repos/${namespace}`
    const pr = await gh('GET', `${repo}/pulls/${number}`, null, token)
    if (!pr || pr.number !== number) throw unavailable('Publication PR identity could not be confirmed')
    if (!pr.merged_at) return null
    if (!sha(pr.merge_commit_sha)) throw unavailable('Merged publication commit is unavailable')
    if (pr.base?.repo?.full_name && pr.base.repo.full_name.toLowerCase() !== namespace.toLowerCase()) throw unavailable('Publication belongs to another repository')
    const commit = pr.merge_commit_sha
    const path = await filePath(repo, number, pr, options, token)
    const result = { number, path, state: 'merged', commit, revision: options.revision || 0 }
    if (options.publishedCommit === commit && options.publishedHash && options.path) return { ...result, unchanged: true }
    let file = await gh('GET', `${repo}/contents/${encodedPath(path)}?ref=${commit}`, null, token)
    if (file && file.encoding !== 'base64' && sha(file.sha)) file = await gh('GET', `${repo}/git/blobs/${file.sha}`, null, token)
    if (!file || file.encoding !== 'base64' || typeof file.content !== 'string' || file.size > maxBytes || file.content.length > maxBytes * 2) {
      throw unavailable('Merged publication text is unavailable or too large')
    }
    const encoded = file.content.replace(/\s/g, '')
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw unavailable('Merged publication text is invalid')
    const bytes = Buffer.from(encoded, 'base64')
    const body = bytes.toString('utf8')
    if (bytes.length > maxBytes || !Buffer.from(body).equals(bytes)) throw unavailable('Merged publication must be bounded UTF-8 text')
    return { ...result, body, hash: digest(body) }
  }

  return { recover }
}

module.exports = { createPublicationRecovery }
