const invalid = message => new Error('Invalid DOCUMENTATION_FOLLOWUPS: ' + message)
const repository = value => typeof value === 'string' && value.length <= 200 &&
  /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)

function markdownPath (value) {
  return typeof value === 'string' && value.length <= 500 && /\.md$/i.test(value) &&
    !/[\\%\x00-\x1f\x7f*?\[\]{}]/.test(value) &&
    value.split('/').every(part => part && part !== '.' && part !== '..' && !part.startsWith('.'))
}

function documentationTargets (raw, namespaces) {
  let targets
  try { targets = JSON.parse(raw || '[]') } catch (_) { throw invalid('expected a JSON array') }
  if (!Array.isArray(targets) || targets.length > 16) throw invalid('expected an array of at most 16 targets')
  const allowed = new Set(namespaces.map(namespace => namespace.toLowerCase()))
  const seen = new Set()
  return targets.map(target => {
    if (!target || typeof target !== 'object' || Array.isArray(target) ||
        Object.keys(target).some(key => !['namespace', 'targetRepo', 'paths', 'exclude', 'bot'].includes(key))) throw invalid('unknown target fields')
    if (!repository(target.namespace) || !repository(target.targetRepo)) throw invalid('namespace and targetRepo must name repositories')
    const namespace = target.namespace.toLowerCase()
    const targetRepo = target.targetRepo.toLowerCase()
    if (!allowed.has(namespace)) throw invalid('namespace must be configured on this board')
    const key = namespace + ':' + targetRepo
    if (seen.has(key)) throw invalid('duplicate namespace and target repository')
    seen.add(key)
    if (typeof target.bot !== 'string' || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(target.bot)) throw invalid('a configured bot name is required')
    const paths = target.paths
    const exclude = target.exclude || []
    if (!Array.isArray(paths) || !paths.length || paths.length > 32 || paths.some(path => !markdownPath(path)) ||
        !Array.isArray(exclude) || exclude.length > 32 || exclude.some(path => !markdownPath(path))) throw invalid('paths and exclude must list Markdown file paths')
    if (new Set(paths).size !== paths.length || new Set(exclude).size !== exclude.length) throw invalid('duplicate Markdown paths')
    if (!paths.some(path => !exclude.includes(path))) throw invalid('at least one Markdown path must be included')
    return Object.freeze({ namespace, targetRepo, bot: target.bot,
      paths: Object.freeze([...paths].sort()), exclude: Object.freeze([...exclude].sort()) })
  })
}

module.exports = { documentationTargets, markdownPath }
