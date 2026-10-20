'use strict'

const yaml = require('js-yaml')
const { frontmatterRange } = require('./critic-source')

function repairFrontmatterReview (content, authorship) {
  const bom = content.startsWith('\uFEFF') ? 1 : 0
  const prefix = /^(?:\{>>(?:(?!\{>>)[\s\S])*?<<\}[ \t\r\n]*)+/.exec(content.slice(bom))
  if (!prefix) return null
  const start = bom + prefix[0].length
  const rest = content.slice(start)
  const header = frontmatterRange(rest)
  if (!header) return null
  const closing = /(?:\r\n|\r|\n)(?:---|\.\.\.)[^\S\r\n]*(?:(?:\r\n|\r|\n)|$)/.exec(rest)
  let meta
  try { meta = yaml.load(rest.slice(3, closing.index)) } catch { return null }
  const tags = meta && (Array.isArray(meta.tags) ? meta.tags : String(meta.tags || '').split(','))
  if (!tags || !tags.some(tag => String(tag).trim().toLowerCase() === 'spec')) return null

  if (authorship != null && (!Array.isArray(authorship) || authorship.some(atom =>
    !Array.isArray(atom) || !Number.isInteger(atom[1]) || !Number.isInteger(atom[2]) ||
    atom[1] < 0 || atom[2] < atom[1] || atom[2] > content.length))) return null

  const end = start + header[1]
  const headerText = content.slice(start, end)
  const newline = headerText.includes('\r\n') ? '\r\n' : headerText.includes('\r') ? '\r' : '\n'
  const separator = /[\r\n]$/.test(headerText) ? newline : newline + newline
  const afterComment = /[\r\n]$/.test(prefix[0]) ? newline : newline + newline
  const commentStart = bom + headerText.length + separator.length
  const bodyStart = commentStart + prefix[0].length + afterComment.length
  const pieces = [[0, bom, 0], [start, end, bom], [bom, start, commentStart], [end, content.length, bodyStart]]
  const moved = authorship == null
    ? authorship
    : authorship.flatMap(atom => pieces.flatMap(([from, to, target]) => {
      const first = Math.max(from, atom[1])
      const last = Math.min(to, atom[2])
      if (first >= last) return []
      const copy = atom.slice()
      copy[1] = target + first - from
      copy[2] = target + last - from
      return [copy]
    })).sort((a, b) => a[1] - b[1] || a[2] - b[2])

  return {
    content: content.slice(0, bom) + headerText + separator + prefix[0] + afterComment + content.slice(end),
    authorship: moved,
    meta,
    start,
    end: start + closing.index + (closing[0].startsWith('\r\n') ? 1 : 0),
    bodyStart: end
  }
}

module.exports = { repairFrontmatterReview }
