const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const { Readable } = require('node:stream')

process.env.NAMESPACES = 'team/specs,other/specs'
process.env.OVERLAP_MAX_BYTES = '500'
process.env.BOARD_ADMIN_IDS = '42'
process.env.SESSION_SECRET = 'finding-fixture-only'
process.env.BOARD_OAUTH_CLIENT_ID = 'fixture-client'
process.env.BOARD_OAUTH_CLIENT_SECRET = 'fixture-secret'
process.env.SPEC_BOARD_BASE_URL = 'https://board.test'
process.env.GITHUB_TOKEN = 'fixture-service-token'

function fixture ({ notes = new Map(), receipts = new Map(), rows = new Map() } = {}) {
  const file = path.join(__dirname, 'server.js')
  const loaded = new Module(file + '.findings', module)
  loaded.filename = file
  loaded.paths = Module._nodeModulePaths(__dirname)
  const writes = []
  const notifications = []
  const editorAttempts = []
  const saveAttempts = []
  const sourceFailures = new Map()
  let editorError = null
  let editorReplyLost = false
  let saveError = null
  let saveReplyLost = false
  const copy = value => value == null ? value : structuredClone(value)
  const key = (noteId, botName) => noteId + '\0' + botName
  loaded.fixtureState = { notes, rows, copy, key, saveAttempts, sourceFailures, notifications,
    saveNew: async (noteId, botName, hash, delivery, previousHash) => {
      saveAttempts.push(copy({ noteId, botName, hash, delivery, previousHash }))
      if (saveError && !saveReplyLost) throw saveError
      const id = key(noteId, botName), existing = rows.get(id)
      if (existing && existing.reviewed_hash !== hash && existing.reviewed_hash !== previousHash) return null
      if (!existing || existing.reviewed_hash !== hash) rows.set(id, copy({ reviewed_hash: hash, delivery }))
      if (saveError) throw saveError
      return copy(rows.get(id))
    } }
  const requireModule = loaded.require.bind(loaded)
  loaded.require = name => name === './editor-client' ? { ...requireModule(name), createEditorClient: () => async mutation => {
    editorAttempts.push(copy(mutation))
    const receipt = receipts.get(mutation.operationId)
    if (receipt) {
      assert.deepEqual(mutation, receipt.mutation, 'a receipt can only replay the same mutation')
      return copy(receipt.result)
    }
    if (editorError && !editorReplyLost) throw editorError
    const note = notes.get(mutation.noteId)
    if (!note || requireModule('./editor-client').contentHash(note.content) !== mutation.expectedHash ||
        note.permission !== mutation.expectedPermission) throw Object.assign(new Error('Editor precondition failed'), { status: 412 })
    note.content = mutation.content
    writes.push(copy(mutation))
    const result = { version: 1, noteId: mutation.noteId, applied: true, permission: note.permission,
      contentHash: requireModule('./editor-client').contentHash(note.content) }
    receipts.set(mutation.operationId, { mutation: copy(mutation), result })
    if (editorError) throw editorError
    return copy(result)
  } } : requireModule(name)
  loaded._compile(fs.readFileSync(file, 'utf8') + `
    const fixtureState = module.fixtureState;
    loadBots = async () => [];
    reviewDeliveryStore.read = async (noteId, botName) => fixtureState.copy(fixtureState.rows.get(fixtureState.key(noteId, botName))) || null;
    reviewDeliveryStore.saveNew = fixtureState.saveNew;
    reviewDeliveryStore.update = async (noteId, botName, hash, runId, delivery) => {
      const id = fixtureState.key(noteId, botName), row = fixtureState.rows.get(id);
      if (!row || row.reviewed_hash !== hash || row.delivery?.id !== runId) return false;
      fixtureState.rows.set(id, fixtureState.copy({ reviewed_hash: hash, delivery }));
      return true;
    };
    visibleSnapshot = async () => ({ specs: [
      { id: 'model', alias: 'model-alias', urlId: 'encoded-model', url: 'https://editor.test/model-alias' },
      { id: 'format', alias: 'format-alias', urlId: 'encoded-format', url: 'https://editor.test/format-alias' }
    ] });
    module.exports.fixture = { findOverlap, generatedFinding, checkpointsGet, checkpointsPost, checkpointSection,
      discussionSourceGet, discussionRecover, csrfToken, signToken, threadAnchors, REVIEW_MAX_CHARS,
      sharedDelivery: rows => filterSharedNotificationContext(rows),
      sources: read => { reviewCurrentSource = read },
      roles: read => { gh = read },
      prepareFindingAuthorization, authorizeFinding,
      pendingReview: (noteId, botName) => fixtureState.copy(unsavedReviews.get(reviewKey(noteId, botName))),
      runReview: async (spec, bot, comments, context, options = {}) => {
        tickCount++;
        reviewBudget = options.modelBudget ?? 1; reviewDeliveryBudget = options.deliveryBudget ?? 1;
        reviewedNamespaces.clear(); reviewFailedBots.clear();
        if (options.blockModel) {
          reviewFailedBots.add(bot.name);
          botHealth.set(bot.name, { failures: 1, retryTick: tickCount + 60, lastError: 'Model unavailable' });
        }
        if (!fixtureState.notes.has(spec.id)) fixtureState.notes.set(spec.id, fixtureState.copy(spec));
        for (const source of context.sources || []) {
          if (!fixtureState.notes.has(source.spec.id)) fixtureState.notes.set(source.spec.id, fixtureState.copy(source.spec));
        }
        reviewCurrentSource = async id => {
          if (fixtureState.sourceFailures.has(id)) throw fixtureState.sourceFailures.get(id);
          const note = fixtureState.notes.get(id);
          if (!note || note.hidden || !NAMESPACES.includes(note.namespace) ||
              (note.permission != null && !['freely', 'editable', 'locked'].includes(note.permission))) return null;
          return { id, namespace: note.namespace, permission: note.permission, content: note.content, body: publishedBody(note),
            contentHash: contentHash(note.content), spec: fixtureState.copy(note) };
        };
        const reviews = new Map([...fixtureState.rows].map(([key, row]) => [key,
          { hash: row.reviewed_hash, state: row.delivery?.state, retryAt: row.delivery?.retryAt }]));
        let modelCalls = 0;
        pool.query = async (sql, params) => {
          if (sql.includes('SELECT content, permission')) return { rows: [fixtureState.copy(fixtureState.notes.get(params[0]))].filter(Boolean) };
          if (!sql.includes('specdoc-moderation') && !sql.includes('spec_board_moderation_notes')) throw new Error('unexpected fixture query');
          return { rows: [] };
        };
        currentVisibleSpecs = async specs => specs;
        callBot = async () => { modelCalls++; if (options.afterModel) await options.afterModel(); return comments };
        loadBots = async () => [bot];
        notify = async message => fixtureState.notifications.push(message);
        await maybeReviewSpec(spec, [bot], reviews, () => context);
        return { modelCalls, health: botHealth.get(bot.name), review: fixtureState.copy(fixtureState.rows.get(reviewKey(spec.id, bot.name))),
          pending: fixtureState.copy(unsavedReviews.get(reviewKey(spec.id, bot.name))) };
      },
      cleanupReviews: async (specs, bots, { unavailable = [], roles = 'unknown', visibilityError = null } = {}) => {
        rolesCache.clear();
        if (roles !== 'unknown') for (const ns of new Set(specs.map(spec => spec.namespace))) {
          rolesCache.set(ns, { roles: null, at: Date.now(), successAt: Date.now(), failed: roles === 'failed' });
        }
        let retained;
        reviewDeliveryStore.sweep = async (notes, activeBots) => { retained = { notes, bots: activeBots } };
        pool.query = async (sql, params) => {
          if (!sql.includes('SELECT n.shortid FROM')) throw new Error('unexpected cleanup fixture query');
          if (visibilityError) throw visibilityError;
          return { rows: params[0].filter(id => !unavailable.includes(id)).map(shortid => ({ shortid })) };
        };
        await cleanupReviewDeliveries(specs, bots);
        return retained;
      },
      checkpointSources: async (specs, { review = false, nodes = [{ id: 'model', ns: 'team/specs', n: 1 }] } = {}) => {
        snapshot.at = Date.now();
        serviceTokenFor = async () => 'fixture';
        nsSpecsDir = async () => null;
        gh = async (_method, route) => route.endsWith('/team/specs')
          ? { default_branch: 'main' } : { object: { sha: 'fixture-head' } };
        ghOrNull = async route => route.includes('/git/trees/') ? { tree: [] } : [];
        checkpointBlockers = () => [];
        specGraph = () => nodes;
        visibleSnapshot = async () => ({ specs, state: new Map() });
        pool.query = async (sql, params) => {
          if (sql.includes('SELECT n.shortid FROM')) return { rows: params[0].map(shortid => ({ shortid })) };
          if (!sql.includes('array_agg(n.note_id')) throw new Error('unexpected fixture query');
          return { rows: [{ id: '17', note_ids: ['format', 'model'] }] };
        };
        return checkpointState('team/specs', { review });
      },
      review: reviewService,
      model: (bot, call) => { loadBots = async () => [bot]; callBotJson = call },
      checkpoint: read => { checkpointState = read; roadmapStore.read = async () => ({ milestones: [] }) }
    };`, file)
  return { ...loaded.exports.fixture, writes, notifications, editorAttempts, saveAttempts,
    restart: () => fixture({ notes, receipts, rows }),
    failEditor: (error, afterApply = false) => { editorError = error; editorReplyLost = afterApply },
    failSave: (error, afterSave = false) => { saveError = error; saveReplyLost = afterSave },
    failSource: (id, error) => { if (error) sourceFailures.set(id, error); else sourceFailures.delete(id) },
    editNote: (id, changes) => { notes.set(id, { ...notes.get(id), ...changes }) },
    currentNote: id => copy(notes.get(id)) }
}

