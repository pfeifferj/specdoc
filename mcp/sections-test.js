const assert = require('assert')
const { sections, bodyHash, sectionId, parseSectionId } = require('./sections')

const nested = '# Recovery\n\nThese rules apply only during rollback.\n\n## Journal\n\nReplay the journal before accepting writes.\n\n### Retry\n\nRetry twice.\n\n## Success\n\nResume normal operation.\n'
const parts = sections(nested)
assert.deepStrictEqual(parts.map(s => s.heading), ['Recovery', 'Recovery > Journal', 'Recovery > Journal > Retry', 'Recovery > Success'])
assert.deepStrictEqual(parts.map(s => s.number), [1, 2, 3, 4])
assert.strictEqual(parts[0].text, '# Recovery\n\nThese rules apply only during rollback.\n\n')
assert.strictEqual(parts[1].start, 5)
assert.strictEqual(parts[1].end, 8)
assert.deepStrictEqual(parts[2].ancestors.map(s => s.text), [parts[0].text, parts[1].text])
assert.deepStrictEqual(parts[3].ancestors.map(s => s.text), [parts[0].text])
assert.strictEqual(parts.map(s => s.text).join(''), nested)

const crlf = 'Preamble.\r\n\r\nRecovery\r\n========\r\n\r\nOnly when disconnected.\r\n\r\nRetry\r\n-----\r\n\r\nWait first.\r\n'
const windows = sections(crlf)
assert.deepStrictEqual(windows.map(s => s.heading), ['Introduction', 'Recovery', 'Recovery > Retry'])
assert.strictEqual(windows[1].start, 3)
assert.strictEqual(windows[2].start, 8)
assert.strictEqual(windows[2].end, 11)
assert.strictEqual(windows.map(s => s.text).join(''), crlf)
assert.deepStrictEqual(windows[2].ancestors.map(s => s.text), [windows[0].text, windows[1].text])
assert.strictEqual(sections('A\r\r# B\rC')[1].text, '# B\rC')
const multilineHeading = 'First title line\nSecond title line\n=================\n\nA complete paragraph.\n'
assert.strictEqual(sections(multilineHeading)[0].text, multilineHeading)
assert.strictEqual(sections(multilineHeading)[0].heading, 'First title line Second title line')

const embedded = '# Main\n\n```markdown\n# Fenced heading\n```\n\n- Item\n\n  # List heading\n\n  List text.\n\n> # Quoted heading\n> Quote text.\n\n<div>\n# HTML heading\n</div>\n\n    # Indented heading\n\n| a | b |\n| --- | --- |\n| # Cell | Value |\n\n## Real\n\nKeep the table and code intact.\n'
const blocks = sections(embedded)
assert.deepStrictEqual(blocks.map(s => s.heading), ['Main', 'Main > Real'])
assert.strictEqual(blocks.map(s => s.text).join(''), embedded)
assert.ok(blocks[1].ancestors[0].text.includes('| # Cell | Value |'))

const duplicates = sections('# Root\n\n## Same\nFirst.\n\n## Same\nSecond.\n')
assert.strictEqual(duplicates.length, 2, 'a heading-only ancestor is not a separate candidate')
assert.deepStrictEqual(duplicates.map(s => s.heading), ['Root > Same', 'Root > Same'])
assert.strictEqual(duplicates[0].ancestors.length, 0)
assert.notStrictEqual(duplicates[0].number, duplicates[1].number)
assert.strictEqual(sections('')[0].text, '')
assert.strictEqual(sections('# Empty\n\n## Child\n')[0].text, '# Empty\n\n## Child\n')

