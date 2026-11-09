const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { Readable } = require('node:stream')

process.env.NAMESPACES = 'team/specs,other/specs'
process.env.BOARD_ADMIN_IDS = '42'
process.env.SESSION_SECRET = 'consistency-fixture'
process.env.BOARD_OAUTH_CLIENT_ID = 'fixture'
process.env.BOARD_OAUTH_CLIENT_SECRET = 'fixture'
process.env.SPEC_BOARD_BASE_URL = 'https://board.test'

function fixture () {
  const file = path.join(__dirname, 'server.js')
  const loaded = new Module(file + '.consistency-test', module)
  loaded.filename = file
  loaded.paths = Module._nodeModulePaths(__dirname)
  loaded._compile(fs.readFileSync(file, 'utf8') + `
    module.exports.fixture = {
      run: typeof runConsistencyReview === 'function' ? runConsistencyReview : null,
      post: typeof consistencyPost === 'function' ? consistencyPost : null,
      source: typeof consistencySources === 'function' ? consistencySources : null,
      csrfToken, signToken, generatedFinding, publishedHash, publishedBody, specsFromRows, consistencyView, botsGet,
      delivery: read => { reviewCurrentSource = read; },
      bots: read => { listBotsForForm = read; },
      inputFailure: () => { if (typeof consistencyInput === 'function') consistencyInput = async () => { throw new Error('Read unavailable') }; },
      sources: (rows, state, roles, allowed) => {
        const calls = { notes: 0, state: 0, policies: [] };
        queryNotes = async () => { calls.notes++; return rows; };
        loadState = async () => { calls.state++; return state; };
        feedbackRoles = async (namespace, refresh, cacheOnly) => { calls.policies.push({namespace,refresh,cacheOnly}); return roles; };
        pool.query = async (_sql, params) => ({rows: params[0].filter(id => allowed.includes(id)).map(shortid => ({shortid}))});
        return calls;
      },
      resolved: value => { pool.query = async (_sql, params) => ({rows: params[0].map(id => ({id,resolved:value}))}); },
      setup: (read, bot, call, save) => {
        if (typeof consistencySources === 'function') consistencySources = read;
        if (typeof consistencyInput === 'function') consistencyInput = async () => ({ specs: [], state: new Map() });
        loadBots = async () => bot ? [bot] : [];
        callBotJson = call;
        reviewService.recordFinding = save;
        reviewCurrentSource = async id => ({id,namespace:'team/specs'});
        pool.connect = async () => ({query: async () => ({rows:[{locked:true}]}),release:()=>{},on:()=>{},removeListener:()=>{}});
      }
    };`, file)
  return loaded.exports.fixture
}
const bot = { name: 'reviewer', model: 'fixture', url: 'https://model.test', namespaces: ['team/specs'] }
const source = (id, stage = 'draft', extra = {}) => ({ id, title: id, url: 'https://editor.test/' + id,
  namespace: 'team/specs', ownerSubject: '7', content: `# ${id}\n\n**FR-001**: Strings remain strings in ${id}.`,
  body: `# ${id}\n\n**FR-001**: Strings remain strings in ${id}.`, stage, area: 'core', kind: 'feature',
  dependsOn: [], supersedes: null, ...extra })
const context = sources => ({ sources, key: JSON.stringify(sources) })
const actor = () => ({ purpose: 'board-session', provider: 'github', subject: '42', login: 'admin',
  authenticatedAt: Date.now(), exp: Date.now() + 60000 })
const response = () => ({ status: null, headers: {}, body: '', writeHead (status, headers = {}) { this.status = status; this.headers = headers; return this }, end (body = '') { this.body = body; return this } })
function request (api, who, fields) {
  const req = Readable.from([new URLSearchParams(fields).toString()])
  req.headers = { accept: 'application/json', ...(who ? { cookie: 'sb_session=' + api.signToken(who) } : {}) }
  req.method = 'POST'
  return req
}

