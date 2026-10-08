const assert = require('assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { Pool } = require('pg')
process.env.GITHUB_TOKEN = 'test-token-never-sent'
delete process.env.GITHUB_APP_ID
delete process.env.GITHUB_APP_PRIVATE_KEY
delete process.env.SMTP_HOST

const file = path.join(__dirname, 'server.js')
const mod = new Module(file + '.reviewer-identities-test', module)
mod.filename = file
mod.paths = Module._nodeModulePaths(__dirname)
mod._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.fixture = { commitIdentities, reviewerIdentities, participantUsers }\n', file)
const { commitIdentities, reviewerIdentities, participantUsers } = mod.exports.fixture
const namespace = 'team/specs'
const githubUser = (id, username, displayName, email) => ({
  id, email, profileid: `github:${id}`,
  profile: JSON.stringify({ provider: 'github', id, username, displayName })
})
const users = [
  githubUser('1', 'owner', 'Owner', 'owner@example.test'),
  githubUser('2', 'approver', 'Approver A', 'approver@example.test'),
  githubUser('3', 'rahulrj', 'rahul Rajesh', 'rahul@example.test'),
  githubUser('4', 'commenter', 'Commenter C', 'account@example.test'),
  { id: '5', email: 'external@example.test', profile: JSON.stringify({ provider: 'oauth2', username: 'external-handle', displayName: 'Other Reviewer' }) }
]
const authorEmails = new Map([
  ['1', [{ namespace: '', email: 'owner-global@example.test' }]],
  ['2', [{ namespace, email: 'approver-commit@example.test' }]],
  ['4', [{ namespace: '', email: 'commenter-global@example.test' }, { namespace, email: 'commenter-commit@example.test' }]]
])
const notificationEmails = new Map([['3', 'private-rahul@example.test'], ['4', 'private-delivery@example.test']])
const preference = id => {
  const rows = authorEmails.get(id) || []
  return (rows.find(r => r.namespace === namespace) || rows.find(r => r.namespace === ''))?.email
}
const content = users.map(u => `{>>@${JSON.parse(u.profile).displayName}: Looks good<<}{>>%%resolved%%<<}`).join('\n')
const authorship = users.map(u => {
  const name = JSON.parse(u.profile).displayName
  const start = content.indexOf(name)
  return [u.id, start, start + name.length, 1, 1]
})
const spec = {
  id: 'note', namespace, ownerId: '1', authorDisplayName: 'Owner', authorEmail: users[0].email,
  approvers: ['approver'], approvedBy: ['APPROVER'], content, authorship
}

async function main () {
  const originalQuery = Pool.prototype.query
  const originalFetch = global.fetch
  global.fetch = async () => { throw new Error('identity resolution must not fetch an email from GitHub') }
  Pool.prototype.query = async function (sql, args) {
    if (sql.includes('SELECT namespace, email FROM spec_board_email')) {
      assert.equal(args[1], namespace)
      return { rows: authorEmails.get(args[0]) || [] }
    }
    if (sql.includes('SELECT id, email, profile, profileid')) {
      return { rows: users.filter(u => args[0].includes(JSON.parse(u.profile).username)) }
    }
    if (sql.includes('JOIN "Authors"')) {
      assert.deepEqual(args, ['note', namespace])
      const notification = sql.includes('spec_board_notify_email')
      return { rows: users.map(u => ({ ...u, email: (notification ? notificationEmails.get(u.id) : preference(u.id)) || u.email })) }
    }
    throw new Error('Unexpected database query: ' + sql)
  }
  try {
    spec.approverUsers = await reviewerIdentities(['APPROVER'])
    const identities = await commitIdentities(spec)
    assert.deepEqual(identities.author, { name: 'Owner', email: 'owner-global@example.test' })
    assert.deepEqual(identities.reviewers, [
      { name: 'Approver A', login: 'approver', email: 'approver-commit@example.test' },
      { name: 'Commenter C', login: 'commenter', email: 'commenter-commit@example.test' },
      { name: 'Other Reviewer', login: null, email: 'external@example.test' },
      { name: 'rahul Rajesh', login: 'rahulrj', email: 'rahul@example.test' }
    ])
    assert.ok(!JSON.stringify(identities).includes('private-'), 'notification delivery addresses never become commit credits')
    authorEmails.get('4').pop()
    assert.equal((await commitIdentities(spec)).reviewers.find(u => u.login === 'commenter').email, 'commenter-global@example.test')
    authorEmails.delete('4')
    assert.equal((await commitIdentities(spec)).reviewers.find(u => u.login === 'commenter').email, 'account@example.test')
    users[3].email = null
    const profile = JSON.parse(users[3].profile)
    profile.emails = [{ value: 'profile@example.test' }]
    users[3].profile = JSON.stringify(profile)
    assert.equal((await commitIdentities(spec)).reviewers.find(u => u.login === 'commenter').email, 'profile@example.test')
    const participants = await participantUsers('note', namespace)
    assert.equal(participants.find(u => u.id === '4').email, 'private-delivery@example.test', 'notifications retain their delivery preference')
    assert.deepEqual((await commitIdentities({ ...spec, authorship: [] })).reviewers, [identities.reviewers[0]], 'comment credit still requires authored signatures')
    users[2].email = null
    await assert.rejects(commitIdentities(spec), /Missing commit email for rahul Rajesh \(@rahulrj\).*Sign in again/)
    users[2].email = 'rahul@example.test'
    await assert.rejects(commitIdentities({ ...spec, authorEmail: null, ownerId: 'unknown-owner' }), /Missing commit email for Owner/)
    console.log('reviewer identities: commit email preferences, complete identity gate and comment attestation passed')
  } finally {
    Pool.prototype.query = originalQuery
    global.fetch = originalFetch
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