const response = () => ({ status: null, headers: {}, body: '',
  writeHead (status, headers = {}) { this.status = status; this.headers = headers; return this },
  end (body = '') { this.body = body; return this } })
const actor = () => ({ purpose: 'board-session', provider: 'github', subject: '42', login: 'maintainer',
  authenticatedAt: Date.now(), exp: Date.now() + 60000 })
const request = (api, who, form = null) => {
  const req = Readable.from(form ? [new URLSearchParams(form).toString()] : [])
  req.method = form ? 'POST' : 'GET'
  req.headers = { cookie: 'sb_session=' + api.signToken(who), host: 'board.test' }
  req.socket = { remoteAddress: '127.0.0.1' }
  return req
}

test('checkpoint findings cite only supplied text and share their identity with per-spec review', async () => {
  const api = fixture()
  const bot = { name: 'reviewer', namespaces: ['team/specs'], url: 'https://model.test', model: 'fixture' }
  const a = { id: 'model', namespace: 'team/specs', admitted: true, content: '**FR-001**: Strings remain strings in the model.' }
  const b = { id: 'format', namespace: 'team/specs', admitted: true, content: '**FR-002**: IP-looking strings become IP values in the model.' }
  const skipped = { id: 'omitted', namespace: 'team/specs', admitted: true, content: 'x'.repeat(800) + '\n\nOmitted exact requirement.' }
  const saved = []
  api.sources(async id => [a, b, skipped].find(spec => spec.id === id) || null)
  api.review.recordFinding = async finding => { saved.push(finding); return { threadId: '17' } }
  api.model(bot, async (_bot, _system, supplied) => {
    assert.ok(!supplied.includes('Omitted exact requirement.'))
    return { overlaps: [
      { a: 1, b: 2, kind: 'conflict', aQuote: 'Strings remain strings', bQuote: 'IP-looking strings become IP values', why: 'The same input has incompatible types.' },
      { a: 1, b: 3, kind: 'conflict', aQuote: 'Strings remain strings', bQuote: 'Omitted exact requirement.', why: 'Unsupplied evidence.' },
      { a: 1, b: 2, kind: 'conflict', aQuote: 'The model never saw this quote.', bQuote: 'IP-looking strings become IP values', why: 'Invented quotation.' }
    ] }
  })
  const result = await api.findOverlap('team/specs', [a, b, skipped].map((spec, i) => ({ id: spec.id, ns: spec.namespace, n: i + 1, title: spec.id })), [a, b, skipped])
  assert.equal(saved.length, 1)
  assert.deepEqual(result.findings, [{ threadId: '17', noteId: 'model' }])
  assert.deepEqual(result.skipped, [3])
  const reviewed = api.generatedFinding(bot, 'spec-review', 'conflict', 'Different prose.', [
    { spec: a, supplied: a.content, quote: 'Strings remain strings' },
    { spec: b, supplied: b.content, quote: 'IP-looking strings become IP values' }
  ])
  assert.equal(reviewed.findingKey, saved[0].findingKey)
  assert.notEqual(reviewed.occurrenceKey, saved[0].occurrenceKey)
  assert.equal(api.generatedFinding(bot, 'spec-review', 'conflict', 'Unsupported.', [
    { spec: a, supplied: 'Only the title', quote: 'Strings remain strings' },
    { spec: b, supplied: b.content, quote: 'IP-looking strings become IP values' }
  ]), null)
})

test('checkpoint consistency distinguishes malformed responses from an empty result', async () => {
  const specs = ['model', 'format'].map(id => ({ id, title: id, namespace: 'team/specs', permission: 'freely', admitted: true,
    content: `**FR-001**: ${id} has its own requirement.`, url: `https://editor.test/${id}` }))
  const nodes = specs.map((spec, i) => ({ id: spec.id, ns: spec.namespace, n: i + 1 }))
  const bot = { name: 'reviewer', namespaces: ['team/specs'], url: 'https://model.test', model: 'fixture' }
  for (const output of [{}, null, { overlaps: null }, { overlaps: {} }, { overlaps: '' }, { overlaps: [] }]) {
    const api = fixture()
    let calls = 0
    api.sources(async id => specs.find(spec => spec.id === id) || null)
    api.model(bot, async () => { calls++; return output })
    api.review.recordFinding = async () => { assert.fail('empty or malformed output cannot save a finding') }
    const state = await api.checkpointSources(specs, { review: true, nodes })
    const html = api.checkpointSection('fixture', state)
    if (Array.isArray(output?.overlaps)) {
      assert.equal(state.overlap.error, undefined)
      assert.match(html, /No supported finding/)
      assert.doesNotMatch(html, /Consistency review failed/)
    } else {
      assert.equal(state.overlap.error, 'Model response must include an overlaps array')
      assert.match(html, /Consistency review failed: Model response must include an overlaps array/)
      assert.doesNotMatch(html, /No supported finding/)
    }
    const cached = await api.checkpointSources(specs, { nodes })
    assert.deepEqual(cached.overlap, state.overlap)
    assert.equal(calls, 1, 'reading a cached failure or empty result does not rerun the model')
  }
})