test('manual consistency reviews compare unpublished specs in every active lifecycle and rerun unchanged content', async () => {
  const api = fixture()
  const sources = ['draft', 'ready-for-review', 'in-review', 'approved', 'implemented'].map((stage, i) => source('note' + i, stage))
  let calls = 0
  api.setup(async () => context(sources), bot, async (selected, system, input) => {
    calls++
    for (const stage of sources.map(s => s.stage)) assert.ok(input.includes(stage))
    assert.match(system, /propos/i)
    assert.ok(!input.includes('spec ???'))
    assert.deepEqual(selected.contextIds.sort(), sources.map(s => s.id).sort())
    return { overlaps: [] }
  })
  assert.equal(typeof api.run, 'function', 'an explicit consistency review must not depend on publication or review status')
  const first = await api.run('team/specs')
  assert.equal(first.compared, 5)
  assert.equal(first.ran, true)
  assert.equal(first.stale, false)
  await api.run('team/specs')
  assert.equal(calls, 2)
})

test('even an empty model result is stale when a source changes during the review', async () => {
  const api = fixture()
  let sources = [source('model'), source('format')]
  api.setup(async () => context(sources), bot, async () => {
    sources = [source('model', 'approved'), source('format')]
    return { overlaps: [] }
  })
  assert.equal(typeof api.run, 'function')
  const result = await api.run('team/specs')
  assert.equal(result.stale, true)
  assert.deepEqual(result.findings, [])
})

test('manual findings use shared clause identity and keep an existing discussion resolved', async () => {
  const api = fixture()
  const sources = [source('model'), source('format')]
  let saved
  api.setup(async () => context(sources), bot, async () => ({ overlaps: [{a: 1,b: 2,kind:'conflict',why:'The two clauses disagree.',
    aQuote:'Strings remain strings in format.',bQuote:'Strings remain strings in model.'}] }), async finding => {
    saved = finding
    return {threadId:'17',resolved:true,created:false}
  })
  assert.equal(typeof api.run, 'function')
  const result = await api.run('team/specs')
  assert.equal(result.findings[0].resolved, true)
  assert.equal(saved.producer, 'consistency')
  const previous = api.generatedFinding(bot, 'checkpoint', saved.kind, saved.body, sources.map(spec => ({spec,supplied:spec.body,quote:`Strings remain strings in ${spec.id}.`})))
  assert.equal(saved.findingKey, previous.findingKey)
})

test('admin authentication, CSRF and the configured project are checked before starting a run', async () => {
  const api = fixture(), who = actor()
  let calls = 0
  api.setup(async () => { calls++; return context([]) }, bot, async () => ({overlaps:[]}))
  assert.equal(typeof api.post, 'function')
  for (const [user, fields, status] of [[null, {}, 401], [{...who,subject:'43'}, {},403], [who,{ns:'team/specs',csrf:'bad'},403], [who,{ns:'other/unknown',csrf:api.csrfToken(who)},400]]) {
    const res = response()
    await api.post(request(api,user,fields),res)
    assert.equal(res.status,status)
  }
  assert.equal(calls,0)
})

