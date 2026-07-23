const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Pool } = require('pg')
const yaml = require('js-yaml')

const BASE_URL = process.env.HEDGEDOC_BASE_URL || 'http://localhost:3000'
const SPEC_TAG = (process.env.SPEC_TAG || 'spec').toLowerCase()
const PORT = process.env.PORT || 8080
const STALE_DAYS = Number(process.env.STALE_DAYS || 14)
const POLL_SECONDS = Number(process.env.POLL_SECONDS || 60)
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
const githubEnabled = !!(GITHUB_TOKEN || GITHUB_APP_ID)
const SPECS_DIR = process.env.SPECS_DIR || 'specs'
const ROLES_TTL_MS = 5 * 60 * 1000
// One hard deadline for every outbound call, GitHub/webhook fetches and pg
// queries alike; a hung socket must not wedge the poll loop.
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000)

// Public origin of the board itself, for links in email (which has no request
// to derive it from). HEDGEDOC_BASE_URL points at HedgeDoc, not here.
const SPEC_BOARD_BASE_URL = (process.env.SPEC_BOARD_BASE_URL || '').replace(/\/$/, '')
const SESSION_SECRET = process.env.SESSION_SECRET

// Email digest: quiet-period debounce per recipient. Each new event resets the
// window (see flushEmails); a burst collapses into one message.
const SMTP_HOST = process.env.SMTP_HOST
const SMTP_FROM = process.env.SMTP_FROM || 'specdoc@localhost'
const EMAIL_DEBOUNCE_MINUTES = Number(process.env.EMAIL_DEBOUNCE_MINUTES || 30)
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
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
  })
  : null

// Notification settings page: GitHub OAuth login + stateless signed-cookie
// session (Node crypto, no store). Disabled unless all three are set.
const OAUTH_CLIENT_ID = process.env.BOARD_OAUTH_CLIENT_ID
const OAUTH_CLIENT_SECRET = process.env.BOARD_OAUTH_CLIENT_SECRET
const SETTINGS_ENABLED = !!(OAUTH_CLIENT_ID && OAUTH_CLIENT_SECRET && SESSION_SECRET)
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
const IN_REVIEW_IDX = STATUS_INDEX.get('in-review')
const READY_IDX = STATUS_INDEX.get('ready-for-review')
const REVIEW_STATUSES = new Set(['ready-for-review', 'in-review'])

const pool = new Pool({
  statement_timeout: FETCH_TIMEOUT_MS,
  query_timeout: FETCH_TIMEOUT_MS,
  connectionTimeoutMillis: FETCH_TIMEOUT_MS
})

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

// Resolve CriticMarkup to its accepted form: keep insertions, drop
// deletions, apply substitutions, unwrap highlights, strip comments.
function resolveCritic (text) {
  return text
    .replace(/\{~~([\s\S]*?)~>([\s\S]*?)~~\}/g, '$2')
    .replace(/\{\+\+([\s\S]*?)\+\+\}/g, '$1')
    .replace(/\{--[\s\S]*?--\}/g, '')
    .replace(/\{==([\s\S]*?)==\}/g, '$1')
    .replace(/\{>>[\s\S]*?<<\}/g, '')
}

// Sentinel appended by the editor's Resolve button; mirrors RESOLVED_MARK in
// public/js/lib/critic-markup.js (separate service, no shared import).
const RESOLVED_MARK = '%%resolved%%'

