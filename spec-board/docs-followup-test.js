const assert = require('node:assert/strict')
const test = require('node:test')
const { assessDocumentation, validateProposal } = require('./docs-followup')

const config = { namespace: 'example/specs', targetRepo: 'example/docs', paths: ['guide.md'], exclude: [], bot: 'reviewer' }
const source = { complete: true, repo: 'example/core', number: 7, mergeSha: 'a'.repeat(40),
  author: { id: 24, login: 'contributor', type: 'User' },
  files: [{ path: 'src/lib.rs', status: 'modified', blob: 'b'.repeat(40), content: 'pub fn enable() {}', patch: '+pub fn enable() {}' }] }
const baseline = { complete: true, repo: config.targetRepo, commit: 'c'.repeat(40),
  files: [{ path: 'guide.md', mode: '100644', blob: 'd'.repeat(40), content: '# Usage\n' }] }
const proposal = { summary: 'Describe enabling the feature.', reason: 'The feature is now available.',
  edits: [{ path: 'guide.md', beforeBlob: 'd'.repeat(40), hunks: [{ find: '# Usage\n', replace: '# Usage\n\nEnable the feature.\n' }] }],
  evidence: [{ path: 'src/lib.rs', quote: 'pub fn enable() {}' }] }
const beforeText = content => ({ ...baseline, files: [{ ...baseline.files[0], content }] })
const replaceText = (content, before = baseline) => ({ ...proposal,
  edits: [{ ...proposal.edits[0], hunks: [{ find: before.files[0].content, replace: content }] }] })
const reject = (value, before = baseline) => assert.throws(() => validateProposal(value, source, before, config), { code: 'docs-model-invalid' })

test('assessment sends exact hunks and necessary source evidence without author identity', async () => {
  const signal = new AbortController().signal
  let args
  const result = await assessDocumentation({ config, source, baseline, bot: { name: 'reviewer', namespaces: ['other/specs'] }, signal,
    modelCall: async (...input) => { args = input; return { needed: true, ...proposal } } })
  assert.deepEqual(result, { needed: true, proposal: validateProposal(proposal, source, baseline, config) })
  assert.deepEqual(args[0].budgetNamespaces, [config.namespace])
  assert.equal(args[0].budgetKey, 'documentation:example/core#7')
  assert.equal(args[6].signal, signal)
  assert.deepEqual(JSON.parse(args[2]), { source: { repo: source.repo, number: source.number, mergeSha: source.mergeSha, files: source.files }, baseline })
  assert.deepEqual(args[4].properties.edits.items.required, ['path', 'beforeBlob', 'hunks'])
  assert.equal(args[4].properties.edits.items.properties.content, undefined)
})

test('missing evidence, model failures and invalid output remain distinct', async () => {
  let calls = 0
  const base = { config, source, baseline, bot: {}, modelCall: async () => { calls++; throw new Error('unavailable') } }
  await assert.rejects(assessDocumentation({ ...base, source: { ...source, complete: false } }), { code: 'incomplete' })
  await assert.rejects(assessDocumentation({ ...base, config: { ...config, paths: ['guide.md', 'other.md'] } }), { code: 'incomplete' })
  assert.equal(calls, 0)
  await assert.rejects(assessDocumentation(base), /unavailable/)
  const unchanged = { needed: false, reason: 'The existing guide describes this behavior.', summary: '', edits: [], evidence: [] }
  assert.deepEqual(await assessDocumentation({ ...base, modelCall: async () => unchanged }), { needed: false, reason: unchanged.reason })
  for (const value of [null, { ...unchanged, needed: 'false' }, { ...unchanged, edits: proposal.edits },
    { ...unchanged, summary: 'Unexpected content.' }, { needed: true, ...proposal, edits: [] }]) {
    await assert.rejects(assessDocumentation({ ...base, modelCall: async () => value }), { code: 'docs-model-invalid' })
  }
  const abort = new AbortController()
  await assert.rejects(assessDocumentation({ ...base, signal: abort.signal, modelCall: async () => {
    abort.abort(); return { needed: true, ...proposal }
  } }), { name: 'AbortError' })
})

