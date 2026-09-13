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

module.exports = { implementsRefs, specRef }
