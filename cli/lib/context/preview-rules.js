'use strict'
const { createHash } = require('node:crypto')
const { z } = require('zod')

const named = limit => z.string().min(1).max(limit).refine(value => value.trim() === value && !/[\x00-\x1f\x7f]/.test(value), 'must be nonempty trimmed text without control characters')
const id = named(128)
const selector = z.union([
  z.object({ label: id }).strict(),
  z.object({ startLine: z.number().int().positive().safe(), endLine: z.number().int().positive().safe() }).strict().refine(value => value.endLine >= value.startLine, 'endLine must follow startLine')
])
const ruleSchema = z.object({
  id,
  governing: z.object({ source: id, selector }).strict(),
  type: z.literal('forbid-relation'),
  relation: z.enum(['normative', 'implementation', 'publication', 'supersedes']),
  from: z.array(id).max(128),
  to: z.array(id).max(128),
  required: z.boolean().default(true)
}).strict()
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
const exceptionSchema = z.object({
  rule: id,
  version: z.string().regex(/^[a-f0-9]{64}$/),
  scope: z.array(id).min(1).max(128),
  stage: named(128),
  owner: named(256),
  rationale: named(2048),
  decision: named(2048),
  expires: z.string().refine(date, 'expires must be a real YYYY-MM-DD date').optional(),
  revisit: named(2048).optional()
}).strict().refine(value => value.expires || value.revisit, 'an exception needs expires or revisit')

function canonical (value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]))
  return value
}

