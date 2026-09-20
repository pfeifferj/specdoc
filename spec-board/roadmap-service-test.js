const assert = require('assert/strict')
const { createRoadmapService } = require('./roadmap-service')
const { fail } = require('./roadmap')

async function main () {
  const checkpointCalls = []
  let bodyLimit = 0
  let assigned, assignedAll = [], saved, detached, scope, deletedReads = 0, deleted = [], userSearches = 0, roleFailure = false, current = { namespace: 'o/r', topLevel: false }
  const data = { milestones: [{ id: '1', namespace: 'o/r', title: 'One', description: '', state: 'open', version: 1 }], assignments: [] }
  const specs = [{ id: 'a', namespace: 'o/r', title: 'Feature', url: 'http://editor/a', statusIdx: 0, dependsOn: [] }]
  const deps = {
    store: { read: async options => { scope = options; return data }, getMilestone: async (id, ns) => data.milestones.find(m => m.id === id && m.namespace === ns), users: async () => { userSearches++; return [] },
      deletedAssignments: async namespaces => { deletedReads++; return deleted.filter(a => namespaces.includes(a.namespace)) },
      detachDeleted: async args => { if (args.expectedVersion !== 3) throw fail(409, 'Assignments changed'); detached = args },
      saveMilestone: async args => { saved = args; return { id: '1' } },
      saveAssignment: async args => { await args.validate({}); if (args.expectedVersion !== 0) throw fail(409, 'Assignments changed'); assigned = args; assignedAll.push(args) } },
    namespaces: ['o/r'], roles: async () => roleFailure ? null : { approvers: ['reviewer'] },
    isAdmin: s => s && s.login === 'admin', session: req => req.who || null,
    csrfToken: login => 'csrf-' + login, readBody: async (req, limit) => { bodyLimit = limit; if (Buffer.byteLength(req.body) > limit) throw fail(413, 'Body too large'); return req.body },
    redirect: (res, location) => res.writeHead(302, { location }).end(),
    startLogin: (req, res, next) => res.writeHead(302, { location: 'login:' + next }).end(),
    basicPage: (title, body) => body, loginEnabled: true,
    snapshot: async () => ({ specs, state: new Map(), at: Date.now() }), stale: () => false,
    currentSpec: async () => current,
    checkpoint: async (ns, tag) => { checkpointCalls.push({ ns, tag }); if (tag === 'specs/v9') throw fail(400, 'Checkpoint not found'); return { commit: 'a'.repeat(40) } }
  }
  const service = createRoadmapService(deps)
  async function call (path, method = 'GET', fields = {}, who = null) {
    const res = { status: 0, headers: {}, writeHead (status, headers) { this.status = status; this.headers = headers || {}; return this }, end (body = '') { this.body = body; return this } }
    await service.handle({ method, body: new URLSearchParams(fields).toString(), who }, res, new URL(path, 'http://board'))
    return res
  }
  const admin = { login: 'admin', uid: 'u' }, reviewer = { login: 'reviewer', uid: 'v' }
  const fields = { csrf: 'csrf-admin', ns: 'o/r', action: 'milestone', noteId: 'a', version: '0', milestoneId: '1' }
  assert.equal((await call('/roadmap')).status, 200)
  assert.equal(deletedReads, 0)
  assert.deepEqual(scope, { namespaces: ['o/r'], noteIds: null })
  assert.equal((await call('/roadmap?login=1')).headers.location, 'login:/roadmap')
  assert.equal((await call('/roadmap', 'POST', fields)).status, 401)
  assert.equal((await call('/roadmap', 'POST', { ...fields, csrf: 'wrong' }, admin)).status, 403)
  assert.equal((await call('/roadmap', 'POST', { ...fields, csrf: 'csrf-guest' }, { login: 'guest' })).status, 403)
  assert.equal((await call('/roadmap', 'POST', fields, admin)).status, 302)
  assert.equal(assigned.noteId, 'a')
  assert.equal((await call('/roadmap', 'POST', { ...fields, csrf: 'csrf-reviewer' }, reviewer)).status, 302)
  roleFailure = true
  assert.equal((await call('/roadmap', 'POST', { ...fields, csrf: 'csrf-reviewer' }, reviewer)).status, 403)
  assert.equal((await call('/roadmap', 'POST', fields, admin)).status, 302)
  roleFailure = false
  for (const changed of [null, { namespace: 'other/r' }, { namespace: 'o/r', topLevel: true }, { namespace: 'o/r', superseded: true }]) {
    current = changed
    assert.equal((await call('/roadmap', 'POST', fields, admin)).status, 409)
  }
  current = { namespace: 'o/r', superseded: true }
  assert.equal((await call('/roadmap', 'POST', { ...fields, milestoneId: '' }, admin)).status, 302)
  assert.equal((await call('/roadmap', 'POST', { ...fields, action: 'remove-implementer', userId: 'u1' }, admin)).status, 302)
  assert.equal((await call('/roadmap', 'POST', { ...fields, action: 'add-implementer', userId: 'u1' }, admin)).status, 409)
  current = { namespace: 'o/r' }
  assert.equal((await call('/roadmap', 'POST', { ...fields, version: '1' }, admin)).status, 409)
  assert.equal((await call('/roadmap', 'POST', { ...fields, version: '-1' }, admin)).status, 400)
  assert.equal((await call('/roadmap', 'POST', { ...fields, ns: 'evil/r' }, admin)).status, 400)
  assert.equal((await call('/roadmap', 'POST', { ...fields, action: 'add-implementer', userId: 'u1' }, admin)).status, 302)
  assert.equal(assigned.userId, 'u1')
  const detachFields = { ...fields, action: 'detach-deleted', noteId: 'gone', version: '3' }
  assert.equal((await call('/roadmap', 'POST', detachFields)).status, 401)
  assert.equal((await call('/roadmap', 'POST', { ...detachFields, csrf: 'bad' }, admin)).status, 403)
  assert.equal((await call('/roadmap', 'POST', { ...detachFields, csrf: 'csrf-guest' }, { login: 'guest' })).status, 403)
  assert.equal((await call('/roadmap', 'POST', { ...detachFields, version: '2' }, admin)).status, 409)
  assert.equal((await call('/roadmap', 'POST', detachFields, admin)).headers.location, '/roadmap?ns=o%2Fr')
  assert.deepEqual(detached, { noteId: 'gone', namespace: 'o/r', expectedVersion: 3, actor: 'admin' })
  deleted = [{ noteId: 'gone', namespace: 'o/r', version: 3, milestoneId: '1' }]
  assert.ok(!(await call('/roadmap')).body.includes('Deleted spec gone'))
  assert.ok((await call('/roadmap', 'GET', {}, admin)).body.includes('Deleted spec gone'))
  assert.ok((await call('/roadmap', 'GET', {}, admin)).body.includes('name="action" value="detach-deleted"'))
  assert.ok(!(await call('/api/roadmap', 'GET', {}, admin)).body.includes('gone'))
  deleted = []
  await call('/roadmap?ns=o/r&spec=a&userQuery=al')
  assert.equal(userSearches, 0)
  await call('/roadmap?ns=o/r&spec=a&userQuery=al', 'GET', {}, admin)
  assert.equal(userSearches, 1)
  const milestone = { csrf: 'csrf-admin', ns: 'o/r', action: 'save-milestone', version: '0', title: 'First', dueDate: '2028-02-29', checkpointTag: 'specs/v1' }
  assert.equal((await call('/roadmap', 'POST', milestone, admin)).status, 302)
  assert.equal(saved.checkpoint.commit, 'a'.repeat(40))
  assert.equal((await call('/roadmap', 'POST', { ...milestone, checkpointTag: 'specs/v9' }, admin)).status, 400)
  data.milestones[0].checkpointTag = 'specs/v9'
  data.milestones[0].checkpointCommit = 'b'.repeat(40)
  const before = checkpointCalls.length
  assert.equal((await call('/roadmap', 'POST', { ...milestone, id: '1', version: '1', title: 'Renamed', state: 'closed', checkpointTag: 'specs/v9' }, admin)).status, 302)
  assert.equal(saved.checkpoint.commit, 'b'.repeat(40))
  assert.equal(checkpointCalls.length, before)
  assert.equal((await call('/roadmap', 'POST', { ...milestone, id: '1', version: '0' }, admin)).status, 409)
  assignedAll = []
  const membership = [['csrf', 'csrf-admin'], ['ns', 'o/r'], ['action', 'save-milestone'], ['id', '1'], ['version', '1'], ['title', 'Renamed'], ['checkpointTag', 'specs/v9'],
    ['spec', 'a:0'], ['spec', 'b:0'], ['member', 'b:0'], ['member', 'c:0']]
  assert.equal((await call('/roadmap', 'POST', membership, admin)).status, 302)
  assert.deepEqual(assignedAll.map(a => [a.noteId, a.milestoneId]), [['a', '1'], ['c', null]], 'ticked joins, unticked leaves, unchanged is untouched')
  assert.equal((await call('/roadmap', 'POST', [...membership, ['spec', 'bad id:0']], admin)).status, 400)
  assert.equal((await call('/roadmap', 'POST', [...membership, ['spec', 'd:1']], admin)).status, 409)
  assert.equal(checkpointCalls.length, before)
  assert.equal((await call('/roadmap', 'POST', { ...milestone, id: '1', version: '1', checkpointTag: '' }, admin)).status, 302)
  assert.equal(saved.checkpoint, null)
  assert.equal((await call('/roadmap', 'POST', { ...milestone, description: '字'.repeat(10000) }, admin)).status, 302)
  assert.equal(saved.input.description.length, 10000)
  assert.equal(bodyLimit, 150000)
  assert.equal((await call('/roadmap?implementer=me')).status, 401)
  assert.equal((await call('/api/roadmap', 'POST', fields, admin)).status, 405)
  assert.equal((await call('/api/roadmap', 'OPTIONS')).status, 204)
  assert.equal((await call('/api/milestones/1')).status, 200)
  assert.equal((await call('/api/milestones/404')).status, 404)
  assert.equal((await call('/api/milestones/no')).status, 404)
  const api = await call('/api/roadmap')
  assert.equal(JSON.parse(api.body).nodes[0].title, 'Feature')
  assert.equal(api.headers['Cache-Control'], 'no-store')
  await service.decorate(specs)
  assert.deepEqual(scope.noteIds, ['a'])
  for (const path of ['/roadmap?ns=bad/r', '/roadmap?state=bad', '/roadmap?page=-1']) assert.equal((await call(path)).status, 400)
  data.milestones = Array.from({ length: 105 }, (_, i) => ({ id: String(i + 1), namespace: 'o/r', title: 'Milestone ' + String(i).padStart(3, '0'), description: '', state: 'open', version: 1 }))
  const milestonePage = await call('/roadmap?ns=o/r&milestonePage=1', 'GET', {}, admin)
  assert.equal((milestonePage.body.match(/class="milestone"/g) || []).length, 5)
  assert.ok(milestonePage.body.includes('Previous milestones'))
  assert.ok(!milestonePage.body.includes('More milestones'))
  assert.ok(!milestonePage.body.includes('name="spec"'))
  const msApi = JSON.parse((await call('/api/milestones?page=1')).body)
  assert.deepEqual(msApi.milestones.map(m => m.id), ['101', '102', '103', '104', '105'])
  assert.equal(msApi.nextPage, null)
  specs.push(...Array.from({ length: 104 }, (_, i) => ({ ...specs[0], id: 's' + i, title: 'Spec ' + String(i).padStart(3, '0') })))
  const nodePage = JSON.parse((await call('/api/roadmap?page=1')).body)
  assert.deepEqual(nodePage.nodes.map(n => n.id), ['s99', 's100', 's101', 's102', 's103'])
  assert.equal(nodePage.nextPage, null)
  assert.equal((await call('/roadmap?milestonePage=-1')).status, 400)
  deps.loginEnabled = false
  deps.session = () => { throw new Error('No session secret is configured') }
  assert.equal((await call('/roadmap')).status, 200)
  assert.equal((await call('/roadmap', 'POST', fields, admin)).status, 503)
  console.log('roadmap service tests passed')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
