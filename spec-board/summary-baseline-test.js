const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { Pool } = require('pg')
const { digest, publicationDocument } = require('./publication-candidate')

async function main () {
  process.env.GITHUB_TOKEN = 'summary-baseline-fixture'
  process.env.GITHUB_APP_ID = ''
  process.env.GITHUB_APP_PRIVATE_KEY = ''
  const { summaryBaseline } = require('./server')
  const priorFetch = global.fetch, priorQuery = Pool.prototype.query
  const body = '# Requirements\n\nKeep the checkpoint.\n'
  const intent = { id: crypto.randomUUID(), note_id: 'note', namespace: 'team/specs', candidate_hash: 'a'.repeat(64),
    path: 'specs/001-checkpoint.md', pr_number: 1, base_branch: 'main', relations: { supersedes: null, dependsOn: [] } }
  intent.document = publicationDocument(body, { format: 1, submission: intent.id, noteId: 'note', namespace: intent.namespace,
    candidate: intent.candidate_hash, bodyHash: digest(body), relations: intent.relations })
  intent.document_hash = digest(intent.document)
  const commit = 'b'.repeat(40)
  let intents = [intent], remoteBody = intent.document, revisionMerged = false
  const source = { id: 'note', namespace: intent.namespace, publication: { number: 1, state: 'merged',
    commit, path: intent.path, hash: intent.document_hash, receipt: { submission: intent.id, number: 1 } } }
  Pool.prototype.query = async function (sql, values) {
    if (sql.includes('UNION ALL SELECT')) return { rows: [] }
    assert.match(sql, /SELECT \* FROM spec_board_publication_intents/)
    const rows = values.length === 1 ? intents.filter(row => row.id === values[0])
      : intents.filter(row => row.note_id === values[0] && row.namespace === values[1] && row.pr_number === values[2])
    return { rows: structuredClone(rows) }
  }
  global.fetch = async (url, options) => {
    assert.equal(options.method, 'GET')
    const u = new URL(url)
    let value
    if (/\/pulls\/[12]$/.test(u.pathname)) {
      const number = Number(u.pathname.split('/').at(-1))
      value = { number, merged_at: number === 1 || revisionMerged ? '2026-01-01' : null,
        merge_commit_sha: commit, base: { ref: 'main', repo: { full_name: intent.namespace } } }
    } else {
      assert.equal(u.pathname, '/repos/team/specs/contents/' + intent.path)
      assert.equal(u.searchParams.get('ref'), commit)
      value = { encoding: 'base64', size: Buffer.byteLength(remoteBody), content: Buffer.from(remoteBody).toString('base64') }
    }
    return new Response(JSON.stringify(value), { status: 200 })
  }
  try {
    let result = await summaryBaseline(source)
    assert.equal(result.body, body, 'verified provenance metadata is excluded from the prose comparison')
    assert.equal(result.hash, digest(body))
    assert.equal(result.documentHash, intent.document_hash, 'comparison identity retains the exact published file hash')
    source.publication.revisionPr = 2
    source.publication.revision = 1
    source.publication.hash = digest('proposed revision')
    result = await summaryBaseline(source)
    assert.equal(result.body, body, 'a pending proposal hash cannot replace the verified merged baseline')
    revisionMerged = true
    remoteBody = publicationDocument('Unapproved change', { format: 1, submission: intent.id, noteId: 'note', namespace: intent.namespace,
      candidate: intent.candidate_hash, bodyHash: digest('Unapproved change'), relations: intent.relations })
    await assert.rejects(summaryBaseline(source), /authorization/)
    remoteBody = body
    intents = [{ ...intent, pr_number: 2 }]
    await assert.rejects(summaryBaseline(source), /authorization/, 'removing the marker cannot turn a current publication into a legacy one')
    intents = [{ ...intent, pr_number: 2, redacted_at: new Date() }]
    remoteBody = intent.document
    await assert.rejects(summaryBaseline(source), /authorization/)
    revisionMerged = false
    intents = []
    remoteBody = body
    delete source.publication.receipt
    assert.equal((await summaryBaseline(source)).body, body, 'legacy merged commits remain usable while a revision is pending')
    delete source.publication.revisionPr
    await assert.rejects(summaryBaseline(source), /recorded publication text changed/, 'an unexplained stored hash mismatch fails closed')
    console.log('Summary baselines preserve merged authorization and compare only requirement text')
  } finally {
    global.fetch = priorFetch
    Pool.prototype.query = priorQuery
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
