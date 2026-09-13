const assert = require('assert')
const { wordDiff, requirementMap, requirementDelta, diffHtml, diffText } = require('./prosediff')
process.env.GITHUB_TOKEN = 'test-token' // openSpecPr's gh() reads it at module load
process.env.SESSION_SECRET = 'test-secret' // hmac for signToken/verifyToken
process.env.NAMESPACES = 'o/r' // specRefTarget only resolves allowlisted namespaces
const { render, frontmatter, metaTags, approvalAuthors, attestedApprovals, snapshotPlan, revisionNote, resolveSnapshotRef, defaultFrom, changesPage, resolveCritic, fenceRanges, countCommentThreads, countSuggestions, commentAnchorHash, threadAnchors, reviewHash, injectComments, callBot, REVIEW_SYSTEM, validateBot, specsFromRows, applyRoles, quorumMet, canApprove, commitPrefix, buildBoard, slug, numberedSlug, normSpecsDir, stripFrontmatter, specAbstract, implementsRefs, specRef, dependsOnRefs, specGraph, specRefTarget, noteRecord, mermaidMap, mapPage, namespaceMapDoc, clientIp, specPage, encodeCursor, specsGet, specGet, revisionsGet, revisionGet, specSummary, specList, revisionList, checkpointTags, checkpointBlockers, checkpointChanges, parseSummary, CHANGELOG_SYSTEM, checkpointMessage, checkpointsPage, inBatches, overlapCorpus, parseOverlap, openSpecPr, revisionPlan, lockPlan, publishedBody, publishedHash, publicSpecs, attestedApprovers, commentReviewers, reviewContext, mergePr, renderDigest, emailFooter, profileEmail, resolveRecipients, signToken, verifyToken } = require('./server')

const note = (content, extra) => ({ shortid: 'abc', title: 'T', content, lastchangeAt: new Date().toISOString(), ...extra })

