const { implementsRefs, specPathRefs, canonicalSpecPath, specRef } = require('./refs')
const { readGit } = require('./git')
const git = (repo, ...args) => readGit(repo, args)

// Only completion refs use the implementation repository's origin as their
// default namespace. Spec paths require an explicit source mapping.
function originRepo (repo) {
  try {
    const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(git(repo, 'remote', 'get-url', 'origin').trim())
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

function contributionRef (ref, sources) {
  const candidates = sources.filter(s => s.namespace && canonicalSpecPath(s.path) === canonicalSpecPath(ref.path))
  const targets = new Map(candidates.map(s => [`${s.namespace}\0${s.reference || s.id || canonicalSpecPath(s.path)}`, s]))
  if (targets.size !== 1) {
    return {
      ...ref, relation: 'contributes_to', ns: null, label: `path:${ref.path}`,
      resolution: 'unresolved', reason: targets.size ? 'ambiguous configured Spec path' : 'no configured source for Spec path',
      candidates: [...targets.values()].map(s => ({ namespace: s.namespace, path: s.path, reference: s.reference || null, id: s.id || null }))
    }
  }
  const source = [...targets.values()][0]
  const published = source.reference && specRef(source.reference, source.namespace)
  if (published?.ns && published.ns !== source.namespace) {
    return { ...ref, relation: 'contributes_to', ns: null, label: `path:${ref.path}`, resolution: 'unresolved', reason: 'source reference namespace does not match source namespace', candidates: [] }
  }
  return {
    ...ref, relation: 'contributes_to', ns: source.namespace, specPath: source.path,
    sourceId: source.id || null, label: source.reference || source.id || `${source.namespace}:${source.path}`,
    ...(published?.n ? { n: published.n } : {}), resolution: 'configured-source'
  }
}

// NUL separates message fields; Git refuses NUL in a commit message. This
// records file-level history, not symbol attribution or requirement coverage.
function referenceLog (repo, sources) {
  const origin = originRepo(repo)
  let fields
  try {
    fields = git(repo, 'log', '-i', '--grep=implements ', '--grep=^Spec:', '--name-only', '--format=%x00%h%x00%s%x00%b%x00').split('\0').slice(1)
  } catch {
    return []
  }
  const out = []
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [sha, subject, body, files] = fields.slice(i, i + 4)
    const message = `${subject}\n\n${body}`
    const refs = [
      ...implementsRefs(message, origin).filter(r => r.ns).map(r => ({ ...r, label: `${r.ns}#${r.n}`, relation: 'implements' })),
      ...specPathRefs(message).map(r => contributionRef(r, sources))
    ]
    if (!refs.length) continue
    out.push({ sha, subject, refs, files: files.split('\n').map(f => f.trim()).filter(Boolean) })
  }
  return out
}

class Trace {
  constructor (repo, sources = []) {
    this.repo = repo
    this.head = null
    this.commits = []
    this.configure(sources)
  }

  configure (sources = []) {
    const next = JSON.stringify(sources.map(({ id, namespace, path, reference }) => ({ id, namespace, path, reference })))
    if (this.mapping !== next) this.head = null
    this.mapping = next
    this.sources = sources
    return this
  }

  refresh (head) {
    if (head === this.head) return this
    this.head = head
    this.commits = referenceLog(this.repo, this.sources)
    return this
  }

  forSpec (s) {
    return this.commits.filter(c => this.refsForSpec(c, s).length)
  }

  refsForSpec (commit, s) {
    return commit.refs.filter(r => {
      if (r.ns !== s.namespace) return false
      if (r.relation === 'implements') return !!s.pr && r.n === s.pr
      return (s.specPath && canonicalSpecPath(r.specPath) === canonicalSpecPath(s.specPath)) ||
        (!!s.pr && r.n === s.pr) || (!!s.id && (r.sourceId === s.id || r.label === s.id))
    })
  }

  forFile (file) {
    return this.commits.filter(c => c.files.includes(file))
  }

  namespaces (relation = null) {
    return [...new Set(this.commits.flatMap(c => c.refs.filter(r => !relation || r.relation === relation).map(r => r.ns).filter(Boolean)))]
  }
}

module.exports = { Trace }