test('fresh source discovery excludes withdrawn, retired and unadmitted notes and distinguishes published principles', async () => {
  const api = fixture()
  const roles = { authors: [{id:'7',login:'writer'}],approvers:[{id:'8',login:'reviewer'}],'approvals-required':1 }
  const note = (id, tags = 'draft', extra = {}) => ({shortid:id, title:id, permission:'editable', owner_profileid:'github:7',
    owner_profile:JSON.stringify({provider:'github',id:'7',username:'writer'}),
    content:`---\ntags: [spec, ${tags}]\nnamespace: team/specs\n${id === 'principles' ? 'kind: top-level\n' : ''}---\n# ${id}\n\nRequirements stay explicit.`, ...extra})
  const rows = [note('draft'), note('ready','ready-for-review'), note('review','in-review'), note('principles','approved'),
    note('shipped','implemented'), note('private','draft',{permission:'private'}), note('hidden'), note('suspended'),
    note('retired'), note('incomplete-retirement'), note('outsider','draft',{owner_profileid:'github:99',owner_profile:JSON.stringify({provider:'github',id:'99'})}),
    note('withdrawn','draft',{content:'# No longer a specification'}),note('other','draft',{content:'---\ntags: [spec, draft]\nnamespace: other/specs\n---\nOther project'})]
  const state = new Map([['retired',{superseded_at:'2026-11-09',supersession_receipt:{noteId:'draft'}}],['incomplete-retirement',{superseded_at:'2026-11-09'}]])
  const principle = api.specsFromRows([rows[3]], state)[0]
  state.set('principles',{pr_number:3,pr_state:'merged',publication_receipt:{},published_hash:api.publishedHash(api.publishedBody(principle))})
  api.sources(rows,state,roles,rows.filter(row=>!['hidden','suspended'].includes(row.shortid)).map(row=>row.shortid))
  const result = await api.source('team/specs')
  assert.deepEqual(result.sources.map(s=>s.id),['draft','incomplete-retirement','principles','ready','review','shipped'])
  assert.equal(result.sources.find(s=>s.id==='principles').governing,true)
  assert.equal(result.sources.find(s=>s.id==='draft').governing,false)
  rows[3].content += '\nA proposed revision.'
  const revised = await api.source('team/specs')
  assert.equal(revised.sources.find(s=>s.id==='principles').governing,false)
  assert.notEqual(result.key,revised.key)
})

test('the corpus omits whole oversized sources and bounds UTF-8 bytes', () => {
  const {consistencyCorpus} = require('./consistency-corpus')
  const sources = [source('a','approved',{kind:'top-level',governing:true}), source('b','draft',{dependsOn:['a'],supersedes:'a'}),
    source('huge','draft',{body:'€'.repeat(1000)})]
  const corpus = consistencyCorpus(sources,700)
  assert.ok(Buffer.byteLength(corpus.text)<=700)
  assert.deepEqual(corpus.supplied.map(s=>s.id),['a','b'])
  assert.deepEqual(corpus.omitted.map(s=>s.id),['huge'])
  assert.match(corpus.text,/"dependsOn":\[1\],"supersedes":1/)
  assert.ok(!corpus.text.includes('�'))
})

test('unsupported evidence and failed discussion saves are counted as incomplete', async () => {
  const api = fixture()
  const sources = [source('model'),source('format')]
  const good = {a:1,b:2,kind:'conflict',why:'Requirements disagree.',aQuote:'Strings remain strings in format.',bQuote:'Strings remain strings in model.'}
  api.setup(async()=>context(sources),bot,async()=>({overlaps:[{...good,a:90},{...good,aQuote:'An invented quotation.'},good]}),async()=>null)
  const result = await api.run('team/specs')
  assert.equal(result.rejected,2)
  assert.equal(result.failed,1)
  assert.deepEqual(result.findings,[])
})

test('new sources, removed sources and model changes invalidate even an empty response', async () => {
  for (const change of ['new','removed','model']) {
    const api = fixture(), selected = {...bot}
    let sources = [source('model'),source('format')]
    api.setup(async()=>context(sources),selected,async()=>{
      if(change==='new') sources=[...sources,source('new')]
      if(change==='removed') sources=sources.slice(1)
      if(change==='model') selected.model='changed'
      return {overlaps:[]}
    })
    assert.equal((await api.run('team/specs')).stale,true,change)
  }
})

test('a stale run reports discussions already created without retaining source links', async () => {
  const api = fixture()
  let sources = [source('model'),source('format')]
  api.setup(async()=>context(sources),bot,async()=>({overlaps:[{a:1,b:2,kind:'conflict',why:'Requirements disagree.',aQuote:'Strings remain strings in format.',bQuote:'Strings remain strings in model.'}]}),async()=>{
    sources=[...sources,source('new')]
    return {threadId:'17',created:true,resolved:false}
  })
  const result = await api.run('team/specs')
  assert.equal(result.stale,true)
  assert.equal(result.saved,1)
  assert.deepEqual(result.findings,[])
})

