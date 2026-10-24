'use strict'

const { specRef } = require('./refs')

const MAX_RELATIONS = 512
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const blank = value => value == null || (typeof value === 'string' && !value.trim())

function parseSpecRelations (meta, namespace, selfId, options = {}) {
  meta = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {}
  const result = { supersedes: null, dependsOn: [], issues: [] }
  const line = new Map()
  const commented = new Set()
  if (typeof options.content === 'string' && Number.isInteger(options.start) && Number.isInteger(options.end) && options.end > options.start) {
    const before = options.content.slice(0, options.start).split(/\r\n|\r|\n/).length
    const lines = options.content.slice(options.start, options.end).split(/\r\n|\r|\n/)
    let indent = Infinity
    for (const value of lines.slice(1)) if (/^\s*[^\s#]/.test(value)) indent = Math.min(indent, /^[ \t]*/.exec(value)[0].length)
    for (let index = 1; index < lines.length; index++) {
      const match = /^([ \t]*)(?:["']?(depends-on|supersedes)["']?)[ \t]*:[ \t]*(.*)$/.exec(lines[index])
      if (!match || match[1].length !== indent) continue
      if (!line.has(match[2])) line.set(match[2], before + index)
      if (own(meta, match[2]) && blank(meta[match[2]]) && /^#\d+(?:\s|$)/.test(match[3])) commented.add(match[2])
    }
  }
  const issue = (code, field, message, index) => result.issues.push({ code, severity: 'error', field,
    ...(index === undefined ? {} : { index }), ...(line.has(field) ? { line: line.get(field) } : {}), message })
  for (const field of commented) issue('REFERENCE_COMMENTED_OUT', field, `${field} is a YAML comment, not a reference; use a number or quote the # reference`)
  const parse = (value, field, index) => {
    if (!['string', 'number'].includes(typeof value) || (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1))) {
      issue('INVALID_REFERENCE', field, `${field} needs a note ID or positive safe publication number`, index)
      return null
    }
    const text = String(value).trim()
    if (/^-\d+$/.test(text)) {
      issue('INVALID_REFERENCE', field, `${field} needs a positive publication number`, index)
      return null
    }
    const ref = text && text.length <= 1024 && !text.includes('##') ? specRef(text, namespace) : null
    if (!ref || (ref.n !== undefined && (!Number.isSafeInteger(ref.n) || ref.n < 1 || !/^[\w.-]+\/[\w.-]+$/.test(ref.ns || '')))) {
      issue('INVALID_REFERENCE', field, `${field} needs a note ID or positive safe publication reference`, index)
      return null
    }
    if ((ref.noteId && ref.noteId === selfId) ||
        (ref.ns === namespace && Number.isSafeInteger(options.selfNumber) && ref.n === options.selfNumber)) {
      issue('SELF_REFERENCE', field, `${field} must identify another specification`, index)
      return null
    }
    if (field === 'supersedes' && ref.ns && ref.ns !== namespace) {
      issue('CROSS_NAMESPACE_SUPERSESSION', field, 'supersedes must identify a specification in the same project', index)
      return null
    }
    return ref
  }
  if (!blank(meta.supersedes)) result.supersedes = parse(meta.supersedes, 'supersedes')
  const raw = meta['depends-on']
  if (!blank(raw)) {
    let entries
    if (Array.isArray(raw)) entries = raw
    else if (typeof raw === 'string') entries = raw.split(',')
    else if (typeof raw === 'number') entries = [raw]
    else {
      issue('INVALID_REFERENCE', 'depends-on', 'depends-on needs a list, comma-separated references or one publication number')
      entries = []
    }
    if (entries.length > MAX_RELATIONS) issue('TOO_MANY_RELATIONS', 'depends-on', `depends-on permits at most ${MAX_RELATIONS} references`)
    const seen = new Set()
    for (const [index, value] of entries.slice(0, MAX_RELATIONS).entries()) {
      const ref = parse(value, 'depends-on', index)
      if (!ref) continue
      const key = ref.noteId || `${ref.ns}#${ref.n}`
      if (seen.has(key)) {
        issue('DUPLICATE_REFERENCE', 'depends-on', `depends-on repeats ${key}`, index)
        continue
      }
      seen.add(key)
      result.dependsOn.push(ref)
    }
  }
  return result
}

module.exports = { parseSpecRelations }