test('normalized proposals reapply exact hunks and preserve untouched bytes', () => {
  const before = beforeText('# Guide\n\nOld wording.\n\nKeep this paragraph.\n\nMore wording.\n')
  const edit = { ...proposal, edits: [{ ...proposal.edits[0], hunks: [
    { find: 'More wording.', replace: 'More useful wording.' }, { find: 'Old wording.', replace: 'Current wording.' }
  ] }] }
  const normalized = validateProposal(edit, source, before, config)
  assert.equal(normalized.edits[0].content, '# Guide\n\nCurrent wording.\n\nKeep this paragraph.\n\nMore useful wording.\n')
  assert.deepEqual(validateProposal(normalized, source, before, config), normalized)
  reject({ ...normalized, edits: [{ ...normalized.edits[0], content: '# Invented replacement\n' }] }, before)
  assert.ok(validateProposal(replaceText('# Guide\n'), source, baseline, config))
  const long = beforeText('# Guide\n\n' + 'Unchanged paragraph.\n\n'.repeat(1500) + 'Unique old wording.\n')
  const bounded = { ...proposal, edits: [{ ...proposal.edits[0], hunks: [{ find: 'Unique old wording.', replace: 'Unique new wording.' }] }] }
  assert.equal(validateProposal(bounded, source, long, config).edits[0].content, long.files[0].content.replace('Unique old wording.', 'Unique new wording.'))
})

test('ambiguous, overlapping, oversized and destructive hunks cannot publish', () => {
  const before = beforeText('# Guide\n\nRepeated word.\n\nRepeated word.\n\nKeep this paragraph unchanged.\n')
  for (const hunks of [[], [{ find: '', replace: 'Extra' }], [{ find: 'absent', replace: 'Extra' }],
    [{ find: 'Repeated word.', replace: 'Other.' }],
    [{ find: '# Guide', replace: '# Updated' }, { find: 'Guide', replace: 'New guide' }],
    [{ find: '# Guide', replace: 'x'.repeat(4001) }],
    [{ find: before.files[0].content, replace: 'x' }]]) reject({ ...proposal, edits: [{ ...proposal.edits[0], hunks }] }, before)
  const large = beforeText('x'.repeat(2001))
  reject(replaceText('x'.repeat(2002), large), large)
  const noHunks = { ...proposal, edits: [{ path: 'guide.md', beforeBlob: 'd'.repeat(40), content: '# Guide\n' }] }
  reject(noHunks)
})

test('proposals cannot escape paths, stale blobs or exact source evidence', () => {
  for (const value of [
    { ...proposal, edits: [{ ...proposal.edits[0], path: '../guide.md' }] },
    { ...proposal, edits: [{ ...proposal.edits[0], beforeBlob: '0'.repeat(40) }] },
    { ...proposal, edits: [proposal.edits[0], proposal.edits[0]] },
    { ...proposal, evidence: [{ path: 'src/lib.rs', quote: 'invented behavior' }] }
  ]) reject(value)
  assert.throws(() => validateProposal(proposal, source, baseline, { ...config, exclude: ['guide.md'] }), { code: 'incomplete' })
})

test('summary and reason cannot create notification recipients, close issues or report checks', () => {
  for (const field of ['summary', 'reason']) {
    for (const text of ['Ask @maintainer to review.', 'Notify @example/reviewers.', 'Fixes #12.', 'Fixes GH-12.', 'Resolves gh-24.', 'Resolves example/project#42.',
      'Closes https://github.com/example/project/issues/12.', 'See https://github.com/example/project/pull/8.',
      'Checks: 74 tests passed.', 'All checks are green.', 'Tested on Fedora 41.', 'Verified with cargo test.',
      'Checks:74 fixture tests.', 'Tests: completed.', 'Verification: complete.', 'Validation: complete.',
      'Includes 74 fixture tests.', 'There are 12 checks.', 'Run cargo test', 'Execute: npm test', 'Invoke bash check.sh']) {
      reject({ ...proposal, [field]: text })
    }
    assert.ok(validateProposal({ ...proposal, [field]: 'Describe validation errors' }, source, baseline, config))
  }
})

test('frontmatter, heading identifiers and whole snippet fences stay unchanged and ordered', () => {
  const first = '```yaml\n--8<-- "first.yaml"\n```'
  const second = '```yaml\n-8<-\nsecond.yaml\n-8<-\n```'
  const text = '---\ntitle: Guide\n---\n\n# Guide {#guide}\n\nFirst example.\n\n' + first + '\n\nSecond example.\n\n' + second + '\n'
  const before = beforeText(text)
  assert.equal(validateProposal(replaceText(text.replace('First example.', 'Use the first example.'), before), source, before, config).edits[0].content,
    text.replace('First example.', 'Use the first example.'))
  for (const changed of [text.replace('first.yaml', 'other.yaml'), text.replace('second.yaml', 'other.yaml'),
    text.replace('{#guide}', '{#other}'), text.replace('title: Guide', 'title: Other'),
    text.replace(first, second).replace('Second example.\n\n' + second, 'Second example.\n\n' + first),
    text.replace('\n\n' + first, '\n' + first)]) reject(replaceText(changed, before), before)
  for (const marker of ['-8<-', '--8<--', '---8<---', '-8<---']) {
    reject(replaceText('```yaml\n' + marker + ' "secret.md"\n```\n'))
    reject(replaceText(marker + '\nsecret.md\n' + marker))
  }
})