// Count unresolved comment threads the way the editor and preview do: skip
// {>>...<<} inside fenced code (markdown-it never renders those) and merge
// directly-adjacent comments into one thread. A thread carrying the resolve
// sentinel is resolved and not counted, so the board's gate and badge stay in
// step with the comment icons a reviewer actually sees.
// ponytail: fenced blocks only, not inline `code` spans; matches the editor's
// scanCritic. Add inline-span handling if a spec ever hides a comment there.
function countCommentThreads (text) {
  const fences = []
  let open = -1
  let offset = 0
  for (const line of text.split('\n')) {
    if (/^ {0,3}(```|~~~)/.test(line)) {
      if (open === -1) open = offset
      else { fences.push([open, offset + line.length]); open = -1 }
    }
    offset += line.length + 1
  }
  if (open !== -1) fences.push([open, text.length])
  const inFence = pos => fences.some(([f, t]) => pos >= f && pos < t)

  const re = /\{>>((?:(?!\{>>)[\s\S])*?)<<\}/g
  let m
  let count = 0
  let prevEnd = -1
  let threadOpen = false
  let threadResolved = false
  const flush = () => { if (threadOpen && !threadResolved) count++ }
  while ((m = re.exec(text)) !== null) {
    if (inFence(m.index)) continue
    if (m.index !== prevEnd) { // a match adjacent to the last is a reply
      flush()
      threadOpen = true
    }
    threadResolved = m[1].trim() === RESOLVED_MARK // last message wins; a reply after the sentinel reopens
    prevEnd = m.index + m[0].length
  }
  flush()
  return count
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

function specsFromRows (rows) {
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
    if (idx === READY_IDX && comments > 0) idx = IN_REVIEW_IDX
    const ownerProfile = parseProfile(r.owner_profile)
    const author = ownerProfile.username || ownerProfile.displayName || (meta.owner && String(meta.owner)) || ''
    const namespace = meta.namespace ? String(meta.namespace).trim() : DEFAULT_NAMESPACE
    specs.push({
      id: r.shortid,
      title: r.title || r.shortid,
      url: `${BASE_URL}/${r.alias || r.shortid}`,
      changed: r.lastchangeAt,
      statusIdx: idx,
      author,
      authorLogin: String(meta.owner || ownerProfile.username || '').toLowerCase(),
      editor: profileName(r.editor_profile),
      comments,
      permission: r.permission,
      namespace,
      validNamespace: NAMESPACES.includes(namespace),
      tags,
      approvedBy: normList(meta['approved-by']),
      supersedes: supersedesRef(meta, namespace),
      // PR-as-author: only a GitHub OAuth token can act on github.com
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
  const approved = new Set(spec.approvedBy.map(a => a.toLowerCase()))
  spec.approvers = approvers
  spec.required = required
  spec.approvals = approvers.filter(a => approved.has(a.toLowerCase())).length
  spec.missingApprovers = approvers.filter(a => !approved.has(a.toLowerCase()))
  // A note tag matching the namespace's declared categories routes the spec
  // into a subdir; first match wins, unlisted tags are ignored.
  const categories = normList(roles && roles.categories).map(c => c.toLowerCase())
  spec.category = spec.tags.find(t => categories.includes(t)) || ''
  spec.roles = roles || null
  return spec
}

// Server-side gate on PR creation: the "approved" status tag is editable by
// anyone with note edit rights, so a governed spec must actually meet its
// approval bar before a PR is opened. Ungoverned specs (no approvers in the
// note or the namespace's roles.yml) fall back to the tag; branch protection
// on the repo is their real gate.
function quorumMet (spec) {
  if (spec.rolesUnknown) return false
  return spec.required === 0 || spec.approvals >= spec.required
}

// A spec only counts as approved once quorum is met AND every CriticMarkup
// comment thread is resolved (Resolve button, or deleting {>>...<<} from the
// note). resolveCritic strips whatever remains from the PR content.
function canApprove (spec) {
  return spec.comments === 0 && quorumMet(spec)
}

function esc (s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
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
    const idx = st && st.implemented_at ? IMPLEMENTED_IDX : s.statusIdx
    const ageDays = (Date.now() - new Date(s.changed).getTime()) / 86400000
    buckets[idx].push({
      ...s,
      pr: st && st.pr_number,
      prState: (st && st.pr_state) || 'open',
      stale: REVIEW_STATUSES.has(COLUMNS[idx].tag) && ageDays > STALE_DAYS
    })
  }
  for (const b of buckets) b.sort((a, c) => new Date(c.changed) - new Date(a.changed))
  return buckets
}

function render (buckets, q, ns) {
  // Render every lane; the Implemented lane ships hidden and a header toggle
  // reveals it (its cards still offer Replace, so shipped specs are reachable).
  const cols = COLUMNS.map((col, i) => {
    const reviewing = STATUS_INDEX.get(col.tag) >= IN_REVIEW_IDX
    const cards = buckets[i].map(c => {
      // Approvals only matter once review has started; hide the badge earlier.
      const approvals = (reviewing && c.approvers.length)
        ? `<span class="approvals" title="${esc(c.missingApprovers.length ? 'Waiting on: ' + c.missingApprovers.join(', ') : 'Fully approved')}">${c.approvals}/${c.required} approved</span>`
        : ''
      const chip = c.namespace
        ? `<span class="ns${c.validNamespace ? '' : ' ns-bad'}" title="${esc(c.validNamespace ? 'Namespace' : 'Unknown namespace, PR flow disabled')}">${esc(c.namespace)}</span>`
        : ''
      const cat = c.category ? `<span class="cat">${esc(c.category)}</span>` : ''
      const sup = c.supersedes
        ? `<span class="sup" title="Replaces ${esc(c.supersedes.ns)}#${c.supersedes.n}">supersedes #${c.supersedes.n}</span>`
        : ''
      const meta = [
        chip,
        cat,
        sup,
        c.author && `by ${esc(c.author)}`,
        c.editor && c.editor !== c.author && `edited by ${esc(c.editor)}`,
        c.comments > 0 && (col.tag === 'approved'
          ? `<span class="blocking" title="Unresolved comment threads block approval">${c.comments} unresolved comment${c.comments === 1 ? '' : 's'}</span>`
          : `${c.comments} comment${c.comments === 1 ? '' : 's'}`),
        approvals,
        c.stale && `<span class="stale-tag" title="No changes for over ${STALE_DAYS} days while awaiting review">stale</span>`,
        `<span title="${esc(new Date(c.changed).toISOString())}">${esc(relTime(c.changed))}</span>`
      ].filter(Boolean).join(' · ')
      const prLabel = c.prState === 'merged' ? `#${c.pr} merged` : c.prState === 'closed' ? `#${c.pr} closed` : `#${c.pr}`
      const pr = c.pr
        ? ` <a class="pr pr-${esc(c.prState)}" href="https://github.com/${esc(c.namespace)}/pull/${c.pr}" target="_blank" rel="noopener">${prLabel}</a>`
        : ''
      // Replaceable: anything with a PR to reference (by number), plus
      // implemented specs even without one (referenced by note id, so a
      // hand-marked spec is still reachable). Starts a new spec in the same
      // namespace with supersedes prefilled.
      const replace = (c.pr || i === IMPLEMENTED_IDX)
        ? ` <a class="replace" href="${esc(BASE_URL)}/new/spec?namespace=${encodeURIComponent(c.namespace)}&supersedes=${encodeURIComponent(c.pr || c.id)}" title="Start a spec that replaces this one">Replace</a>`
        : ''
      // Reviewers still owed a review (only once review has started) drive the
      // "To review" me-chip; the full approver list drives the person picker's
      // reviewer match. Author drives "My specs".
      const reviewLogins = (reviewing && c.approvers.length)
        ? c.missingApprovers.map(a => a.toLowerCase()).join(' ')
        : ''
      const reviewerLogins = c.approvers.length ? c.approvers.map(a => a.toLowerCase()).join(' ') : ''
      return `
      <div class="card${c.stale ? ' stale' : ''}" data-author="${esc(c.authorLogin)}" data-review="${esc(reviewLogins)}" data-reviewers="${esc(reviewerLogins)}">
        <a class="title" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a>${pr}${replace}
        <div class="meta">${meta}</div>
      </div>`
    }).join('')
    const impl = i === IMPLEMENTED_IDX
    return `
    <section class="col${impl ? ' implemented' : ''}"${impl ? ' hidden' : ''}>
      <h2>${esc(col.label)} <span class="count">${buckets[i].length}</span></h2>
      ${cards}<div class="empty"${cards ? ' hidden' : ''}>-</div>
    </section>`
  }).join('')

  const nsOptions = NAMESPACES.map(n =>
    `<option value="${esc(n)}"${n === ns ? ' selected' : ''}>${esc(n)}</option>`).join('')

  // People for the assignee picker: every author + every declared reviewer.
  const people = new Set()
  for (const b of buckets) for (const s of b) {
    if (s.authorLogin) people.add(s.authorLogin)
    for (const a of (s.approvers || [])) people.add(a.toLowerCase())
  }
  const personOptions = [...people].sort().map(p =>
    `<option value="${esc(p)}">${esc(p)}</option>`).join('')

  const multiNs = NAMESPACES.length > 1

  // New spec: pick a namespace when more than one exists; the app fills it into
  // the template. A single namespace needs no dropdown.
  const newSpec = multiNs
    ? `<form class="newspec" method="get" action="${esc(BASE_URL)}/new/spec">
    <select name="namespace" aria-label="Namespace for new spec">${NAMESPACES.map(n => `<option value="${esc(n)}"${n === DEFAULT_NAMESPACE ? ' selected' : ''}>${esc(n)}</option>`).join('')}</select>
    <button>New spec</button>
  </form>`
    : `<a class="new" href="${esc(BASE_URL)}/new/spec${DEFAULT_NAMESPACE ? '?namespace=' + encodeURIComponent(DEFAULT_NAMESPACE) : ''}">New spec</a>`

  // Namespace filter is a no-op with one namespace; only render it when it can
  // actually narrow anything. Lives inside the search form so it submits with q.
  const nsFilter = multiNs
    ? `<select name="ns" aria-label="Filter by namespace" onchange="this.form.submit()"><option value="">all namespaces</option>${nsOptions}</select>`
    : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="shortcut icon" href="/favicon.ico">
