const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Pool } = require('pg')
const yaml = require('js-yaml')
const { implementsRefs, specRef } = require('./refs')
const { esc, wordDiff, requirementMap, requirementDelta, diffHtml, diffText } = require('./prosediff')
const { createFeedbackStore } = require('./feedback-store')
const { createFeedbackService } = require('./feedback-service')
const { createRoadmapStore } = require('./roadmap-store')
const { createRoadmapService } = require('./roadmap-service')
const { filterSpecs: filterPlanningSpecs, decorateSpecs: decoratePlanningSpecs, fail: roadmapError } = require('./roadmap')
const { scanCritic, resolveCritic, commentAnchorHash, SUGGESTION_TYPES } = require('./critic-markup')
const { event: digestEvent, discussionState, discussionEvents, recipientDetails, renderDigest } = require('./notifications')
const { migrateNotifications, visibleNotifications, insertNotifications } = require('./notification-store')
const { createEditorClient, contentHash } = require('./editor-client')
const { createLifecycle } = require('./lifecycle')
const { publicationGuard } = require('./schema-guard')
const { numericConfig } = require('./config')
const { createHealthState } = require('./health-state')
const { createNotificationDelivery } = require('./notification-delivery')
const { createPublicationRecovery } = require('./publication-recovery')
const { claimPublication, completePublication } = require('./publication-state')
const { createImplementationScanner, cursorKey: implementationCursorKey } = require('./implementation-scan')

const BASE_URL = process.env.HEDGEDOC_BASE_URL || 'http://localhost:3000'
const SPEC_TAG = (process.env.SPEC_TAG || 'spec').toLowerCase()
const { port: PORT, staleDays: STALE_DAYS, pollSeconds: POLL_SECONDS, fetchTimeoutMs: FETCH_TIMEOUT_MS,
  trustedProxies: TRUSTED_PROXIES, reviewIdleMinutes: REVIEW_IDLE_MINUTES, overlapMaxBytes: OVERLAP_MAX_BYTES,
  emailDebounceMinutes: EMAIL_DEBOUNCE_MINUTES, smtpPort: SMTP_PORT } = numericConfig()
const WEBHOOK_URL = process.env.WEBHOOK_URL
// Namespaces are target spec repos ("owner/name"); every spec belongs to
// exactly one.
const NAMESPACES = (process.env.NAMESPACES || '')
  .split(',').map(s => s.trim()).filter(Boolean)
const DEFAULT_NAMESPACE = process.env.DEFAULT_NAMESPACE || NAMESPACES[0] || ''
const GITHUB_TOKEN = process.env.GITHUB_TOKEN // service token: roles, scans, PR fallback
// GitHub App auth. When APP_ID + PRIVATE_KEY are set, service calls to a repo
// the app is installed on use a short-lived installation token minted per
// namespace; GITHUB_TOKEN stays the fallback for repos the app does not cover.
const GITHUB_APP_ID = process.env.GITHUB_APP_ID
const GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY
if (!!GITHUB_APP_ID !== !!GITHUB_APP_PRIVATE_KEY) console.warn('github app auth disabled: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY must both be set')
const githubEnabled = !!(GITHUB_TOKEN || GITHUB_APP_ID)
const SPECS_DIR = process.env.SPECS_DIR || 'specs'
const ROLES_TTL_MS = 5 * 60 * 1000
// Review bots: OpenAI-compatible endpoints, one row each in spec_board_bots,
// scoped to their assigned namespaces. Findings are injected into the note as
// {>>@<bot>: ...<<} threads, which gate approval and resolve exactly like
// human comments.
// Quiet time avoids reviewing unfinished sentences; the editor separately
// reserves inactive notes before accepting a bot's replacement.
const settled = spec => Date.now() - new Date(spec.changed).getTime() >= REVIEW_IDLE_MINUTES * 60000
// A large model on modest GPUs takes minutes, not the 15s every other
// outbound call gets.
const REVIEW_TIMEOUT_MS = 120000
const REVIEW_MAX_CHARS = 24000 // with the context below, fits an 8k-ctx model with room left for the reply
const REVIEW_CONTEXT_MAX_CHARS = 12000 // the namespace's top-level specs, sent alongside every review
const REVIEW_MAX_COMMENTS = 10 // schema maxItems, re-enforced by a hard slice
const REVIEWS_PER_TICK = 4 // bounds tick wall-time at 4 x REVIEW_TIMEOUT_MS
// The overlap pass sends the whole corpus in one message, so its budget is the
// context, not the spec count. Operator-tunable: a 128k-ctx model can take far
// more than the 8k one REVIEW_MAX_CHARS is sized for.
const OVERLAP_MAX_FINDINGS = 20 // schema maxItems, re-enforced by a hard slice

// Public origin of the board itself, for links in email (which has no request
// to derive it from). HEDGEDOC_BASE_URL points at HedgeDoc, not here.
const SPEC_BOARD_BASE_URL = (process.env.SPEC_BOARD_BASE_URL || '').replace(/\/$/, '')
const SESSION_SECRET = process.env.SESSION_SECRET
// Shared with the editor, which signs the identity assertion its approve
// button sends here. Unset: the approval route answers 503.
const EDITOR_SECRET = process.env.EDITOR_SECRET
const lifecycle = createLifecycle()
const health = createHealthState()
health.observe('implementationScan', { enabled: githubEnabled, pending: 0, oldestPendingAt: null })
let publicationSchema = { ready: false, reason: 'Publication identity guard has not been checked' }
let leadership = null
function assertWorkAllowed () {
  if (lifecycle.stopping || (leadership && leadership.signal.aborted)) throw new Error('Side effects stopped while draining or after leadership loss')
}
function outboundSignal (timeout, { mutation = false } = {}) {
  assertWorkAllowed()
  if (mutation) return AbortSignal.timeout(timeout)
  return AbortSignal.any([lifecycle.signal, ...(leadership ? [leadership.signal] : []), AbortSignal.timeout(timeout)])
}
const mutateEditor = createEditorClient({ url: process.env.HEDGEDOC_INTERNAL_URL || BASE_URL, secret: EDITOR_SECRET,
  timeout: FETCH_TIMEOUT_MS, signal: timeout => outboundSignal(timeout, { mutation: true }) })

// Email digest: quiet-period debounce per recipient. Each new event resets the
// window (see flushEmails); a burst collapses into one message.
const SMTP_HOST = process.env.SMTP_HOST
const SMTP_FROM = process.env.SMTP_FROM || 'specdoc@localhost'
const EMAIL_ORG_NAME = process.env.EMAIL_ORG_NAME || 'SpecDoc'
const EMAIL_POSTAL_ADDRESS = process.env.EMAIL_POSTAL_ADDRESS || ''
const PRIVACY_URL = process.env.PRIVACY_URL || ''
// Contact for data-handling requests. Distinct from SMTP_FROM, which is the
// no-reply sender; falls back to it only when unset.
const PRIVACY_CONTACT = process.env.PRIVACY_CONTACT || SMTP_FROM
// One-click unsubscribe needs a public URL to point at and SESSION_SECRET to
// sign the token. Without both, mail cannot carry a compliant unsubscribe, so
// email stays off rather than shipping non-compliant messages.
const EMAIL_ENABLED = !!(SMTP_HOST && /^https?:\/\/.+/.test(SPEC_BOARD_BASE_URL) && SESSION_SECRET)
if (SMTP_HOST && !EMAIL_ENABLED) console.warn('email disabled: set SPEC_BOARD_BASE_URL and SESSION_SECRET to enable compliant unsubscribe')
const mailer = EMAIL_ENABLED
  ? require('nodemailer').createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    // nodemailer's defaults run to minutes; a wedged SMTP server must not
    // stall the poll loop past the same deadline every other outbound call has.
    connectionTimeout: FETCH_TIMEOUT_MS,
    greetingTimeout: FETCH_TIMEOUT_MS,
    socketTimeout: FETCH_TIMEOUT_MS
  })
  : null

// Notification settings page: GitHub OAuth login + stateless signed-cookie
// session (Node crypto, no store). Disabled unless all three are set.
const OAUTH_CLIENT_ID = process.env.BOARD_OAUTH_CLIENT_ID
const OAUTH_CLIENT_SECRET = process.env.BOARD_OAUTH_CLIENT_SECRET
const SETTINGS_ENABLED = !!(OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && SESSION_SECRET)
if ((OAUTH_CLIENT_ID || OAUTH_CLIENT_SECRET) && !SETTINGS_ENABLED) console.warn('settings disabled: set BOARD_OAUTH_CLIENT_ID, BOARD_OAUTH_CLIENT_SECRET, and SESSION_SECRET')
// GitHub logins allowed to manage review bots at /bots. Lowercased on both
// sides: GitHub logins are case-insensitive.
const BOARD_ADMINS = normList(process.env.BOARD_ADMINS).map(s => s.toLowerCase())
const BOTS_ENABLED = SETTINGS_ENABLED && BOARD_ADMINS.length > 0
const isAdmin = s => !!s && BOARD_ADMINS.includes(String(s.login).toLowerCase())
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
// Unsubscribe links must keep working on old mail, so the capability token is
// long-lived; its only power is opting an address out of digests.
const UNSUB_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000
const SUB_LEVELS = new Set(['watch', 'participating', 'disabled'])

// Ordered least -> most advanced; index doubles as precedence.
const COLUMNS = [
  { tag: 'draft', label: 'Draft' },
  { tag: 'ready-for-review', label: 'Ready for review' },
  { tag: 'in-review', label: 'In review' },
  { tag: 'approved', label: 'Approved' },
  { tag: 'implemented', label: 'Implemented' }
]
const STATUS_INDEX = new Map(COLUMNS.map((c, i) => [c.tag, i]))
const IMPLEMENTED_IDX = STATUS_INDEX.get('implemented')
const APPROVED_IDX = STATUS_INDEX.get('approved')
// GitHub's implemented mark overlays the lane unless the tag was put back
// into review: a shipped spec under re-review is under review.
const laneIdx = (s, st) => st && st.implemented_at && !REVIEW_STATUSES.has(COLUMNS[s.statusIdx].tag) ? IMPLEMENTED_IDX : s.statusIdx
const IN_REVIEW_IDX = STATUS_INDEX.get('in-review')
const READY_IDX = STATUS_INDEX.get('ready-for-review')
const REVIEW_STATUSES = new Set(['ready-for-review', 'in-review'])
// A top-level spec (frontmatter `kind: top-level`) states constraints every
// other spec in its namespace inherits: unnumbered, published at the specs-dir
// root as <slug>.md, grouped under this pseudo-area ahead of the real ones.
const TOP_AREA = 'top-level'

const pool = new Pool({
  statement_timeout: FETCH_TIMEOUT_MS,
  query_timeout: FETCH_TIMEOUT_MS,
  connectionTimeoutMillis: FETCH_TIMEOUT_MS
})
// An idle client losing its backend (DB restart, failover) emits 'error' on
// the pool; unhandled, that event kills the process. The pool already discards
// the client, so logging is the only work left.
pool.on('error', e => console.error('pg pool:', e.message))
const feedbackStore = createFeedbackStore(pool)
const roadmapStore = createRoadmapStore(pool)

// Returns { meta, end } where end is the offset of the closing delimiter, so
// callers can reuse it instead of re-scanning for the frontmatter boundary.
function frontmatter (content) {
  if (!content || !content.startsWith('---')) return { meta: {}, end: -1 }
  const end = content.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, end: -1 }
  try {
    return { meta: yaml.load(content.slice(3, end)) || {}, end }
  } catch (e) {
    return { meta: {}, end }
  }
}

function normList (value) {
  if (value == null) return []
  const raw = Array.isArray(value) ? value : String(value).split(',')
  return raw.map(v => String(v).trim()).filter(Boolean)
}

function metaTags (meta) {
  return normList(meta.tags).map(t => t.toLowerCase())
}

