const assert = require('assert/strict')
const crypto = require('crypto')
const { createRevisionSummary, SUMMARY_SYSTEM, SUMMARY_SCHEMA, LIMITS } = require('./revision-summary')

const digest = text => crypto.createHash('sha256').update(text).digest('hex')
const before = '# Recovery\n\nRecover state after a restart.\n'
const after = '# Recovery\n\nRecover the journal before accepting writes.\n'
const actor = { uid: 'owner', login: 'alice', email: 'private-account@example.test' }
const output = () => ({ change: 'Require journal recovery before accepting writes.',
  reason: 'The recovery order was unspecified.',
  changeQuotes: [{ source: 'after', quote: 'Recover the journal before accepting writes.' }],
  reasonQuotes: [{ source: 'discussion:one', quote: 'The recovery order was unspecified.' }] })

function fixture () {
  const f = { time: 1800000000000, calls: [], allowed: true, sourceReads: 0, baselineReads: 0, authorizations: 0 }
  f.source = { id: 'note', namespace: 'o/specs', title: 'Recovery', public: true, complete: true,
    content: '---\nowner: alice\n---\n' + after, body: after, ownerId: 'owner', author: 'alice', editor: 'bob', status: 'in-review',
    publication: { prNumber: 7, revisionPr: 8, prState: 'merged', publishedCommit: 'a'.repeat(40), specPath: 'specs/007-recovery.md' },
    discussionVersion: 1,
    discussion: [{ id: 'one', author: 'alice', body: 'The recovery order was unspecified.', role: 'owner', resolved: false }] }
  f.sources = new Map([['note', f.source]])
  f.baseline = { mode: 'revision', commit: 'a'.repeat(40), path: 'specs/007-recovery.md', body: before, hash: digest(before) }
  f.bot = { name: 'reviewer', url: 'https://model.example', model: 'model', api_key: 'account-secret', namespaces: ['o/specs'] }
  f.result = output()
  f.service = createRevisionSummary({
    now: () => f.time,
    loadSource: async id => { f.sourceReads++; return f.sources.get(id) },
    authorize: async who => {
      f.authorizations++
      if (f.authError) throw f.authError
      return f.allowed && (who.exp == null || who.exp > f.time)
    },
    loadBaseline: async () => { f.baselineReads++; if (f.baselineError) throw f.baselineError; if (f.onBaseline) f.onBaseline(); return f.baseline },
    loadBot: async () => { if (f.onBot) f.onBot(); return f.bot },
    callModel: async (...args) => {
      f.calls.push(args)
      if (f.onModel) return f.onModel()
      return structuredClone(f.result)
    }
  })
  f.generate = (id = 'note', who = actor) => f.service.generate(id, { expectedHash: digest(f.sources.get(id).content), actor: who })
  return f
}