for (const changed of ['private', 'hidden', 'suspended', 'moved', 'missing']) {
  test(`consistency review saves nothing when uncited context becomes ${changed} during the model call`, async () => {
    const api = fixture()
    const specs = [
      { id: 'model', content: '**FR-001**: Strings remain strings.' },
      { id: 'format', content: '**FR-002**: Strings become IP values.' },
      { id: 'uncited', content: '**FR-003**: Sensitive additional context.' }
    ].map(spec => ({ ...spec, title: spec.id, namespace: 'team/specs', permission: 'freely', admitted: true,
      url: `https://editor.test/${spec.id}` }))
    const nodes = specs.map((spec, i) => ({ id: spec.id, ns: spec.namespace, n: i + 1, title: spec.title }))
    const current = new Map(specs.map(spec => [spec.id, { ...spec }]))
    const checked = []
    api.sources(async id => {
      checked.push(id)
      const source = current.get(id)
      if (source?.suspended) throw Object.assign(new Error('Content or account is restricted by moderation'), { status: 403 })
      return !source || source.hidden || source.permission === 'private' ? null : source
    })
    let calls = 0, saved = 0
    api.review.recordFinding = async () => { saved++; return { threadId: '17' } }
    api.model({ name: 'reviewer', namespaces: ['team/specs'] }, async (_bot, _system, input) => {
      calls++
      assert.ok(input.includes('Sensitive additional context.'), 'the uncited source was part of the model input')
      const source = current.get('uncited')
      if (changed === 'private') source.permission = 'private'
      else if (changed === 'moved') source.namespace = 'other/specs'
      else if (changed === 'missing') current.delete('uncited')
      else source[changed] = true
      return { overlaps: [{ a: 1, b: 2, kind: 'conflict', aQuote: 'Strings remain strings.',
        bQuote: 'Strings become IP values.', why: 'The input has incompatible types.' }] }
    })
    const state = await api.checkpointSources(specs, { review: true, nodes })
    assert.equal(saved, 0)
    assert.deepEqual(checked.sort(), specs.map(spec => spec.id).sort())
    const html = api.checkpointSection('fixture', state)
    assert.match(html, /Consistency review failed:/)
    assert.doesNotMatch(html, /No supported finding|Sensitive additional context|The input has incompatible types/)
    assert.equal(state.overlap.error, changed === 'suspended'
      ? 'Content or account is restricted by moderation' : 'Review sources are no longer available in this project')
    const cached = await api.checkpointSources(specs, { nodes })
    assert.deepEqual(cached.overlap, state.overlap)
    assert.equal(calls, 1)
    assert.equal(saved, 0)
  })
}

for (const roles of ['unknown', 'failed']) {
  test(`${roles} governance retains a queued response and suspends delivery until recovery`, async t => {
    useClock(t)
    const api = fixture(), { spec, peer, bot, comments, context } = reviewScenario()
    let findings = 0
    api.review.recordFinding = async () => { findings++; return { threadId: '17' } }
    api.failSave(Object.assign(new Error('Storage unavailable'), { code: 'ECONNRESET' }))
    const first = await api.runReview(spec, bot, comments, context)
    api.failSave(null)
    nextRetry(t, first)
    const uncertain = [spec, peer].map(source => ({ ...source, validNamespace: true, admitted: false, rolesUnknown: true }))
    const retained = await api.cleanupReviews(uncertain, [bot], { roles })
    assert.deepEqual(retained.notes, uncertain.map(({ id, namespace }) => ({ id, namespace })))
    assert.deepEqual(api.saveAttempts[1].delivery, first.pending.delivery)
    assert.equal(api.pendingReview(spec.id, bot.name), undefined)
    const held = await api.runReview({ ...spec, admitted: true, rolesUnknown: true }, bot, comments, context)
    assert.equal(held.modelCalls, 0)
    assert.equal(held.review.delivery.state, 'pending')
    assert.equal(findings, 0)
    assert.equal(api.editorAttempts.length, 0)
    const resumed = await api.runReview({ ...spec, rolesUnknown: false }, bot, reword(comments), context)
    assert.equal(resumed.modelCalls, 0)
    assert.equal(resumed.review.delivery, null)
    assert.equal(findings, 1)
    assert.equal(api.writes.length, 1)
    assert.ok(!api.writes[0].content.includes('Reworded.'))
  })
}

for (const unavailable of ['denied', 'private', 'hidden', 'deleted', 'moved-peer', 'moved-subject', 'unknown-namespace', 'disabled-bot', 'expired']) {
  test(`cleanup removes queued source text after ${unavailable}`, async t => {
    useClock(t)
    const api = fixture(), { spec, peer, bot, comments, context } = reviewScenario()
    api.failSave(Object.assign(new Error('Storage unavailable'), { code: 'ECONNRESET' }))
    const first = await api.runReview(spec, bot, comments, context)
    api.failSave(null)
    nextRetry(t, first)
    let specs = [spec, peer].map(source => ({ ...source, validNamespace: true }))
    const options = { roles: 'fresh' }
    if (unavailable === 'denied') specs[1].admitted = false
    if (unavailable === 'private') specs[1].permission = 'private'
    if (unavailable === 'hidden') options.unavailable = [peer.id]
    if (unavailable === 'deleted') specs = specs.slice(0, 1)
    if (unavailable === 'moved-peer') specs[1].namespace = 'other/specs'
    if (unavailable === 'moved-subject') specs[0].namespace = 'other/specs'
    if (unavailable === 'unknown-namespace') specs[1].validNamespace = false
    if (unavailable === 'expired') t.mock.timers.setTime(first.pending.delivery.expiresAt + 1)
    const retained = await api.cleanupReviews(specs, unavailable === 'disabled-bot' ? [] : [bot], options)
    if (['denied', 'private', 'hidden', 'deleted', 'unknown-namespace'].includes(unavailable)) {
      assert.ok(!retained.notes.some(source => source.id === peer.id))
    }
    assert.deepEqual(api.saveAttempts[1].delivery, { id: first.pending.delivery.id, state: 'failed',
      reason: unavailable === 'expired' ? 'expired' : unavailable === 'disabled-bot' ? 'bot-unavailable' : 'source-unavailable' })
    assert.equal(api.editorAttempts.length, 0)
  })
}

test('an unavailable visibility read preserves queued responses without attempting cleanup writes', async t => {
  useClock(t)
  const api = fixture(), { spec, peer, bot, comments, context } = reviewScenario()
  api.failSave(Object.assign(new Error('Storage unavailable'), { code: 'ECONNRESET' }))
  const first = await api.runReview(spec, bot, comments, context)
  api.failSave(null)
  nextRetry(t, first)
  await assert.rejects(api.cleanupReviews([spec, peer].map(source => ({ ...source, validNamespace: true })), [bot],
    { visibilityError: new Error('Visibility unavailable') }), /Visibility unavailable/)
  assert.deepEqual(api.pendingReview(spec.id, bot.name), first.pending)
  assert.equal(api.saveAttempts.length, 1)
  assert.equal(api.editorAttempts.length, 0)
})

test('expiry scrubs every unsaved response even when the cleanup write budget is exhausted', async t => {
  useClock(t)
  const api = fixture(), { spec, peer, bot, comments, context } = reviewScenario()
  const subjects = Array.from({ length: 5 }, (_, i) => ({ ...spec, id: `model-${i}`, validNamespace: true }))
  api.failSave(Object.assign(new Error('Storage unavailable'), { code: 'ECONNRESET' }))
  const retained = []
  for (const subject of subjects) retained.push(await api.runReview(subject, bot, comments, context))
  t.mock.timers.setTime(retained[0].pending.delivery.expiresAt + 1)
  await api.cleanupReviews([...subjects, { ...peer, validNamespace: true }], [bot])
  for (let i = 0; i < subjects.length; i++) {
    assert.deepEqual(api.pendingReview(subjects[i].id, bot.name).delivery,
      { id: retained[i].pending.delivery.id, state: 'failed', reason: 'expired' })
  }
  assert.equal(api.saveAttempts.length, 9, 'the write limit still bounds database retries')
  assert.equal(api.editorAttempts.length, 0)
})