// hedgedoc's per-character authorship: [userId, start, end, createdAt,
// updatedAt] atoms over the document, assigned by the server from the
// session that sent each edit. Stored as a JSON string.
function parseAuthorship (raw) {
  if (Array.isArray(raw)) return raw
  try {
    const v = JSON.parse(raw || 'null')
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

// The user ids whose atoms cover [start, end). An uncovered character counts
// as nobody's (null): a span with no atoms at all, as after an authorship
// reset or an import, is unattested rather than free.
function authorsOf (authorship, start, end) {
  const ids = new Set()
  let n = 0
  for (const a of authorship) {
    if (!Array.isArray(a) || a[1] >= end || a[2] <= start) continue
    ids.add(a[0])
    n += Math.min(a[2], end) - Math.max(a[1], start)
  }
  if (n < end - start) ids.add(null)
  return ids
}

const ownSpan = (authorship, span, id) => {
  const ids = authorsOf(authorship, span.start, span.end)
  return ids.size === 1 && ids.has(id)
}

// The approvals the board recorded for each note, from the editor's button,
// replace the note's own approved-by list. That list stays on claimedBy: it
// is what the note says, shown and never acted on. recorded: note id to the
// labels of its approval rows in click order; idMap: from reviewerIdentities.
function recordedApprovals (specs, recorded, idMap) {
  for (const spec of specs) {
    spec.claimedBy = spec.approvedBy
    spec.approvedBy = recorded.get(spec.id) || []
    spec.approverUsers = new Map()
    for (const login of spec.approvedBy) {
      const u = idMap.get(login.toLowerCase())
      if (u) spec.approverUsers.set(login.toLowerCase(), u)
    }
  }
  return specs
}

// Fenced-code spans as { ranges: [from, to)[], open } where open is the
// offset of a trailing unclosed fence (-1 when balanced), so comment counting
// and anchoring skip {>>...<<} that markdown-it never renders.
function fenceRanges (text) {
  const ranges = []
  let open = -1
  let offset = 0
  for (const line of text.split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      if (open === -1) open = offset
      else { ranges.push([open, offset + line.length]); open = -1 }
    }
    offset += line.length + 1
  }
  if (open !== -1) ranges.push([open, text.length])
  return { ranges, open }
}

// One comment span; tempered so a nested {>> can't be swallowed. Factory, not
// a shared const: the g flag carries lastIndex state across exec calls.
const commentRe = () => /\{>>((?:(?!\{>>)[\s\S])*?)<<\}/g

function countCommentThreads (text) {
  return scanCritic(text).filter(span => span.type === 'comment' && !span.resolved && span.messages.length).length
}

function countSuggestions (text) {
  return scanCritic(text).filter(span => SUGGESTION_TYPES.includes(span.type)).length
}

// Use the editor's parser so literal examples and resolved threads consume no
// anchor ordinal in notification links.
function threadAnchors (text) {
  const seen = {}
  const out = []
  for (const span of scanCritic(text)) {
    if (span.type !== 'comment' || span.resolved || !span.messages.length) continue
    const { author, text: body } = span.messages[0]
    const hash = commentAnchorHash(author, body)
    const nth = (seen[hash] = (seen[hash] || 0) + 1)
    out.push({ author, text: body, id: 'comment-' + hash + (nth > 1 ? '-' + nth : '') })
  }
  return out
}

// Display name / GitHub token from a HedgeDoc Users row.
function parseProfile (profileJson) {
  if (!profileJson) return {}
  try {
    return JSON.parse(profileJson) || {}
  } catch (e) {
    return {}
  }
}

function profileName (profileJson) {
  const p = parseProfile(profileJson)
  return p.username || p.displayName || ''
}

// Mirrors HedgeDoc's own Note.encodeNoteId. A note with no alias is addressed
// by this in its URL.
function encodeNoteId (id) {
  const hex = String(id).replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(hex)) return null
  return Buffer.from(hex, 'hex').toString('base64url')
}

function specsFromRows (rows, state = new Map()) {
  const specs = []
  for (const r of rows) {
    const { meta } = frontmatter(r.content)
    const tags = metaTags(meta)
    if (!tags.includes(SPEC_TAG)) continue
    // ponytail: right-most (most advanced) status tag wins; no status -> Draft.
    // Revisit if a spec legitimately needs parallel statuses.
    let idx = 0
    for (const t of tags) if (STATUS_INDEX.has(t)) idx = Math.max(idx, STATUS_INDEX.get(t))
    // First comment thread means review has started: advance the effective
    // status. The note's tag is never rewritten (content lives in HedgeDoc's
    // server memory); this is computed, so resolving all threads reverts it.
    const comments = countCommentThreads(r.content)
    const suggestions = countSuggestions(r.content)
    if (idx === READY_IDX && comments > 0) idx = IN_REVIEW_IDX
    const ownerProfile = parseProfile(r.owner_profile)
    const author = ownerProfile.username || ownerProfile.displayName || (meta.owner && String(meta.owner)) || ''
    // Owner's HedgeDoc display name (empty for non-GitHub accounts); the git
    // author name falls back to the GitHub login's real name when this is blank.
    const authorDisplayName = ownerProfile.displayName || ''
    const declaredNamespace = meta.namespace ? String(meta.namespace).trim() : DEFAULT_NAMESPACE
    const pinned = state.get(r.shortid)
    const namespace = pinned && pinned.pr_number && pinned.namespace ? pinned.namespace : declaredNamespace
    specs.push({
      id: r.shortid,
      // The editor addresses a note by the segment its URL carries: the alias if
      // it has one, else the encoded uuid (lib/web/note/util.js). Neither is the
      // shortid we key on.
      alias: r.alias || null,
      urlId: encodeNoteId(r.id),
      title: r.title || r.shortid,
      url: `${BASE_URL}/${r.alias || r.shortid}`,
      changed: r.lastchangeAt,
      statusIdx: idx,
      author,
      authorDisplayName,
      ownerId: r.owner_id || null,
      // Git author address, from HedgeDoc's own record of the note owner.
      authorEmail: userEmail({ email: r.owner_email, profile: r.owner_profile }),
      authorLogin: String(meta.owner || ownerProfile.username || '').toLowerCase(),
      editor: profileName(r.editor_profile),
      comments,
      suggestions,
      permission: r.permission,
      namespace,
      validNamespace: NAMESPACES.includes(namespace),
      tags,
      area: meta.area ? String(meta.area).trim().toLowerCase() : '',
      topLevel: String(meta.kind || '').trim().toLowerCase() === TOP_AREA,
      approvedBy: normList(meta['approved-by']),
      authorship: parseAuthorship(r.authorship),
      // Single-valued; chains form across notes.
      supersedes: specRef(meta.supersedes, namespace),
      dependsOn: dependsOnRefs(meta, namespace, r.shortid),
      // Derived once per poll rather than per request: /map and /api/specs are
      // unauthenticated, and openSpecPr hands these same objects to the map it
      // commits, so both paths need it.
      abstract: specAbstract(stripFrontmatter(resolveCritic(r.content))),
      // PR-as-author: only a GitHub OAuth token can act on github.com, and
      // only one carrying repo scope, which the editor login does not ask for.
      // pushSpecPr falls back to the service token when it fails.
      ownerToken: ownerProfile.provider === 'github' ? (r.owner_token || null) : null,
      content: r.content
    })
  }
  return specs
}

// Who may approve comes only from the namespace repo's .specs/roles.yml
// (branch-protected), never the editable note. approvals-required of the list.
function applyRoles (spec, roles) {
  spec.rolesUnknown = roles === undefined
  roles = roles || null
  const approvers = normList(roles && roles.approvers)
  // Explicit approvals-required: 0 is respected (quorum off); missing or
  // malformed values default to 1.
  const reqRaw = Number(roles && roles['approvals-required'])
  const required = Math.min(approvers.length, Number.isInteger(reqRaw) && reqRaw >= 0 ? reqRaw : 1)
  spec.approvers = approvers
  spec.required = required
  countApprovals(spec)
  // The matched area becomes the spec PR's subdir. A declared areas list
  // (`categories` is the legacy key) is an optional allowlist and the only
  // thing that lets note tags route (any tag as a dir would include status
  // tags). Without one, an explicit `area:` routes as its slug. Either way
  // the value lands in git paths and refs, so it is slug- or charset-bound.
  const declared = normList(roles && (roles.areas ?? roles.categories))
  const areas = declared.map(c => c.toLowerCase()).filter(c => /^[\w.-]+$/.test(c))
  spec.category = spec.topLevel
    ? ''
    : declared.length
      ? (areas.includes(spec.area) ? spec.area : '') || spec.tags.find(t => areas.includes(t)) || ''
      : (spec.area ? slug(spec.area) : '')
  spec.roles = roles || null
  return spec
}

// Server-side gate on PR creation: the "approved" status tag is editable by
// anyone with note edit rights, so a governed spec must actually meet its
// approval bar before a PR is opened. Ungoverned specs (no approvers in the
// note or the namespace's roles.yml) fall back to the tag; branch protection
// on the repo is their real gate.
// approvals and the missing approvers from approvedBy against the roster;
// rerun when an approval lands between ticks.
function countApprovals (spec) {
  const approved = new Set(spec.approvedBy.map(a => a.toLowerCase()))
  spec.approvals = spec.approvers.filter(a => approved.has(a.toLowerCase())).length
  spec.missingApprovers = spec.approvers.filter(a => !approved.has(a.toLowerCase()))
}

function quorumMet (spec) {
  if (spec.rolesUnknown) return false
  return spec.required === 0 || spec.approvals >= spec.required
}

// A spec only counts as approved once quorum is met, every CriticMarkup comment
// thread is resolved (Resolve button, or deleting {>>...<<} from the note), and
// every suggestion is accepted or rejected. Both kinds of markup are published
// by resolveCritic rather than blocking it, so this is what keeps unreviewed
// edits out of the PR.
function canApprove (spec) {
  return spec.comments === 0 && spec.suggestions === 0 && quorumMet(spec)
}


function relTime (date) {
  if (!date) return ''
  const sec = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  const units = [[86400, 'd'], [3600, 'h'], [60, 'm']]
  for (const [s, u] of units) if (sec >= s) return `${Math.floor(sec / s)}${u} ago`
  return 'just now'
}

function buildBoard (specs, state) {
  const buckets = COLUMNS.map(() => [])
  for (const s of specs) {
    const st = state.get(s.id)
    // A spec retired by a replacement is tracked for history but never shown.
    if (st && st.superseded_at) continue
    // GitHub is source of truth for "implemented"; overlay it so nobody has
    // to write HedgeDoc's tables (live notes are held in server memory). The
    // Implemented lane is hidden by default (render toggles it) so replacing a
    // shipped spec stays reachable without cluttering the board.
    const idx = laneIdx(s, st)
    const ageDays = (Date.now() - new Date(s.changed).getTime()) / 86400000
    buckets[idx].push({
      ...s,
      pr: st && st.pr_number,
      prState: (st && st.pr_state) || 'open',
      revPr: st && st.revision_pr,
      revision: st && st.revision,
      stale: REVIEW_STATUSES.has(COLUMNS[idx].tag) && ageDays > STALE_DAYS
    })
  }
  for (const b of buckets) b.sort((a, c) => new Date(c.changed) - new Date(a.changed))
  return buckets
}

// Note ids keyed by the "<namespace>#<pr>" reference specs cite each other by.
// Unfiltered: a retired or shipped spec is still a legitimate target.
function refIndex (state) {
  const index = new Map()
  for (const [id, s] of state) {
    if (s.pr_number && s.namespace) index.set(`${s.namespace}#${s.pr_number}`, id)
  }
  return index
}

const prUrl = (ns, n) => `https://github.com/${ns}/pull/${n}`

// The system as its specs describe it: approved and implemented only, so the
// picture stays still while work is in flight (the board covers that).
// A top-level spec is cited by its file name, never a number. The recorded
// path wins once the spec has published, so a later title edit does not
// relabel it; before that the title's slug is what openSpecPr will use.
function topSlug (s, st) {
  if (!s.topLevel) return null
  return st.spec_path ? st.spec_path.replace(/^.*\//, '').replace(/\.md$/, '') : numberedSlug(s.title).slug
}

function specGraph (specs, state) {
  const index = refIndex(state)
  const byId = new Map(specs.map(s => [s.id, s]))
  const resolve = ref => (ref.noteId
    ? (byId.has(ref.noteId) ? ref.noteId : null)
    : index.get(`${ref.ns}#${ref.n}`)) || null
  // An unresolvable ref still renders, so a typo is visible to its author
  // instead of silently vanishing from the map.
  const brief = (id, ref) => {
    const s = id && byId.get(id)
    if (!s) return { id: null, ns: (ref && ref.ns) || null, n: (ref && ref.n) || null, title: '', url: '' }
    const st = state.get(id) || {}
    const n = st.pr_number || null
    return { id, ns: s.namespace, n, slug: topSlug(s, st), title: s.title, url: n ? prUrl(s.namespace, n) : s.url }
  }

  const nodes = []
  for (const s of specs) {
    const st = state.get(s.id) || {}
    if (st.superseded_at) continue
    if (laneIdx(s, st) < APPROVED_IDX) continue
    // The visited set is what terminates the chain: two notes can name each other.
    const retired = []
    const seen = new Set([s.id])
    for (let cur = s; cur && cur.supersedes;) {
      const id = resolve(cur.supersedes)
      if (!id || seen.has(id)) break
      seen.add(id)
      retired.push(brief(id, cur.supersedes))
      cur = byId.get(id)
    }
    nodes.push({
      id: s.id,
      ns: s.namespace,
      n: st.pr_number || null,
      slug: topSlug(s, st),
      area: s.topLevel ? TOP_AREA : (s.category || ''),
      title: s.title,
      url: st.pr_number ? prUrl(s.namespace, st.pr_number) : s.url,
      status: laneIdx(s, st) === IMPLEMENTED_IDX ? 'implemented' : 'approved',
      abstract: s.abstract,
      retired,
      dependsOn: [],
      neededBy: []
    })
  }

  const nodeById = new Map(nodes.map(n => [n.id, n]))
  for (const node of nodes) {
    for (const ref of byId.get(node.id).dependsOn) {
      const id = resolve(ref)
      // Self-reference by number: only resolvable now that the note's own PR
      // number is in hand.
      if (id && id === node.id) continue
      node.dependsOn.push(brief(id, ref))
      const target = id && nodeById.get(id)
      if (target) target.neededBy.push(brief(node.id))
    }
  }

  // Top-level specs lead their namespace: the overlap corpus reads in this
  // order and the constraints should precede what they constrain.
  nodes.sort((a, b) =>
    a.ns.localeCompare(b.ns) || (b.area === TOP_AREA) - (a.area === TOP_AREA) ||
    a.area.localeCompare(b.area) || (a.n || 0) - (b.n || 0))
  return nodes
}

const findSpec = (specs, id) => specs.find(x => x.id === id || x.alias === id || x.urlId === id) || null

const refLabel = ref => ref.noteId || `${ref.ns}#${ref.n}`

const specStatus = (s, st) => COLUMNS[laneIdx(s, st)].tag

// An allowlist: the spec object also carries the note body, the author's git
// email and the namespace's roles.yml, none of which belong in a response.
function specSummary (s, state) {
  const st = state.get(s.id) || {}
  return {
    id: s.id,
    urlId: s.urlId,
    alias: s.alias,
    title: s.title,
    url: s.url,
    status: specStatus(s, st),
    area: s.category || '',
    kind: s.topLevel ? TOP_AREA : 'feature',
    namespace: s.namespace,
    tags: s.tags,
    author: s.authorLogin || s.author || '',
    changed: s.changed,
    comments: s.comments,
    suggestions: s.suggestions,
    pr: st.pr_number || null,
    prState: st.pr_state || null,
    specPath: st.spec_path || null,
    // The board hides a retired spec; the api serves it with a flag instead, so
    // a client pulling the corpus can tell it apart from a live one.
    superseded: !!st.superseded_at,
    abstract: s.abstract || '',
    // The graph resolves references only for approved specs, and a draft's are
    // the ones worth reading.
    dependsOn: s.dependsOn.map(refLabel),
    milestone: s.milestone ? { id: s.milestone.id, title: s.milestone.title, dueDate: s.milestone.dueDate, state: s.milestone.state } : null,
    implementers: (s.implementers || []).map(u => ({ id: u.id, login: u.login, name: u.name })),
    supersedes: s.supersedes ? refLabel(s.supersedes) : null
  }
}

// Ordered so a client diffing two pulls sees no churn.
// Note ID breaks ties between unnumbered specs with the same title.
const bySpecOrder = (a, b) =>
  a.namespace.localeCompare(b.namespace) ||
  (a.pr === b.pr ? 0 : a.pr == null ? 1 : b.pr == null ? -1 : a.pr - b.pr) ||
  a.title.localeCompare(b.title) || (b.id == null ? 0 : String(a.id || '').localeCompare(b.id))

function specList (specs, state, { ns, status } = {}) {
  return specs
    .filter(s => !ns || s.namespace === ns)
    .filter(s => !status || specStatus(s, state.get(s.id) || {}) === status)
    .map(s => specSummary(s, state))
    .sort(bySpecOrder)
}

// A cursor carries the sort key of the last row a client saw, not an index, so
// a spec added or retired between pages cannot make a pull skip or repeat one.
const encodeCursor = r => Buffer.from(JSON.stringify([r.namespace, r.pr, r.title, r.id || ''])).toString('base64url')

function decodeCursor (raw) {
  try {
    const values = JSON.parse(Buffer.from(raw, 'base64url').toString())
    if (!Array.isArray(values) || ![3, 4].includes(values.length)) return null
    const [namespace, pr, title, id] = values
    if (typeof namespace !== 'string' || typeof title !== 'string') return null
    if (pr !== null && !Number.isInteger(pr)) return null
    if (values.length === 4 && typeof id !== 'string') return null
    return { namespace, pr, title, id }
  } catch (e) { return null }
}

function specPage (rows, limit, cursor) {
  const at = cursor ? rows.findIndex(r => bySpecOrder(r, cursor) > 0) : 0
  const start = at === -1 ? rows.length : at
  const specs = rows.slice(start, start + limit)
  return {
    specs,
    next: start + specs.length < rows.length ? encodeCursor(specs[specs.length - 1]) : null
  }
}

// What the editor cannot work out from a note's frontmatter: the effective area
// (roles.yml can route an undeclared one to a tag, or to nowhere), the phase
// once an implements-commit has moved it, and the spec's number.
function noteRecord (id, specs, state) {
  const s = findSpec(specs, id)
  if (!s) return null
  const st = state.get(s.id) || {}
  return {
    status: specStatus(s, st),
    area: s.category || '',
    namespace: s.namespace,
    pr: st.pr_number || null,
    prState: st.pr_state || null,
    // The recorded approvals. The editor's roster reads these so it agrees
    // with what the board will act on; the note's own list is display.
    approvedBy: s.approvedBy,
    approvals: s.approvals,
    required: s.required,
    // Approvers whose approval the text has moved past, and where to see it.
    stale: s.staleApprovals || [],
    changesUrl: `/changes/${s.id}`
  }
}

// Where "<namespace>#<n>" should send a reader: the note, which is the
// reviewable copy, falling back to the PR so an unpublished spec still resolves.
// The namespace has to be on the allowlist, or this is an open redirector to any
// github.com/*/pull/*, since the caller picks the whole path.
function specRefTarget (ns, n, specs, state) {
  if (!NAMESPACES.includes(ns)) return null
  const id = refIndex(state).get(`${ns}#${n}`)
  // specs is the public-filtered snapshot, so a note guests cannot read falls
  // through to the PR rather than leaking its URL.
  const spec = id && specs.find(s => s.id === id)
  return spec ? spec.url : prUrl(ns, n)
}

// Top-level specs come first, unfiled ones (under '') last, in both renderers.
function byArea (nodes) {
  const areas = new Map()
  for (const n of nodes) {
    if (!areas.has(n.area)) areas.set(n.area, [])
    areas.get(n.area).push(n)
  }
  const rank = a => (a === TOP_AREA ? 0 : a ? 1 : 2)
  return [...areas].sort((a, b) => rank(a[0]) - rank(b[0]))
}

const specNum = n => (n == null ? '???' : String(n).padStart(3, '0'))
// How a node is printed: a top-level spec by its file name, anything else by
// its zero-padded number.
const specLabel = n => n.slug || specNum(n.n)

// Mermaid node ids have to be bare identifiers, and its labels read '#' as the
// start of an entity code, so neither can carry the "owner/repo#12" spelling.
const mermaidId = (ns, n) => 'n' + `${ns}_${n}`.replace(/\W/g, '_')
const mermaidLabel = s => `"${String(s).replace(/"/g, '#quot;').replace(/\s+/g, ' ').trim()}"`

// The map as a spec repo can serve it: GitHub renders mermaid in markdown, so
// this needs no runtime anywhere. Only spec metadata that the merged spec files
// and their PRs already publish, so it adds no disclosure of its own.
function mermaidMap (nodes, ns) {
  // Numbered specs only. This file is committed to the namespace repo, and a
  // spec with no PR number has no file there to describe; drawing it would put
  // the title of a note the board may not even show guests into a public repo.
  const mine = nodes.filter(n => n.ns === ns && n.n)
  const lines = ['```mermaid', 'flowchart LR']
  const drawn = new Set()
  const box = (r, title) => `${mermaidId(r.ns, r.n)}[${mermaidLabel(`${specLabel(r)} ${title}`)}]`
  // A box drawn only because an edge points at it lands outside every subgraph,
  // which is why edges are held back until the areas are closed.
  const ensure = r => {
    const id = mermaidId(r.ns, r.n)
    if (!drawn.has(id)) { drawn.add(id); lines.push(`  ${box(r, r.title || 'unknown')}`) }
    return id
  }
  for (const [area, group] of byArea(mine)) {
    const indent = area ? '    ' : '  '
    const body = group.map(n => { drawn.add(mermaidId(n.ns, n.n)); return indent + box(n, n.title) })
    if (area) lines.push(`  subgraph area_${area.replace(/\W/g, '_')}[${mermaidLabel(area)}]`, ...body, '  end')
    else lines.push(...body)
  }
  const retired = new Set()
  const edges = []
  for (const n of mine) {
    const from = mermaidId(n.ns, n.n)
    for (const d of n.dependsOn) {
      if (d.n) edges.push(`  ${from} --> ${ensure(d)}`)
    }
    // Only the spec directly replaced: the rest of the chain is history, and
    // drawing all of it buries the current shape under retired boxes.
    const [old] = n.retired
    if (old && old.n) {
      const to = ensure(old)
      retired.add(to)
      edges.push(`  ${from} -.->|supersedes| ${to}`)
    }
  }
  lines.push(...edges)
  if (retired.size) {
    lines.push('  classDef retired stroke-dasharray:4 3,color:#888')
    lines.push(`  class ${[...retired].join(',')} retired`)
  }
  lines.push('```')

  // A title is note-authored and can hold newlines and backticks, which would
  // end the row (and the fence) and leave the rest as markdown in the repo.
  const cell = s => String(s).replace(/\s+/g, ' ').replace(/([|`\\])/g, '\\$1').trim()
  const rows = mine.map(n =>
    `| ${specLabel(n)} | ${cell(n.title)} | ${cell(n.area || '')} | ${n.status} | [#${n.n}](${prUrl(n.ns, n.n)}) |`)
  return [
    `# ${ns} specs`,
    '',
    'Edit the notes, not this file.',
    '',
    mine.length ? lines.join('\n') : '_No approved specs yet._',
    '',
    ...(mine.length ? ['| spec | title | area | status | pr |', '| --- | --- | --- | --- | --- |', ...rows, ''] : [])
  ].join('\n')
}

const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A checkpoint is a git tag on the namespace repo marking a tree whose spec
// corpus is internally consistent. Sequential per namespace, prefixed so it
// never collides with the repo's own release tags.
const CHECKPOINT_RE = /^refs\/tags\/(specs\/v(\d+))$/

// Accepts matching-refs rows or bare ref strings. Gaps and non-numeric tags are
// ignored: the next number is always highest + 1, never a hole refilled.
function checkpointTags (refs) {
  let latest = null
  for (const r of refs || []) {
    const m = CHECKPOINT_RE.exec(String(r && r.ref != null ? r.ref : r))
    if (!m) continue
    const n = Number(m[2])
    if (!latest || n > latest.n) latest = { tag: m[1], n, sha: (r && r.object && r.object.sha) || null }
  }
  return { latest, next: `specs/v${(latest ? latest.n : 0) + 1}` }
}

// Spec files as the publisher writes them, plus the legacy NNN-slug/spec.md
// layout that specPathFromPr and stampSuperseded still match.
const specFileRe = dir => new RegExp(`^${reEsc(dir)}/(?:[^/]+/)?\\d+-[^/]+(?:\\.md|/spec\\.md)$`)

const SUPERSEDE_BANNER = /^> \*\*Superseded by /

// Why a corpus is not yet a known-good state. Consistency, not completeness: a
// spec still in review is not a blocker, it lands in the next checkpoint. Pure
// over prepared inputs (paths and file contents fetched by checkpointState) so
// it tests without a network.
function checkpointBlockers ({ ns, specsDir, nodes, specs, state, paths, committedMap, banners, orphans = true }) {
  const out = []
  const push = (kind, o) => out.push({ kind, ns, ...o })
  const mine = nodes.filter(n => n.ns === ns)

  // Resolved off the declared refs rather than the graph: specGraph drops an
  // unresolvable supersedes when it stops walking the chain, and a dangling one
  // is exactly what this has to catch. A ref that reaches a state row whose note
  // is gone still points at a real merged spec, so it is not dangling.
  const byId = new Map((specs || []).map(s => [s.id, s]))
  const index = refIndex(state)
  const resolve = ref => (ref.noteId
    ? ((byId.has(ref.noteId) || state.has(ref.noteId)) ? ref.noteId : null)
    : index.get(`${ref.ns}#${ref.n}`)) || null

  for (const n of mine) {
    const spec = byId.get(n.id)
    if (!spec) continue
    for (const ref of spec.dependsOn) {
      const id = resolve(ref)
      if (!id) push('unresolved-ref', { n: n.n, detail: `depends-on ${refLabel(ref)}, which matches no spec` })
      else if ((state.get(id) || {}).superseded_at) {
        push('stale-dep', { n: n.n, detail: `depends-on ${refLabel(ref)}, which has been superseded` })
      }
    }
    if (spec.supersedes && !resolve(spec.supersedes)) {
      push('unresolved-ref', { n: n.n, detail: `supersedes ${refLabel(spec.supersedes)}, which matches no spec` })
    }
  }

  const claimed = new Set()
  for (const [, st] of state) {
    if (st.namespace !== ns) continue
    if (st.spec_path) claimed.add(st.spec_path)
    if (!st.spec_path) continue
    if (st.superseded_at) {
      // stampSuperseded is best-effort and skips cross-repo and not-yet-merged
      // targets, so a retired spec can sit in the tree still reading live.
      if (paths.has(st.spec_path) && !banners.get(st.spec_path)) {
        push('unstamped-supersede', { n: st.pr_number, path: st.spec_path, detail: 'retired, but its file carries no "Superseded by" banner' })
      }
    } else if (st.pr_state === 'merged' && !paths.has(st.spec_path)) {
      push('missing-file', { n: st.pr_number, path: st.spec_path, detail: 'published, but the file is not in the tree' })
    }
  }

  // No map and no numbering convention at the repo apex, where README.md is the
  // project's own and every top-level file would read as a stray spec.
  if (specsDir) {
    const re = specFileRe(specsDir)
    // orphans off: at least one published spec's path is unknown, so a file
    // with no claim on it may well be that spec's.
    if (orphans) {
      for (const p of paths) {
        if (re.test(p) && !claimed.has(p)) push('orphan-file', { path: p, detail: 'no spec note claims this file' })
      }
    }
    const fresh = mermaidMap(nodes, ns)
    if ((committedMap || '') !== fresh) {
      push('stale-map', { path: `${specsDir}/README.md`, detail: 'the committed map no longer matches the graph' })
    }
  }
  return out
}

// The corpus as one prompt, in graph order. Bounded by bytes, not spec count: a
// checkpoint of 60 short specs is cheaper to judge than one of 10 long ones.
// `skipped` is what the budget left out, so the page can name it.
function overlapCorpus (nodes, bodyOf, limit = OVERLAP_MAX_BYTES) {
  const parts = []
  const skipped = []
  let size = 0
  for (const n of nodes) {
    const body = String(bodyOf(n.id) || '').trim()
    const block = `### spec ${specNum(n.n)}: ${n.title}\narea: ${n.area || 'unfiled'}\n\n${body}\n`
    if (size + block.length > limit) {
      // The first spec still goes in, truncated: an empty corpus would have the
      // model report on nothing at all.
      if (parts.length) { skipped.push(n.n); continue }
      parts.push(block.slice(0, limit))
      size = limit
      continue
    }
    parts.push(block)
    size += block.length
  }
  return { text: parts.join('\n'), skipped }
}

// A pair whose relation is already declared is not a finding: supersedes and
// depends-on are how overlap gets resolved, so reporting them back trains the
// reader to ignore the list.
function parseOverlap (findings, nodes) {
  const byNum = new Map(nodes.filter(n => n.n).map(n => [n.n, n]))
  const declared = new Set()
  for (const n of nodes) {
    for (const r of [...n.dependsOn, ...n.retired]) {
      if (r.n) declared.add([n.n, r.n].sort((x, y) => x - y).join(':'))
    }
  }
  const out = []
  const seen = new Set()
  for (const f of findings || []) {
    const a = Number(f && f.a)
    const b = Number(f && f.b)
    if (!byNum.has(a) || !byNum.has(b) || a === b) continue
    const key = [a, b].sort((x, y) => x - y).join(':')
    if (declared.has(key) || seen.has(key)) continue
    seen.add(key)
    // The model answers in numbers; a top-level spec is reported by its name.
    const label = n => byNum.get(n).slug || n
    out.push({ a: label(a), b: label(b), why: String(f.why || '').replace(/\s+/g, ' ').trim().slice(0, 300) })
  }
  return out
}

function render (buckets, q, ns, planning = {}) {
  const icon = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`
  const chevron = icon('<path d="m8 10 4 4 4-4"/>')
  const searchIcon = icon('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>')
  const more = icon('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>')
  const total = buckets.reduce((n, cards, i) => n + (i === IMPLEMENTED_IDX ? 0 : cards.length), 0)
  const cols = COLUMNS.map((col, i) => {
    const reviewing = i >= IN_REVIEW_IDX
    const cards = buckets[i].map(c => {
      const met = quorumMet(c)
      const approval = !reviewing ? '' : c.rolesUnknown
        ? '<span class="badge warning">Reviewers unavailable</span>'
        : c.required === 0
          ? '<span class="badge">No approvals required</span>'
          : `<span class="badge approvals${met ? ' success' : ''}" title="${esc(met ? 'Approval requirement met' : 'Waiting on: ' + c.missingApprovers.join(', '))}">${c.approvals}/${c.required} approved</span>`
      const tags = [
        c.namespace && (!ns || !c.validNamespace) && `<span class="ns${c.validNamespace ? '' : ' ns-bad'}" title="${esc(c.validNamespace ? 'Namespace' : 'Unknown namespace, PR flow disabled')}">${esc(c.namespace)}</span>`,
        c.topLevel ? `<span class="tag" title="Constraints every spec in the repo inherits">${TOP_AREA}</span>` : c.category && `<span class="tag">${esc(c.category)}</span>`,
        c.supersedes && `<span class="tag" title="Replaces ${esc(c.supersedes.ns)}#${c.supersedes.n}">supersedes #${c.supersedes.n}</span>`
      ].filter(Boolean).join('')
      const moved = (c.staleApprovals || []).length
      const review = [
        approval,
        c.comments > 0 && `<span class="badge${col.tag === 'approved' ? ' blocking' : ''}" title="Unresolved comment threads block approval">${c.comments} open comment${c.comments === 1 ? '' : 's'}</span>`,
        c.suggestions > 0 && `<span class="badge${col.tag === 'approved' ? ' blocking' : ''}" title="Accept or reject pending suggestions before approval">${c.suggestions} suggestion${c.suggestions === 1 ? '' : 's'}</span>`,
        c.stale && `<span class="badge warning" title="No changes for over ${STALE_DAYS} days while awaiting review">Stale review</span>`,
        moved && `<a class="changed" href="/changes/${esc(c.id)}" title="The text changed after ${esc(c.staleApprovals.join(', '))} approved it">changed since ${moved} approval${moved === 1 ? '' : 's'}</a>`
      ].filter(Boolean).join('')
      const prLabel = c.prState === 'merged' ? `#${c.pr} merged` : c.prState === 'closed' ? `#${c.pr} closed` : `#${c.pr} open`
      const links = [
        c.pr && `<a class="pr pr-${esc(c.prState)}" href="https://github.com/${esc(c.namespace)}/pull/${c.pr}" target="_blank" rel="noopener" aria-label="Spec pull request ${esc(prLabel)}">${prLabel}</a>`,
        c.revPr && `<a class="pr" href="https://github.com/${esc(c.namespace)}/pull/${esc(c.revPr)}" target="_blank" rel="noopener" title="Revision ${esc(c.revision)} of this spec">Revision #${esc(c.revPr)}</a>`,
        c.milestone && `<a href="/roadmap?milestone=${esc(c.milestone.id)}">${esc(c.milestone.title)}</a>`,
        (c.implementers || []).length && `<span>Implementation: ${c.implementers.map(u => esc(u.login ? '@' + u.login : u.name)).join(', ')}</span>`
      ].filter(Boolean).join('')
      const actions = [
        !c.topLevel && `<a href="/roadmap?ns=${encodeURIComponent(c.namespace)}&amp;spec=${esc(c.id)}">Assign implementation</a>`,
        (c.pr || i === IMPLEMENTED_IDX) && `<a href="${esc(BASE_URL)}/new/spec?namespace=${encodeURIComponent(c.namespace)}&amp;supersedes=${encodeURIComponent(c.pr || c.id)}">Replace this spec</a>`
      ].filter(Boolean).join('')
      const reviewLogins = reviewing ? c.missingApprovers.map(a => a.toLowerCase()).join(' ') : ''
      const changed = c.changed && new Date(c.changed)
      const date = changed && Number.isFinite(changed.getTime())
        ? `<time datetime="${esc(changed.toISOString())}" title="${esc(changed.toISOString())}">${esc(relTime(c.changed))}</time>` : ''
      return `<article class="card${c.stale ? ' stale' : ''}" data-author="${esc(c.authorLogin)}" data-review="${esc(reviewLogins)}" data-reviewers="${esc(c.approvers.map(a => a.toLowerCase()).join(' '))}">
        <h3><a class="title" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a></h3>
        ${tags ? `<div class="card-tags">${tags}</div>` : ''}
        ${review ? `<div class="review-state">${review}</div>` : ''}
        ${links ? `<div class="card-links">${links}</div>` : ''}
        <div class="card-footer"><span${c.editor && c.editor !== c.author ? ` title="Last edited by ${esc(c.editor)}"` : ''}>${c.author ? esc(c.author) : 'No author'}</span>${date}</div>
        ${actions ? `<details class="card-actions"><summary aria-label="Actions for ${esc(c.title)}" title="Spec actions">${more}</summary><div class="menu">${actions}</div></details>` : ''}
      </article>`
    }).join('')
    const impl = i === IMPLEMENTED_IDX
    return `<section class="col${impl ? ' implemented' : ''}" data-status="${col.tag}" aria-labelledby="stage-${col.tag}"${impl ? ' hidden' : ''}>
      <h2 id="stage-${col.tag}"><span class="status-dot" aria-hidden="true"></span>${esc(col.label)} <span class="count">${buckets[i].length}</span></h2>
      ${cards}<p class="empty"${cards ? ' hidden' : ''}>No specs in this stage.</p>
    </section>`
  }).join('')

  const people = new Set()
  for (const bucket of buckets) for (const spec of bucket) {
    if (spec.authorLogin) people.add(spec.authorLogin)
    for (const approver of spec.approvers) people.add(approver.toLowerCase())
  }
  const personOptions = [...people].sort().map(person => `<option value="${esc(person)}">${esc(person)}</option>`).join('')
  const options = (items, current) => items.map(([value, label]) => `<option value="${esc(value)}"${value === current ? ' selected' : ''}>${esc(label)}</option>`).join('') +
    (current && !items.some(([value]) => value === current) ? `<option value="${esc(current)}" selected>${esc(current)} (unavailable)</option>` : '')
  const multiNs = NAMESPACES.length > 1
  const newSpecNs = (multiNs && ns) || DEFAULT_NAMESPACE
  const newHref = kind => {
    const params = new URLSearchParams()
    if (kind) params.set('kind', kind)
    if (newSpecNs) params.set('namespace', newSpecNs)
    return `${esc(BASE_URL)}/new/spec${params.size ? '?' + esc(params.toString()) : ''}`
  }
  const newSpec = `<details class="new"><summary${newSpecNs ? ` title="New spec in ${esc(newSpecNs)}"` : ''}>New spec ${chevron}</summary><div class="menu">
    <a href="${newHref('')}">Feature spec<small>One capability with user stories and requirements. Done when implemented.</small></a>
    <a href="${newHref('top-level')}">Top-level spec<small>Shared constraints, such as a design philosophy. Done when approved.</small></a>
  </div></details>`
  const milestoneOptions = [['', 'All milestones'], ['none', 'No milestone'], ...(planning.milestones || []).map(m => [m.id, m.title])]
  const implementerOptions = [['', 'Any implementer'], ...(planning.who ? [['me', 'Assigned to me']] : []), ['none', 'No implementer'], ...(planning.implementers || []).map(u => [u.id, u.login ? '@' + u.login : u.name])]
  const filters = new URLSearchParams()
  for (const [key, value] of Object.entries({ ns, q, milestone: planning.milestone, implementer: planning.implementer })) {
    if (value) filters.set(key, value)
  }
  const labels = {
    ns: 'Namespace: ' + ns,
    q: 'Search: ' + q,
    milestone: 'Milestone: ' + (milestoneOptions.find(([id]) => id === planning.milestone)?.[1] || planning.milestone),
    implementer: 'Implementer: ' + (implementerOptions.find(([id]) => id === planning.implementer)?.[1] || (planning.implementer === 'me' ? 'Assigned to me (sign in required)' : planning.implementer))
  }
  const activeFilters = [...filters.keys()].map(key => {
    const rest = new URLSearchParams(filters)
    rest.delete(key)
    return `<a class="filter-token" data-url-filter="${key}" href="/${rest.size ? '?' + esc(rest.toString()) : ''}" aria-label="Remove filter: ${esc(labels[key])}"><span>${esc(labels[key])}</span><span aria-hidden="true">×</span></a>`
  }).join('')

  return basicPage('Specifications', `
  <div class="page-heading">
    <div><h1>Specifications</h1><p class="context">${esc(ns || (NAMESPACES.length === 1 ? NAMESPACES[0] : 'All namespaces'))}</p></div>
    <div class="view-controls" data-enhanced hidden>
      <label class="sr-only" for="status-filter">Filter by status</label>
      <select id="status-filter"><option value="">All stages</option>${COLUMNS.map(col => `<option value="${col.tag}">${esc(col.label)}</option>`).join('')}</select>
      <div class="layout-switch" role="group" aria-label="View layout">
        <button type="button" data-layout-choice="board" aria-pressed="true">${icon('<rect x="3" y="4" width="7" height="16" rx="1"/><rect x="14" y="4" width="7" height="11" rx="1"/>')}Board</button>
        <button type="button" data-layout-choice="list" aria-pressed="false">${icon('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>')}List</button>
      </div>
    </div>
  </div>
  ${snapshotStale() ? '<div class="warn" role="status">Updates are delayed. Review and pull request information may be out of date.</div>' : ''}
  <form class="toolbar" id="board-filters" method="get" action="/" role="search">
    <div class="search">${searchIcon}<input type="search" name="q" value="${esc(q)}" placeholder="Search specifications…" aria-label="Search specifications"><button type="submit" aria-label="Search">${icon('<path d="M5 12h14m-5-5 5 5-5 5"/>')}</button></div>
    <div class="mefilters" role="group" aria-label="Match any personal filter" hidden>
      <button type="button" class="chip" data-filter="mine" aria-pressed="false">My specs</button>
      <button type="button" class="chip" data-filter="review" aria-pressed="false">To review</button>
    </div>
    <details class="filter-menu"><summary>${icon('<path d="M4 7h16M7 12h10M10 17h4"/>')}Filters ${chevron}</summary>
      <div class="filter-panel">
        ${multiNs ? `<label>Namespace<select name="ns" aria-label="Filter by namespace">${options([['', 'All namespaces'], ...NAMESPACES.map(n => [n, n])], ns)}</select></label>` : ns ? `<input type="hidden" name="ns" value="${esc(ns)}">` : ''}
        <label>Milestone<select name="milestone" aria-label="Filter by milestone">${options(milestoneOptions, planning.milestone || '')}</select></label>
        <label>Implementer<select name="implementer" aria-label="Filter by implementer">${options(implementerOptions, planning.implementer || '')}</select></label>
        <label data-enhanced hidden>Author or reviewer<select class="person" aria-label="Filter by author or reviewer"><option value="">Anyone</option>${personOptions}</select></label>
        <div class="filter-help"><p>Author, reviewer and personal shortcuts match any selected person. Other filters narrow the results.</p><button class="primary" type="submit">Apply</button></div>
      </div>
    </details>
  </form>
  <div class="active-filters"${activeFilters ? '' : ' hidden'}>${activeFilters}<span class="personal-filters"></span><a class="clear-filters" href="/" data-clear-filters>Clear filters</a></div>
  <div class="board-summary">
    <span id="result-count" role="status" tabindex="-1">${total} ${total === 1 ? 'spec' : 'specs'}</span>
    <div class="display-options" data-enhanced hidden><label><input type="checkbox" id="toggle-impl">Show implemented</label><button class="refresh" id="refresh-board" type="button">${icon('<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 6M4 12l2 6a7 7 0 0 0 12-1"/>')}Refresh</button></div>
  </div>
  <div class="board">${cols}</div>
  <div class="empty-board" id="no-matches"${!buckets.some(b => b.length) && filters.size ? '' : ' hidden'}><h2>No specs match these filters</h2><p>Try another stage, show implemented specs, or clear your filters.</p><a href="/" data-clear-filters>Clear filters</a></div>
  <div class="empty-board" id="no-specs"${!buckets.some(b => b.length) && !filters.size ? '' : ' hidden'}><h2>Your specifications start here</h2><p>Create a spec to bring an idea into review.</p><a class="button primary" href="${newHref('')}">New feature spec</a></div>
`, { page: 'board', ns, who: planning.who, actions: newSpec })
}

// Poller-only: renders are served from the snapshot, so this full scan (and
// the owner tokens it carries) never runs on the request path.
// The WHERE is a cheap superset of specsFromRows' real gate (frontmatter tags
// containing SPEC_TAG): without it every note body in the instance ships to
// the board each tick, and the whole HedgeDoc DB becomes the board's ceiling.
async function queryNotes () {
  const { rows } = await pool.query(
    `SELECT n.id, n.shortid, n.alias, n.title, n.content, n.authorship, n."lastchangeAt", n.permission,
      ou.id AS owner_id, ou.profile AS owner_profile, ou.email AS owner_email, ou."accessToken" AS owner_token, eu.profile AS editor_profile
    FROM "Notes" n
    LEFT JOIN "Users" ou ON ou.id = n."ownerId"
    LEFT JOIN "Users" eu ON eu.id = n."lastchangeuserId"
    WHERE n.content LIKE '---%' AND n.content ILIKE $1`, [`%${SPEC_TAG}%`])
  return rows
}

async function loadState () {
  const { rows } = await pool.query('SELECT note_id, status, comment_count, pr_number, implemented_at, approvals, namespace, category, pr_state, locked_at, prelock_permission, permission_intent, permission_lock_id, superseded_at, spec_path, published_hash, published_commit, publication_generation, revision, revision_pr, discussion_hashes FROM spec_board_state')
  return new Map(rows.map(r => [r.note_id, r]))
}

async function loadBots () {
  const { rows } = await pool.query('SELECT name, url, api_key, model, prompt, namespaces FROM spec_board_bots WHERE enabled')
  return rows.map(r => ({ ...r, namespaces: normList(r.namespaces) }))
}

// \0 as key separator: the bot-name charset and shortids exclude it.
const reviewKey = (noteId, botName) => noteId + '\0' + botName

// Metadata only; a body is read when a page or a PR needs that one row.
async function loadSnapshots () {
  const { rows } = await pool.query(`SELECT * FROM (
    SELECT DISTINCT ON (note_id, kind, CASE WHEN kind = 'approval' THEN lower(label) ELSE '' END)
      id, note_id, kind, label, hash, notified_hash, taken_at
    FROM spec_board_snapshots
    ORDER BY note_id, kind, CASE WHEN kind = 'approval' THEN lower(label) ELSE '' END, id DESC
  ) latest ORDER BY id`)
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.note_id)) map.set(r.note_id, [])
    map.get(r.note_id).push(r)
  }
  return map
}

// Note id to the logins with a recorded approval, in click order.
async function loadApprovals () {
  const { rows } = await pool.query("SELECT note_id, label FROM spec_board_snapshots WHERE kind = 'approval' ORDER BY id")
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.note_id)) map.set(r.note_id, [])
    map.get(r.note_id).push(r.label)
  }
  return map
}

// The newest row of a kind, optionally of one label (case-folded).
const lastRow = (rows, kind, label) => rows.filter(r => r.kind === kind && (label == null || r.label.toLowerCase() === label.toLowerCase())).pop()

// What to record this tick for one spec. A status row is skipped when the
// newest one already carries the same label and text; approval rows exist
// exactly for the approvers attested now, so a retracted approval drops its
// row and a re-approval takes a fresh one.
function snapshotPlan ({ status, prevStatus, rows, hash, publishedHash = null, revision = 0 }) {
  const inserts = []
  const last = lastRow(rows, 'status')
  if (prevStatus !== status && !(last && last.label === status && last.hash === hash)) {
    inserts.push({ kind: 'status', label: status })
  }
  // A note published before snapshots existed has no published row; while
  // its text still matches what was published, that row can be taken now.
  if (publishedHash && publishedHash === hash && !rows.some(r => r.kind === 'published' && r.hash === hash)) {
    inserts.push({ kind: 'published', label: `r${revision || 0}` })
  }
  return { inserts }
}

// Bodies live in their own table by hash: the same text at several events
// (a status change right after an approval, say) is stored once.
async function takeSnapshot (noteId, kind, label, body, hash, db = null, { insertOnly = false } = {}) {
  if (!db) return withTx(client => takeSnapshot(noteId, kind, label, body, hash, client, { insertOnly }))
  // Pin reused bodies until their reference commits; GC may run concurrently.
  await db.query('INSERT INTO spec_board_snapshot_bodies (hash, body) VALUES ($1, $2) ON CONFLICT (hash) DO UPDATE SET hash = EXCLUDED.hash', [hash, body])
  const { rows } = await db.query(
    `INSERT INTO spec_board_snapshots (note_id, kind, label, hash) VALUES ($1, $2, $3, $4)
     ON CONFLICT (note_id, kind, lower(label)) WHERE kind <> 'status'
     ${insertOnly ? 'DO NOTHING' : 'DO UPDATE SET label = EXCLUDED.label, hash = EXCLUDED.hash, taken_at = now(), notified_hash = NULL'}
     RETURNING id, note_id, kind, label, hash, notified_hash, taken_at`, [noteId, kind, label, hash])
  return rows[0]
}

// Applies a plan; the rows are re-read rather than replayed in memory.
async function applySnapshotPlan (noteId, rows, plan, body, hash, db = pool) {
  for (const s of plan.inserts) {
    await withTx(client => takeSnapshot(noteId, s.kind, s.label, body, hash, client, { insertOnly: s.kind === 'published' }), db)
  }
  return plan.inserts.length ? loadNoteSnapshots(noteId, db) : rows
}

async function loadNoteSnapshots (noteId, db = pool) {
  const { rows } = await db.query('SELECT id, note_id, kind, label, hash, notified_hash, taken_at FROM spec_board_snapshots WHERE note_id = $1 ORDER BY id', [noteId])
  return rows
}

async function snapshotBody (id, db = pool) {
  const { rows } = await db.query(
    'SELECT b.body FROM spec_board_snapshots s JOIN spec_board_snapshot_bodies b ON b.hash = s.hash WHERE s.id = $1', [id])
  if (!rows.length) throw new Error(`snapshot ${id} has no stored text`)
  return rows[0].body
}

async function migrateSnapshotIntegrity (db = pool) {
  await db.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'spec_board_snapshots'::regclass AND conname = 'spec_board_snapshot_body_fk') THEN
      ALTER TABLE spec_board_snapshots ADD CONSTRAINT spec_board_snapshot_body_fk
        FOREIGN KEY (hash) REFERENCES spec_board_snapshot_bodies(hash) NOT VALID;
    END IF;
  END $$`)
}

// The editor attests persisted text; the row lock prevents another save from
// landing between the version check and its approval snapshot.
async function noteApprovalPost (req, res, spec) {
  const cors = { 'Access-Control-Allow-Origin': BASE_ORIGIN, 'Content-Type': 'application/json' }
  const fail = (code, msg) => { res.writeHead(code, cors).end(JSON.stringify({ error: msg })) }
  if (!EDITOR_SECRET) return fail(503, 'the board has no EDITOR_SECRET, approvals cannot be recorded')
  let body
  try { body = JSON.parse(await readBody(req, 10000)) } catch { return fail(400, 'bad request') }
  const who = verifyToken(body.token, EDITOR_SECRET)
  if (!who || who.version !== 1 || who.purpose !== 'spec-approval' || who.provider !== 'github' ||
      !/^\d+$/.test(who.subject) || typeof who.username !== 'string' || who.noteId !== spec.id || who.action !== body.action ||
      (body.action === 'approve' && !/^[a-f0-9]{64}$/.test(who.contentHash))) {
    return fail(401, 'A current, version-bound GitHub assertion from the editor is required')
  }
  let login = who.username
  if (body.action === 'approve') {
    if (!NAMESPACES.includes(spec.namespace)) return fail(403, 'The namespace is not configured for approvals')
    const roles = await feedbackRoles(spec.namespace, true)
    if (!roles) return fail(503, 'Current approver roles could not be verified; try again shortly')
    login = normList(roles.approvers).find(a => a.toLowerCase() === who.username.toLowerCase())
    if (!login) return fail(403, `${who.username} is not an approver in roles.yml`)
    const result = await withTx(async client => {
      const { rows } = await client.query('SELECT shortid, content, permission FROM "Notes" WHERE shortid = $1 FOR UPDATE', [spec.id])
      if (!rows.length || !publicSpecs(rows).length) return [404, 'unknown note']
      if (contentHash(rows[0].content) !== who.contentHash) return [409, 'The note changed after saving. Review the current text and try again.']
      const { rows: [pinned] } = await client.query('SELECT namespace, pr_number FROM spec_board_state WHERE note_id=$1 FOR SHARE', [spec.id])
      const current = specsFromRows(rows, new Map(pinned ? [[spec.id, pinned]] : []))[0]
      if (!current || current.namespace !== spec.namespace || !REVIEW_STATUSES.has(COLUMNS[current.statusIdx].tag)) return [409, 'the spec is not under review']
      const text = publishedBody({ content: rows[0].content })
      await takeSnapshot(spec.id, 'approval', login, text, publishedHash(text), client)
      return null
    })
    if (result) return fail(...result)
    applyRoles(spec, roles)
    if (!spec.approvedBy.some(a => a.toLowerCase() === login.toLowerCase())) spec.approvedBy = spec.approvedBy.concat(login)
  } else if (body.action === 'retract') {
    await pool.query("DELETE FROM spec_board_snapshots WHERE note_id = $1 AND kind = 'approval' AND lower(label) = $2", [spec.id, login.toLowerCase()])
    spec.approvedBy = spec.approvedBy.filter(a => a.toLowerCase() !== login.toLowerCase())
  } else return fail(400, 'action must be approve or retract')
  // The in-memory spec answers /api/note until the next tick re-reads the rows.
  spec.staleApprovals = (spec.staleApprovals || []).filter(a => a.toLowerCase() !== login.toLowerCase())
  countApprovals(spec)
  console.log(`approval: ${body.action} ${login} on ${spec.id} (${spec.approvals}/${spec.required})`)
  res.writeHead(200, cors).end(JSON.stringify(noteRecord(spec.id, snapshot.specs, snapshot.state)))
}

// A ref names one text of a note: a row id, `current` (the live note in its
// published form), `approval:<login>`, `status:<tag>` (the newest such row),
// `published:rN`. The body is fetched only when asked for.
function resolveSnapshotRef (rows, ref, spec) {
  const v = String(ref || 'current').trim()
  if (v === 'current') {
    return { id: 'current', kind: 'current', label: 'current', at: spec.changed, hash: publishedHash(publishedBody(spec)), body: async () => publishedBody(spec) }
  }
  let row = null
  if (/^\d{1,12}$/.test(v)) {
    row = rows.find(r => String(r.id) === v) || null
  } else {
    const m = /^(approval|status|published):(.{1,80})$/.exec(v)
    if (m) row = lastRow(rows, m[1], m[2]) || null
  }
  return row && { id: row.id, kind: row.kind, label: row.label, at: row.taken_at, hash: row.hash, body: async () => snapshotBody(row.id) }
}

// What a returning reviewer most likely wants to diff from: their own
// approval, else the text as approved, else the last status change, else
// the first thing recorded.
function defaultFrom (rows, login) {
  const me = login && lastRow(rows, 'approval', login)
  if (me) return `approval:${me.label}`
  if (lastRow(rows, 'status', 'approved')) return 'status:approved'
  const status = lastRow(rows, 'status')
  if (status) return `status:${status.label}`
  return rows.length ? String(rows[0].id) : null
}

// The diff is the expensive part of a public route, so one result per pair of
// texts is kept, named by their hashes; a hit reads no body at all.
const diffCache = new Map()
async function diffBetween (from, to) {
  const key = `${from.hash}:${to.hash}`
  if (!diffCache.has(key)) {
    const [a, b] = await Promise.all([from.body(), to.body()])
    if (diffCache.size >= 50) diffCache.clear()
    diffCache.set(key, { requirements: requirementDelta(requirementMap(a), requirementMap(b)), diff: wordDiff(a, b) })
  }
  return diffCache.get(key)
}

async function changesData (spec, rows, fromRef, toRef) {
  const from = resolveSnapshotRef(rows, fromRef, spec)
  const to = resolveSnapshotRef(rows, toRef, spec)
  if (!from || !to) return null
  return { from, to, same: from.hash === to.hash, ...(await diffBetween(from, to)) }
}

// The board's changes page for a note, absolute when the board knows its own
// origin. Callers that would otherwise print a bare path (a PR body, a
// webhook line) print nothing.
const changesUrl = (noteId, query = '') => SPEC_BOARD_BASE_URL ? `${SPEC_BOARD_BASE_URL}/changes/${noteId}${query}` : null

const snapshotLabel = r => r.kind === 'current' ? 'current text' : `${r.kind} ${r.label}`
const refValue = r => r.kind === 'current' ? 'current' : `${r.kind}:${r.label}`

function changesPage (spec, rows, data, wanted = {}) {
  const option = (r, sel) => `<option value="${esc(refValue(r))}"${sel ? ' selected' : ''}>${esc(snapshotLabel(r))}${r.at ? ` · ${esc(new Date(r.at).toISOString().slice(0, 16).replace('T', ' '))}` : ''}</option>`
  const all = rows.map(r => ({ kind: r.kind, label: r.label, at: r.taken_at })).concat([{ kind: 'current', label: 'current', at: spec.changed }])
  const pick = (name, cur) => `<select name="${name}">${all.map(r => option(r, cur && refValue(r) === refValue(cur))).join('')}</select>`
  let body
  if (!rows.length) {
    body = '<p class="notice">No snapshots yet: the board records the published text at each status change, approval and publish, and this note has had none since that started.</p>'
  } else if (!data) {
    body = `<p class="warn">Unknown snapshot ${esc(wanted.from || '')} or ${esc(wanted.to || '')}. Pick one below.</p>