test('ordinary prose, tables, single-line code and plain balanced fences remain editable', () => {
  for (const text of ['# Updated guide\n\nUse the feature.\n', 'Use `data:text/plain,example` for the value.',
    'Avoid `javascript:alert(1)` links.', 'Use `Vec<State>` for the result.',
    '| Field | Value |\n| --- | --- |\n| `name` | Text |\n', '- First item\n- Second item\n',
    '```rust\nVec<State>\n```\n', '~~~yaml\nkey: value\n~~~\n']) {
    assert.equal(validateProposal(replaceText(text), source, baseline, config).edits[0].content, text)
  }
})

test('unsupported leading metadata cannot be introduced or edited', () => {
  for (const metadata of ['--- \ntitle: Changed\n---\n\n', '---\t\ntitle: Changed\n---\n\n',
    '\ufeff---\ntitle: Changed\n---\n\n', 'title: Changed\n\n', '  template: alternate.html\n\n']) {
    reject(replaceText(metadata + '# Usage\n'))
    const before = beforeText(metadata + '# Usage\n')
    reject(replaceText(before.files[0].content + '\nNew paragraph.\n', before), before)
  }
})

test('MkDocs renderer boundaries cannot introduce active markup or executable directives', () => {
  const attacks = [
    '```text\n<img src=x onerror=alert(1)>\n',
    '!!! note\n\n    <img src=x onerror=alert(1)>',
    '- step\n\n      Text\n      {: onclick="alert(1)" }',
    'Run ``x\n<video src=x onerror=alert(1)></video>\ny`` now.',
    'Run `x\r\r<img src=x onerror=alert(1)>\r\ry` now.',
    'Run `x\r\rText\r{: onclick="alert(1)" }\r\ry` now.',
    'Run `x\r\r!!! note\r\r    <img src=x onerror=alert(1)>\r\ry` now.',
    '# Guide\r\n\r\nUse the feature.\r\n',
    'Read the <svg/onload=alert(1)> guide.', '<img src="x"onerror="alert(1)">',
    '<scr\x02ipt>alert(1)</scr\x02ipt>', '[a](java\x02script:alert(1))', '[a](<\x01javascript:alert(1)>)',
    '```yaml title="<img src=x onerror=alert(1)>" title_mode="html"\nkey: value\n```',
    '```text\n````\n<img src=x onerror=alert(1)>\n```', '\\`<svg/onload=alert(1)>\\`',
    '[link](https://example.com){: onclick="alert(1)"}',
    '[click](javascript:alert(1))', '[click](data:text/html,test)', '[click](vbscript:evil)',
    '[click](jav&#x61;script:evil)', '[click](javascript&colon;alert(1))',
    '[click](java&Tab;script:alert(1))', '[click](java&NewLine;script:alert(1))',
    '{% include "partial.html" %}', '`{{ page.description }}`', '```markdown\n{% include "partial.html" %}\n```'
  ]
  for (const text of attacks) assert.throws(() => validateProposal(replaceText(text), source, baseline, config), { code: 'docs-model-invalid' }, text)
  const unsupported = beforeText('# Guide\n\n<img src="logo.png">\n')
  reject(replaceText(unsupported.files[0].content + '\nNew paragraph.\n', unsupported), unsupported)
})

test('added process reports are rejected without banning durable testing instructions', () => {
  for (const added of ['## Verification\n\nRan cargo test: 74 passed.', '## Review notes\n\nThe change is ready.',
    '## Evidence appendix\n\nCommand output follows.', '## Migration log\n\nChanged the deployment.',
    '- [x] Run checks', 'All checks are green.', 'Tested on Fedora 41.']) reject(replaceText('# Usage\n\n' + added + '\n'))
  const durable = '# Testing\n\nRun `cargo test` before submitting a change.\n\nUse a disposable database for integration tests.\n'
  assert.ok(validateProposal(replaceText(durable), source, baseline, config))
  const existing = beforeText('# Guide\n\n## Review notes\n\nExisting text.\n')
  assert.ok(validateProposal(replaceText(existing.files[0].content + '\nUse the feature.\n', existing), source, existing, config))
})