test('checkpoint page reads do not run a model pass; explicit admin POST does', async () => {
  const api = fixture(), who = actor(), calls = []
  api.checkpoint(async (ns, options) => {
    calls.push({ ns, options })
    return { ns, count: 2, blockers: [], discussions: [], head: 'abc', next: 'specs/v1', orphans: true }
  })
  const url = new URL('https://board.test/checkpoints?ns=team%2Fspecs')
  const page = response()
  await api.checkpointsGet(request(api, who), page, url)
  assert.equal(page.status, 200)
  assert.equal(calls[0].options, undefined)
  const denied = response()
  await api.checkpointsPost(request(api, who, { ns: 'team/specs', action: 'review-consistency', csrf: 'invalid' }), denied)
  assert.equal(denied.status, 403)
  assert.equal(calls.length, 1)
  const posted = response()
  await api.checkpointsPost(request(api, who, { ns: 'team/specs', action: 'review-consistency', csrf: api.csrfToken(who) }), posted)
  assert.equal(posted.status, 302)
  assert.deepEqual(calls[1], { ns: 'team/specs', options: { review: true } })
})

test('frozen source pages escape content and withhold unavailable evidence', async () => {
  const api = fixture()
  const req = request(api, actor()), url = new URL('https://board.test/discussion/17/source/model?note=format-alias')
  api.review.evidence = async (...args) => {
    assert.deepEqual(args, ['format', '17', 'model'])
    return { title: '<script>title</script>', body: '<script>body</script>', quote: '<script>quote</script>', contentHash: 'a'.repeat(64) }
  }
  const page = response()
  await api.discussionSourceGet(req, page, url, '17', 'model')
  assert.equal(page.status, 200)
  assert.equal(page.headers['Cache-Control'], 'no-store')
  assert.ok(!page.body.includes('<script>body</script>'))
  assert.ok(page.body.includes('&lt;script&gt;body&lt;/script&gt;'))
  api.review.evidence = async () => { throw Object.assign(new Error('private source text'), { status: 409 }) }
  const hidden = response()
  await api.discussionSourceGet(req, hidden, url, '17', 'model')
  assert.equal(hidden.status, 409)
  assert.ok(!hidden.body.includes('private source text'))
})

test('unavailable-source recovery requires a board admin, CSRF and the displayed version', async () => {
  const api = fixture(), who = actor(), url = new URL('https://board.test/discussion/17/recover?note=encoded-model')
  api.review.read = async () => ({ threads: [{ id: '17', version: 3, restricted: true, resolved: false }] })
  let applied = null
  api.review.act = async (...args) => { applied = args }
  const denied = response()
  await api.discussionRecover(request(api, { ...who, subject: '43' }), denied, url, '17')
  assert.equal(denied.status, 403)
  const form = response()
  await api.discussionRecover(request(api, who), form, url, '17')
  assert.equal(form.status, 200)
  assert.ok(form.body.includes('name="version" value="3"'))
  const badCsrf = response()
  await api.discussionRecover(request(api, who, { csrf: 'bad', version: '3', requestId: 'recovery-request-bad' }), badCsrf, url, '17')
  assert.equal(badCsrf.status, 403)
  assert.equal(applied, null)
  const post = response()
  await api.discussionRecover(request(api, who, { csrf: api.csrfToken(who), version: '3', requestId: 'recovery-request-17' }), post, url, '17')
  assert.equal(post.status, 302)
  assert.equal(applied[1].subject, '42')
  assert.equal(applied[0], 'model')
  assert.deepEqual(applied[3], { threadId: '17', version: 3, requestId: 'recovery-request-17', recover: true })
  api.review.read = async () => ({ threads: [{ id: '17', version: 3, restricted: false, resolved: false }] })
  const ordinary = response()
  await api.discussionRecover(request(api, who), ordinary, url, '17')
  assert.equal(ordinary.status, 409)
})

test('consistency reviews exclude concurrent work only in the same namespace', async () => {
  const api = fixture(), who = actor()
  let release, began
  const started = new Promise(resolve => { began = resolve })
  const waiting = new Promise(resolve => { release = resolve })
  api.checkpoint(async ns => { if (ns === 'team/specs') { began(); await waiting } return { ns } })
  const post = async ns => {
    const res = response()
    await api.checkpointsPost(request(api, who, { ns, action: 'review-consistency', csrf: api.csrfToken(who) }), res)
    return res
  }
  const first = post('team/specs')
  await started
  try {
    const duplicate = await post('team/specs')
    assert.equal(duplicate.status, 429)
    assert.equal((await post('other/specs')).status, 302)
  } finally { release() }
  await first
  assert.equal((await post('team/specs')).status, 302)
})

test('queued shared discussion mail requires every source to remain in its original namespace', async () => {
  const api = fixture()
  const row = { note_id: 'model', event: { namespace: 'team/specs', noteIds: ['model', 'format'] } }
  const ordinary = { note_id: 'model', event: {} }
  const sources = new Map(['model', 'format'].map(id => [id, { id, namespace: 'team/specs' }]))
  api.sources(async id => sources.get(id))
  assert.deepEqual(await api.sharedDelivery([row, ordinary]), [row, ordinary])
  sources.set('format', { id: 'format', namespace: 'other/specs' })
  assert.deepEqual(await api.sharedDelivery([row, ordinary]), [ordinary])
  sources.delete('format')
  assert.deepEqual(await api.sharedDelivery([row, ordinary]), [ordinary])
  sources.set('format', { id: 'format', namespace: 'team/specs' })
  assert.deepEqual(await api.sharedDelivery([{ ...row, event: { ...row.event, namespace: '' } }]), [])
  for (const status of [403, 404]) {
    api.sources(async id => {
      if (id === 'format') throw Object.assign(new Error('Source unavailable'), { status })
      return sources.get(id)
    })
    assert.deepEqual(await api.sharedDelivery([row, ordinary]), [ordinary])
  }
  api.sources(async () => { throw Object.assign(new Error('Database unavailable'), { code: 'ECONNRESET' }) })
  await assert.rejects(api.sharedDelivery([row, ordinary]), { code: 'ECONNRESET' })
})

test('checkpoint pages keep an open shared discussion as a cut blocker', async () => {
  const api = fixture(), who = actor()
  api.checkpoint(async ns => ({ ns, count: 1, blockers: [], head: 'abc', next: 'specs/v1', orphans: true,
    discussions: [{ id: '17', url: 'https://editor.test/model', restricted: false }] }))
  const page = response()
  await api.checkpointsGet(request(api, who), page, new URL('https://board.test/checkpoints?ns=team%2Fspecs'))
  assert.equal(page.status, 200)
  assert.ok(page.body.includes('https://editor.test/model#discussion-17'))
  assert.ok(!page.body.includes('source unavailable'))
  assert.match(page.body, /disabled[^>]*>Cut specs\/v1/)
})

