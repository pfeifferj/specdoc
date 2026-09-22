const assert = require('node:assert/strict')
const { analyzeFeedback, feedbackRunHash, canManageFeedback } = require('./feedback')
const { feedbackSettings } = require('./feedback-ui')

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
  assert.equal(canManageFeedback(owner, roles), false, 'owning one note does not confer namespace management')
  assert.equal(canManageFeedback({ login: 'reviewer' }, roles), true)
  assert.equal(canManageFeedback(owner, null, true), true)
  assert.equal(canManageFeedback(null, roles, true), false)

  const hostile = '</textarea><script>alert("x")</script><img src=x onerror=alert(1)>'
  const settings = feedbackSettings('csrf', [{ namespace: hostile, enabled: true, configured: true, manageable: true },
    { namespace: 'readonly/specs', enabled: false, configured: true, manageable: false }])
  assert.ok(!settings.includes(hostile))
  assert.equal((settings.match(/action="\/feedback\/settings"/g) || []).length, 1)
  assert.match(settings, /name="enabled" value="on" checked/)
  assert.match(settings, /Automatic spec amendment proposals/)
  assert.ok(settings.includes('Automatic spec amendment proposals: on. This is one setting for the whole project.'),
    'the row that can be changed says the change lands on everyone who sees the project')
  assert.match(settings, /as suggestions in the note/)
  assert.match(settings, /Save amendment settings/)
  assert.match(settings, /Email preferences above have their own Save/)
  assert.equal((settings.match(/id="amendments"/g) || []).length, 1)
  assert.deepEqual((settings.match(/id="amendments-([^"]*)"/g) || []).map(m => m.slice(4, -1)),
    [hostile, 'readonly/specs'].map(ns => 'amendments-' + ns.replace(/[^a-z0-9]/g, '-')))
  const unconfigured = feedbackSettings('csrf', [{ namespace: 'project/specs', enabled: true, configured: false, manageable: true }])
  assert.ok(!unconfigured.includes('<form'))
  assert.ok(unconfigured.includes("Automatic spec amendment proposals: off. Not running: no review bot is bound to this project, so nothing is proposed. The project's saved preference is on."),
    'a project with no bot bound proposes nothing, so the slot reads off and the stored preference is named as the divergence')
  // One row and nothing before it, so a sentence that leans on a neighbour
  // reads as a sentence about nothing.
  const unconfiguredOff = feedbackSettings('csrf', [{ namespace: 'project/specs', enabled: false, configured: false, manageable: true }])
  assert.equal((unconfiguredOff.match(/<h3 /g) || []).length, 1)
  assert.ok(unconfiguredOff.includes('Automatic spec amendment proposals: off. No review bot is bound to this project, so turning the preference on alone would propose nothing.'),
    'the value in force and the missing binding are stated as two plain facts')
  assert.ok(!/\beither\b/.test(unconfiguredOff), 'the row points at no other row')
  assert.ok(unconfiguredOff.includes('.specs/roles.yml'), 'the fix is stated whichever way the preference is set')
  assert.ok(unconfigured.includes('.specs/roles.yml'), 'the unconfigured row names the file')
  assert.ok(unconfigured.includes('feedback-bot: &lt;bot name&gt;'), 'the unconfigured row names the key')
  assert.ok(unconfigured.includes('adds the bot on Review bots'))
  assert.ok(!unconfigured.includes('href="/bots"'), 'a non-admin gets no link to a page that refuses them')
  const unconfiguredAdmin = feedbackSettings('csrf', [{ namespace: 'project/specs', enabled: true, configured: false, manageable: true, admin: true }])
  assert.ok(unconfiguredAdmin.includes('adds the bot on <a href="/bots">Review bots</a>'))

  const notApprover = feedbackSettings('csrf', [{ namespace: 'project/specs', enabled: true, configured: true, manageable: false, reason: 'not-approver' }])
  assert.ok(!notApprover.includes('<form'))
  assert.ok(notApprover.includes('Automatic spec amendment proposals: on. Only project approvers and board admins can change this.'))
  // A failed roles read leaves the bot binding unknown too, so the service
  // never pairs roles-unavailable with configured: true.
  const unreadable = feedbackSettings('csrf', [{ namespace: 'project/specs', enabled: true, configured: false, manageable: false, reason: 'roles-unavailable' }])
  assert.ok(!unreadable.includes('<form'))
  assert.ok(unreadable.includes("Automatic spec amendment proposals: on. The project's approver list could not be read just now, so this cannot be changed here. Try again shortly."))
  assert.ok(!unreadable.includes('.specs/roles.yml'), 'a viewer who could not manage it either way waits on the approver list, not the binding')
  // A failed roles read is also why the bot binding is unknown, so the row
  // must not report the project as having no bot.
  const unreadableOff = feedbackSettings('csrf', [{ namespace: 'project/specs', enabled: false, configured: false, manageable: false, reason: 'roles-unavailable' }])
  assert.ok(unreadableOff.includes('Automatic spec amendment proposals: off.'))
  assert.ok(!unreadableOff.includes('No review bot is bound'))
  const adminUnreadable = feedbackSettings('csrf', [{ namespace: 'project/specs', enabled: true, configured: false, manageable: true, admin: true, reason: 'bot-unknown' }])
  assert.ok(adminUnreadable.includes('Automatic spec amendment proposals: on. That value is the saved preference.'),
    'a manageable row whose roles read failed shows the stored value and says that is what it is')
  assert.ok(!adminUnreadable.includes('No review bot is bound'), 'an unreadable roles file is not evidence that no bot is bound, whoever is looking')
  assert.ok(!adminUnreadable.includes('<form'), 'no switch is offered while the binding is unknown')
  assert.ok(adminUnreadable.includes('The review bot binding in <code>.specs/roles.yml</code> could not be read just now, so what it would do is unknown. Reload to change it.'),
    'the viewer who could fix it is told which read failed, and what is unknown is the effect rather than their standing')
  assert.ok(!adminUnreadable.includes('cannot be changed here'),
    'the row states an unknown, not a refusal: post() re-reads the roles file and a board admin passes whatever it says')
  assert.ok(!adminUnreadable.includes('approver list could not be read'),
    'a viewer who is an approver or admin is not told the approver list is what withholds the switch')
  assert.ok(unconfigured.includes('<code>.specs/roles.yml</code>') && adminUnreadable.includes('<code>.specs/roles.yml</code>'),
    'the file is typeset the same way wherever the section names it')
  // settingsHtml names a cause on every row it builds. A row built without one
  // still says why the switch is missing instead of leaving the state alone.
  const noReason = feedbackSettings('csrf', [{ namespace: 'project/specs', enabled: false, configured: true, manageable: false }])
  assert.ok(noReason.includes('Automatic spec amendment proposals: off. Only project approvers and board admins can change this.'))

  // The four row shapes on one page: the switch, a gate, and the two unbound
  // states. The value has to be findable in one place, whichever shape a row
  // takes, and the switch is one row per project rather than the viewer's own.
  const shapes = feedbackSettings('csrf', [
    { namespace: 'switch/specs', enabled: true, configured: true, manageable: true, reason: '' },
    { namespace: 'gated/specs', enabled: false, configured: true, manageable: false, reason: 'not-approver' },
    { namespace: 'unbound-on/specs', enabled: true, configured: false, manageable: true, reason: '' },
    { namespace: 'unbound-off/specs', enabled: false, configured: false, manageable: true, reason: '' }
  ])
  assert.deepEqual([...shapes.matchAll(/<h3[^>]*>[^<]*<\/h3><p>Automatic spec amendment proposals: (on|off)\./g)].map(m => m[1]),
    ['on', 'off', 'off', 'off'], 'every shape opens on the value in force, in the slot after the project heading')
  for (const [name, html] of Object.entries({ settings, unconfigured, unconfiguredOff, unconfiguredAdmin, notApprover, unreadable, unreadableOff, adminUnreadable, noReason, shapes })) {
    assert.ok(!/[Yy]our saved preference/.test(html), name + ' does not call a project setting the viewer\'s')
    assert.ok(!/[Pp]aused/.test(html), name + ' leaves paused to mean the switch is off, as /statusz and docs/operations.md use it')
  }
  process.stdout.write('feedback model and UI tests passed\n')
}

module.exports = { run }
if (require.main === module) run().catch(e => { process.stderr.write(e.stack + '\n'); process.exitCode = 1 })
