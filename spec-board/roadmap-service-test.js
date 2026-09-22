const assert = require('assert/strict')
const { createRoadmapService } = require('./roadmap-service')
const { fail } = require('./roadmap')

async function main () {
  const checkpointCalls = []
  let bodyLimit = 0
  let assigned, assignedAll = [], saved, removed, detached, scope, shell = null, deletedReads = 0, deleted = [], userSearches = 0, roleFailure = false, rolesCold = false, current = { namespace: 'o/r', topLevel: false }
  const data = { milestones: [{ id: '1', namespace: 'o/r', title: 'One', description: '', state: 'open', version: 1 }], assignments: [] }
  const specs = [{ id: 'a', namespace: 'o/r', title: 'Feature', url: 'http://editor/a', statusIdx: 0, dependsOn: [] }]
  const deps = {
    store: { read: async options => { scope = options; return data }, getMilestone: async (id, ns) => data.milestones.find(m => m.id === id && m.namespace === ns), users: async () => { userSearches++; return [] },
      deletedAssignments: async namespaces => { deletedReads++; return deleted.filter(a => namespaces.includes(a.namespace)) },
      detachDeleted: async args => { if (args.expectedVersion !== 3) throw fail(409, 'Assignments changed'); detached = args },
      saveMilestone: async args => { saved = args; return { id: '1' } },
      deleteMilestone: async args => { removed = args },
      saveAssignment: async args => { await args.validate({}); const row = data.assignments.find(a => a.noteId === args.noteId)
        if (args.expectedVersion !== (row ? row.version : 0)) throw fail(409, 'Assignments changed. Reload before saving.')
        if (args.action === 'milestone' && args.milestoneId) {
          const target = data.milestones.find(m => m.id === args.milestoneId && m.namespace === args.namespace)
          if (!target) throw fail(400, 'Milestone belongs to another project or does not exist')
          if (target.state !== 'open') throw Object.assign(fail(409, 'Reopen the milestone before assigning work'), { closedMilestone: true })
        }
        if (args.userId === 'gone') throw fail(400, 'Unknown user')
        assigned = args; assignedAll.push(args) } },
    namespaces: ['o/r'], roles: async (ns, live = false, cacheOnly = false) => roleFailure || (cacheOnly && rolesCold) ? null : { approvers: ['reviewer'] },
    isAdmin: s => s && s.login === 'admin', session: req => req.who || null,
    csrfToken: login => 'csrf-' + login, readBody: async (req, limit) => { bodyLimit = limit; if (Buffer.byteLength(req.body) > limit) throw fail(413, 'Body too large'); return req.body },
    redirect: (res, location) => res.writeHead(302, { location }).end(),
    startLogin: (req, res, next) => res.writeHead(302, { location: 'login:' + next }).end(),
    basicPage: (title, body, options = {}) => { shell = { title, ...options }; return body }, loginEnabled: true,
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
  // Re-post a form the error page rendered, exactly as a browser would.
  const replay = body => {
    const form = body.slice(body.indexOf('<form'), body.indexOf('</form>'))
    return [...form.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)]
      .map(m => [m[1], m[2].replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'")])
  }
  async function recovery () {
    const refused = await call('/roadmap', 'POST', { csrf: 'wrong', ns: 'o/r', action: 'save-milestone', id: '1', version: '1', title: 'Held' }, admin)
    assert.equal(refused.status, 403)
    assert.equal(refused.headers['Content-Type'], 'text/html; charset=utf-8')
    assert.ok(refused.body.includes('Back to planning'), refused.body)
    assert.ok(!refused.body.includes('Apply my changes on top'))
    assert.ok(refused.body.includes('Save again'), refused.body)
    assert.ok(refused.body.includes('<input name="title" maxlength="160" value="Held">'), refused.body)
    const stale = await call('/roadmap', 'POST', [['csrf', 'csrf-admin'], ['ns', 'o/r'], ['action', 'save-milestone'], ['id', '1'], ['version', '0'],
      ['title', 'Held <edit>'], ['state', 'closed'], ['spec', 'a:0'], ['member', 'a:0']], admin)
    assert.equal(stale.status, 409)
    assert.equal(stale.headers['Content-Type'], 'text/html; charset=utf-8')
    assert.ok(stale.body.includes('Apply my changes on top'), stale.body)
    assert.ok(stale.body.includes('Someone else saved this milestone while you were editing'), stale.body)
    assert.ok(stale.body.includes('<p>Title: theirs One, yours Held &lt;edit&gt;</p>'), stale.body)
    assert.ok(stale.body.includes('<p>State: theirs open, yours closed</p>'), stale.body)
    assert.ok(stale.body.includes('Specs ticked: 1'))
    const fields = replay(stale.body)
    const sent = new Map(fields)
    assert.equal(sent.get('title'), 'Held <edit>')
    assert.equal(sent.get('version'), String(data.milestones.find(m => m.id === '1').version))
    assert.equal(sent.get('csrf'), 'csrf-admin')
    assert.equal(fields.filter(([name]) => name === 'spec').length, 1)
    const retried = await call('/roadmap', 'POST', fields, admin)
    assert.equal(retried.status, 302, retried.body)
    assert.equal(saved.input.title, 'Held <edit>')
    const guest = await call('/roadmap?ns=bad/r')
    assert.equal(guest.status, 400)
    assert.ok(guest.body.includes('Back to planning'))
    assert.ok(!guest.body.includes('Apply my changes on top'))
  }
  // A membership save whose conflict is a spec row rather than the milestone.
  async function specRowRecovery () {
    data.assignments = [{ noteId: 'd', namespace: 'o/r', version: 5, implementers: [] }]
    const stale = await call('/roadmap', 'POST', [['csrf', 'csrf-admin'], ['ns', 'o/r'], ['action', 'save-milestone'], ['id', '1'], ['version', '1'],
      ['title', 'Renamed'], ['spec', 'd:1'], ['member', 'e:0']], admin)
    assert.equal(stale.status, 409)
    const fields = replay(stale.body)
    assert.deepEqual(fields.filter(([name]) => name === 'spec' || name === 'member'), [['spec', 'd:5'], ['member', 'e:0']], stale.body)
    assignedAll = []
    const retried = await call('/roadmap', 'POST', fields, admin)
    assert.equal(retried.status, 302, retried.body)
    assert.deepEqual(assignedAll.map(a => [a.noteId, a.expectedVersion, a.milestoneId]), [['d', 5, '1'], ['e', 0, null]])
    data.assignments = []
  }
  // Every refusal that is not a version race, and the save that half landed.
  async function refusals () {
    const long = 'x'.repeat(161)
    const overLong = await call('/roadmap', 'POST', { csrf: 'csrf-admin', ns: 'o/r', action: 'save-milestone', id: '1', version: '1', title: long, state: 'open' }, admin)
    assert.equal(overLong.status, 400)
    assert.ok(overLong.body.includes('Save again'), overLong.body)
    assert.ok(overLong.body.includes(`<input name="title" maxlength="160" value="${long}">`), overLong.body)
    const signedOut = await call('/roadmap', 'POST', { csrf: 'csrf-admin', ns: 'o/r', action: 'save-milestone', id: '1', version: '1', title: 'Typed while away' })
    assert.equal(signedOut.status, 401)
    assert.ok(signedOut.body.includes('Your unsaved changes'), signedOut.body)
    assert.ok(signedOut.body.includes('<p>Title: Typed while away</p>'), signedOut.body)
    // the unsaved list names the milestone being saved, not its row id
    assert.ok(signedOut.body.includes('<p>Milestone: One</p>'), signedOut.body)
    assert.ok(!signedOut.body.includes('Milestone: 1'), signedOut.body)
    assert.ok(!signedOut.body.includes('<form'), signedOut.body)
    const noSpecs = await call('/roadmap', 'POST', { csrf: 'csrf-admin', ns: 'o/r', action: 'save-milestone', id: '1', version: '0', title: 'Held' }, admin)
    assert.equal(noSpecs.status, 409)
    assert.ok(noSpecs.body.includes('Apply my changes on top'), noSpecs.body)
    assert.ok(!noSpecs.body.includes('Specs ticked'), noSpecs.body)
    data.assignments = [{ noteId: 'later', namespace: 'o/r', version: 7, implementers: [] }]
    saved = null
    const partial = await call('/roadmap', 'POST', [['csrf', 'csrf-admin'], ['ns', 'o/r'], ['action', 'save-milestone'], ['id', '1'], ['version', '1'],
      ['title', 'Renamed anyway'], ['spec', 'first:0'], ['spec', 'later:0']], admin)
    assert.equal(partial.status, 409)
    assert.ok(partial.body.includes('Saved the milestone, but not every spec'), partial.body)
    assert.ok(partial.body.includes('The milestone fields are saved. Someone else saved this milestone while you were editing.'), partial.body)
    assert.ok(!partial.body.includes('Reload'), partial.body)
    assert.equal(saved.input.title, 'Renamed anyway')
    // A refusal the retry cannot fix keeps its own wording, race or not.
    current = { namespace: 'o/r', topLevel: false, superseded: true }
    const gone = await call('/roadmap', 'POST', [['csrf', 'csrf-admin'], ['ns', 'o/r'], ['action', 'save-milestone'], ['id', '1'], ['version', '1'],
      ['title', 'Renamed anyway'], ['spec', 'first:0']], admin)
    assert.equal(gone.status, 409)
    assert.ok(gone.body.includes('The milestone fields are saved. Spec is no longer available for assignment.'), gone.body)
    assert.ok(!gone.body.includes('Someone else saved this milestone'), gone.body)
    current = { namespace: 'o/r', topLevel: false }
    data.assignments = [{ noteId: 'a', namespace: 'o/r', milestoneId: '2', version: 0, implementers: [] }]
    const moved = await call('/roadmap', 'POST', [['csrf', 'csrf-admin'], ['ns', 'o/r'], ['action', 'save-milestone'], ['id', '1'], ['version', '1'], ['title', 'Renamed'], ['spec', 'a:0']], admin)
    assert.equal(moved.status, 302, moved.body)
    assert.ok(moved.headers.location.includes('saved=members&added=1&moved=1'), moved.headers.location)
    data.assignments = []
    // A half-landed save on a closed milestone keeps the store's reason: the
    // form being refused is the one that reopens it.
    data.milestones.push({ id: '3', namespace: 'o/r', title: 'Shipped', description: '', state: 'closed', version: 1 })
    current = { namespace: 'o/r', topLevel: false, superseded: true }
    const onClosed = await call('/roadmap', 'POST', [['csrf', 'csrf-admin'], ['ns', 'o/r'], ['action', 'save-milestone'], ['id', '3'], ['version', '1'],
      ['title', 'Shipped'], ['state', 'closed'], ['spec', 'first:0']], admin)
    assert.equal(onClosed.status, 409)
    assert.ok(onClosed.body.includes('Spec is no longer available for assignment.'), onClosed.body)
    assert.ok(!onClosed.body.includes('is closed.'), onClosed.body)
    current = { namespace: 'o/r', topLevel: false }
    data.milestones.pop()
  }
  // Every refusal an assignment can reach: what it names, and whether it can
  // offer a retry that would do anything.
  async function assignmentRefusals () {
    data.milestones.push({ id: '2', namespace: 'o/r', title: 'Shipped', description: '', state: 'closed', version: 1 })
    const card = { csrf: 'csrf-admin', ns: 'o/r', action: 'milestone', noteId: 'a', version: '0', milestoneId: '1', next: 'board', nextQuery: 'ns=o/r' }
    const closed = await call('/roadmap', 'POST', { ...card, milestoneId: '2' }, admin)
    assert.equal(closed.status, 409)
    assert.ok(!closed.body.includes('<form'), closed.body)
    assert.ok(closed.body.includes('Shipped is closed. Open <a href="/roadmap?ns=o%2Fr&amp;milestone=2#milestone-2">Edit milestone on planning</a> and set it to open, or pick another milestone.'), closed.body)
    assert.ok(!closed.body.includes('Reopen the milestone before assigning work'), closed.body)
    assert.ok(closed.body.includes('<p>Spec: Feature</p>'), closed.body)
    assert.ok(closed.body.includes('<p>Milestone: Shipped</p>'), closed.body)
    assert.equal(shell.page, 'board-prose')
    // A row that went while the card was on screen. The post carries nothing
    // the reader can correct, so the page offers no button back into it.
    const vanished = await call('/roadmap', 'POST', { ...card, milestoneId: '99' }, admin)
    assert.equal(vanished.status, 400)
    assert.ok(!vanished.body.includes('<form'), vanished.body)
    assert.ok(vanished.body.includes('Milestone belongs to another project or does not exist'), vanished.body)
    assert.ok(vanished.body.includes('<p>Spec: Feature</p>'), vanished.body)
    const unknownUser = await call('/roadmap', 'POST', { ...card, action: 'add-implementer', userId: 'gone', milestoneId: '' }, admin)
    assert.equal(unknownUser.status, 400)
    assert.ok(!unknownUser.body.includes('<form'), unknownUser.body)
    assert.ok(unknownUser.body.includes('Unknown user'), unknownUser.body)
    // The store reads the target only for a milestone post, so a closed one
    // riding along on an implementer post refuses nothing.
    const closedRider = await call('/roadmap', 'POST', { ...card, action: 'add-implementer', userId: 'u1', milestoneId: '2' }, admin)
    assert.equal(closedRider.status, 302, closedRider.body)
    assert.equal(assigned.action, 'add-implementer')
    data.assignments = [{ noteId: 'a', namespace: 'o/r', version: 3, implementers: [] }]
    const raced = await call('/roadmap', 'POST', card, admin)
    assert.equal(raced.status, 409)
    assert.ok(raced.body.includes('Apply my changes on top'), raced.body)
    // the button is right there, so the page does not ask for a reload
    assert.ok(raced.body.includes("Someone else changed this spec's implementation plan while you were editing."), raced.body)
    assert.ok(!raced.body.includes('Reload'), raced.body)
    assert.ok(raced.body.includes('<p>Spec: Feature</p>') && raced.body.includes('<p>Milestone: One</p>'), raced.body)
    // The validator refuses a superseded spec whatever the stored version is
    // doing, so a row that also moved gets the validator's sentence and no
    // button, and a closed target does not take the reason over either.
    current = { namespace: 'o/r', topLevel: false, superseded: true }
    data.assignments = [{ noteId: 'a', namespace: 'o/r', version: 9, implementers: [] }]
    const superseded = await call('/roadmap', 'POST', { ...card, version: '6' }, admin)
    assert.equal(superseded.status, 409)
    assert.ok(!superseded.body.includes('<form'), superseded.body)
    assert.ok(!superseded.body.includes("Someone else changed this spec's implementation plan"), superseded.body)
    assert.ok(superseded.body.includes('Spec is no longer available for assignment. Reload the board.'), superseded.body)
    const supersededClosed = await call('/roadmap', 'POST', { ...card, milestoneId: '2', version: '6' }, admin)
    assert.equal(supersededClosed.status, 409)
    assert.ok(supersededClosed.body.includes('Spec is no longer available for assignment.'), supersededClosed.body)
    assert.ok(!supersededClosed.body.includes('is closed.'), supersededClosed.body)
    // Nothing raced here, so the only thing separating this refusal from the
    // closed one is which of them the store raised.
    data.assignments = [{ noteId: 'a', namespace: 'o/r', version: 6, implementers: [] }]
    const supersededCurrent = await call('/roadmap', 'POST', { ...card, milestoneId: '2', version: '6' }, admin)
    assert.equal(supersededCurrent.status, 409)
    assert.ok(supersededCurrent.body.includes('Spec is no longer available for assignment.'), supersededCurrent.body)
    assert.ok(!supersededCurrent.body.includes('is closed.'), supersededCurrent.body)
    current = { namespace: 'o/r', topLevel: false }
    data.assignments = []
    // A login roles.yml does not list is refused by the same check on every
    // post, so the page names the spec it could not save and offers no button
    // that would send the identical post again.
    const outsider = await call('/roadmap', 'POST', { ...card, csrf: 'csrf-stranger' }, { login: 'stranger', uid: 'w' })
    assert.equal(outsider.status, 403)
    assert.ok(!outsider.body.includes('<form'), outsider.body)
    assert.ok(!outsider.body.includes('Save again'), outsider.body)
    assert.ok(outsider.body.includes('Only project approvers and board admins can manage implementation planning.'), outsider.body)
    assert.ok(outsider.body.includes('<p>Spec: Feature</p>') && outsider.body.includes('<p>Milestone: One</p>'), outsider.body)
    const expired = await call('/roadmap', 'POST', { ...card, csrf: 'stale' }, admin)
    assert.equal(expired.status, 403)
    assert.ok(expired.body.includes('Your session expired.'), expired.body)
    assert.ok(!expired.body.includes('CSRF'), expired.body)
    // The retry below carries a fresh token, so the page does not send a
    // signed-in reader to a sign-in they do not need.
    assert.ok(!/sign in/i.test(expired.body), expired.body)
    assert.ok(expired.body.includes('Save again'), expired.body)
    assert.ok(expired.body.includes('<p>Spec: Feature</p>') && expired.body.includes('<p>Milestone: One</p>'), expired.body)
    const cleared = await call('/roadmap', 'POST', { ...card, milestoneId: '', csrf: 'stale' }, admin)
    assert.ok(cleared.body.includes('<p>Milestone: No milestone</p>'), cleared.body)
    const implementer = await call('/roadmap', 'POST', { ...card, action: 'add-implementer', userId: 'u1', milestoneId: '', csrf: 'stale' }, admin)
    assert.ok(implementer.body.includes('<p>Spec: Feature</p>'), implementer.body)
    // An implementer post carries no milestone, so its refusal reads the plan
    // the spec is under and states it as context rather than as a change.
    assert.ok(implementer.body.includes('<p>Milestone: No milestone</p>'), implementer.body)
    assert.ok(implementer.body.includes('<h2>What you were saving</h2>'), implementer.body)
    assert.ok(!implementer.body.includes('What your save will apply'), implementer.body)
    data.assignments = [{ noteId: 'a', namespace: 'o/r', version: 3, milestoneId: '1', implementers: [{ id: 'u1', login: 'dev', name: 'Dev' }] }]
    const adding = await call('/roadmap', 'POST', { ...card, action: 'add-implementer', userId: 'u2', userLabel: '@second', milestoneId: '', csrf: 'stale' }, admin)
    assert.equal(adding.status, 403)
    assert.ok(adding.body.includes('<p>Spec: Feature</p>') && adding.body.includes('<p>Milestone: One</p>'), adding.body)
    // The person is not on the stored row yet, so the refusal names them from
    // the form, and the retry carries that name into its own refusal.
    assert.ok(adding.body.includes('<p>Implementer: @second</p>'), adding.body)
    assert.ok(adding.body.includes('<input type="hidden" name="userLabel" value="@second">'), adding.body)
    const unlabelled = await call('/roadmap', 'POST', { ...card, action: 'add-implementer', userId: 'u2', milestoneId: '', csrf: 'stale' }, admin)
    assert.ok(unlabelled.body.includes('<p>Implementer: u2</p>'), unlabelled.body)
    const crafted = await call('/roadmap', 'POST', { ...card, action: 'add-implementer', userId: 'u2', userLabel: '<b>' + 'x'.repeat(200), milestoneId: '', csrf: 'stale' }, admin)
    assert.ok(crafted.body.includes('<p>Implementer: &lt;b&gt;' + 'x'.repeat(77) + '</p>'), crafted.body)
    const removing = await call('/roadmap', 'POST', { ...card, action: 'remove-implementer', userId: 'u1', milestoneId: '', csrf: 'stale' }, admin)
    assert.ok(removing.body.includes('<p>Milestone: One</p>') && removing.body.includes('<p>Implementer: @dev</p>'), removing.body)
    const racedAdd = await call('/roadmap', 'POST', { ...card, action: 'add-implementer', userId: 'u2', milestoneId: '' }, admin)
    assert.equal(racedAdd.status, 409)
    assert.ok(racedAdd.body.includes('Apply my changes on top'), racedAdd.body)
    assert.ok(racedAdd.body.includes('<p>Milestone: One</p>'), racedAdd.body)
    assert.ok(racedAdd.body.includes('<h2>What you were saving</h2>'), racedAdd.body)
    const awayAdd = await call('/roadmap', 'POST', { ...card, action: 'add-implementer', userId: 'u2', milestoneId: '' })
    assert.equal(awayAdd.status, 401)
    assert.ok(!awayAdd.body.includes('<form'), awayAdd.body)
    assert.ok(awayAdd.body.includes('<p>Spec: Feature</p>') && awayAdd.body.includes('<p>Milestone: One</p>'), awayAdd.body)
    assert.ok(!awayAdd.body.includes('Your unsaved changes'), awayAdd.body)
    data.assignments = []
    const signedOut = await call('/roadmap', 'POST', card)
    assert.equal(signedOut.status, 401)
    assert.ok(!signedOut.body.includes('<form'), signedOut.body)
    // the unsaved list names the milestone the reader picked, not its row id
    assert.equal((signedOut.body.match(/<p>Milestone: One<\/p>/g) || []).length, 1)
    assert.ok(!signedOut.body.includes('Milestone: 1'), signedOut.body)
    assert.ok(signedOut.body.includes('<p>Spec: Feature</p>'), signedOut.body)
    // Clearing the milestone posts it empty, and that emptiness is the change,
    // so the list still separates removing a milestone from setting one.
    const signedOutCleared = await call('/roadmap', 'POST', { ...card, milestoneId: '' })
    assert.equal(signedOutCleared.status, 401)
    assert.ok(signedOutCleared.body.includes('<p>Spec: Feature</p>'), signedOutCleared.body)
    assert.equal((signedOutCleared.body.match(/<p>Milestone: No milestone<\/p>/g) || []).length, 1, signedOutCleared.body)
    data.milestones.pop()
  }
  const fields = { csrf: 'csrf-admin', ns: 'o/r', action: 'milestone', noteId: 'a', version: '0', milestoneId: '1' }
  assert.equal((await call('/roadmap')).status, 200)
  assert.equal(deletedReads, 0)
  assert.deepEqual(scope, { namespaces: ['o/r'], noteIds: null })
  assert.equal((await call('/roadmap?login=1')).headers.location, 'login:/roadmap')
  assert.equal((await call('/roadmap', 'POST', fields)).status, 401)
  assert.equal((await call('/roadmap', 'POST', { ...fields, csrf: 'wrong' }, admin)).status, 403)
  assert.equal((await call('/roadmap', 'POST', { ...fields, csrf: 'csrf-guest' }, { login: 'guest' })).status, 403)
  const setMilestone = await call('/roadmap', 'POST', fields, admin)
  assert.equal(setMilestone.status, 302)
  assert.equal(setMilestone.headers.location, '/roadmap?ns=o%2Fr&spec=a&saved=spec-milestone')
  assert.equal(assigned.noteId, 'a')
  // a save posted from a board card lands back on the board it came from
  // stage is browser state, so it never rides the return address
  const returned = await call('/roadmap', 'POST', { ...fields, next: 'board', nextQuery: 'ns=o/r&milestone=1&stage=approved' }, admin)
  assert.equal(returned.status, 302)
  assert.equal(returned.headers.location, '/?ns=o%2Fr&milestone=1&saved=spec-milestone&spec=a#spec-a')
  const filtered = await call('/roadmap', 'POST', { ...fields, next: 'board', nextQuery: 'q=lease&evil=http://elsewhere&saved=members' }, admin)
  assert.equal(filtered.headers.location, '/?q=lease&saved=spec-milestone&spec=a#spec-a')
  const unfiltered = await call('/roadmap', 'POST', { ...fields, next: 'board', nextQuery: '' }, admin)
  assert.equal(unfiltered.headers.location, '/?saved=spec-milestone&spec=a#spec-a')
  const elsewhere = await call('/roadmap', 'POST', { ...fields, next: 'evil', nextQuery: 'ns=o/r' }, admin)
  assert.equal(elsewhere.headers.location, '/roadmap?ns=o%2Fr&spec=a&saved=spec-milestone')
  const refusedOnBoard = await call('/roadmap', 'POST', { ...fields, csrf: 'wrong', next: 'board', nextQuery: 'ns=o/r' }, admin)
  assert.equal(refusedOnBoard.status, 403)
  // the way back is the board the form carried, and the refusal wears the board's shell
  assert.ok(refusedOnBoard.body.trimEnd().endsWith('<p><a href="/?ns=o%2Fr">Back to the board</a></p>'), refusedOnBoard.body)
  assert.ok(!refusedOnBoard.body.includes('Back to planning'), refusedOnBoard.body)
  assert.equal(shell.page, 'board-prose')
  assert.ok(replay(refusedOnBoard.body).some(([name, value]) => name === 'nextQuery' && value === 'ns=o/r'), refusedOnBoard.body)
  const refusedFiltered = await call('/roadmap', 'POST', { ...fields, csrf: 'wrong', next: 'board', nextQuery: 'ns=o/r&q=lease&evil=x&saved=members&spec=b' }, admin)
  assert.ok(refusedFiltered.body.includes('<a href="/?ns=o%2Fr&amp;q=lease">Back to the board</a>'), refusedFiltered.body)
  const refusedOnPlanning = await call('/roadmap', 'POST', { ...fields, csrf: 'wrong' }, admin)
  assert.ok(refusedOnPlanning.body.includes('Back to planning'), refusedOnPlanning.body)
  assert.equal(shell.page, 'planning')
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
  const implementerAdded = await call('/roadmap', 'POST', { ...fields, action: 'add-implementer', userId: 'u1' }, admin)
  assert.equal(implementerAdded.status, 302)
  assert.ok(implementerAdded.headers.location.includes('saved=implementer-added'), implementerAdded.headers.location)
  assert.equal(assigned.userId, 'u1')
  const detachFields = { ...fields, action: 'detach-deleted', noteId: 'gone', version: '3' }
  assert.equal((await call('/roadmap', 'POST', detachFields)).status, 401)
  assert.equal((await call('/roadmap', 'POST', { ...detachFields, csrf: 'bad' }, admin)).status, 403)
  assert.equal((await call('/roadmap', 'POST', { ...detachFields, csrf: 'csrf-guest' }, { login: 'guest' })).status, 403)
  assert.equal((await call('/roadmap', 'POST', { ...detachFields, version: '2' }, admin)).status, 409)
  assert.equal((await call('/roadmap', 'POST', detachFields, admin)).headers.location, '/roadmap?ns=o%2Fr&saved=detached')
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
  // a panel opened from a board card closes onto that board, filters and all
  const fromBoard = await call('/roadmap?ns=o/r&spec=a&next=board&nextQuery=' + encodeURIComponent('ns=o/r&implementer=u1&stage=approved&evil=x'), 'GET', {}, admin)
  assert.equal(fromBoard.status, 200)
  assert.ok(fromBoard.body.includes('<a href="/?ns=o%2Fr&amp;implementer=u1">Back to the board</a>'), fromBoard.body)
  assert.ok(!(await call('/roadmap?ns=o/r&spec=a', 'GET', {}, admin)).body.includes('Back to the board'))
  // A namespace the poller has never warmed, because it holds no specs: the
  // planning render reads live and still offers the create form, while the
  // board's cache-only read stands down.
  rolesCold = true
  const cold = await call('/roadmap?ns=o/r', 'GET', {}, reviewer)
  assert.ok(cold.body.includes('<summary>Create a milestone</summary>'), cold.body)
  assert.ok(!cold.body.includes('Only project approvers and board admins can add or edit milestones'), cold.body)
  assert.deepEqual(await service.manageable(reviewer, 'o/r'), ['o/r'])
  assert.deepEqual(await service.manageable(reviewer, 'o/r', true), [])
  rolesCold = false
  const milestone = { csrf: 'csrf-admin', ns: 'o/r', action: 'save-milestone', version: '0', title: 'First', dueDate: '2028-02-29', checkpointTag: 'specs/v1' }
  const created = await call('/roadmap', 'POST', milestone, admin)
  assert.equal(created.status, 302)
  assert.ok(created.headers.location.includes('saved=milestone-created'), created.headers.location)
  assert.ok(created.headers.location.includes('#milestone-1'), created.headers.location)
  assert.ok(!created.headers.location.includes('milestone='), created.headers.location)
  assert.equal(saved.checkpoint.commit, 'a'.repeat(40))
  assert.equal((await call('/roadmap', 'POST', { ...milestone, checkpointTag: 'specs/v9' }, admin)).status, 400)
  data.milestones[0].checkpointTag = 'specs/v9'
  data.milestones[0].checkpointCommit = 'b'.repeat(40)
  const before = checkpointCalls.length
  const renamed = await call('/roadmap', 'POST', { ...milestone, id: '1', version: '1', title: 'Renamed', state: 'closed', checkpointTag: 'specs/v9' }, admin)
  assert.equal(renamed.status, 302)
  assert.ok(renamed.headers.location.includes('saved=milestone-saved'), renamed.headers.location)
  assert.equal(saved.checkpoint.commit, 'b'.repeat(40))
  assert.equal(checkpointCalls.length, before)
  assert.equal((await call('/roadmap', 'POST', { ...milestone, id: '1', version: '0' }, admin)).status, 409)
  assignedAll = []
  const membership = [['csrf', 'csrf-admin'], ['ns', 'o/r'], ['action', 'save-milestone'], ['id', '1'], ['version', '1'], ['title', 'Renamed'], ['checkpointTag', 'specs/v9'],
    ['spec', 'a:0'], ['spec', 'b:0'], ['member', 'b:0'], ['member', 'c:0']]
  const membershipSave = await call('/roadmap', 'POST', membership, admin)
  assert.equal(membershipSave.status, 302)
  assert.ok(membershipSave.headers.location.includes('saved=members&added=1&removed=1'), membershipSave.headers.location)
  assert.deepEqual(assignedAll.map(a => [a.noteId, a.milestoneId]), [['a', '1'], ['c', null]], 'ticked joins, unticked leaves, unchanged is untouched')
  assert.equal((await call('/roadmap', 'POST', [...membership, ['spec', 'bad id:0']], admin)).status, 400)
  assert.equal((await call('/roadmap', 'POST', [...membership, ['spec', 'd:1']], admin)).status, 409)
  const gone = await call('/roadmap', 'POST', { csrf: 'csrf-admin', ns: 'o/r', action: 'delete-milestone', id: '1', version: '1' }, admin)
  assert.equal(gone.status, 302)
  assert.equal(gone.headers.location, '/roadmap?ns=o%2Fr&saved=milestone-deleted')
  assert.deepEqual(removed, { id: '1', namespace: 'o/r', expectedVersion: 1, actor: 'admin' })
  assert.equal((await call('/roadmap', 'POST', { csrf: 'csrf-admin', ns: 'o/r', action: 'delete-milestone', id: 'x', version: '1' }, admin)).status, 400)
  assert.equal((await call('/roadmap', 'POST', { csrf: 'csrf-guest', ns: 'o/r', action: 'delete-milestone', id: '1', version: '1' }, { login: 'guest' })).status, 403)
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
  data.milestones = [{ id: '1', namespace: 'o/r', title: 'One', description: '', state: 'open', version: 1 }]
  specs.length = 1
  await recovery()
  await specRowRecovery()
  await refusals()
  await assignmentRefusals()
  assert.equal((await call('/roadmap?ns=o/r&milestone=9')).status, 302)
  assert.equal((await call('/roadmap?ns=o/r&milestone=9')).headers.location, '/roadmap?ns=o%2Fr')
  assert.equal((await call('/api/milestones/9')).status, 404)
  assert.equal(JSON.parse((await call('/api/milestones/9')).body).error, 'Unknown milestone.')
  deps.loginEnabled = false
  deps.session = () => { throw new Error('No session secret is configured') }
  assert.equal((await call('/roadmap')).status, 200)
  assert.equal((await call('/roadmap', 'POST', fields, admin)).status, 503)
  console.log('roadmap service tests passed')
}
main().catch(e => { console.error(e); process.exitCode = 1 })
