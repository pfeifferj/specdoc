const assert = require('assert')
const crypto = require('crypto')
const { createFeedbackService } = require('./feedback-service')
const { createFeedbackGitHub } = require('./feedback-github')

const hash = body => crypto.createHash('sha256').update(body).digest('hex')
const body = '# Recovery\nRecover state after a restart.\n'
const canonical = { commit: 'a'.repeat(40), blob: 'b'.repeat(40), body, hash: hash(body), path: 'specs/012-recovery.md' }
const owner = { uid: 'owner', login: 'alice' }
const roles = { approvers: ['alice'], 'feedback-bot': 'reviewer', 'implementation-repos': ['o/app'] }
const evidence = { repo: 'o/app', number: 9, mergedAt: new Date().toISOString(), headSha: 'c'.repeat(40), mergeSha: 'd'.repeat(40),
  body: 'implements o/specs#12', links: [{ ns: 'o/specs', n: 12 }], hash: 'source-v1',
  groups: [{ id: 'thread:1', entries: [{ id: 'inline:1', author: 'alice', body: 'Recover the journal before accepting writes.', url: 'https://github.com/o/app/pull/9#discussion_r1' }] }],
  files: [{ path: 'state.js', patch: '@@ -0,0 +1,2 @@\n+recoverJournal()\n+acceptWrites()' }] }
const output = { proposals: [{ targetNote: 'note', groupId: 'thread:1', anchor: 'note#Recovery', quote: 'Recover state after a restart.',
  amendment: 'Recover the journal before accepting writes.', rationale: 'Recovery ordering was missing.',
  sources: [{ id: 'inline:1', quote: 'Recover the journal before accepting writes.' }], finalEvidence: { path: 'state.js', quote: 'recoverJournal()\nacceptWrites()' } }] }

function fixture () {
  const f = { settings: { enabled: true, generation: 0 }, source: structuredClone(evidence), permissions: roles, manual: false,
    writes: [], failures: [], models: 0, providers: 0, proposals: [], analysisExists: false, roleReads: [] }
  f.spec = { id: 'note', namespace: 'o/specs', title: 'Recovery', ownerId: 'owner', statusIdx: 3, content: body, url: 'https://editor/note' }
  f.state = new Map([['note', { namespace: 'o/specs', pr_number: 12, pr_state: 'merged', spec_path: canonical.path }]])
  const job = () => ({ id: '1', namespace: 'o/specs', repo: 'o/app', number: 9, manual: f.manual })
  f.store = {
    settings: async () => ({ ...f.settings }), scan: async () => f.scan || null, saveScan: async (key, scan) => { f.scan = scan },
    due: async () => !f.dormant && (f.settings.enabled || f.manual) ? [job()] : [],
    saveEvidence: async () => {}, analysisExists: async () => f.analysisExists,
    recordAnalysis: async (j, run) => {
      if (j.manual || (f.settings.enabled && run.settingsGeneration === f.settings.generation)) {
        f.writes.push(run); f.proposals = run.proposals
      }
      return { stored: true }
    },
    finish: async (j, mergedAt) => { f.finished = { job: j, mergedAt } },
    waitForMerge: async () => { f.dormant = true },
    defer: async () => {}, fail: async (j, e) => f.failures.push(e.message), unavailable: async () => {},
    cleanup: async () => {}, status: async () => ({ pending: f.proposals.length }),
    queued: async () => [], markPlaced: async () => 0,
    problems: async () => [],
    toggle: async (ns, enabled, actor) => { f.settings = { enabled, generation: f.settings.generation + 1 }; f.toggle = { ns, actor } }
  }
  const deps = {
    store: f.store, namespaces: ['o/specs'], gh: async () => { throw new Error('unexpected network') },
    roles: async (ns, refresh = false) => { f.roleReads.push(refresh); return f.permissions }, getBots: async () => [{ name: 'reviewer', namespaces: ['o/specs'], model: 'model', url: 'https://model' }],
    getSpecs: async () => [f.spec], getState: async () => f.state, hashBody: s => hash(s.content), getBody: s => s.content, publicSpec: s => !s.private,
    session: req => req.user, csrfToken: login => 'csrf:' + login, isAdmin: s => s.login === 'admin',
    readBody: async req => req.body, startLogin: (req, res) => res.writeHead(302).end(),
    redirect: (res, location) => res.writeHead(302, { Location: location }).end(), basicPage: (title, html) => html,
    createProvider: () => ({
      get calls () { return f.providers }, get remaining () { return (f.budget || 64) - f.providers },
      preflight: async () => { f.preflights = (f.preflights || 0) + 1; f.providers++; if (f.preflightError) throw f.preflightError },
      discover: async () => { f.providers++; return { items: [], scan: { complete: true, reconcileAt: Date.now() + 86400000 }, complete: true } },
      evidence: async () => { f.providers++; if (f.onEvidence) f.onEvidence(); return f.source },
      publicRepo: async repo => { f.providers++; return !(repo === 'o/specs' ? f.privateTarget : f.privateSource) },
      baseline: async () => { f.providers++; return canonical },
      mergedRevision: async (ns, number, path) => ns === 'o/specs' && number === 25 && path === canonical.path
    })
  }
  f.deps = deps
  f.service = createFeedbackService(deps)
  f.tick = async () => f.service.tick({ specs: [f.spec], state: f.state, bots: await deps.getBots(), modelCall: async () => {
    f.models++; if (f.onModel) f.onModel(); return structuredClone(output)
  } })
  f.request = async (path, form, user = owner) => {
    const res = { code: 0, body: '', writeHead (code, headers = {}) { this.code = code; this.headers = headers; return this }, end (text = '') { this.body = text; return this } }
    await f.service.handle({ method: form ? 'POST' : 'GET', user, body: new URLSearchParams(form || {}).toString() }, res, new URL('https://board' + path))
    return res
  }
  return f
}