const references = '# Rule\n\nRead [the contract][spec].\n\n## Other\n\n![Diagram][image]\n\n## Definitions\n\n[spec]: https://example.test/spec\n  "Versioned contract"\n[image]: https://example.test/image.png\n[unused]: https://example.test/unused\n'
const linked = sections(references)
assert.deepStrictEqual(linked[0].ancestors.map(s => s.heading), ['Reference [SPEC]'])
assert.strictEqual(linked[0].ancestors[0].text, '[spec]: https://example.test/spec\n  "Versioned contract"\n')
assert.deepStrictEqual(linked[1].ancestors.map(s => s.heading), ['Rule', 'Reference [SPEC]', 'Reference [IMAGE]'])
assert.ok(!linked[0].ancestors.some(s => s.text.includes('[unused]')))
assert.deepStrictEqual(linked[2].ancestors.map(s => s.heading), ['Rule'], 'a definition already in the section is not duplicated')
const repeatedReference = sections('# Rule\nUse [reference].\n\n# Definitions\n[reference]: https://example.test/first\n[reference]: https://example.test/second\n')
assert.strictEqual(repeatedReference[0].ancestors[0].text, '[reference]: https://example.test/first\n', 'the first definition wins as it does in Markdown')
assert.deepStrictEqual(sections(references), linked, 'parsing does not retain reference definitions between documents')

const rulePreamble = '# Rules\n\nDuring rollback only.\n\n'
const ruleScope = '## Functional Requirements\n\nApply every applicable exception below.\n\n'
const firstRule = '- **FR-001**: Preserve [recovery][contract] before writes.\n  Continue the same requirement here.\n\n  - **FR-999**: This nested example is part of FR-001.\n\n  ```text\n  - **FR-998**: A code example, not another requirement.\n  ```\n\n  Keep this concluding paragraph with the requirement.\n\n'
const secondRule = '- **FR-002**: Release the journal.\n\n'
const ruleSuffix = 'These rules do not apply after successful recovery.\n\n'
const ruleReferences = '## References\n\n[contract]: https://example.test/recovery\n'
const requirementSource = rulePreamble + ruleScope + firstRule + secondRule + ruleSuffix + ruleReferences
const requirementSections = sections(requirementSource)
const atomicRules = requirementSections.filter(s => s.label)
assert.deepStrictEqual(atomicRules.map(s => s.label), ['FR-001', 'FR-002'])
assert.deepStrictEqual(atomicRules.map(s => s.heading), ['Rules > Functional Requirements > FR-001', 'Rules > Functional Requirements > FR-002'])
assert.deepStrictEqual(atomicRules.map(s => s.text), [firstRule, secondRule], 'nested lists, examples and continuations stay with their requirement')
for (const rule of atomicRules) {
  assert.deepStrictEqual(rule.ancestors.slice(0, 3).map(s => s.text), [rulePreamble, ruleScope, ruleSuffix], 'all enclosing and surrounding conditions accompany each requirement')
}
assert.strictEqual(atomicRules[0].ancestors.at(-1).text, '[contract]: https://example.test/recovery\n')
assert.ok(!atomicRules[1].ancestors.some(a => a.heading === 'Reference [CONTRACT]'), 'reference definitions accompany the items that use them')
const sourceLines = requirementSource.match(/.*(?:\n|$)/g).filter(Boolean)
const coveredLines = new Set()
for (const unit of requirementSections) {
  for (const range of [unit, ...unit.ancestors]) {
    assert.strictEqual(range.text, sourceLines.slice(range.start - 1, range.end).join(''), 'each excerpt is an exact contiguous source range')
    for (let line = range.start; line <= range.end; line++) coveredLines.add(line)
  }
}
assert.strictEqual(coveredLines.size, sourceLines.length, 'splitting does not lose headings, prose, whitespace or requirements')

