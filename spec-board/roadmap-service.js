const { fail, positiveId, version, milestoneInput, roadmap, decorateSpecs, filterSpecs } = require('./roadmap')
const { roadmapPage, query } = require('./roadmap-ui')
const { canManageFeedback } = require('./feedback')

function createRoadmapService (deps) {
  const allowed = async (who, ns, refresh = false) => !!who && (deps.isAdmin(who) || canManageFeedback(who, await deps.roles(ns, refresh)))
  async function data (namespace = '', noteIds = null) {
    const namespaces = namespace ? [namespace] : deps.namespaces
    const all = await deps.store.read({ namespaces, noteIds })
    return { milestones: all.milestones.filter(m => namespaces.includes(m.namespace)),
      assignments: all.assignments.filter(a => namespaces.includes(a.namespace)) }
  }
  async function decorate (specs) { return decorateSpecs(specs, await data('', specs.map(s => s.id))) }
  async function handle (req, res, url) {
    const api = url.pathname.startsWith('/api/')
    const json = (status, body) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' }).end(JSON.stringify(body))
    try {
      if (api && req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' }).end(); return }
      if (req.method !== 'GET' && (req.method !== 'POST' || api)) throw fail(405, 'Method not allowed')
      const who = deps.loginEnabled ? deps.session(req) : null
      if (req.method === 'POST') {
        if (!deps.loginEnabled) throw fail(503, 'Sign-in is not configured')
        if (!who) throw fail(401, 'Sign in to manage planning')
        const form = new URLSearchParams(await deps.readBody(req, 150000))
        if (form.get('csrf') !== deps.csrfToken(who.login)) throw fail(403, 'Invalid CSRF token')
        const namespace = form.get('ns') || ''
        if (!deps.namespaces.includes(namespace)) throw fail(400, 'Unknown namespace')
        if (!await allowed(who, namespace, true)) throw fail(403, 'Only namespace approvers and board admins can manage implementation planning')
        const action = form.get('action')
        const expectedVersion = version(form.get('version'))
        const assign = ({ noteId, expectedVersion, action, milestoneId, userId }) => deps.store.saveAssignment({
          noteId, namespace, expectedVersion, action, milestoneId, userId, actor: who.login,
          validate: async db => {
            const spec = await deps.currentSpec(noteId, db)
            const removing = action === 'remove-implementer' || (action === 'milestone' && !milestoneId)
            if (!spec || spec.namespace !== namespace || spec.topLevel || (spec.superseded && !removing)) throw fail(409, 'Spec is no longer available for assignment. Reload the planning page.')
          } })
        if (action === 'save-milestone') {
          const id = form.get('id') || null
          if (id && !positiveId(id)) throw fail(400, 'Invalid milestone')
          const input = milestoneInput(Object.fromEntries(form))
          const existing = id ? await deps.store.getMilestone(id, namespace) : null
          if (id && (!existing || existing.version !== expectedVersion)) throw fail(409, 'Milestone changed. Reload before saving.')
          const checkpoint = !input.checkpointTag ? null
            : existing && existing.checkpointTag === input.checkpointTag && existing.checkpointCommit
              ? { commit: existing.checkpointCommit }
              : await deps.checkpoint(namespace, input.checkpointTag)
          const m = await deps.store.saveMilestone({ id, namespace, input, checkpoint, expectedVersion })
          const pairs = name => {
            const entries = form.getAll(name)
            if (entries.length > 100) throw fail(400, 'Too many specs in one save')
            return new Map(entries.map(entry => {
              const [noteId, ver] = entry.split(':')
              if (!/^[\w-]{1,128}$/.test(noteId)) throw fail(400, 'Invalid assignment')
              return [noteId, version(ver)]
            }))
          }
          const checked = pairs('spec')
          const members = pairs('member')
          for (const [noteId, ver] of checked) if (!members.has(noteId)) await assign({ noteId, expectedVersion: ver, action: 'milestone', milestoneId: m.id, userId: null })
          for (const [noteId, ver] of members) if (!checked.has(noteId)) await assign({ noteId, expectedVersion: ver, action: 'milestone', milestoneId: null, userId: null })
          deps.redirect(res, query({ ns: namespace, milestone: m.id }))
        } else if (action === 'detach-deleted') {
          const noteId = form.get('noteId') || ''
          if (!/^[\w-]{1,128}$/.test(noteId)) throw fail(400, 'Invalid assignment')
          await deps.store.detachDeleted({ noteId, namespace, expectedVersion, actor: who.login })
          deps.redirect(res, query({ ns: namespace }))
        } else {
          const noteId = form.get('noteId') || ''
          const milestoneId = form.get('milestoneId') || null
          const userId = form.get('userId') || null
          if (!/^[\w-]{1,128}$/.test(noteId) || (milestoneId && !positiveId(milestoneId))) throw fail(400, 'Invalid assignment')
          if (!['milestone', 'add-implementer', 'remove-implementer'].includes(action)) throw fail(400, 'Unknown action')
          if (action !== 'milestone' && (!userId || userId.length > 128)) throw fail(400, 'Invalid user')
          await assign({ noteId, expectedVersion, action, milestoneId, userId })
          deps.redirect(res, query({ ns: namespace, spec: noteId }))
        }
        return
      }
      if (!api && url.searchParams.has('login')) {
        if (!deps.loginEnabled) throw fail(503, 'Sign-in is not configured')
        deps.startLogin(req, res, '/roadmap'); return
      }
      const namespace = url.searchParams.get('ns') || ''
      if (namespace && !deps.namespaces.includes(namespace)) throw fail(400, 'Unknown namespace')
      const snapshot = await deps.snapshot()
      const stored = await data(namespace)
      const model = roadmap(snapshot.specs.filter(s => deps.namespaces.includes(s.namespace)), snapshot.state, stored, new Date(), deps.canApprove)
      const detail = /^\/api\/milestones\/([1-9]\d{0,18})$/.exec(url.pathname)
      if (api && !['/api/milestones', '/api/roadmap'].includes(url.pathname) && !detail) throw fail(404, 'Unknown endpoint')
      const milestoneId = detail ? detail[1] : url.searchParams.get('milestone') || ''
      if (milestoneId && milestoneId !== 'none' && !model.milestones.some(m => m.id === milestoneId && (!namespace || m.namespace === namespace))) throw fail(404, 'Unknown milestone')
      const implementer = url.searchParams.get('implementer') || ''
      if (implementer === 'me' && !who) throw fail(401, 'Sign in to use assigned-to-me')
      const state = url.searchParams.get('state') || ''
      if (state && !['open', 'closed'].includes(state)) throw fail(400, 'Invalid milestone state')
      const page = Number(url.searchParams.get('page') || 0)
      const milestonePage = Number(url.searchParams.get('milestonePage') || 0)
      if (![page, milestonePage].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 1000000)) throw fail(400, 'Invalid page')
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
      const manageable = []
      if (who) for (const ns of deps.namespaces.filter(ns => !namespace || ns === namespace)) if (await allowed(who, ns)) manageable.push(ns)
      const specId = url.searchParams.get('spec') || ''
      const spec = model.nodes.find(n => n.id === specId && (!namespace || n.namespace === namespace))
      if (specId && !spec) throw fail(404, 'Unknown spec')
      const userQuery = url.searchParams.get('userQuery') || ''
      const users = spec && manageable.includes(spec.namespace) && userQuery ? await deps.store.users(userQuery) : []
      const deleted = manageable.length ? await deps.store.deletedAssignments(manageable, 100, milestoneId || null) : []
      model.filterState = state
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
      res.end(deps.basicPage('Planning', roadmapPage({ model, namespaces: deps.namespaces, namespace, milestoneId,
        who, csrf: who ? deps.csrfToken(who.login) : '', manageable, specId, users, userQuery, deleted,
        stale: deps.stale(snapshot), loginEnabled: deps.loginEnabled, milestonePage }), { page: 'planning', ns: namespace, who }))
    } catch (e) {
      if (!e.status) throw e
      if (api) json(e.status, { error: e.message })
      else res.writeHead(e.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end(e.message)
    }
  }
  return { handle, decorate }
}
module.exports = { createRoadmapService }