test('checkpoint discussions distinguish visible drafts from unavailable sources', async () => {
  const api = fixture()
  const model = { id: 'model', namespace: 'team/specs', permission: 'freely', admitted: true,
    title: 'Model', content: 'Model requirement.', url: 'https://editor.test/model' }
  const format = { ...model, id: 'format', title: 'Draft format', url: 'https://editor.test/format' }
  const visible = await api.checkpointSources([model, format])
  assert.deepEqual(visible.discussions, [{ id: '17', url: model.url, restricted: false }])
  assert.deepEqual(visible.sources.map(source => source.id), ['model'])
  const unadmitted = await api.checkpointSources([model, { ...format, admitted: false }])
  assert.equal(unadmitted.discussions[0].restricted, false)
  const removed = await api.checkpointSources([model])
  assert.equal(removed.discussions[0].restricted, true)
  const moved = await api.checkpointSources([model, { ...format, namespace: 'other/specs' }])
  assert.equal(moved.discussions[0].restricted, true)
})

test('a busy finding does not discard later checkpoint findings', async () => {
  const api = fixture()
  const specs = ['a', 'b', 'c'].map((id, i) => ({ id, namespace: 'team/specs', admitted: true,
    content: `**FR-00${i + 1}**: Requirement ${id} chooses its own value.` }))
  const bot = { name: 'reviewer', namespaces: ['team/specs'], url: 'https://model.test', model: 'fixture' }
  api.sources(async id => specs.find(spec => spec.id === id) || null)
  api.model(bot, async () => ({ overlaps: [{ a: 1, b: 2 }, { a: 1, b: 3 }].map(pair => ({ ...pair,
    kind: 'conflict', why: 'The values disagree.', aQuote: 'Requirement a chooses its own value.',
    bQuote: `Requirement ${pair.b === 2 ? 'b' : 'c'} chooses its own value.` })) }))
  let attempts = 0
  api.review.recordFinding = async () => {
    if (++attempts === 1) throw Object.assign(new Error('busy'), { status: 409, code: 'review-busy' })
    return { threadId: '2' }
  }
  const result = await api.findOverlap('team/specs', specs.map((spec, i) => ({ id: spec.id, ns: spec.namespace, n: i + 1 })), specs)
  assert.equal(attempts, 2)
  assert.deepEqual(result.findings, [{ threadId: '2', noteId: 'a' }])
})

function reviewScenario () {
  const spec = { id: 'model', namespace: 'team/specs', permission: 'freely', admitted: true, statusIdx: 1,
    changed: '2020-01-01', title: 'Model', url: 'https://editor.test/model', content: 'Strings remain strings in the model.' }
  const peer = { ...spec, id: 'format', content: 'IP-looking strings become IP values in the model.' }
  const bot = { name: 'reviewer', namespaces: ['team/specs'], url: 'https://model.test', model: 'fixture' }
  const comments = [
    { quote: spec.content, comment: 'This conflicts with the format.', conflictsWith: '2', conflictQuote: peer.content },
    { quote: spec.content, comment: 'Clarify the scope of this requirement.' }
  ]
  const context = { text: peer.content, key: 'peer', labels: ['2'], ids: [peer.id], sources: [{ label: '2', spec: peer, supplied: peer.content }] }
  return { spec, peer, bot, comments, context }
}

const reword = comments => comments.map(comment => ({ ...comment, comment: comment.comment + ' Reworded.' }))
const useClock = t => t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-08T12:00:00Z') })
const nextRetry = (t, result) => {
  const at = result.pending?.retryAt || result.review?.delivery?.retryAt
  assert.ok(at > Date.now(), 'the failed save schedules a future retry')
  t.mock.timers.setTime(at + 1)
}

for (const failure of [{ status: 409, code: 'review-busy' }, { code: 'ECONNRESET' }]) {
  test(`${failure.code} retries its saved findings and exact comments after backoff`, async t => {
    useClock(t)
    const api = fixture(), { spec, bot, comments, context } = reviewScenario()
    const attempts = []
    api.review.recordFinding = async finding => {
      attempts.push(structuredClone(finding))
      if (attempts.length === 1) throw Object.assign(new Error('Finding save failed'), failure)
      return { threadId: '17' }
    }
    const first = await api.runReview(spec, bot, comments, context)
    assert.equal(first.modelCalls, 1)
    assert.equal(first.health, undefined)
    assert.equal(first.review.delivery.state, 'pending')
    assert.equal(api.writes.length, 0, 'inline comments wait so their insertion cannot stale pending evidence')
    assert.equal((await api.runReview(spec, bot, reword(comments), context)).modelCalls, 0)
    assert.equal(attempts.length, 1, 'an early poll does not retry storage')
    nextRetry(t, first)
    const retried = await api.runReview(spec, bot, reword(comments), context, { modelBudget: 0, blockModel: true })
    assert.equal(retried.modelCalls, 0, 'model budget and backoff do not block saved delivery')
    assert.equal(retried.review.delivery, null)
    assert.deepEqual(attempts[1], attempts[0], 'storage receives the original normalized finding')
    assert.equal(api.writes.length, 1)
    assert.ok(api.writes[0].content.includes(comments[1].comment))
    assert.ok(!api.writes[0].content.includes('Reworded.'))
    assert.equal(spec.content, api.currentNote(spec.id).content)
    assert.equal((await api.runReview(spec, bot, reword(comments), context)).modelCalls, 0)
    assert.equal(api.writes.length, 1)
    assert.equal(attempts.length, 2)
  })
}

for (const failure of [{ status: 403 }, { status: 404 }, { status: 422 }, { status: 409, code: 'review-source-changed' }]) {
  test(`${failure.code || failure.status} ends shared delivery without another model request`, async t => {
    useClock(t)
    const api = fixture(), { spec, bot, comments, context } = reviewScenario()
    let attempts = 0
    api.review.recordFinding = async () => { attempts++; throw Object.assign(new Error('Unavailable finding'), failure) }
    const first = await api.runReview(spec, bot, comments, context)
    assert.equal(first.modelCalls, 1)
    assert.equal(first.health, undefined)
    assert.equal(first.review.delivery.state, 'failed')
    assert.equal(first.review.delivery.rejected, 1)
    assert.equal(first.review.delivery.findings, undefined)
    assert.equal(first.review.delivery.mutation, undefined)
    assert.equal(api.writes.length, 1)
    assert.equal((await api.runReview(spec, bot, reword(comments), context)).modelCalls, 0)
    assert.equal(attempts, 1)
    assert.equal(api.writes.length, 1)
  })
}

test('a restart retains partial finding progress and retries only the unsaved finding', async t => {
  useClock(t)
  const api = fixture(), { spec, peer, bot, comments, context } = reviewScenario()
  const third = { ...peer, id: 'validation', content: 'String values must be converted before validation.' }
  context.ids.push(third.id)
  context.labels.push('3')
  context.sources.push({ label: '3', spec: third, supplied: third.content })
  comments.splice(1, 0, { quote: spec.content, comment: 'This also conflicts with validation.',
    conflictsWith: '3', conflictQuote: third.content })
  const attempts = []
  api.review.recordFinding = async finding => {
    attempts.push(structuredClone(finding))
    if (attempts.length === 1) throw Object.assign(new Error('Busy'), { code: 'review-busy', status: 409 })
    return { threadId: '18' }
  }
  const first = await api.runReview(spec, bot, comments, context)
  assert.equal(first.modelCalls, 1)
  assert.equal(attempts.length, 2, 'one busy finding does not hold back independent findings')
  assert.equal(first.review.delivery.findings.length, 1)
  assert.equal(api.writes.length, 0)
  const restarted = api.restart()
  restarted.review.recordFinding = async finding => { attempts.push(structuredClone(finding)); return { threadId: '17' } }
  assert.equal((await restarted.runReview(spec, bot, reword(comments), context)).modelCalls, 0)
  assert.equal(attempts.length, 2, 'durable backoff survives restart')
  nextRetry(t, first)
  const retried = await restarted.runReview(spec, bot, reword(comments), context, { modelBudget: 0 })
  assert.equal(retried.modelCalls, 0)
  assert.equal(retried.review.delivery, null)
  assert.equal(attempts.length, 3)
  assert.deepEqual(attempts[2], attempts[0])
  assert.equal(restarted.writes.length, 1)
  assert.ok(restarted.writes[0].content.includes(comments[2].comment))
  assert.ok(!restarted.writes[0].content.includes('Reworded.'))
})

