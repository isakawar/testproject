// QA Hub reporter for Playwright (@playwright/test 1.42+). No dependencies; Node 18+.
//
//   // playwright.config.ts
//   reporter: [['list'], ['./qahub-playwright-reporter.mjs', { uploadArtifacts: 'failures' }]]
//
// Environment (or the same names as options): QAHUB_URL, QAHUB_TOKEN (project API token),
// QAHUB_RUN_ID (set by the hub when it starts the pipeline), QAHUB_PLAN_ID (optional: create a run
// from this plan when the pipeline was not started by the hub).
//
// A test names its case with an annotation or a tag, and may declare a stable ID so renames keep
// the link:
//   test('Вхід за кодом', { annotation: [{ type: 'qahub', description: 'UKR-42' }, { type: 'qahub-id', description: 'login-otp' }] }, …)
//   test('Вхід за кодом', { tag: '@UKR-42' }, …)
//
// What it sends: the collected tests before anything runs (the hub's inventory and unmapped inbox),
// then every attempt of every test with its error, output and artifacts. A failing network never
// fails the test run: the reporter warns and moves on.

import fs from 'node:fs/promises'
import path from 'node:path'

const KEY_RE = /^@?([A-Za-z][A-Za-z0-9]{0,9}-\d{1,7})$/
const CASE_TYPES = new Set(['qahub', 'qahub-case', 'tms', 'case', 'testcase'])
const ID_TYPES = new Set(['qahub-id', 'test-id', 'testid', 'stable-id'])
const CHUNK = 500
const MAX_TEXT = 40_000

function env(...names) {
  for (const n of names) if (process.env[n]) return process.env[n]
  return undefined
}

function posix(p) {
  return p.split(path.sep).join('/')
}