async function main () {
  {
    const f = fixture()
    await f.generate()
    f.time += LIMITS.resultMs
    const reads = f.sourceReads
    assert.equal(await f.service.peek('note'), null)
    assert.equal(await f.service.peek('note'), null)
    assert.equal(f.sourceReads, reads, 'expired summaries are removed before loading their discussion context')
  }
  {
    const f = fixture()
    f.baseline.documentHash = digest('verified publication envelope plus prose')
    const result = await f.generate()
    assert.equal(result.before.hash, f.baseline.documentHash, 'summary comparisons remain bound to the exact published file')
    assert.equal(JSON.parse(f.calls[0][2]).sources[0].text, before, 'only requirement text is sent as the before source')
  }
  {
    const f = fixture()
    f.baseline.body = f.source.body
    f.baseline.hash = digest(f.baseline.body)
    f.bot = null
    const expected = { status: 'unchanged', message: 'No changes to the published requirements.' }
    assert.equal(await f.service.peek('note'), null)
    assert.equal(f.sourceReads, 0, 'an unrequested summary reads no discussion context')
    assert.equal(f.baselineReads, 0, 'An unrequested comparison does not read GitHub')
    assert.deepEqual(await f.generate(), expected)
    const reads = f.baselineReads
    assert.deepEqual(await f.service.peek('note'), expected)
    assert.equal(f.baselineReads, reads, 'Reading an unchanged result reuses its proved baseline')
    assert.equal(f.calls.length, 0, 'Unchanged requirements do not need a model or model configuration')
    f.source.discussion[0].body += ' An unresolved question remains.'
    assert.equal(await f.service.peek('note'), null, 'A discussion change hides the previously requested comparison')
    await assert.rejects(f.service.generate('note', { expectedHash: '0'.repeat(64), actor }), e => e.code === 'summary-stale')
    f.allowed = false
    await assert.rejects(f.generate(), e => e.code === 'not-authorized')
  }
  {
    const f = fixture()
    assert.equal(await f.service.peek('note'), null)
    assert.equal(f.calls.length, 0, 'Reading never invokes the model')
    assert.equal(f.baselineReads, 0, 'Passive reads never resolve an external baseline')
    assert.equal(f.authorizations, 0, 'Public cached reads need no actor')
    const result = await f.generate()
    assert.equal(result.mode, 'revision')
    assert.equal(result.before.hash, digest(before))
    assert.equal(result.afterHash, digest(after))
    assert.equal(result.sourceHash, digest(f.source.content))
    assert.equal(result.advisory, true)
    assert.equal(result.reason, f.result.reason)
    assert.equal(f.calls[0][1], SUMMARY_SYSTEM)
    assert.deepEqual(f.calls[0][3], SUMMARY_SCHEMA)
    const supplied = JSON.parse(f.calls[0][2])
    assert.deepEqual(supplied.sources.at(-1), { id: 'discussion:one', text: f.source.discussion[0].body, role: 'owner' })
    assert.ok(supplied.comparison.includes('{+'))
    assert.ok(!f.calls[0][2].includes(actor.email) && !f.calls[0][2].includes(f.bot.api_key))
    assert.ok(!f.calls[0][2].includes('alice'), 'Model evidence omits account names and note metadata')
    result.change = 'Mutated by a caller'
    const baselineReads = f.baselineReads
    f.baselineError = new Error('Passive reads must not call GitHub')
    assert.equal((await f.service.peek('note')).change, f.result.change)
    assert.equal(f.baselineReads, baselineReads)
    f.baselineError = null
    assert.equal((await f.generate()).change, f.result.change)
    assert.equal(f.calls.length, 1, 'An identical authorized request reuses the result')
  }
  {
    const f = fixture()
    await f.generate()
    f.source.discussion[0].resolved = true
    assert.equal(await f.service.peek('note'), null, 'Structured discussion changes invalidate cached text')
    f.time += LIMITS.actorCooldownMs
    await f.generate()
    f.source.discussionVersion++
    assert.equal(await f.service.peek('note'), null)
    f.source.discussionVersion--
    f.source.content += '\n{>>@reviewer: Explain this.<<}\n'
    assert.equal(await f.service.peek('note'), null, 'Raw inline discussion changes invalidate cached text')
  }
  for (const mutate of [
    f => { f.source.publication.revisionPr++ },
    f => { f.source.ownerId = 'new-owner' },
    f => { f.source.ownerSubject = 'another-account' },
    f => { f.source.status = 'approved' },
    f => { f.bot.model = 'another-model' },
    f => { f.bot.api_key = 'rotated-secret' },
    f => { f.source.publication.publishedCommit = 'c'.repeat(40) }
  ]) {
    const f = fixture()
    await f.generate()
    mutate(f)
    assert.equal(await f.service.peek('note'), null, 'Publication, attribution and model changes invalidate cached text')
  }
  {
    const f = fixture()
    f.source.discussion[0].changedAt = new Date('2026-01-01T00:00:00Z')
    await f.generate()
    f.source.discussion[0].changedAt = new Date('2026-01-02T00:00:00Z')
    assert.equal(await f.service.peek('note'), null, 'Stored discussion dates retain their value in the fingerprint')
  }
  {
    const f = fixture()
    f.result.reason = null
    f.result.reasonQuotes = []
    f.source.discussion[0].role = 'unverified-owner'
    const result = await f.generate()
    assert.equal(result.reason, null)
    assert.equal(JSON.parse(f.calls[0][2]).sources.at(-1).role, 'unknown')
    assert.match(SUMMARY_SYSTEM, /resolved thread is not evidence of acceptance/)
  }
  {
    const f = fixture()
    f.baseline = { mode: 'addition', commit: null, path: null, body: '', hash: null }
    f.source.publication = { prNumber: null }
    const result = await f.generate()
    assert.equal(result.mode, 'addition')
    assert.equal(result.before, null)
    const supplied = JSON.parse(f.calls[0][2])
    assert.equal(supplied.comparison, null)
    assert.ok(!supplied.sources.some(s => s.id === 'before'))
  }
  for (const mutate of [
    f => { f.result.changeQuotes[0].quote = 'A quotation the source never contained' },
    f => { f.result.changeQuotes[0].source = 'another-note' },
    f => { f.result.reasonQuotes = [] },
    f => { f.result.reasonQuotes[0].source = 'before' },
    f => { f.result.reason = null },
    f => { f.result.author = 'invented-proposer' }
  ]) {
    const f = fixture()
    mutate(f)
    await assert.rejects(f.generate(), e => e.code === 'unsupported-summary')
    const cached = await f.service.peek('note')
    assert.equal(cached.status, 'failed')
    assert.equal(cached.code, 'unsupported-summary')
    await assert.rejects(f.generate(), e => e.code === 'unsupported-summary')
    assert.equal(f.calls.length, 1, 'Rejected model output is cached through its retry interval')
  }
  for (const [mutate, code] of [
    [f => { f.source.content += '\nEdit\n' }, 'summary-stale'],
    [f => { f.source.discussion[0].body += ' A reply.' }, 'summary-stale'],
    [f => { f.source.public = false }, 'unknown-note'],
    [f => { f.allowed = false }, 'not-authorized'],
    [f => { f.baseline.commit = 'c'.repeat(40) }, 'summary-stale'],
    [f => { f.bot.model = 'replacement' }, 'summary-stale'],
    [f => { f.source.publication.revisionPr++ }, 'summary-stale']
  ]) {
    const f = fixture()
    f.onModel = () => { mutate(f); return output() }
    await assert.rejects(f.generate(), e => e.code === code)
  }
  for (const code of ['sign-in-required', 'not-authorized', 'authorization-unavailable']) {
    const f = fixture()
    const expiring = { ...actor, exp: f.time + 1 }
    if (code === 'sign-in-required') f.onBot = () => { f.time++ }
    else f.onModel = () => {
      if (code === 'not-authorized') f.allowed = false
      else f.authError = new Error('Policy lookup failed')
      return output()
    }
    await assert.rejects(f.generate('note', code === 'sign-in-required' ? expiring : actor), e => e.code === code)
    assert.equal(await f.service.peek('note'), null, 'requester authorization failures are not public summary results')
    f.onBot = null
    f.onModel = null
    f.allowed = true
    f.authError = null
    f.time += LIMITS.projectCooldownMs
    assert.equal((await f.generate('note', { uid: 'another-reviewer' })).status, 'ready',
      'another authorized reviewer can generate without inheriting the prior requester failure')
  }
  for (const hook of ['onBaseline', 'onBot']) {
    for (const [mutate, code] of [
      [f => { f.source.public = false }, 'unknown-note'],
      [f => { f.source.ownerSubject = 'changed-owner' }, 'summary-stale'],
      [f => { f.source.discussion[0].body += ' A late reply.' }, 'summary-stale'],
      [f => { f.source.publication.revisionPr++ }, 'summary-stale']
    ]) {
      const f = fixture()
      f[hook] = () => mutate(f)
      await assert.rejects(f.generate(), e => e.code === code)
      assert.equal(f.calls.length, 0, 'A preflight source race never reaches the model')
    }
  }
  {
    const f = fixture()
    f.onBaseline = () => { f.allowed = false }
    await assert.rejects(f.generate(), e => e.code === 'not-authorized')
    assert.equal(f.calls.length, 0, 'Permissions are rechecked after baseline lookup')
  }
  {
    const f = fixture()
    f.onBot = () => { f.time += 1000 }
    await assert.rejects(f.generate('note', { ...actor, exp: f.time + 1 }), e => e.status === 401)
    assert.equal(f.calls.length, 0, 'An assertion that expires during preflight cannot start model work')
  }
  {
    const f = fixture()
    await assert.rejects(f.service.generate('note', { expectedHash: '0'.repeat(64), actor }), e => e.code === 'summary-stale')
    assert.equal(f.calls.length, 0)
    await assert.rejects(f.service.generate('note', { expectedHash: digest(f.source.content) }), e => e.status === 401)
    f.allowed = false
    await assert.rejects(f.generate(), e => e.status === 403)
    f.allowed = true
    f.source.public = false
    await assert.rejects(f.generate(), e => e.status === 404)
    assert.equal(f.calls.length, 0)
  }
  for (const mutate of [
    f => { f.source.complete = false },
    f => { f.source.body = 'x'.repeat(LIMITS.bodyBytes + 1) },
    f => { f.source.discussion.push({ ...f.source.discussion[0] }) },
    f => { f.source.discussion[0].body = 'x'.repeat(LIMITS.discussionBytes + 1) },
    f => { f.source.discussion = Array.from({ length: LIMITS.discussionMessages + 1 }, (_, i) => ({ id: String(i), body: 'Message' })) }
  ]) {
    const f = fixture()
    mutate(f)
    await assert.rejects(f.generate(), e => e.status === 422)
    assert.equal(f.calls.length, 0, 'Incomplete evidence is refused before model generation')
  }
  {
    const f = fixture()
    f.baseline.body = 'a '.repeat(13000)
    f.baseline.hash = digest(f.baseline.body)
    f.source.body = 'b '.repeat(13000)
    await assert.rejects(f.generate(), e => e.code === 'evidence-too-large')
    assert.equal(f.calls.length, 0)
    assert.equal((await f.service.peek('note')).status, 'failed', 'A pre-call failure does not leave a pending promise')
  }
  {
    const f = fixture()
    f.onModel = () => { throw new Error('Authorization: Bearer account-secret https://upstream/private') }
    await assert.rejects(f.generate(), e => e.code === 'summary-unavailable' && !e.message.includes('secret'))
    assert.ok(!JSON.stringify(await f.service.peek('note')).includes('secret'))
    f.source.content += '\nAnother source\n'
    await assert.rejects(f.generate(), e => e.code === 'summary-cooldown', 'A failed model attempt consumes the cooldown')
    await assert.rejects(f.generate('note', { uid: 'another', login: 'bob' }), e => e.code === 'summary-cooldown', 'The project also has a cooldown')
  }
  {
    const f = fixture()
    f.onModel = () => { throw new Error('Temporary model failure') }
    await assert.rejects(f.generate(), e => e.code === 'summary-unavailable')
    f.time += LIMITS.errorMs
    f.onModel = null
    assert.equal((await f.generate()).status, 'ready')
    assert.equal(f.calls.length, 2, 'An expired error can be retried explicitly')
  }
  {
    const f = fixture()
    f.sources.set('two', { ...structuredClone(f.source), id: 'two', namespace: 'p/specs' })
    await f.generate('note', { ...actor, provider: 'github', subject: '1234' })
    await assert.rejects(f.generate('two', { ...actor, uid: 'another-local-account', provider: 'github', subject: '1234' }),
      e => e.code === 'summary-cooldown', 'Actor cooldowns use the stable provider identity across local accounts')
    assert.equal(f.calls.length, 1)
  }
  {
    const f = fixture()
    f.baseline.hash = digest('not the merged body')
    await assert.rejects(f.generate(), e => e.code === 'baseline-unavailable')
    assert.equal(f.calls.length, 0)
    f.baselineError = new Error('Private repository URL and credential')
    await assert.rejects(f.generate(), e => !e.message.includes('credential'))
  }
  {
    const f = fixture()
    const entered = []
    f.onModel = () => new Promise(resolve => entered.push(resolve))
    for (const [id, namespace] of [['two', 'p/specs'], ['three', 'q/specs']]) {
      f.sources.set(id, { ...structuredClone(f.source), id, namespace })
    }
    const first = f.generate()
    await new Promise(resolve => setImmediate(resolve))
    const duplicate = f.generate()
    const second = f.generate('two', { uid: 'two', login: 'two' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.calls.length, 2, 'Matching requests share the in-flight result')
    assert.equal((await f.service.peek('note')).status, 'pending')
    await assert.rejects(f.generate('three', { uid: 'three', login: 'three' }), e => e.code === 'summary-capacity')
    entered.forEach(resolve => resolve(output()))
    const results = await Promise.all([first, duplicate, second])
    assert.equal(results[0].change, results[1].change)
    assert.equal(f.calls.length, LIMITS.concurrent)
    f.onModel = null
    assert.equal((await f.generate('three', { uid: 'three', login: 'three' })).status, 'ready',
      'a rejected capacity request does not consume the caller or project cooldown')
  }
  {
    const f = fixture()
    const original = f.source.content
    await f.generate()
    for (let i = 0; i < LIMITS.cacheEntries; i++) {
      f.time += LIMITS.actorCooldownMs
      f.source.content = original + '\n' + i
      await f.generate()
    }
    f.source.content = original
    assert.equal(await f.service.peek('note'), null, 'The result cache is bounded')
    f.time += LIMITS.resultMs
    f.source.content = original + '\n' + (LIMITS.cacheEntries - 1)
    assert.equal(await f.service.peek('note'), null, 'Results expire')
  }
  console.log('revision summary fixtures passed')
}

main().catch(error => { console.error(error); process.exitCode = 1 })
