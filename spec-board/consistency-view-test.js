const assert = require('node:assert/strict')
const { test } = require('node:test')
const { renderConsistency, renderConsistencyResult } = require('./consistency-view')

const complete = { namespace: 'demo/specs', ran: true, eligible: 8, compared: 8, omitted: [], findings: [], rejected: 0, failed: 0, truncated: 0, stale: false }

test('the form submits the selected project and CSRF token without JavaScript', () => {
  const html = renderConsistency({ csrf: 'a"<token>', namespace: 'other/specs', namespaces: [{ namespace: 'demo/specs', count: 8 }, { namespace: 'other/specs', count: 1 }] })
  assert.match(html, /method="post" action="\/bots\/consistency"/)
  assert.match(html, /name="csrf" value="a&quot;&lt;token&gt;"/)
  assert.match(html, /value="other\/specs" selected>other\/specs · 1 active spec<\/option>/)
  assert.match(html, /demo\/specs · 8 active specs/)
  assert.match(html, /type="submit" id="run-consistency">Run review/)
  assert.match(html, /Unresolved discussions block publication and affected checkpoints, even when one spec is a draft/)
  assert.match(html, /role="status" aria-live="polite" tabindex="-1"/)
})

test('an unavailable project count is not displayed as an empty project', () => {
  const html = renderConsistency({ namespace: 'demo/specs', namespaces: [{ namespace: 'demo/specs', count: null }, { namespace: 'empty/specs', count: 0 }], error: 'Project policy could not be read. Try again.' })
  assert.match(html, /demo\/specs · Count unavailable/)
  assert.match(html, /empty\/specs · 0 active specs/)
  assert.match(html, /Project policy could not be read/)
})

test('source text and links cannot inject markup or executable URLs', () => {
  const hostile = '<img src=x onerror="alert(1)">'
  const html = renderConsistency({ csrf: hostile, namespace: hostile, namespaces: [{ namespace: hostile, count: 3 }], result: {
    ...complete,
    findings: [{ title: hostile, url: 'javascript:alert(1)', links: [{ title: hostile, url: '/model?a="b"&c=d#discussion-1' }, { title: 'Other source', url: '//attacker.test' }, { title: 'Backslash', url: '/\\attacker.test' }] }]
  } })
  assert.doesNotMatch(html, /<img|href="javascript:|href="\/\/|href="\/\\/)
  assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/)
  assert.match(html, /href="\/model\?a=&quot;b&quot;&amp;c=d#discussion-1"/)
  assert.match(renderConsistencyResult(null, hostile), /&lt;img/)
})

test('a finding links to the same discussion from both specs and retains resolution', () => {
  const html = renderConsistencyResult({ ...complete, findings: [{ threadId: 1, url: '/model#discussion-1', title: 'Conflicting requirements', resolved: true, links: [{ title: 'State model', url: '/model#discussion-1' }, { title: 'YAML format', url: '/format#discussion-1' }] }] })
  assert.match(html, /1 finding in a shared discussion\. All 8 specs included\./)
  assert.match(html, /Conflicting requirements<\/a> · Resolved/)
  assert.match(html, /href="\/model#discussion-1">State model/)
  assert.match(html, /href="\/format#discussion-1">YAML format/)
  assert.match(html, /Resolve a shared discussion once for both specs/)
})

test('only a complete review can report no supported findings', () => {
  assert.match(renderConsistencyResult(complete), /No supported conflicts or overlaps found/)
  for (const partial of [
    { compared: 6 },
    { omitted: [{ title: 'Large spec', url: '/large', reason: 'size' }], compared: 7 },
    { rejected: 1 }, { failed: 1 }, { truncated: 1 }, { eligible: 0, compared: 0 }
  ]) {
    const html = renderConsistencyResult({ ...complete, ...partial })
    assert.doesNotMatch(html, /No supported conflicts or overlaps found/)
    assert.match(html, /No findings recorded/)
    assert.match(html, /class="warn"/)
  }
})

test('omitted specs and failed findings explain why a result is incomplete', () => {
  const html = renderConsistencyResult({ ...complete, compared: 6, omitted: [{ id: 'large', title: 'Large spec', url: '/large', reason: 'size' }], rejected: 2, failed: 1 })
  assert.match(html, /6 of 8 specs included/)
  assert.match(html, /1 spec exceeded the context limit/)
  assert.match(html, /href="\/large">Large spec<\/a> separately/)
  assert.match(html, /2 findings could not be verified; 1 finding could not be saved/)
})

test('stale results suppress old source links and any clean-review claim', () => {
  const html = renderConsistencyResult({ ...complete, stale: true, saved: 2, findings: [{ title: 'Old finding', url: '/old', links: [] }], omitted: [{ title: 'Old omitted', url: '/private' }] })
  assert.match(html, /changed after this review started/)
  assert.match(html, /Run review again/)
  assert.match(html, /already created 2 shared discussions/)
  assert.doesNotMatch(html, /Old finding|Old omitted|href=|No supported/)
})

test('a failed review reports saved discussions without exposing stale sources', () => {
  const partial = { ...complete, saved: 1, findings: [{ title: 'Private finding', url: '/private', links: [] }], omitted: [{ title: 'Private source', url: '/source' }] }
  const error = 'Project policy could not be read. Try again.'
  for (const html of [renderConsistencyResult(partial, error), renderConsistencyResult({ ...partial, error })]) {
    assert.match(html, /Project policy could not be read/)
    assert.match(html, /This run already created 1 shared discussion\./)
    assert.doesNotMatch(html, /Private finding|Private source|href=|No supported|All 8 specs/)
  }
  assert.doesNotMatch(renderConsistencyResult({ saved: '<img src=x>' }, error), /already created|<img/)
})

test('no-run reasons and errors never imply a completed comparison', () => {
  for (const reason of ['no-bot', 'too-few-specs', 'context-too-small']) {
    const html = renderConsistencyResult({ ...complete, ran: false, reason })
    assert.match(html, /No review ran/)
    assert.doesNotMatch(html, /All 8 specs included|No supported/)
  }
  assert.match(renderConsistencyResult(complete, 'Daily model budget reached. No review ran.'), /Daily model budget reached/)
  assert.doesNotMatch(renderConsistencyResult(complete, 'Daily model budget reached.'), /No supported/)
  assert.doesNotMatch(renderConsistency({ namespaces: [] }), /<form/)
})

test('the browser and server use the same escaped result renderer', () => {
  const fs = require('node:fs')
  const vm = require('node:vm')
  const context = { window: {} }
  vm.runInNewContext(fs.readFileSync(require.resolve('./consistency-view'), 'utf8'), context)
  assert.equal(context.window.SpecDocConsistency.renderConsistencyResult(complete), renderConsistencyResult(complete))
})