test('GET view refreshes resolution without invoking the model', async () => {
  const api = fixture(), sources=[source('model'),source('format')]
  let calls=0
  api.setup(async()=>context(sources),bot,async()=>{ calls++; return {overlaps:[{a:1,b:2,kind:'conflict',why:'Requirements disagree.',aQuote:'Strings remain strings in format.',bQuote:'Strings remain strings in model.'}]} },async()=>({threadId:'17',resolved:false,created:true}))
  await api.run('team/specs')
  api.resolved(true)
  const view = await api.consistencyView('team/specs')
  assert.equal(view.result.findings[0].resolved,true)
  assert.equal(calls,1)
})

test('cooldown and exhausted budget errors are explicit and do not expose provider details', async () => {
  for(const error of [Object.assign(new Error('Model trigger is cooling down'),{code:'budget'}),Object.assign(new Error('Daily model budget exhausted'),{code:'budget'}),new Error('https://secret-model.test provider-secret')]) {
    const api=fixture(),who=actor(),res=response()
    api.setup(async()=>context([source('model'),source('format')]),bot,async()=>{throw error})
    await api.post(request(api,who,{csrf:api.csrfToken(who),ns:'team/specs'}),res)
    assert.equal(res.status,error.code==='budget'?429:503)
    assert.ok(!res.body.includes('secret-model'))
    assert.ok(!res.body.includes('provider-secret'))
  }
})

test('no bot, too few sources and an undersized corpus do not call a model', async () => {
  for (const [sources, selected, reason] of [
    [[source('model'), source('format')], null, 'no-bot'],
    [[source('model')], bot, 'too-few-specs'],
    [[source('model'), source('format', 'draft', { body: 'x'.repeat(200001) })], bot, 'context-too-small']
  ]) {
    const api = fixture()
    api.setup(async () => context(sources), selected, async () => { throw new Error('unexpected model request') })
    const result = await api.run('team/specs')
    assert.equal(result.ran, false)
    assert.equal(result.reason, reason)
    assert.equal(result.compared, 0)
  }
})

test('a scope change while reserving quota stops dispatch through the supplied callback', async () => {
  const api = fixture()
  let sources = [source('model'), source('format')]
  let dispatched = false
  api.setup(async () => context(sources), bot, async (_bot, _system, _input, _name, _schema, _tokens, options) => {
    sources = [...sources, source('new')]
    await options.beforeDispatch()
    dispatched = true
    return { overlaps: [] }
  })
  await assert.rejects(api.run('team/specs'), { code: 'consistency-stale' })
  assert.equal(dispatched, false)
})

test('a cache whose source is withdrawn cannot expose its old links on GET', async () => {
  const api = fixture()
  let sources = [source('model'), source('format')]
  api.setup(async () => context(sources), bot, async () => ({ overlaps: [{ a: 1, b: 2, kind: 'conflict', why: 'Requirements disagree.',
    aQuote: 'Strings remain strings in format.', bQuote: 'Strings remain strings in model.' }] }),
  async () => ({ threadId: '17', resolved: false, created: true }))
  await api.run('team/specs')
  sources = sources.slice(1)
  const view = await api.consistencyView('team/specs')
  assert.equal(view.result.stale, true)
  assert.equal(view.result.saved, 1)
  assert.ok(!JSON.stringify(view.result).includes('https://editor.test'))
})

test('a normal HTML form returns to the same project after a review', async () => {
  const api = fixture(), who = actor(), res = response()
  api.setup(async () => context([source('model'), source('format')]), bot, async () => ({ overlaps: [] }))
  const req = request(api, who, { csrf: api.csrfToken(who), ns: 'team/specs' })
  req.headers.accept = 'text/html'
  await api.post(req, res)
  assert.equal(res.status, 302)
  assert.equal(res.headers.Location, '/bots?ns=team%2Fspecs#consistency-review')
})