function checkRules (input = {}, { candidateIds = [], relations = [], resolve } = {}) {
  const result = { diagnostics: [], ruleChecks: [], exceptions: [] }
  const add = (code, severity, message, location) => result.diagnostics.push({ code, severity, message, ...(location ? { location } : {}) })
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    add('INVALID_RULE_INPUT', 'error', 'Rule input must be an object')
    return result
  }
  const { rules = [], exceptions = [], stage, asOf } = input
  const candidates = new Set(candidateIds)
  const byId = new Map()
  const parse = (schema, value, location, code) => {
    const parsed = schema.safeParse(value)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) add(code, 'error', issue.message, [location, ...issue.path].join('.'))
      return null
    }
    return parsed.data
  }
  const validStage = stage === undefined || named(128).safeParse(stage).success
  const validAsOf = asOf === undefined || date(asOf)
  if (!validStage) add('INVALID_STAGE', 'error', 'Stage must be nonempty trimmed text', 'stage')
  if (!validAsOf) add('INVALID_AS_OF', 'error', 'asOf must be a real YYYY-MM-DD date', 'asOf')
  const list = (values, maximum, name) => {
    if (!Array.isArray(values) || values.length > maximum) {
      add('INVALID_RULE_COLLECTION', 'error', `${name} must be an array of at most ${maximum} records`, name)
      return []
    }
    return values
  }
  const sourceRules = list(rules, 64, 'rules')
  const parsedRules = sourceRules.map((value, index) => parse(ruleSchema, value, `rules.${index}`, 'INVALID_RULE'))
  const duplicates = new Set()
  for (const rule of parsedRules.filter(Boolean)) {
    if (byId.has(rule.id)) duplicates.add(rule.id)
    else byId.set(rule.id, rule)
  }
  byId.clear()
  for (const [index, rule] of parsedRules.entries()) {
    if (!rule) continue
    const location = `rules.${index}`
    const check = { id: rule.id, version: null, status: 'unresolved', declarationOnly: true, selectedFrom: rule.from, selectedTo: rule.to, violations: [] }
    result.ruleChecks.push(check)
    byId.set(rule.id, { rule, check })
    if (duplicates.has(rule.id)) {
      add('DUPLICATE_RULE_ID', 'error', `Rule ${rule.id} is not unique`, `${location}.id`)
      check.status = 'failed'
      continue
    }
    let invalid = false
    for (const field of ['from', 'to']) {
      if (new Set(rule[field]).size !== rule[field].length) {
        add('DUPLICATE_RULE_SELECTION', 'error', `Rule ${rule.id} repeats a ${field} source`, `${location}.${field}`)
        invalid = true
      }
      for (const source of rule[field]) {
        if (!candidates.has(source)) {
          add('RULE_SOURCE_UNAVAILABLE', 'error', `Rule ${rule.id} selects unavailable candidate source ${source}`, `${location}.${field}`)
          invalid = true
        }
      }
    }
    let governing = null
    if (candidates.has(rule.governing.source) && typeof resolve === 'function') {
      try { governing = resolve(rule.governing) } catch {}
    }
    if (!governing || governing.source !== rule.governing.source || !/^[a-f0-9]{64}$/.test(governing.sha256 || '') ||
        !Number.isSafeInteger(governing.startLine) || governing.startLine < 1 || !Number.isSafeInteger(governing.endLine) || governing.endLine < governing.startLine ||
        typeof governing.text !== 'string' || !governing.text.trim()) {
      add('RULE_GOVERNING_UNRESOLVED', 'error', `Rule ${rule.id} needs a resolvable source-backed governing excerpt`, `${location}.governing`)
      invalid = true
    } else {
      check.governing = governing
      try {
        const excerpt = Object.fromEntries(['source', 'sha256', 'startLine', 'endLine', 'text'].map(key => [key, governing[key]]))
        check.version = createHash('sha256').update(JSON.stringify(canonical({ rule: { ...rule, from: [...rule.from].sort(), to: [...rule.to].sort() }, governing: excerpt }))).digest('hex')
      } catch {
        add('RULE_GOVERNING_UNRESOLVED', 'error', `Rule ${rule.id} governing evidence must be serializable`, `${location}.governing`)
        invalid = true
      }
    }
    if (!rule.from.length || !rule.to.length) {
      add('EMPTY_RULE_SELECTION', rule.required ? 'error' : 'warning', `Rule ${rule.id} selects no ${rule.from.length ? 'target' : 'origin'} sources`, location)
      check.status = rule.required || invalid ? 'failed' : 'not-selected'
      continue
    }
    if (invalid) {
      check.status = 'failed'
      continue
    }
    check.violations = relations.filter(edge => edge.type === rule.relation && rule.from.includes(edge.from) && rule.to.includes(edge.to)).map(edge => ({ ...edge }))
    for (const edge of check.violations) add('FORBIDDEN_RELATION', 'error', `Rule ${rule.id} forbids declared ${edge.type} relation ${edge.from} -> ${edge.to}`, location)
    check.status = check.violations.length ? 'failed' : 'passed'
  }
  for (const [index, value] of list(exceptions, 128, 'exceptions').entries()) {
    const location = `exceptions.${index}`
    const record = parse(exceptionSchema, value, location, 'INVALID_EXCEPTION')
    if (!record) {
      result.exceptions.push({ index, valid: false, authority: 'caller-declared-unverified', suppressesViolation: false })
      continue
    }
    const output = { ...record, valid: true, authority: 'caller-declared-unverified', suppressesViolation: false }
    result.exceptions.push(output)
    const fail = (code, message, field) => {
      output.valid = false
      add(code, 'error', message, `${location}.${field}`)
    }
    const selected = byId.get(record.rule)
    if (!selected || duplicates.has(record.rule)) fail('EXCEPTION_RULE_UNKNOWN', `Exception needs one uniquely identified rule ${record.rule}`, 'rule')
    else {
      if (!selected.check.version || record.version !== selected.check.version) fail('EXCEPTION_VERSION_MISMATCH', `Exception does not match the resolved version of rule ${record.rule}`, 'version')
      const scope = new Set([...selected.rule.from, ...selected.rule.to])
      if (new Set(record.scope).size !== record.scope.length || record.scope.some(source => !candidates.has(source) || !scope.has(source))) fail('EXCEPTION_SCOPE_MISMATCH', 'Exception scope must be a nonempty unique subset of selected candidate sources', 'scope')
    }
    if (!validStage || !stage || record.stage !== stage) fail('EXCEPTION_STAGE_MISMATCH', 'Exception stage must match the explicit preview stage', 'stage')
    if (record.expires) {
      if (!validAsOf || !asOf) fail('EXCEPTION_DATE_UNRESOLVED', 'Expiry requires an explicit valid preview asOf date', 'expires')
      else if (record.expires < asOf) fail('EXCEPTION_EXPIRED', `Exception expired before ${asOf}`, 'expires')
    }
    add('EXCEPTION_AUTHORITY_UNVERIFIED', 'warning', `Exception for ${record.rule} is caller-declared; its decision is unverified and does not suppress violations`, location)
  }
  return result
}

module.exports = { checkRules }
