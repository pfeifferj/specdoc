const assert = require('assert')
process.env.GITHUB_TOKEN = 'test-token' // openSpecPr's gh() reads it at module load
process.env.SESSION_SECRET = 'test-secret' // hmac for signToken/verifyToken
const { frontmatter, metaTags, resolveCritic, fenceRanges, countCommentThreads, countSuggestions, commentAnchorHash, threadAnchors, reviewHash, injectComments, callBot, REVIEW_SYSTEM, validateBot, specsFromRows, applyRoles, quorumMet, canApprove, commitPrefix, buildBoard, slug, numberedSlug, normSpecsDir, stripFrontmatter, specAbstract, implementsRefs, supersedesRef, openSpecPr, revisionPlan, publishedBody, publishedHash, publicSpecs, attestedApprovers, mergePr, renderDigest, emailFooter, profileEmail, resolveRecipients, signToken, verifyToken } = require('./server')

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
assert.deepStrictEqual(supersedesRef({ supersedes: 5 }, 'o/r'), { ns: 'o/r', n: 5 })
assert.deepStrictEqual(supersedesRef({ supersedes: '#5' }, 'o/r'), { ns: 'o/r', n: 5 })
assert.deepStrictEqual(supersedesRef({ supersedes: 'a/b#12' }, 'o/r'), { ns: 'a/b', n: 12 })
// a note shortid (PR-less spec) resolves by id, not number
assert.deepStrictEqual(supersedesRef({ supersedes: 'rBk2X-Y_z' }, 'o/r'), { noteId: 'rBk2X-Y_z' })
assert.strictEqual(supersedesRef({}, 'o/r'), null)
assert.strictEqual(supersedesRef({ supersedes: '' }, 'o/r'), null)
assert.strictEqual(supersedesRef({ supersedes: 'a b' }, 'o/r'), null) // spaces are not a valid ref
// specsFromRows surfaces the parsed link on the spec
assert.deepStrictEqual(
  specsFromRows([note('---\ntags: [spec]\nnamespace: o/r\nsupersedes: a/b#3\n---\nx')])[0].supersedes,
  { ns: 'a/b', n: 3 })
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

// End-to-end of the supersede PR path: drive the real openSpecPr against a
// mocked GitHub API and assert it opens the replacement PR with a Supersedes
// line and stamps the "Superseded by" banner into the replaced spec.md.
;(async () => {
  const calls = []
  let branchRefs = [] // live heads served by the matching-refs mock, per scenario
  let headPulls = [] // PRs already on the branch being pushed, per scenario
  const ok = obj => ({ ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) })
  const notFound = () => ({ ok: false, status: 404, json: async () => ({}), text: async () => 'not found' })
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
    if (method === 'GET' && /\/contents\/(?:[\w-]+\/)*\d+-[^/]+\.md\?/.test(path)) return notFound()
    if (method === 'PUT' && /\/contents\/(?:[\w-]+\/)*\d+-[^/]+\.md$/.test(path)) return ok({})
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
    supersedes: { ns: 'o/r', n: 12 },
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

  console.log('ok')
})().catch(e => { console.error(e); process.exit(1) })