const acceptance = 'Success criteria\r\n================\r\n\r\n1. **SC-001**: Reject invalid data.\r\n\r\n   ```json\r\n   {"invalid": true}\r\n   ```\r\n\r\n2. `SC-002`: Accept valid data.\r\n'
const acceptanceItems = sections(acceptance)
assert.deepStrictEqual(acceptanceItems.map(s => s.label), ['SC-001', 'SC-002'])
assert.strictEqual(acceptanceItems[0].ancestors[0].text, 'Success criteria\r\n================\r\n\r\n')
assert.strictEqual(acceptanceItems[0].text, '1. **SC-001**: Reject invalid data.\r\n\r\n   ```json\r\n   {"invalid": true}\r\n   ```\r\n\r\n')
assert.strictEqual(acceptanceItems[1].text, '2. `SC-002`: Accept valid data.\r\n')
assert.deepStrictEqual(sections('- **FR-001**\n  Keep data.\n\n- **FR-002**\n  Release data.\n').map(s => s.label), ['FR-001', 'FR-002'], 'a label can introduce a continuation on the next line')

const mixedRequirements = '# Mixed\n\n- **FR-001**: Preserve state.\n- This condition applies to the preceding requirement.\n- **FR-002**: Restore state.\n'
assert.strictEqual(sections(mixedRequirements).length, 1, 'mixed labelled and unlabelled lists remain intact')
assert.strictEqual(sections(mixedRequirements)[0].text, mixedRequirements)
const embeddedLabels = '# Examples\n\n> - **FR-001**: Quoted material.\n\n```text\n- **FR-002**: Fenced material.\n```\n\n- Ordinary list\n  - **SC-001**: Nested material.\n'
assert.ok(sections(embeddedLabels).every(s => !s.label), 'only document-level lists can produce requirement units')

const severalLists = 'Scope before either list.\n\n- FR-001: First rule.\n\nAn exception between lists.\n\n1. SC-001: First result.\n\nException after both lists.\n'
const multipleItems = sections(severalLists)
assert.deepStrictEqual(multipleItems.map(s => s.label), ['FR-001', 'SC-001'])
for (const item of multipleItems) {
  assert.deepStrictEqual(item.ancestors.map(a => a.text), ['Scope before either list.\n\n', 'An exception between lists.\n\n', 'Exception after both lists.\n'])
}

const manySections = Array.from({ length: 1200 }, (_, i) => `## Requirement ${i}\n\nConsult [shared] before step ${i}.\n\n`)
const commonDefinition = '[shared]: https://example.test/contract\n'
const large = sections(`# Rules\n\nAll requirements preserve [shared].\n\n${manySections.join('')}# References\n\n${commonDefinition}`)
assert.strictEqual(large.length, 1202)
for (let i = 1; i <= manySections.length; i++) {
  assert.strictEqual(large[i].text, manySections[i - 1])
  assert.deepStrictEqual(large[i].ancestors.map(a => a.heading), ['Rules', 'Reference [SHARED]'])
  assert.strictEqual(large[i].ancestors[1].text, commonDefinition)
}
assert.deepStrictEqual(large.at(-1).ancestors, [], 'reference definitions in their own section are not repeated')

const hash = bodyHash(nested)
assert.match(hash, /^[0-9a-f]{16}$/)
assert.strictEqual(hash, bodyHash(nested))
assert.notStrictEqual(hash, bodyHash(nested + '\n'))
assert.notStrictEqual(bodyHash('a\r\n'), bodyHash('a\n'), 'the hash identifies exact source bytes')
const id = sectionId('note:with/slash #', hash, 3)
assert.deepStrictEqual(parseSectionId(id), { noteId: 'note:with/slash #', hash, number: 3 })
assert.strictEqual(sectionId('abc', hash, 1), `section:abc:${hash}:1`)
assert.notStrictEqual(sectionId('abc', hash, duplicates[0].number), sectionId('abc', hash, duplicates[1].number))
for (const malformed of [null, '', 'spec:abc', `section:a:${hash}:0`, `section:a:${hash}:-1`, `section:a:${hash}:1.0`, `section:a:${hash}:01`, `section:a:${hash}:9007199254740992`, `section:%xx:${hash}:1`, `section:%00:${hash}:1`, `section:a:${hash.toUpperCase()}:1`, `section:a:${hash}:1:extra`]) {
  assert.strictEqual(parseSectionId(malformed), null, String(malformed))
}

console.log('sections ok')
