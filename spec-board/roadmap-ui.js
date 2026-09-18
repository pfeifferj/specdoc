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
    <button>${m.id ? 'Save milestone' : 'Create milestone'}</button></form>`
}
function roadmapPage ({ model, nodes, namespaces, namespace, milestoneId, implementer, who, csrf, manageable, specId, users = [], userQuery = '', stale = false, loginEnabled = true, page = 0, hasMore = false, milestonePage = 0 }) {
  const milestone = model.milestones.find(m => m.id === milestoneId)
  const selected = model.nodes.find(n => n.id === specId)
  const milestones = model.milestones.filter(m => !namespace || m.namespace === namespace)
  const listedMilestones = milestones.filter(m => (!milestoneId || milestoneId === m.id) && (!model.filterState || m.state === model.filterState))
  const base = { ns: namespace, milestone: milestoneId, implementer, state: model.filterState }
  const nodeCard = n => `<article class="spec"><h3><a href="${esc(n.url)}">${esc(n.title)}</a></h3>
    <p>${esc(n.namespace)} · ${esc(n.status)}${n.superseded ? ' · Superseded' : ''}${n.ready ? ' · Ready to implement' : ''}</p>
    <p>${people(n)}</p>${n.milestone ? `<p><a href="${query({ ns: n.namespace, milestone: n.milestone.id })}">${esc(n.milestone.title)}</a></p>` : ''}
    ${n.dependencies.length ? `<ul class="dependencies">${n.dependencies.map(d => `<li>← ${d.id ? `<a href="${d.state === 'invalid' ? esc(d.url) : query({ ns: d.namespace, spec: d.id })}">${esc(d.title)}</a>` : esc(d.title)} · ${esc(d.state)}${d.id && d.milestoneId !== (n.milestone && n.milestone.id) ? ' · outside milestone' : ''}</li>`).join('')}</ul>` : ''}
    ${n.blockers.length ? `<p class="warn">${n.blockers.map(esc).join('; ')}</p>` : ''}
    <a href="${query({ ns: n.namespace, spec: n.id })}">Assignments and details</a></article>`
  const fields = action => input('csrf', csrf) + input('action', action) + input('ns', selected.namespace) + input('noteId', selected.id) + input('version', selected.version)
  const assignment = selected && manageable.includes(selected.namespace) ? `<section><h2>Assign implementation</h2>
    ${selected.superseded ? (selected.milestone ? `<form method="post" action="/roadmap">${fields('milestone')}${input('milestoneId', '')}<button>Remove from milestone</button></form>` : '') : `<form method="post" action="/roadmap">${fields('milestone')}<label>Milestone<select name="milestoneId">${option('', 'No milestone', selected.milestone ? selected.milestone.id : '')}${model.milestones.filter(m => m.namespace === selected.namespace && (m.state === 'open' || (selected.milestone && selected.milestone.id === m.id))).map(m => option(m.id, m.title + (m.state === 'closed' ? ' (closed)' : ''), selected.milestone && selected.milestone.id)).join('')}</select></label><button>Save assignment</button></form>`}
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
  return `<style>
    body { max-width: 1280px; margin: auto; } header, .filters { display:flex; flex-wrap:wrap; gap:1rem; align-items:center; }
    header { justify-content:space-between; } section { margin:1.5rem 0; } .filters label, .edit label { display:block; }
    input, select, textarea { font:inherit; padding:.4rem; max-width:100%; box-sizing:border-box; } .edit input, .edit textarea { display:block; width:100%; }
    .edit { max-width:38rem; } form { margin:.6rem 0; } .edit label { margin:.6rem 0; }
    .milestones { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr)); gap:1rem; }
    .milestone, .spec { border:1px solid #8886; border-radius:6px; padding:1rem; overflow-wrap:anywhere; }
    .milestone h2, .spec h3 { margin:0; } .description { white-space:pre-wrap; } .warn { color:light-dark(#8a3300,#ffbf87); }
    .waves { display:flex; gap:1rem; overflow-x:auto; padding-bottom:1rem; } .wave { flex:0 0 290px; max-width:85vw; }
    .wave .spec { margin-bottom:.7rem; } .dependencies { padding-left:1rem; } progress { width:100%; }
    @media(max-width:600px) { body { padding:14px; } .filters { align-items:stretch; } .filters label { width:100%; } }
  </style>
  <header><h1>Roadmap${milestone ? ' · ' + esc(milestone.title) : ''}</h1><nav><a href="/">Board</a> · <a href="/map">Map</a> · <a href="/checkpoints${namespace ? '?ns=' + encodeURIComponent(namespace) : ''}">Checkpoints</a>${!who && loginEnabled ? ' · <a href="/roadmap?login=1">Sign in to manage</a>' : who ? ` · ${esc(who.login)}` : ''}</nav></header>
  ${stale ? '<p class="warn">Spec data is stale. Progress and dependencies may have changed.</p>' : ''}
  <form method="get" action="/roadmap" class="filters">
    <label>Namespace<select name="ns">${option('', 'All namespaces', namespace)}${namespaces.map(ns => option(ns, ns, namespace)).join('')}</select></label>
    <label>Milestone<select name="milestone">${option('', 'All milestones', milestoneId)}${option('none', 'No milestone', milestoneId)}${milestones.map(m => option(m.id, m.title + ' (' + m.state + ')', milestoneId)).join('')}</select></label>
    <label>Implementer<select name="implementer">${option('', 'Anyone', implementer)}${who ? option('me', 'Assigned to me', implementer) : ''}${option('none', 'No implementer', implementer)}${[...new Map(model.nodes.flatMap(n => n.implementers).map(u => [u.id, u])).values()].map(u => option(u.id, u.login ? '@' + u.login : u.name, implementer)).join('')}</select></label>
    <label>Milestone state<select name="state">${option('', 'All', model.filterState)}${option('open', 'Open', model.filterState)}${option('closed', 'Closed', model.filterState)}</select></label><button>Filter</button>
  </form>
  ${selected ? `<section><h2>Spec details</h2>${nodeCard(selected)}${assignment}</section>` : ''}
  <div class="milestones">${listedMilestones.slice(milestonePage * 100, (milestonePage + 1) * 100).map(m => `<article class="milestone"><h2><a href="${query({ ns: m.namespace, milestone: m.id })}">${esc(m.title)}</a></h2><p>${esc(m.namespace)} · ${esc(m.state)}${m.dueDate ? ` · Due ${esc(m.dueDate)}` : ''}${m.overdue ? ' · <strong class="warn">Overdue</strong>' : ''}</p><p class="description">${esc(m.description)}</p><p>${progress(m)}</p>${m.percent != null ? `<progress value="${m.percent}" max="100" aria-label="Implementation progress">${m.percent}%</progress>` : ''}
    ${m.checkpointTag ? `<p>Linked spec checkpoint: <a href="https://github.com/${esc(m.namespace)}/tree/${esc(m.checkpointCommit)}">${esc(m.checkpointTag)}</a>. Covers the namespace's specs, not implementation completion.</p>` : ''}
    ${manageable.includes(m.namespace) ? `<details><summary>Edit milestone</summary>${milestoneForm(m, csrf, m.namespace)}</details>${m.state === 'open' && m.id === milestoneId ? `<details><summary>Add specs</summary>${model.nodes.filter(n => n.namespace === m.namespace && !n.superseded && !n.milestone).slice(0, 100).map(n => `<form method="post" action="/roadmap">${input('csrf', csrf)}${input('action', 'milestone')}${input('ns', m.namespace)}${input('noteId', n.id)}${input('version', n.version)}${input('milestoneId', m.id)}<span>${esc(n.title)}</span> <button>Add to milestone</button></form>`).join('') || '<p>No unassigned specs.</p>'}<p><a href="${query({ ns: m.namespace, milestone: 'none' })}">Browse all unassigned specs</a>. To move work from another milestone, use its spec assignment controls.</p></details>` : ''}` : ''}</article>`).join('')}</div>
  ${milestonePage > 0 ? `<a href="${query({ ...base, page, milestonePage: milestonePage - 1 })}">Previous milestones</a> ` : ''}${(milestonePage + 1) * 100 < listedMilestones.length ? `<a href="${query({ ...base, page, milestonePage: milestonePage + 1 })}">More milestones</a>` : ''}
  ${!milestoneId && manageable.length ? `<details><summary>Create a milestone</summary>${manageable.map(ns => `<h2>${esc(ns)}</h2>${milestoneForm({}, csrf, ns)}`).join('')}</details>` : ''}
  <section><h2>Dependency order</h2><p>Read steps from left to right. Work in a step may proceed in parallel once approved and its prerequisites are implemented. These are dependency steps, not scheduled dates. Links show prerequisites outside this selection.</p>
    <div class="waves">${[...byWave].sort((a, b) => stageOrder(a[0]) - stageOrder(b[0])).map(([key, rows]) => `<section class="wave"><h2>${esc(key)}</h2>${rows.map(nodeCard).join('')}</section>`).join('') || '<p>No specs match these filters.</p>'}</div>
    ${page > 0 ? `<a href="${query({ ...base, milestonePage, page: page - 1 })}">Previous specs</a> ` : ''}${hasMore ? `<a href="${query({ ...base, milestonePage, page: page + 1 })}">More specs</a>` : ''}</section>`
}
module.exports = { roadmapPage, query }