<form method="get" class="filters"><label>From${pick('from', null)}</label><label>To${pick('to', null)}</label><button class="primary">Compare</button></form>`
  } else {
    const reqLine = reqSummary(data.requirements)
    body = `${wanted.missing ? `<p class="warn">Snapshot ${esc(wanted.missing)} no longer exists; showing the default comparison.</p>` : ''}
<form method="get" class="filters"><label>From${pick('from', data.from)}</label><label>To${pick('to', data.to)}</label><button class="primary">Compare</button></form>
<p class="facts">${esc(snapshotLabel(data.from))} → ${esc(snapshotLabel(data.to))}${reqLine ? ` · requirements ${esc(reqLine)}` : ''}</p>
${data.same ? '<p class="notice">No change in the published text between these two.</p>' : `<pre class="diff">${diffHtml(data.diff)}</pre>`}`
  }
  return basicPage(`Changes: ${spec.title}`, `
    <div class="page-heading"><div><h1>${esc(spec.title)}</h1><p class="context">Compare published text across status changes, approvals and revisions.</p></div><a class="button" href="${esc(spec.url)}">Open spec</a></div>
    ${body}`, { page: 'changes', ns: spec.namespace })
}

// fallback: a link to a snapshot since replaced (a retracted approval) shows
// the default pair with a note, where the api answers 404.
async function changesFor (spec, url, login, fallback = false) {
  const rows = await loadNoteSnapshots(spec.id)
  const wanted = { from: url.searchParams.get('from') || defaultFrom(rows, login), to: url.searchParams.get('to') || 'current' }
  let data = rows.length ? await changesData(spec, rows, wanted.from, wanted.to) : null
  if (!data && rows.length && fallback) {
    wanted.missing = `${wanted.from} or ${wanted.to}`
    wanted.from = defaultFrom(rows, login)
    wanted.to = 'current'
    data = await changesData(spec, rows, wanted.from, wanted.to)
  }
  return { rows, wanted, data }
}

async function changesGet (req, res, spec, url) {
  if (!await currentPublicNote(spec.id)) { res.writeHead(404).end('unknown spec'); return }
  const sess = session(req)
  const { rows, wanted, data } = await changesFor(spec, url, sess && sess.login, true)
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
  res.end(changesPage(spec, rows, data, wanted))
}

async function changesApiGet (res, spec, url) {
  if (!await currentPublicNote(spec.id)) { apiMiss(res); return }
  const { rows, data } = await changesFor(spec, url, null)
  if (!data) { sendError(res, 404, 'unknown snapshot'); return }
  const pub = r => ({ id: r.id, kind: r.kind, label: r.label, at: r.at })
  sendJson(res, {
    from: pub(data.from),
    to: pub(data.to),
    same: data.same,
    snapshots: rows.map(r => ({ id: r.id, kind: r.kind, label: r.label, at: r.taken_at })),
    requirements: data.requirements,
    diff: data.diff
  })
}

// Once per new text per approver, after the note has settled, so a live edit
// is one mail rather than one a minute. Nothing is recorded when no channel
// exists.
async function notifyStaleApprovals (spec, rows, hash) {
  if ((!mailer && !WEBHOOK_URL) || !settled(spec)) return
  for (const r of rows) {
    if (r.kind !== 'approval' || r.hash === hash || r.notified_hash === hash) continue
    const link = changesUrl(spec.id, `?from=approval:${encodeURIComponent(r.label)}`)
    const line = `"${spec.title}" changed since ${r.label}'s approval: ${link || spec.url}`
    try {
      const u = spec.approverUsers && spec.approverUsers.get(r.label.toLowerCase())
      const queued = await withTx(async client => {
        const { rows: current } = await client.query('SELECT hash, notified_hash FROM spec_board_snapshots WHERE id = $1 FOR UPDATE', [r.id])
        if (!current.length || current[0].hash !== r.hash || current[0].notified_hash === hash) return false
        if (u) await enqueueEmails(spec, [digestEvent('approval-stale', line, { url: link || spec.url, noteUrl: spec.url, namespace: spec.namespace })], u.id, client)
        await client.query('UPDATE spec_board_snapshots SET notified_hash = $1 WHERE id = $2', [hash, r.id])
        return true
      })
      if (!queued) continue
      r.notified_hash = hash
      await notify(line)
    } catch (e) {
      console.error(`stale approval [${spec.id} ${r.label}]:`, e.message)
    }
  }
}

async function loadReviews () {
  const { rows } = await pool.query('SELECT note_id, bot_name, reviewed_hash FROM spec_board_reviews')
  return new Map(rows.map(r => [reviewKey(r.note_id, r.bot_name), r.reviewed_hash]))
}

// r: { id, status, comments, prNumber, implementedAt, approvals, namespace, category, prState, lockedAt, supersededAt, specPath, publishedHash, revision, revisionPr }
// Partial upsert: only keys present on r are written, so a caller that omits
// a field preserves the stored value instead of nulling it. pr_number and
// implemented_at are the only proof a PR opened or a spec landed; clearing a
// column takes an explicit null.
const STATE_COLS = [
  ['status', 'status'], ['comments', 'comment_count'], ['prNumber', 'pr_number'],
  ['implementedAt', 'implemented_at'], ['approvals', 'approvals'], ['namespace', 'namespace'],
  ['category', 'category'], ['prState', 'pr_state'], ['lockedAt', 'locked_at'],
  ['prelockPermission', 'prelock_permission'],
  ['permissionIntent', 'permission_intent'], ['permissionLockId', 'permission_lock_id'],
  ['supersededAt', 'superseded_at'], ['specPath', 'spec_path'],
  ['publishedHash', 'published_hash'], ['publishedCommit', 'published_commit'], ['revision', 'revision'], ['revisionPr', 'revision_pr'],
  ['discussionHashes', 'discussion_hashes']
]
const STATE_KEYS = new Set(['id', ...STATE_COLS.map(([key]) => key)])
// One connection, one transaction; the callback gets the client to query on.
async function withTx (fn, db = pool) {
  const client = await db.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

async function upsertState (r, db = pool) {
  // A misspelled key would silently no-op (undefined = preserve), which on a
  // state row means losing the write instead of erroring. Fail loud instead.
  for (const key of Object.keys(r)) {
    if (!STATE_KEYS.has(key)) throw new Error(`upsertState: unknown key ${key}`)
  }
  const cols = []
  const vals = [r.id]
  for (const [key, col] of STATE_COLS) {
    if (r[key] !== undefined) {
      cols.push(col)
      vals.push(r[key])
    }
  }
  if (!cols.length) return
  const places = cols.map((_, i) => `$${i + 2}`)
  await db.query(
    `INSERT INTO spec_board_state (note_id, ${cols.join(', ')}) VALUES ($1, ${places.join(', ')})
     ON CONFLICT (note_id) DO UPDATE SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')}`, vals)
}

// passport profiles carry emails as [{value}] (github) or [string] (our oauth2
// mapping, lib/web/auth/oauth2 userProfile); accept either shape.
function profileEmail (profileJson) {
  const e = (parseProfile(profileJson).emails || [])[0]
  return (typeof e === 'string' ? e : e && e.value) || ''
}

// Lowercased so a mixed-case address opts out and re-subscribes consistently;
// mail domains are case-insensitive and real mailboxes treat the local part so.
function userEmail (u) {
  return ((u.email && u.email.trim()) || profileEmail(u.profile)).toLowerCase()
}

// Opt-out is stored as a one-way hash, never the address, so the table cannot
// be read back into a list of who unsubscribed. Callers hash the candidate to
// test membership.
function emailKey (email) {
  return crypto.createHash('sha256').update(email.toLowerCase()).digest('hex')
}

// Delivery-address override for one user: the namespace row if there is one,
// otherwise the global (namespace '') row. Lands in the email column, which
// userEmail prefers over the profile address.
function notifyEmailJoin (userCol, nsParam) {
  return `LEFT JOIN LATERAL (
      SELECT email FROM spec_board_notify_email ne
       WHERE ne.user_id = ${userCol} AND ne.namespace IN (${nsParam}, '')
       ORDER BY ne.namespace = ${nsParam} DESC LIMIT 1) ne ON true`
}

// Spec author (Notes.ownerId) plus every participant the editor's authorship
// patch recorded in Authors: the only server-side evidence the board has that
// a person touched the content. OAuth logins never populate Users.email
// (passportGeneralCallback stores only the profile JSON), so fall back to the
// profile's address. Guests have no Users row and drop out of the join.
async function participantUsers (shortid, namespace, db = pool) {
  const { rows } = await db.query(
    `SELECT u.id, COALESCE(ne.email, u.email) AS email, u.profile FROM "Notes" n
       JOIN "Users" u ON u.id = n."ownerId"
       ${notifyEmailJoin('u.id::text', '$2')}
       WHERE n.shortid = $1
     UNION
     SELECT u.id, COALESCE(ne.email, u.email) AS email, u.profile FROM "Notes" n
       JOIN "Authors" a ON a."noteId" = n.id
       JOIN "Users" u ON u.id = a."userId"
       ${notifyEmailJoin('u.id::text', '$2')}
       WHERE n.shortid = $1`, [shortid, namespace || ''])
  return rows
}

async function namespaceSubs (namespace, db = pool) {
  const watch = await db.query(
      // user_id is a text column holding a Users.id; compare as text so one
      // malformed row degrades to no match instead of aborting the whole
      // query and killing watcher delivery for the namespace.
      `SELECT u.id, COALESCE(ne.email, u.email) AS email, u.profile FROM spec_board_subscriptions s
         JOIN "Users" u ON u.id::text = s.user_id
         ${notifyEmailJoin('s.user_id', '$1')}
         WHERE s.namespace = $1 AND s.level = 'watch'`, [namespace])
  const disabled = await db.query("SELECT user_id FROM spec_board_subscriptions WHERE namespace = $1 AND level = 'disabled'", [namespace])
  return { watchers: watch.rows, disabled: new Set(disabled.rows.map(r => r.user_id)) }
}

// (participants ∪ watchers) − disabled − globally opted-out, deduped to a list.
function resolveRecipients (participants, watchers, disabledIds, suppressed = new Set()) {
  return recipientDetails(participants, watchers, disabledIds, userEmail, suppressed).map(r => r.email)
}

// only: one user's id. That person still has to be a participant or watcher
// and the same mute and opt-out apply; the address is the one they chose for
// delivery, not the commit-author one.
async function recipientsForSpec (shortid, namespace, only = null, db = pool) {
  const participants = await participantUsers(shortid, namespace, db)
  const subs = namespace ? await namespaceSubs(namespace, db) : { watchers: [], disabled: new Set() }
  const candidates = recipientDetails(participants, subs.watchers, subs.disabled, userEmail, new Set(), only)
  if (!candidates.length) return []
  const keys = candidates.map(r => emailKey(r.email))
  const { rows } = await db.query('SELECT email_hash FROM spec_board_optout WHERE email_hash = ANY($1)', [keys])
  const suppressed = new Set(rows.map(r => r.email_hash))
  return candidates.filter(r => !suppressed.has(emailKey(r.email)))
}

async function enqueueEmails (spec, events, only = null, db = pool) {
  if (!mailer || !events.length) return
  if (!(await visibleNotifications(db, [{ note_id: spec.id }])).length) return
  const recipients = await recipientsForSpec(spec.id, spec.namespace, only, db)
  await insertNotifications(db, spec, events, recipients)
}

function unsubUrl (email) {
  return `${SPEC_BOARD_BASE_URL}/unsub?t=${signToken({ u: email, exp: Date.now() + UNSUB_TTL_MS })}`
}

// Plain-text footer on every digest: sender identity, one-click unsubscribe,
// granular settings, privacy policy, and optional postal address (CAN-SPAM).
function emailFooter (email, unsub) {
  const privacy = PRIVACY_URL || `${SPEC_BOARD_BASE_URL}/privacy`
  const lines = [
    '',
    '--',
    `${EMAIL_ORG_NAME} spec activity digest for ${email}.`,
    `Unsubscribe from all digests: ${unsub}`
  ]
  if (SETTINGS_ENABLED) lines.push(`Change which specs email you: ${SPEC_BOARD_BASE_URL}/settings`)
  lines.push(`Privacy: ${privacy}`)
  if (EMAIL_POSTAL_ADDRESS) lines.push(EMAIL_POSTAL_ADDRESS)
  return lines.join('\n') + '\n'
}

// Send to any recipient quiet for the debounce window, then drop the sent rows.
// Only captured ids are deleted, so a line arriving mid-send survives and resets
// the window. Send failure leaves the rows for the next poll to retry.
// Single flusher guaranteed by the poll advisory lock, so replicas never
// double-send.
const delivery = createNotificationDelivery({ db: pool, mailer, renderDigest, emailKey, emailFooter, unsubUrl,
  from: SMTP_FROM, debounceMinutes: EMAIL_DEBOUNCE_MINUTES, health,
  shouldStop: () => lifecycle.stopping || !!(leadership && leadership.signal.aborted) })
const flushEmails = () => delivery.flush()

async function ensureState () {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS spec_board_state (
       note_id text PRIMARY KEY,
       status text,
       comment_count int DEFAULT 0,
       pr_number int,
       implemented_at timestamptz
     )`)
  await pool.query('CREATE TABLE IF NOT EXISTS spec_board_meta (key text PRIMARY KEY, value text)')
  await pool.query(
    `CREATE TABLE IF NOT EXISTS spec_board_notifications (
       id serial PRIMARY KEY,
       email text NOT NULL,
       note_id text NOT NULL,
       title text,
       line text NOT NULL,
       created_at timestamptz DEFAULT now()
     )`)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS spec_board_subscriptions (
       user_id text NOT NULL,
       namespace text NOT NULL,
       level text NOT NULL,
       PRIMARY KEY (user_id, namespace)
     )`)
  // Chosen git-author address per user; namespace '' is the global default that
  // a per-namespace row overrides. Empty table means "use the account email".
  await pool.query(
    `CREATE TABLE IF NOT EXISTS spec_board_email (
       user_id text NOT NULL,
       namespace text NOT NULL,
       email text NOT NULL,
       PRIMARY KEY (user_id, namespace)
     )`)
  // Chosen delivery address for notification email; namespace '' is the global
  // default that a per-namespace row overrides. Empty table means "deliver to
  // the account email".
  await pool.query(
    `CREATE TABLE IF NOT EXISTS spec_board_notify_email (
       user_id text NOT NULL,
       namespace text NOT NULL DEFAULT '',
       email text NOT NULL,
       PRIMARY KEY (user_id, namespace)
     )`)
  // Widen the pre-namespace shape: existing rows become the global default.
  await pool.query("ALTER TABLE spec_board_notify_email ADD COLUMN IF NOT EXISTS namespace text NOT NULL DEFAULT ''")
  const { rows: pk } = await pool.query(
    `SELECT count(*) AS n FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'spec_board_notify_email'::regclass AND i.indisprimary`)
  // Two statements, so a crash between them leaves no key at all; the guard
  // is "not the two-column key yet", which also covers that state.
  if (Number(pk[0].n) !== 2) {
    await pool.query('ALTER TABLE spec_board_notify_email DROP CONSTRAINT IF EXISTS spec_board_notify_email_pkey')
    await pool.query('ALTER TABLE spec_board_notify_email ADD PRIMARY KEY (user_id, namespace)')
  }
  // Global opt-out keyed by a one-way hash of the address (not the address),
  // covering recipients with no linked account who can't use the subscriptions
  // table. Retained after opt-out so it keeps being honored.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS spec_board_optout (
       email_hash text PRIMARY KEY,
       created_at timestamptz DEFAULT now()
     )`)
  // Retire the pre-hash plaintext table: hash its rows into the new one, then
  // drop it. Runs once; skipped after the table is gone.
  if ((await pool.query("SELECT to_regclass('spec_board_email_optout') IS NOT NULL AS present")).rows[0].present) {
    const { rows: old } = await pool.query('SELECT email, created_at FROM spec_board_email_optout')
    for (const r of old) {
      await pool.query('INSERT INTO spec_board_optout (email_hash, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING', [emailKey(r.email), r.created_at])
    }
    await pool.query('DROP TABLE spec_board_email_optout')
  }
  await pool.query('ALTER TABLE spec_board_notifications ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0')
  await migrateNotifications(pool)
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS approvals int DEFAULT 0')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS category text')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS namespace text')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS pr_state text')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS locked_at timestamptz')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS prelock_permission text')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS permission_intent jsonb')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS permission_lock_id text')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS superseded_at timestamptz')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS spec_path text')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS published_hash text')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS published_commit text')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS publication_generation bigint NOT NULL DEFAULT 0')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS revision int')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS revision_pr int')
  // Superseded by spec_board_reviews; review state re-derives on the next
  // tick, so dropping loses nothing.
  await pool.query('ALTER TABLE spec_board_state DROP COLUMN IF EXISTS reviewed_hash')
  // api_key is plaintext in the same Postgres that already holds HedgeDoc's
  // own OAuth tokens (Users.accessToken): same trust boundary.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS spec_board_bots (
       name text PRIMARY KEY,
       url text NOT NULL,
       api_key text,
       model text NOT NULL,
       prompt text,
       namespaces text NOT NULL DEFAULT '',
       enabled boolean NOT NULL DEFAULT true
     )`)
  await pool.query(
    `CREATE TABLE IF NOT EXISTS spec_board_reviews (
       note_id text NOT NULL,
       bot_name text NOT NULL,
       reviewed_hash text NOT NULL,
       PRIMARY KEY (note_id, bot_name)
     )`)
  // The published text at each event a reviewer diffs against. Status rows
  // accumulate; an approval row is one per approver and a published row one
  // per revision, both replaced in place.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS spec_board_snapshots (
       id serial PRIMARY KEY,
       note_id text NOT NULL,
       kind text NOT NULL,
       label text NOT NULL,
       hash text NOT NULL,
       taken_at timestamptz NOT NULL DEFAULT now(),
       notified_hash text
     )`)
  await pool.query('CREATE TABLE IF NOT EXISTS spec_board_snapshot_bodies (hash text PRIMARY KEY, body text NOT NULL)')
  // A stack that ran the pre-release shape, bodies inline on the row: move
  // them over before the column goes. Never deployed, so no rollback story.
  const inline = await pool.query(
    "SELECT 1 FROM information_schema.columns WHERE table_name = 'spec_board_snapshots' AND column_name = 'body'")
  if (inline.rows.length) {
    await pool.query('INSERT INTO spec_board_snapshot_bodies (hash, body) SELECT DISTINCT ON (hash) hash, body FROM spec_board_snapshots ON CONFLICT (hash) DO NOTHING')
    await pool.query('ALTER TABLE spec_board_snapshots DROP COLUMN IF EXISTS body')
  }
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS spec_board_snapshots_one
     ON spec_board_snapshots (note_id, kind, lower(label)) WHERE kind <> 'status'`)
  await pool.query('CREATE INDEX IF NOT EXISTS spec_board_snapshots_note ON spec_board_snapshots (note_id)')
  await migrateSnapshotIntegrity()
  publicationSchema = await publicationGuard(pool)
  await feedbackStore.migrate()
  await roadmapStore.migrate()
}

// Index a namespace's PRs so a spec keeps its PR link through close/merge, and
// so a spec whose recorded number was lost is re-linked by matching the PR's
// head branch (which ends in the spec's slug).
//
// In-process and refreshed incrementally: one full listing on first use, then
// only PRs updated since the cursor. Memory-only cursor: persisting it with
// empty maps would skip history, and one cold listing per restart is cheap.
const prIndexCache = new Map() // ns -> { byNumber, bySlug, cursor }
// Overlap re-reads absorb the list endpoint's eventual consistency; merging
// the same PR twice is idempotent.
const PR_CURSOR_SLOP_MS = 5 * 60 * 1000

// Merge one PR into the maps. bySlug keeps the newest PR per slug; an equal
// number still updates state/ref, so open -> merged transitions land.
// ns is the namespace being indexed: only a branch in that repo can be one the
// board pushed, and bySlug drives re-linking, so a fork PR whose head happens
// to be named NNN-<slug> must never enter it or an outsider could adopt a
// spec's PR link by opening one. byNumber is state-only and safe either way.
function mergePr (idx, p, ns) {
  const state = p.merged_at ? 'merged' : p.state
  idx.byNumber.set(p.number, state)
  const sameRepo = !ns || (p.head.repo && p.head.repo.full_name === ns)
  const m = /^(?:[\w.-]+\/)?\d+-(.+)$/.exec(p.head.ref)
  if (m && sameRepo) {
    const cur = idx.bySlug.get(m[1])
    if (!cur || p.number >= cur.number) idx.bySlug.set(m[1], { number: p.number, state, ref: p.head.ref })
  }
}

async function namespacePRIndex (ns) {
  const cached = prIndexCache.get(ns)
  try {
    if (!cached) {
      const idx = { byNumber: new Map(), bySlug: new Map(), cursor: 0 }
      const { items } = await ghPaged(`/repos/${ns}/pulls?state=all&per_page=100`)
      for (const p of items) {
        mergePr(idx, p, ns)
        idx.cursor = Math.max(idx.cursor, Date.parse(p.updated_at) || 0)
      }
      prIndexCache.set(ns, idx)
      return idx
    }
    // Warm: newest-updated first, stop at the first item older than the
    // cursor minus slop. The cursor advances only once the fetch completes,
    // so a mid-listing failure re-reads instead of skipping.
    const since = cached.cursor - PR_CURSOR_SLOP_MS
    let cursor = cached.cursor
    await ghPagedUntil(`/repos/${ns}/pulls?state=all&sort=updated&direction=desc&per_page=100`, p => {
      const at = Date.parse(p.updated_at) || 0
      if (at < since) return true
      mergePr(cached, p, ns)
      cursor = Math.max(cursor, at)
      return false
    })
    cached.cursor = cursor
    return cached
  } catch (e) {
    console.error('pr list:', e.message)
    // A stale index beats none: recorded PRs keep their last-known state and
    // slug re-links still work.
    return cached || null
  }
}

async function branchExists (ns, ref) {
  try { await gh('GET', `/repos/${ns}/branches/${encodeURIComponent(ref)}`); return true } catch (e) {
    if (e.status === 404) return false
    throw e
  }
}

async function notify (text) {
  if (!WEBHOOK_URL || lifecycle.stopping || (leadership && leadership.signal.aborted)) return
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: outboundSignal(FETCH_TIMEOUT_MS, { mutation: true })
    })
  } catch (e) {
    console.error('webhook:', e.message)
  }
}

let appJwtCache = null
function appJwt () {
  const now = Math.floor(Date.now() / 1000)
  if (appJwtCache && now < appJwtCache.exp - 30) return appJwtCache.jwt
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url')
  const exp = now + 540 // GitHub caps app JWTs at 10 min; 9 leaves clock-skew room
  const head = b64({ alg: 'RS256', typ: 'JWT' })
  const body = b64({ iat: now - 60, exp, iss: GITHUB_APP_ID })
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(GITHUB_APP_PRIVATE_KEY).toString('base64url')
  appJwtCache = { jwt: `${head}.${body}.${sig}`, exp }
  return appJwtCache.jwt
}

// The app's installation on a namespace repo, or throws 404 if not installed.
function appInstallation (ns) {
  return gh('GET', `/repos/${ns}/installation`, null, appJwt())
}

const instTokenCache = new Map() // ns -> { token, exp(ms) }
async function installationToken (ns) {
  const cached = instTokenCache.get(ns)
  if (cached && Date.now() < cached.exp - 60000) return cached.token
  const inst = await appInstallation(ns)
  const tok = await gh('POST', `/app/installations/${inst.id}/access_tokens`, {}, appJwt())
  instTokenCache.set(ns, { token: tok.token, exp: Date.parse(tok.expires_at) })
  return tok.token
}

// Service token for a namespace: the app installation token when the app
// covers it, else the PAT. A 404 means the app is not installed here; cache
// that so a PAT namespace does not re-probe /installation on every gh call.
const appMissCache = new Map() // ns -> expiry(ms) of the "not installed" verdict
async function serviceTokenFor (ns) {
  if (GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY && !(appMissCache.get(ns) > Date.now())) {
    try { return await installationToken(ns) } catch (e) {
      // 5 min, not an hour: one 404 blip must not strand a namespace on the
      // PAT fallback (or on nothing, in an app-only deploy) for long.
      if (e.status === 404) appMissCache.set(ns, Date.now() + 300000)
      else console.error('app token:', e.message)
    }
  }
  return GITHUB_TOKEN
}

async function serviceTokenForPath (path) {
  const m = /^\/repos\/([^/]+\/[^/]+)/.exec(path)
  return m ? serviceTokenFor(m[1]) : GITHUB_TOKEN
}

// Past the hourly budget every further call is a wasted request that GitHub
// also counts against the abuse limit, so calls stop until its own reset.
// The budget is per credential: one namespace's app token running dry must
// not pause the others.
const ghPaused = new Map() // token -> epoch ms
const ghPausedUntil = () => [...ghPaused.values()].filter(t => t > Date.now()).map(t => new Date(t).toISOString())
let ghQuota = { remaining: null, resetAt: null }
const tickStats = { gh: 0, bots: 0 }

