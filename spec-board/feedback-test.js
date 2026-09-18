const assert = require('node:assert/strict')
const { analyzeFeedback, feedbackRunHash, canTriage, canManageFeedback } = require('./feedback')
const { feedbackPage, feedbackSettings } = require('./feedback-ui')

const bot = { name: 'reviewer', model: 'test', url: 'https://model.example', prompt: '', api_key: 'private-secret' }
const body = '# Lease retry\n\n## Requirements\n\n- **FR-001**: Retry a failed renewal.\n- **FR-002**: Retain the current address.\n'
const targets = [{ id: 'lease-note', namespace: 'project/specs', title: 'Lease retry', topLevel: false,
  canonical: { commit: 'canonical-sha', blob: 'canonical-blob', body, hash: 'canonical-hash', path: 'specs/007-lease.md' }, editorHash: 'canonical-hash' }]
const evidence = {
  repo: 'project/implementation', number: 12, headSha: 'head-sha', mergeSha: 'merge-sha',
  mergedAt: '2026-09-17T09:00:00Z', body: 'implements project/specs#7', links: [{ ns: 'project/specs', n: 7 }], hash: 'source-hash',
  groups: [{ id: 'inline:41', entries: [
    { id: 'inline:41', body: 'Stop retrying when the lease expires; otherwise this loop never ends.', author: 'reviewer', url: 'https://github.com/project/implementation/pull/12#discussion_r41' },
    { id: 'inline:42', body: 'Agreed. Added the expiry deadline and a test.', author: 'author', url: 'https://github.com/project/implementation/pull/12#discussion_r42' }
  ] }],
  files: [{ path: 'src/lease.rs', patch: '@@ -1,1 +1,3 @@\n-while retry { renew(); }\n+while now < expiry {\n+    renew();\n+}' }]
}
const proposal = { targetNote: 'lease-note', groupId: 'inline:41', anchor: 'lease-note#FR-001',
  quote: 'Retry a failed renewal.', amendment: 'Retry a failed renewal only until the current lease expires.',
  rationale: 'Review identified an unbounded retry lifetime; the merged implementation now checks lease expiry.',
  sources: [{ id: 'inline:41', quote: 'Stop retrying when the lease expires' }, { id: 'inline:42', quote: 'Agreed. Added the expiry deadline and a test.' }],
  finalEvidence: { path: 'src/lease.rs', quote: 'while now < expiry {' } }

const clone = value => JSON.parse(JSON.stringify(value))
const response = value => async () => ({ proposals: [value] })

