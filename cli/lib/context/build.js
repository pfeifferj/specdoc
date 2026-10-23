'use strict'
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { readGit } = require('./git')
// Cargo manifests need a real TOML parser. smol-toml supports TOML 1.1 and
// CommonJS on the CLI's supported Node versions; the exact version is locked.
const TOML = require('smol-toml')
// Use the board's YAML parser family with CORE scalars and no executable tags.
const YAML = require('js-yaml')

const MAX_BYTES = 512 * 1024
const hash = value => createHash('sha256').update(value).digest('hex')
const posix = path.posix
const relative = value => typeof value === 'string' && value !== '' && !posix.isAbsolute(value) && value !== '..' && !value.startsWith('../') && !value.includes('\\')
const object = value => value && typeof value === 'object' && !Array.isArray(value)
const id = (kind, file, name) => `build:${kind}:${file}${name === undefined ? '' : `#${name}`}`

class Build {
  constructor (repo) {
    this.repo = path.resolve(repo)
    try { this.root = fs.realpathSync(this.repo) } catch { this.root = this.repo }
  }

  refresh () {
    this.nodes = new Map()
    this.edges = []
    this.gaps = []
    this.documents = new Map()
    this.revision = null
    this.dirty = false
    this.tracked = new Set()
    try {
      this.tracked = new Set(this.git('ls-files', '-z').split('\0').filter(Boolean))
      try { this.revision = this.git('rev-parse', 'HEAD').trim() } catch {}
      this.dirty = this.git('status', '--porcelain=v2', '-z', '--untracked-files=no').split('\0').some(Boolean)
    } catch (error) {
      this.gap('repository-unavailable', null, 'Cannot read tracked Git files in the selected repository')
      return this
    }
    const cargo = new Map()
    for (const file of [...this.tracked].sort()) {
      if (posix.basename(file) === 'Cargo.toml') {
        const doc = this.read(file)
        if (!doc) continue
        try {
          cargo.set(file, { doc, value: TOML.parse(doc.text, { integersAsBigInt: 'asNeeded' }) })
        } catch (error) {
          this.gap('invalid-manifest', file, `TOML parse failed: ${error.message}`, this.evidence(doc))
        }
      } else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) this.workflow(file)
      else if (posix.basename(file) === 'package.json') this.npm(file)
      else if (['Makefile', 'makefile', 'GNUmakefile'].includes(posix.basename(file))) this.make(file)
      else if (/\.(sh|bash)$/.test(file)) this.shell(file)
    }
    this.cargo(cargo)
    return this
  }

  git (...args) {
    return readGit(this.repo, args)
  }

  gap (code, file, message, evidence = null) {
    const item = { code, path: file, message, ...(evidence ? { evidence } : {}) }
    if (!this.gaps.some(g => JSON.stringify(g) === JSON.stringify(item))) this.gaps.push(item)
  }

  read (file) {
    if (this.documents.has(file)) return this.documents.get(file)
    if (!relative(file) || !this.tracked.has(file)) return null
    let doc = null
    try {
      const full = path.join(this.root, file)
      if (fs.realpathSync(full) !== full || !fs.lstatSync(full).isFile()) {
        this.gap('unsafe-source', file, 'Source is not a regular file without symlink components')
      } else if (fs.statSync(full).size > MAX_BYTES) {
        this.gap('source-too-large', file, `Source exceeds ${MAX_BYTES} bytes`)
      } else {
        const bytes = fs.readFileSync(full)
        doc = { path: file, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), sha256: hash(bytes) }
      }
    } catch {
      this.gap('source-unavailable', file, 'Tracked source cannot be read from the working tree')
    }
    this.documents.set(file, doc)
    return doc
  }

  evidence (doc, line = 1, endLine = doc.text.split('\n').length) {
    return { path: doc.path, line, endLine, sha256: doc.sha256, revision: this.revision, basis: 'tracked-working-tree' }
  }

  node (node) {
    if (!this.nodes.has(node.id)) this.nodes.set(node.id, node)
    return node.id
  }

  edge (from, to, relation, evidence, rest = {}) {
    this.edges.push({ from, to, relation, evidence, ...rest })
  }

  cargo (manifests) {
    const packages = new Map()
    const workspaces = new Map()
    for (const [file, { doc, value }] of manifests) {
      const evidence = [this.evidence(doc)]
      if (object(value.package) && typeof value.package.name === 'string') {
        const packageId = this.node({ id: id('cargo-package', file), kind: 'cargo-package', name: value.package.name, manifest: file, evidence })
        packages.set(file, packageId)
      }
      if (object(value.workspace)) {
        const workspaceId = this.node({ id: id('cargo-workspace', file), kind: 'cargo-workspace', manifest: file, evidence })
        workspaces.set(file, workspaceId)
      }
    }
    const membership = new Map()
    for (const [file, workspaceId] of workspaces) {
      const { doc, value } = manifests.get(file)
      const evidence = [this.evidence(doc)]
      const base = posix.dirname(file)
      const ws = value.workspace
      if (packages.has(file)) {
        this.edge(workspaceId, packages.get(file), 'declares_root_package', evidence)
        membership.set(file, file)
      }
      const members = Array.isArray(ws.members) ? ws.members : []
      const excluded = Array.isArray(ws.exclude) ? ws.exclude : []
      const exclusions = excluded.map(p => typeof p === 'string' ? this.memberPattern(p, file) : null)
      for (const member of members) {
        if (typeof member !== 'string') continue
        const patternId = this.node({ id: id('cargo-member-pattern', file, member), kind: 'cargo-member-pattern', pattern: member, evidence })
        this.edge(workspaceId, patternId, 'declares_member_pattern', evidence)
        const pattern = this.memberPattern(member, file)
        if (!pattern) continue
        let matches = 0
        for (const [target, packageId] of packages) {
          const directory = posix.relative(base, posix.dirname(target)) || '.'
          if (!pattern.test(directory)) continue
          if (exclusions.some(p => !p)) continue
          if (exclusions.some(p => p && p.test(directory))) continue
          this.edge(workspaceId, packageId, 'declares_member', evidence, { pattern: member })
          membership.set(target, file)
          matches++
        }
        if (!matches) this.gap('unresolved-member', file, `No tracked Cargo package matches declared member ${member}`, this.evidence(doc))
      }
    }
    for (const [file, packageId] of packages) {
      const { doc, value } = manifests.get(file)
      const workspace = manifests.get(membership.get(file))
      const inheritedEdition = value.package.edition?.workspace === true
      const edition = inheritedEdition ? workspace?.value.workspace?.package?.edition : value.package.edition || '2015'
      this.targets(file, doc, value, packageId, edition, inheritedEdition && workspace ? [this.evidence(workspace.doc)] : [])
      const groups = [['dependencies', value.dependencies], ['dev-dependencies', value['dev-dependencies']], ['build-dependencies', value['build-dependencies']]]
      for (const [condition, target] of Object.entries(value.target || {})) {
        for (const kind of ['dependencies', 'dev-dependencies', 'build-dependencies']) groups.push([kind, target[kind], condition])
      }
      for (const [kind, dependencies, condition] of groups) {
        for (const [name, declared] of Object.entries(dependencies || {})) {
          if (!object(declared)) continue
          let dependency = declared
          let dependencyFile = file
          let evidence = [this.evidence(doc)]
          if (declared.workspace === true) {
            const workspaceFile = membership.get(file)
            const workspace = manifests.get(workspaceFile)
            const inherited = workspace?.value.workspace?.dependencies?.[name]
            if (typeof inherited === 'string') continue
            if (!object(inherited)) {
              this.gap('unresolved-workspace-dependency', file, `Cannot resolve workspace dependency ${name}`, this.evidence(doc))
              continue
            }
            dependency = inherited
            dependencyFile = workspaceFile
            evidence = [...evidence, this.evidence(workspace.doc)]
          }
          if (typeof dependency.path !== 'string') continue
          const expected = posix.normalize(posix.join(posix.isAbsolute(dependency.path) ? dependency.path : posix.join(posix.dirname(dependencyFile), dependency.path), 'Cargo.toml'))
          const target = relative(expected) ? packages.get(expected) : null
          const targetId = target || this.node({ id: id('cargo-path', expected), kind: 'cargo-unresolved-path', manifest: expected, available: false, evidence })
          this.edge(packageId, targetId, 'declares_path_dependency', evidence, { name, dependencyKind: kind, condition: condition || null, optional: declared.optional === true, workspaceInherited: declared.workspace === true })
          if (!target) this.gap('unresolved-path-dependency', file, `Dependency ${name} targets a package outside the tracked graph: ${expected}`, this.evidence(doc))
        }
      }
    }
  }

  memberPattern (value, file) {
    value = posix.normalize(value)
    if (!relative(posix.normalize(value)) && value !== '.') {
      this.gap('unsupported-member-pattern', file, `Member pattern escapes the selected repository: ${value}`)
      return null
    }
    // Cargo globs with character classes or recursive matches need a full glob
    // engine. Keep those declarations visible instead of guessing membership.
    if (/[?\[\]{}!]/.test(value) || value.includes('**')) {
      this.gap('unsupported-member-pattern', file, `Member pattern retained without expansion: ${value}`)
      return null
    }
    return new RegExp(`^${value.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
  }

  targets (file, doc, value, packageId, edition, inheritedEvidence) {
    const base = posix.dirname(file)
    const declared = Array.isArray(value.test) ? value.test : []
    const names = new Set()
    const add = (name, targetPath, mode, table = {}) => {
      if (typeof name !== 'string' || !name || names.has(name)) return
      names.add(name)
      const target = typeof targetPath === 'string' ? posix.normalize(posix.isAbsolute(targetPath) ? targetPath : posix.join(base, targetPath)) : null
      const source = target && relative(target) ? this.read(target) : null
      const evidence = [this.evidence(doc), ...inheritedEvidence, ...(source ? [this.evidence(source)] : [])]
      const features = table['required-features']
      const validFeatures = features === undefined || Array.isArray(features) && features.every(feature => typeof feature === 'string')
      if (!validFeatures) this.gap('invalid-test-features', file, `Test target ${name} required-features is not a string list`, this.evidence(doc))
      const targetId = this.node({ id: id('cargo-test', file, name), kind: 'cargo-test-target', name, path: target, manifest: file, discovery: mode, available: !!source, harness: table.harness !== false, ...(validFeatures ? { requiredFeatures: features || [] } : {}), evidence })
      this.edge(packageId, targetId, 'declares_test_target', [this.evidence(doc), ...inheritedEvidence], { discovery: mode })
      if (!source) this.gap('unresolved-test-source', file, `Test target ${name} has no readable tracked source${target ? ` at ${target}` : ''}`, this.evidence(doc))
    }
    for (const target of declared) {
      const name = typeof target.name === 'string' ? target.name : null
      if (!name) this.gap('invalid-test-target', file, 'Explicit test target has no name', this.evidence(doc))
      const conventional = name && [`tests/${name}.rs`, `tests/${name}/main.rs`].find(p => this.tracked.has(posix.normalize(posix.join(base, p))))
      add(name, target.path || conventional, 'explicit', target)
    }
    const manualTarget = object(value.lib) || ['bin', 'example', 'test', 'bench'].some(kind => Array.isArray(value[kind]) && value[kind].length)
    if (value.package.autotests === false || (value.package.autotests !== true && edition === '2015' && manualTarget)) return
    if (edition === undefined && value.package.autotests !== true) {
      this.gap('unresolved-package-edition', file, 'Cannot establish automatic test discovery without the inherited package edition', this.evidence(doc))
      return
    }
    for (const candidate of this.tracked) {
      const local = posix.relative(base, candidate)
      const match = /^tests\/([^/]+)\.rs$/.exec(local) || /^tests\/([^/]+)\/main\.rs$/.exec(local)
      if (match) add(match[1], local, 'conventional-layout')
    }
  }

  npm (file) {
    const doc = this.read(file)
    if (!doc) return
    let value
    try { value = JSON.parse(doc.text) } catch (error) {
      this.gap('invalid-manifest', file, `JSON parse failed: ${error.message}`, this.evidence(doc))
      return
    }
    if (!object(value)) return
    const evidence = [this.evidence(doc)]
    const packageId = this.node({ id: id('npm-package', file), kind: 'npm-package', name: typeof value.name === 'string' ? value.name : null, manifest: file, evidence })
    if (!object(value.scripts)) return
    for (const [name, command] of Object.entries(value.scripts)) {
      if (typeof command !== 'string') continue
      const scriptId = this.node({ id: id('npm-script', file, name), kind: 'npm-script', name, command, cwd: posix.dirname(file), evidence })
      this.edge(packageId, scriptId, 'declares_script', evidence)
    }
  }

  workflow (file) {
    const doc = this.read(file)
    if (!doc) return
    let value
    try { value = YAML.load(doc.text, { schema: YAML.CORE_SCHEMA }) } catch (error) {
      this.gap('invalid-workflow', file, `YAML parse failed: ${error.message}`, this.evidence(doc))
      return
    }
    if (!object(value) || !object(value.jobs)) {
      this.gap('unsupported-workflow', file, 'Workflow does not declare a static jobs mapping', this.evidence(doc))
      return
    }
    const evidence = [this.evidence(doc)]
    const scalar = input => input === null || ['string', 'boolean'].includes(typeof input) || typeof input === 'number' && Number.isFinite(input)
    const merges = (input, field) => {
      if (object(input) && Object.hasOwn(input, '<<')) this.gap('unevaluated-ci-merge', file, `${field} contains YAML merge declarations that are not expanded`, this.evidence(doc))
    }
    const literal = (input, field) => {
      if (input === undefined) return undefined
      if (scalar(input)) return input
      if (Array.isArray(input) && input.every(scalar)) return input
      if (object(input) && Object.values(input).every(scalar)) return input
      this.gap('unsupported-workflow-value', file, `${field} is not a flat literal declaration and was not expanded`, this.evidence(doc))
      return undefined
    }
    const expressions = (input, field) => {
      if (typeof input === 'string' && input.includes('${{') || Array.isArray(input) && input.some(s => typeof s === 'string' && s.includes('${{')) || object(input) && Object.values(input).some(s => typeof s === 'string' && s.includes('${{'))) {
        this.gap('unevaluated-ci-expression', file, `${field} contains expressions retained literally; runtime values are unknown`, this.evidence(doc))
      }
      return input
    }
    const declaration = (input, field) => expressions(literal(input, field), field)
    const defaults = (input, field) => {
      if (input === undefined) return undefined
      if (!object(input) || !object(input.run)) {
        this.gap('unsupported-workflow-defaults', file, `${field} is not a static run-defaults mapping`, this.evidence(doc))
        return undefined
      }
      return { shell: declaration(input.run.shell, `${field}.run.shell`), workingDirectory: declaration(input.run['working-directory'], `${field}.run.working-directory`) }
    }
    merges(value, 'workflow')
    merges(value.jobs, 'workflow.jobs')
    const workflowId = this.node({ id: id('ci-workflow', file), kind: 'ci-workflow', path: file,
      name: typeof value.name === 'string' ? value.name : null, env: declaration(value.env, 'workflow.env'),
      defaultRun: defaults(value.defaults, 'workflow.defaults'), declarationOnly: true, evidence })
    const jobs = new Map()
    for (const [key, job] of Object.entries(value.jobs)) {
      if (key === '<<') continue
      if (!object(job)) {
        this.gap('unsupported-ci-job', file, `Job ${key} is not a static mapping`, this.evidence(doc))
        continue
      }
      merges(job, `job ${key}`)
      const jobId = this.node({ id: id('ci-job', file, key), kind: 'ci-job', key, workflow: file,
        name: declaration(job.name, `job ${key}.name`), runsOn: declaration(job['runs-on'], `job ${key}.runs-on`),
        condition: declaration(job.if, `job ${key}.if`), needs: declaration(job.needs, `job ${key}.needs`),
        uses: declaration(job.uses, `job ${key}.uses`), env: declaration(job.env, `job ${key}.env`),
        defaultRun: defaults(job.defaults, `job ${key}.defaults`), matrixDeclared: !!(object(job.strategy) && job.strategy.matrix !== undefined),
        declarationOnly: true, evidence })
      jobs.set(key, jobId)
      this.edge(workflowId, jobId, 'declares_job', evidence)
      if (object(job.strategy) && job.strategy.matrix !== undefined) this.gap('unevaluated-ci-matrix', file, `Job ${key} is a matrix template; expanded jobs and availability are unknown`, this.evidence(doc))
      if (job.steps !== undefined && !Array.isArray(job.steps)) this.gap('unsupported-ci-steps', file, `Job ${key} steps are not a static list`, this.evidence(doc))
      for (const [index, step] of (Array.isArray(job.steps) ? job.steps : []).entries()) {
        if (!object(step)) {
          this.gap('unsupported-ci-step', file, `Job ${key} step ${index + 1} is not a static mapping`, this.evidence(doc))
          continue
        }
        merges(step, `job ${key} step ${index + 1}`)
        const stepId = this.node({ id: id('ci-step', file, `${key}/${index + 1}`), kind: 'ci-step', job: key, index: index + 1, workflow: file,
          stepId: declaration(step.id, `job ${key} step ${index + 1}.id`), name: declaration(step.name, `job ${key} step ${index + 1}.name`),
          run: declaration(step.run, `job ${key} step ${index + 1}.run`), uses: declaration(step.uses, `job ${key} step ${index + 1}.uses`),
          condition: declaration(step.if, `job ${key} step ${index + 1}.if`), shell: declaration(step.shell, `job ${key} step ${index + 1}.shell`),
          workingDirectory: declaration(step['working-directory'], `job ${key} step ${index + 1}.working-directory`),
          env: declaration(step.env, `job ${key} step ${index + 1}.env`), with: declaration(step.with, `job ${key} step ${index + 1}.with`),
          declarationOnly: true, evidence })
        this.edge(jobId, stepId, 'declares_step', evidence)
      }
    }
    for (const [key, jobId] of jobs) {
      const job = value.jobs[key]
      if (job.needs === undefined) continue
      const needs = typeof job.needs === 'string' ? [job.needs] : Array.isArray(job.needs) ? job.needs : null
      if (!needs || needs.some(name => typeof name !== 'string')) {
        this.gap('unsupported-ci-needs', file, `Job ${key} needs are not static job identifiers`, this.evidence(doc))
        continue
      }
      for (const needed of needs) {
        if (needed.includes('${{')) continue
        if (!jobs.has(needed)) this.gap('unresolved-ci-needs', file, `Job ${key} declares unknown prerequisite ${needed}`, this.evidence(doc))
        else this.edge(jobId, jobs.get(needed), 'declares_needs', evidence, { conditional: job.if !== undefined, declarationOnly: true })
      }
    }
  }

  make (file) {
    const doc = this.read(file)
    if (!doc) return
    let definition = false
    for (const [index, line] of doc.text.split('\n').entries()) {
      if (/^(?:override\s+|export\s+)?define\b/.test(line)) definition = true
      if (definition) {
        if (/^endef\b/.test(line)) definition = false
        continue
      }
      if (/^[ \t]*(include|-include|sinclude|ifeq|ifneq|ifdef|ifndef|else|endif)\b/.test(line)) this.gap('unevaluated-make', file, 'Includes and conditional Make syntax are not evaluated', this.evidence(doc, index + 1, index + 1))
      const match = /^([^\s#:=][^:=]*?):(?![:=])(.*)$/.exec(line)
      if (!match || match[1].includes('$') || /[=\\]/.test(match[2])) continue
      const names = match[1].trim().split(/\s+/)
      if (names.some(n => !/^[A-Za-z0-9_.%/+-]+$/.test(n))) continue
      const evidence = [this.evidence(doc, index + 1, index + 1)]
      for (const name of names.filter(n => !n.startsWith('.'))) {
        this.node({ id: id('make-target', file, name), kind: name.includes('%') ? 'make-pattern-target' : 'make-target', name, makefile: file, prerequisites: match[2].split(';')[0].trim(), declarationOnly: true, cwd: posix.dirname(file), evidence })
      }
    }
  }

  shell (file) {
    const doc = this.read(file)
    if (!doc) return
    const tags = []
    const evidence = []
    for (const [index, line] of doc.text.split('\n').slice(0, 10).entries()) {
      const match = /^\s*#\s*tags:\s*(.*)$/.exec(line)
      if (!match) continue
      tags.push(...match[1].split(/[,\s]+/).filter(Boolean))
      evidence.push(this.evidence(doc, index + 1, index + 1))
    }
    if (!tags.length && !/(^|\/)(test|tests)\//.test(file)) return
    this.node({ id: id('shell-test', file), kind: 'shell-test', path: file, tags: [...new Set(tags)], evidence: evidence.length ? evidence : [this.evidence(doc)] })
  }

  packet () {
    return {
      schemaVersion: 1, repository: this.repo, revision: this.revision, dirty: this.dirty, trackedOnly: true,
      nodes: [...this.nodes.values()], edges: this.edges, gaps: this.gaps,
      limits: [
        'Declarations from tracked working-tree files only; no command is executed and no check result is established.',
        'Cargo registry resolution, implicit workspace membership, feature/cfg activation, unit tests and build-script effects are not resolved.',
        'Workspace member patterns expand literal paths and single-star wildcards only; other patterns remain explicit gaps.',
        'Make includes, variables, recipes, conditions and generated targets are not evaluated; a declared target may be unavailable or have side effects.',
        'npm scripts remain literal declarations; lifecycle hooks and script call chains are not resolved.',
        'Shell tags are labels from the first ten lines; they do not establish prerequisites, isolation or requirement coverage.',
        'CI jobs, steps, needs, run/uses, environments and run defaults are literal declarations; expressions, matrices, triggers, reusable workflows and actions are not evaluated or executed.',
        'Workflow, job and step environment/default declarations remain separate; no effective runtime environment, runner availability or successful check is inferred.',
        'Manifest and workflow evidence spans the complete parsed document; line spans identify source evidence, not TOML, JSON or YAML AST locations.'
      ]
    }
  }

  neighbors (nodeId) {
    const node = this.nodes.get(nodeId)
    if (!node) return null
    return { node, edges: this.edges.filter(e => e.from === nodeId || e.to === nodeId) }
  }
}

module.exports = { Build }