function strip(text) {
  return typeof text === 'string' ? text.replace(/\u001b\[[0-9;]*m/g, '').slice(0, MAX_TEXT) : undefined
}

function fileSuiteOf(test) {
  for (let s = test.parent; s; s = s.parent) if (s.type === 'file') return s
  return undefined
}

function describe(test, rootDir) {
  const titles = test.titlePath()
  const keys = new Set()
  let stableId
  for (const a of test.annotations ?? []) {
    const type = String(a.type ?? '').toLowerCase()
    if (CASE_TYPES.has(type) && a.description) for (const part of String(a.description).split(/[\s,;]+/)) if (KEY_RE.test(part)) keys.add(part.replace(/^@/, '').toUpperCase())
    if (ID_TYPES.has(type) && a.description && !stableId) stableId = String(a.description).trim()
  }
  const tags = []
  for (const t of test.tags ?? []) {
    const m = KEY_RE.exec(t)
    if (m) keys.add(m[1].toUpperCase())
    else tags.push(t.replace(/^@/, ''))
  }
  const fileSuite = fileSuiteOf(test)
  return {
    stableId,
    caseKeys: [...keys],
    // The same classname and name Playwright's JUnit reporter writes, so a GitLab report of the same
    // test lands in the same inventory entry.
    classname: fileSuite?.title,
    name: titles.slice(3).join(' › '),
    titlePath: titles.slice(3),
    file: posix(path.relative(rootDir, test.location.file)),
    line: test.location.line,
    variant: titles[1] || undefined,
    tags,
  }
}

function status(result) {
  switch (result.status) {
    case 'passed': return 'passed'
    case 'failed': return 'failed'
    case 'timedOut': return 'timedOut'
    case 'interrupted': return 'interrupted'
    default: return 'skipped'
  }
}

function errorType(result) {
  const message = strip(result.error?.message ?? '') ?? ''
  return /expect\(.*?\)\./.test(message) ? 'assertion' : 'error'
}

export default class QaHubReporter {
  constructor(options = {}) {
    this.url = (options.url ?? env('QAHUB_URL') ?? '').replace(/\/+$/, '')
    this.token = options.token ?? env('QAHUB_TOKEN')
    this.runId = options.runId ?? env('QAHUB_RUN_ID')
    this.planId = options.planId ?? env('QAHUB_PLAN_ID')
    this.discover = options.discover ?? true
    this.uploadArtifacts = options.uploadArtifacts ?? env('QAHUB_UPLOAD_ARTIFACTS') ?? 'failures'
    this.forceComplete = options.completeCollection
    this.tests = new Map()
    this.pending = []
    this.disabled = !this.url || !this.token
    if (this.disabled && (this.url || this.token || this.runId)) {
      this.warn('QAHUB_URL і QAHUB_TOKEN потрібні обидва — звіт у QA Hub не надсилається')
    }
  }

  printsToStdio() {
    return false
  }

  warn(message) {
    process.stderr.write(`[qahub] ${message}\n`)
  }

  async call(method, pathname, body, headers = {}) {
    const res = await fetch(`${this.url}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, ...(body && !(body instanceof FormData) && { 'Content-Type': 'application/json' }), ...headers },
      body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : undefined
    if (!res.ok) throw new Error(`${res.status} ${data?.error?.message ?? res.statusText}`)
    return data
  }

  onBegin(config, suite) {
    if (this.disabled) return
    this.rootDir = config.rootDir
    this.shard = config.shard ?? null
    const job = env('QAHUB_JOB', 'CI_JOB_NAME', 'GITHUB_JOB', 'SYSTEM_JOBDISPLAYNAME', 'JOB_NAME') ?? 'playwright'
    this.job = this.shard ? `${job.replace(/\s+\d+\/\d+$/, '')} ${this.shard.current}/${this.shard.total}` : job
    const tests = suite.allTests()
    this.collected = tests.map(t => ({ ...describe(t, this.rootDir) }))
    this.pending.push(this.start(config))
  }

  async start(config) {
    try {
      const me = await this.call('GET', '/api/token')
      this.projectId = me.project.id
      if (!this.runId && this.planId) {
        const run = await this.call('POST', `/api/projects/${this.projectId}/runs`, {
          name: env('QAHUB_RUN_NAME') ?? `Playwright · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
          planId: this.planId,
          executionScope: 'automated',
        })
        this.runId = run.id
        this.warn(`створено запуск ${this.url}/p/${me.project.slug}/runs/${run.id}`)
      }
      if (this.discover) {
        // A collection is complete only when nothing narrowed it: no grep, shard, test list or file filter.
        const filtered = !!(config.grep && String(config.grep) !== '/.*/') || !!config.grepInvert || !!config.shard ||
          process.argv.some(a => /^--(grep|grep-invert|test-list|last-failed|only-changed)(=|$)/.test(a)) ||
          process.argv.slice(process.argv.indexOf('test') + 1).some(a => !a.startsWith('-') && !/^\d+$/.test(a))
        const variants = new Map()
        for (const t of this.collected) {
          const key = `${t.stableId ?? ''}\u0000${t.classname}\u0000${t.name}`
          const prev = variants.get(key)
          if (prev) { if (t.variant) prev.variants.push(t.variant); continue }
          variants.set(key, { ...t, variants: t.variant ? [t.variant] : [], variant: undefined })
        }
        const res = await this.call('POST', `/api/projects/${this.projectId}/automation/collections`, {
          source: 'reporter', framework: 'playwright', complete: this.forceComplete ?? !filtered,
          repository: env('QAHUB_REPOSITORY', 'CI_PROJECT_PATH', 'GITHUB_REPOSITORY', 'BUILD_REPOSITORY_NAME'),
          branch: env('QAHUB_BRANCH', 'CI_COMMIT_REF_NAME', 'GITHUB_REF_NAME', 'BRANCH_NAME', 'BUILD_SOURCEBRANCHNAME'),
          commit: env('QAHUB_COMMIT', 'CI_COMMIT_SHA', 'GITHUB_SHA', 'GIT_COMMIT', 'BUILD_SOURCEVERSION'),
          runId: this.runId,
          tests: [...variants.values()],
        })
        if (res.unmapped > 0) this.warn(`${res.unmapped} тестів без кейсу — прив’яжіть їх у QA Hub (Автоматизація)`)
        if (res.duplicates?.length) this.warn(`однакові стабільні ID: ${res.duplicates.map(d => d.stableId).join(', ')}`)
      }
    } catch (err) {
      this.warn(`не вдалося зв’язатися з QA Hub: ${err.message}`)
      this.failed = true
    }
  }

  onTestEnd(test) {
    if (!this.disabled) this.tests.set(test.id, test)
  }

  async attachment(att, failed) {
    const wanted = this.uploadArtifacts === 'all' || (this.uploadArtifacts === 'failures' && failed)
    if (att.path && wanted && this.runId) {
      try {
        const buf = await fs.readFile(att.path)
        const form = new FormData()
        form.append('file', new Blob([buf], { type: att.contentType ?? 'application/octet-stream' }), att.name + (path.extname(att.path) && !att.name.includes('.') ? path.extname(att.path) : ''))
        const up = await this.call('POST', `/api/projects/${this.projectId}/runs/${this.runId}/artifacts`, form)
        return { name: att.name, url: up.url, contentType: att.contentType, size: buf.length }
      } catch (err) {
        this.warn(`артефакт ${att.name} не завантажено: ${err.message}`)
      }
    }
    if (att.path) return { name: att.name, path: posix(path.relative(this.rootDir, att.path)), contentType: att.contentType }
    return null
  }

  async onEnd() {
    if (this.disabled) return
    await Promise.all(this.pending)
    if (this.failed) return
    if (!this.runId) {
      this.warn('QAHUB_RUN_ID не задано: інвентар надіслано, результати — ні. Запускайте з QA Hub або задайте QAHUB_PLAN_ID.')
      return
    }
    const payload = []
    for (const test of this.tests.values()) {
      const d = describe(test, this.rootDir)
      const attempts = []
      for (const result of test.results) {
        const st = status(result)
        const failed = st === 'failed' || st === 'timedOut'
        const artifacts = (await Promise.all((result.attachments ?? []).map(a => this.attachment(a, failed)))).filter(Boolean)
        attempts.push({
          status: st,
          errorType: failed ? errorType(result) : undefined,
          durationMs: result.duration,
          startedAt: result.startTime instanceof Date ? result.startTime.toISOString() : undefined,
          error: failed ? strip([result.error?.message, result.error?.stack].filter(Boolean).join('\n')) : undefined,
          stdout: strip((result.stdout ?? []).map(x => String(x)).join('')),
          artifacts,
        })
      }
      if (attempts.length) payload.push({ ...d, attempts })
    }
    const jobUrl = env('CI_JOB_URL', 'BUILD_URL') ?? (process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined)
    try {
      for (let i = 0; i < Math.max(1, payload.length); i += CHUNK) {
        const last = i + CHUNK >= payload.length
        await this.call('POST', `/api/projects/${this.projectId}/runs/${this.runId}/results`, {
          job: this.job, complete: last, expectedJobs: this.shard?.total, framework: 'playwright',
          repository: env('CI_PROJECT_PATH', 'GITHUB_REPOSITORY'), jobUrl,
          artifactBase: this.uploadArtifacts === 'none' && process.env.CI_JOB_URL ? `${process.env.CI_JOB_URL}/artifacts/file` : undefined,
          tests: payload.slice(i, i + CHUNK),
        })
      }
      process.stderr.write(`[qahub] надіслано ${payload.length} тестів у запуск ${this.runId}\n`)
    } catch (err) {
      this.warn(`результати не надіслано: ${err.message}`)
    }
  }
}