async function gh (method, path, body, token) {
  const tok = token || await serviceTokenForPath(path)
  // A half-configured deploy (app id without key, no PAT) would otherwise
  // send "Bearer undefined" and spam 401s that look like a GitHub problem.
  if (!tok) throw new Error(`${method} ${path}: no GitHub credential configured`)
  const until = ghPaused.get(tok) || 0
  if (Date.now() < until) throw new Error(`${method} ${path}: GitHub rate limit exhausted until ${new Date(until).toISOString()}`)
  tickStats.gh++
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${tok}`,
      accept: 'application/vnd.github+json',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: outboundSignal(FETCH_TIMEOUT_MS, { mutation: method !== 'GET' })
  })
  const remaining = resp.headers.get('x-ratelimit-remaining')
  const resetAt = Number(resp.headers.get('x-ratelimit-reset')) * 1000
  if (remaining != null) ghQuota = { remaining: Number(remaining), resetAt: resetAt ? new Date(resetAt).toISOString() : null }
  if (!resp.ok) {
    if ((resp.status === 403 || resp.status === 429) && remaining === '0' && resetAt) {
      if (ghPaused.size >= 100) ghPaused.clear()
      ghPaused.set(tok, resetAt)
    }
    // Cap the echoed body: it reaches logs and the /bots failure banner, and
    // an oversized or credential-bearing upstream response should not ride
    // along in full.
    const err = new Error(`${method} ${path}: ${resp.status} ${(await resp.text()).slice(0, 300)}`)
    err.status = resp.status
    throw err
  }
  return resp.json()
}

// Paged GET: path must already carry per_page=100. Capped so one busy repo
// can't eat the rate budget. Returns { items, truncated }; truncated means the
// cap was hit with a full final page, so older results were not fetched.
async function ghPaged (path, maxPages = 50) {
  const items = []
  for (let page = 1; page <= maxPages; page++) {
    const batch = await gh('GET', `${path}&page=${page}`)
    items.push(...batch)
    if (batch.length < 100) return { items, truncated: false }
  }
  console.warn(`gh: ${path} truncated at ${maxPages} pages`)
  return { items, truncated: true }
}

// Paged GET like ghPaged, but stop(item) === true halts pagination early;
// the rest of the page and later pages are skipped.
async function ghPagedUntil (path, stop, maxPages = 50) {
  for (let page = 1; page <= maxPages; page++) {
    const batch = await gh('GET', `${path}&page=${page}`)
    for (const item of batch) {
      if (stop(item)) return
    }
    if (batch.length < 100) return
  }
  console.warn(`gh: ${path} truncated at ${maxPages} pages`)
}

// GET that treats 404 as "absent" rather than an error.
async function ghOrNull (path, token) {
  try {
    return await gh('GET', path, null, token)
  } catch (e) {
    if (e.status === 404) return null
    throw e
  }
}

// Effective specs dir for a namespace, normalized from roles.yml `specs-dir`
// ('.' or '' = repo apex, surrounding slashes stripped). Default: the apex
// when roles.yml sits at the repo root (a specs-only repo), SPECS_DIR
// otherwise. Segments are limited to word chars, dots, and dashes (the value
// lands in unencoded API URLs and git paths); traversal or other characters
// fall back to the default.
function normSpecsDir (raw, atRoot) {
  const fallback = atRoot ? '' : SPECS_DIR
  if (raw == null) return fallback
  const dir = String(raw).trim().replace(/^\/+|\/+$/g, '')
  if (dir === '' || dir === '.') return ''
  if (!dir.split('/').every(s => /^[\w.-]+$/.test(s) && s !== '.' && s !== '..')) return fallback
  return dir
}

// RBAC as code: .specs/roles.yml (or root roles.yml) in each namespace repo. The enforceable
// gate stays CODEOWNERS + branch protection there; this only drives the UI.
const rolesCache = new Map()
// cacheOnly: page renders never block on a live GitHub fetch; the poller
// keeps the cache warm and a cold entry just renders without role data.
async function namespaceRoles (ns, cacheOnly, refresh = false) {
  const cached = rolesCache.get(ns)
  if (!refresh && cached && Date.now() - cached.at < ROLES_TTL_MS) return cached.roles
  if (cacheOnly) return cached ? cached.roles : null
  let roles = null
  if (githubEnabled) {
    // Also accept roles.yml at the repo root, for specs-only repos where a
    // hidden .specs dir is redundant.
    try {
      let data, atRoot
      for (const p of ['.specs/roles.yml', 'roles.yml']) {
        try { data = await gh('GET', `/repos/${ns}/contents/${p}`); atRoot = p === 'roles.yml'; break } catch (e) {
          if (e.status !== 404) throw e
        }
      }
      roles = data ? yaml.load(Buffer.from(data.content, 'base64').toString()) || null : null
      if (roles && typeof roles === 'object' && !Array.isArray(roles)) {
        roles['specs-dir'] = normSpecsDir(roles['specs-dir'], atRoot)
      }
    } catch (e) {
      // Only a 404 means "confirmed ungoverned". Any other failure serves the
      // stale entry, or reports unknown so the PR gate fails closed instead of
      // treating the namespace as ungoverned (required would become 0).
      if (e.status !== 404) {
        console.error('roles:', e.message)
        if (cached) {
          cached.at = Date.now()
          cached.failed = true
          return cached.roles
        }
        return undefined
      }
    }
  }
  rolesCache.set(ns, { roles, at: Date.now(), successAt: Date.now(), failed: false })
  return roles
}

async function feedbackRoles (ns, refresh = false) {
  const r = await namespaceRoles(ns, false, refresh)
  const cached = rolesCache.get(ns)
  if (!githubEnabled || !cached || cached.failed || !Number.isFinite(cached.successAt) || Date.now() - cached.successAt >= ROLES_TTL_MS) return null
  return r && typeof r === 'object' && !Array.isArray(r) ? r : null
}

async function rolesForSpecs (specs, cacheOnly) {
  const recorded = await loadApprovals()
  const logins = [...new Set([...recorded.values()].flat().map(a => a.toLowerCase()))]
  recordedApprovals(specs, recorded, await reviewerIdentities(logins))
  const nsList = [...new Set(specs.filter(s => s.validNamespace).map(s => s.namespace))]
  const roles = await Promise.all(nsList.map(ns => namespaceRoles(ns, cacheOnly)))
  const byNs = new Map(nsList.map((ns, i) => [ns, roles[i]]))
  // undefined = roles fetch failed (gate must fail closed); null = confirmed absent
  for (const spec of specs) {
    applyRoles(spec, spec.validNamespace ? byNs.get(spec.namespace) : null)
    const cached = rolesCache.get(spec.namespace)
    if (spec.validNamespace && (!cached || cached.failed || !cached.successAt || Date.now() - cached.successAt >= ROLES_TTL_MS)) spec.rolesUnknown = true
  }
  return specs
}

// Verifiable onboarding: check each namespace with the service token. Branch
// protection needs administration:read, which a push-only PAT lacks, so it
// degrades to "unknown" rather than failing the namespace.
async function preflightNamespace (ns) {
  const checks = { repo: 'fail', push: 'fail', roles: 'fail', protection: 'unknown' }
  let repo
  try {
    repo = await gh('GET', `/repos/${ns}`)
  } catch (e) {
    return { ns, checks, status: 'FAIL', error: e.status || e.message }
  }
  checks.repo = 'pass'
  // App installation tokens carry fine-grained permissions, not the classic
  // push/pull roles, so repo.permissions.push is always false for them; read
  // the installation's contents grant instead. PATs keep the role check.
  let instPerms = null
  if (GITHUB_APP_ID && GITHUB_APP_PRIVATE_KEY) {
    try { instPerms = (await appInstallation(ns)).permissions } catch { /* not installed: PAT path */ }
  }
  checks.push = (instPerms ? instPerms.contents === 'write' : repo.permissions && repo.permissions.push) ? 'pass' : 'fail'
  checks.roles = (await namespaceRoles(ns)) ? 'pass' : 'fail'
  try {
    await gh('GET', `/repos/${ns}/branches/${encodeURIComponent(repo.default_branch)}/protection`)
    checks.protection = 'pass'
  } catch (e) {
    checks.protection = (e.status === 403 || e.status === 404) ? 'unknown' : 'fail'
  }
  // repo/push/roles are what you must fix to onboard; protection is advisory,
  // often unreadable by a push-only token, so it never fails the namespace.
  const status = ['repo', 'push', 'roles'].some(k => checks[k] !== 'pass') ? 'FAIL' : 'PASS'
  return { ns, default_branch: repo.default_branch, checks, status }
}

let preflightCache = []
const preflightStatus = new Map() // ns -> last status, to alert only on change
// ns -> { tag } for the newest checkpoint. /map is unauthenticated and must not
// reach GitHub per request, so the tag rides the preflight cadence instead.
const checkpointCache = new Map()
async function runPreflight () {
  if (!githubEnabled || lifecycle.stopping) return
  preflightCache = await Promise.all(NAMESPACES.map(preflightNamespace))
  await Promise.all(NAMESPACES.map(async ns => {
    try {
      const refs = await ghOrNull(`/repos/${ns}/git/matching-refs/tags/specs/v`)
      const { latest } = checkpointTags(refs || [])
      if (latest) checkpointCache.set(ns, { tag: latest.tag })
      else checkpointCache.delete(ns)
    } catch (e) { console.warn(`checkpoint tags ${ns}:`, e.message) }
  }))
  for (const r of preflightCache) {
    const checks = Object.entries(r.checks).map(([k, v]) => `${k}=${v}`).join(' ')
    console.log(`preflight ${r.status} ${r.ns}: ${checks}`)
    // Edge-triggered: a namespace losing access reached only the logs before.
    const prev = preflightStatus.get(r.ns)
    if (prev && prev !== r.status) await notify(`Preflight ${r.ns}: ${prev} -> ${r.status} (${checks})`)
    preflightStatus.set(r.ns, r.status)
  }
}

function slug (title) {
  return String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'spec'
}

function stripFrontmatter (content) {
  const { end } = frontmatter(content)
  if (end === -1) return content
  return content.slice(content.indexOf('\n', end + 1) + 1).replace(/^\n+/, '')
}

// First prose paragraph after the top heading: the spec's abstract.
function specAbstract (body) {
  const m = /^#[^\n]*\n+([\s\S]*?)(?=\n{2,}#{1,6} |\s*$)/.exec(body.trim())
  if (!m || m[1].trim().startsWith('#')) return ''
  const text = m[1].trim().replace(/\s*\n\s*/g, ' ')
  return text.length > 600 ? text.slice(0, 600) + '...' : text
}

// Numbers already taken in an area: NNN-slug.md files (and legacy NNN-slug/
// dirs) on the base branch plus live NNN-slug branch heads (an
// approved-but-unmerged spec, or an orphan from a crashed attempt).
// Returns { taken: Map(number -> Set(slugs)), live: Map(slug -> number) from
// branch heads only }.
async function takenSpecNumbers (repo, base, token, specsDir, catDir) {
  const taken = new Map()
  const live = new Map()
  const add = (num, slugPart) => {
    if (!taken.has(num)) taken.set(num, new Set())
    taken.get(num).add(slugPart)
  }
  const dir = `${specsDir}${catDir}`.replace(/\/$/, '')
  const entries = await ghOrNull(`${repo}/contents/${dir}?ref=${encodeURIComponent(base)}`, token) || []
  for (const entry of entries) {
    // Sibling area dirs (no digit prefix) skip the regex anyway; stray files
    // like README.md skip the .md-with-number match.
    const m = entry.type === 'dir'
      ? /^(\d+)(?:-(.*))?$/.exec(entry.name)
      : entry.type === 'file' ? /^(\d+)(?:-(.*))?\.md$/.exec(entry.name) : null
    if (m) add(Number(m[1]), m[2] || '')
  }
  // Branch heads are `${catDir}NNN-slug`; the prefix match scopes the category,
  // and at the root the path guard drops category-prefixed refs.
  const refs = await ghOrNull(`${repo}/git/matching-refs/heads/${catDir}`, token) || []
  for (const r of refs) {
    const name = String(r.ref || '').replace(/^refs\/heads\//, '').slice(catDir.length)
    const m = /^(\d+)-(.+)$/.exec(name)
    if (m && !m[2].includes('/')) {
      add(Number(m[1]), m[2])
      if (!live.has(m[2])) live.set(m[2], Number(m[1]))
    }
  }
  return { taken, live }
}

// Allocate the spec number. A live branch with this slug is this spec's own
// earlier attempt, so reuse its number. A merged file with that slug is not:
// two notes can share a title, and reusing it overwrites the other's file.
async function allocateSpecNumber (repo, base, token, specsDir, catDir, titleNum, specSlug) {
  const { taken, live } = await takenSpecNumbers(repo, base, token, specsDir, catDir)
  const inFlight = live.get(specSlug)
  if (inFlight != null) return String(inFlight).padStart(3, '0')
  if (titleNum) {
    if (!taken.has(Number(titleNum))) return titleNum
    console.warn(`spec number ${titleNum} already taken; allocating sequentially for "${specSlug}"`)
  }
  const max = taken.size ? Math.max(...taken.keys()) : 0
  return String(max + 1).padStart(3, '0')
}

// Type/scope for the commit + PR title; a specs-only repo can drop the default.
function commitPrefix (roles) {
  const raw = roles && roles['commit-prefix'] != null ? String(roles['commit-prefix']).trim() : 'spec'
  const type = raw.replace(/:+$/, '')
  return type ? `${type}: ` : ''
}

// The spec file a PR published, from the PR's own file list. PR numbers and
// path numbers diverge in any repo with other PRs or issues, so the file list
// is the only authoritative mapping. Null when the PR is gone or published no
// spec file. Callers that write to the result pass dir: branch slugs match
// across forks, so a re-linked PR can otherwise aim the write outside the
// specs dir. The charset stays slug-bound; the path lands in a contents URL.
async function specPathFromPr (repo, prNumber, token, dir = null) {
  const files = await ghOrNull(`${repo}/pulls/${prNumber}/files?per_page=100`, token)
  if (!Array.isArray(files)) return null
  const prefix = dir ? `${dir}/` : ''
  const f = files.find(f => /(^|\/)\d{3}-[\w.-]+(\.md|\/spec\.md)$/.test(f.filename) &&
    (dir == null || f.filename.startsWith(prefix)))
  return f ? f.filename : null
}

// Stamp a "Superseded by #M" banner into the spec this one replaces, on the
// replacement's own branch so it rides in the same PR. Same-repo, best-effort:
// the old spec file must be reachable on the base branch (the old spec merged). A
// cross-repo or not-yet-merged target is left to the webhook + board hide.
// ponytail: extend to the old PR's branch or a cross-repo stamp PR if replacing
// unmerged or cross-namespace specs becomes common.
async function stampSuperseded (repo, branch, baseSha, token, specsDir, oldN, byNum, byNs) {
  // The padded-number grep below is only a fallback for pre-board specs that
  // never had a PR.
  let path = await specPathFromPr(repo, oldN, token, specsDir.replace(/\/$/, ''))
  const pad = String(oldN).padStart(3, '0')
  if (!path) {
    const tree = await ghOrNull(`${repo}/git/trees/${baseSha}?recursive=1`, token)
    // Legacy NNN-slug/spec.md and the env-default prefix stay matchable: specs
    // published before a layout or specs-dir change live at the old paths. The
    // prefix is required unless the namespace publishes at the apex, so an
    // unrelated top-level dir like archive/012-x.md is never stamped.
    const prefixes = [...new Set([specsDir, `${SPECS_DIR}/`])].map(reEsc)
    const re = new RegExp(`^(?:${prefixes.join('|')})(?:[^/]+/)?${pad}-[^/]+(?:\\.md|/spec\\.md)$`)
    const hit = tree && tree.tree.find(e => e.type === 'blob' && re.test(e.path))
    if (hit) path = hit.path
  }
  if (!path) { console.warn(`supersede: ${byNs}#${oldN} spec file not found, stamp skipped`); return }
  const cur = await ghOrNull(`${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, token)
  if (!cur) return
  const banner = `> **Superseded by ${byNs}#${byNum}.**\n\n`
  const old = Buffer.from(cur.content, 'base64').toString()
  if (old.startsWith(banner)) return
  await gh('PUT', `${repo}/contents/${path}`, {
    message: `mark ${pad} superseded by #${byNum}`,
    content: Buffer.from(banner + old).toString('base64'),
    branch,
    sha: cur.sha
  }, token)
}

// Chosen git-author email for a user in a namespace: the per-namespace row, or
// the global default (namespace ''), or null to fall back to the account email.
async function preferredEmail (userId, namespace) {
  if (!userId) return null
  const { rows } = await pool.query(
    "SELECT namespace, email FROM spec_board_email WHERE user_id = $1 AND namespace IN ($2, '')",
    [userId, namespace])
  const pick = rows.find(r => r.namespace === namespace) || rows.find(r => r.namespace === '')
  return pick ? pick.email : null
}

// Map a set of GitHub logins to their HedgeDoc account (id, display name, email),
// keyed by lowercased login. Only logins with a linked account resolve.
async function reviewerIdentities (logins) {
  const map = new Map()
  if (!logins.length) return map
  const { rows } = await pool.query(
    `SELECT id, email, profile, profileid FROM "Users" WHERE profile IS NOT NULL
      AND profile::jsonb->>'provider' = 'github' AND lower(profile::jsonb->>'username') = ANY($1)`,
    [logins.map(l => l.toLowerCase())])
  for (const r of rows) {
    const p = parseProfile(r.profile)
    if (!/^\d+$/.test(String(p.id)) || ![String(p.id), `github:${p.id}`].includes(r.profileid)) continue
    const login = (p.username || '').toLowerCase()
    // Full name for the commit trailer, falling back to the login.
    if (login) map.set(login, { id: r.id, name: p.displayName || p.username || login, email: userEmail(r) })
  }
  return map
}

// Real name for a GitHub login, for the commit-author name when HedgeDoc has
// no display name (a non-GitHub owner account). Cached; '' when unresolved.
const ghNameCache = new Map()
async function ghDisplayName (login, token) {
  if (ghNameCache.has(login)) return ghNameCache.get(login)
  // ponytail: crude full reset instead of an LRU; also drops the process-lifetime
  // staleness of renamed users eventually. Bound matters, precision does not.
  if (ghNameCache.size >= 500) ghNameCache.clear()
  let name = ''
  try {
    name = (await gh('GET', `/users/${login}`, null, token)).name || ''
  } catch (e) {
    if (e.status !== 404) console.error('gh name:', e.message)
  }
  ghNameCache.set(login, name)
  return name
}

// Display names that signed a {>>@name: ...<<} message anywhere in the note,
// replies and resolved threads included: the PR opens only once every thread
// is resolved, so the live-thread parsers see nothing by then.
// Lowercased name to the spans of its signatures, so a signature can be
// checked against who wrote it.
function commentAuthors (text) {
  const fences = fenceRanges(text).ranges
  const inFence = pos => fences.some(([f, t]) => pos >= f && pos < t)
  const re = commentRe()
  const names = new Map()
  let m
  while ((m = re.exec(text)) !== null) {
    if (inFence(m.index)) continue
    const lead = m[1].length - m[1].trimStart().length
    const p = /^@([^:]{1,40}):/.exec(m[1].trimStart())
    if (!p) continue
    const name = p[1].trim()
    const start = m.index + 3 + lead + 1 + (p[1].length - p[1].trimStart().length)
    const key = name.toLowerCase()
    if (!names.has(key)) names.set(key, [])
    names.get(key).push({ start, end: start + name.length })
  }
  return names
}

// Reviewers beyond the roster: whoever commented on the note. A signature is
// typed text like any edit, so the same attestation applies: at least one
// {>>@name: ...<<} signature must have been written by that participant's
// own session. The editor signs comments with displayName || username, the
// same name resolved here. exclude holds ids already credited (author,
// approvers) and grows.
function commentReviewers (content, participants, exclude, authorship = []) {
  const names = commentAuthors(content)
  const out = []
  for (const u of participants) {
    if (exclude.has(u.id)) continue
    const p = parseProfile(u.profile)
    const name = p.displayName || p.username || ''
    const spans = names.get(name.toLowerCase())
    if (!spans || !spans.some(sp => ownSpan(authorship, sp, u.id))) continue
    exclude.add(u.id)
    out.push({ name, email: userEmail(u) || null })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

// Author is the note owner; reviewers are the roles.yml approvers on record
// (spec.approvedBy, approverUsers their accounts), then everyone else who
// commented, backed by HedgeDoc's authorship record. Each email prefers the
// person's per-namespace setting, then their account email.
async function commitIdentities (spec) {
  const token = await serviceTokenFor(spec.namespace)
  const ownerPref = await preferredEmail(spec.ownerId, spec.namespace)
  const authorEmail = ownerPref || spec.authorEmail
  const authorName = spec.authorDisplayName ||
    (spec.authorLogin && await ghDisplayName(spec.authorLogin, token)) ||
    spec.author || (authorEmail && authorEmail.split('@')[0]) || ''
  const author = authorEmail ? { name: authorName, email: authorEmail } : null
  const approvers = (spec.approvers || [])
    .filter(a => (spec.approvedBy || []).some(b => b.toLowerCase() === a.toLowerCase()))
    .map(a => spec.approverUsers && spec.approverUsers.get(a.toLowerCase()))
    .filter(Boolean)
  const participants = await participantUsers(spec.id, spec.namespace)
  const reviewers = await Promise.all(approvers.map(async u =>
    ({ name: u.name, email: (await preferredEmail(u.id, spec.namespace)) || u.email || null })))
  const credited = new Set(approvers.map(u => u.id))
  if (spec.ownerId) credited.add(spec.ownerId)
  reviewers.push(...commentReviewers(spec.content || '', participants, credited, spec.authorship || []))
  return { author, reviewers }
}

// The spec PR number doubles as the spec number: implementation commits
// reference it as "implements #N". Opened with the spec author's own GitHub
// token when available so the PR is genuinely theirs. category pins the subdir
// so a later tag change never re-paths an existing PR.
// Long dashes read as an editorial tic in generated PR titles and commits;
// normalise to a spaced hyphen.
const cleanTitle = t => String(t).replace(new RegExp('\\s*[\\u2014\\u2013]\\s*', 'g'), ' - ')

// A title like "SPEC-000 - Project Setup" carries its own number: use it as the
// spec number and drop it from the slug so the path is not doubly numbered.
// Untitled numbering (no SPEC-N prefix) leaves num null for the caller to allocate.
function numberedSlug (title) {
  const m = /^\s*spec[-\s]*(\d+)\W*/i.exec(String(title))
  return { num: m ? m[1].padStart(3, '0') : null, slug: slug(m ? title.slice(m[0].length) : title) }
}

// The body a spec publishes: CriticMarkup resolved, frontmatter dropped. Its
// hash is what "the note changed since it was published" is measured against.
const publishedBody = spec => stripFrontmatter(resolveCritic(spec.content))
const publishedHash = body => crypto.createHash('sha256').update(body).digest('hex')
const publicationRecovery = createPublicationRecovery(gh)

async function recordPublication (spec, prev, generation, write) {
  const result = await withTx(client => completePublication(client, spec.id, generation, write))
  if (result.state) Object.assign(prev, result.state)
  return result
}

async function recoverPublication (spec, prev) {
  const namespace = prev.namespace || spec.namespace
  const specsDir = spec.roles && spec.roles['specs-dir'] != null ? spec.roles['specs-dir'] : SPECS_DIR
  const options = { path: prev.spec_path, specsDir, topLevel: spec.topLevel,
    publishedCommit: prev.published_commit, publishedHash: prev.published_hash }
  if (prev.revision_pr) {
    const revision = await publicationRecovery.recover(namespace, prev.revision_pr,
      { ...options, revision: prev.revision || 1 })
    if (revision) return revision
    // The original PR must not replace the baseline of an earlier merged revision.
    if (prev.published_commit) return null
  }
  return prev.pr_number ? publicationRecovery.recover(namespace, prev.pr_number, options) : null
}

// Which revision an unpublished edit belongs to, or null when there is nothing
// to publish. Only a spec whose PR merged revises: while that PR is open the
// note is still what is under review.
function revisionPlan (prev, hash, prState) {
  if (prev.superseded_at) return null // a retired spec is never republished
  if (prev.pr_state !== 'merged' || !prev.published_hash || prev.published_hash === hash) return null
  const cur = prev.revision || 0
  const open = prev.revision_pr && prState(prev.revision_pr) === 'open'
  return { n: open ? Math.max(cur, 1) : cur + 1 }
}

// Approval freezes the note (HedgeDoc's own 'locked': anyone reads, only the
// owner edits) and reopening thaws it, or the reviewers who have to re-approve
// cannot edit. Both edges are one-shot, so a deliberate owner change in between
// is respected and never re-forced. Returns null for no change, else the
// permission to write plus the state to record. Rows locked before the pre-lock
// permission was recorded restore to 'editable' (HedgeDoc's own default): a
// spec back under review has to be editable by signed-in reviewers.
function lockPlan (status, approvable, prev, permission) {
  if (status === 'approved' && approvable && !prev.locked_at) {
    return { permission: 'locked', lockedAt: new Date().toISOString(), prelockPermission: permission || null }
  }
  if (status !== 'approved' && prev.locked_at) {
    // Only our own lock is lifted; an owner who locked it by hand keeps it.
    const restore = permission === 'locked' ? (prev.prelock_permission || 'editable') : permission
    return { permission: restore, lockedAt: null, prelockPermission: null }
  }
  return null
}

async function reconcilePermission (spec, prev, status) {
  const read = async client => (await client.query(`SELECT locked_at, prelock_permission, permission_intent, permission_lock_id
    FROM spec_board_state WHERE note_id=$1 FOR UPDATE`, [spec.id])).rows[0]
  const claimed = await withTx(async client => {
    assertWorkAllowed()
    const current = await read(client)
    if (!current) return null
    if (current.permission_intent) return current
    const plan = lockPlan(status, canApprove(spec), current, spec.permission)
    if (!plan) return current
    const intent = { plan, mutation: { operationId: crypto.randomUUID(), noteId: spec.id, operation: 'permission',
      expectedHash: contentHash(spec.content), expectedPermission: spec.permission || null, permission: plan.permission,
      ...(plan.lockedAt ? {} : { expectedLockId: current.permission_lock_id || null }) } }
    assertWorkAllowed()
    await upsertState({ id: spec.id, permissionIntent: intent }, client)
    return { ...current, permission_intent: intent }
  })
  if (!claimed) return
  Object.assign(prev, claimed)
  const intent = claimed.permission_intent
  if (!intent) return
  const owns = current => current && current.permission_intent && current.permission_intent.mutation.operationId === intent.mutation.operationId
  let result
  try {
    result = await mutateEditor(intent.mutation)
  } catch (error) {
    if (error.status === 412) {
      const current = await withTx(async client => {
        const row = await read(client)
        if (!owns(row)) return row
        await upsertState({ id: spec.id, permissionIntent: null }, client)
        return { ...row, permission_intent: null }
      })
      if (current) Object.assign(prev, current)
    }
    throw error
  }
  const plan = intent.plan
  const lockId = plan.lockedAt ? intent.mutation.operationId : null
  if (plan.lockedAt && !result.superseded && result.lockId !== lockId) throw new Error('Editor did not attest permission ownership')
  const line = result.superseded || intent.mutation.expectedPermission === intent.plan.permission ? null : plan.lockedAt
    ? `Locked "${spec.title}" after approval (owner can still edit): ${spec.url}`
    : `Unlocked "${spec.title}" after it left approved: ${spec.url}`
  const finished = await withTx(async client => {
    const current = await read(client)
    if (!owns(current)) return { applied: false, state: current }
    await upsertState({ id: spec.id, lockedAt: plan.lockedAt, prelockPermission: plan.prelockPermission,
      permissionIntent: null, permissionLockId: lockId }, client)
    if (line) await enqueueEmails(spec, [line], null, client)
    return { applied: true, state: { locked_at: plan.lockedAt, prelock_permission: plan.prelockPermission,
      permission_intent: null, permission_lock_id: lockId } }
  })
  if (finished.state) Object.assign(prev, finished.state)
  if (finished.applied) {
    spec.permission = result.permission
    if (line) await notify(line)
  }
}

const reqSummary = d => ['changed', 'added', 'removed'].filter(k => d[k].length).map(k => `${k} ${d[k].join(', ')}`).join('; ')

// The first lines of a revision PR: which requirement ids moved since the
// previous published text, and where to read the diff. The git diff shows
// the same, but a reviewer decides from this whether to open it.
function revisionNote (since, body, n, noteId) {
  const d = requirementDelta(requirementMap(since.body), requirementMap(body))
  const what = reqSummary(d) || 'wording only, no requirement id changed'
  const link = changesUrl(noteId, `?from=published:${since.label}&to=published:r${n}`)
  return `Since ${since.label}: ${what}.${link ? `\nDiff: ${link}` : ''}`
}

// ids: { author, reviewers } from commitIdentities; empty means the bot authors.
// poll: the tick's live { specs, state }, which the spec map is derived from;
// omitting it publishes without one.
// rev: { n, path, since } republishes an already-published spec as revision n
// of that path, instead of allocating a number and writing a new file; since
// is the previous published text, when on record.
async function openSpecPr (spec, category, ids = {}, rev = null, poll = null) {
  const catDir = category ? `${category}/` : ''
  // roles.yml `specs-dir`, normalized at load: '' = repo apex. Ungoverned
  // namespaces (no roles.yml) publish under the env default.
  const nsDir = spec.roles && spec.roles['specs-dir'] != null ? spec.roles['specs-dir'] : SPECS_DIR
  const specsDir = nsDir ? `${nsDir}/` : ''
  const pfx = commitPrefix(spec.roles)
  const title = cleanTitle(spec.title)
  const { num: titleNum, slug: specSlug } = numberedSlug(spec.title)
  const attempt = async (token) => {
    const repo = `/repos/${spec.namespace}`
    const { default_branch: base } = await gh('GET', repo, null, token)
    const { object: { sha } } = await gh('GET', `${repo}/git/ref/heads/${base}`, null, token)
    // A revision keeps the number and path that merged: re-deriving them from
    // the title would move the file whenever the title is edited.
    // A top-level spec has no number: it lives at the specs-dir root under its
    // slug alone, and a revision of one finds no number in its path either.
    const num = rev
      ? (/(?:^|\/)(\d+)-/.exec(rev.path) || [])[1] || ''
      : spec.topLevel ? '' : await allocateSpecNumber(repo, base, token, specsDir, catDir, titleNum, specSlug)
    const specPath = rev ? rev.path : spec.topLevel ? `${specsDir}${specSlug}.md` : `${specsDir}${catDir}${num}-${specSlug}.md`
    // Revision branches are the spec's own branch name plus -rN, so each
    // revision gets its own head even after the previous one merged. The
    // (?:/spec)? arm keeps legacy NNN-slug/spec.md paths on a flat branch name.
    const relPath = specPath.startsWith(specsDir) ? specPath.slice(specsDir.length) : specPath
    // ponytail: a top-level slug that equals an area dir name collides with that
    // area's branch prefix; rename the note if it ever happens.
    const branch = rev
      ? `${relPath.replace(/(?:\/spec)?\.md$/, '')}-r${rev.n}`
      : spec.topLevel ? specSlug : `${catDir}${num}-${specSlug}`
    const owner = spec.namespace.slice(0, spec.namespace.indexOf('/'))
    const existingPath = `${repo}/pulls?state=all&head=${owner}:${encodeURIComponent(branch)}&per_page=100`
    const existing = await gh('GET', existingPath, null, token)
    if (!Array.isArray(existing)) throw new Error('Invalid publication PR listing')
    const sameRepo = p => !p.head?.repo?.full_name || p.head.repo.full_name.toLowerCase() === spec.namespace.toLowerCase()
    const recoverMerged = async number => {
      const recovered = await publicationRecovery.recover(spec.namespace, number,
        { path: rev && rev.path, specsDir: nsDir, branch, topLevel: spec.topLevel, revision: rev && rev.n }, token)
      if (!recovered) throw Object.assign(new Error('Publication merge could not be confirmed'), { code: 'publication-baseline' })
      return recovered
    }
    const merged = existing.filter(p => p.merged_at && sameRepo(p)).sort((a, b) => b.number - a.number)[0]
    if (merged && !existing.some(p => p.state === 'open' && sameRepo(p))) return recoverMerged(merged.number)
    try {
      await gh('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha }, token)
    } catch (e) {
      // 422 = branch left over from a failed or closed earlier attempt; reuse it.
      if (e.status !== 422) throw e
    }
    const body = publishedBody(spec)
    // Updating an existing file needs its blob sha; a leftover branch already
    // holds the spec file, so look it up instead of failing the create-only PUT.
    const cur = await ghOrNull(`${repo}/contents/${specPath}?ref=${encodeURIComponent(branch)}`, token)
    // Gerrit-style trailers: a stable spec id, a link back to the reviewable
    // note, and a Reviewed-by per approver who signed off and per commenter.
    const trailers = [
      `Spec-Id: ${spec.id}`,
      `Reviewed-on: ${spec.url}`,
      ...(ids.reviewers || []).map(id => id.email ? `Reviewed-by: ${id.name} <${id.email}>` : `Reviewed-by: @${id.name}`),
      ...(spec.supersedes && !rev ? [`Supersedes: ${spec.supersedes.noteId || `${spec.supersedes.ns}#${spec.supersedes.n}`}`] : [])
    ].join('\n')
    // The bot commits, but the human wrote the spec: the git author is the note
    // owner (committer stays the app). GitHub links the commit to whatever
    // account has this email verified. No author identity means the bot authors.
    const author = ids.author || null
    await gh('PUT', `${repo}/contents/${specPath}`, {
      message: `${pfx}${rev ? 'update' : 'add'} ${num ? num + ' ' : ''}${title}\n\n${trailers}`,
      content: Buffer.from(body).toString('base64'),
      branch,
      ...(author ? { author } : {}),
      ...(cur ? { sha: cur.sha } : {})
    }, token)
    // The stamp also runs on the reuse path: a crash between PR create and
    // state write must not lose the banner. Idempotent via its startsWith
    // guard.
    const stamp = async (prNumber) => {
      // The supersede rides in the original PR; a revision of the replacement
      // must not stamp the retired spec a second time.
      if (spec.supersedes && !rev && spec.supersedes.ns === spec.namespace) {
        await stampSuperseded(repo, branch, sha, token, specsDir, spec.supersedes.n, prNumber, spec.supersedes.ns)
          .catch(e => console.warn('supersede stamp:', e.message))
      }
      // No map at the repo apex, where README.md is the project's own.
      if (poll && specsDir) {
        await writeNamespaceMap(repo, branch, token, `${specsDir}README.md`, `${pfx}update spec map`,
          namespaceMapDoc(poll.specs, poll.state, spec, prNumber), author
        ).catch(e => console.warn('spec map:', e.message))
      }
      return { number: prNumber, path: specPath, state: 'open', body, hash: publishedHash(body), commit: null }
    }
    // A PR can merge while its branch is being updated. Reconcile that merge
    // before the caller records the newly pushed text as its baseline.
    const refreshed = await gh('GET', existingPath, null, token)
    if (!Array.isArray(refreshed)) throw new Error('Invalid publication PR listing')
    const reuse = refreshed.find(p => p.state === 'open' && sameRepo(p))
    if (reuse) return stamp(reuse.number)
    const landed = refreshed.filter(p => p.merged_at && sameRepo(p)).sort((a, b) => b.number - a.number)[0]
    if (landed) return recoverMerged(landed.number)
    const abstract = specAbstract(body)
    const pr = await gh('POST', `${repo}/pulls`, {
      title: `${pfx}${title}${rev ? ` (rev ${rev.n})` : ''}`,
      head: branch,
      base,
      body: (rev && rev.since ? revisionNote(rev.since, body, rev.n, spec.id) + '\n\n' : '') + (abstract ? abstract + '\n\n' : '') + `Spec note: ${spec.url}`
    }, token)
    return stamp(pr.number)
  }
  if (spec.ownerToken) {
    try {
      return await attempt(spec.ownerToken)
    } catch (e) {
      // Editor login does not request repo scope, so most author tokens can
      // reach the namespace repo only if it is public; a private one is
      // invisible to them and answers 404 rather than 403.
      if (![401, 403, 404].includes(e.status)) throw e
      console.error(`spec pr: author token rejected for ${spec.id}, using service token`)
    }
  }
  return attempt(await serviceTokenFor(spec.namespace))
}

// "depends-on" is list-valued and takes the same forms as supersedes. A repeated
// target is a typo rather than a second edge; a note naming its own shortid is
// dropped here, and the ns#pr spelling of the same thing is dropped in
// specGraph, which is the first place a note knows its own number.
function dependsOnRefs (meta, defaultNs, selfId) {
  const refs = []
  const seen = new Set()
  for (const v of normList(meta['depends-on'])) {
    const ref = specRef(v, defaultNs)
    if (!ref || (ref.noteId && ref.noteId === selfId)) continue
    const key = ref.noteId || `${ref.ns}#${ref.n}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push(ref)
  }
  return refs
}

// skip: ids that never become implemented (top-level specs). State rows do
// not record the kind, so the tick's specs list is where the set comes from.
async function scanImplements (state, skip = new Set()) {
  const open = new Map()
  const openNamespaces = new Set()
  for (const [id, s] of state) {
    if (s.pr_number && !s.implemented_at && s.namespace && !skip.has(id)) {
      open.set(`${s.namespace}#${s.pr_number}`, id)
      openNamespaces.add(s.namespace)
    }
  }
  const status = { repositories: 0, commits: 0, pending: 0, oldestPendingAt: null, results: [], failures: [] }
  if (!open.size) return status
  // Implemented = the feature landed, which happens in the repos the
  // namespace declares as implementation-repos (default: the spec repo).
  const nsList = [...openNamespaces]
  const nsRoles = await Promise.all(nsList.map(ns => namespaceRoles(ns)))
  const scanRepos = new Set()
  nsList.forEach((ns, i) => {
    const declared = nsRoles[i] ? normList(nsRoles[i]['implementation-repos']) : []
    for (const repo of declared.length ? declared : [ns]) scanRepos.add(repo)
  })
  const scanner = createImplementationScanner({
    gh,
    load: async key => {
      const { rows } = await pool.query('SELECT value FROM spec_board_meta WHERE key = $1', [key])
      return rows[0]?.value
    },
    commitPage: async (repo, commits, cursor) => {
      assertWorkAllowed()
      const updates = new Map()
      for (const c of commits) {
        for (const ref of implementsRefs(c.commit.message, repo)) {
          const id = open.get(`${ref.ns}#${ref.n}`)
          if (!id || updates.has(id)) continue
          const s = state.get(id)
          const implementedAt = new Date().toISOString()
          const line = `Spec ${ref.ns}#${s.pr_number} implemented by ${repo}@${c.sha.slice(0, 10)} ("${c.commit.message.split('\n')[0]}")`
          updates.set(id, { id, s, ref, implementedAt, line, sha: c.sha })
        }
      }
      const applied = []
      await withTx(async client => {
        assertWorkAllowed()
        for (const update of [...updates.values()].sort((a, b) => a.id.localeCompare(b.id))) {
          const { id, s, ref, implementedAt, line, sha } = update
          const { rows: [current] } = await client.query('SELECT implemented_at FROM spec_board_state WHERE note_id = $1 FOR UPDATE', [id])
          if (!current) throw new Error('Implementation state disappeared while scanning')
          if (current.implemented_at) {
            applied.push({ ...update, implementedAt: current.implemented_at, line: null })
            continue
          }
          await upsertState({ id, implementedAt }, client)
          await enqueueEmails({ id, title: `${ref.ns}#${s.pr_number}`, namespace: s.namespace, url: `${BASE_URL}/${id}` },
            [digestEvent('activity', line, { url: `https://github.com/${repo}/commit/${sha}`, noteUrl: `${BASE_URL}/${id}`, namespace: s.namespace })], null, client)
          applied.push(update)
        }
        await client.query(`INSERT INTO spec_board_meta (key, value) VALUES ($1, $2)
          ON CONFLICT (key) DO UPDATE SET value = $2`, [implementationCursorKey(repo), JSON.stringify(cursor)])
      })
      for (const { s, ref, implementedAt, line } of applied) {
        s.implemented_at = implementedAt
        open.delete(`${ref.ns}#${ref.n}`)
        if (line) await notify(line)
      }
    }
  })
  const errors = []
  for (const repo of scanRepos) {
    try {
      const result = await scanner.scanRepository(repo)
      status.repositories++
      status.commits += result.commits
      status.results.push(result)
      if (result.pending) {
        status.pending++
        status.oldestPendingAt = status.oldestPendingAt === null ? result.startedAt : Math.min(status.oldestPendingAt, result.startedAt)
      }
    } catch (error) {
      errors.push(error)
      status.failures.push({ repo, code: error.code || 'unavailable' })
    }
  }
  if (errors.length) throw Object.assign(new AggregateError(errors, `Implementation scans failed for ${errors.length} repositories`), { code: 'implementation-scan', scanStatus: status })
  return status
}

// HedgeDoc permissions that hide a note from guests: 'limited'/'protected'
// need a login, 'private' is owner-only. The board is unauthenticated and its
// search matches note bodies, so none may reach a snapshot. Null reads public.
const publicSpecs = specs => specs.filter(s => s.permission == null ||
  ['freely', 'editable', 'locked'].includes(s.permission))

async function currentPublicNote (id, db = pool) {
  const { rows } = await db.query(`SELECT 1 FROM "Notes" WHERE shortid = $1
    AND (permission IS NULL OR permission IN ('freely', 'editable', 'locked'))`, [id])
  return rows.length > 0
}

async function currentVisibleSpecs (specs, db = pool) {
  if (!specs.length) return []
  const { rows } = await db.query(`SELECT shortid FROM "Notes" WHERE shortid=ANY($1::text[])
    AND (permission IS NULL OR permission IN ('freely', 'editable', 'locked'))`, [specs.map(s => s.id)])
  const visible = new Set(rows.map(r => r.shortid))
  return specs.filter(s => visible.has(s.id))
}

async function visibleSnapshot () {
  const cached = snapshot
  const specs = await currentVisibleSpecs(cached.specs)
  const ids = new Set(specs.map(s => s.id))
  const state = new Map([...cached.state].filter(([id]) => ids.has(id)))
  return { ...cached, specs, state, graph: specGraph(specs, state) }
}

// Board data served to every request: rebuilt by the poller (or, on replicas
// that lose the poll lock, read straight from the DB the winner writes to),
// never per-request. Spec copies carry no ownerToken: a live OAuth token must
// not sit in a long-lived global the render path touches. The poller still
// works the notes filtered out here; they are only kept off the page.
// Starts empty rather than null so every reader is spared the null case; `at: 0`
// keeps it stale until the first poll lands.
let snapshot = { specs: [], state: new Map(), graph: [], at: 0 }
// A tick that keeps beating (long bot reviews) leaves the live snapshot old
// but the poller alive, so age alone does not make it stale.
const snapshotStale = (snap = snapshot) =>
  !snap.at || (Date.now() - snap.at > POLL_SECONDS * 3000 && (snap !== snapshot || pollStale()))
function setSnapshot (specs, state) {
  // The graph is built here, not per request: /map is unauthenticated.
  const shown = publicSpecs(specs).map(({ ownerToken, ...s }) => s)
  snapshot = { specs: shown, state, graph: specGraph(shown, state), at: Date.now() }
}

// Read-only rebuild for startup and lock-losing replicas. cacheOnly roles: it
// must never block on a live GitHub fetch.
async function refreshSnapshot () {
  const state = await loadState()
  const specs = await rolesForSpecs(specsFromRows(await queryNotes(), state), true)
  setSnapshot(specs, state)
}

let polling = false
let lastPollOk = 0
// A tick can outlast the stale window on its own (REVIEWS_PER_TICK bot calls
// of REVIEW_TIMEOUT_MS each), so progress inside a tick counts as life too.
let lastPollBeat = 0
const beat = () => { lastPollBeat = Date.now() }
// One definition of "the poller is stale" for the board banner, the
// namespaces API, and healthz.
const pollStale = () => !lastPollOk || Date.now() - Math.max(lastPollOk, lastPollBeat) > POLL_SECONDS * 3000
// Cross-replica mutex for everything with side effects (PRs, note locks,
// emails, webhooks, startup migration). Session-scoped, so it must be taken
// and released on one dedicated connection, not through pool.query.
const ADVISORY_LOCK_KEY = 0x53504543 // 'SPEC'
async function withAdvisoryLock (blocking, fn) {
  const client = await pool.connect()
  const lease = new AbortController()
  const lost = error => lease.abort(error)
  client.on('error', lost)
  try {
    const fnName = blocking ? 'pg_advisory_lock' : 'pg_try_advisory_lock'
    const { rows: [l] } = await client.query(`SELECT ${fnName}($1) AS ok`, [ADVISORY_LOCK_KEY])
    if (!blocking && !l.ok) return false
    leadership = lease
    await fn()
    if (lease.signal.aborted) throw new Error('Poll leadership connection was lost')
    return true
  } finally {
    // The pool reuses sessions, so a leaked lock would outlive the tick;
    // if the unlock cannot be confirmed, destroy the client and let the
    // dying session free it.
    try {
      await client.query('SELECT pg_advisory_unlock_all()')
      client.release()
    } catch (e) {
      client.release(true)
    }
    client.removeListener('error', lost)
    if (leadership === lease) leadership = null
  }
}

async function poll () {
  if (polling || lifecycle.stopping) return
  polling = true
  try {
    const ran = await withAdvisoryLock(false, pollTick)
    // Another replica is mid-tick; it does the side-effect work, so this is a
    // healthy skip. Refresh the local snapshot from the DB it writes to.
    if (!ran) {
      await refreshSnapshot()
      lastPollOk = Date.now()
    }
  } catch (e) {
    console.error('poll:', e)
  } finally {
    polling = false
  }
}

// The review sees a spec as its resolved, frontmatter-stripped prose. The
// hash guards on the same text the model reads, so the bot's own comments,
// their resolution, and tag shuffles never re-trigger a review.
function reviewBody (content) {
  return resolveCritic(stripFrontmatter(content))
}

// What a spec under review inherits: the namespace's approved top-level specs,
// resolved the way they publish. Goes into the system prompt, never the user
// turn: injectComments anchors a finding by a verbatim quote of the note, and
// text from another document would anchor nowhere, or worse, somewhere.
function reviewContext (spec, specs, state) {
  const tops = publicSpecs(specs).filter(s => s.topLevel && s.id !== spec.id && s.namespace === spec.namespace &&
    s.statusIdx >= APPROVED_IDX && !(state.get(s.id) || {}).superseded_at)
  if (!tops.length) return ''
  // A published body carries its own heading; nothing to add on top.
  const docs = tops.map(s => publishedBody(s).trim()).join('\n\n')
  const clipped = docs.length > REVIEW_CONTEXT_MAX_CHARS ? docs.slice(0, REVIEW_CONTEXT_MAX_CHARS) + '\n\n[truncated]' : docs
  return '\n\nThe project\'s top-level specs follow. Every spec inherits them: flag any statement in the spec under review that contradicts one, naming its ID (for example P4). Quote only the spec under review, never this text.\n\n' + clipped
}

// Whitespace collapses before hashing: neither formatting-only edits nor the
// blank lines injection leaves behind (e.g. a tail landed above an unclosed
// fence) count as new prose.
function reviewHash (content) {
  return crypto.createHash('sha256').update(reviewBody(content).replace(/\s+/g, ' ').trim()).digest('hex')
}

function reviewFingerprint (bot, body, context) {
  return 'v2:' + contentHash(JSON.stringify([bot.url, bot.model, bot.prompt || REVIEW_SYSTEM,
    body.replace(/\s+/g, ' ').trim(), context]))
}

const REVIEW_SEVERITIES = ['nit', 'question', 'issue']

const REVIEW_SYSTEM = 'You review technical design specs for Linux networking projects. Reply with JSON only. Emit one comment per substantive problem: protocol or addressing mistakes, missing failure modes, unstated assumptions, contradictions. "quote" must be a short verbatim substring of the spec, on a single line. "comment" is one terse sentence. No style or formatting remarks. Return an empty array if the spec is sound.'

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    comments: {
      type: 'array',
      maxItems: REVIEW_MAX_COMMENTS,
      items: {
        type: 'object',
        properties: {
          quote: { type: 'string', maxLength: 200 },
          severity: { type: 'string', enum: REVIEW_SEVERITIES },
          comment: { type: 'string', maxLength: 500 }
        },
        required: ['quote', 'comment']
      }
    }
  },
  required: ['comments']
}

async function callBotJson (bot, system, user, name, schema, maxTokens) {
  const headers = { 'Content-Type': 'application/json' }
  if (bot.api_key) headers.Authorization = `Bearer ${bot.api_key}`
  tickStats.bots++
  // The host check ran on the configured url; a redirect would carry the
  // note and the key to a host it never saw.
  const res = await fetch(`${bot.url}/v1/chat/completions`, {
    method: 'POST',
    redirect: 'error',
    headers,
    signal: outboundSignal(REVIEW_TIMEOUT_MS),
    body: JSON.stringify({
      model: bot.model,
      temperature: 0.2,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      response_format: { type: 'json_schema', json_schema: { name, schema } }
    })
  })
  if (!res.ok) throw new Error(`${bot.name} ${res.status}`)
  const data = await res.json()
  return JSON.parse(data.choices[0].message.content)
}

// context rides behind an operator's own prompt too: it is corpus, not style.
async function callBot (bot, specBody, context = '') {
  const parsed = await callBotJson(bot, (bot.prompt || REVIEW_SYSTEM) + context, specBody, 'review', REVIEW_SCHEMA, 1024)
  if (!Array.isArray(parsed.comments)) throw new Error(`${bot.name}: no comments array`)
  return parsed.comments
}

// A second job for the same bot row, with its own prompt: the per-spec review
// prompt is operator-editable and scoped to one document, and this reads the
// whole corpus at once.
const OVERLAP_SYSTEM = 'You are given every approved spec in one project. Find pairs of specs that overlap: two specs that describe the same mechanism, or that state requirements which cannot both hold. A spec whose area is top-level states principles every other spec inherits: also report a spec that contradicts one of its principles, naming the principle ID in "why". Reply with JSON only. "a" and "b" are the two spec numbers as integers. "why" is one terse sentence naming the specific thing they both claim, quoting the wording where it helps. Report only genuine overlap or contradiction, never a spec merely being related to or building on another. Return an empty array when the corpus is coherent.'

const OVERLAP_SCHEMA = {
  type: 'object',
  properties: {
    overlaps: {
      type: 'array',
      maxItems: OVERLAP_MAX_FINDINGS,
      items: {
        type: 'object',
        properties: {
          a: { type: 'integer' },
          b: { type: 'integer' },
          why: { type: 'string', maxLength: 300 }
        },
        required: ['a', 'b', 'why']
      }
    }
  },
  required: ['overlaps']
}

// Findings the admin was last shown, keyed to the head they were computed at.
// The cut reuses them rather than asking the model again: a second pass answers
// differently, and the count acknowledged on the page would stop matching the
// one the cut demands.
// ponytail: a spec revised on the board but not yet republished keeps the
// findings the last pass produced, since head is all that invalidates them.
const overlapCache = new Map() // ns -> { head, result }

// Advisory overlap findings for one namespace's live corpus, from whichever
// enabled bot already reviews that namespace. No bot means no findings, which
// is not an error: the rest of the checkpoint gate stands on its own.
async function findOverlap (ns, nodes, specs) {
  const mine = nodes.filter(n => n.ns === ns && n.n)
  if (mine.length < 2) return { findings: [], bot: null, skipped: [] }
  const bot = (await loadBots()).find(b => b.namespaces.includes(ns))
  if (!bot) return { findings: [], bot: null, skipped: [] }
  const byId = new Map(specs.map(s => [s.id, s]))
  const corpus = overlapCorpus(mine, id => {
    const s = byId.get(id)
    return s ? publishedBody(s) : ''
  })
  const parsed = await callBotJson(bot, OVERLAP_SYSTEM, corpus.text, 'overlap', OVERLAP_SCHEMA, 2048)
  return {
    bot: bot.name,
    skipped: corpus.skipped,
    findings: parseOverlap(parsed.overlaps, mine).slice(0, OVERLAP_MAX_FINDINGS)
  }
}

const CHANGELOG_SYSTEM = 'You are given what changed in one project\'s specs since its last checkpoint: a list of everything that changed, then the full text of each added spec and of any revised spec whose earlier text is not on record, then for each other revised spec its changed requirement ids and a diff excerpt with [-removed-] and {+added+} marks. Write one plain paragraph of at most four sentences saying what changed for a reader of the specs. Name specs by number. No headings, no lists, no praise, no guesses at intent; if a spec only changed wording, say so. Reply with JSON only.'
const CHANGELOG_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string', maxLength: 600 } },
  required: ['summary']
}

// One paragraph of model prose for the tag message; the braces go for the
// same reason as in reviewText, and the cap matches the schema's.
function parseSummary (parsed) {
  const text = parsed && typeof parsed.summary === 'string' ? parsed.summary : ''
  return text.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, 600)
}

// The changelog's advisory paragraph, from the namespace's review bot. Reads
// the specs added or revised since the last cut (their published bodies, via
// the same corpus builder the overlap pass uses) and the mechanical lines, so
// a retirement can be mentioned without its body. Nothing to read means no
// paragraph rather than a paragraph about nothing.
async function summarizeChanges (ns, changes, nodes, specs) {
  if (!changes || !(changes.added.length + changes.revised.length)) return null
  const bot = (await loadBots()).find(b => b.namespaces.includes(ns))
  if (!bot) return null
  // A new spec is described from its text; a revised one from what moved,
  // so the paragraph is about the change rather than the spec.
  const ids = new Set([...changes.added, ...changes.revised.filter(e => !e.requirements)].map(e => e.id))
  const byId = new Map(specs.map(s => [s.id, s]))
  const corpus = overlapCorpus(nodes.filter(n => ids.has(n.id)), id => {
    const s = byId.get(id)
    return s ? publishedBody(s) : ''
  })
  const revised = changes.revised.filter(e => e.requirements)
    .map(e => `### spec ${e.label}: ${e.title} revised (${e.requirements.from} to ${e.requirements.to}): ${reqSummary(e.requirements) || 'wording only'}\n${e.requirements.excerpt}\n`)
    .join('\n')
  const lines = CHANGE_KINDS.flatMap(k => changes[k].map(e => changeLine(k, e)))
  const parsed = await callBotJson(bot, CHANGELOG_SYSTEM, `since ${changes.from}:\n${lines.join('\n')}\n\n${corpus.text}\n${revised}`, 'changelog', CHANGELOG_SCHEMA, 400)
  return { bot: bot.name, summary: parseSummary(parsed) }
}
// ponytail: same head-keyed shape as overlapCache, kept apart because an
// errored summary is cached too (a failing bot must not re-fire on every
// page load) while an errored overlap pass is not.
const summaryCache = new Map() // ns -> { head, summary }

// Thread text for one bot finding. Stripping braces kills every CriticMarkup
// delimiter the model could emit ({>>, <<}, {--, ...) in one move; braces in
// review prose are expendable. The @<bot>: prefix the caller adds also
// guarantees the payload can never equal the bare resolve sentinel.
function reviewText (c) {
  const text = String(c.comment || '').replace(/\s+/g, ' ').replace(/[{}]/g, '').trim().slice(0, 500)
  if (!text) return ''
  const sev = REVIEW_SEVERITIES.includes(c.severity) ? `${c.severity}: ` : ''
  return sev + text
}

// Insert each finding as a {>>@<bot>: ...<<} thread right after the first
// occurrence of its quote, never inside frontmatter, fenced code, or an
// existing comment's braces. Unanchorable findings append at the end as
// separate threads. Returns the new content, or null when there is nothing to
// write: no findings, or every one already in the note (the dedup that makes
// a replayed review a no-op, and is per bot because the name is part of the
// matched string).
// edits collects [position, length] of each insertion in application order,
// each in the coordinates of the text at that point, for shiftAuthorship.
function injectComments (content, comments, botName, edits = []) {
  const { end } = frontmatter(content)
  // No newline after the closing --- means no body at all; bodyStart must not
  // fall back into the frontmatter, or anchoring corrupts the YAML.
  const bodyNl = end === -1 ? -1 : content.indexOf('\n', end + 1)
  const bodyStart = end === -1 ? 0 : (bodyNl === -1 ? content.length : bodyNl + 1)
  const excluded = fenceRanges(content).ranges
  const re = commentRe()
  let m
  while ((m = re.exec(content)) !== null) excluded.push([m.index, m.index + m[0].length])
  const inExcluded = pos => excluded.some(([f, t]) => pos >= f && pos < t)

  const inserts = []
  const tail = []
  for (const c of comments.slice(0, REVIEW_MAX_COMMENTS)) {
    const t = reviewText(c)
    if (!t) continue
    const marked = `{>>@${botName}: ${t}<<}`
    const tailMarked = `{>>@${botName}: [no anchor] ${t}<<}`
    if (content.includes(marked) || content.includes(tailMarked)) continue
    const quote = String(c.quote || '').trim()
    let pos = -1
    if (quote) {
      let i = content.indexOf(quote, bodyStart)
      while (i !== -1 && (inExcluded(i) || inExcluded(i + quote.length))) i = content.indexOf(quote, i + 1)
      if (i !== -1) pos = i + quote.length
    }
    if (pos === -1) tail.push(tailMarked)
    else inserts.push([pos, marked])
  }
  if (!inserts.length && !tail.length) return null
  let out = content
  for (const [pos, text] of inserts.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, pos) + text + out.slice(pos)
    edits.push([pos, text.length])
  }
  // Blank lines between appended threads so adjacency-merge keeps them
  // separate. A note ending inside an unclosed fence would swallow the
  // append (fenced {>>...<<} neither renders nor counts); land it above the
  // fence instead.
  if (tail.length) {
    const block = tail.join('\n\n')
    const { open } = fenceRanges(out)
    if (open !== -1) {
      out = out.slice(0, open) + block + '\n\n' + out.slice(open)
      edits.push([open, block.length + 2])
    } else {
      const kept = out.replace(/\n*$/, '')
      out = kept + '\n\n' + block + '\n'
      edits.push([kept.length, out.length - kept.length - 1])
    }
  }
  return out
}