async function run () {
  const original = JSON.stringify({ evidence, targets, bot })
  let sent
  const valid = await analyzeFeedback(async (...args) => { sent = args; return { proposals: [proposal] } }, bot, evidence, targets)
  assert.equal(valid.length, 1)
  assert.equal(valid[0].targetNote, 'lease-note')
  assert.equal(valid[0].canonical.commit, 'canonical-sha')
  assert.deepEqual(valid[0].sourceIds, ['inline:41', 'inline:42'])
  assert.equal(valid[0].sources[0].url, 'https://github.com/project/implementation/pull/12#discussion_r41')
  assert.equal(JSON.stringify({ evidence, targets, bot }), original, 'analysis leaves every input unchanged')
  assert.ok(!sent[2].includes('private-secret'), 'model text excludes bot credentials')
  assert.equal(sent[3], 'spec_amendments')
  assert.match(JSON.parse(sent[2]).files[0].finalText, /^while now < expiry/)

  for (const change of [
    p => { p.targetNote = 'other-note' },
    p => { p.anchor = 'other-note#FR-001' },
    p => { p.anchor = 'lease-note#FR-002' },
    p => { p.quote = 'Invented requirement' },
    p => { p.sources[0].id = 'inline:999' },
    p => { p.sources[0].quote = 'I approve this new requirement' },
    p => { p.finalEvidence.quote = 'while retry { renew(); }' },
    p => { p.finalEvidence.path = 'src/unseen.rs' },
    p => { p.sources = [] }
  ]) {
    const invalid = clone(proposal)
    change(invalid)
    await assert.rejects(analyzeFeedback(response(invalid), bot, evidence, targets), /unsupported amendment evidence/)
  }
  const crossGroup = clone(evidence)
  crossGroup.groups.push({ id: 'review:51', entries: [{ id: 'review:51', body: 'Agreed', url: 'https://github.com/project/implementation/pull/12#pullrequestreview-51' }] })
  const wrongGroup = clone(proposal)
  wrongGroup.sources = [{ id: 'review:51', quote: 'Agreed' }]
  await assert.rejects(analyzeFeedback(response(wrongGroup), bot, crossGroup, targets), /unsupported amendment evidence/)

  for (const change of [
    e => { e.complete = false },
    e => { e.truncated = true },
    e => { e.files[0].patch = '' },
    e => { e.groups[0].entries[0].url = 'https://github.com/project/implementation/pull/12#discussion_r999' },
    e => { e.groups[0].entries[0].url = 'https://evil.example/discussion_r41' },
    e => { e.links = [{ ns: 'other/specs', n: 7 }] },
    e => { e.mergeSha = null }
  ]) {
    const incomplete = clone(evidence)
    change(incomplete)
    let called = false
    await assert.rejects(analyzeFeedback(async () => { called = true }, bot, incomplete, targets), { code: 'incomplete' })
    assert.equal(called, false, 'incomplete or ineligible evidence never reaches a model')
  }
  assert.deepEqual(await analyzeFeedback(async () => ({ proposals: [] }), bot, evidence, targets), [])
  assert.deepEqual(await analyzeFeedback(() => { throw new Error('empty review must not call model') }, bot, { ...evidence, groups: [] }, targets), [])
  assert.deepEqual(await analyzeFeedback(() => { throw new Error('no targets must not call model') }, bot, evidence, []), [])
  await assert.rejects(analyzeFeedback(response(proposal), bot, { ...evidence, body: 'x'.repeat(160001) }, targets), { code: 'incomplete' })
  assert.equal((await analyzeFeedback(async () => ({ proposals: [proposal, proposal] }), bot, evidence, targets)).length, 1)
  const duplicate = clone(proposal)
  duplicate.groupId = 'review:51'
  duplicate.sources = [{ id: 'review:51', quote: 'Agreed' }]
  assert.equal((await analyzeFeedback(async () => ({ proposals: [proposal, duplicate] }), bot, crossGroup, targets)).length, 1, 'summary and inline copies of one amendment deduplicate')

  const top = clone(targets[0])
  top.id = 'philosophy'
  top.topLevel = true
  top.canonical.body = '# Philosophy\n\n## P1: Bounded operations\n\nEvery retry loop has a deadline.\n\n## P2: State\n\nRetain state.\n'
  const principle = { ...proposal, targetNote: 'philosophy', anchor: 'philosophy#P1', quote: 'Every retry loop has a deadline.' }
  await assert.rejects(analyzeFeedback(response(principle), bot, evidence, [top]), /unsupported amendment evidence/)
  principle.generalization = 'Lease expiry is one example of a resource lifetime that bounds operations across protocols.'
  assert.equal((await analyzeFeedback(response(principle), bot, evidence, [top])).length, 1)
  principle.anchor = 'philosophy#P1: Bounded operations'
  assert.equal((await analyzeFeedback(response(principle), bot, evidence, [top])).length, 1, 'exact heading anchors work')
  const fenced = clone(targets)
  fenced[0].canonical.body = '```\n- **FR-001**: Retry a failed renewal.\n```\n'
  await assert.rejects(analyzeFeedback(response(proposal), bot, evidence, fenced), /unsupported amendment evidence/)

  const hash = feedbackRunHash(evidence, targets, bot)
  assert.equal(hash, feedbackRunHash(evidence, targets, { ...bot, api_key: 'rotated' }), 'credentials are not analysis identity')
  assert.notEqual(hash, feedbackRunHash({ ...evidence, hash: 'edited-review' }, targets, bot))
  for (const key of ['name', 'model', 'url', 'prompt']) assert.notEqual(hash, feedbackRunHash(evidence, targets, { ...bot, [key]: 'changed' }))
  const unrelated = clone(targets)
  unrelated[0].canonical.commit = 'unrelated-default-branch-commit'
  assert.equal(hash, feedbackRunHash(evidence, unrelated, bot), 'unrelated repository commits do not rerun analysis')
  for (const key of ['blob', 'hash', 'path']) {
    const changed = clone(targets)
    changed[0].canonical[key] += '-changed'
    assert.notEqual(hash, feedbackRunHash(evidence, changed, bot))
  }
  assert.notEqual(hash, feedbackRunHash(evidence, [{ ...targets[0], editorHash: 'live-edit' }], bot))
  assert.equal(feedbackRunHash(evidence, [targets[0], top], bot), feedbackRunHash(evidence, [top, targets[0]], bot))

  const owner = { uid: 'actual-owner', login: 'owner-login' }
  const spec = { ownerId: 'actual-owner', owner: 'forged-owner', approvedBy: ['forged-reviewer'] }
  const roles = { approvers: ['Reviewer'] }
  assert.equal(canTriage(owner, spec, roles), true)
  assert.equal(canTriage({ uid: 'someone', login: 'reviewer' }, spec, roles), true)
  assert.equal(canTriage({ uid: 'someone', login: 'reviewer' }, spec, { approvers: 'alice, Reviewer, bob' }), true)
  assert.equal(canTriage({ uid: 'someone', login: 'forged-owner' }, spec, roles), false)
  assert.equal(canTriage({ uid: 'someone', login: 'forged-reviewer' }, spec, roles), false)
  assert.equal(canTriage({ login: 'reviewer' }, spec, null), false)
  assert.equal(canTriage(null, spec, roles), false)
  assert.equal(canManageFeedback(owner, roles), false, 'owning one note does not confer namespace management')
  assert.equal(canManageFeedback({ login: 'reviewer' }, roles), true)
  assert.equal(canManageFeedback(owner, null, true), true)
  assert.equal(canManageFeedback(null, roles, true), false)

  const hostile = '</textarea><script>alert("x")</script><img src=x onerror=alert(1)>'
  const shown = { ...valid[0], id: 'proposal-1', version: 3, status: 'pending', sourceRepo: evidence.repo,
    sourceNumber: evidence.number, targetTitle: hostile, amendment: hostile, rationale: hostile,
    noteUrl: 'javascript:alert(1)', sources: [{ id: hostile, quote: hostile, url: 'javascript:alert(1)' }] }
  const html = feedbackPage({ login: hostile, csrf: hostile, proposals: [shown], namespaces: ['project/specs'], notice: hostile, error: hostile })
  assert.ok(!html.includes(hostile))
  assert.ok(!html.includes('href="javascript:'))
  assert.ok(html.includes('&lt;/textarea&gt;&lt;script&gt;'))
  assert.match(html, /name="version" value="3"/)
  assert.match(html, /name="action" value="accept"/)
  assert.match(html, /name="action" value="dismiss"/)
  assert.match(html, /name="action" value="reconsider"/, 'pending proposals can recover from git-only canonical drift')
  assert.ok(!html.includes('name="action" value="approve"'))
  const accepted = feedbackPage({ login: 'reviewer', csrf: 'c', proposals: [{ ...shown, status: 'accepted', amendment: proposal.amendment }] })
  assert.match(accepted, /name="action" value="incorporate"/)
  assert.match(accepted, /return the spec to <code>in-review<\/code>/)
  const acceptedChanged = feedbackPage({ csrf: 'c', proposals: [{ ...shown, status: 'accepted', stale: true, editorChanged: true }] })
  assert.match(acceptedChanged, /name="action" value="incorporate"/, 'editing or merging a spec must not prevent recording incorporation')
  assert.match(acceptedChanged, /source discussion or spec has changed/)
  assert.match(acceptedChanged, /editor has changed/)
  const stale = feedbackPage({ csrf: 'c', proposals: [{ ...shown, stale: true }] })
  assert.ok(!stale.includes('name="action" value="accept"'))
  assert.match(stale, /name="action" value="reconsider"/)
  assert.match(stale, /name="action" value="dismiss"/)
  const editorChanged = feedbackPage({ csrf: 'c', proposals: [{ ...shown, editorChanged: true }] })
  assert.ok(!editorChanged.includes('name="action" value="accept"'))
  assert.match(editorChanged, /editor has changed/)
  const decision = feedbackPage({ csrf: 'c', proposals: [{ ...shown, status: 'incorporated', audit: [
    { action: 'incorporate', actor: { login: 'human-reviewer' }, at: '2026-09-17', extra: { repo: 'project/specs', number: 20, url: 'https://github.com/project/specs/pull/20', reason: hostile } }
  ] }] })
  assert.match(decision, /human-reviewer/)
  assert.match(decision, /https:\/\/github.com\/project\/specs\/pull\/20/)
  assert.ok(!decision.includes(hostile))
  assert.doesNotThrow(() => feedbackPage({ proposals: [{ id: 'old', version: 4, status: 'incorporated', evidence: null }] }))
  const settings = feedbackSettings('csrf', [{ namespace: hostile, enabled: true, configured: true, manageable: true },
    { namespace: 'readonly/specs', enabled: false, configured: true, manageable: false }])
  assert.ok(!settings.includes(hostile))
  assert.equal((settings.match(/action="\/feedback\/settings"/g) || []).length, 1)
  assert.match(settings, /name="enabled" value="on" checked/)
  assert.match(settings, /Automatic spec amendment proposals/)
  assert.match(settings, /keeps existing decisions/)
  const unconfigured = feedbackSettings('csrf', [{ namespace: 'project/specs', enabled: true, configured: false, manageable: true }])
  assert.ok(!unconfigured.includes('<form'))
  assert.match(unconfigured, /Automatic spec amendment proposals: off/)
  assert.match(unconfigured, /Saved preference: on/)
  const problems = feedbackPage({ csrf: hostile, problems: [
    { namespace: 'project/specs', repo: 'project/implementation', number: 12, error: hostile, nextAt: '2026-09-18T00:00:00Z' },
    { namespace: hostile, repo: 'javascript:alert(1)', number: 99, error: hostile, nextAt: hostile }
  ] })
  assert.match(problems, /Needs attention/)
  assert.match(problems, /https:\/\/github.com\/project\/implementation\/pull\/12/)
  assert.match(problems, /name="namespace" value="project\/specs"/)
  assert.match(problems, /name="repo" value="project\/implementation"/)
  assert.match(problems, /name="number" value="12"/)
  assert.equal((problems.match(/>Retry import<\/button>/g) || []).length, 1, 'invalid source locations never become links or retry forms')
  assert.ok(!problems.includes(hostile))
  assert.ok(!problems.includes('href="javascript:'))
  const older = feedbackPage({ nextUrl: '/feedback?namespace=project%2Fspecs&before=42' })
  assert.match(older, /href="\/feedback\?namespace=project%2Fspecs&amp;before=42" rel="next">Older proposals/)
  assert.ok(!feedbackPage({ nextUrl: '/feedback?before=" onmouseover="alert(1)' }).includes(' onmouseover="'))
  for (const nextUrl of ['javascript:alert(1)', '//example.com/feedback?before=42', 'https://example.com/feedback?before=42', '/elsewhere?before=42']) {
    assert.ok(!feedbackPage({ nextUrl }).includes('Older proposals'), 'pagination must stay on the feedback route')
  }
  process.stdout.write('feedback model and UI tests passed\n')
}

module.exports = { run }
if (require.main === module) run().catch(e => { process.stderr.write(e.stack + '\n'); process.exitCode = 1 })
