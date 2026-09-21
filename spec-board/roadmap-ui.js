const { esc } = require('./prosediff')
const input = (name, value) => `<input type="hidden" name="${name}" value="${esc(value == null ? '' : value)}">`
const query = values => '/roadmap?' + new URLSearchParams(Object.entries(values).filter(([, v]) => v != null && v !== '')).toString()
const option = (value, label, selected) => `<option value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`
const people = node => node.implementers.map(u => esc(u.login ? '@' + u.login : u.name)).join(', ') || 'No implementer'
const SAVED = {
  'milestone-created': () => 'Milestone created.',
  'milestone-saved': () => 'Milestone saved.',
  members: c => {
    const moved = Number(c.moved) || 0
    return `Milestone saved. Added ${Number(c.added) || 0}${moved ? ` (${moved} moved from another milestone)` : ''}, removed ${Number(c.removed) || 0}.`
  },
  'milestone-deleted': () => 'Milestone deleted. Its specs are now unassigned.',
  detached: () => 'Removed from planning. Milestone progress is recalculated.',
  'spec-milestone': () => 'Milestone set for this spec.',
  'implementer-added': () => 'Implementer added.',
  'implementer-removed': () => 'Implementer removed.'
}
const progress = m => m.incomplete ? 'Progress unavailable: some assigned work is no longer visible or eligible.' : `${m.implemented}/${m.total} implemented`
// One row shape for the card's roster and for the edit form's ticking list, so
// the two cannot drift. milestone is the card the row is drawn on; milestoneId
// is the filter the page already has, and Details carries that and nothing
// more, so a reader looking at every card still has every card on the way back.
const memberRow = (n, { checkbox = null, milestone = null, milestoneId = '' } = {}) => {
  const held = n.milestone && (!milestone || n.milestone.id !== milestone.id) ? n.milestone : null
  return `<li>${checkbox || ''}<a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a>${held ? ` <span class="held">(in ${esc(held.title)})</span>` : ''} <span class="badge">${esc(n.status.replaceAll('-', ' '))}</span>${n.ready ? '<span class="badge success">Ready to implement</span>' : ''}${n.superseded ? '<span class="badge warning">Superseded</span>' : ''} <span class="assignees">${people(n)}</span>${n.blockers.length ? `<span class="warn">${n.blockers.map(esc).join('; ')}</span>` : ''} <a href="${query({ ns: n.namespace, milestone: milestoneId, spec: n.id })}#spec-panel">Details</a></li>`
}
const specBox = n => `<input type="checkbox" name="spec" value="${esc(n.id + ':' + (n.version || 0))}"${n.member ? ' checked' : ''} aria-label="${esc(n.label)}">`
// specs, when given, lists the milestone's members and the project's unassigned
// specs as rows, and the specs another milestone holds behind a disclosure;
// each box carries the note's version so a concurrent change is caught, and
// hidden member fields let a save remove what was unticked. Unticking a spec
// held by another milestone does nothing, because the member fields only name
// this milestone's own.
function milestoneForm (m, csrf, namespace, specs = null, milestoneId = '') {
  const choices = Array.isArray(namespace) ? namespace : [namespace]
  const rows = list => `<ul class="members">${list.map(n => memberRow(n, { checkbox: specBox(n), milestone: m, milestoneId })).join('')}</ul>`
  const membership = specs ? `<fieldset><legend>Specs in this milestone</legend>
      ${specs.held.length ? '<p class="meta">Ticking a spec held by another milestone moves it here.</p>' : ''}
      ${specs.list.length ? rows(specs.list) : (specs.held.length || specs.more ? '' : `<p class="meta">${m.state === 'closed' ? 'This milestone is closed. Reopen it to add specs.' : 'No specs available to add.'}</p>`)}
      ${specs.held.length ? `<details><summary>Held by other milestones (${specs.heldCount})</summary>${rows(specs.held)}</details>` : ''}
      ${specs.list.filter(n => n.member).map(n => input('member', n.id + ':' + (n.version || 0))).join('')}
      ${specs.more ? `<p class="meta"><a href="${specs.more}">Add specs on the milestone's page</a>.</p>` : ''}
      ${specs.cut ? `<p class="meta">Showing ${specs.shown} of ${specs.eligible} specs. To add one that is not listed, <a href="${specs.board}">open it from the board</a> and use Assign implementation.</p>` : ''}</fieldset>` : ''
  const project = choices.length > 1
    ? `<label>Project<select name="ns" required>${choices.map(ns => option(ns, ns, m.namespace)).join('')}</select></label>`
    : input('ns', choices[0])
  return `<form method="post" action="/roadmap" class="edit">${input('csrf', csrf)}${input('action', 'save-milestone')}${project}${input('id', m.id)}${input('version', m.version || 0)}
    <label>Title<input name="title" maxlength="160" required value="${esc(m.title || '')}"></label>
    <label>Description<textarea name="description" maxlength="10000" rows="3">${esc(m.description || '')}</textarea></label>
    <label>Due date<input type="date" name="dueDate" value="${esc(m.dueDate || '')}"></label>
    ${m.id ? `<label>State<select name="state">${option('open', 'Open', m.state)}${option('closed', 'Closed', m.state)}</select></label>` : ''}
    <label>Linked spec checkpoint<input name="checkpointTag" placeholder="specs/v1 (optional)" value="${esc(m.checkpointTag || '')}"></label>
    ${membership}
    <button class="primary">${m.id ? 'Save' : 'Create milestone'}</button></form>${m.id
    ? `<form method="post" action="/roadmap" class="delete-milestone" onsubmit="return confirm('Delete this milestone? Its specs stay, unassigned.')">${input('csrf', csrf)}${input('action', 'delete-milestone')}${input('ns', m.namespace)}${input('id', m.id)}${input('version', m.version || 0)}<button class="danger">Delete milestone</button></form>`
    : ''}`
}
function roadmapPage ({ model, namespaces, namespace, milestoneId, csrf, manageable, specId, users = [], userQuery = '', deleted = [], stale = false, milestonePage = 0, saved = '', savedCounts = {} }) {
  const milestone = model.milestones.find(m => m.id === milestoneId)
  const selected = model.nodes.find(n => n.id === specId)
  const milestones = model.milestones.filter(m => !namespace || m.namespace === namespace)
  const listedMilestones = milestones.filter(m => (!milestoneId || milestoneId === m.id) && (!model.filterState || m.state === model.filterState))
  const base = { ns: namespace, milestone: milestoneId, state: model.filterState }
  const deletedWork = deleted.filter(a => manageable.includes(a.namespace) &&
    (!milestoneId || (milestoneId === 'none' ? !a.milestoneId : a.milestoneId === milestoneId)))
  // A page listing many milestones would repeat the namespace's unassigned
  // specs under every card, so past twenty cards each form lists only its
  // members and points at the milestone's own page for adding.
  const roomy = listedMilestones.length <= 20
  const memberList = m => {
    const members = model.nodes.filter(n => n.milestone && n.milestone.id === m.id)
    if (!members.length) return '<p class="meta no-members">No specs in this milestone yet.</p>'
    return `<ul class="members">${members.map(n => memberRow(n, { milestone: m, milestoneId })).join('')}</ul>`
  }
  const membersFor = m => {
    const eligible = model.nodes.filter(n => n.namespace === m.namespace && !n.topLevel)
    const members = eligible.filter(n => n.milestone && n.milestone.id === m.id).map(n => ({ ...n, member: true, label: n.title }))
    const full = roomy || m.id === milestoneId
    const free = full && m.state === 'open' ? eligible.filter(n => !n.superseded && (!n.milestone || n.milestone.id !== m.id)) : []
    const own = [...members, ...free.filter(n => !n.milestone).map(n => ({ ...n, label: n.title }))]
    const taken = free.filter(n => n.milestone).map(n => ({ ...n, label: `${n.title} (in ${n.milestone.title})` }))
    const list = own.slice(0, Math.max(members.length, 100))
    const held = taken.slice(0, 100)
    return { list, held, heldCount: taken.length, shown: list.length + held.length, eligible: eligible.length, cut: list.length < own.length || held.length < taken.length, board: '/?ns=' + encodeURIComponent(m.namespace), more: full || m.state !== 'open' ? '' : query({ ns: m.namespace, milestone: m.id }) }
  }
  const nodeCard = n => `<article class="spec"><h3><a href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></h3>
    <p class="meta"><span>${esc(n.namespace)}</span><span class="badge">${esc(n.status.replaceAll('-', ' '))}</span>${n.superseded ? '<span class="badge warning">Superseded</span>' : ''}${n.ready ? '<span class="badge success">Ready to implement</span>' : ''}</p>
    <p class="assignees">${people(n)}</p>${n.milestone ? `<p><a href="${query({ ns: n.namespace, milestone: n.milestone.id })}">${esc(n.milestone.title)}</a></p>` : ''}
    ${n.dependencies.length ? `<ul class="dependencies">${n.dependencies.map(d => `<li>← ${d.id ? `<a href="${d.state === 'invalid' ? esc(d.url) : query({ ns: d.namespace, spec: d.id })}">${esc(d.title)}</a>` : esc(d.title)} · ${esc(d.state)}${d.id && d.milestoneId !== (n.milestone && n.milestone.id) ? ' · outside milestone' : ''}</li>`).join('')}</ul>` : ''}
    ${n.blockers.length ? `<p class="warn">${n.blockers.map(esc).join('; ')}</p>` : ''}</article>`
  const fields = action => input('csrf', csrf) + input('action', action) + input('ns', selected.namespace) + input('noteId', selected.id) + input('version', selected.version)
  const readOnlyAssignment = () => `<section class="assignment"><h2>Implementation</h2>
    <p>Milestone: ${selected.milestone ? esc(selected.milestone.title) : 'None'}</p>
    <p>Implementers: ${people(selected)}</p>
    <p class="meta">Only project approvers and board admins can change this.</p></section>`
  const assignment = !selected ? '' : !manageable.includes(selected.namespace) ? readOnlyAssignment() : `<section class="assignment"><h2>Assign implementation</h2>
    ${selected.superseded ? (selected.milestone ? `<form method="post" action="/roadmap">${fields('milestone')}${input('milestoneId', '')}<button>Remove from milestone</button></form>` : '') : `<form method="post" action="/roadmap">${fields('milestone')}<label>Milestone<select name="milestoneId">${option('', 'No milestone', selected.milestone ? selected.milestone.id : '')}${model.milestones.filter(m => m.namespace === selected.namespace).map(m => option(m.id, m.title + (m.state === 'closed' ? ' (closed)' : ''), selected.milestone && selected.milestone.id)).join('')}</select></label><button class="primary">Save</button></form>`}
    ${selected.implementers.map(u => `<form method="post" action="/roadmap">${fields('remove-implementer')}${input('userId', u.id)}<span>${esc(u.login ? '@' + u.login : u.name)}</span> <button>Remove implementer</button></form>`).join('')}
    ${!selected.superseded ? `<form method="get" action="/roadmap">${input('ns', selected.namespace)}${input('spec', selected.id)}<label>Find an implementer<input name="userQuery" value="${esc(userQuery)}" minlength="2" maxlength="80" placeholder="Username or display name"></label><button>Find users</button></form>
    ${userQuery && !users.length ? '<p>No matching users. Assignees need an existing editor account.</p>' : ''}
    ${users.filter(u => !selected.implementers.some(a => a.id === u.id)).map(u => `<form method="post" action="/roadmap">${fields('add-implementer')}${input('userId', u.id)}<span>${esc(u.login ? '@' + u.login : u.name)}</span> <button>Add implementer</button></form>`).join('')}` : ''}</section>`
  return `<div class="page-heading"><div><h1>Planning</h1><p class="context">${milestone ? esc(milestone.title) + ' · ' : ''}Plan milestones, assign implementers and work through dependencies.</p></div><div class="meta"><span class="badge">${listedMilestones.length} ${listedMilestones.length === 1 ? 'milestone' : 'milestones'}</span>${manageable.length ? '' : '<p class="meta">Only project approvers and board admins can add or edit milestones.</p>'}</div></div>
  ${SAVED[saved] ? `<p class="notice" role="status">${esc(SAVED[saved](savedCounts))}</p>` : ''}
  ${stale ? '<p class="warn">Spec data is stale. Progress and dependencies may have changed.</p>' : ''}
  <form method="get" action="/roadmap" class="filters">${milestoneId ? input('milestone', milestoneId) : ''}
    ${namespaces.length > 1 ? `<label>Namespace<select name="ns">${option('', 'All namespaces', namespace)}${namespaces.map(ns => option(ns, ns, namespace)).join('')}</select></label>` : ''}
    <label>Show<select name="state">${option('', 'All milestones', model.filterState)}${option('open', 'Open', model.filterState)}${option('closed', 'Closed', model.filterState)}</select></label><button>Apply</button>
  </form>
  ${selected ? `<section class="panel" id="spec-panel">${milestone
    ? `<p><a href="${query({ ns: namespace, milestone: milestoneId })}#milestone-${esc(milestoneId)}">Back to ${esc(milestone.title)}</a></p>`
    : `<p><a href="${query({ ns: namespace })}">Close</a></p>`}<h2>Spec details</h2>${nodeCard(selected)}${assignment}</section>` : ''}
  ${deletedWork.length ? `<section class="panel"><h2>Deleted specs</h2><p>These notes have been deleted. Remove their assignments to restore milestone progress; planning history is retained.</p>
    ${deletedWork.map(a => `<form method="post" action="/roadmap">${input('csrf', csrf)}${input('action', 'detach-deleted')}${input('ns', a.namespace)}${input('noteId', a.noteId)}${input('version', a.version)}<span>Deleted spec ${esc(a.noteId)} · ${esc(a.namespace)}</span><button>Remove from planning</button></form>`).join('')}</section>` : ''}
  <div class="section-heading"><h2>Milestones</h2></div>
  ${!listedMilestones.length ? '<div class="empty-state"><h3>No milestones in this selection</h3><p>Milestones group specifications into a shared implementation goal.</p></div>' : ''}
  <div class="milestones">${listedMilestones.slice(milestonePage * 100, (milestonePage + 1) * 100).map(m => `<article class="milestone" id="milestone-${esc(m.id)}"><h2><a href="${query({ ns: m.namespace, milestone: m.id })}">${esc(m.title)}</a></h2><p class="meta"><span>${esc(m.namespace)}</span><span class="badge">${esc(m.state)}</span>${m.dueDate ? `<span>Due ${esc(m.dueDate)}</span>` : ''}${m.overdue ? '<span class="badge warning">Overdue</span>' : ''}</p><p class="description">${esc(m.description)}</p><p class="progress-label">${progress(m)}</p>${m.percent != null ? `<progress value="${m.percent}" max="100" aria-label="Implementation progress">${m.percent}%</progress>` : ''}
    ${m.checkpointTag ? `<p class="meta"><span>Linked spec checkpoint: <a href="https://github.com/${esc(m.namespace)}/tree/${esc(m.checkpointCommit)}">${esc(m.checkpointTag)}</a></span></p>` : ''}
    ${memberList(m)}
    <p class="meta"><a href="/?milestone=${esc(m.id)}">See these on the board</a></p>
    ${manageable.includes(m.namespace) ? `<details><summary>Edit milestone</summary>${milestoneForm(m, csrf, m.namespace, membersFor(m), milestoneId)}</details>` : ''}</article>`).join('')}</div>
  <nav class="pagination" aria-label="Milestone pages">${milestonePage > 0 ? `<a href="${query({ ...base, milestonePage: milestonePage - 1 })}">Previous milestones</a> ` : ''}${(milestonePage + 1) * 100 < listedMilestones.length ? `<a href="${query({ ...base, milestonePage: milestonePage + 1 })}">More milestones</a>` : ''}</nav>
  ${!milestoneId && manageable.length ? `<details class="disclosure"><summary>Create a milestone</summary>${milestoneForm({ namespace }, csrf, manageable)}</details>` : ''}`
}
module.exports = { roadmapPage, query }