const CRITIC_SPAN = /\{(~~|\+\+|--)[\s\S]*?\1\}/g
// Bot prose must not close the markup it sits in.
const critSafe = text => String(text || '').replace(/[{}]/g, '').replace(/~>/g, '~ >').trim()

// Each proposal becomes a substitution the editor can accept or reject, with
// the bot's reasoning as a thread beside it. A quote the live text no longer
// holds, or one already taken by another proposal, becomes a thread alone.
// Returns null when nothing new is written; ids report where each landed.
function placeProposals (content, proposals, botName, edits = []) {
  const { end } = frontmatter(content)
  const bodyNl = end === -1 ? -1 : content.indexOf('\n', end + 1)
  const bodyStart = end === -1 ? 0 : (bodyNl === -1 ? content.length : bodyNl + 1)
  const excluded = fenceRanges(content).ranges
  for (const re of [commentRe(), CRITIC_SPAN]) {
    let m
    while ((m = re.exec(content)) !== null) excluded.push([m.index, m.index + m[0].length])
  }
  const inExcluded = (from, to) => excluded.some(([f, t]) => from < t && to > f)
  const source = p => `${p.sourceRepo || (p.job && p.job.repo)}#${p.sourceNumber || (p.job && p.job.number)}`
  const inserts = []
  const tail = []
  const placed = []
  const commented = []
  const already = []
  for (const p of proposals) {
    const why = `{>>@${botName}: ${critSafe(p.rationale)} (from ${source(p)})<<}`
    const sub = `{~~${critSafe(p.quote)}~>${critSafe(p.amendment)}~~}`
    const alone = `{>>@${botName}: [no anchor] Proposed for "${critSafe(p.anchor)}": ${critSafe(p.amendment)} ${critSafe(p.rationale)} (from ${source(p)})<<}`
    if (content.includes(sub + why)) { placed.push(p.id); already.push(p.id); continue }
    if (content.includes(alone)) { commented.push(p.id); already.push(p.id); continue }
    const quote = String(p.quote || '').trim()
    let i = quote ? content.indexOf(quote, bodyStart) : -1
    while (i !== -1 && inExcluded(i, i + quote.length)) i = content.indexOf(quote, i + 1)
    if (i === -1) { tail.push(alone); commented.push(p.id); continue }
    excluded.push([i, i + quote.length])
    inserts.push([i, '{~~'], [i + quote.length, `~>${critSafe(p.amendment)}~~}${why}`])
    placed.push(p.id)
  }
  if (already.length === proposals.length) return { content, placed, commented, changed: false }
  let out = content
  for (const [pos, text] of inserts.sort((a, b) => b[0] - a[0])) {
    out = out.slice(0, pos) + text + out.slice(pos)
    edits.push([pos, text.length])
  }
  if (tail.length) {
    const block = tail.join('\n\n')
    const { open } = fenceRanges(out)
    if (open !== -1) {
      out = out.slice(0, open) + block + '\n\n' + out.slice(open)
      edits.push([open, block.length + 2])
    } else {
      const kept = out.replace(/\n*$/, '')
      out = kept + '\n\n' + block + '\n'
      edits.push([kept.length, out.length - kept.length - 1])
    }
  }
  return { content: out, placed, commented, changed: true }
}

// Flips an approved or implemented status tag to in-review, leaving anything
// else alone; verified by re-parsing so a strange tags layout is untouched.
function retagInReview (content, edits = []) {
  const { end } = frontmatter(content)
  if (end === -1) return content
  const head = content.slice(0, end)
  const at = head.search(/^tags:/m)
  if (at === -1) return content
  const m = /\b(approved|implemented)\b/.exec(head.slice(at))
  if (!m) return content
  const pos = at + m.index
  const out = head.slice(0, pos) + 'in-review' + head.slice(pos + m[0].length) + content.slice(end)
  const tags = metaTags(frontmatter(out).meta)
  if (!tags.includes('in-review') || tags.includes('approved') || tags.includes('implemented')) return content
  edits.push([pos, 'in-review'.length - m[0].length])
  return out
}