async function main () {
  {
    const f = fixture()
    f.settings.enabled = false
    await f.tick()
    assert.strictEqual(f.providers, 0)
    assert.strictEqual(f.models, 0)
  }
  {
    const f = fixture()
    await f.tick()
    assert.strictEqual(f.models, 1)
    assert.strictEqual(f.writes.length, 1)
    assert.strictEqual(f.proposals[0].targetNote, 'note')
    assert.strictEqual(f.spec.content, body)
    assert.strictEqual(f.state.get('note').pr_number, 12)
  }
  {
    const f = fixture()
    f.onEvidence = () => { f.settings.enabled = false; f.settings.generation++ }
    await f.tick()
    assert.strictEqual(f.models, 0, 'a toggle before dispatch prevents the model request')
  }
  {
    const f = fixture()
    f.store.due = async () => []
    f.preflightError = Object.assign(new Error('GitHub feedback request failed (403)'), { code: 'inaccessible' })
    await f.tick()
    assert.strictEqual(f.scan, undefined, 'failed preflight must not advance discovery')
    assert.strictEqual(f.service.status.discoveryFailures, 1)
    f.preflightError = null
    await f.tick()
    assert.strictEqual(f.service.status.discoveryFailures, 0)
    assert.strictEqual(f.service.status.discoveryError, null)
    await f.tick()
    assert.strictEqual(f.preflights, 2, 'successful preflight is reused until daily reconciliation')
    f.scan.reconcileAt = Date.now() - 1
    await f.tick()
    assert.strictEqual(f.preflights, 3)
  }
  {
    const f = fixture()
    f.onModel = () => { f.settings.enabled = false; f.settings.generation++ }
    await f.tick()
    assert.strictEqual(f.writes.length, 0, 'in-flight results carry the original settings generation')
  }
  {
    const f = fixture()
    f.settings.enabled = false; f.manual = true; f.analysisExists = true
    f.source.mergedAt = '2020-01-01T00:00:00Z'
    await f.tick()
    assert.strictEqual(f.models, 0)
    assert.ok(f.finished, 'an unchanged historical import must finish its one-off refresh')
  }
  for (const state of ['open', 'closed']) {
    const f = fixture()
    f.deps.createProvider = createFeedbackGitHub
    let merged = false
    const calls = []
    f.deps.gh = async (method, path) => {
      calls.push(path)
      if (path === '/repos/o/app' || path === '/repos/o/specs') return { private: false, default_branch: 'master' }
      if (path.endsWith('per_page=1')) return []
      if (path.startsWith('/repos/o/app/issues?')) return [{ id: 9, number: 9, updated_at: new Date().toISOString(), pull_request: {}, body: 'implements o/specs#12' }]
      if (path === '/repos/o/app/pulls/9') return { state, body: 'implements o/specs#12', head: { sha: 'c'.repeat(40) },
        merged_at: merged ? evidence.mergedAt : null, merge_commit_sha: merged ? 'd'.repeat(40) : null }
      if (path.includes('/files?')) return [{ filename: 'state.js', patch: '@@ -0,0 +1 @@\n+recoverJournal()' }]
      if (/\/(reviews|comments)\?/.test(path)) return []
      if (path === '/repos/o/specs/commits/master') return { sha: canonical.commit }
      if (path.startsWith('/repos/o/specs/contents/')) return { type: 'file', encoding: 'base64', content: Buffer.from(body).toString('base64'), sha: canonical.blob }
      throw new Error('unexpected provider route: ' + path)
    }
    f.dormant = true
    f.store.saveScan = async (key, scan, jobs) => { f.scan = scan; if (jobs.length) f.dormant = false }
    const specs = [f.spec]
    if (state === 'open') {
      for (let n = 0; n < 12; n++) {
        const id = `principle-${n}`
        specs.push({ ...f.spec, id, topLevel: true })
        f.state.set(id, { namespace: 'o/specs', pr_state: 'merged', spec_path: `principles/${n}.md` })
      }
    }
    f.deps.getSpecs = async () => specs
    const service = createFeedbackService(f.deps)
    const tick = async () => service.tick({ specs, state: f.state, bots: await f.deps.getBots(), modelCall: async () => { f.models++ } })
    await tick()
    assert.strictEqual(f.dormant, true, 'unmerged PRs wait for discovery updates')
    assert.deepStrictEqual(f.failures, [])
    assert.strictEqual(f.models, 0)
    assert.ok(!calls.some(path => path.includes('/reviews?')))
    merged = true; f.scan.nextAt = 0
    await tick()
    assert.ok(calls.some(path => path.includes('/reviews?')), 'a merged discovery update resumes evidence collection')
    assert.deepStrictEqual(f.failures, [])
    assert.strictEqual(f.writes.length, 1)
    assert.strictEqual(calls.filter(path => path.endsWith('/commits/master')).length, 2, 'each snapshot pins one HEAD even for thirteen targets')
  }
  {
    const f = fixture()
    f.onModel = () => { f.spec.content += 'Concurrent edit.\n' }
    await f.tick()
    assert.strictEqual(f.writes.length, 0)
    assert.match(f.failures[0], /spec changed/)
  }
  {
    const f = fixture()
    f.budget = 5
    await f.tick()
    assert.strictEqual(f.models, 0, 'reserve enough requests to validate after the model call')
    assert.match(f.failures[0], /request budget/)
  }
  {
    const f = fixture()
    assert.strictEqual((await f.request('/feedback/settings', { csrf: 'bad', namespace: 'o/specs' })).code, 403)
    assert.strictEqual((await f.request('/feedback/settings', { csrf: 'csrf:outsider', namespace: 'o/specs' }, { login: 'outsider' })).code, 403)
    assert.strictEqual((await f.request('/feedback/settings', { csrf: 'csrf:alice', namespace: 'o/specs' })).code, 302)
    assert.strictEqual(f.settings.enabled, false)
    assert.deepStrictEqual(f.toggle, { ns: 'o/specs', actor: 'alice' })
    f.permissions = null
    assert.strictEqual((await f.request('/feedback/settings', { csrf: 'csrf:alice', namespace: 'o/specs', enabled: 'on' })).code, 403)
    assert.strictEqual(f.spec.content, body)
    assert.strictEqual((await f.request('/feedback')).code, 302, 'the old inbox route sends people to settings')
  }
  {
    const f = fixture()
    const queued = [{ id: '7', targetNote: 'note', targetNamespace: 'o/specs', quote: 'Recover state after a restart.',
      amendment: 'Recover the journal before accepting writes.', rationale: 'Ordering.', job: { repo: 'o/app', number: 9 } }]
    f.store.queued = async () => queued
    const marks = []
    f.store.markPlaced = async (ids, status) => { if (ids.length) marks.push([ids, status]) }
    let applied = null
    f.deps.applyProposals = async (spec, group, bot) => { applied = { spec: spec.id, ids: group.map(p => p.id), bot }; return { placed: ['7'], commented: [] } }
    await f.tick()
    assert.deepStrictEqual(applied, { spec: 'note', ids: ['7'], bot: 'reviewer' })
    assert.deepStrictEqual(marks, [[['7'], 'placed']])
    marks.length = 0
    f.deps.applyProposals = async () => null
    await f.tick()
    assert.deepStrictEqual(marks, [], 'a busy note keeps its proposals queued')
    f.settings.enabled = false
    f.deps.applyProposals = async () => { throw new Error('must not place while paused') }
    await f.tick()
    assert.deepStrictEqual(marks, [])
    f.settings.enabled = true
    f.state.get('note').superseded_at = 'now'
    await f.tick()
    assert.deepStrictEqual(marks, [[['7'], 'unplaced']], 'a retired target parks its proposals')
  }
  console.log('feedback service ok')
}

main().catch(e => { console.error(e); process.exitCode = 1 })