for (const afterSave of [false, true]) {
  test(`initial review save ${afterSave ? 'reply loss' : 'failure'} retries without model calls or early side effects`, async t => {
    useClock(t)
    const api = fixture(), { spec, bot, comments, context } = reviewScenario()
    let findings = 0
    api.review.recordFinding = async () => { findings++; return { threadId: '17' } }
    api.failSave(Object.assign(new Error('Storage unavailable'), { code: 'ECONNRESET' }), afterSave)
    const first = await api.runReview(spec, bot, comments, context)
    assert.equal(first.modelCalls, 1)
    assert.equal(first.health, undefined)
    assert.ok(first.pending)
    assert.equal(first.review?.delivery?.state, afterSave ? 'pending' : undefined)
    assert.equal(findings, 0)
    assert.equal(api.editorAttempts.length, 0)
    assert.equal((await api.runReview(spec, bot, reword(comments), context)).modelCalls, 0)
    assert.equal(api.saveAttempts.length, 1, 'an early poll does not retry the initial durable save')
    api.failSave(null)
    nextRetry(t, first)
    const retried = await api.runReview(spec, bot, reword(comments), context, { modelBudget: 0, blockModel: true })
    assert.equal(retried.modelCalls, 0)
    assert.equal(retried.pending, undefined)
    assert.equal(retried.review.delivery, null)
    assert.deepEqual(api.saveAttempts[1].delivery, api.saveAttempts[0].delivery)
    assert.equal(findings, 1)
    assert.equal(api.writes.length, 1)
    assert.ok(!api.writes[0].content.includes('Reworded.'))
  })
}

test('an unavailable database stops new model calls before evicting unsaved responses', async t => {
  useClock(t)
  const api = fixture(), { spec, bot, comments, context } = reviewScenario()
  const specs = Array.from({ length: 17 }, (_, i) => ({ ...spec, id: `model-${i}` }))
  const retained = []
  api.review.recordFinding = async () => ({ threadId: '17' })
  api.failSave(Object.assign(new Error('Storage unavailable'), { code: 'ECONNRESET' }))
  for (const candidate of specs.slice(0, 16)) {
    const result = await api.runReview(candidate, bot, comments, context)
    assert.equal(result.modelCalls, 1)
    retained.push(result.pending)
  }
  assert.equal((await api.runReview(specs[16], bot, comments, context)).modelCalls, 0)
  assert.equal(api.saveAttempts.length, 16)
  assert.equal(api.editorAttempts.length, 0)
  for (let i = 0; i < retained.length; i++) {
    assert.deepEqual(api.pendingReview(specs[i].id, bot.name), retained[i])
  }
  api.failSave(null)
  nextRetry(t, { pending: retained[0] })
  for (let i = 0; i < retained.length; i++) {
    const result = await api.runReview(specs[i], bot, reword(comments), context, { modelBudget: 0 })
    assert.equal(result.modelCalls, 0)
    assert.equal(result.pending, undefined)
    assert.equal(result.review.delivery, null)
    assert.deepEqual(api.saveAttempts[16 + i].delivery, retained[i].delivery)
  }
  assert.equal(api.writes.length, 16)
  assert.equal((await api.runReview(specs[16], bot, comments, context)).modelCalls, 1,
    'persisting retained responses releases capacity for new work')
  assert.equal(api.writes.length, 17)
})

for (const changed of ['body', 'context']) {
  test(`a changed ${changed} replaces an unsaved response with a new review generation`, async t => {
    useClock(t)
    const api = fixture(), { spec, bot, comments, context } = reviewScenario()
    api.review.recordFinding = async () => ({ threadId: '17' })
    api.failSave(Object.assign(new Error('Storage unavailable'), { code: 'ECONNRESET' }))
    const first = await api.runReview(spec, bot, comments, context)
    if (changed === 'body') {
      spec.content += '\n\nA new requirement.'
      api.editNote(spec.id, { content: spec.content })
    } else context.key = 'changed-peer-context'
    const second = await api.runReview(spec, bot, reword(comments), context)
    assert.equal(second.modelCalls, 1)
    assert.notEqual(second.pending.hash, first.pending.hash)
    assert.notEqual(second.pending.delivery.id, first.pending.delivery.id)
    assert.equal(api.editorAttempts.length, 0)
    api.failSave(null)
    nextRetry(t, second)
    const retried = await api.runReview(spec, bot, [], context, { modelBudget: 0 })
    assert.equal(retried.modelCalls, 0)
    assert.equal(retried.review.delivery, null)
    assert.deepEqual(api.saveAttempts[2].delivery, second.pending.delivery)
    assert.equal(api.writes.length, 1)
    assert.ok(api.writes[0].content.includes('Reworded.'))
  })
}

test('an editor failure retries the saved mutation without rerunning a model', async t => {
  useClock(t)
  const api = fixture(), { spec, bot, comments, context } = reviewScenario()
  api.review.recordFinding = async () => ({ threadId: '17' })
  api.failEditor(Object.assign(new Error('Editor unavailable'), { status: 503 }))
  const first = await api.runReview(spec, bot, comments, context)
  assert.equal(first.modelCalls, 1)
  assert.equal(first.health, undefined)
  assert.equal(first.review.delivery.state, 'pending')
  assert.equal(first.review.delivery.findings.length, 0)
  assert.equal(api.writes.length, 0)
  assert.equal(api.editorAttempts.length, 1)
  await api.runReview(spec, bot, reword(comments), context)
  assert.equal(api.editorAttempts.length, 1)
  api.failEditor(null)
  nextRetry(t, first)
  const retried = await api.runReview(spec, bot, reword(comments), context, { modelBudget: 0, blockModel: true })
  assert.equal(retried.modelCalls, 0)
  assert.deepEqual(api.editorAttempts[1], api.editorAttempts[0], 'operation ID and exact mutation survive the retry')
  assert.equal(api.writes.length, 1)
  assert.equal(retried.review.delivery, null)
})

for (const edit of ['frontmatter', 'comment']) {
  test(`a ${edit} edit rebases saved inline remarks without another model call`, async t => {
    useClock(t)
    const api = fixture(), { spec, bot, comments, context } = reviewScenario()
    api.review.recordFinding = async () => ({ threadId: '17' })
    api.failEditor(Object.assign(new Error('Editor open'), { status: 409 }))
    const first = await api.runReview(spec, bot, comments, context)
    const original = first.review.delivery.mutation
    const content = edit === 'frontmatter'
      ? '---\ntitle: Updated title\n---\n' + spec.content
      : spec.content + '{>>@human: Please clarify.<<}'
    api.editNote(spec.id, { content })
    spec.content = content
    api.failEditor(null)
    nextRetry(t, first)
    const rebased = await api.runReview(spec, bot, reword(comments), context, { modelBudget: 0 })
    assert.equal(rebased.modelCalls, 0)
    assert.equal(rebased.review.delivery.state, 'pending')
    assert.notEqual(rebased.review.delivery.mutation.operationId, original.operationId)
    assert.equal(api.writes.length, 0, 'the replacement operation is saved before it is attempted')
    const restarted = api.restart()
    nextRetry(t, rebased)
    const delivered = await restarted.runReview(spec, bot, reword(comments), context, { modelBudget: 0 })
    assert.equal(delivered.modelCalls, 0)
    assert.equal(delivered.review.delivery, null)
    assert.equal(restarted.writes.length, 1)
    assert.deepEqual(restarted.writes[0], rebased.review.delivery.mutation)
    assert.ok(restarted.writes[0].content.includes(comments[1].comment))
    assert.ok(!restarted.writes[0].content.includes('Reworded.'))
    assert.ok(restarted.writes[0].content.includes(edit === 'frontmatter' ? 'Updated title' : 'Please clarify.'))
  })
}

