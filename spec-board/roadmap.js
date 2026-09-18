const { specRef } = require('./refs')

const fail = (status, message) => Object.assign(new Error(message), { status })
const positiveId = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
function version (value) {
  if (!/^\d{1,9}$/.test(String(value))) throw fail(400, 'Invalid version')
  return Number(value)
}
function milestoneInput (input) {
  const title = String(input.title || '').trim()
  const description = String(input.description || '').trim()
  const dueDate = input.dueDate || null
  const state = input.state || 'open'
  const checkpointTag = String(input.checkpointTag || '').trim() || null
  if (!title || title.length > 160 || description.length > 10000) throw fail(400, 'Use a title of 1-160 characters and a description of at most 10,000 characters')
  if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0, 10) !== dueDate || dueDate < '0001-01-01')) throw fail(400, 'Invalid due date')
  if (!['open', 'closed'].includes(state)) throw fail(400, 'Invalid milestone state')
  if (checkpointTag && !/^specs\/v[1-9]\d{0,8}$/.test(checkpointTag)) throw fail(400, 'Use an existing checkpoint tag such as specs/v1')
  return { title, description, dueDate, state, checkpointTag }
}

function decorateSpecs (specs, data) {
  const milestones = new Map(data.milestones.map(m => [m.id, m]))
  const assignments = new Map(data.assignments.map(a => [a.noteId, a]))
  return specs.map(s => {
    const a = assignments.get(s.id)
    const valid = a && a.namespace === s.namespace && !s.topLevel
    const m = valid && milestones.get(a.milestoneId)
    return { ...s, planningVersion: a ? a.version : 0,
      milestone: m && m.namespace === s.namespace ? { id: m.id, title: m.title, dueDate: m.dueDate, state: m.state } : null,
      implementers: valid ? a.implementers : [] }
  })
}

function filterSpecs (specs, { milestone = '', implementer = '' } = {}, who = null) {
  return specs.filter(s => (!milestone || (milestone === 'none' ? !s.milestone : s.milestone && s.milestone.id === milestone)) &&
    (!implementer || (implementer === 'none' ? !s.implementers.length : s.implementers.some(u => implementer === 'me' ? who && String(who.uid) === u.id : u.id === implementer))))
}

