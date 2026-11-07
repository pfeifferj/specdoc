const assert = require('node:assert/strict')
const crypto = require('node:crypto')
process.env.NAMESPACES = 'team/specs,other/specs'
const { specsFromRows, applyRoles, countApprovals, canPublish, recordedApprovals, supersessionTarget, specGraph, automationSnapshot } = require('./server')
const { governance, authorized } = require('./security-identities')
const { digest, publicationDocument, publicationMetadata, receiptMatches } = require('./publication-candidate')

const roles = { approvers: [{ id: '42', login: 'reviewer' }], authors: [{ id: '10', login: 'writer' }], 'approvals-required': 1 }
const content = (fields = '', body = 'Reviewed requirement.') => `---\ntags: [spec, approved]\nnamespace: team/specs\n${fields}---\n${body}`
const row = (text = content(), extra = {}) => ({ id: crypto.randomUUID(), shortid: 'note', title: 'Requirement', content: text,
  permission: 'editable', owner_id: 'owner', owner_profileid: 'github:10',
  owner_profile: JSON.stringify({ provider: 'github', id: '10', username: 'writer' }), ...extra })
const spec = (text, extra, policy = roles) => applyRoles(specsFromRows([row(text, extra)])[0], policy)
const approve = s => {
  s.approvalReceipts = [{ label: 'reviewer', subject: '42', provider: 'github', candidate_hash: s.candidate.hash, policy_hash: s.candidate.policy }]
  countApprovals(s)
  return s
}

const approved = approve(spec())
assert.equal(canPublish(approved), true)
for (const policy of [null, undefined, {}, { approvers: ['reviewer'] }, { approvers: ['42'], 'approvals-required': 2 }, { approvers: ['42'], 'approvals-required': '0' }]) {
  assert.equal(canPublish(approve(applyRoles(spec(), policy))), false, 'invalid or absent governance is not approval-free publication')
}
const zero = { authors: ['10'], approvers: [], 'approvals-required': 0 }
assert.equal(canPublish(spec(undefined, undefined, zero)), true, 'explicit protected zero-quorum policy can publish admitted notes')
assert.equal(governance({ approvers: ['42', '42'] }), null)
assert.equal(authorized({ provider: 'github', subject: '43', login: 'reviewer' }, roles.approvers), false)
assert.equal(authorized({ provider: 'github', subject: '42', login: 'renamed' }, roles.approvers), true)
assert.equal(authorized({ login: 'reviewer' }, roles.approvers), false)

for (const permission of ['private', 'limited', 'protected', null, 'invented']) {
  assert.equal(canPublish(approve(spec(undefined, { permission }))), false, 'publication requires explicitly public editor permission')
}
for (const extra of [{ owner_profileid: 'github:99' }, { owner_profile: JSON.stringify({ provider: 'github', id: '99', username: 'writer' }) }, { owner_profile: null }]) {
  const forged = approve(spec(content('owner: writer\n'), extra))
  assert.equal(forged.admitted, false)
  assert.equal(canPublish(forged), false)
}

for (const changed of [spec(content('', 'Changed requirement.')), spec(content('depends-on: [7]\n')),
  spec(content('supersedes: 7\n')), spec(content('area: architecture\n')), spec(content('kind: top-level\n')),
  spec(undefined, { title: 'Different title' }), spec(undefined, undefined, { ...roles, 'specs-dir': 'different' })]) {
  changed.approvalReceipts = approved.approvalReceipts
  countApprovals(changed)
  assert.notEqual(changed.candidate.hash, approved.candidate.hash)
  assert.equal(canPublish(changed), false, 'old receipts cannot authorize a new candidate or policy')
}
assert.equal(spec(content().replace('approved', 'in-review')).candidate.hash, approved.candidate.hash, 'normal status transition does not change the candidate')
const pending = spec(content('', 'A {++suggestion++}'))
assert.notEqual(pending.candidate.hash, spec(content('', 'A suggestion')).candidate.hash)
const blocked = spec(content('', 'Text {>>remove me<<}'))
assert.notEqual(blocked.candidate.hash, spec(content('', 'Text ')).candidate.hash)
const reordered = spec(content('depends-on: [3, 7]\n'))
assert.equal(reordered.candidate.hash, spec(content('depends-on: [7, 3]\n')).candidate.hash)
const legacy = spec()
legacy.approvalReceipts = [{ provider: 'github', subject: '42', label: 'reviewer', hash: digest('Reviewed requirement.') }]
countApprovals(legacy)
assert.equal(canPublish(legacy), false, 'legacy unbound receipts count for zero')
recordedApprovals([legacy], new Map([['note', ['reviewer']]]), new Map())
assert.deepEqual(legacy.approvedBy, [], 'login labels are not approval evidence')

