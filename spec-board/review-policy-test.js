'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createReviewPolicyReader } = require('./review-policy')

test('discussion policy refresh is shared and bounded per configured namespace', async () => {
  let time = 0, calls = 0, release
  let cached = { approvers: ['42'] }
  const source = { namespace: 'team/specs' }
  const reader = createReviewPolicyReader({ namespaces: [source.namespace], now: () => time,
    read: async () => cached,
    refresh: async () => { calls++; await new Promise(resolve => { release = resolve }); return cached } })
  const first = reader(source)
  const second = reader(source)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
  release()
  assert.deepEqual(await first, await second)
  for (let i = 0; i < 60; i++) assert.equal(await reader(source), cached)
  assert.equal(calls, 1, 'repeated writes cannot force a fresh GitHub fetch')
  cached = { approvers: ['43'] }
  assert.equal(await reader(source), cached, 'a policy refreshed by publication is visible immediately')
  assert.equal(await reader({ namespace: 'attacker/specs' }), null)
  time = 30000
  const afterExpiry = reader(source)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  release()
  await afterExpiry
})

test('a cached roster denies unrelated actors without consuming a refresh', async () => {
  let calls = 0
  const cached = { approvers: ['42'] }
  const source = { namespace: 'team/specs' }
  const reader = createReviewPolicyReader({ namespaces: [source.namespace], read: async () => cached,
    refresh: async () => { calls++; return cached } })
  for (let i = 0; i < 60; i++) await reader(source, policy => policy.approvers.includes('99'))
  assert.equal(calls, 0)
  await reader(source, policy => policy.approvers.includes('42'))
  assert.equal(calls, 1, 'an eligible actor can still refresh after rejected attempts')
})

test('a cold policy or failed refresh remains bounded and unavailable', async () => {
  let calls = 0, time = 0
  const source = { namespace: 'team/specs' }
  const reader = createReviewPolicyReader({ namespaces: [source.namespace], now: () => time, read: async () => null,
    refresh: async () => { calls++; return null } })
  for (let i = 0; i < 60; i++) assert.equal(await reader(source), null)
  assert.equal(calls, 1)
  time = 30000
  assert.equal(await reader(source), null)
  assert.equal(calls, 2)
})