function roadmap (specs, state, data, now = new Date(), approvalAllowed = () => false) {
  const decorated = decorateSpecs(specs, data)
  const byId = new Map(decorated.map(s => [s.id, s]))
  const byRef = new Map()
  for (const s of decorated) {
    const st = state.get(s.id) || {}
    if (st.pr_number) byRef.set(`${st.namespace || s.namespace}#${st.pr_number}`, s.id)
    for (const id of [s.id, s.alias, s.urlId].filter(Boolean)) byRef.set(id, s.id)
  }
  const nodes = decorated.filter(s => !s.topLevel).map(s => {
    const st = state.get(s.id) || {}
    return { id: s.id, namespace: s.namespace, title: s.title, url: s.url,
      status: st.implemented_at ? 'implemented' : ['draft', 'ready-for-review', 'in-review', 'approved', 'implemented'][s.statusIdx],
      implemented: !!st.implemented_at, superseded: !!st.superseded_at,
      milestone: s.milestone, implementers: s.implementers, version: s.planningVersion,
      dependencies: [], blockers: [], cycle: false, wave: null, ready: false }
  })
  const nodeMap = new Map(nodes.map(n => [n.id, n]))
  for (const node of nodes) {
    for (const raw of byId.get(node.id).dependsOn || []) {
      const ref = typeof raw === 'string' ? specRef(raw, node.namespace) : raw
      const id = ref && byRef.get(ref.noteId || `${ref.ns}#${ref.n}`)
      const target = id && byId.get(id)
      const dep = id && nodeMap.get(id)
      node.dependencies.push(target ? { id, title: target.title, namespace: target.namespace, url: target.url,
        milestoneId: dep && dep.milestone ? dep.milestone.id : null,
        state: target.topLevel ? 'invalid' : dep.superseded ? 'superseded' : dep.implemented ? 'implemented' : 'pending' }
        : { id: null, title: 'Unresolved prerequisite', state: 'unresolved' })
    }
  }
  // Iterative DFS avoids call-stack limits for long dependency chains.
  const color = new Map()
  const finish = []
  const edges = n => n.dependencies.filter(d => d.state === 'pending' && nodeMap.has(d.id)).map(d => d.id)
  const active = nodes.filter(n => !n.implemented && !n.superseded)
  for (const start of active) {
    if (color.has(start.id)) continue
    color.set(start.id, 1)
    const stack = [{ id: start.id, next: 0, edges: edges(start) }]
    while (stack.length) {
      const frame = stack[stack.length - 1]
      if (frame.next === frame.edges.length) { finish.push(frame.id); color.set(frame.id, 2); stack.pop(); continue }
      const id = frame.edges[frame.next++]
      if (!color.has(id)) { color.set(id, 1); stack.push({ id, next: 0, edges: edges(nodeMap.get(id)) }) }
    }
  }
  const reverse = new Map(active.map(n => [n.id, []]))
  for (const n of active) for (const id of edges(n)) reverse.get(id).push(n.id)
  const seen = new Set()
  for (const id of finish.slice().reverse()) {
    if (seen.has(id)) continue
    const component = [], stack = [id]
    seen.add(id)
    while (stack.length) {
      const cur = stack.pop(); component.push(cur)
      for (const next of reverse.get(cur)) if (!seen.has(next)) { seen.add(next); stack.push(next) }
    }
    if (component.length > 1 || edges(nodeMap.get(id)).includes(id)) for (const cur of component) nodeMap.get(cur).cycle = true
  }
  for (const id of finish) {
    const n = nodeMap.get(id)
    if (n.cycle) n.blockers.push('Dependency cycle')
    for (const d of n.dependencies) {
      if (d.state === 'unresolved') n.blockers.push('Unresolved prerequisite')
      if (d.state === 'superseded') n.blockers.push('Superseded prerequisite')
      if (d.state === 'invalid') n.blockers.push('Top-level specs cannot be implementation prerequisites')
    }
    const pending = edges(n).map(id => nodeMap.get(id))
    if (!n.cycle && pending.some(d => d.wave === null)) n.blockers.push('Blocked by an unresolved dependency or cycle')
    if (!n.blockers.length) n.wave = pending.length ? 1 + pending.reduce((max, d) => Math.max(max, d.wave), 0) : 0
    const approved = n.status === 'approved' && approvalAllowed(byId.get(id))
    n.ready = !n.blockers.length && !pending.length && approved
    if (n.status === 'approved' && !approved) n.blockers.push('Approval requirements are not met')
    if (pending.length && !n.blockers.length) n.blockers.push('Waiting for prerequisite implementation')
  }
  const today = now.toISOString().slice(0, 10)
  const counts = new Map(data.milestones.map(m => [m.id, { namespace: m.namespace, total: 0, implemented: 0, incomplete: false }]))
  for (const n of nodes) {
    const count = n.milestone && counts.get(n.milestone.id)
    if (count) { count.total++; if (n.implemented && !n.superseded) count.implemented++ }
  }
  for (const a of data.assignments) {
    const count = counts.get(a.milestoneId)
    const spec = byId.get(a.noteId)
    if (count && (!spec || spec.namespace !== count.namespace || spec.topLevel)) count.incomplete = true
  }
  const milestones = data.milestones.map(m => {
    const { total, implemented, incomplete } = counts.get(m.id)
    return { ...m, total, implemented, incomplete, percent: !incomplete && total ? Math.floor(100 * implemented / total) : null,
      overdue: m.state === 'open' && !!m.dueDate && m.dueDate < today }
  }).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999') || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
  nodes.sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
  return { milestones, nodes }
}

module.exports = { fail, positiveId, version, milestoneInput, decorateSpecs, filterSpecs, roadmap }
