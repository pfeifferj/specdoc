const { fail, positiveId, version, milestoneInput, roadmap, decorateSpecs, filterSpecs } = require('./roadmap')
const { roadmapPage, query, personName } = require('./roadmap-ui')
const { canManageFeedback } = require('./feedback')
const { esc } = require('./prosediff')

const KNOWN_SAVED = new Set(['milestone-created', 'milestone-saved', 'members', 'milestone-deleted', 'detached', 'spec-milestone', 'implementer-added', 'implementer-removed'])
// Actions a refusal page can offer to post again: a version race re-posts the
// same fields on top of the current version, a 403 re-posts them with a fresh
// token, a 400 re-opens the milestone fields for correction. A refusal the
// same post would hit again offers nothing.
const RETRY_ACTIONS = new Set(['save-milestone', 'milestone', 'add-implementer', 'remove-implementer'])
// The two actions whose post names a person and leaves the milestone alone.
const IMPLEMENTER_ACTIONS = new Set(['add-implementer', 'remove-implementer'])
// The three actions whose post names a spec and carries its plan.
const ASSIGNMENT_ACTIONS = new Set(['milestone', ...IMPLEMENTER_ACTIONS])
const MILESTONE_FIELDS = [['title', 'Title'], ['description', 'Description'], ['dueDate', 'Due date'], ['state', 'State'], ['checkpointTag', 'Linked spec checkpoint']]
const MILESTONE_NAMES = new Set(MILESTONE_FIELDS.map(([name]) => name))
const LABELS = new Map([...MILESTONE_FIELDS, ['ns', 'Project'], ['id', 'Milestone'], ['noteId', 'Spec'], ['milestoneId', 'Milestone'], ['userId', 'User'], ['spec', 'Spec ticked'], ['member', 'Current member']])
// Fields whose value is a note id, or a note id and a version.
const NOTE_FIELDS = new Set(['noteId', 'spec', 'member'])
// Every field the reader picked by name and the form carries as an id. A
// milestone save names its milestone in `id`, an assignment in `milestoneId`.
const ID_FIELDS = new Set([...NOTE_FIELDS, 'milestoneId', 'id'])
// A refusal the same post would hit again whatever the stored version does.
// Both retry forms and the closed-milestone reason stand aside for it, so the
// page states the cause the reader has to clear first.
const durable = (status, message) => Object.assign(fail(status, message), { durable: true })
const hidden = (name, value) => `<input type="hidden" name="${esc(name)}" value="${esc(value == null ? '' : value)}">`
const count = raw => Math.min(999, Math.max(0, Math.trunc(Number(raw)) || 0))
// The board's own view, rebuilt from the query string the card form carried.
// Only the keys the board reads survive, so a crafted form cannot aim the
// redirect anywhere but the board. These four are all of what render() puts in
// nextQuery: stage, person, chips, layout and implemented are browser state
// board.js restores on the next load, so the return address never carries them.
const CARRIED = ['ns', 'q', 'milestone', 'implementer']
function boardQuery (nextQuery) {
  const carried = new URLSearchParams(String(nextQuery || '').slice(0, 500))
  const out = new URLSearchParams()
  for (const key of CARRIED) {
    const value = carried.get(key)
    if (value) out.set(key, value.slice(0, 200))
  }
  return out
}
// The board as the card form left it. A refusal saved nothing, so the link
// back carries no saved code and no spec.
const boardLink = nextQuery => {
  const carried = boardQuery(nextQuery).toString()
  return carried ? '/?' + carried : '/'
}
function boardReturn (nextQuery, namespace, noteId, saved) {
  const out = boardQuery(nextQuery)
  // An all-namespaces board comes back all-namespaces: pinning the return to
  // the spec's namespace would add a filter the reader never set.
  if (out.get('ns')) out.set('ns', namespace)
  out.set('saved', saved)
  out.set('spec', noteId)
  return '/?' + out.toString() + '#spec-' + encodeURIComponent(noteId)
}
function editable (name, label, value) {
  const v = esc(value == null ? '' : value)
  const field = name === 'description' ? `<textarea name="description" maxlength="10000" rows="3">${v}</textarea>`
    : name === 'dueDate' ? `<input type="date" name="dueDate" value="${v}">`
      : name === 'state' ? `<select name="state"><option value="open"${value === 'closed' ? '' : ' selected'}>Open</option><option value="closed"${value === 'closed' ? ' selected' : ''}>Closed</option></select>`
        : `<input name="${name}"${name === 'title' ? ' maxlength="160"' : ''} value="${v}">`
  return `<label>${label}${field}</label>`
}
// A session that expired with the form open cannot be given a form back: the
// CSRF token belongs to a login that no longer exists. Show what was typed so
// it survives the sign-in in the header.
const unsavedChanges = (submitted, titles) => {
  const action = submitted.get('action') || ''
  // Clearing a spec's milestone posts milestoneId empty, and that emptiness is
  // the change, so the row stays and reads in the words appliedBlock uses.
  const keep = (name, value) => !!value || (name === 'milestoneId' && ASSIGNMENT_ACTIONS.has(action))
  const rows = [...submitted.entries()].filter(([name, value]) => keep(name, value) && !['csrf', 'action', 'version', 'next', 'nextQuery'].includes(name))
  const shown = (name, value) => name === 'milestoneId' && !value ? 'No milestone' : ID_FIELDS.has(name) ? titles.get(value.split(':')[0]) || value.split(':')[0] : value
  return rows.length ? `<h2>Your unsaved changes</h2>${rows.map(([name, value]) => `<p>${esc(LABELS.get(name) || name)}: ${esc(shown(name, value))}</p>`).join('')}` : ''
}