<title>SpecBoard</title>
<style>
  @font-face { font-family: "Source Sans Pro"; font-weight: 400; font-style: normal; font-display: swap; src: url(/fonts/SourceSansPro-Regular.woff2) format("woff2"); }
  @font-face { font-family: "Source Sans Pro"; font-weight: 600; font-style: normal; font-display: swap; src: url(/fonts/SourceSansPro-Semibold.woff2) format("woff2"); }
  :root { color-scheme: light dark; }
  body { font: 14px/1.4 "Source Sans Pro", Helvetica, Arial, sans-serif; margin: 0; padding: 16px; background: light-dark(#fff, #333); }
  header { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: center; margin: 0 0 16px; }
  h1 { font-size: 18px; margin: 0; }
  h1 .logo { width: 22px; height: 22px; vertical-align: -5px; margin-right: 8px; display: block; }
  header input, header select { padding: 4px 8px; border: 1px solid #8885; border-radius: 4px; background: light-dark(#fff, #333); color: inherit; font: inherit; }
  header input:focus-visible, header select:focus-visible, .chip:focus-visible { outline: 2px solid #9a7409; outline-offset: 1px; }
  header button, header a.new, header a.settings { padding: 4px 10px; border: 1px solid #8885; border-radius: 4px; background: #8881; color: inherit; cursor: pointer; text-decoration: none; font-size: 13px; }
  header .newspec button, header a.new { border-color: #caa437; background: #efcb5f; color: #1c1917; font-weight: 600; }
  header .newspec button:hover, header a.new:hover { background: #e0b63f; border-color: #b8922f; }
  header .newspec { display: flex; gap: 6px; }
  /* center zone absorbs slack so the right-hand actions stay pinned */
  .find { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; flex: 1; min-width: 220px; }
  .search { display: flex; gap: 6px; flex: 1; min-width: 180px; }
  .search input[type=search] { flex: 1; min-width: 140px; }
  .filters { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .filters .chip { padding: 4px 10px; border: 1px solid #8885; border-radius: 4px; background: #8881; color: inherit; cursor: pointer; font-size: 13px; }
  .filters .chip.on { border-color: #caa437; background: #efcb5f; color: #1c1917; }
  /* view toggle is a low-frequency column switch, kept quiet so it never
     competes with the person filter or the primary action */
  .filters .chip.view { border-color: transparent; background: transparent; color: light-dark(#555, #aaa); padding: 4px 6px; }
  .filters .chip.view:hover { color: inherit; }
  .filters .chip.view.on { border-color: transparent; background: transparent; color: #9a7409; font-weight: 600; }
  .actions { display: flex; align-items: center; gap: 12px; margin-left: auto; }
  header a.settings { display: inline-flex; align-items: center; border-color: transparent; background: transparent; color: light-dark(#555, #aaa); padding: 4px; }
  header a.settings:hover { color: inherit; }
  header a.settings svg { display: block; }
  .board { display: flex; gap: 12px; align-items: flex-start; overflow-x: auto; }
  .col { flex: 1 0 200px; background: #8881; border-radius: 8px; padding: 8px; }
  .col h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; margin: 4px 4px 10px; color: light-dark(#555, #aaa); }
  .count { float: right; background: #8883; border-radius: 10px; padding: 0 7px; }
  .card { background: light-dark(#fff, #333); border: 1px solid #8883; border-radius: 6px; padding: 8px 10px; margin-bottom: 8px; }
  .card:hover { border-color: #caa437; }
  .card .title { font-weight: 600; text-decoration: none; color: inherit; }
  .card .title:hover { text-decoration: underline; }
  .card .pr { font-size: 12px; text-decoration: none; }
  .card .pr-open { color: #2da44e; }
  .card .pr-merged { color: #8250df; }
  .card .pr-closed { color: #cf222e; }
  .card .meta { color: light-dark(#555, #aaa); font-size: 12px; margin-top: 2px; }
  .card .stale-tag { color: #cf222e; }
  .card .blocking { color: #cf222e; }
  .card .approvals { color: #2da44e; }
  .card .ns { background: #8882; border-radius: 4px; padding: 0 5px; font-size: 11px; }
  .card .ns-bad { background: #cf222e33; color: #cf222e; }
  .card .cat { background: #efcb5f33; color: #9a7409; border-radius: 4px; padding: 0 5px; font-size: 11px; }
  .card .sup { background: #efcb5f33; color: #9a7409; border-radius: 4px; padding: 0 5px; font-size: 11px; }
  .card .replace { font-size: 12px; text-decoration: none; color: #9a7409; }
  .card .replace:hover { text-decoration: underline; }
  .card.stale { border-left: 3px solid #cf222e; }
  .empty { color: light-dark(#666, #999); text-align: center; padding: 12px; }
  .warn { background: #cf222e18; color: #cf222e; border: 1px solid #cf222e55; border-radius: 6px; padding: 6px 10px; margin: 0 0 12px; font-size: 13px; }
  @media (max-width: 600px) {
    .board { flex-direction: column; align-items: stretch; }
    .col { flex-basis: auto; }
    /* brand + primary action share the top line; search and filters stack full
       width below so the CTA stays visible without scrolling the row */
    header { gap: 10px; }
    h1 { flex: 1; }
    .find { order: 3; flex-basis: 100%; }
    .search { flex-basis: 100%; }
    .actions { order: 2; margin-left: 0; }
  }
</style>
</head>
<body>
<header>
  <h1><img class="logo" src="/apple-touch-icon.png" alt="SpecBoard"></h1>
  <div class="find">
    <form class="search" method="get" action="/">
      ${nsFilter}
      <input type="search" name="q" value="${esc(q)}" placeholder="Search specs">
    </form>
    <div class="filters">
      <select class="person" aria-label="Filter by person"><option value="">Anyone</option>${personOptions}</select>
      <span class="mefilters" hidden>
        <button type="button" class="chip" data-filter="mine" aria-pressed="false">My specs</button>
        <button type="button" class="chip" data-filter="review" aria-pressed="false">To review</button>
      </span>
      <button type="button" class="chip view" id="toggle-impl" aria-pressed="false">Show implemented</button>
    </div>
  </div>
  <div class="actions">
    ${SETTINGS_ENABLED ? '<a class="settings" href="/settings" title="Settings" aria-label="Settings"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></a>' : ''}
    ${newSpec}
  </div>
</header>
${!lastPollOk || Date.now() - lastPollOk > POLL_SECONDS * 3000 ? '<div class="warn">Poller degraded: PR, approval, and roles data may be stale. Check pod logs.</div>' : ''}
<div class="board">${cols}</div>
<script>
(function () {
  var ME_URL = ${JSON.stringify(BASE_URL)} + '/me';
  var KEY = 'specBoardFilters';
  var state = { chips: [], person: '' };
  try { Object.assign(state, JSON.parse(localStorage.getItem(KEY)) || {}); } catch (e) {}
  if (!Array.isArray(state.chips)) state.chips = [];
  var chips = [].slice.call(document.querySelectorAll('.mefilters .chip'));
  var cards = [].slice.call(document.querySelectorAll('.card'));
  var picker = document.querySelector('.person');
  var implBtn = document.getElementById('toggle-impl');
  var implCol = document.querySelector('.col.implemented');
  var me = '';
  function save () { localStorage.setItem(KEY, JSON.stringify(state)); }
  // OR across active terms (me-chips need identity; person picker matches any
  // author or assigned reviewer). No active term -> everything shows. Chips
  // only count once /me resolved, and a saved person missing from the picker
  // is dropped: a filter the header can't show must never hide cards.
  function matches (card, person, chipsOn) {
    if (!chipsOn.length && !person) return true;
    if (chipsOn.indexOf('mine') !== -1 && card.dataset.author === me) return true;
    if (chipsOn.indexOf('review') !== -1 && card.dataset.review.split(' ').indexOf(me) !== -1) return true;
    if (person && (card.dataset.author === person ||
        card.dataset.reviewers.split(' ').indexOf(person) !== -1)) return true;
    return false;
  }
  function apply () {
    if (state.person && picker &&
        ![].some.call(picker.options, function (o) { return o.value === state.person; })) {
      state.person = '';
      save();
    }
    var chipsOn = me ? state.chips : [];
    chips.forEach(function (ch) {
      var on = state.chips.indexOf(ch.dataset.filter) !== -1;
      ch.classList.toggle('on', on);
      ch.setAttribute('aria-pressed', on);
    });
    if (picker) picker.value = state.person;
    if (implBtn) { implBtn.classList.toggle('on', !!state.implemented); implBtn.setAttribute('aria-pressed', !!state.implemented); }
    if (implCol) implCol.hidden = !state.implemented;
    cards.forEach(function (card) { card.style.display = matches(card, state.person, chipsOn) ? '' : 'none'; });
    [].slice.call(document.querySelectorAll('.col')).forEach(function (col) {
      var total = col.querySelectorAll('.card').length;
      var n = [].slice.call(col.querySelectorAll('.card')).filter(function (c) { return c.style.display !== 'none'; }).length;
      var badge = col.querySelector('.count');
      if (badge) badge.textContent = n;
      var empty = col.querySelector('.empty');
      if (empty) {
        empty.hidden = n > 0;
        empty.textContent = total ? 'no matches' : '-';
      }
    });
  }
  if (picker) picker.addEventListener('change', function () { state.person = picker.value; save(); apply(); });
  if (implBtn) implBtn.addEventListener('click', function () { state.implemented = !state.implemented; save(); apply(); });
  apply();
  fetch(ME_URL, { credentials: 'include' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d || d.status !== 'ok' || !d.username) return;
      me = String(d.username).toLowerCase();
      document.querySelector('.mefilters').hidden = false;
      chips.forEach(function (ch) {
        ch.addEventListener('click', function () {
          var f = ch.dataset.filter, i = state.chips.indexOf(f);
          if (i === -1) state.chips.push(f); else state.chips.splice(i, 1);
          save(); apply();
        });
      });
      apply();
    })
    .catch(function () {});
  // Auto-refresh, skipped while a field has focus so it never eats a
  // half-typed search or snaps a dropdown shut.
  setInterval(function () {
    var el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT')) return;
    location.reload();
  }, 30000);
})();
</script>
</body>
</html>`
}

async function queryNotes (q) {
  const sql = `SELECT n.shortid, n.alias, n.title, n.content, n."lastchangeAt", n.permission,
      ou.profile AS owner_profile, ou."accessToken" AS owner_token, eu.profile AS editor_profile
    FROM "Notes" n
    LEFT JOIN "Users" ou ON ou.id = n."ownerId"
    LEFT JOIN "Users" eu ON eu.id = n."lastchangeuserId"` +
    (q ? ' WHERE n.title ILIKE $1 OR n.content ILIKE $1' : '')
  const { rows } = await pool.query(sql, q ? [`%${q}%`] : [])
  return rows
}

async function loadState () {
  const { rows } = await pool.query('SELECT note_id, status, comment_count, pr_number, implemented_at, approvals, namespace, category, pr_state, locked_at, superseded_at FROM spec_board_state')
  return new Map(rows.map(r => [r.note_id, r]))
}

// r: { id, status, comments, prNumber, implementedAt, approvals, namespace, category, prState, lockedAt, supersededAt }
async function upsertState (r) {
  await pool.query(
    `INSERT INTO spec_board_state (note_id, status, comment_count, pr_number, implemented_at, approvals, namespace, category, pr_state, locked_at, superseded_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (note_id) DO UPDATE SET status = $2, comment_count = $3, pr_number = $4, implemented_at = $5, approvals = $6, namespace = $7, category = $8, pr_state = $9, locked_at = $10, superseded_at = $11`,
    [r.id, r.status, r.comments, r.prNumber ?? null, r.implementedAt ?? null, r.approvals || 0,
      r.namespace || null, r.category == null ? null : r.category, r.prState ?? null, r.lockedAt ?? null, r.supersededAt ?? null])
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

// Spec author (Notes.ownerId) plus every participant the editor's authorship
// patch recorded in Authors. OAuth logins never populate Users.email
// (passportGeneralCallback stores only the profile JSON), so fall back to the
// profile's address. Guests have no Users row and drop out of the join.
async function participantUsers (shortid) {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.profile FROM "Notes" n JOIN "Users" u ON u.id = n."ownerId" WHERE n.shortid = $1
     UNION
     SELECT u.id, u.email, u.profile FROM "Notes" n
       JOIN "Authors" a ON a."noteId" = n.id
       JOIN "Users" u ON u.id = a."userId"
       WHERE n.shortid = $1`, [shortid])
  return rows
}

async function namespaceSubs (namespace) {
  const [watch, disabled] = await Promise.all([
    pool.query(
      `SELECT u.id, u.email, u.profile FROM spec_board_subscriptions s
         JOIN "Users" u ON u.id = s.user_id WHERE s.namespace = $1 AND s.level = 'watch'`, [namespace]),
    pool.query("SELECT user_id FROM spec_board_subscriptions WHERE namespace = $1 AND level = 'disabled'", [namespace])
  ])
  return { watchers: watch.rows, disabled: new Set(disabled.rows.map(r => r.user_id)) }
}

// (participants ∪ watchers) − disabled − globally opted-out, deduped to a list.
function resolveRecipients (participants, watchers, disabledIds, suppressed = new Set()) {
  const emails = new Set()
  for (const u of [...participants, ...watchers]) {
    if (disabledIds.has(u.id)) continue
    const addr = userEmail(u)
    if (addr && !suppressed.has(addr)) emails.add(addr)
  }
  return [...emails]
}

async function recipientEmailsForSpec (shortid, namespace) {
  const [participants, subs] = await Promise.all([
    participantUsers(shortid),
    namespace ? namespaceSubs(namespace) : Promise.resolve({ watchers: [], disabled: new Set() })
  ])
  const candidates = resolveRecipients(participants, subs.watchers, subs.disabled)
  if (!candidates.length) return []
  const keys = candidates.map(emailKey)
  const { rows } = await pool.query('SELECT email_hash FROM spec_board_optout WHERE email_hash = ANY($1)', [keys])
  const suppressed = new Set(rows.map(r => r.email_hash))
  return candidates.filter(e => !suppressed.has(emailKey(e)))
}

async function enqueueEmails (spec, lines) {
  if (!mailer || !lines.length) return
  const emails = await recipientEmailsForSpec(spec.id, spec.namespace)
  console.log(`email: enqueue ${spec.id} recipients=${emails.length} lines=${lines.length}`)
  for (const email of emails) {
    for (const line of lines) {
      await pool.query(
        'INSERT INTO spec_board_notifications (email, note_id, title, line) VALUES ($1, $2, $3, $4)',
        [email, spec.id, spec.title, line])
    }
  }
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

function renderDigest (rows, footer = '') {
  const titles = [...new Map(rows.map(r => [r.note_id, r.title || r.note_id])).values()]
  const subject = titles.length === 1 ? `SpecDoc: ${titles[0]}` : `SpecDoc: activity on ${titles.length} specs`
  return { subject, text: rows.map(r => `- ${r.line}`).join('\n') + '\n' + footer }
}

// Send to any recipient quiet for the debounce window, then drop the sent rows.
// Only captured ids are deleted, so a line arriving mid-send survives and resets
// the window. Send failure leaves the rows for the next poll to retry.
// ponytail: assumes a single flusher; two replicas would both send. Add
// SELECT ... FOR UPDATE SKIP LOCKED in a txn if the board is scaled out.
async function flushEmails () {
  if (!mailer) return
  let due
  try {
    ({ rows: due } = await pool.query(
      `SELECT email FROM spec_board_notifications
       GROUP BY email HAVING max(created_at) < now() - ($1 * interval '1 minute')`,
      [EMAIL_DEBOUNCE_MINUTES]))
  } catch (e) {
    console.error('email flush:', e.message)
    return
  }
  for (const { email } of due) {
    try {
      const { rows } = await pool.query(
        `SELECT id, note_id, title, line FROM spec_board_notifications
         WHERE email = $1 AND created_at < now() - ($2 * interval '1 minute') ORDER BY created_at`,
        [email, EMAIL_DEBOUNCE_MINUTES])
      if (!rows.length) continue
      // Opt-out can land after these rows were enqueued; re-check before sending
      // so nothing ships post-unsubscribe, and drain the stale rows either way.
      const { rows: opt } = await pool.query('SELECT 1 FROM spec_board_optout WHERE email_hash = $1', [emailKey(email)])
      if (opt.length) {
        await pool.query('DELETE FROM spec_board_notifications WHERE id = ANY($1)', [rows.map(r => r.id)])
        continue
      }
      const unsub = unsubUrl(email)
      const { subject, text } = renderDigest(rows, emailFooter(email, unsub))
      await mailer.sendMail({
        from: SMTP_FROM,
        to: email,
        subject,
        text,
        headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
      })
      await pool.query('DELETE FROM spec_board_notifications WHERE id = ANY($1)', [rows.map(r => r.id)])
    } catch (e) {
      console.error(`email to ${email}:`, e.message)
    }
  }
}

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
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS approvals int DEFAULT 0')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS category text')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS namespace text')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS pr_state text')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS locked_at timestamptz')
  await pool.query('ALTER TABLE spec_board_state ADD COLUMN IF NOT EXISTS superseded_at timestamptz')
}

// Index a namespace's PRs so a spec keeps its PR link through close/merge, and
// so a spec whose recorded number was lost is re-linked by matching the PR's
// head branch (which ends in the spec's slug).
async function namespacePRIndex (ns) {
  let prs
  try {
    ({ items: prs } = await ghPaged(`/repos/${ns}/pulls?state=all&per_page=100`))
  } catch (e) {
    console.error('pr list:', e.message)
    return null
  }
  const byNumber = new Map()
  const bySlug = new Map()
  for (const p of prs) {
    const state = p.merged_at ? 'merged' : p.state
    byNumber.set(p.number, state)
    const m = /^(?:[\w.-]+\/)?\d+-(.+)$/.exec(p.head.ref)
    if (m) {
      const cur = bySlug.get(m[1])
      if (!cur || p.number > cur.number) bySlug.set(m[1], { number: p.number, state })
    }
  }
  return { byNumber, bySlug }
}

async function notify (text) {
  if (!WEBHOOK_URL) return
  try {
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
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

const instTokenCache = new Map() // ns -> { token, exp(ms) }
async function installationToken (ns) {
  const cached = instTokenCache.get(ns)
  if (cached && Date.now() < cached.exp - 60000) return cached.token
  const jwt = appJwt()
  const inst = await gh('GET', `/repos/${ns}/installation`, null, jwt)
  const tok = await gh('POST', `/app/installations/${inst.id}/access_tokens`, {}, jwt)
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
      if (e.status === 404) appMissCache.set(ns, Date.now() + 3600000)
      else console.error('app token:', e.message)
    }
  }
  return GITHUB_TOKEN
}

async function serviceTokenForPath (path) {
  const m = /^\/repos\/([^/]+\/[^/]+)/.exec(path)
  return m ? serviceTokenFor(m[1]) : GITHUB_TOKEN
}

async function gh (method, path, body, token) {
  const resp = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token || await serviceTokenForPath(path)}`,
      accept: 'application/vnd.github+json',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!resp.ok) {
    const err = new Error(`${method} ${path}: ${resp.status} ${await resp.text()}`)
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

// GET that treats 404 as "absent" rather than an error.
async function ghOrNull (path, token) {
  try {
    return await gh('GET', path, null, token)
  } catch (e) {
    if (e.status === 404) return null
    throw e
  }
}

// RBAC as code: .specs/roles.yml (or root roles.yml) in each namespace repo. The enforceable
// gate stays CODEOWNERS + branch protection there; this only drives the UI.
const rolesCache = new Map()
// cacheOnly: page renders never block on a live GitHub fetch; the poller
// keeps the cache warm and a cold entry just renders without role data.
async function namespaceRoles (ns, cacheOnly) {
  const cached = rolesCache.get(ns)
  if (cached && Date.now() - cached.at < ROLES_TTL_MS) return cached.roles
  if (cacheOnly) return cached ? cached.roles : null
  let roles = null
  if (githubEnabled) {
    // Also accept roles.yml at the repo root, for specs-only repos where a
    // hidden .specs dir is redundant.
    try {
      let data
      for (const p of ['.specs/roles.yml', 'roles.yml']) {
        try { data = await gh('GET', `/repos/${ns}/contents/${p}`); break } catch (e) {
          if (e.status !== 404) throw e
        }
      }
      roles = data ? yaml.load(Buffer.from(data.content, 'base64').toString()) || null : null
    } catch (e) {
      // Only a 404 means "confirmed ungoverned". Any other failure serves the
      // stale entry, or reports unknown so the PR gate fails closed instead of
      // treating the namespace as ungoverned (required would become 0).
      if (e.status !== 404) {
        console.error('roles:', e.message)
        if (cached) {
          cached.at = Date.now()
          return cached.roles
        }
        return undefined
      }
    }
  }
  rolesCache.set(ns, { roles, at: Date.now() })
  return roles
}

async function rolesForSpecs (specs, cacheOnly) {
  const nsList = [...new Set(specs.filter(s => s.validNamespace).map(s => s.namespace))]
  const roles = await Promise.all(nsList.map(ns => namespaceRoles(ns, cacheOnly)))
  const byNs = new Map(nsList.map((ns, i) => [ns, roles[i]]))
  // undefined = roles fetch failed (gate must fail closed); null = confirmed absent
  for (const spec of specs) applyRoles(spec, spec.validNamespace ? byNs.get(spec.namespace) : null)
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
  checks.push = repo.permissions && repo.permissions.push ? 'pass' : 'fail'
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
async function runPreflight () {
  if (!githubEnabled) return
  preflightCache = await Promise.all(NAMESPACES.map(preflightNamespace))
  for (const r of preflightCache) {
    console.log(`preflight ${r.status} ${r.ns}: ${Object.entries(r.checks).map(([k, v]) => `${k}=${v}`).join(' ')}`)
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

// Next spec number within a directory: specs[/category]/ holds NNN-slug/ dirs.
async function nextSpecNumber (repo, base, token, catDir) {
  const dir = `${SPECS_DIR}${catDir ? '/' + catDir : ''}`
  const entries = await ghOrNull(`${repo}/contents/${dir}?ref=${encodeURIComponent(base)}`, token) || []
  let max = 0
  for (const entry of entries) {
    // At the root, sibling category dirs (no digit prefix) skip the regex anyway;
    // the type guard drops stray files like specs/README.md.
    if (entry.type !== 'dir') continue
    const m = /^(\d+)/.exec(entry.name)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return String(max + 1).padStart(3, '0')
}

// Type/scope for the commit + PR title; a specs-only repo can drop the default.
function commitPrefix (roles) {
  const raw = roles && roles['commit-prefix'] != null ? String(roles['commit-prefix']).trim() : 'spec'
  const type = raw.replace(/:+$/, '')
  return type ? `${type}: ` : ''
}

// Stamp a "Superseded by #M" banner into the spec this one replaces, on the
// replacement's own branch so it rides in the same PR. Same-repo, best-effort:
// the old spec.md must be reachable on the base branch (the old spec merged). A
// cross-repo or not-yet-merged target is left to the webhook + board hide.
// ponytail: extend to the old PR's branch or a cross-repo stamp PR if replacing
// unmerged or cross-namespace specs becomes common.
async function stampSuperseded (repo, branch, baseSha, token, oldN, byNum, byNs) {
  const pad = String(oldN).padStart(3, '0')
  const tree = await ghOrNull(`${repo}/git/trees/${baseSha}?recursive=1`, token)
  const re = new RegExp(`^${SPECS_DIR}/(?:[^/]+/)?${pad}-[^/]+/spec\\.md$`)
  const hit = tree && tree.tree.find(e => e.type === 'blob' && re.test(e.path))
  if (!hit) { console.warn(`supersede: ${byNs}#${oldN} spec.md not on base, stamp skipped`); return }
  const cur = await ghOrNull(`${repo}/contents/${hit.path}?ref=${encodeURIComponent(branch)}`, token)
  if (!cur) return
  const banner = `> **Superseded by ${byNs}#${byNum}.**\n\n`
  const old = Buffer.from(cur.content, 'base64').toString()
  if (old.startsWith(banner)) return
  await gh('PUT', `${repo}/contents/${hit.path}`, {
    message: `mark ${pad} superseded by #${byNum}`,
    content: Buffer.from(banner + old).toString('base64'),
    branch,
    sha: cur.sha
  }, token)
}

// The spec PR number doubles as the spec number: implementation commits
// reference it as "implements #N". Opened with the spec author's own GitHub
// token when available so the PR is genuinely theirs. category pins the subdir
// so a later tag change never re-paths an existing PR.
async function openSpecPr (spec, category) {
  const catDir = category ? `${category}/` : ''
  const pfx = commitPrefix(spec.roles)
  const attempt = async (token, asService) => {
    const repo = `/repos/${spec.namespace}`
    const { default_branch: base } = await gh('GET', repo, null, token)
    const { object: { sha } } = await gh('GET', `${repo}/git/ref/heads/${base}`, null, token)
    // ponytail: number is derived from the base branch, so two specs approved
    // before the first PR merges both get the same N. Allocate from open PRs
    // too if collisions matter.
    const num = await nextSpecNumber(repo, base, token, catDir)
    const branch = `${catDir}${num}-${slug(spec.title)}`
    try {
      await gh('POST', `${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha }, token)
    } catch (e) {
      // 422 = branch left over from a failed or closed earlier attempt; reuse it.
      if (e.status !== 422) throw e
    }
    const body = stripFrontmatter(resolveCritic(spec.content))
    const specPath = `${SPECS_DIR}/${catDir}${num}-${slug(spec.title)}/spec.md`
    // Updating an existing file needs its blob sha; a leftover branch already
    // holds spec.md, so look it up instead of failing the create-only PUT.
    const cur = await ghOrNull(`${repo}/contents/${specPath}?ref=${encodeURIComponent(branch)}`, token)
    // Gerrit-style trailers on the spec commit: a stable spec id, a link back
    // to the reviewable note, and a Reviewed-by per approver who signed off.
    // Only roles.yml approvers count; the note-editable approved-by alone is
    // never trusted as a review record.
    const reviewers = (spec.approvers || []).filter(a =>
      (spec.approvedBy || []).some(b => b.toLowerCase() === a.toLowerCase()))
    const trailers = [
      `Spec-Id: ${spec.id}`,
      `Reviewed-on: ${spec.url}`,
      ...reviewers.map(r => `Reviewed-by: @${r}`),
      ...(spec.supersedes ? [`Supersedes: ${spec.supersedes.noteId || `${spec.supersedes.ns}#${spec.supersedes.n}`}`] : [])
    ].join('\n')
    await gh('PUT', `${repo}/contents/${specPath}`, {
      message: `${pfx}add ${num} ${spec.title}\n\n${trailers}`,
      content: Buffer.from(body).toString('base64'),
      branch,
      ...(cur ? { sha: cur.sha } : {})
    }, token)
    // Idempotency: a crash after the PR was created but before its number was
    // recorded leaves a live PR on this branch. Reuse it instead of creating a
    // second one (GitHub 422s the duplicate, and the board would retry forever).
    const owner = spec.namespace.slice(0, spec.namespace.indexOf('/'))
    const existing = await gh('GET', `${repo}/pulls?state=all&head=${owner}:${encodeURIComponent(branch)}&per_page=1`, null, token)
    if (existing.length) return existing[0].number
    const abstract = specAbstract(body)
    const pr = await gh('POST', `${repo}/pulls`, {
      title: `${pfx}${spec.title}`,
      head: branch,
      base,
      body: (abstract ? abstract + '\n\n' : '') + `Spec note: ${spec.url}` +
        (asService ? '\n\nOpened with the service token; the spec author had no usable GitHub token.' : '')
    }, token)
    if (spec.supersedes && spec.supersedes.ns === spec.namespace) {
      await stampSuperseded(repo, branch, sha, token, spec.supersedes.n, pr.number, spec.supersedes.ns)
        .catch(e => console.warn('supersede stamp:', e.message))
    }
    return pr.number
  }
  if (spec.ownerToken) {
    try {
      return await attempt(spec.ownerToken)
    } catch (e) {
      if (e.status !== 401 && e.status !== 403) throw e
      console.error(`spec pr: author token rejected for ${spec.id}, using service token`)
    }
  }
  return attempt(await serviceTokenFor(spec.namespace), true)
}

// "implements" refs in a commit message. Bare "#12" refers to the scanned
// repo; the feature usually lands elsewhere, so cross-repo commits use
// GitHub's full reference syntax: "implements owner/spec-repo#12".
function implementsRefs (message, scannedRepo) {
  const refs = []
  for (const m of message.matchAll(/\bimplements ((?:[\w.-]+\/[\w.-]+)?#(\d+))/gi)) {
    const ns = m[1].includes('/') ? m[1].slice(0, m[1].indexOf('#')) : scannedRepo
    refs.push({ ns, n: Number(m[2]) })
  }
  return refs
}

// A spec's "supersedes" frontmatter link to the spec it replaces. Bare "#12"
// targets the note's own namespace; "owner/repo#12" crosses namespaces. Single
// value; chains form across notes. Mirrors implementsRefs, but note-authored.
function supersedesRef (meta, defaultNs) {
  const v = String(meta.supersedes ?? '').trim()
  if (!v) return null
  // Same namespace: a bare number "5" (YAML-safe, no leading # that YAML would
  // read as a comment) or "#5". Cross namespace: "owner/repo#5".
  const m = /^(?:([\w.-]+\/[\w.-]+)#)?#?(\d+)$/.exec(v)
  if (m) return { ns: m[1] || defaultNs, n: Number(m[2]) }
  // A note shortid targets a spec that has no PR number to reference (e.g. one
  // marked implemented by hand); resolved directly against the state map.
  if (/^[A-Za-z0-9_-]+$/.test(v)) return { noteId: v }
  return null
}

async function scanImplements (state) {
  const open = new Map()
  const openNamespaces = new Set()
  for (const [id, s] of state) {
    if (s.pr_number && !s.implemented_at && s.namespace) {
      open.set(`${s.namespace}#${s.pr_number}`, id)
      openNamespaces.add(s.namespace)
    }
  }
  if (!open.size) return
  // Implemented = the feature landed, which happens in the repos the
  // namespace declares as implementation-repos (default: the spec repo).
  const nsList = [...openNamespaces]
  const nsRoles = await Promise.all(nsList.map(ns => namespaceRoles(ns)))
  const scanRepos = new Set()
  nsList.forEach((ns, i) => {
    const declared = nsRoles[i] ? normList(nsRoles[i]['implementation-repos']) : []
    for (const repo of declared.length ? declared : [ns]) scanRepos.add(repo)
  })
  for (const repo of scanRepos) {
    const cursorKey = `last_commit_scan:${repo}`
    const { rows } = await pool.query('SELECT value FROM spec_board_meta WHERE key = $1', [cursorKey])
    const since = rows[0] && rows[0].value
    let commits, truncated
    try {
      ({ items: commits, truncated } = await ghPaged(`/repos/${repo}/commits?per_page=100${since ? `&since=${encodeURIComponent(since)}` : ''}`))
    } catch (e) {
      console.error('scan:', e.message)
      continue
    }
    for (const c of commits) {
      for (const ref of implementsRefs(c.commit.message, repo)) {
        const id = open.get(`${ref.ns}#${ref.n}`)
        if (!id) continue
        const s = state.get(id)
        s.implemented_at = new Date().toISOString()
        await upsertState({ id, status: s.status, comments: s.comment_count, prNumber: s.pr_number, implementedAt: s.implemented_at, approvals: s.approvals, namespace: s.namespace, category: s.category, prState: s.pr_state, lockedAt: s.locked_at, supersededAt: s.superseded_at })
        const implLine = `Spec ${ref.ns}#${s.pr_number} implemented by ${repo}@${c.sha.slice(0, 10)} ("${c.commit.message.split('\n')[0]}")`
        await notify(implLine)
        await enqueueEmails({ id, title: `${ref.ns}#${s.pr_number}`, namespace: s.namespace }, [implLine])
        open.delete(`${ref.ns}#${ref.n}`)
      }
    }
    // Truncation means older commits past the page cap went unscanned; those
    // are exactly the ones closest to the cursor. Advancing past them would
    // skip their implements-refs forever, so hold the cursor and retry (the
    // scan stays correct once volume drops) and tell the operator.
    if (truncated) {
      console.error(`scan: ${repo} exceeded the page cap; cursor held, implements-refs may lag`)
      await notify(`Commit scan for ${repo} hit the page cap; implemented detection is behind until it catches up`)
      continue
    }
    // Advance the cursor to the newest committer date actually seen, not
    // now(): GitHub's `since` filters on committer date, so wall-clock
    // cursors permanently skip delayed pushes and ff-merged old commits.
    // `since` is inclusive, so re-reading the newest commit is expected.
    if (commits.length) {
      await pool.query(
        `INSERT INTO spec_board_meta (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $2`,
        [cursorKey, commits[0].commit.committer.date])
    }
  }
}

let polling = false
let lastPollOk = 0
async function poll () {
  if (polling) return
  polling = true
  try {
    // GC state for notes that are gone, but only rows carrying no
    // irreplaceable record: pr_number and implemented_at are the only proof a
    // PR was opened or a spec landed, and a note-destroy racing this DELETE
    // must not erase them. Seed rows (no PR yet) are safe to drop.
    await pool.query(`DELETE FROM spec_board_state s
      WHERE s.pr_number IS NULL AND s.implemented_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM "Notes" n WHERE n.shortid = s.note_id)`)
    const specs = await rolesForSpecs(specsFromRows(await queryNotes()))
    const state = await loadState()
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
      const status = COLUMNS[spec.statusIdx].tag
      const prev = state.get(spec.id)
      if (!prev) {
        // First sighting: seed silently so a fresh deploy doesn't spam
        // notifications or open PRs for the existing backlog.
        await upsertState({ id: spec.id, status, comments: spec.comments, approvals: spec.approvals, namespace: spec.namespace })
        continue
      }
      // Collected and sent only after the state write lands: notifying first
      // re-fires the same webhook every poll for as long as the write fails.
      const msgs = []
      if (prev.status !== status) {
        msgs.push(`Spec "${spec.title}" moved ${prev.status} -> ${status}: ${spec.url}`)
      } else if (spec.comments > prev.comment_count && REVIEW_STATUSES.has(status)) {
        msgs.push(`New comments on "${spec.title}" (${prev.comment_count} -> ${spec.comments}): ${spec.url}`)
      }
      if (spec.approvers.length && spec.approvals > (prev.approvals || 0)) {
        msgs.push(`Approval on "${spec.title}" (${spec.approvals}/${spec.required}): ${spec.url}`)
      }
      // Resolve the spec's PR: keep the recorded one (refreshing its open/
      // merged/closed state), or re-link by matching the head branch slug.
      const idx = prIdx.get(spec.namespace)
      if (prev.pr_number && idx) {
        prev.pr_state = idx.byNumber.get(prev.pr_number) || prev.pr_state || 'open'
      } else if (!prev.pr_number && idx) {
        const hit = idx.bySlug.get(slug(spec.title))
        if (hit) { prev.pr_number = hit.number; prev.pr_state = hit.state }
      }
      if (status === 'approved' && !canApprove(spec) && !prev.pr_number) {
        console.warn(`withholding PR for "${spec.title}": ${spec.approvals}/${spec.required} approved, ${spec.comments} unresolved comments`)
      }
      // Approval freezes the note: flip HedgeDoc's own 'locked' permission
      // (anyone reads, only the owner edits). One-shot on the transition, so a
      // deliberate owner unlock later is respected, never re-forced. Writing
      // Notes.permission directly is safe: realtime's periodic save only
      // writes title/content/authorship, and permission changes land in the
      // DB immediately. Already-open editor sessions keep the old permission
      // until the note unloads.
      if (status === 'approved' && canApprove(spec) && !prev.locked_at) {
        try {
          if (spec.permission !== 'locked') {
            await pool.query('UPDATE "Notes" SET permission = $1 WHERE shortid = $2', ['locked', spec.id])
            msgs.push(`Locked "${spec.title}" after approval (owner can still edit): ${spec.url}`)
          }
          prev.locked_at = new Date().toISOString()
        } catch (e) {
          console.error('lock:', e.message)
        }
      }
      // Open a PR only when an approved, quorum-cleared spec has none at all
      // (not even a closed one to link); retry each poll so a transient GitHub
      // failure never strands it.
      if (status === 'approved' && canApprove(spec) && !prev.pr_number && spec.validNamespace && githubEnabled) {
        const cat = prev.category != null ? prev.category : spec.category
        try {
          prev.pr_number = await openSpecPr(spec, cat)
          prev.category = cat
          prev.pr_state = 'open'
          await upsertState({ id: spec.id, status, comments: spec.comments, prNumber: prev.pr_number, approvals: spec.approvals, namespace: spec.namespace, category: cat, prState: 'open', lockedAt: prev.locked_at, supersededAt: prev.superseded_at })
          const prLine = `Opened spec PR ${spec.namespace}#${prev.pr_number} for "${spec.title}": https://github.com/${spec.namespace}/pull/${prev.pr_number}`
          await notify(prLine)
          await enqueueEmails(spec, [prLine])
        } catch (e) {
          console.error(`spec pr [${spec.id} "${spec.title}"]:`, e.message)
        }
      }
      await upsertState({ id: spec.id, status, comments: spec.comments, prNumber: prev.pr_number, implementedAt: prev.implemented_at, approvals: spec.approvals, namespace: spec.namespace, category: prev.category, prState: prev.pr_state, lockedAt: prev.locked_at, supersededAt: prev.superseded_at })
      for (const m of msgs) await notify(m)
      await enqueueEmails(spec, msgs)
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
          os.superseded_at = new Date().toISOString()
          await upsertState({ id: oldId, status: os.status, comments: os.comment_count, prNumber: os.pr_number, implementedAt: os.implemented_at, approvals: os.approvals, namespace: os.namespace, category: os.category, prState: os.pr_state, lockedAt: os.locked_at, supersededAt: os.superseded_at })
          const oldRef = os.pr_number ? `${os.namespace}#${os.pr_number}` : oldId
          const supLine = `Spec ${oldRef} superseded by ${spec.namespace}#${prev.pr_number} ("${spec.title}"): ${spec.url}`
          await notify(supLine)
          await enqueueEmails({ id: oldId, title: oldRef, namespace: os.namespace }, [supLine])
        }
      }
    }
    // state is current: every pr_number/implemented_at change above was
    // written to the same in-memory objects scanImplements reads.
    if (githubEnabled) await scanImplements(state)
    await flushEmails()
    lastPollOk = Date.now()
  } catch (e) {
    console.error('poll:', e.message)
  } finally {
    polling = false
  }
}

// Read-only roles view for the editor's Approve button; never exposes tokens.
const BASE_ORIGIN = new URL(BASE_URL).origin
async function serveRoles (res, ns) {
  if (!NAMESPACES.includes(ns)) {
    res.writeHead(404, { 'Access-Control-Allow-Origin': BASE_ORIGIN }).end('unknown namespace')
    return
  }
  const roles = await namespaceRoles(ns)
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': BASE_ORIGIN,
    'Cache-Control': 'public, max-age=60'
  })
  res.end(JSON.stringify(roles || {}))
}

const STATIC = {
  '/fonts/SourceSansPro-Regular.woff2': ['font/woff2', fs.readFileSync(path.join(__dirname, 'fonts/SourceSansPro-Regular.woff2'))],
  '/fonts/SourceSansPro-Semibold.woff2': ['font/woff2', fs.readFileSync(path.join(__dirname, 'fonts/SourceSansPro-Semibold.woff2'))],
  '/favicon-32x32.png': ['image/png', fs.readFileSync(path.join(__dirname, 'favicon-32x32.png'))],
  '/favicon-16x16.png': ['image/png', fs.readFileSync(path.join(__dirname, 'favicon-16x16.png'))],
  '/apple-touch-icon.png': ['image/png', fs.readFileSync(path.join(__dirname, 'apple-touch-icon.png'))],
  '/favicon.ico': ['image/x-icon', fs.readFileSync(path.join(__dirname, 'favicon.ico'))]
}

function hmac (data) { return crypto.createHmac('sha256', SESSION_SECRET).update(data).digest('base64url') }

function signToken (payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${hmac(body)}`
}

function verifyToken (token) {
  if (!token || typeof token !== 'string') return null
  const dot = token.lastIndexOf('.')
  if (dot < 1) return null
  const body = token.slice(0, dot)
  const a = Buffer.from(token.slice(dot + 1))
  const b = Buffer.from(hmac(body))
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

function startLogin (req, res) {
  const state = crypto.randomBytes(16).toString('hex')
  setCookie(res, 'sb_oauth', signToken({ st: state, exp: Date.now() + 600000 }), 600)
  const p = new URLSearchParams({
    client_id: OAUTH_CLIENT_ID,
    redirect_uri: `${originOf(req)}/auth/github/callback`,
    scope: 'read:user',
    state
  })
  redirect(res, `https://github.com/login/oauth/authorize?${p}`)
}

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
  const { rows } = await pool.query('SELECT id FROM "Users" WHERE profileid = $1', [String(gh.id)])
  setCookie(res, 'sb_oauth', '', 0)
  setCookie(res, 'sb_session', signToken({ uid: rows[0] ? rows[0].id : null, login: gh.login, exp: Date.now() + SESSION_TTL_MS }), Math.floor(SESSION_TTL_MS / 1000))
  redirect(res, '/settings')
}

async function emailForUid (uid) {
  const { rows } = await pool.query('SELECT email, profile FROM "Users" WHERE id = $1', [uid])
  return (rows[0] && userEmail(rows[0])) || ''
}

async function settingsGet (req, res) {
  const s = session(req)
  if (!s) { startLogin(req, res); return }
  let subs = new Map()
  let optedOut = false
  if (s.uid) {
    const [subRes, addr] = await Promise.all([
      pool.query('SELECT namespace, level FROM spec_board_subscriptions WHERE user_id = $1', [s.uid]),
      emailForUid(s.uid)
    ])
    subs = new Map(subRes.rows.map(r => [r.namespace, r.level]))
    if (addr) {
      const { rows } = await pool.query('SELECT 1 FROM spec_board_optout WHERE email_hash = $1', [emailKey(addr)])
      optedOut = rows.length > 0
    }
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff' })
  res.end(settingsPage(s, subs, optedOut))
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
    const addr = await emailForUid(s.uid)
    if (addr) await pool.query('DELETE FROM spec_board_optout WHERE email_hash = $1', [emailKey(addr)])
    redirect(res, '/settings')
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
  redirect(res, '/settings')
}

function settingsPage (s, subs, optedOut) {
  const rows = NAMESPACES.map(ns => {
    const cur = subs.get(ns) || 'participating'
    const opt = (v, label) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`
    return `<tr><td class="ns">${esc(ns)}</td><td><select name="lvl:${esc(ns)}">${opt('watch', 'Watch (all specs)')}${opt('participating', 'Participating (default)')}${opt('disabled', 'Disabled')}</select></td></tr>`
  }).join('')
  const optoutBanner = optedOut
    ? `<form method="post" action="/settings" class="warn">
      <input type="hidden" name="csrf" value="${esc(csrfToken(s.uid))}">
      <input type="hidden" name="action" value="reenable">
      Email is turned off for your account. <button type="submit">Re-enable email</button>
    </form>`
    : ''
  const form = s.uid
    ? `<form method="post" action="/settings">
      <input type="hidden" name="csrf" value="${esc(csrfToken(s.uid))}">
      <table>${rows}</table>
      <p class="legend"><b>Watch</b>: email for every spec in the namespace. <b>Participating</b>: only specs you own or edited. <b>Disabled</b>: mute the namespace.</p>
      <button type="submit">Save</button>
    </form>`
    : `<p class="warn">No SpecDoc account is linked to <b>@${esc(s.login)}</b>. Open a note in SpecDoc once, then come back.</p>`
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<title>Notification settings</title>
<style>
  @font-face { font-family: "Source Sans Pro"; font-weight: 400; src: url(/fonts/SourceSansPro-Regular.woff2) format("woff2"); }
  @font-face { font-family: "Source Sans Pro"; font-weight: 600; src: url(/fonts/SourceSansPro-Semibold.woff2) format("woff2"); }
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 "Source Sans Pro", Helvetica, Arial, sans-serif; margin: 0; padding: 24px; max-width: 640px; background: light-dark(#fff, #333); }
  header { display: flex; align-items: baseline; gap: 12px; margin-bottom: 8px; }
  h1 { font-size: 18px; margin: 0; }
  .who { margin-left: auto; font-size: 13px; }
  a { color: inherit; }
  table { border-collapse: collapse; width: 100%; margin: 12px 0; }
  td { padding: 6px 8px; border-bottom: 1px solid #8883; }
  td.ns { font-weight: 600; }
  select { padding: 4px 8px; border: 1px solid #8885; border-radius: 4px; background: light-dark(#fff, #333); color: inherit; font: inherit; }
  button { padding: 6px 14px; border: 1px solid #caa437; border-radius: 4px; background: #efcb5f; color: #1c1917; font-weight: 600; cursor: pointer; }
  .legend { color: #8889; font-size: 13px; }
  .warn { padding: 12px; border: 1px solid #caa437; border-radius: 6px; background: #efcb5f22; }
</style></head><body>
<header><h1>Notification settings</h1><span class="who">@${esc(s.login)} · <a href="/logout">sign out</a> · <a href="/privacy">privacy</a> · <a href="/">board</a></span></header>
${optoutBanner}
${form}
</body></html>`
}

function basicPage (title, bodyHtml) {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<title>${esc(title)}</title>
<style>
  @font-face { font-family: "Source Sans Pro"; font-weight: 400; src: url(/fonts/SourceSansPro-Regular.woff2) format("woff2"); }
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 "Source Sans Pro", Helvetica, Arial, sans-serif; margin: 0; padding: 24px; max-width: 560px; background: light-dark(#fff, #333); }
  h1 { font-size: 18px; } h2 { font-size: 15px; margin: 16px 0 4px; }
  a { color: inherit; }
  button { padding: 6px 14px; border: 1px solid #caa437; border-radius: 4px; background: #efcb5f; color: #1c1917; font-weight: 600; cursor: pointer; }
</style></head><body>${bodyHtml}</body></html>`
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
  return basicPage('Privacy', `<h1>${esc(EMAIL_ORG_NAME)} notification privacy</h1>
  <p>This board emails digests of spec activity. What it stores and why:</p>
  <h2>What is stored</h2>
  <ul>
    <li><b>Recipient email addresses</b>, queued only while a digest is batched, taken from your SpecDoc account or GitHub profile.</li>
    <li><b>Per-namespace subscription levels</b> (watch, participating, disabled), tied to your GitHub-linked account, when you set them.</li>
    <li><b>A one-way hash</b> of any address that unsubscribed, so the opt-out is honored without keeping a readable list of who you are.</li>
  </ul>
  <h2>Retention</h2>
  <ul>
    <li>Queued digest rows are deleted as soon as the email is sent.</li>
    <li>Opt-out entries are kept so the unsubscribe keeps being honored.</li>
    <li>Subscription levels persist until you change them.</li>
  </ul>
  <h2>Lawful basis</h2>
  <p>Legitimate interest: notifying collaborators about specs they own, edited, or chose to watch. Every email carries a one-click unsubscribe.</p>
  <h2>Opt out and erasure</h2>
  <p>Use the unsubscribe link in any digest to stop all email.${SETTINGS_ENABLED ? ' Set every namespace back to Participating on the <a href="/settings">settings page</a> to clear your preferences.' : ''} For anything else, contact <b>${esc(PRIVACY_CONTACT)}</b>.</p>
  ${SETTINGS_ENABLED ? '<p>A recipient with no linked SpecDoc account can unsubscribe from any email, but must sign in once to re-enable it.</p>' : ''}
  <p><a href="/">Back to the board</a></p>`)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/healthz') {
      // Probe target: process-alive only, no DB roundtrip, so a DB outage
      // degrades to error pages instead of a probe-driven restart loop.
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, lastPollOk }))
      return
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [type, body] = STATIC[url.pathname]
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' })
      res.end(body)
      return
    }
    const rolesMatch = /^\/api\/roles\/([\w.-]+\/[\w.-]+)$/.exec(url.pathname)
    if (req.method === 'GET' && rolesMatch) {
      await serveRoles(res, rolesMatch[1])
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/namespaces') {
      const poller = { lastPollOk, stale: !lastPollOk || Date.now() - lastPollOk > POLL_SECONDS * 3000 }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ namespaces: preflightCache, poller }))
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
    if (url.pathname === '/settings' || url.pathname.startsWith('/auth/github') || url.pathname === '/logout') {
      if (!SETTINGS_ENABLED) { res.writeHead(503).end('notification settings not configured'); return }
      if (url.pathname === '/auth/github' && req.method === 'GET') { startLogin(req, res); return }
      if (url.pathname === '/auth/github/callback' && req.method === 'GET') { await finishLogin(req, res, url); return }
      if (url.pathname === '/settings' && req.method === 'GET') { await settingsGet(req, res); return }
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
    // cacheOnly: never block a page render on a live GitHub roles fetch.
    let specs = await rolesForSpecs(specsFromRows(await queryNotes(q)), true)
    if (ns) specs = specs.filter(s => s.namespace === ns)
    const state = await loadState()
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(render(buildBoard(specs, state), q, ns))
  } catch (e) {
    console.error(e)
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('server error')
  }
})

if (require.main === module) {
  ensureState().then(() => {
    server.listen(PORT, () => console.log(`spec-board on :${PORT}`))
    runPreflight()
    setInterval(runPreflight, ROLES_TTL_MS)
    setInterval(poll, POLL_SECONDS * 1000)
    poll()
  }).catch(e => {
    console.error('startup:', e)
    process.exit(1)
  })
} else {
  module.exports = { frontmatter, metaTags, resolveCritic, countCommentThreads, specsFromRows, applyRoles, quorumMet, canApprove, commitPrefix, buildBoard, slug, stripFrontmatter, specAbstract, implementsRefs, supersedesRef, openSpecPr, renderDigest, emailFooter, profileEmail, resolveRecipients, signToken, verifyToken }
}
