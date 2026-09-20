const { esc } = require('./prosediff')
const input = (name, value) => `<input type="hidden" name="${name}" value="${esc(value == null ? '' : value)}">`
const query = values => '/roadmap?' + new URLSearchParams(Object.entries(values).filter(([, v]) => v != null && v !== '')).toString()
const option = (value, label, selected) => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`
const people = node => node.implementers.map(u => esc(u.login ? '@' + u.login : u.name)).join(', ') || 'No implementer'
const progress = m => m.incomplete ? 'Progress unavailable: some assigned work is no longer visible or eligible.' : `${m.implemented}/${m.total} implemented${m.percent == null ? '' : ` · ${m.percent}%`}`
function milestoneForm (m, csrf, namespace) {
  return `<form method="post" action="/roadmap" class="edit">${input('csrf', csrf)}${input('action', 'save-milestone')}${input('ns', namespace)}${input('id', m.id)}${input('version', m.version || 0)}
    <label>Title<input name="title" maxlength="160" required value="${esc(m.title || '')}"></label>
    <label>Description<textarea name="description" maxlength="10000" rows="3">${esc(m.description || '')}</textarea></label>
    <label>Due date<input type="date" name="dueDate" value="${esc(m.dueDate || '')}"></label>
    <label>State<select name="state">${option('open', 'Open', m.state || 'open')}${option('closed', 'Closed', m.state)}</select></label>
    <label>Linked spec checkpoint<input name="checkpointTag" placeholder="specs/v1 (optional)" value="${esc(m.checkpointTag || '')}"></label>
    <button class="primary">${m.id ? 'Save milestone' : 'Create milestone'}</button></form>`
}
function roadmapPage ({ model, nodes, namespaces, namespace, milestoneId, implementer, who, csrf, manageable, specId, users = [], userQuery = '', deleted = [], stale = false, loginEnabled = true, page = 0, hasMore = false, milestonePage = 0 }) {
  const milestone = model.milestones.find(m => m.id === milestoneId)
  const selected = model.nodes.find(n => n.id === specId)
  const milestones = model.milestones.filter(m => !namespace || m.namespace === namespace)
  const listedMilestones = milestones.filter(m => (!milestoneId || milestoneId === m.id) && (!model.filterState || m.state === model.filterState))
  const base = { ns: namespace, milestone: milestoneId, implementer, state: model.filterState }
  const deletedWork = deleted.filter(a => manageable.includes(a.namespace) &&
    (!milestoneId || (milestoneId === 'none' ? !a.milestoneId : a.milestoneId === milestoneId)))
  const nodeCard = n => `<article class="spec"><h3><a href="${esc(n.url)}">${esc(n.title)}</a></h3>
    <p class="meta"><span>${esc(n.namespace)}</span><span class="badge">${esc(n.status.replaceAll('-', ' '))}</span>${n.superseded ? '<span class="badge warning">Superseded</span>' : ''}${n.ready ? '<span class="badge success">Ready to implement</span>' : ''}</p>
    <p class="assignees">${people(n)}</p>${n.milestone ? `<p><a href="${query({ ns: n.namespace, milestone: n.milestone.id })}">${esc(n.milestone.title)}</a></p>` : ''}
    ${n.dependencies.length ? `<ul class="dependencies">${n.dependencies.map(d => `<li>← ${d.id ? `<a href="${d.state === 'invalid' ? esc(d.url) : query({ ns: d.namespace, spec: d.id })}">${esc(d.title)}</a>` : esc(d.title)} · ${esc(d.state)}${d.id && d.milestoneId !== (n.milestone && n.milestone.id) ? ' · outside milestone' : ''}</li>`).join('')}</ul>` : ''}
    ${n.blockers.length ? `<p class="warn">${n.blockers.map(esc).join('; ')}</p>` : ''}
    <a class="details-link" href="${query({ ns: n.namespace, spec: n.id })}">Assignments and details</a></article>`
  const fields = action => input('csrf', csrf) + input('action', action) + input('ns', selected.namespace) + input('noteId', selected.id) + input('version', selected.version)
  const assignment = selected && manageable.includes(selected.namespace) ? `<section class="assignment"><h2>Assign implementation</h2>
    ${selected.superseded ? (selected.milestone ? `<form method="post" action="/roadmap">${fields('milestone')}${input('milestoneId', '')}<button>Remove from milestone</button></form>` : '') : `<form method="post" action="/roadmap">${fields('milestone')}<label>Milestone<select name="milestoneId">${option('', 'No milestone', selected.milestone ? selected.milestone.id : '')}${model.milestones.filter(m => m.namespace === selected.namespace && (m.state === 'open' || (selected.milestone && selected.milestone.id === m.id))).map(m => option(m.id, m.title + (m.state === 'closed' ? ' (closed)' : ''), selected.milestone && selected.milestone.id)).join('')}</select></label><button class="primary">Save assignment</button></form>`}
    ${selected.implementers.map(u => `<form method="post" action="/roadmap">${fields('remove-implementer')}${input('userId', u.id)}<span>${esc(u.login ? '@' + u.login : u.name)}</span> <button>Remove implementer</button></form>`).join('')}
    ${!selected.superseded ? `<form method="get" action="/roadmap">${input('ns', selected.namespace)}${input('spec', selected.id)}<label>Find an implementer<input name="userQuery" value="${esc(userQuery)}" minlength="2" maxlength="80" placeholder="Username or display name"></label><button>Find users</button></form>
    ${userQuery && !users.length ? '<p>No matching users. Assignees need an existing editor account.</p>' : ''}
    ${users.filter(u => !selected.implementers.some(a => a.id === u.id)).map(u => `<form method="post" action="/roadmap">${fields('add-implementer')}${input('userId', u.id)}<span>${esc(u.login ? '@' + u.login : u.name)}</span> <button>Add implementer</button></form>`).join('')}` : ''}</section>` : ''
  const byWave = new Map()
  for (const n of nodes) {
    const key = n.superseded ? 'Superseded' : n.implemented ? 'Implemented' : n.wave == null ? 'Needs attention' : `Step ${n.wave + 1}`
    if (!byWave.has(key)) byWave.set(key, [])
    byWave.get(key).push(n)
  }
  const stageOrder = key => key === 'Implemented' ? -1 : key.startsWith('Step ') ? Number(key.slice(5)) : Infinity
  return `<div class="page-heading"><div><h1>Planning</h1><p class="context">${milestone ? esc(milestone.title) + ' · ' : ''}Plan milestones, assign implementers and work through dependencies.</p></div>${!who && loginEnabled ? '<a class="button" href="/roadmap?login=1">Sign in to manage</a>' : ''}</div>
  ${stale ? '<p class="warn">Spec data is stale. Progress and dependencies may have changed.</p>' : ''}
  <form method="get" action="/roadmap" class="filters">
    <label>Namespace<select name="ns">${option('', 'All namespaces', namespace)}${namespaces.map(ns => option(ns, ns, namespace)).join('')}</select></label>
    <label>Milestone<select name="milestone">${option('', 'All milestones', milestoneId)}${option('none', 'No milestone', milestoneId)}${milestones.map(m => option(m.id, m.title + ' (' + m.state + ')', milestoneId)).join('')}</select></label>
    <label>Implementer<select name="implementer">${option('', 'Anyone', implementer)}${who ? option('me', 'Assigned to me', implementer) : ''}${option('none', 'No implementer', implementer)}${[...new Map(model.nodes.flatMap(n => n.implementers).map(u => [u.id, u])).values()].map(u => option(u.id, u.login ? '@' + u.login : u.name, implementer)).join('')}</select></label>
    <label>Milestone state<select name="state">${option('', 'All', model.filterState)}${option('open', 'Open', model.filterState)}${option('closed', 'Closed', model.filterState)}</select></label><button>Apply filters</button>
  </form>
  ${selected ? `<section class="panel"><h2>Spec details</h2>${nodeCard(selected)}${assignment}</section>` : ''}
  ${deletedWork.length ? `<section class="panel"><h2>Deleted specs</h2><p>These notes have been deleted. Remove their assignments to restore milestone progress; planning history is retained.</p>
    ${deletedWork.map(a => `<form method="post" action="/roadmap">${input('csrf', csrf)}${input('action', 'detach-deleted')}${input('ns', a.namespace)}${input('noteId', a.noteId)}${input('version', a.version)}<span>Deleted spec ${esc(a.noteId)} · ${esc(a.namespace)}</span><button>Remove from planning</button></form>`).join('')}</section>` : ''}
  <div class="section-heading"><h2>Milestones</h2><span class="meta">${listedMilestones.length} ${listedMilestones.length === 1 ? 'milestone' : 'milestones'}</span></div>
  ${!listedMilestones.length ? '<div class="empty-state"><h3>No milestones in this selection</h3><p>Milestones group specifications into a shared implementation goal.</p></div>' : ''}
  <div class="milestones">${listedMilestones.slice(milestonePage * 100, (milestonePage + 1) * 100).map(m => `<article class="milestone"><h2><a href="${query({ ns: m.namespace, milestone: m.id })}">${esc(m.title)}</a></h2><p class="meta"><span>${esc(m.namespace)}</span><span class="badge">${esc(m.state)}</span>${m.dueDate ? `<span>Due ${esc(m.dueDate)}</span>` : ''}${m.overdue ? '<span class="badge warning">Overdue</span>' : ''}</p><p class="description">${esc(m.description)}</p><p class="progress-label">${progress(m)}</p>${m.percent != null ? `<progress value="${m.percent}" max="100" aria-label="Implementation progress">${m.percent}%</progress>` : ''}
    ${m.checkpointTag ? `<p class="meta">Linked spec checkpoint: <a href="https://github.com/${esc(m.namespace)}/tree/${esc(m.checkpointCommit)}">${esc(m.checkpointTag)}</a>. Covers the namespace's specs, not implementation completion.</p>` : ''}
    ${manageable.includes(m.namespace) ? `<details><summary>Edit milestone</summary>${milestoneForm(m, csrf, m.namespace)}</details>${m.state === 'open' && m.id === milestoneId ? `<details><summary>Add specs</summary>${model.nodes.filter(n => n.namespace === m.namespace && !n.superseded && !n.milestone).slice(0, 100).map(n => `<form method="post" action="/roadmap">${input('csrf', csrf)}${input('action', 'milestone')}${input('ns', m.namespace)}${input('noteId', n.id)}${input('version', n.version)}${input('milestoneId', m.id)}<span>${esc(n.title)}</span> <button>Add to milestone</button></form>`).join('') || '<p>No unassigned specs.</p>'}<p><a href="${query({ ns: m.namespace, milestone: 'none' })}">Browse all unassigned specs</a>. To move work from another milestone, use its spec assignment controls.</p></details>` : ''}` : ''}</article>`).join('')}</div>
  <nav class="pagination" aria-label="Milestone pages">${milestonePage > 0 ? `<a href="${query({ ...base, page, milestonePage: milestonePage - 1 })}">Previous milestones</a> ` : ''}${(milestonePage + 1) * 100 < listedMilestones.length ? `<a href="${query({ ...base, page, milestonePage: milestonePage + 1 })}">More milestones</a>` : ''}</nav>
  ${!milestoneId && manageable.length ? `<details class="disclosure"><summary>Create a milestone</summary>${manageable.map(ns => `<h2>${esc(ns)}</h2>${milestoneForm({}, csrf, ns)}`).join('')}</details>` : ''}
  <section><div class="section-heading"><h2>Implementation order</h2></div><p class="legend">Follow the numbered steps. Work in a step may proceed in parallel once approved and its prerequisites are implemented. These are dependency steps, not scheduled dates. Links show prerequisites outside this selection.</p>
    <div class="waves" role="region" aria-label="Implementation steps" tabindex="0">${[...byWave].sort((a, b) => stageOrder(a[0]) - stageOrder(b[0])).map(([key, rows]) => `<section class="wave"><h3>${esc(key)} <span class="badge">${rows.length}</span></h3>${rows.map(nodeCard).join('')}</section>`).join('') || '<div class="empty-state"><h3>No specs match these filters</h3><p>Try another namespace, milestone or implementer.</p></div>'}</div>
    <nav class="pagination" aria-label="Spec pages">${page > 0 ? `<a href="${query({ ...base, milestonePage, page: page - 1 })}">Previous specs</a> ` : ''}${hasMore ? `<a href="${query({ ...base, milestonePage, page: page + 1 })}">More specs</a>` : ''}</nav></section>`
}
module.exports = { roadmapPage, query }