const submission = crypto.randomUUID()
const relations = { supersedes: { ns: 'team/specs', n: 7 }, dependsOn: [] }
const meta = { format: 1, noteId: 'note', namespace: 'team/specs', submission, candidate: approved.candidate.hash,
  bodyHash: digest('Reviewed requirement.'), relations }
const document = publicationDocument('Reviewed requirement.', meta)
assert.deepEqual(publicationMetadata(document), meta)
assert.equal(publicationMetadata(document + 'tampered'), null)
const intent = { id: submission, note_id: 'note', namespace: 'team/specs', candidate_hash: meta.candidate,
  relations, document_hash: digest(document), path: 'specs/008-requirement.md', pr_number: 8, base_branch: 'main' }
const receipt = { body: document, state: 'merged', commit: 'a'.repeat(40), namespace: 'team/specs', base: 'main', number: 8, path: intent.path }
assert.equal(receiptMatches(receipt, intent, 'team/specs', 'note'), true)
for (const patch of [{ state: 'open' }, { commit: null }, { path: 'specs/007-other.md' }, { number: 9 }, { base: 'unprotected' }, { namespace: 'other/specs' }]) {
  assert.equal(receiptMatches({ ...receipt, ...patch }, intent, 'team/specs', 'note'), false)
}
for (const patch of [{ document_hash: 'invalid' }, { path: null }, { pr_number: null }, { base_branch: null }, { candidate_hash: 'invalid' }, { relations: { supersedes: null } }]) {
  assert.equal(receiptMatches(receipt, { ...intent, ...patch }, 'team/specs', 'note'), false)
}
const state = new Map([['note', { namespace: 'team/specs', pr_number: 8 }], ['old', { namespace: 'team/specs', pr_number: 7 }]])
const replacement = approve(spec(content('supersedes: 7\n')))
assert.equal(supersessionTarget(replacement, state), null, 'a live relation and PR number confer no retirement authority')
const verified = { noteId: 'note', namespace: 'team/specs', commit: receipt.commit, relations }
state.get('note').publication_receipt = verified
assert.equal(supersessionTarget({ ...replacement, supersedes: { ns: 'other/specs', n: 3 } }, state), 'old', 'only the verified relation acts')
state.get('old').namespace = 'other/specs'
assert.equal(supersessionTarget(replacement, state), null, 'a note-ID or numeric target cannot cross a namespace')
state.get('old').namespace = 'team/specs'
assert.equal(canPublish(approve(spec(content('supersedes: other/specs#7\n')))), false)

const old = { ...approved, id: 'old', title: 'Old', dependsOn: [], supersedes: null }
state.get('note').publication_receipt = { ...verified, relations: { supersedes: null, dependsOn: [] } }
const graph = specGraph([{ ...replacement, dependsOn: [{ ns: 'team/specs', n: 7 }] }, old], state)
assert.equal(graph.find(n => n.id === 'note').dependsOn.length, 0, 'live relation edits cannot rewrite published dependency graph')
assert.equal(graph.find(n => n.id === 'note').retired.length, 0)
const outsider = { ...approved, id: 'outsider', admitted: false, title: 'Abusive checkpoint blocker', dependsOn: [{ noteId: 'missing' }] }
const privateSource = { ...approved, id: 'hidden', permission: 'private', title: 'Private title' }
const automation = automationSnapshot({ specs: [approved, outsider, privateSource], state: new Map([...state, ['outsider', { namespace: 'team/specs', pr_number: 99 }]]) })
assert.deepEqual(automation.specs.map(source => source.id), ['note'])
assert.equal(automation.state.has('outsider'), false)
assert.ok(automation.graph.every(node => node.id !== 'outsider' && node.id !== 'hidden'), 'claiming a namespace cannot add automation blockers or expose a hidden title')
console.log('publication security: candidate binding, immutable identity, privacy, admission, merge receipts and namespace isolation passed')