// ensureState is forward-only DDL run at startup, so rolling an image back can
// leave an older binary against a newer schema. Destructive statements make
// that unrecoverable without a restore, so each one has to be listed here.
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'server.js'), 'utf8')
  const body = src.slice(src.indexOf('async function ensureState'))
  const destructive = body.slice(0, body.indexOf('\n}\n'))
    .match(/\b(?:DROP\s+(?:TABLE|COLUMN|INDEX)|RENAME\s+COLUMN|ALTER\s+COLUMN|TRUNCATE|DELETE\s+FROM)\b[^'`\n]*/gi) || []
  assert.deepStrictEqual(destructive.map(s => s.trim()), [
    'DROP TABLE spec_board_email_optout',
    'DROP COLUMN IF EXISTS reviewed_hash'
  ])
}

assert.deepStrictEqual(metaTags(frontmatter('---\ntags: [spec, draft]\nowner: josie\n---\nbody').meta), ['spec', 'draft'])
assert.deepStrictEqual(metaTags(frontmatter('---\ntags: spec, in-review\n---\n').meta), ['spec', 'in-review'])
assert.deepStrictEqual(metaTags(frontmatter('no frontmatter').meta), [])
assert.deepStrictEqual(metaTags(frontmatter('---\n: bad yaml [\n---\n').meta), [])

assert.strictEqual(
  resolveCritic('a {++new++} b {--old--}c {~~x~>y~~} {==hl==} {>>note<<}d'),
  'a new b c y hl d')
assert.strictEqual(resolveCritic('plain'), 'plain')

// comment count matches the preview: separate threads count, adjacent
// replies merge into one, and comments inside fenced code are ignored.
assert.strictEqual(countCommentThreads('x {>>a<<} {>>b<<}'), 2)
assert.strictEqual(countCommentThreads('x {>>a<<}{>>reply<<}'), 1)
assert.strictEqual(countCommentThreads('```\n{>>infence<<}\n```\n{>>real<<}'), 1)
assert.strictEqual(countCommentThreads('no comments here'), 0)

// resolved threads (Resolve button appends {>>%%resolved%%<<}) do not block approval
assert.strictEqual(countCommentThreads('x {>>@a: fix<<}{>>%%resolved%%<<}'), 0)
assert.strictEqual(countCommentThreads('x {>>open<<} y {>>@a: fix<<}{>>%%resolved%%<<}'), 1)
assert.strictEqual(countCommentThreads('{>>%%resolved%%<<}'), 0) // lone sentinel
// a reply after the sentinel reopens the thread
assert.strictEqual(countCommentThreads('{>>@a: fix<<}{>>%%resolved%%<<}{>>@b: more<<}'), 1)
// an authored comment quoting the mark is a real comment, not the sentinel
assert.strictEqual(countCommentThreads('{>>@a: %%resolved%%<<}'), 1)
// sentinel inside fenced code is ignored, the open thread still counts
assert.strictEqual(countCommentThreads('```\n{>>%%resolved%%<<}\n```\n{>>open<<}'), 1)
// resolveCritic strips a resolved thread and its sentinel from PR content
assert.strictEqual(resolveCritic('a {>>@x: fix<<}{>>%%resolved%%<<} b'), 'a  b')

// suggestions publish in their accepted form, so a pending one is unreviewed
// text heading for the PR; highlights carry their content through unchanged
assert.strictEqual(countSuggestions('a {++add++} b'), 1)
assert.strictEqual(countSuggestions('a {--cut--} b {~~old~>new~~}'), 2)
assert.strictEqual(countSuggestions('{==just a highlight==}'), 0)
assert.strictEqual(countSuggestions('a {>>comment<<} b'), 0)
assert.strictEqual(countSuggestions('```\n{++infence++}\n```\n{++real++}'), 1)
assert.strictEqual(countSuggestions('no markup at all'), 0)

// Cross-service gate lock: the editor's test/spec-approval.js runs pendingReview
// on the SAME source and must reach these two numbers. The board withholds the
// PR on exactly what the editor's approvals menu reports, so a divergence in
// either scanner fails one side's suite. Keep the two fixtures identical.
{
  const src = 'a {++add++} b {--cut--} c {~~o~>n~~} d {==hl==} e {>>@a: open<<} f {>>@b: done<<}{>>%%resolved%%<<}\n```\n{++fenced++} {>>fenced<<}\n```\n'
  assert.strictEqual(countSuggestions(src), 3)
  assert.strictEqual(countCommentThreads(src), 1)
}

const specs = specsFromRows([
  note('---\ntags: [spec, draft, approved]\nowner: josie\n---\nx {>>a<<} {>>b<<}'),
  note('---\ntags: [other]\n---\n', { shortid: 'skip' })
])
assert.strictEqual(specs.length, 1)
assert.strictEqual(specs[0].statusIdx, 3) // approved wins over draft
assert.strictEqual(specs[0].comments, 2)
assert.strictEqual(specs[0].author, 'josie') // frontmatter owner wins

// DB profiles: owner name fallback, editor surfaced separately
const dbSpecs = specsFromRows([
  note('---\ntags: [spec]\n---\n', {
    owner_profile: JSON.stringify({ displayName: 'Josie P' }),
    editor_profile: JSON.stringify({ username: 'sam' })
  })
])
assert.strictEqual(dbSpecs[0].author, 'Josie P')
assert.strictEqual(dbSpecs[0].editor, 'sam')
assert.strictEqual(specsFromRows([note('---\ntags: [spec]\n---\n', { owner_profile: 'not json' })])[0].author, '')

// implemented specs bucket into the Implemented lane (render hides it behind a
// toggle) so replacing a shipped spec stays reachable
const buckets = buildBoard(specs, new Map([['abc', { pr_number: 7, pr_state: 'merged', implemented_at: new Date().toISOString() }]]))
assert.strictEqual(buckets[4].length, 1) // implemented in its (hidden) lane
assert.strictEqual(buckets[3].length, 0) // and not left in approved
// a spec retired by a replacement is hidden from every lane
const supd = buildBoard(specs, new Map([['abc', { pr_number: 7, superseded_at: new Date().toISOString() }]]))
assert.strictEqual(supd.reduce((n, b) => n + b.length, 0), 0)
// non-implemented spec keeps its PR + state on its card
const shown = buildBoard(specs, new Map([['abc', { pr_number: 9 }]]))
// the header's New spec menu offers both kinds, each aimed at the namespace
{
  const menu = /<details class="new">[\s\S]*?<\/details>/.exec(render(buildBoard([], new Map()), '', ''))[0]
  assert.ok(menu.includes('/new/spec?namespace=o%2Fr">Feature spec<'), menu)
  assert.ok(menu.includes('/new/spec?kind=top-level&amp;namespace=o%2Fr">Top-level spec<'), menu)
}
assert.strictEqual(shown[3][0].pr, 9)
assert.strictEqual(shown[3][0].prState, 'open')
// a revised spec carries its revision PR onto the card alongside the original
const revised = buildBoard(specs, new Map([['abc', { pr_number: 9, pr_state: 'merged', revision: 2, revision_pr: 31 }]]))
assert.strictEqual(revised[3][0].pr, 9)
assert.strictEqual(revised[3][0].revPr, 31)
assert.strictEqual(revised[3][0].revision, 2)
assert.strictEqual(shown[3][0].revPr, undefined) // absent until one is published

assert.strictEqual(slug('My Spec: The (2nd) Try!'), 'my-spec-the-2nd-try')

// a "SPEC-N" title numbers the spec and drops the prefix from the slug; a
// plain title leaves the number for the caller to allocate
const emdash = String.fromCharCode(0x2014)
assert.deepStrictEqual(numberedSlug('SPEC-000 ' + emdash + ' Project Setup'), { num: '000', slug: 'project-setup' })
assert.deepStrictEqual(numberedSlug('SPEC-6 CLI'), { num: '006', slug: 'cli' })
assert.deepStrictEqual(numberedSlug('Plain Title'), { num: null, slug: 'plain-title' })

assert.strictEqual(stripFrontmatter('---\ntags: [spec]\n---\n\n# Title\nbody'), '# Title\nbody')
assert.strictEqual(stripFrontmatter('# No frontmatter\n'), '# No frontmatter\n')

// approvers come only from namespace roles.yml, never the editable note
const nsSpec = applyRoles(specsFromRows([
  note('---\ntags: [spec, in-review]\nnamespace: o/r\napproved-by: [bob]\n---\nx')
])[0], { approvers: ['alice', 'bob', 'carol'], 'approvals-required': 2 })
assert.strictEqual(nsSpec.namespace, 'o/r')
assert.strictEqual(nsSpec.required, 2)
assert.strictEqual(nsSpec.approvals, 1)
assert.deepStrictEqual(nsSpec.missingApprovers, ['alice', 'carol'])
// no roles -> no approvers, even if the note lists some
const noRoles = applyRoles(specsFromRows([note('---\ntags: [spec]\napprovers: [dave]\n---\nx')])[0], null)
assert.deepStrictEqual(noRoles.approvers, [])
assert.strictEqual(noRoles.required, 0)
// note-level approvers are ignored; only roles.yml counts
const ignored = applyRoles(specsFromRows([
  note('---\ntags: [spec, in-review]\napprovers: [dave]\napproved-by: [dave]\n---\nx')
])[0], { approvers: ['alice'], 'approvals-required': 1 })
assert.deepStrictEqual(ignored.approvers, ['alice'])
assert.strictEqual(ignored.approvals, 0)

// owner token only trusted for github-provider profiles
const tok = specsFromRows([
  note('---\ntags: [spec]\n---\nx', {
    owner_profile: JSON.stringify({ provider: 'github', username: 'josie' }),
    owner_token: 'gho_x'
  }),
  note('---\ntags: [spec]\n---\nx', {
    shortid: 'kc',
    owner_profile: JSON.stringify({ provider: 'oauth2', username: 'josie' }),
    owner_token: 'kc-token'
  })
])
assert.strictEqual(tok[0].ownerToken, 'gho_x')
assert.strictEqual(tok[1].ownerToken, null)

// abstract: first prose paragraph after the top heading
assert.strictEqual(
  specAbstract('# Spec: X\n\nThis demonstrates the flow.\nSecond line.\n\n## Section\nrest'),
  'This demonstrates the flow. Second line.')
assert.strictEqual(specAbstract('# Only heading\n\n## Straight to section\nrest'), '')
assert.strictEqual(specAbstract('no heading at all'), '')

// quorum gate: forged "approved" tag without sign-offs must not open a PR
const gov = applyRoles(specsFromRows([
  note('---\ntags: [spec, approved]\nnamespace: o/r\n---\nx')
])[0], { approvers: ['alice', 'bob'], 'approvals-required': 2 })
assert.strictEqual(quorumMet(gov), false) // 0/2, tag forged
gov.approvedBy = ['alice', 'bob']; applyRoles(gov, { approvers: ['alice', 'bob'], 'approvals-required': 2 })
assert.strictEqual(quorumMet(gov), true) // 2/2
// An approval is the approver's own session writing their name: hedgedoc's
// per-character authorship is the evidence, and a name typed by anyone else
// counts for nothing.
{
  const atoms = (content, spans) => {
    const out = []
    let pos = 0
    for (const [id, text] of spans) {
      const at = content.indexOf(text, pos)
      assert.ok(at >= 0, text)
      out.push([id, at, at + text.length, 1, 1])
      pos = at + text.length
    }
    return out
  }
  const idMap = new Map([['alice', { id: 'u-alice' }], ['bob', { id: 'u-bob' }]])
  const flow = '---\ntags: [spec, approved]\napproved-by: [alice, "bob"]\n---\nx'
  const auth = atoms(flow, [['u-mallory', '---\ntags: [spec, approved]\napproved-by: ['], ['u-alice', 'alice'], ['u-mallory', ', "bob"]\n---\nx']])
  const authors = approvalAuthors(flow, auth)
  assert.deepStrictEqual([...authors.get('alice')], ['u-alice'])
  assert.deepStrictEqual([...authors.get('bob')], ['u-mallory'])
  const [spec] = attestedApprovals(specsFromRows([note(flow, { authorship: JSON.stringify(auth) })]), idMap)
  assert.deepStrictEqual(spec.approvedBy, ['alice'])
  assert.deepStrictEqual(spec.claimedBy, ['alice', 'bob'])
  applyRoles(spec, { approvers: ['alice', 'bob'], 'approvals-required': 2 })
  assert.strictEqual(quorumMet(spec), false)
  applyRoles(spec, { approvers: ['alice', 'bob'], 'approvals-required': 1 })
  assert.strictEqual(quorumMet(spec), true)

  // A name split across two atoms of the same account is still that account's.
  const split = atoms(flow, [['u-x', '---\ntags: [spec, approved]\napproved-by: ['], ['u-alice', 'al'], ['u-alice', 'ice'], ['u-bob', ', "'], ['u-bob', 'bob'], ['u-x', '"]\n---\nx']])
  assert.deepStrictEqual(attestedApprovals(specsFromRows([note(flow, { authorship: JSON.stringify(split) })]), idMap)[0].approvedBy, ['alice', 'bob'])

  // A guest atom, an uncovered character, or no authorship at all attests nothing.
  const guest = atoms(flow, [['u-x', '---\ntags: [spec, approved]\napproved-by: ['], [null, 'alice'], ['u-bob', ', "bob"]\n---\nx']])
  assert.deepStrictEqual(attestedApprovals(specsFromRows([note(flow, { authorship: JSON.stringify(guest) })]), idMap)[0].approvedBy, ['bob'])
  const gap = atoms(flow, [['u-alice', 'alic']])
  assert.deepStrictEqual([...approvalAuthors(flow, gap).get('alice')].sort(), [null, 'u-alice'])
  assert.deepStrictEqual(attestedApprovals(specsFromRows([note(flow, { authorship: null })]), idMap)[0].approvedBy, [])
  assert.deepStrictEqual(attestedApprovals(specsFromRows([note(flow, { authorship: 'not json' })]), idMap)[0].approvedBy, [])

  // Block lists and an unknown login.
  const blockFm = '---\ntags: [spec]\napproved-by:\n  - alice\n  - carol\n---\nx'
  const blockAuth = atoms(blockFm, [['u-x', '---\ntags: [spec]\napproved-by:\n  - '], ['u-alice', 'alice'], ['u-x', '\n  - '], ['u-carol', 'carol'], ['u-x', '\n---\nx']])
  const b = attestedApprovals(specsFromRows([note(blockFm, { authorship: JSON.stringify(blockAuth) })]), idMap)[0]
  assert.deepStrictEqual(b.approvedBy, ['alice'])
  assert.deepStrictEqual(b.claimedBy, ['alice', 'carol'])
  assert.deepStrictEqual(approvalAuthors('---\ntags: [spec]\n---\nx', []), new Map())
}
// Snapshots: one status row per transition unless the newest already holds
// that text, one approval row per attested approver, dropped on retraction.
{
  const row = (kind, label, hash) => ({ kind, label, hash })
  let p = snapshotPlan({ status: 'draft', prevStatus: null, approvedBy: [], rows: [], hash: 'h1' })
  assert.deepStrictEqual(p, { inserts: [{ kind: 'status', label: 'draft' }], deleteApprovals: [] })
  p = snapshotPlan({ status: 'draft', prevStatus: 'draft', approvedBy: [], rows: [row('status', 'draft', 'h1')], hash: 'h2' })
  assert.deepStrictEqual(p.inserts, [], 'no transition, no row')
  p = snapshotPlan({ status: 'in-review', prevStatus: 'draft', approvedBy: [], rows: [row('status', 'draft', 'h1')], hash: 'h1' })
  assert.deepStrictEqual(p.inserts, [{ kind: 'status', label: 'in-review' }], 'same text, new status still marks the transition')
  p = snapshotPlan({ status: 'in-review', prevStatus: 'draft', approvedBy: [], rows: [row('status', 'in-review', 'h1')], hash: 'h1' })
  assert.deepStrictEqual(p.inserts, [], 'a replayed transition with the same text is not a second row')
  p = snapshotPlan({ status: 'approved', prevStatus: 'in-review', approvedBy: ['Alice', 'bob'], rows: [row('approval', 'alice', 'h0')], hash: 'h3' })
  assert.deepStrictEqual(p.inserts, [{ kind: 'status', label: 'approved' }, { kind: 'approval', label: 'bob' }])
  assert.deepStrictEqual(p.deleteApprovals, [])
  p = snapshotPlan({ status: 'in-review', prevStatus: 'in-review', approvedBy: ['bob'], rows: [row('approval', 'alice', 'h0'), row('approval', 'bob', 'h0')], hash: 'h3' })
  assert.deepStrictEqual(p, { inserts: [], deleteApprovals: ['alice'] })
}
// Prose diff: whole-word edits, folded unchanged runs, escaped output.
{
  const d = wordDiff('the quick brown fox\njumps', 'the slow brown fox\njumps high')
  assert.deepStrictEqual(d.filter(([op]) => op !== 0), [[-1, 'quick'], [1, 'slow'], [1, ' high']])
  assert.strictEqual(d.map(([, t]) => t).join('').includes('brown fox'), true)
  assert.deepStrictEqual(wordDiff('same', 'same'), [[0, 'same']])
  const long = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n')
  const html = diffHtml(wordDiff(`start\n${long}\nend`, `begin\n${long}\nend`))
  assert.match(html, /^<del>start<\/del><ins>begin<\/ins>/)
  assert.match(html, /<span class="fold">\d+ unchanged lines<\/span>/)
  assert.doesNotMatch(html, /line 5/, 'the middle of a long unchanged run is folded')
  assert.match(diffHtml([[1, '<script>'], [-1, '"x"']]), /^<ins>&lt;script&gt;<\/ins><del>&quot;x&quot;<\/del>$/)

  const before = '# T\n\n- **FR-001**: The X MUST a\n  and b.\n- **FR-002**: The Y MUST c.\n\n**SC-001**: one\n**SC-002**: two\n'
  const after = '# T\n\n- **FR-001**: The X MUST a and b.\n- **FR-003**: The Z MUST d.\n\n**SC-001**: one changed\n'
  const a = requirementMap(before)
  assert.deepStrictEqual([...a.keys()], ['FR-001', 'FR-002', 'SC-001', 'SC-002'])
  assert.strictEqual(a.get('FR-001'), 'The X MUST a and b.', 'continuation lines join, whitespace collapses')
  assert.deepStrictEqual(requirementDelta(a, requirementMap(after)), { added: ['FR-003'], removed: ['FR-002', 'SC-002'], changed: ['SC-001'] })
  assert.strictEqual(requirementMap('no items').size, 0)
}

// Snapshot refs and the returning reviewer's default.
{
  const rows = [
    { id: 3, kind: 'status', label: 'draft', hash: 'a', taken_at: '2026-09-01T00:00:00Z' },
    { id: 5, kind: 'approval', label: 'Alice', hash: 'b', taken_at: '2026-09-02T00:00:00Z' },
    { id: 7, kind: 'status', label: 'approved', hash: 'b', taken_at: '2026-09-02T00:01:00Z' },
    { id: 9, kind: 'published', label: 'r0', hash: 'b', taken_at: '2026-09-02T00:02:00Z' }
  ]
  const spec = { id: 'abc', title: 'T', url: 'u', changed: '2026-09-03T00:00:00Z', content: '---\ntags: [spec, approved]\n---\nbody' }
  assert.strictEqual(resolveSnapshotRef(rows, '5', spec).label, 'Alice')
  assert.strictEqual(resolveSnapshotRef(rows, 'approval:alice', spec).id, 5, 'logins match case-insensitively')
  assert.strictEqual(resolveSnapshotRef(rows, 'status:approved', spec).id, 7)
  assert.strictEqual(resolveSnapshotRef(rows, 'published:r0', spec).id, 9)
  assert.strictEqual(resolveSnapshotRef(rows, 'current', spec).kind, 'current')
  assert.strictEqual(resolveSnapshotRef(rows, 'nope', spec), null)
  assert.strictEqual(resolveSnapshotRef(rows, 'status:in-review', spec), null)
  assert.strictEqual(defaultFrom(rows, 'ALICE'), 'approval:Alice')
  assert.strictEqual(defaultFrom(rows, 'bob'), 'status:approved')
  assert.strictEqual(defaultFrom(rows.filter(r => r.label !== 'approved'), null), 'status:draft')
  assert.strictEqual(defaultFrom(rows.filter(r => r.kind === 'approval'), null), '5')
  assert.strictEqual(defaultFrom([], null), null)

  const data = { from: resolveSnapshotRef(rows, '5', spec), to: resolveSnapshotRef(rows, 'current', spec), same: false, requirements: { added: ['FR-009'], removed: [], changed: ['SC-001'] }, diff: [[0, 'keep '], [-1, 'old'], [1, 'new']] }
  const html = changesPage(spec, rows, data, {})
  assert.ok(html.includes('<option value="approval:Alice" selected>'))
  assert.ok(html.includes('requirements changed: SC-001; added: FR-009'))
  assert.ok(html.includes('<del>old</del><ins>new</ins>'))
  assert.ok(changesPage(spec, rows, { ...data, same: true }, {}).includes('No change in the published text'))
  assert.ok(changesPage(spec, [], null, {}).includes('No snapshots yet'))
  assert.ok(changesPage(spec, rows, null, { from: 'x', to: 'y' }).includes('Unknown snapshot x or y'))
  const hostile = changesPage({ ...spec, title: '<script>t</script>', url: '" onclick="x' }, [{ ...rows[1], label: '<b>' }], { ...data, requirements: { added: ['<i>'], removed: [], changed: [] }, diff: [[1, '<img>']] }, {})
  assert.ok(!hostile.includes('<script>') && hostile.includes('&lt;script&gt;'))
  assert.ok(!hostile.includes('<b>') && hostile.includes('&lt;b&gt;'))
  assert.ok(!hostile.includes('<i>') && hostile.includes('&lt;i&gt;'))
  assert.ok(!hostile.includes('<img>') && hostile.includes('&lt;img&gt;'))
  assert.ok(!hostile.includes('" onclick'))
}
// A revision PR opens with what moved; the checkpoint changelog names the
// same ids per revised spec.
{
  const v1 = '# T\n\n- **FR-001**: a\n- **FR-002**: b\n'
  const v2 = '# T\n\n- **FR-001**: a changed\n- **FR-003**: c\n'
  const note = revisionNote({ label: 'r0', body: v1 }, v2, 1, 'abc')
  assert.match(note, /^Since r0: changed FR-001; added FR-003; removed FR-002\.\n/)
  assert.match(note, /\/changes\/abc\?from=published:r0&to=published:r1$/)
  assert.match(revisionNote({ label: 'r1', body: v1 }, v1 + '\nmore prose\n', 2, 'abc'), /^Since r1: wording only/)
  const text = diffText(wordDiff(v1, v2))
  assert.ok(text.includes('{+ changed+}'), text)
  assert.ok(text.includes('[-'), text)
  assert.match(diffText([[0, Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')]]), /\[\.\.\. 26 unchanged lines \.\.\.\]/)
  assert.match(diffText([[1, 'x'.repeat(50)]], 10), /\[\.\.\. cut \.\.\.\]$/)
  const e = { label: '007', title: 'Static routes', pr: 7, revision: 2, revisionPr: 22, requirements: { changed: ['FR-004'], added: [], removed: ['SC-002'] } }
  assert.strictEqual(checkpointMessage('specs/v3', [], 'o/r', null, { from: 'specs/v2', truncated: false, added: [], revised: [e], retired: [], implemented: [] }).includes('revised 007 Static routes (rev 2, #22) [changed FR-004; removed SC-002]'), true)
}
// ungoverned spec (no approvers anywhere) still opens on the tag
const ungov = applyRoles(specsFromRows([note('---\ntags: [spec, approved]\n---\nx')])[0], null)
assert.strictEqual(quorumMet(ungov), true)
// roles fetch failure (undefined, vs null = confirmed absent) fails the gate closed
const unknown = applyRoles(specsFromRows([note('---\ntags: [spec, approved]\nnamespace: o/r\n---\nx')])[0], undefined)
assert.strictEqual(quorumMet(unknown), false)
// explicit approvals-required: 0 is respected; malformed values default to 1
const zeroReq = applyRoles(specsFromRows([note('---\ntags: [spec, approved]\n---\nx')])[0], { approvers: ['a'], 'approvals-required': 0 })
assert.strictEqual(zeroReq.required, 0)
assert.strictEqual(quorumMet(zeroReq), true)
const badReq = applyRoles(specsFromRows([note('---\ntags: [spec]\n---\nx')])[0], { approvers: ['a', 'b'], 'approvals-required': 'lots' })
assert.strictEqual(badReq.required, 1)

// a comment thread on ready-for-review advances it to in-review (computed,
// tag untouched); draft never advances, resolving all threads reverts
assert.strictEqual(specsFromRows([note('---\ntags: [spec, ready-for-review]\n---\nx {>>q<<}')])[0].statusIdx, 2)
assert.strictEqual(specsFromRows([note('---\ntags: [spec, ready-for-review]\n---\nx')])[0].statusIdx, 1)
assert.strictEqual(specsFromRows([note('---\ntags: [spec, draft]\n---\nx {>>q<<}')])[0].statusIdx, 0)

// unresolved comment threads block approval even at full quorum
const commented = applyRoles(specsFromRows([
  note('---\ntags: [spec, approved]\napproved-by: [alice]\n---\nx {>>open thread<<}')
])[0], { approvers: ['alice'], 'approvals-required': 1 })
assert.strictEqual(quorumMet(commented), true)
assert.strictEqual(canApprove(commented), false) // 1 open thread
const resolved = applyRoles(specsFromRows([
  note('---\ntags: [spec, approved]\napproved-by: [alice]\n---\nx')
])[0], { approvers: ['alice'], 'approvals-required': 1 })
assert.strictEqual(canApprove(resolved), true)
// comments also gate ungoverned specs (quorum trivially met)
const ungovCommented = applyRoles(specsFromRows([note('---\ntags: [spec, approved]\n---\n{>>c<<}')])[0], null)
assert.strictEqual(canApprove(ungovCommented), false)

// a pending suggestion blocks approval the same way: resolveCritic would
// publish it as accepted, so approving with one ships text nobody accepted
const suggested = applyRoles(specsFromRows([
  note('---\ntags: [spec, approved]\napproved-by: [alice]\n---\nx {++unreviewed++}')
])[0], { approvers: ['alice'], 'approvals-required': 1 })
assert.strictEqual(quorumMet(suggested), true)
assert.strictEqual(suggested.suggestions, 1)
assert.strictEqual(canApprove(suggested), false)
// accepting it (the markup is gone) clears the gate
const accepted = applyRoles(specsFromRows([
  note('---\ntags: [spec, approved]\napproved-by: [alice]\n---\nx unreviewed')
])[0], { approvers: ['alice'], 'approvals-required': 1 })
assert.strictEqual(canApprove(accepted), true)
// a highlight is not an edit and does not block
const highlighted = applyRoles(specsFromRows([
  note('---\ntags: [spec, approved]\napproved-by: [alice]\n---\nx {==noted==}')
])[0], { approvers: ['alice'], 'approvals-required': 1 })
assert.strictEqual(canApprove(highlighted), true)

// area routing: `area` frontmatter wins, tag match is the fallback, both
// validated against roles areas (legacy key: categories)
const catRoles = { categories: ['api', 'design'] }
assert.strictEqual(applyRoles(specsFromRows([note('---\ntags: [spec]\narea: API\n---\nx')])[0], { areas: ['api'] }).category, 'api') // frontmatter area, case-folded
assert.strictEqual(applyRoles(specsFromRows([note('---\ntags: [spec, design]\narea: api\n---\nx')])[0], catRoles).category, 'api') // area beats tag
assert.strictEqual(applyRoles(specsFromRows([note('---\ntags: [spec, design]\narea: client\n---\nx')])[0], catRoles).category, 'design') // undeclared area falls back to tag
assert.strictEqual(applyRoles(specsFromRows([note('---\ntags: [spec, in-review, api]\n---\nx')])[0], catRoles).category, 'api')
assert.strictEqual(applyRoles(specsFromRows([note('---\ntags: [spec, design, api]\n---\nx')])[0], catRoles).category, 'design') // frontmatter order
assert.strictEqual(applyRoles(specsFromRows([note('---\ntags: [spec, client]\n---\nx')])[0], catRoles).category, '') // unlisted tag ignored
assert.strictEqual(applyRoles(specsFromRows([note('---\ntags: [spec]\n---\nx')])[0], catRoles).category, '') // no area
// no declared list: any `area:` routes as its slug, tags never route
assert.strictEqual(applyRoles(specsFromRows([note('---\ntags: [spec, api]\narea: api\n---\nx')])[0], null).category, 'api')
assert.strictEqual(applyRoles(specsFromRows([note('---\ntags: [spec]\narea: My Area!\n---\nx')])[0], {}).category, 'my-area')
assert.strictEqual(applyRoles(specsFromRows([note('---\ntags: [spec, api]\n---\nx')])[0], null).category, '') // tag alone needs a declared list

// specs-dir normalization: apex forms, root default, traversal rejected
assert.strictEqual(normSpecsDir(undefined, false), 'specs')
assert.strictEqual(normSpecsDir(undefined, true), '') // root roles.yml defaults to the apex
assert.strictEqual(normSpecsDir('.', false), '')
assert.strictEqual(normSpecsDir('', false), '')
assert.strictEqual(normSpecsDir('/rfcs/', false), 'rfcs')
assert.strictEqual(normSpecsDir('docs/specs', false), 'docs/specs')
assert.strictEqual(normSpecsDir('../up', false), 'specs') // traversal falls back
assert.strictEqual(normSpecsDir('a/../b', false), 'specs') // nested traversal too
assert.strictEqual(normSpecsDir('../up', true), '') // fallback respects the apex default
assert.strictEqual(normSpecsDir('a//b', false), 'specs') // empty segment
assert.strictEqual(normSpecsDir('r?fs', false), 'specs') // URL-significant chars
assert.strictEqual(normSpecsDir('a#b', false), 'specs')
assert.strictEqual(normSpecsDir('a\\b', true), '')

// undeclared-charset areas never route: they would land in git refs and paths
assert.strictEqual(applyRoles(specsFromRows([note('---\ntags: [spec]\narea: a/b\n---\nx')])[0], { areas: ['a/b'] }).category, '')

// a top-level spec has no area, whatever the note or a tag declares
{
  const top = applyRoles(specsFromRows([note('---\ntags: [spec, api]\nkind: Top-Level\narea: api\n---\nx')])[0], catRoles)
  assert.strictEqual(top.topLevel, true)
  assert.strictEqual(top.category, '')
  assert.strictEqual(specsFromRows([note('---\ntags: [spec]\nkind: feature\n---\nx')])[0].topLevel, false)
}

// commit prefix: default spec, custom, empty bare, trailing-colon dedupe
assert.strictEqual(commitPrefix(null), 'spec: ')
assert.strictEqual(commitPrefix({ 'commit-prefix': 'docs(specs)' }), 'docs(specs): ')
assert.strictEqual(commitPrefix({ 'commit-prefix': 'docs(specs):' }), 'docs(specs): ')
assert.strictEqual(commitPrefix({ 'commit-prefix': '' }), '')

// implements refs: bare = scanned repo, cross-repo = explicit
assert.deepStrictEqual(implementsRefs('feat: x\n\nimplements #12', 'o/spec'), [{ ns: 'o/spec', n: 12 }])
assert.deepStrictEqual(
  implementsRefs('implements o/spec#3 and Implements #4', 'o/code'),
  [{ ns: 'o/spec', n: 3 }, { ns: 'o/code', n: 4 }])
assert.deepStrictEqual(implementsRefs('nothing here', 'o/r'), [])

// supersedes ref: bare number or #N targets the note's namespace (YAML reads
// an unquoted leading # as a comment, so the number form is the safe default),
// owner/repo#N crosses, empty/malformed -> null
assert.deepStrictEqual(specRef(5, 'o/r'), { ns: 'o/r', n: 5 })
assert.deepStrictEqual(specRef('#5', 'o/r'), { ns: 'o/r', n: 5 })
assert.deepStrictEqual(specRef('a/b#12', 'o/r'), { ns: 'a/b', n: 12 })
// a note shortid (PR-less spec) resolves by id, not number
assert.deepStrictEqual(specRef('rBk2X-Y_z', 'o/r'), { noteId: 'rBk2X-Y_z' })
assert.strictEqual(specRef(undefined, 'o/r'), null)
assert.strictEqual(specRef('', 'o/r'), null)
assert.strictEqual(specRef('a b', 'o/r'), null) // spaces are not a valid ref
// specsFromRows surfaces the parsed link on the spec
assert.deepStrictEqual(
  specsFromRows([note('---\ntags: [spec]\nnamespace: o/r\nsupersedes: a/b#3\n---\nx')])[0].supersedes,
  { ns: 'a/b', n: 3 })

// depends-on takes the same ref forms as supersedes but is list-valued, in
// either YAML spelling. A repeat is a typo, not a second edge.
assert.deepStrictEqual(dependsOnRefs({ 'depends-on': [12, '#7', 'a/b#3'] }, 'o/r'),
  [{ ns: 'o/r', n: 12 }, { ns: 'o/r', n: 7 }, { ns: 'a/b', n: 3 }])
assert.deepStrictEqual(dependsOnRefs({ 'depends-on': '12, 7' }, 'o/r'),
  [{ ns: 'o/r', n: 12 }, { ns: 'o/r', n: 7 }])
assert.deepStrictEqual(dependsOnRefs({ 'depends-on': 12 }, 'o/r'), [{ ns: 'o/r', n: 12 }])
assert.deepStrictEqual(dependsOnRefs({ 'depends-on': ['12', '#12'] }, 'o/r'), [{ ns: 'o/r', n: 12 }])
assert.deepStrictEqual(dependsOnRefs({ 'depends-on': ['a b', ''] }, 'o/r'), [])
assert.deepStrictEqual(dependsOnRefs({}, 'o/r'), [])
// a note naming its own shortid is dropped; the ns#pr spelling of the same
// thing cannot be seen here (the note has no number yet) and dies in specGraph
assert.deepStrictEqual(dependsOnRefs({ 'depends-on': ['self', '4'] }, 'o/r', 'self'), [{ ns: 'o/r', n: 4 }])
assert.deepStrictEqual(specsFromRows([note('---\ntags: [spec]\nnamespace: o/r\ndepends-on: [3]\n---\nx')])[0].dependsOn,
  [{ ns: 'o/r', n: 3 }])

const mapNote = (id, fm, body = 'Abstract line.') =>
  note(`---\ntags: [spec, ${fm.status || 'approved'}${fm.tags ? ', ' + fm.tags : ''}]\nnamespace: ${fm.ns || 'o/r'}\n` +
    `${fm.kind ? `kind: ${fm.kind}\n` : ''}${fm.area ? `area: ${fm.area}\n` : ''}${fm.deps ? `depends-on: [${fm.deps}]\n` : ''}` +
    `${fm.supersedes ? `supersedes: ${fm.supersedes}\n` : ''}---\n# H\n\n${body}\n`,
  { shortid: id, title: fm.title || `Spec ${id}` })

const mapSpecs = rows => specsFromRows(rows).map(s => applyRoles(s, { areas: ['networking', 'storage'] }))

{
  const specs = mapSpecs([
    mapNote('a', { area: 'networking', deps: '7', title: 'Route policy' }, 'Replaces static route tables.'),
    mapNote('b', { area: 'networking', title: 'Static routes' }),
    mapNote('c', { status: 'draft', area: 'storage', title: 'Volume attach' }),
    mapNote('d', { area: 'storage', title: 'Snapshots' })
  ])
  const state = new Map([
    ['a', { namespace: 'o/r', pr_number: 12 }],
    ['b', { namespace: 'o/r', pr_number: 7 }],
    ['c', { namespace: 'o/r', pr_number: 30 }],
    ['d', { namespace: 'o/r', pr_number: 20, implemented_at: new Date().toISOString() }]
  ])
  const nodes = specGraph(specs, state)
  // in flight stays on the board; the map is what the system is. sorted by
  // namespace, then area, then number, so b (#7) leads a (#12)
  assert.deepStrictEqual(nodes.map(n => n.id), ['b', 'a', 'd'])
  assert.strictEqual(nodes.find(n => n.id === 'd').status, 'implemented')
  assert.strictEqual(nodes.find(n => n.id === 'a').abstract, 'Replaces static route tables.')
  // the depends-on edge resolves by namespace#pr, and its reverse comes free
  const a = nodes.find(n => n.id === 'a')
  assert.deepStrictEqual(a.dependsOn.map(r => [r.id, r.n, r.title]), [['b', 7, 'Static routes']])
  assert.deepStrictEqual(nodes.find(n => n.id === 'b').neededBy.map(r => r.id), ['a'])
  assert.deepStrictEqual(nodes.map(n => n.area), ['networking', 'networking', 'storage'])

  // a title that would break the mermaid parser survives quoting, and '#' never
  // reaches a label (mermaid reads it as the start of an entity code)
  const odd = mapSpecs([mapNote('x', { area: 'networking', title: 'Say "hi" [maybe]' })])
  const doc = mermaidMap(specGraph(odd, new Map([['x', { namespace: 'o/r', pr_number: 5 }]])), 'o/r')
  assert.ok(doc.includes('["005 Say #quot;hi#quot; [maybe]"]'), doc)
  assert.ok(doc.includes('subgraph area_networking["networking"]'), doc)

  // The README is committed to the namespace repo, so it lists only specs that
  // have a file there. A numberless spec would otherwise put the title of a
  // note guests may not even see into a public repo.
  const unnumbered = mapSpecs([mapNote('u', { area: 'networking', title: 'Unpublished secret' })])
  assert.strictEqual(mermaidMap(specGraph(unnumbered, new Map()), 'o/r').includes('Unpublished secret'), false)

  // A note-authored title can carry newlines and backticks, which would end the
  // row and leave the rest of it as markdown in the repo.
  const nasty = mapSpecs([mapNote('x', { title: 'Fence ```js\nalert(1)\n``` out' })])
  const nastyDoc = mermaidMap(specGraph(nasty, new Map([['x', { namespace: 'o/r', pr_number: 5 }]])), 'o/r')
  assert.strictEqual(nastyDoc.split('\n').filter(l => l.startsWith('```')).length, 2, nastyDoc)
  assert.ok(nastyDoc.includes('| 005 | Fence \\`\\`\\`js alert(1) \\`\\`\\` out |'), nastyDoc)

  // a top-level spec leads the graph under its own pseudo-area, named by its
  // file once published and by its title's slug before that
  const withTop = specGraph(
    [...specs, ...mapSpecs([mapNote('p', { kind: 'top-level', area: 'storage', title: 'Philosophy' })])],
    new Map([...state, ['p', { namespace: 'o/r', pr_number: 13 }]]))
  assert.deepStrictEqual([withTop[0].area, withTop[0].slug, withTop[0].n], ['top-level', 'philosophy', 13])
  assert.strictEqual(specGraph(mapSpecs([mapNote('p', { kind: 'top-level', title: 'Renamed' })]),
    new Map([['p', { namespace: 'o/r', pr_number: 13, spec_path: 'specs/philosophy.md' }]]))[0].slug, 'philosophy')

  const topDoc = mermaidMap(withTop, 'o/r')
  assert.ok(topDoc.indexOf('subgraph area_top_level["top-level"]') < topDoc.indexOf('subgraph area_networking'), topDoc)
  assert.ok(topDoc.includes('| philosophy | Philosophy | top-level | approved | [#13](https://github.com/o/r/pull/13) |'), topDoc)
  const topHtml = mapPage(withTop, 'o/r')
  assert.ok(topHtml.indexOf('<h3>top-level') < topHtml.indexOf('<h3>networking'), topHtml)
  assert.ok(topHtml.includes('>philosophy Philosophy</a>'), topHtml)

  const full = mermaidMap(nodes, 'o/r')
  assert.ok(full.includes('```mermaid'))
  assert.ok(full.includes('no_r_12 --> no_r_7'), full)
  assert.ok(full.includes('| 012 | Route policy | networking | approved | [#12](https://github.com/o/r/pull/12) |'), full)
  // another namespace's specs are not this repo's business
  assert.ok(mermaidMap(nodes, 'other/repo').includes('No approved specs yet'))
}

{
  // a retired spec leaves the map as a node and reappears under its replacement
  const specs = mapSpecs([
    mapNote('old', { title: 'Static routes' }),
    mapNote('new', { supersedes: '7', title: 'Route policy' })
  ])
  const state = new Map([
    ['old', { namespace: 'o/r', pr_number: 7, superseded_at: new Date().toISOString() }],
    ['new', { namespace: 'o/r', pr_number: 12 }]
  ])
  const nodes = specGraph(specs, state)
  assert.deepStrictEqual(nodes.map(n => n.id), ['new'])
  assert.deepStrictEqual(nodes[0].retired.map(r => [r.id, r.n]), [['old', 7]])
  assert.ok(mermaidMap(nodes, 'o/r').includes('-.->|supersedes|'))
  // the retired spec has no entry on the page, so it links out to its PR
  // rather than to an anchor that goes nowhere
  const html = mapPage(nodes, 'o/r')
  assert.ok(html.includes('supersedes <a href="https://github.com/o/r/pull/7"'), html)
  assert.ok(!html.includes('#s-old'), html)
  assert.ok(html.includes('id="s-new"'))
}

{
  // an unresolvable ref renders rather than vanishing, so the author sees it
  const specs = mapSpecs([mapNote('a', { deps: '999' })])
  const nodes = specGraph(specs, new Map([['a', { namespace: 'o/r', pr_number: 1 }]]))
  assert.deepStrictEqual(nodes[0].dependsOn, [{ id: null, ns: 'o/r', n: 999, title: '', url: '' }])
}

{
  // cycles terminate: mutual depends-on, mutual supersedes, and a spec that
  // names its own number
  const specs = mapSpecs([
    mapNote('a', { deps: '2', supersedes: '2' }),
    mapNote('b', { deps: '1', supersedes: '1' }),
    mapNote('s', { deps: '3' })
  ])
  const state = new Map([
    ['a', { namespace: 'o/r', pr_number: 1 }],
    ['b', { namespace: 'o/r', pr_number: 2 }],
    ['s', { namespace: 'o/r', pr_number: 3 }]
  ])
  const nodes = specGraph(specs, state)
  assert.deepStrictEqual(nodes.map(n => n.retired.length), [1, 1, 0])
  assert.deepStrictEqual(nodes.find(n => n.id === 's').dependsOn, []) // self-edge dropped
}

{
  // the three fields the editor cannot derive on its own
  // 'meta' is not a declared area, so it routes to the first matching tag
  const row = mapNote('a', { area: 'meta', tags: 'workspace', title: 'Project Setup' })
  row.alias = 'project-setup'
  row.id = 'b70af942-7f34-4117-af02-649c57ff91ec' // encodes to twr5Qn80QRevAmScV_-R7A
  const specs = specsFromRows([row]).map(s => applyRoles(s, { areas: ['workspace', 'testing'] }))
  const state = new Map([['a', { namespace: 'o/r', pr_number: 10, pr_state: 'merged', implemented_at: new Date().toISOString() }]])

  const byId = noteRecord('a', specs, state)
  assert.strictEqual(byId.area, 'workspace', 'effective area, not the declared one')
  assert.strictEqual(byId.status, 'implemented', 'implemented_at overlays the note tag')
  assert.strictEqual(byId.pr, 10)
  assert.strictEqual(byId.prState, 'merged')
  assert.strictEqual(byId.namespace, 'o/r')
  assert.deepStrictEqual(byId.approvedBy, [], 'only attested approvals, none here')
  assert.strictEqual(byId.required, 0, 'no approvers declared')
  assert.deepStrictEqual(byId.stale, [], 'no snapshot rows on a fresh spec')
  assert.strictEqual(byId.changesUrl, '/changes/a')
  // the editor sends whatever segment its url carries, which may be the alias
  assert.deepStrictEqual(noteRecord('project-setup', specs, state), byId)
  // and with no alias it is the encoded uuid, which is what opening a note
  // actually redirects to
  assert.deepStrictEqual(noteRecord('twr5Qn80QRevAmScV_-R7A', specs, state), byId)
  assert.strictEqual(noteRecord('nosuchnote', specs, state), null)
  // a note guests cannot read is absent from the public snapshot
  assert.strictEqual(noteRecord('a', [], state), null)
  // without an implements commit the note's own tag stands
  assert.strictEqual(noteRecord('a', specs, new Map([['a', { pr_number: 10 }]])).status, 'approved')
  // an unpublished spec still answers, with the number and pr state absent
  // rather than undefined, which would drop the keys from the json entirely
  const unpublished = noteRecord('a', specs, new Map())
  assert.strictEqual(unpublished.pr, null)
  assert.strictEqual(unpublished.prState, null)
  assert.strictEqual(unpublished.status, 'approved')
  assert.deepStrictEqual(Object.keys(JSON.parse(JSON.stringify(unpublished))).sort(),
    ['approvals', 'approvedBy', 'area', 'changesUrl', 'namespace', 'pr', 'prState', 'required', 'stale', 'status'])
}

{
  // a spec reference resolves to the reviewable note when the board tracks it,
  // and to the PR otherwise, so an unpublished spec still goes somewhere
  const specs = mapSpecs([mapNote('a', { title: 'Route policy' })])
  const state = new Map([['a', { namespace: 'o/r', pr_number: 12 }]])
  assert.strictEqual(specRefTarget('o/r', 12, specs, state), specs[0].url)
  assert.strictEqual(specRefTarget('o/r', 99, specs, state), 'https://github.com/o/r/pull/99')
  // a namespace off the allowlist is refused: the caller picks the whole path,
  // so resolving it would redirect anywhere on github.com
  assert.strictEqual(specRefTarget('evil/repo', 1, specs, state), null)
  // a note guests cannot read is not in the public snapshot, so it degrades to
  // the PR instead of leaking the note URL
  assert.strictEqual(specRefTarget('o/r', 12, [], state), 'https://github.com/o/r/pull/12')
}

{
  // the map a spec PR carries includes the spec that PR adds: its number is
  // allocated in the same call, so the poller's state has not caught up
  const specs = mapSpecs([mapNote('a', { title: 'Route policy' })])
  const doc = namespaceMapDoc(specs, new Map(), specs[0], 12)
  assert.ok(doc.includes('012 Route policy'), doc)
  assert.ok(doc.startsWith('# o/r specs'), doc)

  // A revision opens its own PR, but the spec keeps the number everything else
  // cites it by; the revision number must not renumber it in the map.
  const published = new Map([['a', { namespace: 'o/r', pr_number: 12 }]])
  const rev = namespaceMapDoc(specs, published, specs[0], 58)
  assert.ok(rev.includes('012 Route policy'), rev)
  assert.strictEqual(rev.includes('058'), false, rev)
}
assert.strictEqual(specsFromRows([note('---\ntags: [spec]\n---\nx')])[0].supersedes, null)

// recipient email resolves from the OAuth profile (github [{value}], oauth2
// [string]) when the email column is empty; blank/garbage profiles yield ''
assert.strictEqual(profileEmail('{"emails":[{"value":"a@b.co"}]}'), 'a@b.co')
assert.strictEqual(profileEmail('{"emails":["c@d.co"]}'), 'c@d.co')
assert.strictEqual(profileEmail('{"displayName":"x"}'), '')
assert.strictEqual(profileEmail('not json'), '')

// PR index merge: an equal number updates state/ref (open -> merged on
// re-fetch), a higher number replaces the slug entry, a lower one is ignored
const prIdx = { byNumber: new Map(), bySlug: new Map() }
mergePr(prIdx, { number: 7, state: 'open', merged_at: null, head: { ref: '007-x' } })
mergePr(prIdx, { number: 7, state: 'closed', merged_at: '2026-01-01T00:00:00Z', head: { ref: '007-x' } })
assert.strictEqual(prIdx.byNumber.get(7), 'merged')
assert.strictEqual(prIdx.bySlug.get('x').state, 'merged')
mergePr(prIdx, { number: 5, state: 'open', merged_at: null, head: { ref: '005-x' } })
assert.strictEqual(prIdx.bySlug.get('x').number, 7)
mergePr(prIdx, { number: 9, state: 'open', merged_at: null, head: { ref: 'cat/009-x' } })
assert.deepStrictEqual(prIdx.bySlug.get('x'), { number: 9, state: 'open', ref: 'cat/009-x' })

// bySlug drives re-linking a spec to a PR, so only branches in the namespace's
// own repo may enter it: anyone can open a fork PR whose head is named
// NNN-<slug> and would otherwise adopt that spec's PR link.
const forkIdx = { byNumber: new Map(), bySlug: new Map() }
mergePr(forkIdx, { number: 11, state: 'open', merged_at: null, head: { ref: '011-y', repo: { full_name: 'attacker/fork' } } }, 'o/r')
assert.strictEqual(forkIdx.bySlug.get('y'), undefined, 'fork PR cannot claim a slug')
assert.strictEqual(forkIdx.byNumber.get(11), 'open') // state still tracked
mergePr(forkIdx, { number: 12, state: 'open', merged_at: null, head: { ref: '012-y', repo: { full_name: 'o/r' } } }, 'o/r')
assert.strictEqual(forkIdx.bySlug.get('y').number, 12)
// a fork PR with a higher number cannot displace the real one either
mergePr(forkIdx, { number: 13, state: 'open', merged_at: null, head: { ref: '013-y', repo: { full_name: 'attacker/fork' } } }, 'o/r')
assert.strictEqual(forkIdx.bySlug.get('y').number, 12)

// signed-cookie session: round-trips, rejects tampered signature and expiry
const sess = signToken({ uid: 'u1', login: 'josie', exp: Date.now() + 10000 })
assert.strictEqual(verifyToken(sess).login, 'josie')
assert.strictEqual(verifyToken(sess + 'x'), null)
assert.strictEqual(verifyToken('x' + sess.slice(1)), null) // tampered payload body, signature no longer covers it
assert.strictEqual(verifyToken(signToken({ exp: Date.now() - 1 })), null)
assert.strictEqual(verifyToken('garbage'), null)

// recipient merge: watchers included, disabled removed, deduped by email,
// profile email used when the column is empty
const recips = resolveRecipients(
  [{ id: 'a', email: 'a@x.co' }, { id: 'b', profile: '{"emails":["b@x.co"]}' }],
  [{ id: 'c', email: 'c@x.co' }, { id: 'a', email: 'a@x.co' }],
  new Set(['b']))
assert.deepStrictEqual(recips.sort(), ['a@x.co', 'c@x.co'])

// email digest: single spec keys the subject off its title, multiple specs
// summarize by count, and every event line lands in the body
assert.deepStrictEqual(
  renderDigest([{ note_id: 'a', title: 'Spec A', line: 'moved draft -> ready-for-review' }]),
  { subject: 'SpecDoc: Spec A', text: '- moved draft -> ready-for-review\n' })
const digest = renderDigest([
  { note_id: 'a', title: 'Spec A', line: 'l1' },
  { note_id: 'a', title: 'Spec A', line: 'l2' },
  { note_id: 'b', title: 'Spec B', line: 'l3' }
])
assert.strictEqual(digest.subject, 'SpecDoc: activity on 2 specs') // distinct specs, not lines
assert.ok(['l1', 'l2', 'l3'].every(l => digest.text.includes(l)))

// global opt-out (4th arg) drops an address even when it's a participant/watcher
assert.deepStrictEqual(
  resolveRecipients([{ id: 'a', email: 'a@x.co' }], [{ id: 'c', email: 'c@x.co' }], new Set(), new Set(['a@x.co'])),
  ['c@x.co'])

// digest footer: appended to the body, carries the one-click unsubscribe and
// privacy links so every mail is self-service compliant
const footer = emailFooter('a@x.co', 'https://b/unsub?t=TOK')
assert.ok(/Unsubscribe from all digests: https:\/\/b\/unsub\?t=TOK/.test(footer))
assert.ok(/Privacy:.*\/privacy/.test(footer))
assert.ok(footer.includes('a@x.co')) // identifies the recipient
assert.ok(renderDigest([{ note_id: 'a', title: 'A', line: 'l' }], footer).text.endsWith(footer))

// fenced-code spans: closed fence bounded, unclosed fence runs to the end
// and reports its opening offset
assert.deepStrictEqual(fenceRanges('a\n```\nb\n```\nc'), { ranges: [[2, 11]], open: -1 })
assert.deepStrictEqual(fenceRanges('```\nx'), { ranges: [[0, 5]], open: 0 })

// comment anchors: pinned vector shared with the editor's critic-markup test
// (cross-service lock), ordinal suffixes, resolved/fenced threads skipped
assert.strictEqual(commentAnchorHash('specbot', 'hello world'), '13af00ed')
assert.strictEqual(commentAnchorHash(' a ', 'x\n  y'), commentAnchorHash('a', 'x y'))
const anchored = threadAnchors('a {>>@a: t<<} b {>>@a: t<<}{>>%%resolved%%<<} c {>>@a: t<<} d\n```\n{>>@a: t<<}\n```\n{>>bare<<}')
assert.deepStrictEqual(anchored.map(t => t.id), ['comment-1ebda7e2', 'comment-1ebda7e2-2', 'comment-' + commentAnchorHash('', 'bare')])
assert.strictEqual(anchored[0].author, 'a')
// Same source and expected ids as the editor's "pinned shared anchor
// sequence" test (test/critic-markup.js); the two must stay identical so a
// divergence in ordinal or skip rules fails one side. Keep the fixtures in sync.
const shared = 'x {>>@specbot: hello world<<} y {>>@a: t<<} z {>>@a: t<<}{>>%%resolved%%<<} w {>>@a: t<<}\n```\n{>>@a: t<<}\n```\n'
assert.deepStrictEqual(threadAnchors(shared).map(t => t.id), ['comment-13af00ed', 'comment-1ebda7e2', 'comment-1ebda7e2-2'])

// review bot: injectComments anchors findings as CriticMarkup threads that
// the real counter sees, and reviewHash only moves on prose edits
const inject = (content, findings) => injectComments(content, findings, 'net-gpt')
const specDoc = '---\ntags: [spec, ready-for-review]\n---\n\n# Title\n\nUse exponential backoff for retries.\n\n```\nUse exponential backoff inside fence\n```\n'

const one = inject(specDoc, [{ quote: 'exponential backoff', comment: 'no jitter', severity: 'issue' }])
assert.ok(one.includes('exponential backoff{>>@net-gpt: issue: no jitter<<} for retries'), 'comment lands right after the quote')
assert.strictEqual(countCommentThreads(one), 1)

// a quote whose first occurrence sits in a fence anchors at the later body one
const skip = inject('---\ntags: [spec]\n---\n```\ntarget phrase\n```\ntarget phrase in prose\n', [{ quote: 'target phrase', comment: 'x' }])
assert.ok(skip.includes('target phrase{>>@net-gpt: x<<} in prose'), 'excluded first match skipped, second anchors')
assert.ok(!skip.includes('[no anchor]'))

// a quote only inside a fence is not anchored there; it appends as [no anchor]
const fenced = inject(specDoc, [{ quote: 'backoff inside fence', comment: 'x' }])
assert.ok(fenced.endsWith('{>>@net-gpt: [no anchor] x<<}\n'), 'fenced-only quote falls back to append')
assert.strictEqual(countCommentThreads(fenced), 1) // appended thread is outside the fence

// a quote that also occurs in frontmatter anchors at the first body occurrence
const fmDoc = '---\ntags: [spec]\ntitle: retries\n---\n\nretries are capped.\n'
const fm = inject(fmDoc, [{ quote: 'retries', comment: 'cap value?' }])
assert.ok(fm.includes('retries{>>@net-gpt: cap value?<<} are capped'), 'frontmatter never anchored')

// no newline after the closing ---: no body, so nothing may anchor into the YAML
const bare = inject('---\ntags: [spec, x]\n---', [{ quote: 'spec', comment: 'c' }])
assert.ok(!bare.includes('spec{>>'), 'frontmatter stays intact without a body')
assert.ok(bare.includes('[no anchor]'), 'finding survives as an append')

// a quote at the very end of the content still anchors inline
const atEnd = inject('---\ntags: [spec]\n---\nBody ends here', [{ quote: 'ends here', comment: 'x' }])
assert.ok(atEnd.endsWith('ends here{>>@net-gpt: x<<}'), 'end-of-content anchor')

// two insertions: descending-order apply keeps both offsets valid
const two = inject(specDoc, [
  { quote: '# Title', comment: 'a' },
  { quote: 'for retries.', comment: 'b' }
])
assert.ok(two.includes('# Title{>>@net-gpt: a<<}') && two.includes('for retries.{>>@net-gpt: b<<}'))
assert.strictEqual(countCommentThreads(two), 2)

// model text carrying CriticMarkup delimiters is defused by brace stripping
const hostile = inject(specDoc, [{ quote: 'Use', comment: 'bad <<} and {>> and {--x--} here' }])
assert.strictEqual(countCommentThreads(hostile), 1, 'sanitized payload stays one thread')
assert.strictEqual(resolveCritic(hostile), resolveCritic(specDoc), 'stripping the comment restores the doc')

// multiple unanchored findings append as separate threads, not one merged one
const multi = inject(specDoc, [
  { quote: 'nowhere1', comment: 'a' },
  { quote: 'nowhere2', comment: 'b' }
])
assert.strictEqual(countCommentThreads(multi), 2)

// no anchoring inside an existing comment's braces
const withThread = specDoc.replace('for retries.', 'for retries. {>>@a: exponential backoff is fine<<}')
const nested = inject(withThread, [{ quote: 'backoff is fine', comment: 'x' }])
assert.ok(!/backoff is fine\{>>@net-gpt/.test(nested), 'match inside a comment span skipped')
assert.ok(nested.includes('[no anchor]'), 'falls back to append')

// a quote ending flush against an existing thread's {>> must not insert there:
// the bot's thread would merge into it as a reply
const flushDoc = specDoc.replace('for retries.', 'for retries.{>>@a: t<<}')
const flush = inject(flushDoc, [{ quote: 'for retries.', comment: 'x' }])
assert.ok(!flush.includes('for retries.{>>@net-gpt'), 'no insert at an existing thread boundary')
assert.ok(flush.includes('[no anchor]'), 'falls back to append')

// a note ending inside an unclosed fence: the append lands above the fence,
// where it renders and counts, not inside it
const openFence = '---\ntags: [spec]\n---\ntext\n```\nnever closed\n'
const above = inject(openFence, [{ quote: 'nowhere', comment: 'x' }])
assert.strictEqual(countCommentThreads(above), 1, 'appended thread escapes the open fence')

// replaying the same findings is a no-op, on both the anchored and the
// [no anchor] form (the crash-between-writes replay path)
assert.strictEqual(inject(one, [{ quote: 'exponential backoff', comment: 'no jitter', severity: 'issue' }]), null)
assert.strictEqual(inject(fenced, [{ quote: 'backoff inside fence', comment: 'x' }]), null)
// findings above the cap are dropped; degenerate findings are ignored
const many = Array.from({ length: 12 }, (_, i) => ({ quote: 'nowhere', comment: `c${i}` }))
assert.strictEqual(countCommentThreads(inject(specDoc, many)), 10)
assert.strictEqual(inject(specDoc, []), null)
assert.strictEqual(inject(specDoc, [{ quote: 'q' }]), null) // no comment text, no empty thread
// an unknown severity drops the prefix instead of leaking into the note
assert.ok(inject(specDoc, [{ quote: '# Title', comment: 'x', severity: 'blocker' }]).includes('# Title{>>@net-gpt: x<<}'))

// dedup is per bot: the same finding from a second bot is a new thread with
// its own author, on both the anchored and the [no anchor] form
const finding = [{ quote: 'exponential backoff', comment: 'no jitter', severity: 'issue' }]
// the anchor sits flush against the first bot's thread, so the second bot's
// finding appends instead of merging into that thread as a reply
const secondBot = injectComments(one, finding, 'gpt-9')
assert.ok(secondBot.includes('{>>@gpt-9: [no anchor] issue: no jitter<<}'), 'second bot gets its own thread')
assert.strictEqual(countCommentThreads(secondBot), 2)
assert.strictEqual(injectComments(secondBot, finding, 'gpt-9'), null, 'second bot replay dedups')
const orphan = [{ quote: 'nowhere', comment: 'x' }]
const tailB = injectComments(inject(specDoc, orphan), orphan, 'gpt-9')
assert.ok(tailB.includes('{>>@gpt-9: [no anchor] x<<}'))
assert.strictEqual(injectComments(tailB, orphan, 'gpt-9'), null)

// validateBot: normalizes good input, rejects anything that could break the
// comment container or point at a non-http endpoint
const goodForm = { name: 'my-bot', url: 'https://m.test/', model: 'm1', prompt: ' ', api_key: '', enabled: 'on', 'ns:o/r': 'on', 'ns:evil/x': 'on' }
const vb = validateBot(goodForm, ['o/r', 'o/r2']).bot
assert.strictEqual(vb.url, 'https://m.test') // trailing slash stripped
assert.strictEqual(vb.prompt, null) // blank prompt -> built-in default
assert.deepStrictEqual(vb.namespaces, ['o/r']) // unknown namespace dropped
assert.strictEqual(vb.apiKey, null) // blank key -> keep stored
assert.strictEqual(vb.enabled, true)
// unchecked enabled box disables the bot
assert.strictEqual(validateBot({ name: 'x2', url: 'https://m', model: 'm' }, []).bot.enabled, false)
for (const bad of [{}, { name: 'My-Bot' }, { name: 'a b' }, { name: 'a{b' }, { name: 'a'.repeat(32) }]) {
  assert.ok(validateBot({ ...goodForm, ...bad, name: bad.name }, []).error, `rejects name ${JSON.stringify(bad.name)}`)
}
assert.ok(validateBot({ ...goodForm, url: 'ftp://x' }, []).error, 'rejects non-http url')
assert.ok(validateBot({ ...goodForm, model: ' ' }, []).error, 'rejects missing model')
for (const u of ['http://localhost/v1', 'http://127.0.0.1', 'http://169.254.169.254/latest', 'http://10.1.2.3', 'http://foo.svc/v1', 'http://[::1]/x']) {
  assert.ok(validateBot({ ...goodForm, url: u }, []).error, `rejects internal endpoint ${u}`)
}
assert.ok(!validateBot({ ...goodForm, url: 'https://api.openai.com/v1' }, []).error, 'accepts a public endpoint')
// the explicit clear checkbox wins over a typed key
assert.strictEqual(validateBot({ ...goodForm, api_key: 'newkey', clear_key: 'on' }, []).bot.apiKey, null)

// hash is blind to any bot's comments, tag edits, and whitespace (including
// the blank lines an above-the-fence append leaves behind); prose edits move it
assert.strictEqual(reviewHash(one), reviewHash(specDoc))
assert.strictEqual(reviewHash(secondBot), reviewHash(specDoc))
assert.strictEqual(reviewHash(specDoc.replace('ready-for-review', 'in-review')), reviewHash(specDoc))
assert.strictEqual(reviewHash(above), reviewHash(openFence))
assert.strictEqual(reviewHash(specDoc.replace('# Title', '#  Title\n\n')), reviewHash(specDoc))
assert.notStrictEqual(reviewHash(specDoc.replace('retries', 'attempts')), reviewHash(specDoc))

// The published body (and so its hash) is what lands in git: CriticMarkup
// resolved, frontmatter gone. Tag edits and resolved threads leave it alone.
{
  const doc = c => ({ content: '---\ntags: [spec, approved]\n---\n' + c })
  assert.strictEqual(publishedBody(doc('a {++new++} b')), 'a new b')
  const base = publishedHash(publishedBody(doc('body text')))
  assert.strictEqual(publishedHash(publishedBody({ content: '---\ntags: [spec, in-review]\n---\nbody text' })), base)
  assert.strictEqual(publishedHash(publishedBody(doc('body {>>@a: nit<<}{>>%%resolved%%<<}text'))), base)
  assert.notStrictEqual(publishedHash(publishedBody(doc('body text, revised'))), base)

  // Revisions only run against a merged spec PR, only for an edit that is not
  // published yet, and reuse an open revision PR instead of stacking a new one.
  const merged = { pr_state: 'merged', published_hash: 'H1', revision: null, revision_pr: null }
  const none = () => 'open'
  assert.strictEqual(revisionPlan(merged, 'H1', none), null) // unchanged
  assert.strictEqual(revisionPlan({ ...merged, pr_state: 'open' }, 'H2', none), null)
  assert.strictEqual(revisionPlan({ ...merged, pr_state: 'closed' }, 'H2', none), null)
  assert.strictEqual(revisionPlan({ ...merged, published_hash: null }, 'H2', none), null) // pre-tracking
  assert.deepStrictEqual(revisionPlan(merged, 'H2', none), { n: 1 })
  const rev1 = { ...merged, revision: 1, revision_pr: 50 }
  assert.deepStrictEqual(revisionPlan(rev1, 'H2', () => 'open'), { n: 1 }) // same PR keeps taking edits
  assert.deepStrictEqual(revisionPlan(rev1, 'H2', () => 'merged'), { n: 2 })
  assert.deepStrictEqual(revisionPlan(rev1, 'H2', () => 'closed'), { n: 2 })
  assert.deepStrictEqual(revisionPlan(rev1, 'H2', () => undefined), { n: 2 }) // PR gone from the index
  assert.strictEqual(revisionPlan({ ...merged, superseded_at: '2026-01-01' }, 'H2', none), null)
  // a revision_pr without its counter (hand-edited state) still names a branch
  assert.deepStrictEqual(revisionPlan({ ...merged, revision_pr: 50 }, 'H2', () => 'open'), { n: 1 })
}

// Approval locks the note and reopening it restores the permission it had, or
// reviewers cannot edit the spec they are being asked to re-approve.
{
  const unlocked = { locked_at: null, prelock_permission: null }
  assert.strictEqual(lockPlan('in-review', true, unlocked, 'freely'), null)
  assert.strictEqual(lockPlan('approved', false, unlocked, 'freely'), null) // quorum/comments not cleared
  const locked = lockPlan('approved', true, unlocked, 'freely')
  assert.strictEqual(locked.permission, 'locked')
  assert.strictEqual(locked.prelockPermission, 'freely')
  assert.ok(locked.lockedAt)
  const held = { locked_at: locked.lockedAt, prelock_permission: 'freely' }
  assert.strictEqual(lockPlan('approved', true, held, 'locked'), null) // one-shot
  assert.deepStrictEqual(lockPlan('in-review', false, held, 'locked'),
    { permission: 'freely', lockedAt: null, prelockPermission: null })
  // locked before the pre-lock permission was recorded
  assert.strictEqual(lockPlan('in-review', false, { ...held, prelock_permission: null }, 'locked').permission, 'editable')
  // the owner already changed it by hand: clear the state, leave the note alone
  assert.deepStrictEqual(lockPlan('draft', false, held, 'editable'),
    { permission: 'editable', lockedAt: null, prelockPermission: null })
}

// The board is unauthenticated and its search matches note bodies, so notes
// HedgeDoc hides from guests never reach the snapshot it serves.
{
  const perm = p => ({ id: p || 'none', permission: p })
  assert.deepStrictEqual(
    publicSpecs(['freely', 'editable', 'locked', 'limited', 'protected', 'private', null, undefined].map(perm)).map(s => s.permission),
    ['freely', 'editable', 'locked', null, undefined])
}

// An approval only earns a Reviewed-by trailer when HedgeDoc recorded that
// person writing to the note; approved-by alone is editable by anyone.
{
  const idMap = new Map([['alice', { id: 'u1', name: 'Alice A', email: 'a@x' }], ['bob', { id: 'u2', name: 'bob', email: null }]])
  const writers = new Set(['u1'])
  const { attested, unattested } = attestedApprovers(['Alice', 'bob', 'carol'], idMap, writers)
  assert.deepStrictEqual(attested.map(u => u.id), ['u1'])
  assert.deepStrictEqual(unattested, ['bob', 'carol']) // bob never wrote, carol has no account
  assert.deepStrictEqual(attestedApprovers([], idMap, writers), { attested: [], unattested: [] })
}

// Commenters are reviewers too, on the same evidence: a thread signature
// their own session wrote. Resolved threads and replies count; the author,
// an already-credited approver, a guest, and a bot do not.
{
  const prof = (displayName, username) => JSON.stringify({ displayName, username })
  const participants = [
    { id: 'owner', email: 'o@x', profile: prof('Owner O', 'owner') },
    { id: 'u1', email: 'a@x', profile: prof('Alice A', 'alice') },
    { id: 'u3', email: 'c@x', profile: prof('Carol C', 'carol') },
    { id: 'u4', email: null, profile: prof(null, 'dave') },
    { id: 'u5', email: 'e@x', profile: prof('Erin E', 'erin') } // wrote, never commented
  ]
  const content = [
    'body {>>@Owner O: mine<<}{>>@Carol C: reply<<}{>>%%resolved%%<<}',
    '{>>@dave: lowercase login signs<<}',
    '{>>@Ghost G: guest, no row<<} {>>@net-bot: bot, no row<<}',
    '```\n{>>@Erin E: inside a fence<<}\n```'
  ].join('\n')
  // Each signature was typed by the session it names; everything else by
  // the owner.
  // Atoms partition the text: the named spans by their sessions, the rest
  // by the owner.
  const atomsFor = (text, spans) => {
    const out = []
    let pos = 0
    for (const [needle, id] of spans) {
      const at = text.indexOf(needle)
      if (at > pos) out.push(['owner', pos, at, 1, 1])
      out.push([id, at, at + needle.length, 1, 1])
      pos = at + needle.length
    }
    if (pos < text.length) out.push(['owner', pos, text.length, 1, 1])
    return out
  }
  const authorship = atomsFor(content, [['Carol C', 'u3'], ['dave', 'u4']])
  const credited = new Set(['owner', 'u1'])
  assert.deepStrictEqual(commentReviewers(content, participants, credited, authorship),
    [{ name: 'Carol C', email: 'c@x' }, { name: 'dave', email: null }])
  assert.deepStrictEqual([...credited].sort(), ['owner', 'u1', 'u3', 'u4'])
  assert.deepStrictEqual(commentReviewers('no threads', participants, new Set(), authorship), [])
  // A signature typed by someone else, or with no authorship behind it,
  // credits nobody.
  assert.deepStrictEqual(commentReviewers(content, participants, new Set(['owner', 'u1']), atomsFor(content, [])), [])
  assert.deepStrictEqual(commentReviewers(content, participants, new Set(['owner', 'u1'])), [])
  const forged = content + '\n{>>@Carol C: typed by the owner<<}'
  assert.deepStrictEqual(commentReviewers(forged, participants, new Set(['owner', 'u1']), atomsFor(forged, [['dave', 'u4']])), [{ name: 'dave', email: null }])
}

// checkpoints: the tag is the record, so the numbering and the gate are the
// only logic worth pinning.
{
  assert.deepStrictEqual(checkpointTags([]).next, 'specs/v1')
  assert.deepStrictEqual(
    checkpointTags(['refs/tags/specs/v1', 'refs/tags/specs/v2']).next, 'specs/v3')
  // gaps are never refilled: highest + 1, so a deleted tag's number stays dead
  assert.strictEqual(checkpointTags(['refs/tags/specs/v1', 'refs/tags/specs/v4']).next, 'specs/v5')
  // the repo's own release tags share the namespace and must not be counted
  const mixed = checkpointTags([
    { ref: 'refs/tags/v9', object: { sha: 'x' } },
    { ref: 'refs/tags/specs/v2', object: { sha: 'deadbeef' } },
    { ref: 'refs/tags/specs/vnext' }
  ])
  assert.strictEqual(mixed.next, 'specs/v3')
  assert.deepStrictEqual(mixed.latest, { tag: 'specs/v2', n: 2, sha: 'deadbeef' })
  assert.strictEqual(checkpointTags(null).latest, null)
}

{
  // a corpus that is consistent: two live specs, one retired and stamped
  const specs = mapSpecs([
    mapNote('a', { area: 'networking', deps: '7', title: 'Route policy' }),
    mapNote('b', { area: 'networking', title: 'Static routes' }),
    mapNote('c', { area: 'storage', supersedes: '20', title: 'Snapshots v2' }),
    mapNote('old', { area: 'storage', title: 'Snapshots' })
  ])
  const state = new Map([
    ['a', { note_id: 'a', namespace: 'o/r', pr_number: 12, pr_state: 'merged', spec_path: 'specs/networking/012-route-policy.md' }],
    ['b', { note_id: 'b', namespace: 'o/r', pr_number: 7, pr_state: 'merged', spec_path: 'specs/networking/007-static-routes.md' }],
    ['c', { note_id: 'c', namespace: 'o/r', pr_number: 21, pr_state: 'merged', spec_path: 'specs/storage/021-snapshots-v2.md' }],
    ['old', { note_id: 'old', namespace: 'o/r', pr_number: 20, pr_state: 'merged', spec_path: 'specs/storage/020-snapshots.md', superseded_at: '2026-01-01T00:00:00Z' }]
  ])
  const nodes = specGraph(specs, state)
  const paths = new Set([...state.values()].map(s => s.spec_path).concat(['specs/README.md']))
  const banners = new Map([['specs/storage/020-snapshots.md', true]])
  const base = { ns: 'o/r', specsDir: 'specs', nodes, specs, state, paths, banners, committedMap: mermaidMap(nodes, 'o/r') }
  assert.deepStrictEqual(checkpointBlockers(base), [])

  const kinds = o => checkpointBlockers({ ...base, ...o }).map(b => b.kind)
  // the retired spec's file still reads live
  assert.deepStrictEqual(kinds({ banners: new Map() }), ['unstamped-supersede'])
  // a published spec's file left the tree
  const gone = new Set([...paths].filter(p => p !== 'specs/networking/007-static-routes.md'))
  assert.deepStrictEqual(kinds({ paths: gone }), ['missing-file'])
  // a file nothing claims, and the same tree with claims unknown
  const stray = new Set([...paths, 'specs/networking/099-hand-written.md'])
  assert.deepStrictEqual(kinds({ paths: stray }), ['orphan-file'])
  assert.deepStrictEqual(kinds({ paths: stray, orphans: false }), [])
  // the committed index no longer describes the graph
  assert.deepStrictEqual(kinds({ committedMap: '# stale\n' }), ['stale-map'])
  // at the repo apex there is no map and no numbering convention to enforce
  assert.deepStrictEqual(kinds({ specsDir: '', paths: stray, committedMap: null }), [])
  // the dir lands in a RegExp source, so a dot in it must not match any char
  assert.deepStrictEqual(checkpointBlockers({
    ...base,
    specsDir: 'do.cs',
    committedMap: null,
    paths: new Set(['doXcs/001-not-ours.md', 'do.cs/002-legacy/spec.md'])
  }).filter(b => b.kind === 'orphan-file').map(b => b.path), ['do.cs/002-legacy/spec.md'])
}

{
  // the two reference failures, which are what "reconciled" actually means
  const specs = mapSpecs([
    mapNote('a', { deps: '7', title: 'Route policy' }),
    mapNote('b', { title: 'Static routes' }),
    mapNote('c', { supersedes: '999', title: 'Orphan replacement' })
  ])
  const state = new Map([
    ['a', { note_id: 'a', namespace: 'o/r', pr_number: 12, pr_state: 'merged', spec_path: 'specs/012-a.md' }],
    ['b', { note_id: 'b', namespace: 'o/r', pr_number: 7, pr_state: 'merged', spec_path: 'specs/007-b.md', superseded_at: '2026-01-01T00:00:00Z' }],
    ['c', { note_id: 'c', namespace: 'o/r', pr_number: 21, pr_state: 'merged', spec_path: 'specs/021-c.md' }]
  ])
  const nodes = specGraph(specs, state)
  const out = checkpointBlockers({
    ns: 'o/r',
    specsDir: 'specs',
    nodes,
    specs,
    state,
    paths: new Set(['specs/012-a.md', 'specs/021-c.md']),
    banners: new Map([['specs/007-b.md', true]]),
    committedMap: mermaidMap(nodes, 'o/r')
  })
  // a still depends on b, which c retired; c supersedes a number nobody has
  assert.deepStrictEqual(out.map(b => [b.kind, b.n]).sort(),
    [['stale-dep', 12], ['unresolved-ref', 21]])
  // b's file is gone from the tree, but a retired spec is allowed to be deleted
  assert.ok(!out.some(b => b.kind === 'missing-file'))
}

{
  // the two ref forms the number-in-this-namespace tests do not reach: a note
  // shortid, and a number in another namespace
  const blockersFor = (dep, rows) => {
    const specs = mapSpecs([mapNote('a', { deps: dep, title: 'Route policy' })])
    const state = new Map([['a', { note_id: 'a', namespace: 'o/r', pr_number: 12 }], ...rows])
    return checkpointBlockers({
      ns: 'o/r',
      specsDir: '',
      nodes: specGraph(specs, state),
      specs,
      state,
      paths: new Set(),
      banners: new Map(),
      committedMap: null
    }).map(b => [b.kind, b.detail])
  }
  const ghost = { note_id: 'ghost', namespace: 'o/r', pr_number: 5 }
  const far = { note_id: 'x', namespace: 'other/repo', pr_number: 4 }
  const retired = { superseded_at: '2026-01-01T00:00:00Z' }

  // a shortid ref survives its note being deleted: the state row still points
  // at a spec file that merged
  assert.deepStrictEqual(blockersFor('ghost', [['ghost', ghost]]), [])
  assert.deepStrictEqual(blockersFor('ghost', []),
    [['unresolved-ref', 'depends-on ghost, which matches no spec']])

  // the ref index spans namespaces, so retirement over there is caught here
  assert.deepStrictEqual(blockersFor('other/repo#4', [['x', far]]), [])
  assert.deepStrictEqual(blockersFor('other/repo#4', [['x', { ...far, ...retired }]]),
    [['stale-dep', 'depends-on other/repo#4, which has been superseded']])
}

{
  // the tag message is the manifest: git show is the only place a checkpoint
  // says what was in it
  const specs = mapSpecs([mapNote('a', { title: 'Route  policy' }), mapNote('b', { title: 'Static routes' })])
  const nodes = specGraph(specs, new Map([
    ['a', { namespace: 'o/r', pr_number: 12 }],
    ['b', { namespace: 'o/r', pr_number: 7 }]
  ]))
  const msg = checkpointMessage('specs/v3', nodes, 'o/r',
    { findings: [{ a: 12, b: 7, why: 'both define retry policy' }] })
  assert.ok(msg.startsWith('checkpoint specs/v3\n\n2 specs\n'), msg)
  assert.ok(msg.includes('007 Static routes\n012 Route policy\n'), msg)
  assert.ok(msg.includes('1 overlap finding acknowledged\n  012 vs 007  both define retry policy'), msg)
  assert.strictEqual(checkpointMessage('specs/v1', nodes, 'o/r', null).includes('overlap'), false)

  // the changelog sits between the manifest and the findings, in the same
  // one-line-per-item shape, with the model paragraph attributed
  const changes = {
    from: 'specs/v2',
    truncated: false,
    added: [{ label: '014', title: 'Route  retries', pr: 14, revision: null, revisionPr: null }],
    revised: [{ label: '007', title: 'Static routes', pr: 7, revision: 2, revisionPr: 22 }],
    retired: [{ label: '005', title: 'Old routes', pr: 5, revision: null, revisionPr: null, replacement: { label: '014', title: 'Route retries' } }],
    implemented: [{ label: '009', title: 'Baz', pr: 9, revision: null, revisionPr: null }]
  }
  const withChanges = checkpointMessage('specs/v3', nodes, 'o/r', { findings: [{ a: 12, b: 7, why: 'w' }] }, changes, { bot: 'nit', summary: 'Retries replace static routes.' })
  assert.ok(withChanges.includes('012 Route policy\n\nsince specs/v2: 1 added, 1 revised, 1 retired, 1 implemented\n' +
    '  added 014 Route retries\n  revised 007 Static routes (rev 2, #22)\n  retired 005 Old routes, replaced by 014 Route retries\n  implemented 009 Baz\n\n' +
    'summary from nit, advisory:\nRetries replace static routes.\n\n1 overlap finding'), withChanges)
  const quiet = { from: 'specs/v2', truncated: true, added: [], revised: [], retired: [], implemented: [] }
  assert.ok(checkpointMessage('specs/v3', nodes, 'o/r', null, quiet, null).endsWith('since specs/v2: no spec changes (file list truncated: added and revised omitted)\n'))
  // a top-level spec heads the manifest under its name
  const topNodes = specGraph(mapSpecs([mapNote('p', { kind: 'top-level', title: 'Philosophy' }), mapNote('b', { title: 'Static routes' })]),
    new Map([['p', { namespace: 'o/r', pr_number: 13 }], ['b', { namespace: 'o/r', pr_number: 7 }]]))
  assert.ok(checkpointMessage('specs/v1', topNodes, 'o/r', { findings: [{ a: 7, b: 'philosophy', why: 'contradicts P4' }] })
    .includes('2 specs\nphilosophy Philosophy\n007 Static routes\n\n1 overlap finding acknowledged\n  007 vs philosophy  contradicts P4'))
}

{
  // what changed since the last cut: added and revised from the file diff,
  // retired and implemented from the board's timestamps
  const cutAt = '2026-08-01T00:00:00Z'
  const before = '2026-07-01T00:00:00Z'
  const later = '2026-08-15T00:00:00Z'
  const specs = mapSpecs([
    mapNote('new', { title: 'Route retries', supersedes: '5' }),
    mapNote('rev', { title: 'Static routes' }),
    mapNote('old', { title: 'Old routes' }),
    mapNote('done', { title: 'Baz' }),
    mapNote('p', { kind: 'top-level', title: 'Philosophy' })
  ])
  const state = new Map([
    ['new', { note_id: 'new', namespace: 'o/r', pr_number: 14, spec_path: 'specs/014-route-retries.md' }],
    ['rev', { note_id: 'rev', namespace: 'o/r', pr_number: 7, spec_path: 'specs/007-static-routes.md', revision: 2, revision_pr: 22 }],
    ['old', { note_id: 'old', namespace: 'o/r', pr_number: 5, spec_path: 'specs/005-old-routes.md', superseded_at: later }],
    ['done', { note_id: 'done', namespace: 'o/r', pr_number: 9, spec_path: 'specs/009-baz.md', implemented_at: later }],
    ['gone', { note_id: 'gone', namespace: 'o/r', pr_number: 3, spec_path: 'specs/003-gone.md', implemented_at: later }],
    ['p', { note_id: 'p', namespace: 'o/r', pr_number: 13, spec_path: 'specs/philosophy.md' }],
    ['earlier', { note_id: 'earlier', namespace: 'o/r', pr_number: 2, spec_path: 'specs/002-earlier.md', implemented_at: before }],
    ['elsewhere', { note_id: 'elsewhere', namespace: 'other/repo', pr_number: 1, spec_path: 'specs/001-x.md', implemented_at: later }]
  ])
  const graph = specGraph(specs, state)
  const files = [
    { status: 'added', filename: 'specs/014-route-retries.md' },
    { status: 'added', filename: 'specs/philosophy.md' },
    { status: 'modified', filename: 'specs/007-static-routes.md' },
    { status: 'modified', filename: 'specs/005-old-routes.md' }, // the superseded banner stamp
    { status: 'modified', filename: 'specs/README.md' },
    { status: 'added', filename: 'specs/099-by-hand.md' } // no row: the orphan blocker's business
  ]
  const ch = checkpointChanges({ files, state, specs, graph, ns: 'o/r', cutAt, from: 'specs/v1' })
  assert.deepStrictEqual(ch.added.map(e => [e.label, e.title]), [['014', 'Route retries'], ['philosophy', 'Philosophy']])
  assert.deepStrictEqual(ch.revised.map(e => [e.label, e.revision, e.revisionPr]), [['007', 2, 22]])
  assert.deepStrictEqual(ch.retired.map(e => [e.label, e.replacement && e.replacement.label]), [['005', '014']])
  // a deleted note keeps its number and falls back to the file name; the
  // earlier window and the other namespace stay out
  assert.deepStrictEqual(ch.implemented.map(e => [e.label, e.title]), [['009', 'Baz'], ['003', '003-gone']])
  assert.strictEqual(ch.truncated, false)
  const capped = checkpointChanges({ files: new Array(300).fill(files[0]), state, specs, graph, ns: 'o/r', cutAt, from: 'specs/v1' })
  assert.deepStrictEqual([capped.truncated, capped.added, capped.retired.length], [true, [], 1])
  assert.strictEqual(checkpointChanges({ files: null, state, specs, graph, ns: 'o/r', cutAt, from: 'specs/v1' }).truncated, true)
  assert.strictEqual(ch.added[0].id, 'new') // the summary pass reads bodies by note id

  // the model paragraph is one line of plain text, braces gone so it can
  // never carry CriticMarkup into a note or a tag
  assert.strictEqual(parseSummary({ summary: '  a {b}\n c ' }), 'a b c')
  assert.strictEqual(parseSummary({ summary: 7 }), '')
  assert.strictEqual(parseSummary(null), '')
  assert.ok(/JSON only/.test(CHANGELOG_SYSTEM))
}

{
  // the admin page: a blocked namespace offers no cut, a clean one with
  // findings cannot be cut without acknowledging them
  const sess = { login: 'octocat' }
  const changes = {
    from: 'specs/v1',
    truncated: false,
    added: [{ label: '014', title: 'Route retries', pr: 14, revision: null, revisionPr: null }],
    revised: [],
    retired: [{ label: '005', title: 'Old routes', pr: 5, revision: null, revisionPr: null, replacement: { label: '014', title: 'Route retries' } }],
    implemented: []
  }
  const clean = { ns: 'o/r', count: 3, head: 'abcdef1234', next: 'specs/v2', latest: { tag: 'specs/v1' }, cutAt: '2026-08-01T00:00:00Z', changes, summary: { bot: 'nit', summary: 'Retries replace static routes.' }, blockers: [], orphans: true, overlap: { bot: 'nit', findings: [{ a: 12, b: 7, why: 'both define retries' }], skipped: [] } }
  const cleanHtml = checkpointsPage(sess, [clean], 'o/r')
  // the changelog previews before the cut, the model paragraph attributed
  assert.ok(cleanHtml.includes('<h3>Since specs/v1</h3>'), cleanHtml)
  assert.ok(cleanHtml.includes('<li><b>retired</b> 005 Old routes, replaced by 014 Route retries</li>'), cleanHtml)
  assert.ok(cleanHtml.includes('Summary from <b>nit</b>, advisory: Retries replace static routes.'), cleanHtml)
  assert.ok(checkpointsPage(sess, [{ ...clean, summary: { bot: null, error: 'nit 500' } }], 'o/r').includes('Summary failed: nit 500. The checkpoint can still be cut.'))
  assert.ok(checkpointsPage(sess, [{ ...clean, changes: null }], 'o/r').includes('cut 2026-08-01'))
  assert.ok(!checkpointsPage(sess, [{ ...clean, changes: null }], 'o/r').includes('Since specs'))
  assert.ok(cleanHtml.includes('Cut specs/v2</button>'), cleanHtml)
  assert.ok(!cleanHtml.includes('disabled'), cleanHtml)
  assert.ok(cleanHtml.includes('name="ack" value="1"'), cleanHtml)
  assert.ok(cleanHtml.includes('012 vs 007: both define retries'), cleanHtml)
  assert.ok(cleanHtml.includes('cut 2026-08-01'), cleanHtml)

  const blocked = { ...clean, blockers: [{ kind: 'stale-map', ns: 'o/r', path: 'specs/README.md', detail: 'the committed map no longer matches the graph' }], overlap: { bot: null, findings: [], skipped: [] } }
  const blockedHtml = checkpointsPage(sess, [blocked], 'o/r')
  assert.ok(blockedHtml.includes('value="cut" disabled'), blockedHtml)
  assert.ok(blockedHtml.includes('Open map refresh PR'), blockedHtml)
  assert.ok(!blockedHtml.includes('name="ack"'), blockedHtml)

  // the index never runs the overlap pass, so it never offers a cut
  const index = checkpointsPage(sess, [blocked], '')
  assert.ok(index.includes('1 to reconcile'), index)
  assert.ok(!index.includes('value="cut"'), index)

  // a namespace that could not be read says so instead of rendering half a form
  const broken = checkpointsPage(sess, [{ ns: 'o/r', error: 'Not Found' }], 'o/r')
  assert.ok(broken.includes('Could not read this namespace: Not Found'), broken)

  // the two silent cases read differently, or a corpus too small to compare
  // looks like a namespace nobody configured a bot for
  const silent = { bot: null, findings: [], skipped: [] }
  assert.ok(checkpointsPage(sess, [{ ...clean, count: 1, overlap: silent }], 'o/r')
    .includes('Fewer than two approved specs'))
  assert.ok(checkpointsPage(sess, [{ ...clean, overlap: silent }], 'o/r')
    .includes('No review bot covers this namespace'))

  // what the budget left out is named whether or not the pass found anything
  const trimmed = { bot: 'nit', findings: [], skipped: [31] }
  assert.ok(checkpointsPage(sess, [{ ...clean, overlap: trimmed }], 'o/r')
    .includes('Specs left out of the pass for size: 031.'))

  // every value on this page is note-authored or model-authored, so none of it
  // may reach the markup unescaped
  const hostile = checkpointsPage(sess, [{
    ...clean,
    ns: 'o/<img src=x>',
    blockers: [{ kind: 'orphan-file', ns: 'o/r', path: 'specs/<script>.md', detail: 'a "quoted" & <tag>' }],
    overlap: { bot: '<b>bot</b>', findings: [{ a: 12, b: 7, why: '</p><script>alert(1)</script>' }], skipped: [] },
    changes: { ...changes, added: [{ label: '014', title: '<script>x</script>', pr: 14 }] },
    summary: { bot: '<img src=x>', summary: '<script>y</script>' }
  }], 'o/r')
  assert.ok(!hostile.includes('<script>'), hostile)
  assert.ok(!hostile.includes('<img src=x>'), hostile)
  assert.ok(hostile.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), hostile)
  assert.ok(hostile.includes('a &quot;quoted&quot; &amp; &lt;tag&gt;'), hostile)
}

{
  const specs = mapSpecs([
    mapNote('a', { deps: '7', title: 'Route policy' }),
    mapNote('b', { title: 'Static routes' })
  ])
  const nodes = specGraph(specs, new Map([
    ['a', { namespace: 'o/r', pr_number: 12 }],
    ['b', { namespace: 'o/r', pr_number: 7 }]
  ]))
  const bodies = new Map([['a', 'A body.'], ['b', 'B body.']])
  const corpus = overlapCorpus(nodes, id => bodies.get(id))
  assert.deepStrictEqual(corpus.skipped, [])
  assert.strictEqual(corpus.text,
    '### spec 007: Static routes\narea: unfiled\n\nB body.\n\n### spec 012: Route policy\narea: unfiled\n\nA body.\n')
  // a spec whose body the board cannot produce still announces itself, so the
  // model is not silently told the corpus is smaller than it is
  assert.ok(overlapCorpus(nodes, () => null).text.includes('### spec 007: Static routes'))
  // the budget is bytes
  const tight = overlapCorpus(nodes, id => bodies.get(id), 40)
  assert.deepStrictEqual(tight.skipped, [12])
  assert.ok(tight.text.startsWith('### spec 007'), tight.text)
  // the first spec is admitted truncated rather than dropped: an empty corpus
  // would have the model report on nothing at all
  const tiny = overlapCorpus(nodes, id => bodies.get(id), 10)
  assert.deepStrictEqual([tiny.text, tiny.skipped], ['### spec 0', [12]])

  // findings are filtered to what was actually asked about
  assert.deepStrictEqual(parseOverlap([
    { a: 12, b: 7, why: 'declared already' }, // a depends-on b: not a finding
    { a: 12, b: 999, why: 'unknown spec' },
    { a: 12, b: 12, why: 'itself' },
    { a: 7, b: 12, why: 'the declared pair the other way round' }
  ], nodes), [])
  assert.deepStrictEqual(parseOverlap([
    { a: 7, b: 12, why: 'x' }
  ], specGraph(mapSpecs([mapNote('a', { title: 'A' }), mapNote('b', { title: 'B' })]), new Map([
    ['a', { namespace: 'o/r', pr_number: 12 }],
    ['b', { namespace: 'o/r', pr_number: 7 }]
  ]))), [{ a: 7, b: 12, why: 'x' }])
  assert.deepStrictEqual(parseOverlap(null, nodes), [])

  // a top-level spec enters the corpus first under its pseudo-area, and a
  // finding against it comes back under its name rather than a number
  const withTop = specGraph(mapSpecs([mapNote('p', { kind: 'top-level', title: 'Philosophy' }), mapNote('b', { title: 'B' })]),
    new Map([['p', { namespace: 'o/r', pr_number: 13 }], ['b', { namespace: 'o/r', pr_number: 7 }]]))
  assert.ok(overlapCorpus(withTop, () => 'x').text.startsWith('### spec 013: Philosophy\narea: top-level\n'))
  assert.deepStrictEqual(parseOverlap([{ a: 7, b: 13, why: 'contradicts P4' }], withTop), [{ a: 7, b: 'philosophy', why: 'contradicts P4' }])
}

{
  // a review carries the namespace's approved top-level specs, as published:
  // not a draft one, not one from another namespace, not the spec itself
  const specs = mapSpecs([
    mapNote('p', { kind: 'top-level', title: 'Philosophy' }, 'P1 holds. {>>@bot: nit<<}{>>%%resolved%%<<}'),
    mapNote('d', { kind: 'top-level', status: 'draft', title: 'Draft rules' }, 'Not yet.'),
    mapNote('o', { kind: 'top-level', ns: 'other/repo', title: 'Elsewhere' }, 'Other.'),
    mapNote('f', { status: 'in-review', title: 'Feature' })
  ])
  const ctx = reviewContext(specs.find(s => s.id === 'f'), specs, new Map())
  assert.ok(ctx.endsWith('never this text.\n\n# H\n\nP1 holds.'), ctx)
  assert.ok(!ctx.includes('nit') && !ctx.includes('Not yet') && !ctx.includes('Other.'), ctx)
  assert.strictEqual(reviewContext(specs.find(s => s.id === 'p'), specs, new Map()), '')
  assert.strictEqual(reviewContext(specs.find(s => s.id === 'f'), specs, new Map([['p', { superseded_at: 'x' }]])), '')
}

{
  // the fields the api must not carry are on the spec object itself, so the
  // fixture has to actually populate them or the exclusion proves nothing
  const row = mapNote('a', { area: 'networking', deps: '7, other/repo#3', supersedes: '4', title: 'Route policy' })
  row.alias = 'route-policy'
  row.id = 'b70af942-7f34-4117-af02-649c57ff91ec'
  row.owner_email = 'octocat@private.example'
  row.owner_profile = JSON.stringify({ provider: 'github', username: 'octocat', displayName: 'Octo Cat' })
  const [spec] = specsFromRows([row]).map(x => applyRoles(x, { areas: ['networking'], approvers: ['octocat'] }))
  const state = new Map([['a', { note_id: 'a', namespace: 'o/r', pr_number: 12, pr_state: 'merged', spec_path: 'specs/networking/012-route-policy.md' }]])

  const out = specSummary(spec, state)
  assert.deepStrictEqual(Object.keys(out).sort(), [
    'abstract', 'alias', 'area', 'author', 'changed', 'comments', 'dependsOn', 'id',
    'kind', 'namespace', 'pr', 'prState', 'specPath', 'status', 'suggestions', 'superseded',
    'supersedes', 'tags', 'title', 'url', 'urlId'
  ])
  assert.strictEqual(out.kind, 'feature')
  assert.strictEqual(spec.authorEmail, 'octocat@private.example')
  assert.ok(spec.roles && spec.content, 'fixture must carry the fields we exclude')
  for (const leaked of ['content', 'authorEmail', 'roles', 'approvers', 'ownerId', 'ownerToken', 'permission']) {
    assert.ok(!(leaked in out), leaked)
  }
  // a key-set assertion alone would not catch the email arriving under a key
  // that belongs here, so the values of the identity fields are pinned too
  assert.strictEqual(out.author, 'octocat')
  assert.ok(!JSON.stringify(out).includes('private.example'), JSON.stringify(out))
  assert.strictEqual(out.status, 'approved')
  assert.strictEqual(out.area, 'networking')
  assert.strictEqual(out.specPath, 'specs/networking/012-route-policy.md')
  assert.strictEqual(out.urlId, 'twr5Qn80QRevAmScV_-R7A')
  assert.strictEqual(out.abstract, 'Abstract line.')
  // the board hides a retired spec; the api marks it instead
  assert.strictEqual(out.superseded, false)
  assert.strictEqual(specSummary(spec, new Map([['a', { superseded_at: '2026-01-01T00:00:00Z' }]])).superseded, true)
  // refs are the declared ones, which is all a draft ever has
  assert.deepStrictEqual(out.dependsOn, ['o/r#7', 'other/repo#3'])
  assert.strictEqual(out.supersedes, 'o/r#4')

  // implemented_at overlays the note's own tag, the way the board does it
  assert.strictEqual(specSummary(spec, new Map([['a', { implemented_at: new Date().toISOString() }]])).status, 'implemented')
}

{
  // the list filters and orders stably
  const specs = mapSpecs([
    mapNote('a', { title: 'Route policy' }),
    mapNote('b', { status: 'draft', title: 'Static routes' }),
    mapNote('c', { ns: 'other/repo', title: 'Snapshots' })
  ])
  const state = new Map([
    ['a', { namespace: 'o/r', pr_number: 12 }],
    ['c', { namespace: 'other/repo', pr_number: 3 }]
  ])
  const all = specList(specs, state)
  // namespace, then number with the unnumbered last
  assert.deepStrictEqual(all.map(r => [r.namespace, r.pr]), [['o/r', 12], ['o/r', null], ['other/repo', 3]])
  assert.deepStrictEqual(specList(specs, state, { ns: 'other/repo' }).map(r => r.title), ['Snapshots'])
  assert.deepStrictEqual(specList(specs, state, { status: 'draft' }).map(r => r.title), ['Static routes'])
  assert.deepStrictEqual(specList(specs, state, { status: 'nonsense' }), [])
  // a draft carries the abstract setSnapshot computed for it, which the graph
  // would never have given it: specGraph only has approved and implemented specs
  const [draft] = mapSpecs([mapNote('d', { status: 'draft', title: 'D' })])
  draft.abstract = 'Draft abstract.'
  assert.strictEqual(specList([draft], new Map())[0].abstract, 'Draft abstract.')
  assert.deepStrictEqual(specGraph([draft], new Map()), [])
}

{
  // publicSpecs is the only gate, and it runs before the projection: these are
  // the three hedgedoc refuses anonymously, and locked is not one of them
  const rows = ['private', 'limited', 'protected', 'locked', 'editable', null].map((p, i) => {
    const r = mapNote(`n${i}`, { title: p || 'default' })
    r.permission = p
    return r
  })
  const specs = mapSpecs(rows)
  assert.strictEqual(specs.length, 6)
  assert.deepStrictEqual(publicSpecs(specs).map(s => s.title), ['locked', 'editable', 'default'])
}

{
  // the live note is never in HedgeDoc's revision list, so the board puts it
  // there itself: `current` leads and needs no round trip to fetch
  const spec = { changed: '2026-09-04T10:00:00.000Z', content: 'body' }
  const list = revisionList(spec, [
    { time: 1757000000000, length: 900 },
    { time: 1757900000000, length: 1000 }
  ])
  assert.deepStrictEqual(list[0], { time: 'current', at: '2026-09-04T10:00:00.000Z', length: 4 })
  // newest first, and `at` is readable without the caller doing epoch maths
  assert.deepStrictEqual(list.slice(1).map(r => [r.time, r.at, r.length]), [
    [1757900000000, '2025-09-15T01:33:20.000Z', 1000],
    [1757000000000, '2025-09-04T15:33:20.000Z', 900]
  ])
  // an editor that answers with nothing usable still yields a usable series
  assert.deepStrictEqual(revisionList(spec, []).map(r => r.time), ['current'])
  assert.deepStrictEqual(revisionList(spec, null).map(r => r.time), ['current'])
  // null, '' and [] all coerce to 0 and would otherwise emit a 1970 entry
  assert.deepStrictEqual(
    revisionList(spec, [{ length: 1 }, { time: 'x' }, { time: null }, { time: '' }, { time: [] }, { time: -1 }])
      .map(r => r.time), ['current'])
}

{
  // the rate-limit key must be the address a proxy we trust actually observed,
  // never one the caller wrote
  const req = (xff, peer = '10.0.0.1') => ({
    socket: { remoteAddress: peer },
    headers: xff == null ? {} : { 'x-forwarded-for': xff }
  })

  // no proxy: the header is ignored entirely
  assert.strictEqual(clientIp(req('1.2.3.4'), 0), '10.0.0.1')

  // one proxy, honest caller: the router appended the caller's address
  assert.strictEqual(clientIp(req('203.0.113.9'), 1), '203.0.113.9')

  // one proxy, caller forges two hops. The router appends what it saw, so the
  // forged values sit further from the server and are never selected.
  assert.strictEqual(clientIp(req('9.9.9.9, 8.8.8.8, 203.0.113.9'), 1), '203.0.113.9')

  // two proxies: the caller is one further along
  assert.strictEqual(clientIp(req('203.0.113.9, 172.16.0.1'), 2), '203.0.113.9')
  assert.strictEqual(clientIp(req('9.9.9.9, 203.0.113.9, 172.16.0.1'), 2), '203.0.113.9')

  // a caller who strips the header cannot reach past the proxies' own addresses
  assert.strictEqual(clientIp(req(null), 1), '10.0.0.1')
  assert.strictEqual(clientIp(req('203.0.113.9'), 3), '203.0.113.9')

  // the spoof the old first-hop read allowed: one bucket per forged value
  const forged = ['a', 'b', 'c'].map(v => clientIp(req(`${v}, 203.0.113.9`), 1))
  assert.deepStrictEqual(forged, ['203.0.113.9', '203.0.113.9', '203.0.113.9'])

  assert.strictEqual(clientIp({ socket: {}, headers: {} }, 1), 'unknown')
  assert.strictEqual(clientIp(req('  , 203.0.113.9 ,  '), 1), '203.0.113.9')
}

{
  // paging walks the whole corpus exactly once, and the cursor survives the
  // corpus changing underneath it
  const row = (namespace, pr, title) => ({ namespace, pr, title })
  const rows = [
    row('o/r', 7, 'B'), row('o/r', 12, 'A'), row('o/r', null, 'Y'),
    row('o/r', null, 'Z'), row('other/repo', 3, 'C')
  ]
  const walk = (all, limit) => {
    const seen = []
    let cursor = null
    for (let i = 0; i < 20; i++) {
      const p = specPage(all, limit, cursor)
      seen.push(...p.specs.map(r => r.title))
      if (!p.next) return seen
      cursor = JSON.parse(Buffer.from(p.next, 'base64url').toString())
      cursor = { namespace: cursor[0], pr: cursor[1], title: cursor[2] }
    }
    throw new Error('did not terminate')
  }
  assert.deepStrictEqual(walk(rows, 2), ['B', 'A', 'Y', 'Z', 'C'])
  assert.deepStrictEqual(walk(rows, 1), ['B', 'A', 'Y', 'Z', 'C'])
  assert.deepStrictEqual(walk(rows, 99), ['B', 'A', 'Y', 'Z', 'C'])
  // a full page that exactly empties the list still reports the end
  assert.strictEqual(specPage(rows, 5, null).next, null)
  assert.strictEqual(specPage([], 10, null).next, null)
  assert.deepStrictEqual(specPage([], 10, null).specs, [])

  // an index would skip 'Y' here; a sort-key cursor does not
  const afterA = { namespace: 'o/r', pr: 12, title: 'A' }
  const grown = [row('o/r', 1, 'New'), ...rows]
  assert.deepStrictEqual(specPage(grown, 2, afterA).specs.map(r => r.title), ['Y', 'Z'])
  // and the row the cursor names disappearing does not strand the pull
  const shrunk = rows.filter(r => r.title !== 'A')
  assert.deepStrictEqual(specPage(shrunk, 9, afterA).specs.map(r => r.title), ['Y', 'Z', 'C'])

  // unnumbered specs sort last within a namespace and never compare NaN
  assert.deepStrictEqual(specPage(rows, 9, null).specs.map(r => [r.namespace, r.pr]),
    [['o/r', 7], ['o/r', 12], ['o/r', null], ['o/r', null], ['other/repo', 3]])
  assert.strictEqual(encodeCursor(row('o/r', null, 'Z')), Buffer.from('["o/r",null,"Z"]').toString('base64url'))
}

// End-to-end of the supersede PR path: drive the real openSpecPr against a
// mocked GitHub API and assert it opens the replacement PR with a Supersedes
// line and stamps the "Superseded by" banner into the replaced spec.md.
;(async () => {
  {
    // the fan-out cap: results stay in input order and no more than GH_BATCH
    // run at once, while one slow item does not stall the slots behind it
    let live = 0
    let peak = 0
    const run = async n => {
      live++
      peak = Math.max(peak, live)
      await new Promise(r => setTimeout(r, n % 10 === 0 ? 40 : 1))
      live--
      return n * 2
    }
    assert.deepStrictEqual(await inBatches([], run), [])
    const started = Date.now()
    assert.deepStrictEqual(await inBatches([...Array(25).keys()], run),
      [...Array(25).keys()].map(n => n * 2))
    assert.ok(peak <= 10, `peak ${peak}`)
    // one slow item per GH_BATCH-sized span. Waves would serialise them into
    // three 40ms waits; a pool overlaps all three.
    assert.ok(Date.now() - started < 90, `took ${Date.now() - started}ms`)
  }

  const calls = []
  let branchRefs = [] // live heads served by the matching-refs mock, per scenario
  let headPulls = [] // PRs already on the branch being pushed, per scenario
  const ok = obj => ({ ok: true, status: 200, headers: new Headers(), json: async () => obj, text: async () => JSON.stringify(obj) })
  const notFound = () => ({ ok: false, status: 404, headers: new Headers(), json: async () => ({}), text: async () => 'not found' })
  global.fetch = async (url, opts) => {
    const method = opts.method
    const path = url.replace('https://api.github.com', '')
    calls.push({ method, path, body: opts.body ? JSON.parse(opts.body) : null })
    if (method === 'GET' && path === '/repos/o/r') return ok({ default_branch: 'main' })
    if (method === 'GET' && path === '/repos/o/r/git/ref/heads/main') return ok({ object: { sha: 'BASESHA' } })
    if (method === 'GET' && path.startsWith('/repos/o/r/contents/specs?')) return ok([{ type: 'dir', name: '012-old-approach' }])
    if (method === 'GET' && path.startsWith('/repos/o/r/contents/?')) return ok([{ type: 'file', name: '007-root-spec.md' }])
    if (method === 'GET' && path.startsWith('/repos/o/r/contents/core?')) return notFound()
    if (method === 'GET' && path.startsWith('/repos/o/r/contents/rfcs?')) return notFound()
    if (method === 'GET' && path === '/repos/o/r/git/matching-refs/heads/') return ok(branchRefs)
    if (method === 'GET' && path === '/repos/o/r/git/matching-refs/heads/core/') return ok([])
    if (method === 'POST' && path === '/repos/o/r/git/refs') return ok({})
    if (method === 'GET' && /\/contents\/specs\/012-old-approach\/spec\.md\?/.test(path)) return ok({ content: Buffer.from('# Old approach\n\nold body\n').toString('base64'), sha: 'OLDSHA' })
    if (method === 'PUT' && path === '/repos/o/r/contents/specs/012-old-approach/spec.md') return ok({})
    // a revision branch carries the merged spec file already, so its blob sha
    // must come back; a fresh spec branch has no file yet
    if (method === 'GET' && /\/contents\/(?:[\w-]+\/)*\d+-[^/]+\.md\?ref=[^&]*-r\d+$/.test(path)) return ok({ content: Buffer.from('# New approach\n\nmerged body\n').toString('base64'), sha: 'REVSHA' })
    if (method === 'GET' && /\/contents\/(?:[\w-]+\/)*README\.md\?/.test(path)) return notFound()
    if (method === 'PUT' && /\/contents\/(?:[\w-]+\/)*README\.md$/.test(path)) return ok({})
    if (method === 'GET' && /\/contents\/(?:[\w-]+\/)*\d+-[^/]+\.md\?/.test(path)) return notFound()
    if (method === 'PUT' && /\/contents\/(?:[\w-]+\/)*\d+-[^/]+\.md$/.test(path)) return ok({})
    if (method === 'GET' && /\/contents\/specs\/philosophy\.md\?ref=philosophy-r1$/.test(path)) return ok({ content: Buffer.from('old\n').toString('base64'), sha: 'PHILSHA' })
    if (method === 'GET' && /\/contents\/specs\/philosophy\.md\?/.test(path)) return notFound()
    if (method === 'PUT' && path === '/repos/o/r/contents/specs/philosophy.md') return ok({})
    if (method === 'GET' && /\/pulls\?state=all&head=/.test(path)) return ok(headPulls)
    if (method === 'POST' && path === '/repos/o/r/pulls') return ok({ number: 42 })
    if (method === 'GET' && path === '/repos/o/r/pulls/12/files?per_page=100') return ok([{ filename: 'specs/012-old-approach/spec.md' }])
    if (method === 'GET' && path === '/repos/o/r/git/trees/BASESHA?recursive=1') return ok({ tree: [{ type: 'blob', path: 'specs/012-old-approach/spec.md' }] })
    throw new Error('unmocked ' + method + ' ' + path)
  }
  const spec = {
    id: 'noteXYZ',
    namespace: 'o/r',
    title: 'New approach',
    url: 'https://md/x',
    content: '---\ntags: [spec, approved]\n---\n\n# New approach\n\nA better way.\n',
    roles: null,
    statusIdx: 3,
    supersedes: { ns: 'o/r', n: 12 },
    dependsOn: [],
    ownerToken: null
  }
  // commitIdentities resolves these before the PR opens; openSpecPr consumes
  // them verbatim. bob has no linked account, so no email.
  const ids = {
    author: { name: 'Josie P', email: 'josie@x.com' },
    reviewers: [{ name: 'Alice A', email: 'alice@x.com' }, { name: 'bob', email: null }]
  }
  const opened = await openSpecPr(spec, '', ids)
  assert.strictEqual(opened.number, 42) // PR number becomes the spec number
  assert.strictEqual(opened.path, 'specs/013-new-approach.md')
  const newFile = calls.find(c => c.method === 'PUT' && /\/contents\/specs\/013-new-approach\.md$/.test(c.path))
  assert.ok(newFile, 'new spec file written on the branch')
  const msg = newFile.body.message
  // Gerrit-style trailers land in the commit message
  assert.ok(msg.includes('Spec-Id: noteXYZ'), 'commit carries the spec id')
  assert.ok(msg.includes('Reviewed-on: https://md/x'), 'commit links back to the note')
  assert.ok(msg.includes('Reviewed-by: Alice A <alice@x.com>'), 'reviewer with an account credited as name <email>')
  assert.ok(msg.includes('Reviewed-by: @bob'), 'reviewer without an account degrades to @login')
  assert.deepStrictEqual(newFile.body.author, { name: 'Josie P', email: 'josie@x.com' }, 'commit authored by the owner')
  assert.ok(msg.includes('Supersedes: o/r#12'), 'supersede recorded as a trailer')
  const stamp = calls.find(c => c.method === 'PUT' && c.path === '/repos/o/r/contents/specs/012-old-approach/spec.md')
  assert.ok(stamp, 'replaced spec.md stamped')
  assert.ok(!calls.some(c => c.path.includes('/git/trees/')), 'old spec located via its PR files, not the tree grep')
  const stamped = Buffer.from(stamp.body.content, 'base64').toString()
  assert.ok(stamped.startsWith('> **Superseded by o/r#42.**'), 'banner prepended')
  assert.ok(stamped.includes('old body'), 'old content kept below the banner')
  assert.strictEqual(stamp.body.sha, 'OLDSHA') // updates the existing blob

  // A spec that supersedes nothing: trailers still present, no Supersedes, no stamp.
  calls.length = 0
  await openSpecPr({ ...spec, title: 'Plain spec', supersedes: null }, '', ids)
  assert.ok(!calls.some(c => c.path.includes('/git/trees/')), 'no stamp when nothing is superseded')
  const plainFile = calls.find(c => c.method === 'PUT' && /\/contents\/specs\/013-plain-spec\.md$/.test(c.path))
  assert.ok(plainFile.body.message.includes('Reviewed-by: Alice A <alice@x.com>'), 'reviewers still credited')
  assert.ok(!plainFile.body.message.includes('Supersedes:'), 'no Supersedes trailer without a link')

  // A live branch from an unmerged spec reserves its number: allocation skips it.
  calls.length = 0
  branchRefs = [{ ref: 'refs/heads/013-in-flight' }]
  await openSpecPr({ ...spec, title: 'Third Way', supersedes: null }, '', ids)
  assert.ok(calls.some(c => c.method === 'PUT' && /\/contents\/specs\/014-third-way\.md$/.test(c.path)), 'live branch 013 skipped, 014 allocated')

  // A SPEC-N title whose number is taken by a different slug falls back to
  // sequential instead of colliding on the branch and path.
  calls.length = 0
  branchRefs = []
  await openSpecPr({ ...spec, title: 'SPEC-012 Other Thing', supersedes: null }, '', ids)
  assert.ok(calls.some(c => c.method === 'PUT' && /\/contents\/specs\/013-other-thing\.md$/.test(c.path)), 'taken title number falls back to sequential')

  // a live branch with this slug is this spec retrying: it reuses its number
  calls.length = 0
  branchRefs = [{ ref: 'refs/heads/012-old-approach' }]
  await openSpecPr({ ...spec, title: 'Old Approach', supersedes: null }, '', ids)
  assert.ok(calls.some(c => c.method === 'PUT' && c.path === '/repos/o/r/contents/specs/012-old-approach.md'), 'live branch with the same slug reuses its number')

  // the same slug on a published spec is a different note sharing a title, so
  // it numbers separately. legacy NNN-slug/ dirs still count toward numbering.
  calls.length = 0
  branchRefs = []
  await openSpecPr({ ...spec, title: 'Old Approach', supersedes: null }, '', ids)
  assert.ok(calls.some(c => c.method === 'PUT' && c.path === '/repos/o/r/contents/specs/013-old-approach.md'), 'merged slug does not hand over its number')
  assert.ok(!calls.some(c => c.method === 'PUT' && c.path.includes('012-old-approach')), 'the published spec file is untouched')

  // specs-dir '': specs (and area dirs) land at the repo apex.
  calls.length = 0
  const rootRoles = { 'specs-dir': '' }
  await openSpecPr({ ...spec, title: 'Apex Spec', supersedes: null, roles: rootRoles }, '', ids)
  assert.ok(calls.some(c => c.method === 'PUT' && c.path === '/repos/o/r/contents/008-apex-spec.md'), 'apex layout writes at the root, numbered from root files')
  calls.length = 0
  await openSpecPr({ ...spec, title: 'Cored Spec', supersedes: null, roles: rootRoles }, 'core', ids)
  assert.ok(calls.some(c => c.method === 'PUT' && c.path === '/repos/o/r/contents/core/001-cored-spec.md'), 'area dir at the apex')

  // Custom specs-dir routes everything under it.
  calls.length = 0
  await openSpecPr({ ...spec, title: 'Rfc Spec', supersedes: null, roles: { 'specs-dir': 'rfcs' } }, '', ids)
  assert.ok(calls.some(c => c.method === 'PUT' && c.path === '/repos/o/r/contents/rfcs/001-rfc-spec.md'), 'custom specs-dir honored')

  // The spec map rides in the PR: same branch, same author, and it already
  // lists the spec that PR adds even though no state row records it yet.
  calls.length = 0
  const mapped = { ...spec, title: 'Mapped Spec', supersedes: null }
  await openSpecPr(mapped, '', ids, null, { specs: [mapped], state: new Map() })
  const mapPut = calls.find(c => c.method === 'PUT' && c.path === '/repos/o/r/contents/specs/README.md')
  assert.ok(mapPut, 'spec map written on the branch')
  const mapDoc = Buffer.from(mapPut.body.content, 'base64').toString()
  assert.ok(mapDoc.includes('042 Mapped Spec'), mapDoc)
  assert.deepStrictEqual(mapPut.body.author, ids.author, 'map commit authored like the spec commit')
  // Without the poller's data (any other caller) no map is written.
  calls.length = 0
  await openSpecPr({ ...spec, title: 'Unmapped Spec', supersedes: null }, '', ids)
  assert.ok(!calls.some(c => /README\.md$/.test(c.path)), 'map only written when the poller passes its data')
  // At the apex, README.md is the project's own.
  calls.length = 0
  const apex = { ...spec, title: 'Apex Mapped', supersedes: null, roles: rootRoles }
  await openSpecPr(apex, '', ids, null, { specs: [apex], state: new Map() })
  assert.ok(!calls.some(c => /README\.md$/.test(c.path)), 'no spec map at the repo apex')

  // A revision of a merged spec: same file, own branch, no number allocation,
  // and no second supersede stamp even though the spec still declares one.
  calls.length = 0
  const revved = await openSpecPr(spec, '', ids, { n: 1, path: 'specs/013-new-approach.md' })
  assert.deepStrictEqual(revved, { number: 42, path: 'specs/013-new-approach.md' })
  assert.ok(!calls.some(c => c.path.includes('/contents/specs?') || c.path.includes('/matching-refs/')),
    'revision reuses the merged path instead of allocating a number')
  const branchRef = calls.find(c => c.method === 'POST' && c.path === '/repos/o/r/git/refs')
  assert.strictEqual(branchRef.body.ref, 'refs/heads/013-new-approach-r1')
  const revFile = calls.find(c => c.method === 'PUT' && c.path === '/repos/o/r/contents/specs/013-new-approach.md')
  assert.ok(revFile.body.message.startsWith('spec: update 013 New approach'), 'revision commit says update')
  assert.ok(revFile.body.message.includes('Spec-Id: noteXYZ'), 'trailers carried into the revision')
  assert.strictEqual(revFile.body.branch, '013-new-approach-r1')
  assert.strictEqual(revFile.body.sha, 'REVSHA') // updates the file the branch inherited from base
  assert.strictEqual(Buffer.from(revFile.body.content, 'base64').toString(), '# New approach\n\nA better way.\n')
  assert.strictEqual(calls.find(c => c.method === 'POST' && c.path === '/repos/o/r/pulls').body.title,
    'spec: New approach (rev 1)')
  assert.ok(!calls.some(c => c.path === '/repos/o/r/contents/specs/012-old-approach/spec.md'), 'no re-stamp on a revision')

  // An open PR on the revision branch takes the new commit; a merged one is
  // finished, so the push opens a fresh PR instead of reporting the merged one.
  calls.length = 0
  headPulls = [{ number: 51, state: 'open', merged_at: null, head: { ref: '013-new-approach-r1' } }]
  assert.strictEqual((await openSpecPr(spec, '', ids, { n: 1, path: 'specs/013-new-approach.md' })).number, 51)
  assert.ok(!calls.some(c => c.method === 'POST' && c.path === '/repos/o/r/pulls'), 'open revision PR reused')
  calls.length = 0
  headPulls = [{ number: 51, state: 'closed', merged_at: '2026-02-01T00:00:00Z', head: { ref: '013-new-approach-r1' } }]
  assert.strictEqual((await openSpecPr(spec, '', ids, { n: 1, path: 'specs/013-new-approach.md' })).number, 42)
  calls.length = 0
  headPulls = []

  // A title edit cannot re-path a revision: the stored path wins, including the
  // legacy NNN-slug/spec.md layout, whose branch stays flat.
  calls.length = 0
  await openSpecPr({ ...spec, title: 'Renamed Entirely' }, '', ids, { n: 2, path: 'specs/012-old-approach/spec.md' })
  assert.strictEqual(calls.find(c => c.method === 'POST' && c.path === '/repos/o/r/git/refs').body.ref,
    'refs/heads/012-old-approach-r2')
  const legacy = calls.find(c => c.method === 'PUT' && c.path === '/repos/o/r/contents/specs/012-old-approach/spec.md')
  assert.ok(legacy.body.message.startsWith('spec: update 012 Renamed Entirely'), 'number comes from the path, not the title')
  assert.strictEqual(legacy.body.sha, 'OLDSHA') // updates the existing blob

  // A top-level spec publishes unnumbered at the specs-dir root, whatever area
  // it is in; its revision finds no number in the path and must not throw.
  calls.length = 0
  const top = { ...spec, title: 'Philosophy', topLevel: true, supersedes: null }
  const topOpened = await openSpecPr(top, 'core', ids)
  assert.strictEqual(topOpened.path, 'specs/philosophy.md')
  assert.ok(!calls.some(c => c.path.includes('/contents/specs?') || c.path.includes('/matching-refs/')), 'no number allocated')
  assert.strictEqual(calls.find(c => c.method === 'POST' && c.path === '/repos/o/r/git/refs').body.ref, 'refs/heads/philosophy')
  const topFile = calls.find(c => c.method === 'PUT' && c.path === '/repos/o/r/contents/specs/philosophy.md')
  assert.ok(topFile.body.message.startsWith('spec: add Philosophy\n'), topFile.body.message)
  calls.length = 0
  await openSpecPr(top, 'core', ids, { n: 1, path: 'specs/philosophy.md' })
  assert.strictEqual(calls.find(c => c.method === 'POST' && c.path === '/repos/o/r/git/refs').body.ref, 'refs/heads/philosophy-r1')
  const topRev = calls.find(c => c.method === 'PUT' && c.path === '/repos/o/r/contents/specs/philosophy.md')
  assert.ok(topRev.body.message.startsWith('spec: update Philosophy\n'), topRev.body.message)
  assert.strictEqual(topRev.body.sha, 'PHILSHA')

  // callBot against a mocked model endpoint (same global.fetch slot as the
  // GitHub mock above, so these run after the openSpecPr scenarios)
  let modelReq
  global.fetch = async (url, opts) => {
    modelReq = { url, opts }
    return ok({ choices: [{ message: { content: JSON.stringify({ comments: [{ quote: 'q', comment: 'c' }] }) } }] })
  }
  const bot = { name: 'net-gpt', url: 'http://model.test', model: 'm1', api_key: 'k', prompt: 'custom prompt' }
  const found = await callBot(bot, 'spec body')
  assert.deepStrictEqual(found, [{ quote: 'q', comment: 'c' }])
  assert.strictEqual(modelReq.url, 'http://model.test/v1/chat/completions')
  assert.ok(modelReq.opts.signal instanceof AbortSignal, 'timeout signal attached')
  assert.strictEqual(modelReq.opts.headers.Authorization, 'Bearer k')
  const reqBody = JSON.parse(modelReq.opts.body)
  assert.strictEqual(reqBody.model, 'm1')
  assert.strictEqual(reqBody.messages[0].content, 'custom prompt')
  assert.strictEqual(reqBody.messages[1].content, 'spec body')
  // inherited context lands behind the prompt, custom or not, never in the user turn
  await callBot(bot, 'spec body', '\n\nCTX')
  assert.deepStrictEqual(JSON.parse(modelReq.opts.body).messages.map(m => m.content), ['custom prompt\n\nCTX', 'spec body'])
  assert.strictEqual(reqBody.response_format.type, 'json_schema')

  // no key -> no auth header; no prompt -> built-in default
  await callBot({ name: 'b', url: 'http://m2.test', model: 'm2' }, 'x')
  assert.ok(!('Authorization' in modelReq.opts.headers))
  assert.strictEqual(JSON.parse(modelReq.opts.body).messages[0].content, REVIEW_SYSTEM)

  global.fetch = async () => notFound()
  await assert.rejects(() => callBot(bot, 'x'), /net-gpt 404/) // error names the bot
  global.fetch = async () => ok({ choices: [{ message: { content: 'not json' } }] })
  await assert.rejects(() => callBot(bot, 'x'), SyntaxError)
  global.fetch = async () => ok({ choices: [{ message: { content: '{"wrong": true}' } }] })
  await assert.rejects(() => callBot(bot, 'x'), /no comments array/)

  {
    // the four api handlers, driven directly: the router resolves the spec, so
    // they take one and never reach for the snapshot
    // Modelled on http.ServerResponse in the one way that matters here: a
    // second writeHead throws, which is how a post-header throw escapes an
    // async handler and takes the process with it.
    const res = () => {
      const r = { status: 0, headers: {}, body: '', sent: false }
      r.writeHead = (st, h) => {
        if (r.sent) throw Object.assign(new Error('headers already sent'), { code: 'ERR_HTTP_HEADERS_SENT' })
        r.sent = true
        r.status = st
        Object.assign(r.headers, h || {})
        return r
      }
      r.end = b => { r.body = b === undefined ? '' : b; return r }
      return r
    }
    const spec = {
      id: 'shortid123',
      alias: 'pwn?x',
      urlId: 'u',
      title: 'Route policy',
      url: 'http://editor:3000/pwn?x',
      changed: '2026-09-04T10:00:00.000Z',
      content: '---\ntitle: T\n---\n# H\n\nBody {>>thread<<}.\n',
      statusIdx: 3,
      category: 'networking',
      namespace: 'o/r',
      tags: ['spec'],
      authorLogin: 'octocat',
      comments: 0,
      suggestions: 0,
      dependsOn: [],
      supersedes: null,
      abstract: 'Body.'
    }
    const state = new Map()
    const fetched = []
    const stub = impl => { global.fetch = async (url, opts) => { fetched.push(url); return impl(url, opts) } }
    const ok = obj => ({ ok: true, status: 200, headers: new Headers(), json: async () => obj })

    // the alias holds `?`, which would move /revision into the query string.
    // The proxy must address the editor by shortid, which no request supplies.
    fetched.length = 0
    stub(() => ok({ content: 'past text' }))
    let r = res()
    await revisionGet(r, spec, '1757000000000')
    // built from the configured editor base and the shortid, never from
    // spec.url, which carries the alias
    assert.deepStrictEqual(fetched, ['http://localhost:3000/shortid123/revision/1757000000000'])
    assert.ok(!fetched[0].includes('pwn'), fetched[0])
    assert.ok(!fetched[0].includes('editor:3000'), fetched[0])
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body, 'past text')

    // an editor answering 200 with something that is not json must not reach
    // the handler's catch after headers are sent: that killed the process
    fetched.length = 0
    stub(() => ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError('Unexpected token <') } }))
    r = res()
    await revisionGet(r, spec, '1757000000000')
    assert.strictEqual(r.status, 502, 'must not have written 200 before parsing')
    assert.deepStrictEqual(JSON.parse(r.body), { error: 'editor unreachable' })

    // the editor refusing a note, or having no revision at that time, is this
    // api's 404 rather than its 502
    stub(() => ({ ok: false, status: 403, headers: new Headers(), json: async () => ({}) }))
    r = res()
    await revisionGet(r, spec, '1757000000000')
    assert.strictEqual(r.status, 404)
    assert.deepStrictEqual(JSON.parse(r.body), { error: 'unknown spec' })

    // an editor that is down
    stub(() => { throw new Error('ECONNREFUSED') })
    r = res()
    await revisionGet(r, spec, '1757000000000')
    assert.strictEqual(r.status, 502)

    // `current` is the board's own copy, raw, and costs no round trip
    fetched.length = 0
    r = res()
    await revisionGet(r, spec, 'current')
    assert.deepStrictEqual(fetched, [])
    assert.strictEqual(r.body, spec.content)
    assert.match(r.headers['Content-Type'], /^text\/markdown/)

    // the series still answers when the editor does not
    stub(() => { throw new Error('down') })
    r = res()
    await revisionsGet(r, spec)
    assert.strictEqual(r.status, 200)
    assert.deepStrictEqual(JSON.parse(r.body).revisions.map(x => x.time), ['current'])

    stub(() => ok({ revision: [{ time: 1757000000000, length: 9 }] }))
    r = res()
    await revisionsGet(r, spec)
    assert.deepStrictEqual(JSON.parse(r.body).revisions.map(x => x.time), ['current', 1757000000000])

    // one spec: json by default, markdown on request, published form in both
    r = res()
    specGet({ headers: {} }, r, spec, state)
    let doc = JSON.parse(r.body)
    assert.strictEqual(doc.body, '# H\n\nBody .\n')
    assert.strictEqual(doc.title, 'Route policy')
    assert.ok(!('content' in doc), 'raw note must not ride along')

    r = res()
    specGet({ headers: { accept: 'text/markdown' } }, r, spec, state)
    assert.strictEqual(r.body, '# H\n\nBody .\n')
    assert.match(r.headers['Content-Type'], /^text\/markdown/)

    // the list envelope reports the snapshot it was handed, not a global
    r = res()
    specsGet(r, new URL('http://x/api/specs'), { at: 1757000000000, specs: [spec], state })
    doc = JSON.parse(r.body)
    assert.strictEqual(doc.at, '2025-09-04T15:33:20.000Z')
    assert.strictEqual(doc.stale, true)
    assert.deepStrictEqual(doc.specs.map(x => x.id), ['shortid123'])
    assert.match(r.headers['Cache-Control'], /^public, max-age=/)
    assert.strictEqual(r.headers['Access-Control-Allow-Origin'], '*')

    r = res()
    specsGet(r, new URL('http://x/api/specs?status=draft'), { at: Date.now(), specs: [spec], state })
    assert.deepStrictEqual(JSON.parse(r.body).specs, [])
    assert.strictEqual(JSON.parse(r.body).stale, false)

    // paging over the handler: two specs, one at a time, and `next` closes
    const two = { at: Date.now(), specs: [spec, { ...spec, id: 'other', title: 'Zulu' }], state }
    r = res()
    specsGet(r, new URL('http://x/api/specs?limit=1'), two)
    doc = JSON.parse(r.body)
    assert.deepStrictEqual(doc.specs.map(x => x.title), ['Route policy'])
    assert.ok(doc.next, 'a short page must offer a cursor')

    r = res()
    specsGet(r, new URL(`http://x/api/specs?limit=1&cursor=${encodeURIComponent(doc.next)}`), two)
    doc = JSON.parse(r.body)
    assert.deepStrictEqual(doc.specs.map(x => x.title), ['Zulu'])
    assert.strictEqual(doc.next, null)

    // a cursor the client did not get from us is a request error, not an
    // empty page that reads like the end of the corpus
    for (const bad of ['zzz', Buffer.from('{}').toString('base64url'), Buffer.from('[1,2,3]').toString('base64url')]) {
      r = res()
      specsGet(r, new URL(`http://x/api/specs?cursor=${encodeURIComponent(bad)}`), two)
      assert.strictEqual(r.status, 400, bad)
      assert.deepStrictEqual(JSON.parse(r.body), { error: 'bad cursor' })
    }

    // limit is clamped, not trusted: a caller cannot ask for the whole corpus
    // in one response, and neither can a caller who asks for nothing sensible
    const many = {
      at: Date.now(),
      state,
      specs: Array.from({ length: 600 }, (_, i) =>
        ({ ...spec, id: `s${i}`, title: `Spec ${String(i).padStart(4, '0')}` }))
    }
    for (const q of ['limit=99999', 'limit=notanumber', 'limit=-1', 'limit=0', '']) {
      r = res()
      specsGet(r, new URL(`http://x/api/specs?${q}`), many)
      doc = JSON.parse(r.body)
      assert.strictEqual(doc.specs.length, 500, q)
      assert.ok(doc.next, q)
    }
    // and a caller asking for less than the cap gets what they asked for
    r = res()
    specsGet(r, new URL('http://x/api/specs?limit=3'), many)
    assert.strictEqual(JSON.parse(r.body).specs.length, 3)
  }

  console.log('ok')
})().catch(e => { console.error(e); process.exit(1) })
