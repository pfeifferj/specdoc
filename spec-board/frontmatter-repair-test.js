const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { Pool } = require('pg')
process.env.NAMESPACES = 'netfyr/specs'
const file = path.join(__dirname, 'server.js')
const mod = new Module(file, module)
mod.filename = file
mod.paths = module.paths
mod._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.queryNotes = queryNotes\n', file)
const { frontmatter, specsFromRows, stripFrontmatter, publishedBody, countCommentThreads, countSuggestions, canApprove, injectComments, placeProposals, queryNotes } = mod.exports
const comment = '{>>@Rahul Rajesh: LGTM<<}'
const header = '---\ntitle: netfyr identity\ntags: [spec, in-review]\nkind: top-level\nowner: pfeifferj\nnamespace: netfyr/specs\n---\n'
const body = '# netfyr identity\n\nThe name is netfyr.\n'
const row = content => ({ shortid: 'identity', title: 'netfyr identity', content })

const broken = comment + header + body
const [spec] = specsFromRows([row(broken)])
assert.ok(spec, 'an existing misplaced review comment must not hide the spec')
assert.equal(spec.namespace, 'netfyr/specs')
assert.equal(spec.topLevel, true)
assert.equal(spec.statusIdx, 2)
assert.equal(spec.comments, 1)
assert.equal(spec.suggestions, 0)
assert.equal(spec.content, broken, 'read recovery preserves the raw content used for mutation hashes')
assert.equal(canApprove({ ...spec, required: 0, approvals: 0 }), false, 'the recovered thread still blocks publication')
assert.equal(publishedBody(spec), body)
assert.equal(stripFrontmatter(broken), comment + '\n' + body)
assert.deepEqual(frontmatter(broken).meta, frontmatter(header + body).meta)

const resolved = comment + '{>>%%resolved%%<<}' + header + body
assert.equal(countCommentThreads(resolved), 0)
assert.equal(publishedBody({ content: resolved }), body)
assert.equal(countSuggestions(comment + header + '{++new++}\n'), 1)
assert.equal(countCommentThreads(comment + header.replace('title: netfyr identity', 'title: "{>>a literal example<<}"') + body), 1)
assert.equal(countSuggestions(comment + header.replace('title: netfyr identity', 'title: "{++a literal example++}"') + body), 0)
assert.equal(publishedBody({ content: comment + header.trimEnd() }), '')
assert.equal(specsFromRows([row('\uFEFF' + header + body)]).length, 1)
for (const newline of ['\n', '\r\n']) {
  const source = (comment + header + body).replace(/\n/g, newline)
  const updated = injectComments(source, [{ quote: 'netfyr/specs', comment: 'Check this.' }], 'bot')
  assert.ok(updated.startsWith(source.trimEnd()), 'a header-only bot quote appends below the recovered header')
  assert.equal(frontmatter(updated).meta.namespace, 'netfyr/specs')
  const proposal = placeProposals(source, [{ id: 'p', quote: 'netfyr/specs', amendment: 'other/specs', rationale: 'Check this.' }], 'bot')
  assert.deepEqual(proposal.commented, ['p'])
  assert.equal(frontmatter(proposal.content).meta.namespace, 'netfyr/specs')
}
for (const content of [comment + 'ordinary note', comment + '---\ntags: [other]\n---\n', comment + '---\ntags: [spec\n---\n', 'Example:\n' + broken]) {
  assert.deepEqual(specsFromRows([row(content)]), [])
}

async function main () {
  const original = Pool.prototype.query
  let called = false
  Pool.prototype.query = async function (sql, args) {
    called = true
    assert.match(sql, /n\.content LIKE ANY\(\$2::text\[\]\)/)
    assert.match(sql, /n\.content ILIKE \$1/)
    assert.equal(args[0], '%spec%')
    assert.deepEqual(args[1], ['---%', '{>>%', '\uFEFF---%', '\uFEFF{>>%'])
    return { rows: [row(broken)] }
  }
  try {
    assert.equal(specsFromRows(await queryNotes()).length, 1)
    assert.equal(called, true, 'the production poller includes notes with leading comments')
  } finally { Pool.prototype.query = original }
  console.log('frontmatter recovery: board discovery, metadata, raw hashes, publication and review gates passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
