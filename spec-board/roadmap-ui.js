const { esc } = require('./prosediff')
const input = (name, value) => `<input type="hidden" name="${name}" value="${esc(value == null ? '' : value)}">`
const query = values => { const search = new URLSearchParams(Object.entries(values).filter(([, v]) => v != null && v !== '')).toString(); return '/roadmap' + (search ? '?' + search : '') }
const option = (value, label, selected, disabled = false) => `<option${disabled ? ' disabled' : ''} value="${esc(value)}"${String(value) === String(selected) ? ' selected' : ''}>${esc(label)}</option>`
const personName = u => u.login ? '@' + u.login : u.name
const people = node => node.implementers.map(u => esc(personName(u))).join(', ') || 'No implementer'
const relTime = at => {
  if (!at) return ''
  const sec = Math.floor((Date.now() - new Date(at).getTime()) / 1000)
  for (const [s, u] of [[86400, 'd'], [3600, 'h'], [60, 'm']]) if (sec >= s) return `${Math.floor(sec / s)}${u} ago`
  return 'just now'
}
// The board, the spec library and the planning page read one snapshot, so one
// sentence describes it, with the age that decides how much of the page to
// trust. `at` is the snapshot's poll time, 0 before the first poll lands.
const staleNotice = at => `<div class="warn" role="status">Updates are delayed. Review and pull request information may be out of date. ${at ? 'Last updated ' + esc(relTime(at)) + '.' : 'No update has landed yet.'}</div>`
// The board card and the spec panel save the same relation, so one sentence
// answers the save wherever it was made. Plain text; the caller escapes.
const milestoneNotice = spec => `${spec.title} ${spec.milestone ? 'is now in ' + spec.milestone.title : 'has no milestone'}.`
const SAVED = {
  'milestone-created': () => 'Milestone created.',
  'milestone-saved': () => 'Milestone saved.',
  members: c => {
    const moved = Number(c.moved) || 0
    return `Milestone saved. Added ${Number(c.added) || 0}${moved ? ` (${moved} moved from another milestone)` : ''}, removed ${Number(c.removed) || 0}.`
  },
  'milestone-deleted': () => 'Milestone deleted. Its specs are now unassigned.',
  detached: () => 'Removed from planning. Milestone progress is recalculated.',
  'spec-milestone': (counts, spec) => spec ? milestoneNotice(spec) : '',
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
      ${specs.cut ? `<p class="meta">Showing ${specs.shown} of ${specs.eligible} specs. To add one that is not listed, <a href="${specs.board}">open it from the board</a> and set its milestone from the card menu.</p>` : ''}</fieldset>` : ''
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
    ? `<form method="post" action="/roadmap" class="delete-milestone">${input('csrf', csrf)}${input('action', 'delete-milestone')}${input('ns', m.namespace)}${input('id', m.id)}${input('version', m.version || 0)}<details class="danger-zone"><summary>Delete this milestone</summary><p class="meta">Its specs stay, unassigned. This cannot be undone.</p><button class="danger">Delete permanently</button></details></form>`
    : ''}`
}
function roadmapPage ({ model, namespaces, namespace, milestoneId, csrf, manageable, specId, users = [], userQuery = '', deleted = [], stale = false, staleAt = 0, milestonePage = 0, saved = '', savedCounts = {}, boardLink = '' }) {
  const milestone = model.milestones.find(m => m.id === milestoneId)
  const selected = model.nodes.find(n => n.id === specId)
  const milestones = model.milestones.filter(m => !namespace || m.namespace === namespace)
  const listedMilestones = milestones.filter(m => (!milestoneId || milestoneId === m.id) && (!model.filterState || m.state === model.filterState))
  const base = { ns: namespace, milestone: milestoneId, state: model.filterState }
  const pageLinks = (milestonePage > 0 ? `<a href="${query({ ...base, milestonePage: milestonePage - 1 })}">Previous milestones</a> ` : '') +
    ((milestonePage + 1) * 100 < listedMilestones.length ? `<a href="${query({ ...base, milestonePage: milestonePage + 1 })}">More milestones</a>` : '')
  const deletedWork = deleted.filter(a => manageable.includes(a.namespace) &&
    (!milestoneId || (milestoneId === 'none' ? !a.milestoneId : a.milestoneId === milestoneId)))
  // A page listing many milestones would repeat the namespace's unassigned
  // specs under every card, so past twenty cards each form lists only its
  // members and points at the milestone's own page for adding.
  const roomy = listedMilestones.length <= 20
  const narrowed = !!milestoneId || !!model.filterState
  // The create form is bound to a namespace the viewer manages, so it belongs
  // on the page only while the viewed project is one of them. With no project
  // chosen the form's own Project select picks between them.
  const canCreate = namespace ? manageable.includes(namespace) : !!manageable.length
  const offerCreate = !listedMilestones.length && !narrowed && canCreate
  const whatAMilestoneIs = '<p>Milestones group specifications into a shared implementation goal.</p>'
  const emptyHeading = `<h3>No milestones ${namespace ? 'in ' + esc(namespace) + ' ' : ''}yet</h3>`
  const elsewhere = manageable.filter(ns => ns !== namespace)
  // An unnarrowed empty page has three causes: a project the viewer manages,
  // where the create form below opens itself; a project they do not manage
  // while they manage another, which the empty state has to name because the
  // page heading's cause only renders for a viewer who manages none; and
  // managing none, where that heading carries the cause already. In the middle
  // case the projects the viewer manages are the only place a milestone of
  // theirs can go, so the sentence links to them.
  const emptyState = narrowed
    ? `<div class="empty-state"><h3>No milestones match this filter</h3>${whatAMilestoneIs}<p><a href="${query({ ns: namespace })}">Show all milestones</a></p></div>`
    : offerCreate
      ? `<div class="empty-state">${emptyHeading}${whatAMilestoneIs}</div>`
      : manageable.length
        ? `<div class="empty-state">${emptyHeading}${whatAMilestoneIs}<p>Only ${esc(namespace)} approvers and board admins can add or edit milestones.${elsewhere.length ? ` You can add one in ${elsewhere.map(ns => `<a href="${query({ ns })}">${esc(ns)}</a>`).join(', ')}.` : ''}</p></div>`
        : `<div class="empty-state">${whatAMilestoneIs}</div>`
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
  const readOnlyAssignment = () => `<section class="assignment"><h2>Implementation plan</h2>
    <p>Milestone: ${selected.milestone ? esc(selected.milestone.title) : 'None'}</p>
    <p>Implementers: ${people(selected)}</p>
    <p class="meta">Only project approvers and board admins can change this.</p></section>`
  const removeMilestone = () => `<form method="post" action="/roadmap">${fields('milestone')}${input('milestoneId', '')}<button class="danger">Remove from milestone</button></form>`
  // A closed milestone is refused as a post target (roadmap-store.js
  // saveAssignment), and an omitted milestoneId reads as "no milestone", so a
  // spec that holds a closed milestone has no option standing for what it
  // already is. Its holding is stated as text, and the select carries the open
  // milestones only, so every post the panel can make is one the store takes.
  const closedHold = selected && selected.milestone && selected.milestone.state === 'closed' ? selected.milestone : null
  const milestoneControl = () => {
    if (selected.superseded) return selected.milestone ? removeMilestone() : ''
    if (!closedHold) return `<form method="post" action="/roadmap">${fields('milestone')}<label>Milestone<select name="milestoneId">${option('', 'No milestone', selected.milestone ? selected.milestone.id : '')}${model.milestones.filter(m => m.namespace === selected.namespace).map(m => option(m.id, m.title + (m.state === 'closed' ? ' (closed)' : ''), selected.milestone && selected.milestone.id, m.state === 'closed')).join('')}</select></label><button class="primary">Set milestone</button></form>`
    const open = model.milestones.filter(m => m.namespace === selected.namespace && m.state === 'open')
    return `<p>Milestone: ${esc(closedHold.title)} (closed). <a href="${query({ ns: selected.namespace, milestone: closedHold.id })}#milestone-${esc(closedHold.id)}">Reopen it on planning</a> to assign more work to it.</p>
    ${open.length ? `<form method="post" action="/roadmap">${fields('milestone')}<label>Move to another milestone<select name="milestoneId">${open.map(m => option(m.id, m.title, '')).join('')}</select></label><button class="primary">Set milestone</button></form>` : ''}
    ${removeMilestone()}`
  }
  const assignment = !selected ? '' : !manageable.includes(selected.namespace) ? readOnlyAssignment() : `<section class="assignment"><h2>Implementation plan</h2>
    ${milestoneControl()}
    ${selected.implementers.map(u => `<form method="post" action="/roadmap">${fields('remove-implementer')}${input('userId', u.id)}${input('userLabel', personName(u))}<span>${esc(personName(u))}</span> <button class="danger">Remove implementer</button></form>`).join('')}
    ${!selected.superseded ? `<div class="implementer-picker" data-implementer-picker>
    <form method="get" action="/roadmap" class="implementer-search">${input('ns', selected.namespace)}${input('spec', selected.id)}<div class="implementer-control"><label for="implementer-query">Find an implementer</label><input id="implementer-query" name="userQuery" value="${esc(userQuery)}" minlength="2" maxlength="80" autocomplete="off" placeholder="Username or display name"></div><button data-find-users>Find users</button></form>
    <form method="post" action="/roadmap" class="implementer-add" hidden>${fields('add-implementer')}${input('userId', '')}${input('userLabel', '')}<button class="primary" disabled>Add implementer</button></form>
    <div class="implementer-fallback">
    ${userQuery && !users.length ? '<p>No matching users. Assignees need an existing editor account.</p>' : ''}
    ${users.filter(u => !selected.implementers.some(a => a.id === u.id)).map(u => `<form method="post" action="/roadmap">${fields('add-implementer')}${input('userId', u.id)}${input('userLabel', personName(u))}<span>${esc(personName(u))}</span> <button>Add implementer</button></form>`).join('')}</div></div>` : ''}</section>`
  const savedText = SAVED[saved] ? SAVED[saved](savedCounts, selected) : ''
  return `<div class="page-heading"><div><h1>Planning</h1><p class="context">${milestone ? esc(milestone.title) + ' · ' : ''}Plan milestones, assign implementers and work through dependencies.</p></div><div class="meta"><span class="badge">${listedMilestones.length} ${listedMilestones.length === 1 ? 'milestone' : 'milestones'}</span>${manageable.length ? '' : '<p class="meta">Only project approvers and board admins can add or edit milestones.</p>'}</div></div>
  ${savedText ? `<p class="notice" role="status">${esc(savedText)}</p>` : ''}
  ${stale ? staleNotice(staleAt) : ''}
  <form method="get" action="/roadmap" class="filters" data-autosubmit>${milestoneId ? input('milestone', milestoneId) : ''}
    ${namespaces.length > 1 ? `<label>Project<select name="ns">${option('', 'All projects', namespace)}${namespaces.map(ns => option(ns, ns, namespace)).join('')}</select></label>` : ''}
    <label>Show<select name="state">${option('', 'All milestones', model.filterState)}${option('open', 'Open', model.filterState)}${option('closed', 'Closed', model.filterState)}</select></label><button data-apply>Show these milestones</button>
  </form>
  ${selected ? `<section class="panel" id="spec-panel">${boardLink
    ? `<p><a href="${esc(boardLink)}">Back to the board</a></p>`
    : milestone
      ? `<p><a href="${query({ ns: namespace, milestone: milestoneId })}#milestone-${esc(milestoneId)}">Back to ${esc(milestone.title)}</a></p>`
      : `<p><a href="${query({ ns: namespace })}">Close</a></p>`}<h2>Spec details</h2>${nodeCard(selected)}${assignment}</section>` : ''}
  ${deletedWork.length ? `<section class="panel"><h2>Deleted specs</h2><p>These notes have been deleted. Remove their assignments to restore milestone progress; planning history is retained.</p>
    ${deletedWork.map(a => `<form method="post" action="/roadmap">${input('csrf', csrf)}${input('action', 'detach-deleted')}${input('ns', a.namespace)}${input('noteId', a.noteId)}${input('version', a.version)}<span>Deleted spec ${esc(a.noteId)} · ${esc(a.namespace)}</span><button class="danger">Remove from planning</button></form>`).join('')}</section>` : ''}
  <div class="section-heading"><h2>Milestones</h2></div>
  ${!listedMilestones.length ? emptyState : ''}
  <div class="milestones">${listedMilestones.slice(milestonePage * 100, (milestonePage + 1) * 100).map(m => `<article class="milestone" id="milestone-${esc(m.id)}"><h2><a href="${query({ ns: m.namespace, milestone: m.id })}">${esc(m.title)}</a></h2><p class="meta"><span>${esc(m.namespace)}</span><span class="badge">${esc(m.state)}</span>${m.dueDate ? `<span>Due ${esc(m.dueDate)}</span>` : ''}${m.overdue ? '<span class="badge warning">Overdue</span>' : ''}</p><p class="description">${esc(m.description)}</p><p class="progress-label">${progress(m)}</p>${m.percent != null ? `<progress value="${m.percent}" max="100" aria-label="Implementation progress">${m.percent}%</progress>` : ''}
    ${m.checkpointTag ? `<p class="meta"><span>Linked spec checkpoint: <a href="https://github.com/${esc(m.namespace)}/tree/${esc(m.checkpointCommit)}">${esc(m.checkpointTag)}</a></span></p>` : ''}
    ${memberList(m)}
    <p class="meta"><a href="/?milestone=${esc(m.id)}">See these on the board</a></p>
    ${manageable.includes(m.namespace) ? `<details><summary>Edit milestone</summary>${milestoneForm(m, csrf, m.namespace, membersFor(m), milestoneId)}</details>` : ''}</article>`).join('')}</div>
  ${pageLinks ? `<nav class="pagination" aria-label="Milestone pages">${pageLinks}</nav>` : ''}
  ${!milestoneId && canCreate ? `<details class="disclosure"${offerCreate ? ' open' : ''} id="create-milestone"><summary>Create a milestone</summary>${milestoneForm({ namespace }, csrf, manageable)}</details>` : ''}`
}
module.exports = { roadmapPage, query, milestoneNotice, staleNotice, relTime, personName }