for (const anchored of [true, false]) {
  test(`a second bot's ${anchored ? 'anchored' : 'unanchored'} comment preserves pending review delivery and its link`, async t => {
    useClock(t)
    const api = fixture(), { spec, bot, comments, context } = reviewScenario()
    api.review.recordFinding = async () => ({ threadId: '17' })
    api.failEditor(Object.assign(new Error('Editor open'), { status: 409 }))
    const first = await api.runReview(spec, bot, comments, context)
    api.failEditor(null)
    const other = { ...bot, name: 'second-reviewer' }
    await api.runReview(spec, other, [{ quote: anchored ? spec.content : 'Words absent from this note.', comment: 'Another observation.' }], context)
    assert.equal(api.writes.length, 1)
    nextRetry(t, first)
    const rebased = await api.runReview(spec, bot, reword(comments), context, { modelBudget: 0 })
    assert.equal(rebased.modelCalls, 0)
    assert.equal(rebased.review.delivery.state, 'pending')
    nextRetry(t, rebased)
    const delivered = await api.runReview(spec, bot, reword(comments), context, { modelBudget: 0 })
    assert.equal(delivered.modelCalls, 0)
    assert.equal(delivered.review.delivery, null)
    assert.equal(api.writes.length, 2)
    const actual = api.threadAnchors(api.currentNote(spec.id).content).find(anchor => anchor.author === bot.name)
    assert.ok(actual)
    assert.ok(api.notifications.at(-1).endsWith('#' + actual.id), 'the notification links to the final comment placement')
    assert.ok(!api.writes[1].content.includes('Reworded.'))
  })
}

test('changes beyond the reviewed excerpt preserve a pending response for that excerpt', async t => {
  useClock(t)
  const api = fixture(), { spec, bot, comments, context } = reviewScenario()
  spec.content += '\n' + 'a'.repeat(api.REVIEW_MAX_CHARS) + '\nOriginal tail.'
  api.review.recordFinding = async () => ({ threadId: '17' })
  api.failEditor(Object.assign(new Error('Editor open'), { status: 409 }))
  const first = await api.runReview(spec, bot, [comments[1]], context)
  spec.content = spec.content.replace('Original tail.', 'Changed tail.')
  api.editNote(spec.id, { content: spec.content })
  api.failEditor(null)
  nextRetry(t, first)
  const rebased = await api.runReview(spec, bot, [], context, { modelBudget: 0 })
  assert.equal(rebased.modelCalls, 0)
  assert.equal(rebased.review.delivery.state, 'pending')
  nextRetry(t, rebased)
  const delivered = await api.runReview(spec, bot, [], context, { modelBudget: 0 })
  assert.equal(delivered.modelCalls, 0)
  assert.equal(delivered.review.delivery, null)
  assert.ok(api.currentNote(spec.id).content.includes('Changed tail.'))
})

for (const edit of ['body', 'permission']) {
  test(`a concurrent ${edit} change does not rebase a stale review`, async t => {
    useClock(t)
    const api = fixture(), { spec, bot, comments, context } = reviewScenario()
    api.review.recordFinding = async () => ({ threadId: '17' })
    api.failEditor(Object.assign(new Error('Editor open'), { status: 409 }))
    const first = await api.runReview(spec, bot, comments, context)
    api.editNote(spec.id, edit === 'body' ? { content: spec.content + '\nA new requirement.' } : { permission: 'locked' })
    api.failEditor(null)
    nextRetry(t, first)
    const refused = await api.runReview(spec, bot, comments, context, { modelBudget: 0 })
    assert.equal(refused.modelCalls, 0)
    assert.equal(refused.review.delivery.state, 'failed')
    assert.equal(api.writes.length, 0)
    assert.equal(refused.review.delivery.mutation, undefined)
  })
}

test('a lost editor reply replays its receipt without replacing a newer human edit', async t => {
  useClock(t)
  const api = fixture(), { spec, bot, comments, context } = reviewScenario()
  api.review.recordFinding = async () => ({ threadId: '17' })
  api.failEditor(Object.assign(new Error('Reply lost'), { code: 'ECONNRESET' }), true)
  const first = await api.runReview(spec, bot, comments, context)
  assert.equal(first.review.delivery.state, 'pending')
  assert.equal(api.writes.length, 1)
  const snapshot = { ...spec, ...api.currentNote(spec.id) }
  const changed = snapshot.content + '\n\nA later human clarification.'
  api.editNote(spec.id, { content: changed, authorship: 'new human attribution' })
  api.failEditor(null)
  nextRetry(t, first)
  const retried = await api.runReview(snapshot, bot, reword(comments), context)
  assert.equal(retried.modelCalls, 0)
  assert.equal(retried.review.delivery, null)
  assert.deepEqual(api.editorAttempts[1], api.editorAttempts[0])
  assert.equal(api.writes.length, 1, 'receipt replay cannot insert the comments again')
  assert.equal(snapshot.content, changed)
  assert.equal(snapshot.authorship, 'new human attribution')
  assert.equal(api.currentNote(spec.id).content, changed)
})

for (const changes of [{ permission: 'private' }, { namespace: 'other/specs' }]) {
  test(`a context source changed to ${JSON.stringify(changes)} blocks queued inline output`, async t => {
    useClock(t)
    const api = fixture(), { spec, peer, bot, comments, context } = reviewScenario()
    const third = { ...peer, id: 'uncited', content: 'Additional context without a reported conflict.' }
    context.ids.push(third.id)
    context.sources.push({ label: '3', spec: third, supplied: third.content })
    api.review.recordFinding = async () => ({ threadId: '17' })
    api.failEditor(Object.assign(new Error('Editor unavailable'), { status: 503 }))
    const first = await api.runReview(spec, bot, comments, context)
    api.editNote(third.id, changes)
    api.failEditor(null)
    nextRetry(t, first)
    const retried = await api.runReview(spec, bot, reword(comments), context)
    assert.equal(retried.modelCalls, 0)
    assert.equal(retried.review.delivery.state, 'failed')
    assert.equal(api.writes.length, 0)
    assert.equal(api.editorAttempts.length, 1, 'all original context is checked before contacting the editor')
  })
}

test('an invalid peer quote retains a uniquely anchored local remark', async () => {
  const api = fixture()
  const spec = { id: 'model', namespace: 'team/specs', permission: 'freely', admitted: true, statusIdx: 1,
    changed: '2020-01-01', title: 'Model', content: 'Strings remain strings in the model.' }
  const peer = { ...spec, id: 'format', content: 'No implicit content inference.' }
  const bot = { name: 'reviewer', namespaces: ['team/specs'], url: 'https://model.test', model: 'fixture' }
  api.review.recordFinding = async () => { throw new Error('Invalid evidence must not reach shared storage') }
  const comments = [{ quote: spec.content, comment: 'Explain what counts as a string.',
    conflictsWith: '2', conflictQuote: 'An invented quotation.' }]
  const context = { text: peer.content, key: 'peer', labels: ['2'], ids: [peer.id], sources: [{ label: '2', spec: peer, supplied: peer.content }] }
  const result = await api.runReview(spec, bot, comments, context)
  assert.equal(api.writes.length, 1)
  assert.ok(api.writes[0].content.includes('Explain what counts as a string.'))
  assert.equal(result.review.delivery, null, 'invalid evidence is handled, not retried as failed storage')
  assert.equal((await api.runReview(spec, bot, comments, context)).modelCalls, 0)
})