test('opening Review bots reads the note corpus once and never refreshes policy remotely', async () => {
  const api = fixture()
  const roles = { authors: [{ id: '7', login: 'writer' }], approvers: [{ id: '8', login: 'reviewer' }], 'approvals-required': 1 }
  const calls = api.sources([], new Map(), roles, [])
  const view = await api.consistencyView('team/specs')
  assert.equal(calls.notes, 1)
  assert.equal(calls.state, 1)
  assert.deepEqual(calls.policies, ['team/specs', 'other/specs'].map(namespace => ({ namespace, refresh: false, cacheOnly: true })))
  assert.equal(view.count, 0)
})

test('comment-only edits keep the compared-body identity while owner and policy changes invalidate it', async () => {
  const api = fixture()
  const roles = { authors: [{ id: '7', login: 'writer' }, { id: '8', login: 'other' }], approvers: [{ id: '9', login: 'reviewer' }], 'approvals-required': 1 }
  const rows = [{ shortid: 'draft', title: 'Draft', permission: 'editable', owner_profileid: 'github:7',
    owner_profile: JSON.stringify({ provider: 'github', id: '7', username: 'writer' }),
    content: '---\ntags: [spec, draft]\nnamespace: team/specs\n---\n# Draft\n\nExplicit requirement.{>>A first comment.<<}' }]
  api.sources(rows, new Map(), roles, ['draft'])
  const original = await api.source('team/specs')
  rows[0].content = rows[0].content.replace('A first comment.', 'A revised comment.')
  assert.equal((await api.source('team/specs')).key, original.key)
  rows[0].owner_profileid = 'github:8'
  rows[0].owner_profile = JSON.stringify({ provider: 'github', id: '8', username: 'other' })
  const moved = await api.source('team/specs')
  assert.notEqual(moved.key, original.key)
  roles['approvals-required'] = 0
  assert.notEqual((await api.source('team/specs')).key, moved.key)
})

test('an exception after a created discussion reports only its safe count in the response and cache', async () => {
  const api = fixture(), who = actor(), res = response()
  const sources = [source('format'), source('model')]
  let saved = 0
  api.setup(async () => {
    if (saved) throw new Error('Internal service URL and private data')
    return context(sources)
  }, bot, async () => ({ overlaps: [{ a: 1, b: 2, kind: 'conflict', why: 'Requirements disagree.',
    aQuote: 'Strings remain strings in format.', bQuote: 'Strings remain strings in model.' }] }),
  async () => { saved++; return { threadId: '17', created: true, resolved: false } })
  await api.post(request(api, who, { csrf: api.csrfToken(who), ns: 'team/specs' }), res)
  assert.equal(res.status, 503)
  const error = JSON.parse(res.body)
  assert.equal(error.saved, 1)
  assert.ok(!res.body.includes('Internal service'))
  const view = await api.consistencyView('team/specs')
  assert.deepEqual(view.result, { error: error.error, saved: 1 })
  assert.ok(!JSON.stringify(view.result).includes('editor.test'))
})

test('a lock lost after the first finding prevents the next save and keeps the created count', async () => {
  const api = fixture(), lease = new AbortController()
  const sources = [source('first'), source('second'), source('third')]
  let saved = 0
  api.setup(async () => context(sources), bot, async () => ({ overlaps: [
    { a: 1, b: 2, kind: 'conflict', why: 'Requirements disagree.', aQuote: 'Strings remain strings in first.', bQuote: 'Strings remain strings in second.' },
    { a: 1, b: 3, kind: 'conflict', why: 'Requirements disagree.', aQuote: 'Strings remain strings in first.', bQuote: 'Strings remain strings in third.' }
  ] }), async () => {
    saved++
    lease.abort(new Error('Lock lost'))
    return { threadId: '17', created: true, resolved: false }
  })
  await assert.rejects(api.run('team/specs', { signal: lease.signal }), error => error.saved === 1 && error.message === 'Lock lost')
  assert.equal(saved, 1)
})