// Writes queued proposals into a quiet, closed note. Null means try again
// later; a busy note surfaces as 409/412 from the editor.
async function applyProposals (spec, proposals, botName) {
  if (!settled(spec) || !publicSpecs([spec]).length) return null
  const { rows: current } = await pool.query('SELECT content, permission FROM "Notes" WHERE shortid=$1', [spec.id])
  if (!current.length || current[0].content !== spec.content) return null
  const edits = []
  const result = placeProposals(spec.content, proposals, botName, edits)
  let updated = result.content
  if (result.changed && laneIdx(spec, snapshot.state.get(spec.id)) >= APPROVED_IDX) updated = retagInReview(updated, edits)
  if (updated !== spec.content) {
    await mutateEditor({ operationId: crypto.randomUUID(), noteId: spec.id, operation: 'review',
      expectedHash: contentHash(spec.content), expectedPermission: spec.permission || null, content: updated })
    spec.content = updated
    if (spec.authorship) spec.authorship = shiftAuthorship(spec.authorship, edits)
    const hit = threadAnchors(updated).find(a => a.author === botName && /\(from [\w.-]+\/[\w.-]+#\d+\)$/.test(a.text))
    await notify(`${botName} proposed amendments to "${spec.title}": ${spec.url}${hit ? '#' + hit.id : ''}`)
  }
  return { placed: result.placed, commented: result.commented }
}

// Bot text belongs to nobody: atoms past an insertion move, an atom around
// it splits and leaves the gap uncovered, so a comment signature keeps
// pointing at the characters it was measured on after a review lands.
function shiftAuthorship (atoms, edits) {
  let out = atoms
  for (const [pos, len] of edits) {
    out = out.flatMap(a => {
      if (!Array.isArray(a)) return [a]
      const [id, s, e, ...rest] = a
      if (pos <= s) return [[id, s + len, e + len, ...rest]]
      if (pos >= e) return [a]
      return [[id, s, pos, ...rest], [id, pos + len, e + len, ...rest]]
    })
  }
  return out
}

// Per-tick ceilings, reset at the top of pollTick: at most REVIEWS_PER_TICK
// model calls across all bots, and a bot's first failure of any kind skips
// its remaining reviews this tick, so a dead or timing-out endpoint costs one
// wasted call per poll and never starves the other bots.
let reviewBudget = 0
const reviewFailedBots = new Set()
// Cross-tick backoff on top of the per-tick skip: a bot that keeps failing
// waits min(2^failures, 60) ticks between attempts instead of one wasted
// call per poll forever. In-memory by design (a restart is the manual
// retry), surfaced on /bots so a dead bot is visible without log-grepping.
const botHealth = new Map() // name -> { failures, retryTick, lastError, failingSince }
let tickCount = 0

async function botFailed (bot, error) {
  reviewFailedBots.add(bot.name)
  const health = botHealth.get(bot.name) || { failures: 0, failingSince: new Date().toISOString() }
  health.failures++
  health.retryTick = tickCount + Math.min(2 ** health.failures, 60)
  health.lastError = error.message
  botHealth.set(bot.name, health)
  if (health.failures === 1) await notify(`Review bot ${bot.name} failing: ${error.message}`)
  return health
}

// Same backoff for the GitHub publish paths: a spec that cannot publish at all
// otherwise spends a half-dozen API calls every tick forever.
const publishHealth = new Map() // note id -> { failures, retryTick }
const publishReady = id => {
  const h = publishHealth.get(id)
  return !h || tickCount >= h.retryTick
}
function publishFailed (id) {
  // ponytail: crude full reset instead of an LRU, matching ghNameCache. A
  // cleared map costs one extra attempt per spec, nothing more.
  if (publishHealth.size >= 1000) publishHealth.clear()
  const h = publishHealth.get(id) || { failures: 0 }
  h.failures++
  h.retryTick = tickCount + Math.min(2 ** h.failures, 60)
  publishHealth.set(id, h)
  return h
}

// contextOf is a thunk so the corpus filter runs only for a spec that is
// actually sent out, not for every spec the tick walks past.
async function maybeReviewSpec (spec, bots, reviews, contextOf = () => '') {
  if (reviewBudget <= 0) return
  if (!REVIEW_STATUSES.has(COLUMNS[spec.statusIdx].tag)) return
  // A note hedgedoc hides from guests does not leave for a third-party endpoint.
  if (!publicSpecs([spec]).length) return
  if (!bots.some(b => b.namespaces.includes(spec.namespace))) return
  if (!settled(spec)) return
  // One body serves every bot: it is invariant across their writes, since
  // reviewBody strips the threads they add.
  const body = reviewBody(spec.content)
  const clipped = body.length > REVIEW_MAX_CHARS
    ? body.slice(0, REVIEW_MAX_CHARS) + '\n\n[spec truncated]' // ponytail: long specs get a head-only review; chunk if that ever hurts
    : body
  const context = await contextOf()
  for (const bot of bots) {
    if (lifecycle.stopping) return
    if (!bot.namespaces.includes(spec.namespace)) continue
    if (reviewFailedBots.has(bot.name) || reviewBudget <= 0) continue
    const health = botHealth.get(bot.name)
    if (health && tickCount < health.retryTick) continue
    const hash = reviewFingerprint(bot, clipped, context)
    if (reviews.get(reviewKey(spec.id, bot.name)) === hash) continue
    const { rows: current } = await pool.query('SELECT content, permission FROM "Notes" WHERE shortid=$1', [spec.id])
    if (!current.length || !publicSpecs(current).length || current[0].content !== spec.content) return
    reviewBudget--
    try {
      const comments = await callBot(bot, clipped, context)
      beat()
      const currentBot = (await loadBots()).find(b => b.name === bot.name && b.namespaces.includes(spec.namespace))
      if (!currentBot || reviewFingerprint(currentBot, clipped, context) !== hash) return
      const edits = []
      const updated = injectComments(spec.content, comments, bot.name, edits)
      if (updated !== null) {
        await mutateEditor({ operationId: crypto.randomUUID(), noteId: spec.id, operation: 'review',
          expectedHash: contentHash(spec.content), expectedPermission: spec.permission || null, content: updated })
        // The next bot's anchoring and optimistic guard must see this write;
        // the hash is unaffected (reviewBody strips comment threads).
        spec.content = updated
        if (spec.authorship) spec.authorship = shiftAuthorship(spec.authorship, edits)
        // Deep-link the notification to the first thread this run injected.
        const anchors = threadAnchors(updated)
        let anchor = ''
        for (const c of comments) {
          const t = reviewText(c)
          if (!t) continue
          const hit = anchors.find(a => a.author === bot.name && (a.text === t || a.text === `[no anchor] ${t}`))
          if (hit) { anchor = '#' + hit.id; break }
        }
        await notify(`${bot.name} left review comments on "${spec.title}": ${spec.url}${anchor}`)
      }
      // The hash lands only after the content write; a crash between the two
      // replays safely through injectComments' dedup.
      await pool.query(
        `INSERT INTO spec_board_reviews (note_id, bot_name, reviewed_hash) VALUES ($1, $2, $3)
         ON CONFLICT (note_id, bot_name) DO UPDATE SET reviewed_hash = $3`, [spec.id, bot.name, hash])
      botHealth.delete(bot.name)
    } catch (e) {
      if (lifecycle.stopping || [409, 412].includes(e.status)) return
      const h = await botFailed(bot, e)
      console.error(`review [${spec.id} "${spec.title}" ${bot.name}]:`, e.message, `(failure ${h.failures}, next attempt in ${h.retryTick - tickCount} ticks)`)
    }
  }
}

async function pollTick () {
  if (!publicationSchema.ready) publicationSchema = await publicationGuard(pool)
  tickCount++
  const tickStart = Date.now()
  tickStats.gh = 0
  tickStats.bots = 0
  reviewBudget = REVIEWS_PER_TICK
  reviewFailedBots.clear()
  // GC state for notes that are gone, but only rows carrying no
  // irreplaceable record: pr_number and implemented_at are the only proof a
  // PR was opened or a spec landed, and a note-destroy racing this DELETE
  // must not erase them. Seed rows (no PR yet) are safe to drop.
  await pool.query(`DELETE FROM spec_board_state s
    WHERE s.pr_number IS NULL AND s.implemented_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM "Notes" n WHERE n.shortid = s.note_id)`)
  await pool.query(`UPDATE spec_board_state s SET discussion_hashes = NULL
    WHERE s.discussion_hashes IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "Notes" n WHERE n.shortid = s.note_id)`)
  // Review rows carry nothing irreplaceable, so this GC needs no guards.
  await pool.query(`DELETE FROM spec_board_reviews r
    WHERE NOT EXISTS (SELECT 1 FROM "Notes" n WHERE n.shortid = r.note_id)
       OR NOT EXISTS (SELECT 1 FROM spec_board_bots b WHERE b.name = r.bot_name)`)
  await pool.query(`DELETE FROM spec_board_snapshots s
    WHERE NOT EXISTS (SELECT 1 FROM "Notes" n WHERE n.shortid = s.note_id)`)
  try {
    await pool.query(`DELETE FROM spec_board_snapshot_bodies b
      WHERE NOT EXISTS (SELECT 1 FROM spec_board_snapshots s WHERE s.hash = b.hash)`)
  } catch (error) {
    if (error.code !== '23503') throw error
    // A new approval referenced a body during this sweep; retry next tick.
  }
  // Per-user preference rows outlive the account otherwise: nothing here
  // references Users, so a deleted user leaks subscription/email rows forever.
  for (const t of ['spec_board_subscriptions', 'spec_board_email', 'spec_board_notify_email']) {
    await pool.query(`DELETE FROM ${t} p WHERE NOT EXISTS (SELECT 1 FROM "Users" u WHERE u.id::text = p.user_id)`)
  }
  const state = await loadState()
  const specs = await rolesForSpecs(specsFromRows(await queryNotes(), state))
  const bots = await loadBots()
  // Drop health for bots that were deleted or disabled, so the Map doesn't
  // accumulate dead entries across the process lifetime.
  const liveBots = new Set(bots.map(b => b.name))
  for (const name of botHealth.keys()) if (!liveBots.has(name)) botHealth.delete(name)
  const reviews = await loadReviews()
  const snapshots = await loadSnapshots()
  if (githubEnabled && SETTINGS_ENABLED) {
    await feedback.tick({ specs, state, bots, modelCall: feedbackModelCall }).catch(e => console.error('feedback:', e.message))
    beat()
  }
  // Index PRs only for namespaces that have (or could adopt) a spec PR, and
  // fetch them in parallel rather than serially.
  const prIdx = new Map()
  if (githubEnabled) {
    const needsPr = new Set()
    for (const s of specs) {
      if (!s.validNamespace) continue
      const st = state.get(s.id)
      if ((st && st.pr_number) || COLUMNS[s.statusIdx].tag === 'approved') needsPr.add(s.namespace)
    }
    const nsList = [...needsPr]
    const idxs = await Promise.all(nsList.map(ns => namespacePRIndex(ns)))
    nsList.forEach((ns, i) => prIdx.set(ns, idxs[i]))
  }
  for (const spec of specs) {
    // The drain deadline is shorter than a worst-case tick (reviews alone can
    // run minutes), so a tick that keeps going into a shutdown gets cut mid
    // publish, which is the orphan branch the drain exists to avoid. A spec
    // boundary is the safe place to stop; the next tick picks up the rest.
    if (lifecycle.stopping || (leadership && leadership.signal.aborted)) {
      console.log('draining: stopping the tick at a spec boundary')
      break
    }
    try {
      beat()
      const status = COLUMNS[spec.statusIdx].tag
      const prev = state.get(spec.id)
      let discussion = discussionState(spec.content, spec.url)
      const body = publishedBody(spec)
      const hash = publishedHash(body)
      const had = snapshots.get(spec.id) || []
      const snaps = await applySnapshotPlan(spec.id, had, snapshotPlan({
        status, prevStatus: prev ? prev.status : null, rows: had, hash,
        publishedHash: prev && prev.published_hash, revision: prev && prev.revision
      }), body, hash)
      // Approvals the text has moved past since they were given. Shown, never
      // dropped: the approver is told once per new text and decides.
      spec.staleApprovals = snaps.filter(r => r.kind === 'approval' && r.hash !== hash).map(r => r.label)
      if (prev) await notifyStaleApprovals(spec, snaps, hash)
      if (!prev) {
        // First sighting: seed silently so a fresh deploy doesn't spam
        // notifications or open PRs for the existing backlog.
        assertWorkAllowed()
        await pool.query(`INSERT INTO spec_board_state (note_id, status, comment_count, approvals, namespace, discussion_hashes)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (note_id) DO NOTHING`,
        [spec.id, status, spec.comments, spec.approvals, spec.namespace, discussion.baseline])
        continue
      }
      // Collected and sent only after the state write lands: notifying first
      // re-fires the same webhook every poll for as long as the write fails.
      const msgs = []
      if (prev.status !== status) {
        msgs.push(digestEvent('status', `Spec "${spec.title}" moved ${prev.status} -> ${status}: ${spec.url}`,
          { from: prev.status, to: status, url: spec.url, namespace: spec.namespace }))
      }
      if (REVIEW_STATUSES.has(status)) {
        if (mailer && discussionEvents(prev.discussion_hashes, discussion, spec).length) {
          const participants = await participantUsers(spec.id, spec.namespace)
          const authorship = parseAuthorship(spec.authorship)
          discussion = discussionState(spec.content, spec.url, (message, span) => {
            for (const user of participants) {
              const profile = parseProfile(user.profile)
              const name = profile.displayName || profile.username
              if (name === message.author && ownSpan(authorship, span, user.id)) return name
            }
            return ''
          })
        }
        msgs.push(...discussionEvents(prev.discussion_hashes, discussion, spec))
      }
      if (spec.approvers.length && spec.approvals > (prev.approvals || 0)) {
        msgs.push(digestEvent('approval', `Approval on "${spec.title}" (${spec.approvals}/${spec.required}): ${spec.url}`,
          { approvals: spec.approvals, required: spec.required, url: spec.url, namespace: spec.namespace }))
      }
      // Resolve the spec's PR: keep the recorded one (refreshing its open/
      // merged/closed state), or re-link by matching the head branch slug.
      const candidateIndex = prIdx.get(prev.pr_number && prev.namespace ? prev.namespace : spec.namespace)
      let publicationGeneration = null
      if (publicationSchema.ready && githubEnabled && spec.validNamespace &&
          (prev.pr_number || (status === 'approved' && canApprove(spec)) ||
           (candidateIndex && candidateIndex.bySlug.has(numberedSlug(spec.title).slug)))) {
        const claimed = await withTx(client => claimPublication(client, spec.id, assertWorkAllowed))
        if (!claimed) continue
        Object.assign(prev, claimed)
        if (prev.pr_number && prev.namespace && prev.namespace !== spec.namespace) continue
        publicationGeneration = claimed.publication_generation
      }
      const idx = prIdx.get(prev.pr_number && prev.namespace ? prev.namespace : spec.namespace)
      if (publicationGeneration !== null && prev.pr_number && idx) {
        const prState = prev.pr_state === 'merged' ? 'merged' : idx.byNumber.get(prev.pr_number) || prev.pr_state || 'open'
        const recorded = await recordPublication(spec, prev, publicationGeneration, client =>
          upsertState({ id: spec.id, prState, namespace: prev.namespace || spec.namespace }, client))
        if (!recorded.applied) continue
      } else if (publicationGeneration !== null && !prev.pr_number && idx) {
        const hit = idx.bySlug.get(numberedSlug(spec.title).slug)
        // A closed PR whose branch was deleted is a deliberate redo: leave the
        // spec unlinked so an approved one opens a fresh PR. A closed PR whose
        // branch survives is a rejection; keep it linked, or it reopens forever.
        if (hit && (hit.state !== 'closed' || await branchExists(spec.namespace, hit.ref))) {
          const recorded = await recordPublication(spec, prev, publicationGeneration, client =>
            upsertState({ id: spec.id, prNumber: hit.number, namespace: spec.namespace, prState: hit.state }, client))
          if (!recorded.applied) continue
        }
      }
      let publicationKnown = !!prev.published_hash
      if (publicationGeneration !== null && prev.pr_number && publishReady(spec.id) &&
          (prev.pr_state === 'merged' || prev.revision_pr)) {
        try {
          const recovered = await recoverPublication(spec, prev)
          if (recovered && idx) idx.byNumber.set(recovered.number, 'merged')
          if (recovered && !recovered.unchanged) {
            const recorded = await recordPublication(spec, prev, publicationGeneration, async client => {
              await upsertState({ id: spec.id, specPath: recovered.path, publishedHash: recovered.hash,
                publishedCommit: recovered.commit }, client)
              return takeSnapshot(spec.id, 'published', `r${recovered.revision}`, recovered.body, recovered.hash, client)
            })
            if (!recorded.applied) continue
            snaps.push(recorded.value)
          }
          publicationKnown = !!prev.published_hash
          publishHealth.delete(spec.id)
        } catch (error) {
          publicationKnown = false
          publishFailed(spec.id)
          console.error(`publication recovery [${spec.id}]:`, error.message)
        }
      }
      if (status === 'approved' && !canApprove(spec) && !prev.pr_number) {
        console.warn(`withholding PR for "${spec.title}": ${spec.approvals}/${spec.required} approved, ${spec.comments} unresolved comments, ${spec.suggestions} pending suggestions`)
      }
      await reconcilePermission(spec, prev, status).catch(error => {
        if (![409, 412].includes(error.status)) console.error('lock:', error.message)
      })
      // Open a PR only when an approved, quorum-cleared spec has none at all
      // (not even a closed one to link); retry on a backoff so a transient
      // GitHub failure never strands it and a permanent one never spins.
      if (publicationGeneration !== null && status === 'approved' && canApprove(spec) && !prev.pr_number && publishReady(spec.id)) {
        const cat = prev.category != null ? prev.category : spec.category
        try {
          const opened = await openSpecPr(spec, cat, await commitIdentities(spec), null, { specs, state })
          const prLine = `${opened.state === 'merged' ? 'Recovered merged' : 'Opened'} spec PR ${spec.namespace}#${opened.number} for "${spec.title}": https://github.com/${spec.namespace}/pull/${opened.number}`
          // namespace rides along: it is the other half of the PR's identity,
          // and the freeze below only pins what a state row already records.
          const recorded = await recordPublication(spec, prev, publicationGeneration, async client => {
            await upsertState({ id: spec.id, prNumber: opened.number, namespace: spec.namespace, category: cat,
              prState: opened.state, specPath: opened.path, publishedHash: opened.hash, publishedCommit: opened.commit }, client)
            await takeSnapshot(spec.id, 'published', 'r0', opened.body, opened.hash, client)
            await enqueueEmails(spec, [digestEvent('activity', prLine, { url: `https://github.com/${spec.namespace}/pull/${opened.number}`, noteUrl: spec.url, namespace: spec.namespace })], null, client)
          })
          if (!recorded.applied) continue
          publicationKnown = true
          publishHealth.delete(spec.id)
          await notify(prLine)
        } catch (e) {
          const h = publishFailed(spec.id)
          console.error(`spec pr [${spec.id} "${spec.title}" ${spec.namespace}]:`, e.message, `(failure ${h.failures}, next attempt in ${h.retryTick - tickCount} ticks)`)
          // An approved spec with no PR looks identical to one nobody approved,
          // so the failing edge is the only chance to say so out loud.
          if (h.failures === 1) await notify(`Spec PR failed for "${spec.title}" (${spec.namespace}): ${e.message}: ${spec.url}`)
        }
      }
      // pr_number stays the spec's identity: implements-detection and
      // supersedes both key on it. The namespace match extends the identity
      // freeze below to the write path, or edited frontmatter would push this
      // spec into another onboarded repo.
      if (publicationGeneration !== null && status === 'approved' && canApprove(spec) && prev.pr_number && prev.pr_state === 'merged' &&
          idx && publishReady(spec.id) && publicationKnown &&
          (!prev.namespace || prev.namespace === spec.namespace)) {
        const plan = revisionPlan(prev, hash, n => idx.byNumber.get(n))
        if (plan) {
          try {
            const specsDir = spec.roles && spec.roles['specs-dir'] != null ? spec.roles['specs-dir'] : SPECS_DIR
            let path = prev.spec_path
            if (!path) {
              path = await specPathFromPr(`/repos/${spec.namespace}`, prev.pr_number, await serviceTokenFor(spec.namespace), specsDir)
              if (!path) throw new Error(`no spec file found in #${prev.pr_number}`)
              const recorded = await recordPublication(spec, prev, publicationGeneration, client =>
                upsertState({ id: spec.id, specPath: path }, client))
              if (!recorded.applied) continue
            }
            const prevPub = lastRow(await loadNoteSnapshots(spec.id), 'published')
            const since = prevPub ? { label: prevPub.label, body: await snapshotBody(prevPub.id) } : null
            const opened = await openSpecPr(spec, prev.category, await commitIdentities(spec), { n: plan.n, path, since }, { specs, state })
            const reused = opened.number === prev.revision_pr
            const revLine = `${opened.state === 'merged' ? 'Recovered merged' : reused ? 'Updated' : 'Opened'} revision ${plan.n} PR ${spec.namespace}#${opened.number} for "${spec.title}": https://github.com/${spec.namespace}/pull/${opened.number}`
            const recorded = await recordPublication(spec, prev, publicationGeneration, async client => {
              await upsertState({ id: spec.id, revision: plan.n, revisionPr: opened.number, specPath: opened.path,
                publishedHash: opened.hash, publishedCommit: opened.commit || prev.published_commit }, client)
              await takeSnapshot(spec.id, 'published', `r${plan.n}`, opened.body, opened.hash, client)
              await enqueueEmails(spec, [digestEvent('activity', revLine, { url: `https://github.com/${spec.namespace}/pull/${opened.number}`, noteUrl: spec.url, namespace: spec.namespace })], null, client)
            })
            if (!recorded.applied) continue
            publishHealth.delete(spec.id)
            await notify(revLine)
          } catch (e) {
            const h = publishFailed(spec.id)
            console.error(`spec revision [${spec.id} "${spec.title}" ${spec.namespace}#${prev.pr_number}]:`, e.message, `(failure ${h.failures}, next attempt in ${h.retryTick - tickCount} ticks)`)
            if (h.failures === 1) await notify(`Spec revision failed for "${spec.title}" (${spec.namespace}#${prev.pr_number}): ${e.message}: ${spec.url}`)
          }
        }
      }
      await withTx(async client => {
        assertWorkAllowed()
        await client.query('UPDATE spec_board_state SET namespace=$2 WHERE note_id=$1 AND pr_number IS NULL', [spec.id, spec.namespace])
        assertWorkAllowed()
        await upsertState({
          id: spec.id,
          status,
          comments: spec.comments,
          // A failed roles fetch reads as zero approvals; keep the stored count
          // so recovery does not re-fire approval notifications.
          approvals: spec.rolesUnknown ? undefined : spec.approvals,
          discussionHashes: discussion.baseline
        }, client)
        await enqueueEmails(spec, msgs, null, client)
      })
      for (const line of new Set(msgs.map(m => m.line))) await notify(line)
      // Retire the spec this one replaces, but only once the replacement itself
      // has a PR (its own approval gate cleared). A note-id ref resolves
      // directly; a #N ref matches on namespace#pr_number, the same identity
      // key scanImplements uses. Idempotent: the !superseded_at guard makes
      // repeats, races, and a dangling target all no-ops. ponytail: a later
      // close of the replacement PR does not auto-revive the old spec; revival
      // would have to re-derive its lane.
      if (spec.supersedes && prev.pr_number) {
        let oldId = null
        if (spec.supersedes.noteId) {
          if (spec.supersedes.noteId !== spec.id && state.has(spec.supersedes.noteId)) oldId = spec.supersedes.noteId
        } else {
          for (const [id, os] of state) {
            if (id !== spec.id && os.namespace === spec.supersedes.ns && os.pr_number === spec.supersedes.n) { oldId = id; break }
          }
        }
        const os = oldId && state.get(oldId)
        if (os && !os.superseded_at) {
          const supersededAt = new Date().toISOString()
          const oldRef = os.pr_number ? `${os.namespace}#${os.pr_number}` : oldId
          const supLine = `Spec ${oldRef} superseded by ${spec.namespace}#${prev.pr_number} ("${spec.title}"): ${spec.url}`
          await withTx(async client => {
            await upsertState({ id: oldId, supersededAt }, client)
            await enqueueEmails({ id: oldId, title: oldRef, namespace: os.namespace, url: `${BASE_URL}/${oldId}` }, [supLine], null, client)
          })
          os.superseded_at = supersededAt
          await notify(supLine)
        }
      }
      await maybeReviewSpec(spec, bots, reviews, async () => reviewContext(spec, await currentVisibleSpecs(specs), state))
    } catch (e) {
      // One bad spec (malformed row, GitHub hiccup mid-publish) must not
      // skip the specs after it or the mail flush.
      console.error(`spec [${spec.id} "${spec.title}"]:`, e)
    }
  }
  // state is current: every pr_number/implemented_at change above was
  // written to the same in-memory objects scanImplements reads.
  // Neither may withhold the snapshot: the writes above already stand, and a
  // tick that never publishes its view reads as a dead poller.
  setSnapshot(specs, state)
  lastPollOk = Date.now()
  if (githubEnabled && !lifecycle.stopping && !(leadership && leadership.signal.aborted)) {
    try {
      const result = await scanImplements(state, new Set(specs.filter(s => s.topLevel).map(s => s.id)))
      health.success('implementationScan', { enabled: true, ...result })
    } catch (error) {
      health.failure('implementationScan', error, { enabled: true, ...error.scanStatus })
      console.error('scan:', error.message)
    } finally {
      setSnapshot(specs, state)
    }
  }
  beat()
  await flushEmails()
  console.log(`poll: ok in ${Math.round((Date.now() - tickStart) / 1000)}s, ${specs.length} specs, ${tickStats.gh} github calls, ${tickStats.bots} bot calls`)
}

// Read-only roles view for the editor's Approve button; never exposes tokens.
const BASE_ORIGIN = new URL(BASE_URL).origin
async function serveRoles (res, ns) {
  if (!NAMESPACES.includes(ns)) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': BASE_ORIGIN }).end('unknown namespace')
    return
  }
  // Cache-first: the poller keeps rolesCache warm, so the request path only
  // does a live GitHub fetch (and cache write) on a cold miss right after
  // startup, instead of on every editor request past the TTL.
  let roles = await namespaceRoles(ns, true)
  if (roles === null) roles = await namespaceRoles(ns)
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': BASE_ORIGIN,
    'Cache-Control': 'public, max-age=60'
  })
  res.end(JSON.stringify(roles || {}))
}

const STATIC = {
  '/ui.css': ['text/css; charset=utf-8', fs.readFileSync(path.join(__dirname, 'ui.css'))],
  '/board.css': ['text/css; charset=utf-8', fs.readFileSync(path.join(__dirname, 'board.css'))],
  '/board.js': ['text/javascript; charset=utf-8', fs.readFileSync(path.join(__dirname, 'board.js'))],
  '/fonts/SourceSansPro-Regular.woff2': ['font/woff2', fs.readFileSync(path.join(__dirname, 'fonts/SourceSansPro-Regular.woff2'))],
  '/fonts/SourceSansPro-Semibold.woff2': ['font/woff2', fs.readFileSync(path.join(__dirname, 'fonts/SourceSansPro-Semibold.woff2'))],
  '/favicon-32x32.png': ['image/png', fs.readFileSync(path.join(__dirname, 'favicon-32x32.png'))],
  '/favicon-16x16.png': ['image/png', fs.readFileSync(path.join(__dirname, 'favicon-16x16.png'))],
  '/apple-touch-icon.png': ['image/png', fs.readFileSync(path.join(__dirname, 'apple-touch-icon.png'))],
  '/favicon.ico': ['image/x-icon', fs.readFileSync(path.join(__dirname, 'favicon.ico'))]
}
const BOARD_ASSET_VERSION = crypto.createHash('sha256').update(STATIC['/ui.css'][1]).update(STATIC['/board.css'][1]).update(STATIC['/board.js'][1]).digest('hex').slice(0, 16)

function hmac (data, secret = SESSION_SECRET) { return crypto.createHmac('sha256', secret).update(data).digest('base64url') }

// Same envelope the editor signs its identity assertion with (secret:
// EDITOR_SECRET), so one verifier reads both.
function signToken (payload, secret = SESSION_SECRET) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${hmac(body, secret)}`
}

function verifyToken (token, secret = SESSION_SECRET) {
  if (!token || typeof token !== 'string') return null
  const dot = token.lastIndexOf('.')
  if (dot < 1) return null
  const body = token.slice(0, dot)
  const a = Buffer.from(token.slice(dot + 1))
  const b = Buffer.from(hmac(body, secret))
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  let payload
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()) } catch (_) { return null }
  if (!payload.exp || payload.exp < Date.now()) return null
  return payload
}

function parseCookies (req) {
  const out = {}
  const h = req.headers.cookie
  if (!h) return out
  for (const part of h.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

function setCookie (res, name, value, maxAgeSec) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']
  if (maxAgeSec != null) parts.push(`Max-Age=${maxAgeSec}`)
  const prev = res.getHeader('Set-Cookie')
  res.setHeader('Set-Cookie', (prev ? [].concat(prev) : []).concat(parts.join('; ')))
}

function readBody (req, limit = 100000) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => { data += c; if (data.length > limit) { req.destroy(); reject(new Error('body too large')) } })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const session = req => verifyToken(parseCookies(req).sb_session)
const csrfToken = uid => hmac('csrf:' + uid)
const redirect = (res, location) => res.writeHead(302, { Location: location }).end()
const originOf = req => `https://${req.headers.host}`

function startLogin (req, res, next) {
  const state = crypto.randomBytes(16).toString('hex')
  // next rides in the signed state token; finishLogin allowlists it, so it
  // can never become an open redirect.
  setCookie(res, 'sb_oauth', signToken({ st: state, next, exp: Date.now() + 600000 }), 600)
  const p = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: `${originOf(req)}/auth/github/callback`,
    scope: 'read:user user:email',
    state
  })
  redirect(res, `https://github.com/login/oauth/authorize?${p}`)
}

// Allowlisted so the round trip cannot be steered to an arbitrary path.
const LOGIN_RETURN = new Set(['/bots', '/checkpoints', '/roadmap'])