function findingAuthorization (api, { spec, peer, bot }) {
  const { createReviewService } = require('./review-service')
  const { contentHash } = require('./editor-client')
  bot.enabled = true
  for (const note of [spec, peer]) { note.ownerSubject = '42'; note.tags = [] }
  const sources = new Map([spec, peer].map(note => [note.id, { id: note.id, namespace: note.namespace,
    permission: note.permission, content: note.content, body: note.content, contentHash: contentHash(note.content),
    status: 'in-review', spec: note }]))
  api.sources(async id => sources.get(id))
  let writes = 0
  const service = createReviewService({ loadSource: async id => sources.get(id), authorize: async () => false,
    prepareAutomation: api.prepareFindingAuthorization, authorizeAutomation: api.authorizeFinding,
    store: { upsertFinding: async ({ validate }) => {
      await validate({ query: async () => ({ rows: [{ bot }] }) })
      writes++
      return { created: false }
    } } })
  api.review.recordFinding = service.recordFinding
  return { get writes () { return writes } }
}

const rolesDocument = () => ({ content: Buffer.from(JSON.stringify({
  approvers: [{ id: '42', login: 'maintainer' }], authors: [{ id: '42', login: 'maintainer' }]
})).toString('base64') })

function addUncitedContext ({ peer, comments, context }) {
  const second = { ...peer, id: 'validation', content: 'String values must be converted before validation.' }
  const uncited = { ...peer, id: 'uncited', content: 'Additional model context.' }
  context.ids.push(second.id, uncited.id)
  context.labels.push('3')
  context.sources.push({ label: '3', spec: second, supplied: second.content },
    { label: '4', spec: uncited, supplied: uncited.content })
  comments.unshift({ ...comments[0], conflictsWith: '3', conflictQuote: second.content,
    comment: 'A separate explanation of the disagreement.' })
  return uncited
}

for (const warm of [false, true]) {
  test(`${warm ? 'cached' : 'uncached'} governance lookup failure retains shared findings for retry`, async t => {
    useClock(t)
    const api = fixture(), scenario = reviewScenario()
    const { spec, bot, comments, context } = scenario
    const authorized = findingAuthorization(api, scenario)
    api.roles(async () => rolesDocument())
    if (warm) await api.prepareFindingAuthorization({ noteIds: [spec.id, scenario.peer.id] })
    api.roles(async () => { throw Object.assign(new Error('GitHub unavailable'), { status: 503 }) })
    const first = await api.runReview(spec, bot, comments, context)
    assert.equal(first.modelCalls, 1)
    assert.equal(first.review.delivery.state, 'pending')
    assert.equal(first.review.delivery.reason, 'review-policy-unavailable')
    assert.equal(first.review.delivery.findings.length, 1)
    assert.equal(authorized.writes, 0)
    assert.equal(api.editorAttempts.length, 0)
    api.roles(async () => rolesDocument())
    nextRetry(t, first)
    const retried = await api.runReview(spec, bot, reword(comments), context, { modelBudget: 0 })
    assert.equal(retried.modelCalls, 0)
    assert.equal(retried.review.delivery, null)
    assert.equal(authorized.writes, 1)
    assert.equal(api.writes.length, 1)
  })
}

test('a confirmed missing governance policy remains a terminal authorization denial', async t => {
  useClock(t)
  const api = fixture(), scenario = reviewScenario()
  const { spec, bot, comments, context } = scenario
  const authorized = findingAuthorization(api, scenario)
  let reads = 0
  api.roles(async () => { reads++; throw Object.assign(new Error('Not found'), { status: 404 }) })
  const first = await api.runReview(spec, bot, comments, context)
  assert.equal(reads, 2)
  assert.equal(first.review.delivery.state, 'failed')
  assert.equal(first.review.delivery.rejected, 1)
  assert.equal(authorized.writes, 0)
  assert.equal((await api.runReview(spec, bot, comments, context)).modelCalls, 0)
})

for (const failure of ['hidden', 'suspended', 'missing', 'moved']) {
  test(`uncited context becoming ${failure} during a model call prevents every shared save`, async t => {
    useClock(t)
    const api = fixture(), scenario = reviewScenario()
    const { spec, bot, comments, context } = scenario
    const uncited = addUncitedContext(scenario)
    let findings = 0
    api.review.recordFinding = async () => { findings++; return { threadId: '17' } }
    const first = await api.runReview(spec, bot, comments, context, { afterModel: () => {
      if (failure === 'hidden') api.editNote(uncited.id, { hidden: true })
      else if (failure === 'moved') api.editNote(uncited.id, { namespace: 'other/specs' })
      else api.failSource(uncited.id, Object.assign(new Error('Source unavailable'), { status: failure === 'missing' ? 404 : 403 }))
    } })
    assert.equal(first.modelCalls, 1)
    assert.equal(findings, 0)
    assert.equal(api.editorAttempts.length, 0)
    assert.equal(first.review.delivery.state, 'failed')
    assert.equal(first.review.delivery.findings, undefined)
    assert.equal(first.review.delivery.mutation, undefined)
  })
}

test('transient whole-context lookup failure retries all saved findings without new model output', async t => {
  useClock(t)
  const api = fixture(), scenario = reviewScenario()
  const { spec, bot, comments, context } = scenario
  const uncited = addUncitedContext(scenario)
  const findings = []
  api.review.recordFinding = async finding => { findings.push(finding); return { threadId: '17' } }
  const first = await api.runReview(spec, bot, comments, context, { afterModel: () => {
    api.failSource(uncited.id, Object.assign(new Error('Database unavailable'), { code: 'ECONNRESET' }))
  } })
  assert.equal(first.modelCalls, 1)
  assert.equal(first.review.delivery.state, 'pending')
  assert.equal(first.review.delivery.findings.length, 2)
  assert.equal(findings.length, 0)
  assert.equal(api.editorAttempts.length, 0)
  api.failSource(uncited.id, null)
  nextRetry(t, first)
  const retried = await api.runReview(spec, bot, reword(comments), context, { modelBudget: 0 })
  assert.equal(retried.modelCalls, 0)
  assert.equal(retried.review.delivery, null)
  assert.deepEqual(findings, first.review.delivery.findings)
  assert.equal(api.writes.length, 1)
})

test('uncited context hidden between attempts stops every pending shared finding', async t => {
  useClock(t)
  const api = fixture(), scenario = reviewScenario()
  const { spec, bot, comments, context } = scenario
  const uncited = addUncitedContext(scenario)
  let findings = 0
  api.review.recordFinding = async () => {
    findings++
    throw Object.assign(new Error('Busy'), { status: 409, code: 'review-busy' })
  }
  const first = await api.runReview(spec, bot, comments, context)
  assert.equal(findings, 2)
  assert.equal(first.review.delivery.findings.length, 2)
  api.editNote(uncited.id, { hidden: true })
  nextRetry(t, first)
  const retried = await api.runReview(spec, bot, reword(comments), context, { modelBudget: 0 })
  assert.equal(retried.modelCalls, 0)
  assert.equal(findings, 2)
  assert.equal(retried.review.delivery.state, 'failed')
  assert.equal(api.editorAttempts.length, 0)
})
