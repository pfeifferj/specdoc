// Reference syntax shared by the board's commit scan and the agent-facing
// mcp server, so both resolve "implements owner/repo#N" the same way.

// "implements" refs in a commit message. Bare "#12" refers to the scanned
// repo; the feature usually lands elsewhere, so cross-repo commits use
// GitHub's full reference syntax: "implements owner/spec-repo#12".
function implementsRefs (message, scannedRepo) {
  const refs = []
  for (const m of message.matchAll(/\bimplements ((?:[\w.-]+\/[\w.-]+)?#(\d+))/gi)) {
    const ns = m[1].includes('/') ? m[1].slice(0, m[1].indexOf('#')) : scannedRepo
    refs.push({ ns, n: Number(m[2]) })
  }
  return refs
}

// A contribution is a Git trailer, not an occurrence in prose or a completion
// declaration. Repeated Spec trailers each identify one repository-relative
// path. Resolve that path through caller-supplied sources, never its digits.
function specPathRefs (message) {
  const text = String(message).replace(/\r\n/g, '\n').trimEnd()
  const paragraphs = text.split(/\n[ \t]*\n/)
  if (paragraphs.length < 2) return []
  const trailers = []
  for (const line of paragraphs.at(-1).split('\n')) {
    const match = /^([A-Za-z0-9-]+):[ \t]*(.*)$/.exec(line)
    if (match) trailers.push({ name: match[1], value: match[2] })
    else if (/^implements (?:[\w.-]+\/[\w.-]+)?#\d+[ \t]*$/i.test(line)) trailers.push({ name: 'implements', value: line })
    else if (/^[ \t]/.test(line) && trailers.length) trailers.at(-1).value += ` ${line.trim()}`
    else return []
  }
  return trailers.filter(t => t.name.toLowerCase() === 'spec')
    .map(t => t.value.trim()).filter(validSpecPath).map(path => ({ path }))
}

function validSpecPath (value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value) &&
    value.split('/').every(part => part !== '.' && part !== '..')
}

function canonicalSpecPath (value) {
  return validSpecPath(value) ? value.replace(/\.md$/, '') : null
}

// One note-authored pointer at another spec. Bare "#12" targets the note's own
// namespace; "owner/repo#12" crosses namespaces. Mirrors implementsRefs.
function specRef (value, defaultNs) {
  const v = String(value ?? '').trim()
  if (!v) return null
  // Same namespace: a bare number "5" (YAML-safe, no leading # that YAML would
  // read as a comment) or "#5". Cross namespace: "owner/repo#5".
  const m = /^(?:([\w.-]+\/[\w.-]+)#)?#?(\d+)$/.exec(v)
  if (m) return { ns: m[1] || defaultNs, n: Number(m[2]) }
  // A note shortid targets a spec that has no PR number to reference (e.g. one
  // marked implemented by hand); resolved directly against the state map.
  if (/^[A-Za-z0-9_-]+$/.test(v)) return { noteId: v }
  return null
}

module.exports = { implementsRefs, specPathRefs, canonicalSpecPath, specRef }