async function finishLogin (req, res, url) {
  const code = url.searchParams.get('code')
  const oauth = verifyToken(parseCookies(req).sb_oauth)
  if (!code || !oauth || oauth.st !== url.searchParams.get('state')) { res.writeHead(400).end('bad oauth state'); return }
  let token
  try {
    const r = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, client_secret: OAUTH_CLIENT_SECRET, code, redirect_uri: `${originOf(req)}/auth/github/callback` }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    token = (await r.json()).access_token
  } catch (e) { console.error('oauth token:', e.message) }
  if (!token) { res.writeHead(502).end('oauth exchange failed'); return }
  let gh
  try {
    const r = await fetch('https://api.github.com/user', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'spec-board' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    gh = await r.json()
  } catch (e) { console.error('oauth user:', e.message) }
  if (!gh || !gh.id) { res.writeHead(502).end('oauth user failed'); return }
  // Verified addresses feed the author-email picker in settings. Carried in the
  // signed session so the settings page needs no stored token.
  let emails = []
  try {
    const r = await fetch('https://api.github.com/user/emails', {
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'user-agent': 'spec-board' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    const list = await r.json()
    if (Array.isArray(list)) emails = list.filter(e => e.verified).map(e => e.email)
    else console.error('oauth emails: non-list response', r.status, JSON.stringify(list).slice(0, 200))
    console.log(`oauth emails for @${gh.login}: ${emails.length} verified`)
  } catch (e) { console.error('oauth emails:', e.message) }
  const { rows } = await pool.query('SELECT id, profile FROM "Users" WHERE profileid = ANY($1::text[])', [[`github:${gh.id}`, String(gh.id)]])
  const linked = rows.find(row => {
    const profile = parseProfile(row.profile)
    return profile.provider === 'github' && String(profile.id) === String(gh.id)
  })
  setCookie(res, 'sb_oauth', '', 0)
  setCookie(res, 'sb_session', signToken({ uid: linked ? linked.id : null, login: gh.login, emails, exp: Date.now() + SESSION_TTL_MS }), Math.floor(SESSION_TTL_MS / 1000))
  redirect(res, LOGIN_RETURN.has(oauth.next) ? oauth.next : '/settings')
}

async function emailForUid (uid) {
  const { rows } = await pool.query('SELECT email, profile FROM "Users" WHERE id = $1', [uid])
  return (rows[0] && userEmail(rows[0])) || ''
}

async function settingsGet (req, res, url) {
  const s = session(req)
  if (!s) { startLogin(req, res); return }
  let subs = new Map()
  let emailPrefs = new Map()
  let notifyPrefs = new Map()
  let optedOut = false
  if (s.uid) {
    const [subRes, emailRes, notifyRes, addr] = await Promise.all([
      pool.query('SELECT namespace, level FROM spec_board_subscriptions WHERE user_id = $1', [s.uid]),
      pool.query('SELECT namespace, email FROM spec_board_email WHERE user_id = $1', [s.uid]),
      pool.query('SELECT namespace, email FROM spec_board_notify_email WHERE user_id = $1', [s.uid]),
      emailForUid(s.uid)
    ])
    subs = new Map(subRes.rows.map(r => [r.namespace, r.level]))
    emailPrefs = new Map(emailRes.rows.map(r => [r.namespace, r.email]))
    notifyPrefs = new Map(notifyRes.rows.map(r => [r.namespace, r.email]))
    // Check the address mail actually goes to; the account default only
    // matters when no override is set. Per-namespace overrides can point
    // elsewhere, so the banner tracks the global delivery address.
    const delivery = notifyPrefs.get('') || addr
    if (delivery) {
      const { rows } = await pool.query('SELECT 1 FROM spec_board_optout WHERE email_hash = $1', [emailKey(delivery)])
      optedOut = rows.length > 0
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
  const proposals = await feedback.settingsHtml(s)
  res.end(settingsPage(s, subs, emailPrefs, notifyPrefs, optedOut, url.searchParams.has('saved'), proposals))
}

async function settingsPost (req, res) {
  const s = session(req)
  if (!s) { res.writeHead(401).end('not signed in'); return }
  if (!s.uid) { res.writeHead(403).end('no linked account'); return }
  let body
  try { body = await readBody(req) } catch (_) { res.writeHead(413).end('too large'); return }
  const form = new URLSearchParams(body)
  if (form.get('csrf') !== csrfToken(s.uid)) { res.writeHead(403).end('bad csrf'); return }
  if (form.get('action') === 'reenable') {
    // Clear every verified address, not just the current account email: the
    // opt-out may be keyed to an address the account no longer resolves to,
    // which the UI could otherwise never undo.
    const addrs = new Set((s.emails || []).map(e => e.toLowerCase()))
    const addr = await emailForUid(s.uid)
    if (addr) addrs.add(addr)
    if (addrs.size) await pool.query('DELETE FROM spec_board_optout WHERE email_hash = ANY($1)', [[...addrs].map(emailKey)])
    redirect(res, '/settings?saved=1')
    return
  }
  for (const ns of NAMESPACES) {
    const level = form.get(`lvl:${ns}`)
    if (!SUB_LEVELS.has(level)) continue
    if (level === 'participating') {
      await pool.query('DELETE FROM spec_board_subscriptions WHERE user_id = $1 AND namespace = $2', [s.uid, ns])
    } else {
      await pool.query(
        `INSERT INTO spec_board_subscriptions (user_id, namespace, level) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, namespace) DO UPDATE SET level = $3`, [s.uid, ns, level])
    }
  }
  // Author-email choices: only a verified address off the session list is
  // accepted; anything else (including "account default") clears the row. A
  // session whose email list failed to load leaves the prefs untouched rather
  // than wiping them, since it can't validate a submission.
  if (s.emails && s.emails.length) {
    const known = new Set(s.emails)
    const saveEmail = async (table, ns, email) => {
      if (email && known.has(email)) {
        await pool.query(
          `INSERT INTO ${table} (user_id, namespace, email) VALUES ($1, $2, $3)
           ON CONFLICT (user_id, namespace) DO UPDATE SET email = $3`, [s.uid, ns, email])
      } else {
        await pool.query(`DELETE FROM ${table} WHERE user_id = $1 AND namespace = $2`, [s.uid, ns])
      }
    }
    // Namespace '' is the global default, and its field names carry the empty
    // suffix (email:, notify:).
    const savePrefs = async ns => {
      await saveEmail('spec_board_email', ns, form.get(`email:${ns}`) || '')
      await saveEmail('spec_board_notify_email', ns, form.get(`notify:${ns}`) || '')
    }
    for (const ns of ['', ...NAMESPACES]) await savePrefs(ns)
  }
  redirect(res, '/settings?saved=1')
}

function settingsPage (s, subs, emailPrefs, notifyPrefs, optedOut, saved, proposals = '') {
  const emailOpts = cur => ['', ...(s.emails || [])].map(e =>
    `<option value="${esc(e)}"${e === cur ? ' selected' : ''}>${e ? esc(e) : 'Account default'}</option>`).join('')
  const rows = NAMESPACES.map(ns => {
    const cur = subs.get(ns) || 'participating'
    const opt = (v, label) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`
    return `<tr><th scope="row">${esc(ns)}</th>
      <td data-label="Notifications"><select name="lvl:${esc(ns)}" aria-label="Notifications for ${esc(ns)}">${opt('watch', 'Watch (all specs)')}${opt('participating', 'Participating (default)')}${opt('disabled', 'Disabled')}</select></td>
      <td data-label="Notification email"><select name="notify:${esc(ns)}" aria-label="Notification email for ${esc(ns)}">${emailOpts(notifyPrefs.get(ns) || '')}</select></td>
      <td data-label="Author email"><select name="email:${esc(ns)}" aria-label="Author email for ${esc(ns)}">${emailOpts(emailPrefs.get(ns) || '')}</select></td></tr>`
  }).join('')
  const optoutBanner = optedOut
    ? `<form method="post" action="/settings" class="warn">
      <input type="hidden" name="csrf" value="${esc(csrfToken(s.uid))}">
      <input type="hidden" name="action" value="reenable">
      <p>Email is turned off for your account.</p><button type="submit">Re-enable email</button>
    </form>`
    : ''
  const emailHint = (s.emails && s.emails.length)
    ? ''
    : '<p class="legend">No GitHub addresses loaded for the email pickers. <a href="/auth/github">Reload them from GitHub</a>.</p>'
  const form = s.uid
    ? `<form method="post" action="/settings" class="panel">
      <input type="hidden" name="csrf" value="${esc(csrfToken(s.uid))}">
      <h2>Account defaults</h2><p class="legend">Choose where notifications arrive and which address credits your spec commits.</p>
      <div class="field-grid">
        <label>Default notification email<select name="notify:">${emailOpts(notifyPrefs.get('') || '')}</select></label>
        <label>Default author email<select name="email:">${emailOpts(emailPrefs.get('') || '')}</select></label>
      </div>
      <div class="section-heading"><h2>Namespace preferences</h2></div>
      <p class="legend">Override your defaults for individual projects.</p>
      <div class="table-wrap"><table class="preferences"><thead><tr><th scope="col">Namespace</th><th scope="col">Notifications</th><th scope="col">Notification email</th><th scope="col">Author email</th></tr></thead><tbody>${rows}</tbody></table></div>
      <details class="preferences-help"><summary>How these preferences work</summary>
        <p><b>Watch</b>: email for every spec in the namespace. <b>Participating</b>: only specs you own or edited. <b>Disabled</b>: mute the namespace.</p>
        <p><b>Notification email</b>: where board mail is delivered. A namespace row overrides the default; <b>Account default</b> uses your linked SpecDoc email.</p>
        <p><b>Author email</b>: the git commit author for specs you own or review. A namespace row overrides the default; <b>Account default</b> uses your linked SpecDoc email. The pickers list your verified GitHub addresses; <a href="/auth/github">reload them</a> after changing them on GitHub.</p>
      </details>
      ${emailHint}
      <div class="form-actions"><button type="submit" class="primary">Save</button></div>
    </form>`
    : `<p class="warn">No SpecDoc account is linked to <b>@${esc(s.login)}</b>. Open a note in SpecDoc once, then come back.</p>`
  return basicPage('Settings', `
    <div class="page-heading"><div><h1>Settings</h1><p class="context">Email, authorship and automatic proposals for @${esc(s.login)}.</p></div></div>
    ${saved ? '<p class="notice" role="status">Preferences saved.</p>' : ''}
    ${optoutBanner}${form}${proposals}`, { page: 'settings', who: s })
}

// Form input (plain object of strings) -> bot row or an error string. The
// name becomes the CriticMarkup author and the dedup key: its charset must
// exclude braces, colon, @, and whitespace so it can never break the comment
// container, spoof another prefix, or equal the resolve sentinel.
// Literal host forms that reach the node, the cluster, or a cloud metadata
// endpoint. Admin-set URLs are fetched server-side, so this is defense in
// depth against a mistyped or hostile endpoint, not a full SSRF guard (a
// public hostname resolving to a private IP still gets through).
function isInternalHost (host) {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.svc') || h.endsWith('.cluster.local')) return true
  if (h === '169.254.169.254' || h === 'metadata.google.internal') return true
  if (/^(?:127\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(h)) return true
  if (h === '::1' || h.startsWith('fd') || h.startsWith('fe80')) return true
  return false
}

function validateBot (form, namespaces) {
  const name = String(form.name || '').trim()
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(name)) return { error: 'bot name must be 1-31 chars of a-z, 0-9, -' }
  const url = String(form.url || '').trim().replace(/\/$/, '')
  if (!/^https?:\/\/.+/.test(url)) return { error: 'endpoint must be an http(s) URL' }
  let host
  try { host = new URL(url).hostname } catch { return { error: 'endpoint must be a valid URL' } }
  if (isInternalHost(host)) return { error: 'endpoint must not be an internal or metadata address' }
  const model = String(form.model || '').trim()
  if (!model) return { error: 'model is required' }
  return {
    bot: {
      name,
      url,
      model,
      prompt: String(form.prompt || '').trim() || null,
      namespaces: namespaces.filter(ns => form['ns:' + ns] === 'on'),
      enabled: form.enabled === 'on',
      // clear_key wins over a typed key so the explicit checkbox is never
      // silently overridden.
      apiKey: form.clear_key === 'on' ? null : (String(form.api_key || '') || null),
      clearKey: form.clear_key === 'on'
    }
  }
}

function botForm (csrf, bot, isNew = !bot.name) {
  const nsBoxes = NAMESPACES.map(ns =>
    `<label class="check"><input type="checkbox" name="ns:${esc(ns)}"${bot.namespaces && bot.namespaces.includes(ns) ? ' checked' : ''}> ${esc(ns)}</label>`).join(' ')
  return `<form method="post" action="/bots">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="action" value="save">
    ${isNew
      ? `<label class="row">Name <input name="name" value="${esc(bot.name || '')}" placeholder="my-bot" required></label>`
      : `<input type="hidden" name="name" value="${esc(bot.name)}">`}
    <label class="row">Endpoint <input name="url" value="${esc(bot.url || '')}" placeholder="https://model.example" required></label>
    <label class="row">Model <input name="model" value="${esc(bot.model || '')}" required></label>
    <label class="row">API key <input type="password" name="api_key" value="" placeholder="${isNew || !bot.has_key ? 'none' : 'key set, leave blank to keep'}"></label>
    ${!isNew && bot.has_key ? '<label class="check"><input type="checkbox" name="clear_key"> Clear the stored key</label>' : ''}
    <label class="row">Prompt <textarea name="prompt" rows="4" placeholder="${esc(REVIEW_SYSTEM)}">${esc(bot.prompt || '')}</textarea></label>
    <fieldset><legend>Namespaces</legend>${nsBoxes || '<p class="legend">None configured</p>'}</fieldset>
    <label class="check"><input type="checkbox" name="enabled"${(bot.enabled ?? true) ? ' checked' : ''}> Enabled</label>
    <div class="form-actions"><button type="submit" class="primary">${isNew ? 'Add bot' : 'Save'}</button></div>
  </form>
  ${isNew
    ? ''
    : `<form method="post" action="/bots" class="delete-bot" onsubmit="return confirm('Delete @${esc(bot.name)}?')">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <input type="hidden" name="action" value="delete">
    <input type="hidden" name="name" value="${esc(bot.name)}">
    <button type="submit" class="danger">Delete</button>
  </form>`}`
}

function botsPage (s, bots, flash = {}) {
  const csrf = csrfToken(s.login)
  // A failed save re-renders with the submitted values in place of the
  // stored ones, so the admin fixes the field instead of retyping the form.
  const echo = flash.echo
  const editEcho = echo && bots.some(b => b.name === echo.name)
  const list = bots.map(b => editEcho && b.name === echo.name ? { ...echo, has_key: b.has_key } : b)
  const banner = flash.error
    ? `<p class="warn">Save failed: ${esc(flash.error)}</p>`
    : flash.saved ? '<p class="notice">Saved.</p>' : flash.deleted ? '<p class="notice">Deleted.</p>' : ''
  const failing = [...botHealth.entries()].filter(([name]) => bots.some(b => b.name === name))
  const healthBanner = failing.length
    ? failing.map(([name, h]) =>
      `<p class="warn">@${esc(name)} failing since ${esc(h.failingSince)} (${h.failures} failure${h.failures > 1 ? 's' : ''}, last: ${esc(h.lastError || '')})</p>`).join('')
    : ''
  return basicPage('Review bots', `
    <div class="page-heading"><div><h1>Review bots</h1><p class="context">Automated reviewers for your projects. Each bot comments under its own name.</p></div></div>
    ${banner}${healthBanner}
    <p class="legend">Spec text is sent to the configured endpoint. <a href="/privacy">Read how automated review uses data</a>.</p>
    ${list.map(b => `<section class="panel bot-editor"><div class="section-heading"><h2>@${esc(b.name)}</h2><span class="badge${b.enabled ? ' success' : ''}">${b.enabled ? 'Enabled' : 'Disabled'}</span></div><p class="meta">${esc(b.model)} · ${esc((b.namespaces || []).join(', ') || 'No namespaces')}</p><details${editEcho && echo.name === b.name ? ' open' : ''}><summary>Edit bot</summary>${botForm(csrf, b)}</details></section>`).join('') || '<div class="empty-state"><h2>No review bots yet</h2><p>Add a bot to help review specifications in your projects.</p></div>'}
    <section class="panel bot-editor"><h2>Add a bot</h2>${botForm(csrf, echo && !editEcho ? echo : {}, true)}</section>`, { page: 'bots', who: s })
}

const BLOCKER_FIX = {
  'unresolved-ref': 'Fix the reference in the note and publish the revision.',
  'stale-dep': 'Re-point the dependency at the replacement spec, or drop it.',
  'unstamped-supersede': 'Add the banner to the retired spec file, or replace it in the same repo so the next publish stamps it.',
  'missing-file': 'Restore the file, or retire the spec with a replacement.',
  'orphan-file': 'Take the file through the board as a spec, or delete it.',
  'stale-map': 'Open the refresh PR below and merge it.'
}

// Why the pass reported what it did. The two silent cases are derived, not
// carried: fewer than two specs is the same predicate cp.count counts, and no
// bot is the absence of one.
function overlapLegend (ov, count) {
  const legend = t => `<p class="legend">${t}</p>`
  const left = ov.skipped && ov.skipped.length
    ? ` Specs left out of the pass for size: ${esc(ov.skipped.map(specNum).join(', '))}.`
    : ''
  if (ov.error) return `<p class="warn">Overlap pass failed: ${esc(ov.error)}. The checkpoint can still be cut.</p>`
  if (count < 2) return legend('Fewer than two approved specs, so there is nothing to compare.')
  if (!ov.bot) return legend('No review bot covers this namespace, so no overlap pass ran.')
  const found = ov.findings || []
  if (!found.length) return legend(`No overlap found by <b>${esc(ov.bot)}</b>.${left}`)
  return `<ul class="overlap">${found.map(f => `<li>${esc(specNum(f.a))} vs ${esc(specNum(f.b))}: ${esc(f.why)}</li>`).join('')}</ul>
             ${legend(`Advisory, from <b>${esc(ov.bot)}</b>. Declare the relation with <code>supersedes</code> or <code>depends-on</code>, or acknowledge them and cut.${left}`)}`
}

function checkpointSection (csrf, cp) {
  const cur = cp.latest
    ? `<b>${esc(cp.latest.tag)}</b>${cp.cutAt ? ` cut ${esc(new Date(cp.cutAt).toISOString().slice(0, 10))}` : ''}`
    : 'none yet'
  const ch = cp.changes
  const changeItems = ch ? CHANGE_KINDS.flatMap(k => ch[k].map(e => `<li><b>${k}</b> ${esc(changeLine(k, e).slice(k.length + 1))}</li>`)) : []
  const sm = cp.summary || {}
  const changesHtml = !ch
    ? ''
    : `<h3>Since ${esc(ch.from)}</h3>
      ${changeItems.length ? `<ul class="changes">${changeItems.join('')}</ul>` : '<p class="legend">No spec changes.</p>'}
      ${ch.truncated ? '<p class="legend">The file list between the two commits was too long to read, so added and revised specs are not listed.</p>' : ''}
      ${sm.error ? `<p class="warn">Summary failed: ${esc(sm.error)}. The checkpoint can still be cut.</p>` : ''}
      ${sm.summary ? `<p>Summary from <b>${esc(sm.bot)}</b>, advisory: ${esc(sm.summary)}</p>` : ''}`
  const rows = cp.blockers.map(b => `
      <li><code>${esc(b.kind)}</code> ${b.n ? `spec ${esc(specNum(b.n))}` : esc(b.path || '')}: ${esc(b.detail)}
        <div class="fix">${esc(BLOCKER_FIX[b.kind] || '')}</div></li>`).join('')
  const ov = cp.overlap || {}
  const found = ov.findings || []
  const overlapHtml = overlapLegend(ov, cp.count)
  const blocked = cp.blockers.length > 0
  const ack = found.length
    ? `<label class="check"><input type="checkbox" name="ack" value="${found.length}" required> Reviewed the ${found.length} overlap finding${found.length === 1 ? '' : 's'} above</label>`
    : ''
  const mapFix = cp.blockers.some(b => b.kind === 'stale-map')
    ? `<form method="post"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="ns" value="${esc(cp.ns)}">
         <button name="action" value="refresh-map">Open map refresh PR</button></form>`
    : ''
  return `
    <section class="panel checkpoint">
      <h2>${esc(cp.ns)}</h2>
      <p>${cp.count} spec${cp.count === 1 ? '' : 's'} · last checkpoint ${cur}</p>
      ${cp.orphans ? '' : '<p class="legend">Some published specs have no recorded file path, so stray files in the specs dir are not checked here.</p>'}
      ${blocked ? `<p class="warn">${cp.blockers.length} thing${cp.blockers.length === 1 ? '' : 's'} to reconcile before ${esc(cp.next)} can be cut.</p><ul class="blockers">${rows}</ul>` : `<p class="notice">Consistent. ${esc(cp.next)} would tag <code>${esc(cp.head.slice(0, 7))}</code>.</p>`}
      ${mapFix}
      ${changesHtml}
      ${overlapHtml}
      <form method="post">
        <input type="hidden" name="csrf" value="${esc(csrf)}">
        <input type="hidden" name="ns" value="${esc(cp.ns)}">
        ${ack}
        <button class="primary" name="action" value="cut"${blocked ? ' disabled' : ''}>Cut ${esc(cp.next)}</button>
      </form>
    </section>`
}

function checkpointsPage (s, states, ns, flash = {}) {
  const csrf = csrfToken(s.login)
  const banner = flash.error
    ? `<p class="warn">${esc(flash.error)}</p>`
    : flash.cut ? `<p class="notice">Cut ${esc(flash.cut)}.</p>` : flash.pr ? `<p class="notice">Map refresh PR #${esc(flash.pr)} opened.</p>` : ''
  const failed = cp => `<section class="panel"><h2>${esc(cp.ns)}</h2><p class="warn">Could not read this namespace: ${esc(cp.error)}</p></section>`
  const summary = cp => cp.error
    ? failed(cp)
    : `<section class="panel"><h2><a href="/checkpoints?ns=${encodeURIComponent(cp.ns)}">${esc(cp.ns)}</a></h2>
       <p>${cp.count} spec${cp.count === 1 ? '' : 's'} · last checkpoint ${cp.latest ? esc(cp.latest.tag) : 'none yet'} · ${cp.blockers.length ? `<b>${cp.blockers.length} to reconcile</b>` : 'consistent'}</p></section>`
  return basicPage('Checkpoints', `
    <div class="page-heading"><div><h1>Checkpoints</h1><p class="context">${ns ? esc(ns) + ' · ' : ''}Versioned snapshots of consistent specifications.</p></div>${ns ? '<a class="button" href="/checkpoints">All namespaces</a>' : ''}</div>
    ${banner}
  ${states.map(cp => {
    const html = ns ? (cp.error ? failed(cp) : checkpointSection(csrf, cp)) : summary(cp)
    const linked = (cp.milestones || []).length ? `<p class="meta"><span>Linked milestones: ${cp.milestones.map(m => `<a href="/roadmap?milestone=${esc(m.id)}">${esc(m.title)}</a> (${esc(m.checkpointTag)})`).join(', ')}</span></p>` : ''
    return html.replace(/<\/section>\s*$/, linked + '</section>')
  }).join('')}`, { page: 'checkpoints', ns, who: s })
}

async function checkpointsGet (req, res, url) {
  const s = session(req)
  if (!s) { startLogin(req, res, '/checkpoints'); return }
  if (!isAdmin(s)) { res.writeHead(403).end('not a board admin'); return }
  // Only a namespace's own page runs the overlap pass: it is one model call over
  // the whole corpus, and the index would fire one per namespace per load.
  const one = url.searchParams.get('ns') || ''
  if (one && !NAMESPACES.includes(one)) { res.writeHead(400).end('unknown namespace'); return }
  const list = one ? [one] : NAMESPACES
  const states = await Promise.all(list.map(ns =>
    checkpointState(ns, { overlap: !!one }).catch(e => ({ ns, error: e.message }))))
  const planning = await roadmapStore.read({ namespaces: list, noteIds: [] })
  for (const cp of states) cp.milestones = planning.milestones.filter(m => m.namespace === cp.ns && m.checkpointTag)
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
  res.end(checkpointsPage(s, states, one, {
    cut: url.searchParams.get('cut'),
    pr: url.searchParams.get('pr'),
    error: url.searchParams.get('error')
  }))
}

async function checkpointsPost (req, res) {
  const s = session(req)
  if (!s) { res.writeHead(401).end('not signed in'); return }
  if (!isAdmin(s)) { res.writeHead(403).end('not a board admin'); return }
  let body
  try { body = await readBody(req) } catch (_) { res.writeHead(413).end('too large'); return }
  const form = Object.fromEntries(new URLSearchParams(body))
  if (form.csrf !== csrfToken(s.login)) { res.writeHead(403).end('bad csrf'); return }
  // The namespace lands in an API path; only the allowlist may reach GitHub.
  const ns = String(form.ns || '')
  if (!NAMESPACES.includes(ns)) { res.writeHead(400).end('unknown namespace'); return }
  const done = q => redirect(res, `/checkpoints?ns=${encodeURIComponent(ns)}&${q}`)
  try {
    if (form.action === 'refresh-map') {
      const r = await refreshMapPr(ns)
      done(r.error ? `error=${encodeURIComponent(r.error)}` : `pr=${r.pr}`)
      return
    }
    if (form.action === 'cut') {
      const r = await cutCheckpoint(ns, form.ack)
      if (r.error) { done(`error=${encodeURIComponent(`${ns}: ${r.error}`)}`); return }
      redirect(res, `/checkpoints?cut=${encodeURIComponent(r.tag)}`)
      return
    }
  } catch (e) {
    done(`error=${encodeURIComponent(e.message)}`)
    return
  }
  res.writeHead(400).end('unknown action')
}

// Distinct name on purpose: a second `loadBots` declaration hoists over the
// poller's and strips api_key and the enabled filter from reviews.
async function listBotsForForm () {
  // api_key is never selected for rendering; the form only learns whether one
  // is set.
  const { rows } = await pool.query(
    'SELECT name, url, model, prompt, namespaces, enabled, api_key IS NOT NULL AS has_key FROM spec_board_bots ORDER BY name')
  return rows.map(r => ({ ...r, namespaces: normList(r.namespaces) }))
}

async function botsGet (req, res, url) {
  const s = session(req)
  if (!s) { startLogin(req, res, '/bots'); return }
  if (!isAdmin(s)) { res.writeHead(403).end('not a board admin'); return }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
  res.end(botsPage(s, await listBotsForForm(), { saved: url.searchParams.has('saved'), deleted: url.searchParams.has('deleted') }))
}

async function botsPost (req, res) {
  const s = session(req)
  if (!s) { res.writeHead(401).end('not signed in'); return }
  if (!isAdmin(s)) { res.writeHead(403).end('not a board admin'); return }
  let body
  try { body = await readBody(req) } catch (_) { res.writeHead(413).end('too large'); return }
  const form = Object.fromEntries(new URLSearchParams(body))
  // csrf keyed on the login, not uid: admins need no linked HedgeDoc account.
  if (form.csrf !== csrfToken(s.login)) { res.writeHead(403).end('bad csrf'); return }
  if (form.action === 'delete') {
    await pool.query('DELETE FROM spec_board_bots WHERE name = $1', [String(form.name || '')])
    overlapCache.clear()
    redirect(res, '/bots?deleted=1')
    return
  }
  const v = validateBot(form, NAMESPACES)
  if (v.error) {
    const echo = {
      name: String(form.name || '').trim(),
      url: String(form.url || '').trim(),
      model: String(form.model || '').trim(),
      prompt: String(form.prompt || ''),
      namespaces: NAMESPACES.filter(ns => form['ns:' + ns] === 'on'),
      enabled: form.enabled === 'on'
    }
    res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
    res.end(botsPage(s, await listBotsForForm(), { error: v.error, echo }))
    return
  }
  const b = v.bot
  // A blank key field keeps the stored key, so the page never has to echo it.
  await pool.query(
    `INSERT INTO spec_board_bots (name, url, api_key, model, prompt, namespaces, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (name) DO UPDATE SET url = $2,
       api_key = CASE WHEN $8::boolean THEN NULL ELSE COALESCE($3, spec_board_bots.api_key) END,
       model = $4, prompt = $5, namespaces = $6, enabled = $7`,
    [b.name, b.url, b.apiKey, b.model, b.prompt, b.namespaces.join(','), b.enabled, b.clearKey])
  // Which bot reviews a namespace decides what the pass answers, and editing
  // one moves no repo head.
  overlapCache.clear()
  redirect(res, '/bots?saved=1')
}

// Nav pill: specs still waiting on the signed-in login's approval.
function navCounts (who) {
  if (!who) return {}
  const login = String(who.login || '').toLowerCase()
  const board = snapshot.specs.filter(s => {
    const st = snapshot.state.get(s.id)
    const idx = laneIdx(s, st)
    return !(st && st.superseded_at) && idx >= IN_REVIEW_IDX && idx < IMPLEMENTED_IDX &&
      (s.missingApprovers || []).some(a => a.toLowerCase() === login)
  }).length
  return { board }
}

function basicPage (title, bodyHtml, { page = 'prose', ns = '', who, actions = '', counts = navCounts(who) } = {}) {
  const context = ns ? '?ns=' + encodeURIComponent(ns) : ''
  const pill = key => counts[key] ? `<span class="pill" title="${counts[key]} waiting for you">${counts[key]}</span>` : ''
  const navLink = (key, href, label) => `<a href="${esc(href)}"${page === key ? ' aria-current="page"' : ''}>${label}${pill(key)}</a>`
  const adminLinks = isAdmin(who) ? navLink('bots', '/bots', 'Review bots') + navLink('checkpoints', '/checkpoints' + context, 'Checkpoints') : ''
  const account = SETTINGS_ENABLED ? `<details class="account-menu"><summary class="button" aria-label="Account and settings">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg>
    <span class="account-name">${who ? '@' + esc(who.login) : 'Account'}</span></summary>
    <div class="menu">${navLink('settings', '/settings', 'Settings')}${adminLinks}${navLink('privacy', '/privacy', 'Privacy')}${who ? '<a href="/logout">Sign out</a>' : ''}</div></details>` : ''
  const subnav = ['settings', 'bots', 'checkpoints'].includes(page)
    ? `<nav class="subnav" aria-label="Settings navigation">${navLink('settings', '/settings', 'Preferences')}${adminLinks}</nav>` : ''
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="shortcut icon" href="/favicon.ico">
<title>${esc(title)} · specdoc</title>
<link rel="stylesheet" href="/ui.css?v=${BOARD_ASSET_VERSION}">
${page === 'board' ? `<link rel="stylesheet" href="/board.css?v=${BOARD_ASSET_VERSION}">
<script src="/board.js?v=${BOARD_ASSET_VERSION}" data-me-url="${esc(BASE_URL)}/me" defer></script>
<noscript><style>.implemented[hidden] { display: block !important; } #result-count { display: none; }</style></noscript>` : ''}
</head><body>
<a class="skip-link" href="#main">Skip to content</a>
<header class="app-header">
  <a class="brand" href="/"><img src="/apple-touch-icon.png" alt="">specdoc</a>
  <nav class="app-nav" aria-label="Main navigation">${navLink('board', '/' + context, 'Board')}${navLink('planning', '/roadmap' + context, 'Planning')}${navLink('library', '/map' + context, 'Spec library')}</nav>
  <div class="header-actions">${account}${actions}</div>
</header>
<main id="main" class="${page === 'board' ? 'board-page' : 'page page-' + esc(page)}">${subnav}${bodyHtml}</main>
<footer class="app-footer"><a href="/privacy">Privacy</a></footer>
</body></html>`
}

function unsubGet (res, url) {
  const t = url.searchParams.get('t')
  const payload = verifyToken(t)
  if (!payload || !payload.u) { res.writeHead(400).end('invalid or expired unsubscribe link'); return }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
  res.end(basicPage('Unsubscribe', `<h1>Unsubscribe from ${esc(EMAIL_ORG_NAME)} digests</h1>
    <p>Stop all activity emails to <b>${esc(payload.u)}</b>?</p>
    <form method="post" action="/unsub?t=${esc(t)}"><button type="submit">Unsubscribe</button></form>
    ${SETTINGS_ENABLED ? '<p><a href="/settings">Or choose which specs email you</a></p>' : ''}`))
}

// No CSRF token: the signed link is itself the unguessable capability, and
// RFC 8058 one-click POSTs carry no form token. GET only confirms (link
// scanners must not auto-unsubscribe); this POST does the opt-out.
async function unsubPost (res, url) {
  const payload = verifyToken(url.searchParams.get('t'))
  if (!payload || !payload.u) { res.writeHead(400).end('invalid or expired unsubscribe link'); return }
  const email = payload.u.toLowerCase()
  await pool.query('INSERT INTO spec_board_optout (email_hash) VALUES ($1) ON CONFLICT DO NOTHING', [emailKey(email)])
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
  res.end(basicPage('Unsubscribed', `<h1>Unsubscribed</h1>
    <p><b>${esc(email)}</b> will no longer receive ${esc(EMAIL_ORG_NAME)} activity emails.</p>
    ${SETTINGS_ENABLED ? '<p><a href="/settings">Change your mind or set per-spec preferences</a></p>' : ''}`))
}

function privacyPage () {
  return basicPage('Privacy', `<h1>${esc(EMAIL_ORG_NAME)} privacy</h1>
  <p>This board emails digests of spec activity and opens pull requests on your behalf. What it stores and why:</p>
  <h2>What is stored</h2>
  <ul>
    <li><b>Recipient email addresses</b>, queued only while a digest is batched, taken from your SpecDoc account or GitHub profile.</li>
    <li><b>Queued activity details</b>: spec titles, observed times, links, recipient reasons, and short public discussion excerpts with their author or visible signature. Digests omit notes that are private, limited, protected or deleted when delivery is checked.</li>
    <li><b>Discussion fingerprints</b>, one-way hashes of comment messages, to detect discussion changes without retaining a second copy of their full text.</li>
    <li><b>Per-namespace subscription levels</b> (watch, participating, disabled), tied to your GitHub-linked account, when you set them.</li>
    <li><b>Your chosen commit-author email</b>, a global default and optional per-namespace override, when you set one in settings.</li>
    <li><b>Your chosen notification email</b>, a global default and optional per-namespace override, when you pick a delivery address other than your account default in settings.</li>
    <li><b>Your verified GitHub email addresses</b>, fetched at sign-in and held only in your signed session cookie, never in the database, so the settings page can list them.</li>
    <li><b>A one-way hash</b> of any address that unsubscribed, so the opt-out is honored without keeping a readable list of who you are.</li>
    <li><b>Copies of a spec's published text</b> at each status change, each publish, and each approval, an approval's copy labelled with that approver's login and taken when they press approve in the editor, so the board can show what changed since and tell an approver when the text moved past their approval. The approval itself is recorded here, not in the note.</li>
    <li><b>Personal access token hashes and metadata</b> in the editor: the owning account, token name, permissions, creation and expiry times, last use, and revocation time. The token secret is displayed once when created and is not stored.</li>
    <li><b>Implementation review evidence and amendment proposals</b> for projects that enable feedback: public GitHub PR descriptions, review discussion and author logins, relevant code patches, source identifiers and spec versions. Automatic-generation settings record the acting login and time.</li>
  </ul>
  <h2>Published in pull requests</h2>
  <p>When an approved spec opens a pull request, and again each time a re-approved spec publishes a revision, the git commit records an author and a Reviewed-by line for each approver and for each person who commented on the note. The generated spec map that rides in the same pull request is committed under the same author. These carry the email you selected in settings, or your account email if you selected none. Commit metadata is public and permanent in the target repository's history.</p>
  <h2>Published by the read API</h2>
  <p>The board serves its spec corpus as JSON at <b>/api/specs</b>, unauthenticated, for tools outside the browser: spec text, author login and review counts, excluding any note HedgeDoc marks private, limited or protected. It reaches further than the board's own pages in two ways: it serves the full text of a spec rather than its first paragraph, and its revision endpoints serve the raw note, including review threads the board resolves away.</p>
  <h2>Personal access tokens</h2>
  <p>The editor also offers an authenticated note API. A personal access token can read raw notes, including frontmatter and review comments, within its owner's note permissions; a write token can create and edit notes as that owner. Edits retain attribution for unchanged text and attribute added text to that account. Tokens do not authorize review approvals.</p>
  <h2>Automated review</h2>
  <p>When a spec enters review, its note text (the spec markdown only, no account data) may be sent to one or more language-model endpoints configured by the board operator, and the board writes the model's review comments back into the note. Configured endpoints may be operated by third parties; nothing else from the model call is stored.</p>
  <p>A board admin reviewing a checkpoint also sends every approved spec in that namespace to the same endpoint, to be checked for specs that overlap each other, and, for the checkpoint's changelog, the text of specs added since the last checkpoint and a diff excerpt of each revised one. This is published spec text only, no account data. The model's findings are shown to the admin and never written into a note; the ones the admin acknowledges are recorded in the checkpoint tag's message, which is public in the target repository.</p>
  <p>When a project selects a feedback bot, merged implementation PR discussions, reviewer logins, relevant code patches and canonical spec text are sent to that configured endpoint to propose amendments. Sources and target specs must be public. Each proposal is written into the note as a suggestion under the bot's name, with a comment naming the pull request it came from, so it is as public as the note and appears in the spec API like any other note text. Nobody's login is written into the note. An approved spec returns to review until the suggestion is accepted or rejected. A project approver or board admin can turn automatic proposals off in settings.</p>
  <h2>Browser preferences</h2>
  <p>The board keeps your layout, stage visibility and personal filter choices in your browser's local storage. These preferences stay in that browser and are not stored in your account. Clear this site's browser data to remove them.</p>
  <h2>Retention</h2>
  <ul>
    <li>Queued digest rows are deleted as soon as the email is sent.</li>
    <li>Discussion fingerprints are replaced at each poll and cleared after the note is deleted.</li>
    <li>Text snapshots are deleted with the note; an approval's snapshot goes when that approval is retracted.</li>
    <li>Editor mutation receipts store operation identifiers, request and content hashes, and permission results so retries do not repeat a write. They are deleted with the note; they do not retain another copy of its text.</li>
    <li>Opt-out entries are kept so the unsubscribe keeps being honored.</li>
    <li>Subscription levels, your commit-author email, and your notification email persist until you change them.</li>
    <li>The verified-email list lives only in your session cookie and is gone when you sign out or it expires.</li>
    <li>Personal access token records remain visible after expiry or revocation and are deleted when their owning editor account is deleted. Revocation stops further authentication immediately.</li>
    <li>Dismissed or incorporated amendment payloads are cleared after 90 days. Unreferenced review evidence is cleared after 90 days. Compact source identifiers, hashes and decision records remain to avoid repeating previously considered suggestions; accepting a proposal for editing keeps it open until a later decision.</li>
  </ul>
  <h2>Lawful basis</h2>
  <p>Legitimate interest: notifying collaborators about specs they own, edited, or chose to watch, and attributing spec commits to their author and reviewers. Every email carries a one-click unsubscribe.</p>
  <h2>Opt out and erasure</h2>
  <p>Use the unsubscribe link in any digest to stop all email.${SETTINGS_ENABLED ? ' On the <a href="/settings">settings page</a>, set every namespace back to Participating to clear subscriptions and set your author and notification emails back to Account default to clear those preferences.' : ''} For anything else, contact <b>${esc(PRIVACY_CONTACT)}</b>.</p>
  ${SETTINGS_ENABLED ? '<p>A recipient with no linked SpecDoc account can unsubscribe from any email, but must sign in once to re-enable it.</p>' : ''}
  <p><a href="/">Back to the board</a></p>`)
}

// Same graph the spec repos get, as an outline: the board is the one surface
// with no mermaid runtime.
function mapPage (nodes, ns, tags = new Map()) {
  // Only nodes on this page can be jumped to; anything else links out to the PR
  // instead of an anchor that goes nowhere.
  const onPage = new Set(nodes.map(n => n.id))
  const link = r => {
    const label = `${specLabel(r)} ${r.title || 'unknown spec'}`
    if (!r.id) return `<span class="miss" title="No tracked spec matches this reference">${esc(label)}</span>`
    if (onPage.has(r.id)) return `<a href="#s-${esc(r.id)}">${esc(label)}</a>`
    return `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(label)}</a>`
  }
  const refs = (label, list) => list.length
    ? `<div class="refs">${label} ${list.map(r => link(r)).join(', ')}</div>` : ''
  const nodeHtml = n => `
      <article class="node" id="s-${esc(n.id)}">
        <div class="node-heading"><h4><a class="title" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title)}</a></h4>
        <span class="badge${n.status === 'implemented' ? ' success' : ''}">${esc(n.status)}</span></div><p class="meta"><code>${esc(specLabel(n))}</code></p>
        ${n.abstract ? `<p class="abstract">${esc(n.abstract)}</p>` : ''}
        ${refs('depends on', n.dependsOn)}
        ${refs('needed by', n.neededBy)}
        ${n.retired.map(r => `<div class="retired">supersedes ${link(r)}</div>`).join('')}
      </article>`
  const areaHtml = ([area, group]) => `
      <section class="library-area"><div class="area-heading"><h3>${esc(area || 'unfiled')}</h3><span class="count">${group.length} ${group.length === 1 ? 'spec' : 'specs'}</span></div>
      <div>${group.map(nodeHtml).join('')}</div></section>`
  const sections = [...new Set(nodes.map(n => n.ns))].map(nsName => {
    const cp = tags.get(nsName)
    const line = cp ? `<p class="meta">Last checkpoint <b>${esc(cp.tag)}</b></p>` : ''
    return `<section class="library-namespace"><h2>${esc(nsName)}</h2>${line}${byArea(nodes.filter(n => n.ns === nsName)).map(areaHtml).join('')}</section>`
  }).join('')
  const namespaces = [...new Set([...NAMESPACES, ...nodes.map(n => n.ns), ...(ns ? [ns] : [])])]
  return basicPage('Spec library', `
    <div class="page-heading"><div><h1>Spec library</h1><p class="context">Approved and implemented specifications, grouped by area. Browse shared principles, dependencies and replacements.</p></div><span class="badge">${nodes.length} ${nodes.length === 1 ? 'spec' : 'specs'}</span></div>
    ${namespaces.length > 1 ? `<form class="filters" method="get" action="/map"><label>Namespace<select name="ns"><option value="">All namespaces</option>${namespaces.map(n => `<option value="${esc(n)}"${n === ns ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select></label><button>Apply</button></form>` : ''}
    ${sections || `<div class="empty-state"><h2>No approved specs yet</h2><p>Specifications appear here once approved.</p><a href="/${ns ? '?ns=' + encodeURIComponent(ns) : ''}">View work on the board</a></div>`}`, { page: 'library', ns })
}

// Wildcard, like HedgeDoc's own /<note>/download: everything here is already
// anonymously readable, no cookie is read, and Allow-Credentials is never set,
// so there is no ambient authority to expose. The editor-facing /api/roles and
// /api/note pin BASE_ORIGIN instead because only the editor calls them.
const API_CORS = { 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' }
// A page a client can hold in memory, and small enough that serialising one
// stays off the event loop's critical path.
const SPECS_PAGE_MAX = 500
// Snapshot responses cache for one poll; planning summaries override this.
const API_CACHE = { 'Cache-Control': 'no-store' }
const sendJson = (res, body, cache = API_CACHE) => {
  res.writeHead(200, { ...API_CORS, ...cache, 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}
const sendMarkdown = (res, body) => {
  res.writeHead(200, { ...API_CORS, ...API_CACHE, 'Content-Type': 'text/markdown; charset=utf-8' })
  res.end(body)
}
// Errors are json too, so a client parses success and failure the same way.
const sendError = (res, status, error) => {
  res.writeHead(status, { ...API_CORS, 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error }))
}
const apiMiss = res => sendError(res, 404, 'unknown spec')

function specsGet (res, url, snap) {
  const raw = url.searchParams.get('cursor') || ''
  const cursor = raw ? decodeCursor(raw) : null
  if (raw && !cursor) { sendError(res, 400, 'bad cursor'); return }
  const asked = Number(url.searchParams.get('limit'))
  const limit = Number.isInteger(asked) && asked > 0 ? Math.min(asked, SPECS_PAGE_MAX) : SPECS_PAGE_MAX
  const rows = specList(snap.specs, snap.state, {
    ns: url.searchParams.get('ns') || '',
    status: url.searchParams.get('status') || ''
  })
  sendJson(res, {
    at: new Date(snap.at).toISOString(),
    stale: snapshotStale(snap),
    ...specPage(rows, limit, cursor)
  }, { 'Cache-Control': 'no-store' })
}

// `body` is the published form, as the spec's PR would carry it. The revision
// endpoints serve the raw note, so a diff across the series is not swamped by
// the difference between the two.
function specGet (req, res, s, state) {
  const body = publishedBody(s)
  if (/text\/markdown/i.test(req.headers.accept || '')) { sendMarkdown(res, body); return }
  sendJson(res, { ...specSummary(s, state), body }, { 'Cache-Control': 'no-store' })
}

// HedgeDoc's revision saver runs on a 5-minute timer that also wants the note
// idle, so the live document is never in its list. The board holds that
// document and offers it as `current`. Every `time` is what the revision
// endpoint below takes.
function revisionList (spec, past) {
  const rows = (past || [])
    // null, '' and [] all coerce to 0, which would read as a 1970 revision.
    .filter(r => Number.isInteger(r.time) && r.time > 0)
    .map(r => ({ time: Number(r.time), at: new Date(Number(r.time)).toISOString(), length: r.length }))
    .sort((a, b) => b.time - a.time)
  return [{ time: 'current', at: spec.changed, length: spec.content.length }, ...rows]
}

// Addressed by shortid, never by `spec.url`: that carries the note alias, which
// HedgeDoc stores verbatim and Express percent-decodes, so an alias holding `?`
// or `/` would steer this off the revision endpoint. A shortid is nanoid over
// [A-Za-z0-9_-] and the board never accepts one from a request.
const editorNote = spec => `${BASE_URL}/${spec.id}`

async function revisionsGet (res, s) {
  let past = []
  try {
    const r = await fetch(`${editorNote(s)}/revision`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (r.ok) past = (await r.json()).revision || []
  } catch (e) { console.warn(`revisions ${s.id}:`, e.message) }
  sendJson(res, { revisions: revisionList(s, past) })
}

async function revisionGet (res, s, time) {
  if (time === 'current') { sendMarkdown(res, s.content); return }
  let body
  try {
    const r = await fetch(`${editorNote(s)}/revision/${time}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    // The editor refuses a note it will not show anonymously, and 404s a time
    // it has no revision for. Neither is this API's failure.
    if (!r.ok) { apiMiss(res); return }
    body = (await r.json()).content
  } catch (e) {
    // Nothing is written until the body is parsed: a throw after writeHead
    // reaches the handler's catch, whose own writeHead throws out of an async
    // listener nobody awaits, and node exits on that.
    sendError(res, 502, 'editor unreachable')
    return
  }
  sendMarkdown(res, typeof body === 'string' ? body : '')
}

function mapGet (res, url, snap = snapshot) {
  const ns = url.searchParams.get('ns') || ''
  const nodes = snap.graph.filter(n => !ns || n.ns === ns)
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
  res.end(mapPage(nodes, ns, checkpointCache))
}

// The map that rides in a spec PR. The spec being opened is not in the poller's
// state yet (its number is allocated in the same call, and the supersede is
// stamped after it returns), so both are overlaid here or the PR would carry a
// map that leaves out the very spec it adds.
function namespaceMapDoc (specs, state, spec, num) {
  const overlay = new Map(state)
  // A revision opens its own PR, but the spec keeps the number its first one
  // gave it: that is what every other spec cites it by.
  const number = (state.get(spec.id) || {}).pr_number || Number(num)
  overlay.set(spec.id, { ...(state.get(spec.id) || {}), namespace: spec.namespace, pr_number: number, superseded_at: null })
  if (spec.supersedes) {
    const old = spec.supersedes.noteId || refIndex(state).get(`${spec.supersedes.ns}#${spec.supersedes.n}`)
    if (old && old !== spec.id && overlay.has(old)) {
      overlay.set(old, { ...overlay.get(old), superseded_at: new Date().toISOString() })
    }
  }
  return mermaidMap(specGraph(specs, overlay), spec.namespace)
}

// README.md in the namespace's specs dir, written on the spec PR's own branch:
// the default branch is protected on a governed namespace.
async function writeNamespaceMap (repo, branch, token, path, message, doc, author) {
  const cur = await ghOrNull(`${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, token)
  if (cur && Buffer.from(cur.content, 'base64').toString() === doc) return
  await gh('PUT', `${repo}/contents/${path}`, {
    message,
    content: Buffer.from(doc).toString('base64'),
    branch,
    // Same author as the spec commit it rides with. Without it GitHub attributes
    // the commit to whatever address the token's account defaults to, which is
    // not the one the owner picked as their commit-author email.
    ...(author ? { author } : {}),
    ...(cur ? { sha: cur.sha } : {})
  }, token)
}

// GitHub fan-out cap: enough parallelism to hide latency, few enough that a
// namespace with hundreds of specs cannot open hundreds of sockets at once.
const GH_BATCH = 10
async function inBatches (items, fn) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(GH_BATCH, items.length) }, worker))
  return out
}

async function readRepoFile (repo, path, ref, token) {
  const cur = await ghOrNull(`${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`, token)
  return cur && cur.content != null ? Buffer.from(cur.content, 'base64').toString() : null
}

// Effective specs dir for a namespace, as openSpecPr resolves it.
async function nsSpecsDir (ns) {
  const roles = await namespaceRoles(ns)
  return roles && roles['specs-dir'] != null ? roles['specs-dir'] : SPECS_DIR
}

// What the tag would say. Kept pure so the manifest is testable: `git show
// specs/v3` is the only place a checkpoint records what was in it.
// What moved since the previous checkpoint. Added and revised come from the
// compare's file list (a spec file is one a state row claims, which covers
// top-level specs too); retired and implemented come from the board's own
// timestamps, so they survive a truncated compare. A spec can sit in two
// lists at once (revised and implemented in the same window); that is what
// happened. The retirement banner is a modified file on a retired row, which
// the superseded_at test keeps out of revised. null files = compare truncated.
// deltaFor(noteId): the requirement ids and diff excerpt between a note's two
// newest published texts, or null; see publishedDeltas.
function checkpointChanges ({ files, state, specs, graph, ns, cutAt, from, deltaFor = () => null }) {
  const rows = [...state.values()].filter(st => st.namespace === ns)
  const byPath = new Map(rows.filter(st => st.spec_path).map(st => [st.spec_path, st]))
  const byNode = new Map(graph.map(n => [n.id, n]))
  const base = path => String(path || '').replace(/^.*\//, '').replace(/\.md$/, '')
  const entry = st => {
    const node = byNode.get(st.note_id)
    const spec = findSpec(specs, st.note_id)
    return {
      id: st.note_id,
      label: node ? specLabel(node) : st.pr_number ? specNum(st.pr_number) : base(st.spec_path),
      title: (spec && spec.title) || base(st.spec_path),
      pr: st.pr_number || null,
      revision: st.revision || null,
      revisionPr: st.revision_pr || null,
      requirements: deltaFor(st.note_id)
    }
  }
  const after = t => t && Date.parse(t) > Date.parse(cutAt)
  const truncated = !Array.isArray(files) || files.length >= 300
  const changed = status => truncated
    ? []
    : files.filter(f => f.status === status && byPath.has(f.filename)).map(f => byPath.get(f.filename))
  const replacementOf = st => graph.find(n => n.retired.some(r => r.id === st.note_id))
  return {
    from,
    truncated,
    added: changed('added').map(entry),
    revised: changed('modified').filter(st => !st.superseded_at).map(entry),
    retired: rows.filter(st => after(st.superseded_at)).map(st => {
      const rep = replacementOf(st)
      return { ...entry(st), replacement: rep ? entry(state.get(rep.id)) : null }
    }),
    implemented: rows.filter(st => after(st.implemented_at)).map(entry)
  }
}

const changeLine = (kind, e) => {
  const one = t => String(t).replace(/\s+/g, ' ').trim()
  const rev = e.revision ? ` (rev ${e.revision}${e.revisionPr ? `, #${e.revisionPr}` : ''})` : ''
  const rep = kind === 'retired' ? (e.replacement ? `, replaced by ${e.replacement.label} ${one(e.replacement.title)}` : ', no replacement tracked') : ''
  const req = e.requirements && reqSummary(e.requirements) ? ` [${reqSummary(e.requirements)}]` : ''
  return `${kind} ${e.label} ${one(e.title)}${rev}${rep}${req}`
}

// Requirement deltas and a diff excerpt between the two newest published
// texts of each note that has two, for the checkpoint changelog.
async function publishedDeltas (noteIds) {
  const out = new Map()
  if (!noteIds.length) return out
  const { rows } = await pool.query(
    `SELECT id, note_id, label, body FROM (
       SELECT id, note_id, label, body, row_number() OVER (PARTITION BY note_id ORDER BY id DESC) AS rn
       FROM spec_board_snapshots WHERE kind = 'published' AND note_id = ANY($1)) t
     WHERE rn <= 2 ORDER BY id`, [noteIds])
  const byNote = new Map()
  for (const r of rows) {
    if (!byNote.has(r.note_id)) byNote.set(r.note_id, [])
    byNote.get(r.note_id).push(r)
  }
  for (const [id, list] of byNote) {
    if (list.length < 2) continue
    const [a, b] = list.slice(-2)
    out.set(id, {
      ...requirementDelta(requirementMap(a.body), requirementMap(b.body)),
      from: a.label,
      to: b.label,
      excerpt: diffText(wordDiff(a.body, b.body))
    })
  }
  return out
}
const CHANGE_KINDS = ['added', 'revised', 'retired', 'implemented']

function checkpointMessage (tag, nodes, ns, overlap, changes = null, summary = null) {
  const mine = nodes.filter(n => n.ns === ns && n.n).sort((a, b) => (b.area === TOP_AREA) - (a.area === TOP_AREA) || a.n - b.n)
  const lines = [`checkpoint ${tag}`, '', `${mine.length} spec${mine.length === 1 ? '' : 's'}`]
  for (const n of mine) lines.push(`${specLabel(n)} ${String(n.title).replace(/\s+/g, ' ').trim()}`)
  if (changes) {
    const counts = CHANGE_KINDS.filter(k => changes[k].length).map(k => `${changes[k].length} ${k}`)
    const cap = changes.truncated ? ' (file list truncated: added and revised omitted)' : ''
    lines.push('', `since ${changes.from}: ${counts.length ? counts.join(', ') : 'no spec changes'}${cap}`)
    for (const k of CHANGE_KINDS) for (const e of changes[k]) lines.push(`  ${changeLine(k, e)}`)
    if (summary && summary.summary) lines.push('', `summary from ${summary.bot}, advisory:`, summary.summary)
  }
  const found = (overlap && overlap.findings) || []
  if (found.length) {
    lines.push('', `${found.length} overlap finding${found.length === 1 ? '' : 's'} acknowledged`)
    for (const f of found) lines.push(`  ${specNum(f.a)} vs ${specNum(f.b)}  ${f.why}`)
  }
  return lines.join('\n') + '\n'
}

// Everything the checkpoint page and the cut need for one namespace, read at
// the default branch head. overlap: run the advisory LLM pass too (a model call
// over the whole corpus, so only on an admin's page load or cut).
// ns -> { head, deltas }, like the overlap and summary caches: the diffs
// hold until the repo moves.
const deltaCache = new Map()
async function checkpointState (ns, { overlap = false } = {}) {
  // Every check is the repo tree read against the poller's view of the specs.
  // A cold or lock-losing replica has an empty view, which would read as every
  // spec file being an orphan.
  if (snapshotStale()) throw new Error('the board snapshot is stale, wait for the next poll')
  const repo = `/repos/${ns}`
  const token = await serviceTokenFor(ns)
  const { default_branch: base } = await gh('GET', repo, null, token)
  const { object: { sha: head } } = await gh('GET', `${repo}/git/ref/heads/${base}`, null, token)
  const specsDir = await nsSpecsDir(ns)
  const tree = await ghOrNull(`${repo}/git/trees/${head}?recursive=1`, token)
  const paths = new Set(((tree && tree.tree) || []).filter(e => e.type === 'blob').map(e => e.path))
  const { specs, state: live, graph } = await visibleSnapshot()

  // Legacy rows predate spec_path, and an unclaimed path is what orphan
  // detection keys on. Fill in what the PR file lists still answer for; if any
  // path stays unknown the orphan check would accuse a real spec, so it is
  // skipped instead.
  const mapDoc = specsDir ? readRepoFile(repo, `${specsDir}/README.md`, head, token) : null
  const state = new Map(live)
  const unpathed = [...state.values()].filter(st =>
    st.namespace === ns && st.pr_number && st.pr_state === 'merged' && !st.spec_path)
  const resolved = await inBatches(unpathed, st =>
    specPathFromPr(repo, st.pr_number, token, specsDir || null).catch(() => null))
  unpathed.forEach((st, i) => {
    if (resolved[i]) state.set(st.note_id, { ...st, spec_path: resolved[i] })
  })
  const orphans = resolved.every(Boolean)

  // ponytail: one read per retired spec, and they only ever accumulate. Fetch
  // the banner with the tree (GraphQL) if a namespace grows enough for the
  // ceil(n/GH_BATCH) round trips to drag.
  const retiredPaths = [...state.values()]
    .filter(st => st.namespace === ns && st.superseded_at && st.spec_path && paths.has(st.spec_path))
    .map(st => st.spec_path)
  const texts = await inBatches(retiredPaths, p => readRepoFile(repo, p, head, token).catch(() => null))
  const banners = new Map(retiredPaths.map((p, i) => [p, SUPERSEDE_BANNER.test(texts[i] || '')]))

  const committedMap = await mapDoc
  const blockers = checkpointBlockers({ ns, specsDir, nodes: graph, specs, state, paths, committedMap, banners, orphans })

  const refs = await ghOrNull(`${repo}/git/matching-refs/tags/specs/v`, token) || []
  const { latest, next } = checkpointTags(refs)
  let cutAt = null
  let changes = null
  let latestHead = null
  if (latest && latest.sha) {
    // Annotated: the tagger date is when the checkpoint was cut, which the
    // tagged commit's own date is not (head can be weeks old at a quiet time).
    const obj = await ghOrNull(`${repo}/git/tags/${latest.sha}`, token)
    if (obj) {
      cutAt = obj.tagger && obj.tagger.date
      latestHead = obj.object.sha
      const cmp = await ghOrNull(`${repo}/compare/${obj.object.sha}...${head}`, token)
      // The compare file list is capped server-side; checkpointChanges treats
      // a capped one as unreadable rather than an undercount presented as fact.
      const hit = deltaCache.get(ns)
      const deltas = hit && hit.head === head
        ? hit.deltas
        : await publishedDeltas([...state.values()].filter(st => st.namespace === ns && st.revision).map(st => st.note_id))
      deltaCache.set(ns, { head, deltas })
      changes = checkpointChanges({ files: cmp && cmp.files, state, specs, graph, ns, cutAt, from: latest.tag, deltaFor: id => deltas.get(id) || null })
    }
  }

  let ov = null
  let summary = null
  if (overlap) {
    const hit = overlapCache.get(ns)
    if (hit && hit.head === head) ov = hit.result
    else {
      ov = await findOverlap(ns, graph, specs).catch(e => ({ findings: [], bot: null, skipped: [], error: e.message }))
      if (!ov.error) overlapCache.set(ns, { head, result: ov })
    }
    const sh = summaryCache.get(ns)
    if (sh && sh.head === head) summary = sh.summary
    else {
      // Advisory: a failed paragraph is shown as failed and never blocks the cut.
      summary = await summarizeChanges(ns, changes, graph, specs).catch(e => ({ bot: null, error: e.message }))
      summaryCache.set(ns, { head, summary })
    }
  }
  return { ns, base, head, specsDir, latest, latestHead, next, cutAt, changes, blockers, orphans, overlap: ov, summary, count: graph.filter(n => n.ns === ns && n.n).length }
}

// Tag the head. Tags are not branch-protected, so this needs no PR and no
// webhook. Annotated, because the message is the checkpoint's manifest.
async function cutCheckpoint (ns, ack) {
  const cp = await checkpointState(ns, { overlap: true })
  if (cp.blockers.length) return { error: `${cp.blockers.length} unresolved`, cp }
  // A resubmitted or double-clicked cut would otherwise tag an empty vN+1 on
  // the commit vN already marks.
  if (cp.latestHead && cp.latestHead === cp.head) return { error: `${cp.latest.tag} already marks this head`, cp }
  const found = (cp.overlap && cp.overlap.findings) || []
  if (found.length && Number(ack) !== found.length) {
    return { error: 'overlap findings not acknowledged', cp }
  }
  const repo = `/repos/${ns}`
  const token = await serviceTokenFor(ns)
  const obj = await gh('POST', `${repo}/git/tags`, {
    tag: cp.next,
    message: checkpointMessage(cp.next, (await visibleSnapshot()).graph, ns, cp.overlap, cp.changes, cp.summary),
    object: cp.head,
    type: 'commit'
  }, token)
  await gh('POST', `${repo}/git/refs`, { ref: `refs/tags/${cp.next}`, sha: obj.sha }, token)
  checkpointCache.set(ns, { tag: cp.next })
  await notify(`Checkpoint ${ns} ${cp.next}: ${cp.count} specs`)
  return { tag: cp.next, cp }
}

// The only remedy for a stale map: the default branch is protected on a
// governed namespace, so the board cannot just write it.
const MAP_REFRESH_BRANCH = 'specs-map-refresh'
async function refreshMapPr (ns) {
  if (snapshotStale()) return { error: 'the board snapshot is stale, wait for the next poll' }
  const repo = `/repos/${ns}`
  const token = await serviceTokenFor(ns)
  const specsDir = await nsSpecsDir(ns)
  if (!specsDir) return { error: 'no spec map at the repo apex' }
  const { default_branch: base } = await gh('GET', repo, null, token)
  const { object: { sha } } = await gh('GET', `${repo}/git/ref/heads/${base}`, null, token)
  const doc = mermaidMap((await visibleSnapshot()).graph, ns)
  const path = `${specsDir}/README.md`
  if (await readRepoFile(repo, path, sha, token) === doc) return { error: 'the map is already current' }
  try {
    await gh('POST', `${repo}/git/refs`, { ref: `refs/heads/${MAP_REFRESH_BRANCH}`, sha }, token)
  } catch (e) {
    if (e.status !== 422) throw e
    // A branch left from an earlier refresh is behind head; the map is the only
    // thing on it, so resetting loses nothing and keeps the PR diff to one file.
    await gh('PATCH', `${repo}/git/refs/heads/${MAP_REFRESH_BRANCH}`, { sha, force: true }, token)
  }
  const roles = await namespaceRoles(ns)
  const pfx = commitPrefix(roles)
  await writeNamespaceMap(repo, MAP_REFRESH_BRANCH, token, path, `${pfx}refresh spec map`, doc, null)
  const owner = ns.slice(0, ns.indexOf('/'))
  const open = await gh('GET', `${repo}/pulls?state=open&head=${owner}:${encodeURIComponent(MAP_REFRESH_BRANCH)}`, null, token)
  if (open.length) return { pr: open[0].number }
  const pr = await gh('POST', `${repo}/pulls`, {
    title: `${pfx}refresh spec map`,
    head: MAP_REFRESH_BRANCH,
    base,
    body: 'Regenerated from the board so a checkpoint can be cut.'
  }, token)
  return { pr: pr.number }
}

// Which X-Forwarded-For entry is the caller. Each proxy appends the address it
// received from, so reading the header left to right walks towards the server:
// with `hops` proxies in front, the caller sits `hops` from the near end of
// [socket peer, ...header reversed]. Anything a caller writes into the header
// itself lands beyond that index and is never picked, which is what makes the
// limiter's key unforgeable. hops 0 ignores the header and trusts the socket.
function clientIp (req, hops) {
  const peer = (req.socket && req.socket.remoteAddress) || 'unknown'
  if (!hops) return peer
  const xff = String((req.headers && req.headers['x-forwarded-for']) || '')
    .split(',').map(v => v.trim()).filter(Boolean).reverse()
  const chain = [peer, ...xff]
  // Short header: a caller who strips hops cannot reach past the addresses the
  // proxies actually added, so this clamps to the furthest trusted one.
  return chain[Math.min(hops, chain.length - 1)]
}

// Fixed-window per-IP limiter: 120 requests / 10s. Entries expire lazily; the
// size cap bounds memory if a flood spreads across many source IPs.
const RATE_WINDOW_MS = 10000
const RATE_MAX = 120
const rateBuckets = new Map() // ip -> { count, resetAt }
// scope: a second, smaller bucket for a route whose work per request is
// large (the diff routes), on top of the shared one.
function rateLimited (req, scope = '', max = RATE_MAX) {
  const key = clientIp(req, TRUSTED_PROXIES) + scope
  const now = Date.now()
  let b = rateBuckets.get(key)
  if (!b || now > b.resetAt) {
    if (rateBuckets.size > 10000) rateBuckets.clear()
    b = { count: 0, resetAt: now + RATE_WINDOW_MS }
    rateBuckets.set(key, b)
  }
  return ++b.count > max
}
const diffLimited = req => rateLimited(req, ':changes', 20)

async function feedbackModelCall (bot, ...args) {
  const health = botHealth.get(bot.name)
  if (reviewBudget <= 0 || reviewFailedBots.has(bot.name) || (health && tickCount < health.retryTick)) {
    throw Object.assign(new Error('review budget unavailable'), { code: 'budget' })
  }
  reviewBudget--
  try {
    const result = await callBotJson(bot, ...args)
    botHealth.delete(bot.name)
    return result
  } catch (e) {
    await botFailed(bot, e)
    throw e
  } finally { beat() }
}

const feedback = createFeedbackService({
  store: feedbackStore, gh, namespaces: NAMESPACES, roles: feedbackRoles,
  getSpecs: async () => specsFromRows(await queryNotes(), await loadState()), getState: loadState, getBots: loadBots,
  hashBody: spec => publishedHash(publishedBody(spec)), publicSpec: spec => publicSpecs([spec]).length > 0,
  getBody: publishedBody,
  session, csrfToken, isAdmin, readBody, startLogin, redirect, basicPage, progress: beat, applyProposals
})

async function roadmapCurrentSpec (id, db) {
  const { rows } = await db.query(`SELECT n.id, n.shortid, n.alias, n.title, n.content, n.permission, n."lastchangeAt"
    FROM "Notes" n WHERE n.shortid=$1 FOR SHARE`, [id])
  const { rows: [st] } = await db.query('SELECT namespace, pr_number, superseded_at FROM spec_board_state WHERE note_id=$1 FOR SHARE', [id])
  const spec = publicSpecs(specsFromRows(rows, new Map(st ? [[id, st]] : [])))[0]
  if (!spec) return null
  return { ...spec, superseded: !!(st && st.superseded_at) }
}

async function roadmapCheckpoint (namespace, tag) {
  if (!githubEnabled) throw roadmapError(503, 'GitHub is required to link a checkpoint')
  const token = await serviceTokenFor(namespace)
  const repo = `/repos/${namespace}`
  try {
    const ref = await gh('GET', `${repo}/git/ref/tags/${tag}`, undefined, token)
    if (!ref || !ref.object || ref.object.type !== 'tag') throw roadmapError(400, 'Choose an existing annotated spec checkpoint')
    const obj = await gh('GET', `${repo}/git/tags/${ref.object.sha}`, undefined, token)
    if (!obj || !obj.object || obj.object.type !== 'commit' || !/^[a-f0-9]{40,64}$/.test(obj.object.sha)) throw roadmapError(400, 'Checkpoint must reference a commit')
    return { commit: obj.object.sha }
  } catch (e) {
    if (e.status === 404) throw roadmapError(400, 'Checkpoint not found')
    if (e.status === 400) throw e
    throw roadmapError(503, 'Could not validate the checkpoint; try again later')
  }
}

const roadmapService = createRoadmapService({
  store: roadmapStore, namespaces: NAMESPACES, roles: feedbackRoles, isAdmin, canApprove,
  session, csrfToken, readBody, startLogin, redirect, basicPage, loginEnabled: SETTINGS_ENABLED,
  snapshot: visibleSnapshot, stale: snapshotStale, currentSpec: roadmapCurrentSpec, checkpoint: roadmapCheckpoint
})

async function handleRequest (req, res) {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      // Probe target: process-alive only, no DB roundtrip, so a DB outage
      // degrades to error pages instead of a probe-driven restart loop.
      // pollStale is informational (monitoring, curl); it never fails the
      // probe, since restarting the pod cannot fix a dead DB or GitHub.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, lastPollOk, pollStale: pollStale() }))
      return
    }
    if (req.method === 'GET' && url.pathname === '/statusz') {
      // External-monitor target: unlike /healthz this DOES fail on a stale
      // poller, so a status-code check catches poller degradation. Never
      // point the kubelet probes here; a restart cannot fix a dead DB.
      const stale = pollStale()
      const subsystems = health.status()
      if (subsystems.mail && subsystems.mail.oldestAt) subsystems.mail.oldestAgeSeconds = Math.max(0, Math.floor((Date.now() - Date.parse(subsystems.mail.oldestAt)) / 1000))
      const degraded = stale || !publicationSchema.ready || Object.values(subsystems).some(s => s.enabled !== false && s.ok === false)
      res.writeHead(degraded ? 503 : 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({
        ok: !degraded,
        lastPollOk,
        lastPollBeat,
        pollStale: stale,
        githubEnabled,
        publicationSchema,
        subsystems,
        githubQuota: ghQuota,
        githubPausedUntil: ghPausedUntil(),
        // A wrong hop count silently breaks the rate limiter in one of two
        // directions, and neither shows up in a log line.
        trustedProxies: TRUSTED_PROXIES,
        failingBots: [...botHealth.entries()].map(([name, h]) => ({ name, failures: h.failures, since: h.failingSince })),
        publishBackoff: publishHealth.size,
        feedback: feedback.status,
        namespacesFailingPreflight: preflightCache.filter(r => r.status !== 'PASS').map(r => r.ns)
      }))
      return
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [type, body] = STATIC[url.pathname]
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' })
      res.end(body)
      return
    }
    // Coarse per-IP rate limit on the dynamic routes below (each hits the DB
    // or GitHub). Probes and static assets returned above are exempt. The cap
    // is well above any human's interactive rate; it only blunts scripted
    // abuse of the OAuth and settings paths.
    if (rateLimited(req)) { res.writeHead(429, { 'Retry-After': '10' }).end('slow down'); return }
    if (lifecycle.stopping) { res.writeHead(503, { 'Retry-After': '5' }).end('server draining'); return }
    const contentRoute = url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/map' ||
      /^\/(?:changes|spec|api\/specs|api\/note)(?:\/|$)/.test(url.pathname)
    const view = contentRoute ? await visibleSnapshot() : null
    if (url.pathname === '/roadmap' || url.pathname === '/api/roadmap' || url.pathname === '/api/milestones' || url.pathname.startsWith('/api/milestones/')) {
      await roadmapService.handle(req, res, url)
      return
    }
    if (url.pathname === '/feedback' || url.pathname === '/feedback/settings') {
      if (!SETTINGS_ENABLED) { res.writeHead(503).end('settings not configured'); return }
      await feedback.handle(req, res, url)
      return
    }
    const rolesMatch = /^\/api\/roles\/([\w.-]+\/[\w.-]+)$/.exec(url.pathname)
    if (req.method === 'GET' && rolesMatch) {
      await serveRoles(res, rolesMatch[1])
      return
    }
    // Served from the public snapshot, so a note guests cannot read 404s here
    // and the header falls back to what the note itself declares.
    const noteMatch = /^\/api\/note\/([\w-]{1,128})(\/approvals)?$/.exec(url.pathname)
    if (noteMatch && noteMatch[2]) {
      const cors = { 'Access-Control-Allow-Origin': BASE_ORIGIN, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'content-type' }
      if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return }
      if (req.method !== 'POST') { res.writeHead(405, cors).end('method not allowed'); return }
      const spec = findSpec(view.specs, noteMatch[1])
      if (!spec) { res.writeHead(404, cors).end(JSON.stringify({ error: 'the board does not know this note yet' })); return }
      await noteApprovalPost(req, res, spec)
      return
    }
    if (req.method === 'GET' && noteMatch) {
      const rec = noteRecord(noteMatch[1], view.specs, view.state)
      const cors = { 'Access-Control-Allow-Origin': BASE_ORIGIN }
      if (!rec) { res.writeHead(404, cors).end('unknown note'); return }
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(rec))
      return
    }
    // One arm owns the whole space, so a malformed path answers with the api's
    // own 404 rather than falling through to the board's bare one.
    if (url.pathname === '/api/specs' || url.pathname.startsWith('/api/specs/')) {
      if (req.method === 'OPTIONS') { res.writeHead(204, API_CORS).end(); return }
      if (req.method !== 'GET') { sendError(res, 405, 'method not allowed'); return }
      const rest = url.pathname.slice('/api/specs'.length)
      const plannedSpecs = await roadmapService.decorate(view.specs)
      if (rest === '') { specsGet(res, url, { ...view, specs: plannedSpecs }); return }
      const m = /^\/([\w-]{1,128})(?:\/(?:(revisions)(?:\/(current|[1-9]\d{0,19}))?|(changes)))?$/.exec(rest)
      const spec = m && findSpec(plannedSpecs, m[1])
      if (!spec) { apiMiss(res); return }
      if (m[4]) {
        if (diffLimited(req)) { res.writeHead(429, { 'Retry-After': '10' }).end('slow down'); return }
        await changesApiGet(res, spec, url)
      }
      else if (m[3]) await revisionGet(res, spec, m[3])
      else if (m[2]) await revisionsGet(res, spec)
      else specGet(req, res, spec, view.state)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/namespaces') {
      const poller = { lastPollOk, stale: pollStale() }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ namespaces: preflightCache, poller }))
      return
    }
    if (url.pathname === '/map' && req.method === 'GET') {
      mapGet(res, url, view)
      return
    }
    if (req.method === 'GET' && url.pathname.startsWith('/changes/')) {
      const id = url.pathname.slice('/changes/'.length)
      const spec = /^[\w-]{1,128}$/.test(id) && findSpec(view.specs, id)
      if (!spec) { res.writeHead(404).end('unknown spec'); return }
      if (diffLimited(req)) { res.writeHead(429, { 'Retry-After': '10' }).end('slow down'); return }
      await changesGet(req, res, spec, url)
      return
    }
    // Stable address for a spec reference, so the editor can linkify
    // "owner/repo#12" without fetching anything: only the board knows which
    // note a spec number belongs to.
    const refMatch = /^\/spec\/([\w.-]+\/[\w.-]+)\/(\d+)$/.exec(url.pathname)
    if (req.method === 'GET' && refMatch) {
      const target = specRefTarget(refMatch[1], Number(refMatch[2]), view.specs, view.state)
      if (!target) { res.writeHead(404).end('unknown namespace'); return }
      redirect(res, target)
      return
    }
    if (url.pathname === '/privacy' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
      res.end(privacyPage())
      return
    }
    if (url.pathname === '/unsub') {
      if (!EMAIL_ENABLED) { res.writeHead(503).end('email not configured'); return }
      if (req.method === 'GET') { unsubGet(res, url); return }
      if (req.method === 'POST') { await unsubPost(res, url); return }
      res.writeHead(405).end('method not allowed')
      return
    }
    if (url.pathname === '/bots') {
      if (!BOTS_ENABLED) { res.writeHead(503).end('bot management not configured'); return }
      if (req.method === 'GET') { await botsGet(req, res, url); return }
      if (req.method === 'POST') { await botsPost(req, res); return }
      res.writeHead(405).end('method not allowed')
      return
    }
    if (url.pathname === '/checkpoints') {
      if (!BOTS_ENABLED) { res.writeHead(503).end('board admins not configured'); return }
      if (!githubEnabled) { res.writeHead(503).end('github not configured'); return }
      if (req.method === 'GET') { await checkpointsGet(req, res, url); return }
      if (req.method === 'POST') { await checkpointsPost(req, res); return }
      res.writeHead(405).end('method not allowed')
      return
    }
    if (url.pathname === '/settings' || url.pathname.startsWith('/auth/github') || url.pathname === '/logout') {
      if (!SETTINGS_ENABLED) { res.writeHead(503).end('notification settings not configured'); return }
      if (url.pathname === '/auth/github' && req.method === 'GET') { startLogin(req, res); return }
      if (url.pathname === '/auth/github/callback' && req.method === 'GET') { await finishLogin(req, res, url); return }
      if (url.pathname === '/settings' && req.method === 'GET') { await settingsGet(req, res, url); return }
      if (url.pathname === '/settings' && req.method === 'POST') { await settingsPost(req, res); return }
      if (url.pathname === '/logout') { setCookie(res, 'sb_session', '', 0); redirect(res, '/'); return }
      res.writeHead(404).end('not found')
      return
    }
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      res.writeHead(404).end('not found')
      return
    }
    const q = url.searchParams.get('q') || ''
    const ns = url.searchParams.get('ns') || ''
    // Search uses the permission-checked snapshot. % and _ are literal.
    const ql = q.toLowerCase()
    const storedPlanning = await roadmapStore.read({ namespaces: ns ? [ns] : NAMESPACES, noteIds: view.specs.map(s => s.id) })
    const allPlannedSpecs = decoratePlanningSpecs(view.specs, storedPlanning)
    const planning = { milestone: url.searchParams.get('milestone') || '', implementer: url.searchParams.get('implementer') || '', who: SETTINGS_ENABLED ? session(req) : null,
      milestones: storedPlanning.milestones.filter(m => NAMESPACES.includes(m.namespace) && (!ns || m.namespace === ns)),
      implementers: [...new Map(allPlannedSpecs.filter(s => !ns || s.namespace === ns).flatMap(s => s.implementers).map(u => [u.id, u])).values()] }
    let specs = filterPlanningSpecs(allPlannedSpecs, planning, planning.who)
    if (ns) specs = specs.filter(s => s.namespace === ns)
    if (ql) specs = specs.filter(s => s.title.toLowerCase().includes(ql) || (s.content || '').toLowerCase().includes(ql))
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(render(buildBoard(specs, view.state), q, ns, planning))
  } catch (e) {
    console.error(e)
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('server error')
  }
}

const server = http.createServer((req, res) => lifecycle.track(handleRequest(req, res)))

if (require.main === module) {
  const timers = []
  lifecycle.track(withAdvisoryLock(true, ensureState).then(refreshSnapshot).then(() => {
    if (lifecycle.stopping) return
    server.listen(PORT, () => console.log(`spec-board on :${PORT}`))
    const preflight = () => lifecycle.track(runPreflight()).catch(error => console.error('preflight:', error.message))
    const tick = () => lifecycle.track(poll())
    preflight()
    timers.push(setInterval(preflight, ROLES_TTL_MS), setInterval(tick, POLL_SECONDS * 1000))
    tick()
  })).catch(error => {
    if (!lifecycle.stopping) {
      console.error('startup:', error)
      process.exit(1)
    }
  })
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`${signal}: draining`)
      lifecycle.shutdown({
        stopTimers: () => timers.forEach(clearInterval),
        closeServer: () => new Promise(resolve => {
          server.close(resolve)
          server.closeIdleConnections()
        }),
        closePool: () => pool.end()
      })
    })
  }
} else {
  module.exports = { placeProposals, retagInReview, recoverPublication, takeSnapshot, applySnapshotPlan, snapshotBody, migrateSnapshotIntegrity, currentPublicNote, withTx, upsertState, enqueueEmails, basicPage, settingsPage, botsPage, privacyPage, unsubGet, roadmapCheckpoint, render, frontmatter, metaTags, recordedApprovals, countApprovals, snapshotPlan, revisionNote, resolveSnapshotRef, defaultFrom, changesPage, resolveCritic, fenceRanges, countCommentThreads, countSuggestions, commentAnchorHash, threadAnchors, reviewHash, injectComments, callBot, botFailed, REVIEW_SYSTEM, validateBot, specsFromRows, applyRoles, quorumMet, canApprove, commitPrefix, buildBoard, slug, numberedSlug, normSpecsDir, stripFrontmatter, specAbstract, implementsRefs, specRef, dependsOnRefs, specGraph, specRefTarget, noteRecord, mermaidMap, mapPage, namespaceMapDoc, clientIp, specPage, encodeCursor, specsGet, specGet, revisionsGet, revisionGet, specSummary, specList, revisionList, checkpointTags, checkpointBlockers, checkpointChanges, parseSummary, CHANGELOG_SYSTEM, checkpointMessage, checkpointsPage, inBatches, overlapCorpus, parseOverlap, openSpecPr, revisionPlan, lockPlan, publishedBody, publishedHash, publicSpecs, shiftAuthorship, commentReviewers, reviewContext, mergePr, renderDigest, emailFooter, profileEmail, resolveRecipients, signToken, verifyToken }
}
