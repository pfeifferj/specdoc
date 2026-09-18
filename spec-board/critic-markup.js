'use strict'

const { renderedSpans, projectComments, literalRanges, lineStarts, lineAt } = require('./critic-source')

// Shared CriticMarkup scanner used by the markdown-it plugin, the editor
// styling pass and accept/reject resolution. Patterns are tempered-greedy:
// a repeated opener cannot swallow the following span.
const PATTERNS = [
  { type: 'ins', regex: /\{\+\+((?:(?!\{\+\+)[\s\S])*?)\+\+\}/g },
  { type: 'del', regex: /\{--((?:(?!\{--)[\s\S])*?)--\}/g },
  { type: 'sub', regex: /\{~~((?:(?!\{~~)[\s\S])*?)~~\}/g },
  { type: 'highlight', regex: /\{==((?:(?!\{==)[\s\S])*?)==\}/g },
  { type: 'comment', regex: /\{>>((?:(?!\{>>)[\s\S])*?)<<\}/g }
]

const SUGGESTION_TYPES = ['ins', 'del', 'sub']

// Sentinel appended to a thread to mark it resolved: {>>%%resolved%%<<}. A
// reply after the sentinel reopens the thread, so resolution keys on the last
// message, not merely the sentinel's presence.
const RESOLVED_MARK = '%%resolved%%'

function isResolveMark (m) {
  return !m.author && m.text === RESOLVED_MARK
}

function splitSub (content) {
  const sep = content.indexOf('~>')
  if (sep === -1) return { oldText: content, newText: content }
  return { oldText: content.slice(0, sep), newText: content.slice(sep + 2) }
}

/**
 * Author and text from one comment body, convention {>>@name: text<<}.
 */
function parseComment (content) {
  const trimmed = content.trim()
  const m = /^@([^:]{1,40}):\s*([\s\S]*)$/.exec(trimmed)
  return { author: m ? m[1].trim() : '', text: m ? m[2] : trimmed }
}

/**
 * Stable anchor hash for a comment thread, from its first message.
 * FNV-1a 32-bit over UTF-16 code units of
 * `norm(author) + ':' + norm(text)`, 8 lowercase hex chars.
 */
function commentAnchorHash (author, text) {
  const norm = s => String(s || '').trim().replace(/\s+/g, ' ')
  const input = norm(author) + ':' + norm(text)
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/**
 * Scan text for CriticMarkup spans rendered as prose. Directly
 * adjacent comments merge into one span with a `messages` array: that is
 * the threading model, a reply is just another comment appended to the run.
 * @param {string} text
 * @returns {Array<{type: string, from: number, to: number, raw: string, content: string, oldText?: string, newText?: string, messages?: Array<{author: string, text: string}>}>} sorted by position
 */
let lastSource = null
let lastSpans = null

function scanCritic (text) {
  if (text === lastSource) return lastSpans
  const found = []
  for (const { type, regex } of PATTERNS) {
    regex.lastIndex = 0
    let m
    while ((m = regex.exec(text)) !== null) {
      const span = { type, from: m.index, to: m.index + m[0].length, raw: m[0], content: m[1] }
      if (type === 'sub') Object.assign(span, splitSub(m[1]))
      found.push(span)
    }
  }
  found.sort((a, b) => a.from - b.from)
  const excluded = new Set()
  let rendered
  while (true) {
    const frontier = []
    const overlapping = new Set()
    for (const span of found) {
      if (excluded.has(span)) continue
      const prev = frontier[frontier.length - 1]
      if (prev && span.from < prev.to) {
        overlapping.add(prev)
      } else {
        frontier.push(span)
      }
    }
    rendered = renderedSpans(text, frontier)
    const active = new Set(rendered)
    const blocker = frontier.find(span => overlapping.has(span) && !active.has(span))
    if (!blocker) break
    excluded.add(blocker)
  }
  const merged = []
  for (const span of rendered) {
    const prev = merged[merged.length - 1]
    if (span.type === 'comment') {
      if (prev && prev.type === 'comment' && prev.to === span.from) {
        prev.to = span.to
        prev.raw += span.raw
        prev.messages.push(parseComment(span.content))
        continue
      }
      span.messages = [parseComment(span.content)]
    }
    merged.push(span)
  }
  const starts = lineStarts(text)
  const seenLines = Object.create(null)
  for (const span of merged) {
    if (span.type !== 'comment') continue
    const last = span.messages[span.messages.length - 1]
    span.resolved = !!last && isResolveMark(last)
    span.messages = span.messages.filter(m => !isResolveMark(m))
    span.line = lineAt(starts, span.from) + 1
    span.endLine = lineAt(starts, span.to - 1) + 1
    if (!span.resolved && span.messages.length) {
      const n = (seenLines[span.line] = (seenLines[span.line] || 0) + 1)
      span.alias = 'cl' + span.line + (n > 1 ? '-' + n : '')
    }
  }
  lastSource = text
  lastSpans = merged
  return merged
}

/**
 * Neutralize CriticMarkup delimiters in user text destined for a comment
 * body, so it cannot terminate the span early or open a nested one.
 */
function escapeCriticText (text) {
  return String(text).replace(/<<\}/g, '<< }').replace(/\{>>/g, '{ >>')
}

/**
 * Locate the comment thread a reply targets. Exact (raw, ordinal) identity
 * first. The clicked element can lag the buffer (pending re-render, stale
 * partial-update block); replies only ever append to a thread, so a stale
 * raw is a prefix of the current one. Accept a lagging identity only while
 * it stays unambiguous; otherwise return null and let the caller refuse.
 * @param {string} text
 * @param {string} raw
 * @param {number} ordinal index among threads with identical raw, source order
 * @returns {object|null} the matching scanCritic span
 */
function findCommentSpan (text, raw, ordinal) {
  if (!raw) return null
  const spans = scanCritic(text).filter(s => s.type === 'comment')
  const exact = spans.filter(s => s.raw === raw)
  if (exact[ordinal]) return exact[ordinal]
  if (exact.length === 1) return exact[0]
  const prefixed = spans.filter(s => s.raw.startsWith(raw))
  return prefixed.length === 1 ? prefixed[0] : null
}

/**
 * Replacement text for a span when a suggestion is accepted or rejected.
 * Comments resolve to '' either way; highlights keep their text.
 */
function resolvedText (span, accept) {
  switch (span.type) {
    case 'ins': return accept ? span.content : ''
    case 'del': return accept ? '' : span.content
    case 'sub': return accept ? span.newText : span.oldText
    case 'highlight': return span.content
    default: return ''
  }
}

/**
 * Resolve all CriticMarkup in text to its accepted form: keep insertions,
 * drop deletions, apply substitutions, unwrap highlights, strip comments.
 */
function resolveCritic (text) {
  const spans = scanCritic(text)
  let out = ''
  let pos = 0
  for (const span of spans) {
    if (span.from < pos) continue
    out += text.slice(pos, span.from) + resolvedText(span, true)
    pos = span.to
  }
  return out + text.slice(pos)
}

module.exports = { scanCritic, resolveCritic, resolvedText, parseComment, findCommentSpan, escapeCriticText, commentAnchorHash, projectComments, literalRanges, SUGGESTION_TYPES, RESOLVED_MARK }