test('uncited context that disappears between findings blocks the next save', async () => {
  const api = fixture(), sources = [source('first'), source('second'), source('third')]
  let saved = 0
  api.setup(async () => context(sources), bot, async () => ({ overlaps: [
    { a: 1, b: 2, kind: 'conflict', why: 'Requirements disagree.', aQuote: 'Strings remain strings in first.', bQuote: 'Strings remain strings in second.' },
    { a: 1, b: 2, kind: 'conflict', why: 'Another observation.', aQuote: 'Strings remain strings in first.', bQuote: 'Strings remain strings in second.' }
  ] }), async () => { saved++; return { threadId: '17', created: true, resolved: false } })
  api.delivery(async id => saved && id === 'third' ? null : { id, namespace: 'team/specs' })
  await assert.rejects(api.run('team/specs'), error => error.saved === 1 && error.code === 'review-context-restricted')
  assert.equal(saved, 1)
})

test('credential detection asks for removal and rotation instead of retrying', async () => {
  const api = fixture(), who = actor(), res = response()
  api.setup(async () => context([source('first'), source('second')]), bot,
    async () => { throw Object.assign(new Error('credential kind'), { code: 'SENSITIVE_CONTENT' }) })
  await api.post(request(api, who, { csrf: api.csrfToken(who), ns: 'team/specs' }), res)
  assert.equal(res.status, 422)
  assert.match(JSON.parse(res.body).error, /Remove and rotate/)
  assert.ok(!res.body.includes('Try again'))
})

test('governing principles precede top-level drafts within a bounded corpus', () => {
  const { consistencyCorpus } = require('./consistency-corpus')
  const sources = [source('a-draft', 'draft', { kind: 'top-level', body: 'Proposal. '.repeat(20) }),
    source('z-governing', 'approved', { kind: 'top-level', governing: true })]
  const corpus = consistencyCorpus(sources, 350)
  assert.deepEqual(corpus.supplied.map(spec => spec.id), ['z-governing'])
  assert.deepEqual(corpus.omitted.map(spec => spec.id), ['a-draft'])
})

test('the bot settings page stays available when consistency reads fail', async () => {
  const api = fixture(), who = actor(), res = response()
  api.inputFailure()
  api.bots(async () => [{ name: 'reviewer', model: 'model', namespaces: ['team/specs'], enabled: true }])
  const req = request(api, who, {})
  req.method = 'GET'
  await api.botsGet(req, res, new URL('https://board.test/bots'))
  assert.equal(res.status, 200)
  assert.equal(res.headers['Cache-Control'], 'no-store')
  assert.ok(res.body.includes('@reviewer'))
  assert.ok(res.body.includes('Consistency review information could not be loaded'))
})

test('frontmatter relations resolve into request context without suppressing replacement findings', async () => {
  const api = fixture()
  const roles = { authors: [{ id: '7', login: 'writer' }], approvers: [{ id: '8', login: 'reviewer' }], 'approvals-required': 1 }
  const rows = ['original', 'replacement'].map(id => ({ shortid: id, title: id, permission: 'editable', owner_profileid: 'github:7',
    owner_profile: JSON.stringify({ provider: 'github', id: '7', username: 'writer' }),
    content: `---\ntags: [spec, draft]\nnamespace: team/specs\n${id === 'replacement' ? 'depends-on: [5]\nsupersedes: original\n' : ''}---\n# ${id}\n\nStrings remain strings in ${id}.` }))
  api.sources(rows, new Map([['original', { pr_number: 5, namespace: 'team/specs' }]]), roles, ['original', 'replacement'])
  const captured = await api.source('team/specs')
  const replacement = captured.sources.find(spec => spec.id === 'replacement')
  assert.deepEqual(replacement.dependsOn, ['original'])
  assert.equal(replacement.supersedes, 'original')
  let saved = 0
  api.setup(async () => captured, bot, async () => ({ overlaps: [{ a: 1, b: 2, kind: 'conflict', why: 'A proposed exception conflicts with a retained requirement.',
    aQuote: 'Strings remain strings in original.', bQuote: 'Strings remain strings in replacement.' }] }),
  async () => { saved++; return { threadId: '17', created: true, resolved: false } })
  const result = await api.run('team/specs')
  assert.equal(saved, 1)
  assert.equal(result.rejected, 0)
})
