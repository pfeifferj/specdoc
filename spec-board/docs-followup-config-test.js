const assert = require('node:assert/strict')
const { test } = require('node:test')
const { documentationTargets } = require('./docs-followup-config')

const target = { namespace: 'Team/Specs', targetRepo: 'Team/Docs', bot: 'reviewer', paths: ['docs/guide.md', 'README.md'] }
const parse = targets => documentationTargets(JSON.stringify(targets), ['team/specs'])

test('documentation follow-up is disabled by default and normalizes repository identities', () => {
  assert.deepEqual(documentationTargets('', ['team/specs']), [])
  assert.deepEqual(parse([target]), [{ ...target, namespace: 'team/specs', targetRepo: 'team/docs', paths: ['README.md', 'docs/guide.md'], exclude: [] }])
  assert.throws(() => parse([target, { ...target, namespace: 'team/specs', targetRepo: 'team/docs' }]), /duplicate/)
})

test('scope cannot include an unknown namespace, executable file, path escape or glob', () => {
  assert.throws(() => parse([{ ...target, namespace: 'other/specs' }]), /namespace/)
  for (const path of ['../README.md', '/README.md', 'docs/../README.md', 'docs\\README.md', 'docs/%2e%2e/x.md',
    '.github/README.md', 'docs/.hidden.md', 'docs/*.md', 'docs/a.mdx', 'scripts/run.js', 'docs/x.md\0']) {
    assert.throws(() => parse([{ ...target, paths: [path] }]), /Markdown/, path)
  }
  assert.throws(() => parse([{ ...target, paths: ['README.md'], exclude: ['README.md'] }]), /included/)
  assert.throws(() => parse([{ ...target, sourceRepos: ['other/code'] }]), /unknown/)
  assert.throws(() => documentationTargets('null', []), /array/)
})
