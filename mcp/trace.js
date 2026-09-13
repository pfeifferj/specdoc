const { implementsRefs } = require('../spec-board/refs')
const { git } = require('./index')

// owner/repo of origin, so a bare "implements #N" resolves the way the
// board's scan resolves it for this repo.
function originRepo (repo) {
  try {
    const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(git(repo, 'remote', 'get-url', 'origin').trim())
    return m ? m[1] : ''
  } catch {
    return ''
  }
}

// Every commit whose message names a spec, with the files it touched. NUL
// delimits the fields: git refuses a NUL in a commit message, so a message
// cannot shift the record boundaries however it is written.
// ponytail: file-level trace; intersect --unified=0 hunks with def ranges if
// per-symbol attribution is needed.
function implementsLog (repo) {
  const origin = originRepo(repo)
  let fields
  try {
    fields = git(repo, 'log', '-i', '--grep=implements ', '--name-only', '--format=%x00%h%x00%s%x00%b%x00').split('\0').slice(1)
  } catch {
    return []
  }
  const out = []
  for (let i = 0; i + 3 < fields.length; i += 4) {
    const [sha, subject, body, files] = fields.slice(i, i + 4)
    const refs = implementsRefs(`${subject}\n${body}`, origin).filter(r => r.ns).map(r => ({ ...r, label: `${r.ns}#${r.n}` }))
    if (!refs.length) continue
    out.push({ sha, subject, refs, files: files.split('\n').map(f => f.trim()).filter(Boolean) })
  }
  return out
}

class Trace {
  constructor (repo) {
    this.repo = repo
    this.head = null
    this.commits = []
  }

  refresh (head) {
    if (head === this.head) return this
    this.head = head
    this.commits = implementsLog(this.repo)
    return this
  }

  forSpec (s) {
    return s.pr ? this.commits.filter(c => c.refs.some(r => r.ns === s.namespace && r.n === s.pr)) : []
  }

  forFile (file) {
    return this.commits.filter(c => c.files.includes(file))
  }

  namespaces () {
    return [...new Set(this.commits.flatMap(c => c.refs.map(r => r.ns)))]
  }
}

module.exports = { Trace }