function createRoadmapService (deps) {
  // live: the write path re-reads the roles before it acts. A render reads the
  // cache and falls back to a live fetch on a miss, so a project the poller
  // has never seen (one that holds no specs yet) still resolves. cacheOnly
  // drops that fallback and is the board's choice alone: a page of cards never
  // blocks on GitHub, so a cold project's card offers no select and says the
  // approver list is unavailable, while the planning page one click away
  // still offers one.
  const allowed = async (who, ns, live = false, cacheOnly = false) => !!who && (deps.isAdmin(who) || canManageFeedback(who, await deps.roles(ns, live, cacheOnly)))
  async function manageable (who, namespace = '', cacheOnly = false) {
    const out = []
    if (who) for (const ns of deps.namespaces.filter(n => !namespace || n === namespace)) if (await allowed(who, ns, false, cacheOnly)) out.push(ns)
    return out
  }
  async function data (namespace = '', noteIds = null) {
    const namespaces = namespace ? [namespace] : deps.namespaces
    const all = await deps.store.read({ namespaces, noteIds })
    return { milestones: all.milestones.filter(m => namespaces.includes(m.namespace)),
      assignments: all.assignments.filter(a => namespaces.includes(a.namespace)) }
  }
  async function decorate (specs) { return decorateSpecs(specs, await data('', specs.map(s => s.id))) }
  // The row the retry must build on: the milestone row for a milestone save,
  // the note's planning row for an assignment, version 0 when it has never
  // been saved. Null means the row is gone and there is nothing to retry onto.
  async function currentRow (action, namespace, submitted) {
    if (action === 'save-milestone') return await deps.store.getMilestone(submitted.get('id'), namespace) || null
    const noteId = submitted.get('noteId') || ''
    return (await data(namespace, [noteId])).assignments.find(a => a.noteId === noteId) || { version: 0 }
  }
  // The spec and member pairs carry a version each, and a membership save that
  // failed part way has already bumped some of them, so the retry has to send
  // what the store holds now rather than what the failed post sent.
  async function refreshedFields (namespace, submitted) {
    const fields = [...submitted.entries()].filter(([name]) => name !== 'version' && name !== 'csrf')
    const noteIds = fields.filter(([name]) => name === 'spec' || name === 'member').map(([, value]) => value.split(':')[0])
    if (!noteIds.length) return { fields, moved: false }
    const rows = (await data(namespace, [...new Set(noteIds)])).assignments
    let moved = false
    const refreshed = fields.map(([name, value]) => {
      if (name !== 'spec' && name !== 'member') return [name, value]
      const noteId = value.split(':')[0]
      const row = rows.find(a => a.noteId === noteId)
      const current = `${noteId}:${row ? row.version : 0}`
      if (current !== value) moved = true
      return [name, current]
    })
    return { fields: refreshed, moved }
  }
  // Returns the form and whether the refusal it answers is a version race. A
  // half-landed save has already bumped the milestone row itself, so there the
  // race is the one on the spec rows.
  async function retryForm (e, namespace, submitted, who, committed) {
    const none = { html: '', raced: false }
    const action = submitted && who && e.status === 409 && !e.durable ? submitted.get('action') || '' : ''
    if (!RETRY_ACTIONS.has(action) || (action === 'save-milestone' && !submitted.get('id'))) return none
    let row = null
    let refreshed = null
    try {
      row = await currentRow(action, namespace, submitted)
      refreshed = await refreshedFields(namespace, submitted)
    } catch { return none }
    if (!row) return none
    const { fields, moved } = refreshed
    // The other side of the race, worth showing only while none of this post
    // has landed; once the fields are saved the stored row is this post's own.
    const theirs = committed || action !== 'save-milestone' ? '' : MILESTONE_FIELDS
      .map(([name, label]) => [label, String(row[name] == null ? '' : row[name]), submitted.get(name) || ''])
      .filter(([, stored, sent]) => stored !== sent)
      .map(([label, stored, sent]) => `<p>${label}: theirs ${esc(stored)}, yours ${esc(sent)}</p>`).join('')
    const raced = committed ? moved : row.version !== version(submitted.get('version'))
    // A refusal the same post cannot clear gets no button: the reader has to
    // change something first, and the reason above says what.
    return { raced,
      html: !raced ? '' : `${theirs ? `<h2>What changed while you were editing</h2>${theirs}` : ''}<form method="post" action="/roadmap">
      ${fields.map(([name, value]) => hidden(name, value)).join('')}${hidden('csrf', deps.csrfToken(who.login))}${hidden('version', row.version)}
      <button class="primary">Apply my changes on top</button></form>` }
  }
  // A 400 or a 403 is not a version race, so the retry carries the submitted
  // version unchanged and offers the milestone fields for correction in place.
  // Only a milestone save reopens anything: an assignment post carries nothing
  // the reader can edit here, so a 400 on one would refuse the identical post
  // again. The 403 that gets a button is the expired session, which a fresh
  // token clears; the permission refusal is durable and gets none.
  function resubmitForm (e, submitted, who) {
    const action = submitted && who && !e.durable && (e.status === 400 || e.status === 403) ? submitted.get('action') || '' : ''
    if (!RETRY_ACTIONS.has(action)) return ''
    const editing = action === 'save-milestone'
    if (e.status === 400 && !editing) return ''
    const fields = [...submitted.entries()].filter(([name]) => name !== 'csrf' && name !== 'version' && !(editing && MILESTONE_NAMES.has(name)))
    return `<form method="post" action="/roadmap">
      ${fields.map(([name, value]) => hidden(name, value)).join('')}${hidden('csrf', deps.csrfToken(who.login))}${hidden('version', submitted.get('version'))}
      ${editing ? MILESTONE_FIELDS.map(([name, label]) => editable(name, label, submitted.get(name))).join('') : ''}
      <button class="primary">Save again</button></form>`
  }
  // A note id tells a signed-out reader nothing, so the unsaved list names the
  // specs the post carried. The snapshot is where the page itself gets titles;
  // if it cannot be read the id stands.
  async function specTitles (submitted) {
    const ids = new Set([...submitted.entries()].filter(([name]) => NOTE_FIELDS.has(name)).map(([, value]) => value.split(':')[0]))
    if (!ids.size) return new Map()
    try {
      const { specs } = await deps.snapshot()
      return new Map(specs.filter(s => ids.has(s.id)).map(s => [s.id, s.title]))
    } catch { return new Map() }
  }
  // The milestone the post aimed at, so the page can name it and read its
  // state. A save carries it as `id`, an assignment as `milestoneId`. Null
  // when the form carried none or the store cannot be read.
  async function targetMilestone (namespace, submitted) {
    const id = submitted && (submitted.get('milestoneId') || (submitted.get('action') === 'save-milestone' && submitted.get('id')))
    if (!id) return null
    try { return (await data(namespace)).milestones.find(m => m.id === String(id)) || null } catch { return null }
  }
  // The plan the spec is under now, for a post that names a person: an
  // implementer form carries no milestone, so the only place the refusal can
  // read it is the store. The implementer is named from the same row when it
  // holds them, which a removal always does; an addition is named by its form.
  async function storedPlan (namespace, submitted) {
    const noteId = submitted && submitted.get('noteId')
    if (!noteId || !IMPLEMENTER_ACTIONS.has(submitted.get('action') || '')) return null
    try {
      const { milestones, assignments } = await data(namespace, [noteId])
      const row = assignments.find(a => a.noteId === noteId)
      const held = row && row.milestoneId ? milestones.find(m => m.id === row.milestoneId) : null
      const person = (row ? row.implementers : []).find(u => u.id === submitted.get('userId'))
      return { milestone: held ? held.title : 'No milestone', person: person ? personName(person) : '' }
    } catch { return null }
  }
  // What the post carried, in the words the reader chose it by. A milestone
  // save states its fields; an assignment states the spec and the milestone,
  // which is the same fact the board's notice states when the save lands.
  function appliedBlock (submitted, titles, plan) {
    const action = submitted.get('action') || ''
    const named = value => titles.get(value) || value
    if (action === 'save-milestone') {
      const ticked = submitted.getAll('spec').length
      return MILESTONE_FIELDS.map(([name, label]) => [label, submitted.get(name)])
        .filter(([, value]) => value).map(([label, value]) => `<p>${label}: ${esc(value)}</p>`).join('') +
        (ticked ? `<p>Specs ticked: ${ticked}</p>` : '')
    }
    const noteId = submitted.get('noteId') || ''
    if (!RETRY_ACTIONS.has(action) || !noteId) return ''
    const spec = `<p>Spec: ${esc(named(noteId))}</p>`
    if (!IMPLEMENTER_ACTIONS.has(action)) {
      const milestoneId = submitted.get('milestoneId') || ''
      return spec + `<p>Milestone: ${esc(milestoneId ? named(milestoneId) : 'No milestone')}</p>`
    }
    const userId = submitted.get('userId') || ''
    // An addition's person is not on the stored row, so its form carries the
    // name it showed beside the button. The value comes from the client, so it
    // is bounded and escaped, and a row id stands when the form carried none.
    const person = (plan && plan.person) || (submitted.get('userLabel') || '').trim().slice(0, 80)
    return spec + (plan ? `<p>Milestone: ${esc(plan.milestone)}</p>` : '') +
      (userId ? `<p>Implementer: ${esc(person || userId)}</p>` : '')
  }
  async function errorPage (res, e, namespace, submitted, who, committed = null) {
    const target = await targetMilestone(namespace, submitted)
    const titles = submitted ? await specTitles(submitted) : new Map()
    if (target) titles.set(target.id, target.title)
    const retry = await retryForm(e, namespace, submitted, who, committed)
    const editing = !!submitted && submitted.get('action') === 'save-milestone'
    // An implementer post holds no typed text, so the signed-out list has
    // nothing to preserve that the block below does not state better.
    const person = !!submitted && IMPLEMENTER_ACTIONS.has(submitted.get('action') || '')
    const plan = await storedPlan(namespace, submitted)
    const fallback = !submitted || committed || retry.html ? '' : who ? resubmitForm(e, submitted, who) : person ? '' : unsavedChanges(submitted, titles)
    const recover = retry.html || fallback
    const toBoard = !!submitted && submitted.get('next') === 'board'
    // The milestone fields come back in their inputs for a correction, and the
    // signed-out list prints every field, so those two say it themselves.
    const applied = !submitted || (fallback && (!who || editing)) ? '' : appliedBlock(submitted, titles, plan)
    // The retry button sits right under this line, so a refusal it can fix
    // says what happened rather than the store's "reload" message. A closed
    // milestone is not a race: the same post fails until someone reopens it.
    // Only the store's mark says that is the refusal in hand; the target's
    // state says nothing about why this post failed. A milestone save is the
    // post that reopens it, so it is not sent away to pick another one. The
    // State select sits inside the milestone card's Edit milestone disclosure,
    // which the fragment does not open, so the sentence names that step.
    const closed = !!e.closedMilestone && !editing && !!target
    const reason = retry.raced
      ? editing ? 'Someone else saved this milestone while you were editing. Your version is below.'
        : "Someone else changed this spec's implementation plan while you were editing."
      : closed ? `${esc(target.title)} is closed. Open <a href="${esc(query({ ns: namespace, milestone: target.id }))}#milestone-${esc(target.id)}">Edit milestone on planning</a> and set it to open, or pick another milestone.`
        : esc(e.message)
    const body = `<div class="page-heading"><div><h1>${committed ? 'Saved the milestone, but not every spec' : 'Could not save'}</h1></div></div>
      <p class="warn">${committed ? `The milestone fields are saved. ${reason}` : reason}</p>
      ${applied ? `<h2>${recover && !person ? 'What your save will apply' : 'What you were saving'}</h2>${applied}` : ''}
      ${recover}
      <p>${toBoard ? `<a href="${esc(boardLink(submitted.get('nextQuery')))}">Back to the board</a>` : `<a href="${query({ ns: namespace })}">Back to planning</a>`}</p>`
    res.writeHead(e.status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
    // A refusal on a card save belongs to the board: the shell it renders in
    // is the one the reader is standing on, and the one the retry returns to.
    // It carries no lanes, so it takes the board's nav place without the
    // board's script.
    res.end(deps.basicPage(toBoard ? 'Specifications' : 'Planning', body, { page: toBoard ? 'board-prose' : 'planning', ns: namespace, who }))
  }
  async function handle (req, res, url) {
    const api = url.pathname.startsWith('/api/')
    const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(body))
    let who = null
    let submitted = null
    let committed = null
    try {
      if (api && req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' }).end(); return }
      if (req.method !== 'GET' && (req.method !== 'POST' || api)) throw fail(405, 'Method not allowed.')
      who = deps.loginEnabled ? deps.session(req) : null
      if (req.method === 'POST') {
        if (!deps.loginEnabled) throw fail(503, 'Sign-in is not configured.')
        // Read before the session check so an expired session still gets what
        // it typed back on the refusal page.
        const form = new URLSearchParams(await deps.readBody(req, 150000))
        submitted = form
        if (!who) throw fail(401, 'Sign in to manage planning.')
        if (form.get('csrf') !== deps.csrfToken(who.login)) throw fail(403, 'Your session expired.')
        const namespace = form.get('ns') || ''
        if (!deps.namespaces.includes(namespace)) throw fail(400, 'Unknown project.')
        if (!await allowed(who, namespace, true)) throw durable(403, 'Only project approvers and board admins can manage implementation planning.')
        const action = form.get('action')
        const expectedVersion = version(form.get('version'))
        // The same refusal reaches a card on the board and the spec panel on
        // planning, so it names the page it came from, as the link below it does.
        const origin = form.get('next') === 'board' ? 'board' : 'planning page'
        const assign = ({ noteId, expectedVersion, action, milestoneId, userId }) => deps.store.saveAssignment({
          noteId, namespace, expectedVersion, action, milestoneId, userId, actor: who.login,
          validate: async db => {
            const spec = await deps.currentSpec(noteId, db)
            const removing = action === 'remove-implementer' || (action === 'milestone' && !milestoneId)
            if (!spec || spec.namespace !== namespace || spec.topLevel || (spec.superseded && !removing)) throw durable(409, `Spec is no longer available for assignment. Reload the ${origin}.`)
          } })
        if (action === 'save-milestone') {
          const id = form.get('id') || null
          if (id && !positiveId(id)) throw fail(400, 'Invalid milestone.')
          const input = milestoneInput(Object.fromEntries(form))
          const existing = id ? await deps.store.getMilestone(id, namespace) : null
          if (id && (!existing || existing.version !== expectedVersion)) throw fail(409, 'Milestone changed. Reload before saving.')
          const checkpoint = !input.checkpointTag ? null
            : existing && existing.checkpointTag === input.checkpointTag && existing.checkpointCommit
              ? { commit: existing.checkpointCommit }
              : await deps.checkpoint(namespace, input.checkpointTag)
          const m = await deps.store.saveMilestone({ id, namespace, input, checkpoint, expectedVersion })
          committed = { milestone: true, added: 0, removed: 0 }
          const pairs = name => {
            const entries = form.getAll(name)
            if (entries.length > 100) throw fail(400, 'Too many specs in one save.')
            return new Map(entries.map(entry => {
              const [noteId, ver] = entry.split(':')
              if (!/^[\w-]{1,128}$/.test(noteId)) throw fail(400, 'Invalid assignment.')
              return [noteId, version(ver)]
            }))
          }
          const checked = pairs('spec')
          const members = pairs('member')
          // Where each ticked spec sat before the save, so one taken from
          // another milestone is reported as a move rather than an addition.
          const prior = checked.size ? (await data(namespace, [...checked.keys()])).assignments : []
          let moved = 0
          for (const [noteId, ver] of checked) {
            if (members.has(noteId)) continue
            await assign({ noteId, expectedVersion: ver, action: 'milestone', milestoneId: m.id, userId: null })
            committed.added++
            const from = prior.find(a => a.noteId === noteId)
            if (from && from.milestoneId && from.milestoneId !== m.id) moved++
          }
          for (const [noteId, ver] of members) {
            if (checked.has(noteId)) continue
            await assign({ noteId, expectedVersion: ver, action: 'milestone', milestoneId: null, userId: null })
            committed.removed++
          }
          const { added, removed } = committed
          const membership = added || removed ? { saved: 'members', added, ...(moved ? { moved } : {}), removed } : { saved: id ? 'milestone-saved' : 'milestone-created' }
          deps.redirect(res, query({ ns: namespace, ...membership }) + '#milestone-' + encodeURIComponent(m.id))
        } else if (action === 'delete-milestone') {
          const id = form.get('id') || ''
          if (!positiveId(id)) throw fail(400, 'Invalid milestone.')
          await deps.store.deleteMilestone({ id, namespace, expectedVersion, actor: who.login })
          deps.redirect(res, query({ ns: namespace, saved: 'milestone-deleted' }))
        } else if (action === 'detach-deleted') {
          const noteId = form.get('noteId') || ''
          if (!/^[\w-]{1,128}$/.test(noteId)) throw fail(400, 'Invalid assignment.')
          await deps.store.detachDeleted({ noteId, namespace, expectedVersion, actor: who.login })
          deps.redirect(res, query({ ns: namespace, saved: 'detached' }))
        } else {
          const noteId = form.get('noteId') || ''
          const milestoneId = form.get('milestoneId') || null
          const userId = form.get('userId') || null
          if (!/^[\w-]{1,128}$/.test(noteId) || (milestoneId && !positiveId(milestoneId))) throw fail(400, 'Invalid assignment.')
          if (!['milestone', 'add-implementer', 'remove-implementer'].includes(action)) throw fail(400, 'Unknown action.')
          if (action !== 'milestone' && (!userId || userId.length > 128)) throw fail(400, 'Invalid user.')
          await assign({ noteId, expectedVersion, action, milestoneId, userId })
          const saved = action === 'milestone' ? 'spec-milestone' : action === 'add-implementer' ? 'implementer-added' : 'implementer-removed'
          if (form.get('next') === 'board') deps.redirect(res, boardReturn(form.get('nextQuery'), namespace, noteId, saved))
          else deps.redirect(res, query({ ns: namespace, spec: noteId, saved }))
        }
        return
      }
      // The page stopped linking here; bookmarks and older mail still do.
      if (!api && url.searchParams.has("login")) {
        if (!deps.loginEnabled) throw fail(503, 'Sign-in is not configured.')
        deps.startLogin(req, res, '/roadmap'); return
      }
      const namespace = url.searchParams.get('ns') || ''
      if (namespace && !deps.namespaces.includes(namespace)) throw fail(400, 'Unknown project.')
      const snapshot = await deps.snapshot()
      const stored = await data(namespace)
      const model = roadmap(snapshot.specs.filter(s => deps.namespaces.includes(s.namespace)), snapshot.state, stored, new Date(), deps.canApprove)
      const detail = /^\/api\/milestones\/([1-9]\d{0,18})$/.exec(url.pathname)
      if (api && !['/api/milestones', '/api/roadmap'].includes(url.pathname) && !detail) throw fail(404, 'Unknown endpoint.')
      const milestoneId = detail ? detail[1] : url.searchParams.get('milestone') || ''
      if (milestoneId && milestoneId !== 'none' && !model.milestones.some(m => m.id === milestoneId && (!namespace || m.namespace === namespace))) {
        // Changing the namespace select with a milestone in the URL is a
        // normal move, not a lost page; only the API treats it as an error.
        if (api) throw fail(404, 'Unknown milestone.')
        deps.redirect(res, query({ ns: namespace })); return
      }
      const implementer = url.searchParams.get('implementer') || ''
      if (implementer === 'me' && !who) throw fail(401, 'Sign in to use assigned-to-me.')
      const state = url.searchParams.get('state') || ''
      if (state && !['open', 'closed'].includes(state)) throw fail(400, 'Invalid milestone state.')
      const page = Number(url.searchParams.get('page') || 0)
      const milestonePage = Number(url.searchParams.get('milestonePage') || 0)
      if (![page, milestonePage].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000)) throw fail(400, 'Invalid page.')
      let nodes = filterSpecs(model.nodes, { milestone: milestoneId, implementer }, who).filter(n => (!namespace || n.namespace === namespace) && (!state || n.milestone && n.milestone.state === state))
      const limit = 100
      const total = nodes.length
      nodes = nodes.slice(page * limit, (page + 1) * limit)
      const milestones = model.milestones.filter(m => (!namespace || m.namespace === namespace) && (!state || m.state === state) && (!milestoneId || m.id === milestoneId))
      if (api) {
        const payload = { at: new Date(snapshot.at).toISOString(), stale: deps.stale(snapshot), page, total, nextPage: (page + 1) * limit < total ? page + 1 : null }
        if (url.pathname === '/api/milestones') {
          json(200, { ...payload, total: milestones.length, nextPage: (page + 1) * limit < milestones.length ? page + 1 : null, milestones: milestones.slice(page * limit, (page + 1) * limit) })
        } else json(200, { ...payload, milestones: milestones.slice(0, limit), nodes })
        return
      }
      const manageableNs = await manageable(who, namespace)
      // A panel opened from a board card closes back onto that board.
      const back = url.searchParams.get('next') === 'board' ? boardLink(url.searchParams.get('nextQuery')) : ''
      const specId = url.searchParams.get('spec') || ''
      const spec = model.nodes.find(n => n.id === specId && (!namespace || n.namespace === namespace))
      if (specId && !spec) throw fail(404, 'Unknown spec.')
      const userQuery = url.searchParams.get('userQuery') || ''
      const users = spec && manageableNs.includes(spec.namespace) && userQuery ? await deps.store.users(userQuery) : []
      const deleted = manageableNs.length ? await deps.store.deletedAssignments(manageableNs, 100, milestoneId || null) : []
      model.filterState = state
      const savedCode = url.searchParams.get('saved') || ''
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
      res.end(deps.basicPage('Planning', roadmapPage({ model, namespaces: deps.namespaces, namespace, milestoneId,
        csrf: who ? deps.csrfToken(who.login) : '', manageable: manageableNs, specId, users, userQuery, deleted, boardLink: back,
        stale: deps.stale(snapshot), staleAt: snapshot.at, milestonePage,
        saved: KNOWN_SAVED.has(savedCode) ? savedCode : '',
        savedCounts: { added: count(url.searchParams.get('added')), moved: count(url.searchParams.get('moved')), removed: count(url.searchParams.get('removed')) } }), { page: 'planning', ns: namespace, who }))
    } catch (e) {
      if (!e.status) throw e
      if (api) { json(e.status, { error: e.message }); return }
      const raw = submitted ? submitted.get('ns') : url.searchParams.get('ns')
      await errorPage(res, e, deps.namespaces.includes(raw) ? raw : '', submitted, who, committed)
    }
  }
  return { handle, decorate, manageable }
}
module.exports = { createRoadmapService }
