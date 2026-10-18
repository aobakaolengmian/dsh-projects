/**
 * Host-half tests for @wxysskd/dsh-projects.
 *
 * These drive the real plugin entry (`apply`) against a fake Cordis context and
 * a fake `webServer` that records the registered exact routes, then invoke the
 * route handlers with fake `IncomingMessage`/`ServerResponse` objects. Durable
 * state is redirected per test through a temporary $DSH_HOME.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
import { test } from 'node:test'

import { apply } from '../index.js'

const ROUTES = Object.freeze({
  state: '/dsh-projects/state',
  health: '/dsh-projects/health',
  mutate: '/dsh-projects/mutate',
  cwd: '/dsh-projects/cwd',
  purge: '/dsh-projects/purge',
  empty: '/dsh-projects/empty-sessions',
})

const POST_HEADERS = Object.freeze({ 'content-type': 'application/json', 'x-dsh-projects': '1' })
const EMPTY_STATE = Object.freeze({ version: 1, projects: [], assignments: {}, sessionCwd: {} })

/* ------------------------------------------------------------------------- *
 * Fake host: cordis context, web server, request/response
 * ------------------------------------------------------------------------- */

function createHarness(services = {}) {
  const routes = new Map()
  const cleanups = []

  const webServer = {
    register(route) {
      assert.equal(route.kind, 'exact', 'only exact-path routes are registered')
      assert.equal(typeof route.handler, 'function', `route ${route.path} has a handler`)
      assert.equal(routes.has(route.path), false, `route ${route.path} is registered once`)
      routes.set(route.path, route.handler)
      return () => {
        routes.delete(route.path)
      }
    },
  }

  const host = {
    webServer,
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') cleanups.push(dispose)
      return dispose
    },
    get(serviceName) {
      return services[serviceName]
    },
  }

  const ctx = {
    webServer,
    inject(dependencies, callback) {
      for (const dependency of dependencies) {
        assert.equal(dependency, 'webServer', 'the plugin only injects webServer')
      }
      callback(host)
    },
    effect(callback) {
      return host.effect(callback)
    },
    get(serviceName) {
      return services[serviceName]
    },
  }

  apply(ctx)

  return {
    routes,
    dispose() {
      while (cleanups.length > 0) {
        const dispose = cleanups.pop()
        try {
          dispose()
        } catch {
          // Disposal must stay idempotent for the tests.
        }
      }
    },
  }
}

function createRequest({ method = 'GET', headers = {}, body, declareContentLength = true } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)])
  request.method = method
  request.headers = { ...headers }
  if (body !== undefined && declareContentLength) {
    request.headers['content-length'] = String(Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body))
  }
  return request
}

function createResponse() {
  const response = {
    statusCode: 200,
    headers: {},
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status, headers = {}) {
      response.statusCode = status
      response.headersSent = true
      for (const [key, value] of Object.entries(headers)) response.headers[key.toLowerCase()] = value
      return response
    },
    setHeader(name, value) {
      response.headers[String(name).toLowerCase()] = value
    },
    end(chunk) {
      if (chunk !== undefined && chunk !== null) {
        response.body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      }
      response.writableEnded = true
    },
  }
  return response
}

async function call(harness, path, options = {}) {
  const { method = 'GET', headers = {}, body, declareContentLength = true } = options
  const handler = harness.routes.get(path)
  assert.equal(typeof handler, 'function', `route ${path} is registered`)
  let payload
  if (body !== undefined) payload = typeof body === 'string' ? body : JSON.stringify(body)
  const request = createRequest({ method, headers, body: payload, declareContentLength })
  const response = createResponse()
  await handler(request, response)
  return {
    status: response.statusCode,
    headers: response.headers,
    body: response.body === '' ? null : JSON.parse(response.body),
  }
}

/* ------------------------------------------------------------------------- *
 * Test environment helpers
 * ------------------------------------------------------------------------- */

/** Isolated $DSH_HOME for one test, restored and removed afterwards. */
function createHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-projects-test-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

function storageFileOf(home) {
  return join(home, 'storages', 'dsh-projects.json')
}

function seedStorage(home, content) {
  mkdirSync(join(home, 'storages'), { recursive: true })
  writeFileSync(storageFileOf(home), typeof content === 'string' ? content : JSON.stringify(content))
}

async function createProject(harness, payload = {}) {
  const response = await call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: POST_HEADERS,
    body: { action: 'project.create', payload: { name: 'Alpha', ...payload } },
  })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  return response.body.result.project
}

function assignSession(harness, sessionId, projectId) {
  return call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: POST_HEADERS,
    body: { action: 'session.assign', payload: { sessionId, projectId } },
  })
}

function updateProject(harness, payload) {
  return call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: POST_HEADERS,
    body: { action: 'project.update', payload },
  })
}

function deleteProject(harness, projectId) {
  return call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: POST_HEADERS,
    body: { action: 'project.delete', payload: { projectId } },
  })
}

function changeDirectory(harness, body) {
  return call(harness, ROUTES.cwd, { method: 'POST', headers: POST_HEADERS, body })
}

function getState(harness) {
  return call(harness, ROUTES.state)
}

async function readStateWithFreshHarness(home) {
  const harness = createHarness()
  try {
    return (await getState(harness)).body.state
  } finally {
    harness.dispose()
  }
}

/* ------------------------------------------------------------------------- *
 * Mounting
 * ------------------------------------------------------------------------- */

test('apply registers the documented exact routes and disposes them', (t) => {
  createHome(t)
  const harness = createHarness()
  assert.deepEqual(
    [...harness.routes.keys()].sort(),
    [ROUTES.cwd, ROUTES.empty, ROUTES.health, ROUTES.mutate, ROUTES.purge, ROUTES.state].sort(),
  )
  harness.dispose()
  assert.equal(harness.routes.size, 0)
})

test('apply only mounts after the webServer service is injected', (t) => {
  createHome(t)
  const calls = []
  const ctx = {
    inject(dependencies, callback) {
      calls.push(dependencies)
      callback({
        webServer: {
          register(route) {
            calls.push(route.path)
            return () => {}
          },
        },
        effect(callback2) {
          callback2()
        },
      })
    },
    get() {
      return undefined
    },
  }
  apply(ctx)
  assert.deepEqual(calls[0], ['webServer'])
  assert.equal(calls.length, 7)
})

/* ------------------------------------------------------------------------- *
 * GET state
 * ------------------------------------------------------------------------- */

test('GET /dsh-projects/state returns empty ProjectData on first run', async (t) => {
  const home = createHome(t)
  const harness = createHarness()
  t.after(() => harness.dispose())

  const response = await getState(harness)
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(response.body, { ok: true, state: EMPTY_STATE })
  assert.equal(existsSync(storageFileOf(home)), false, 'reading state must not create the storage file')
})

/* ------------------------------------------------------------------------- *
 * project.create
 * ------------------------------------------------------------------------- */

test('project.create persists a normalized project and returns result.project', async (t) => {
  const home = createHome(t)
  const harness = createHarness()
  t.after(() => harness.dispose())

  const response = await call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: POST_HEADERS,
    body: {
      action: 'project.create',
      payload: {
        name: '  Alpha  ',
        color: 'green',
        directories: ['/tmp/alpha/', '/tmp/alpha', '/tmp/beta'],
      },
    },
  })

  assert.equal(response.status, 200)
  const { ok, state, result } = response.body
  assert.equal(ok, true)
  assert.equal(state.projects.length, 1)
  const project = state.projects[0]
  assert.match(project.id, /^project-[0-9a-f-]{36}$/)
  assert.equal(project.name, 'Alpha')
  assert.equal(project.color, 'green')
  assert.deepEqual(project.directories, ['/tmp/alpha', '/tmp/beta'])
  assert.equal(project.defaultDirectory, '/tmp/alpha', 'first directory becomes the default')
  assert.ok(Number.isFinite(Date.parse(project.createdAt)))
  assert.ok(Number.isFinite(Date.parse(project.updatedAt)))
  assert.deepEqual(result.project, project)
  assert.deepEqual(state.assignments, {})
  assert.deepEqual(JSON.parse(readFileSync(storageFileOf(home), 'utf8')), state)
})

test('project.create defaults color/directories and rejects invalid input', async (t) => {
  createHome(t)
  const harness = createHarness()
  t.after(() => harness.dispose())

  const created = await createProject(harness)
  assert.equal(created.color, 'blue')
  assert.deepEqual(created.directories, [])
  assert.equal(Object.hasOwn(created, 'defaultDirectory'), false)

  const cases = [
    [{ name: '' }, 'invalid-name'],
    [{ name: 42 }, 'invalid-name'],
    [{ name: 'x', color: 'red' }, 'invalid-color'],
    [{ name: 'x', directories: ['relative/path'] }, 'invalid-directory'],
    [{ name: 'x', directories: '/tmp' }, 'invalid-directories'],
    [{ name: 'x', directories: ['/tmp/a', 7] }, 'invalid-directory'],
  ]
  for (const [payload, code] of cases) {
    const response = await call(harness, ROUTES.mutate, {
      method: 'POST',
      headers: POST_HEADERS,
      body: { action: 'project.create', payload },
    })
    assert.equal(response.status, 400, `payload ${JSON.stringify(payload)} should be rejected`)
    assert.equal(response.body.ok, false)
    assert.equal(response.body.error.code, code)
    assert.equal(typeof response.body.error.message, 'string')
  }

  const state = (await getState(harness)).body.state
  assert.equal(state.projects.length, 1, 'rejected mutations leave the state untouched')
})

/* ------------------------------------------------------------------------- *
 * POST guards
 * ------------------------------------------------------------------------- */

test('POST routes require JSON content type and the x-dsh-projects header', async (t) => {
  createHome(t)
  const harness = createHarness()
  t.after(() => harness.dispose())
  const body = { action: 'project.create', payload: { name: 'Guarded' } }

  const noHeaders = await call(harness, ROUTES.mutate, { method: 'POST', body })
  assert.equal(noHeaders.status, 415)
  assert.equal(noHeaders.body.error.code, 'unsupported-media-type')

  const wrongType = await call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', 'x-dsh-projects': '1' },
    body,
  })
  assert.equal(wrongType.status, 415)

  const missingHeader = await call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  assert.equal(missingHeader.status, 403)
  assert.equal(missingHeader.body.error.code, 'forbidden')

  const wrongHeader = await call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-projects': '0' },
    body,
  })
  assert.equal(wrongHeader.status, 403)

  const accepted = await call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', 'x-dsh-projects': '1' },
    body,
  })
  assert.equal(accepted.status, 200)
  assert.equal(accepted.body.state.projects.length, 1)

  const cwdGuarded = await call(harness, ROUTES.cwd, {
    method: 'POST',
    body: { sessionId: 's1', path: '/tmp' },
  })
  assert.equal(cwdGuarded.status, 415)
  assert.equal(cwdGuarded.body.error.code, 'unsupported-media-type')
})

test('POST mutate enforces the 64KiB limit and validates the envelope', async (t) => {
  createHome(t)
  const harness = createHarness()
  t.after(() => harness.dispose())
  const huge = { action: 'project.create', payload: { name: 'x'.repeat(70 * 1024) } }

  const declaredTooLarge = await call(harness, ROUTES.mutate, { method: 'POST', headers: POST_HEADERS, body: huge })
  assert.equal(declaredTooLarge.status, 413)
  assert.equal(declaredTooLarge.body.error.code, 'payload-too-large')

  const streamedTooLarge = await call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: POST_HEADERS,
    body: huge,
    declareContentLength: false,
  })
  assert.equal(streamedTooLarge.status, 413)
  assert.equal(streamedTooLarge.body.error.code, 'payload-too-large')

  const invalidJson = await call(harness, ROUTES.mutate, { method: 'POST', headers: POST_HEADERS, body: '{not json' })
  assert.equal(invalidJson.status, 400)
  assert.equal(invalidJson.body.error.code, 'invalid-json')

  const arrayBody = await call(harness, ROUTES.mutate, { method: 'POST', headers: POST_HEADERS, body: '[1,2]' })
  assert.equal(arrayBody.status, 400)
  assert.equal(arrayBody.body.error.code, 'invalid-request')

  const missingAction = await call(harness, ROUTES.mutate, { method: 'POST', headers: POST_HEADERS, body: { payload: {} } })
  assert.equal(missingAction.status, 400)
  assert.equal(missingAction.body.error.code, 'invalid-action')

  const unknownAction = await call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: POST_HEADERS,
    body: { action: 'project.archive', payload: {} },
  })
  assert.equal(unknownAction.status, 400)
  assert.equal(unknownAction.body.error.code, 'unknown-action')

  const badPayload = await call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: POST_HEADERS,
    body: { action: 'project.create', payload: 5 },
  })
  assert.equal(badPayload.status, 400)
  assert.equal(badPayload.body.error.code, 'invalid-payload')
})

/* ------------------------------------------------------------------------- *
 * project.update / project.delete / session.assign
 * ------------------------------------------------------------------------- */

test('project.update patches fields, keeps invariants and rejects bad patches', async (t) => {
  createHome(t)
  const harness = createHarness()
  t.after(() => harness.dispose())
  const project = await createProject(harness, { name: 'Alpha', directories: ['/tmp/a'], color: 'blue' })

  const renamed = await updateProject(harness, {
    projectId: project.id,
    name: ' Beta ',
    color: 'purple',
    directories: ['/tmp/b', '/tmp/c'],
    defaultDirectory: '/tmp/c',
  })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.body.ok, true)
  assert.equal(renamed.body.result, null)
  const updated = renamed.body.state.projects[0]
  assert.equal(updated.id, project.id)
  assert.equal(updated.name, 'Beta')
  assert.equal(updated.color, 'purple')
  assert.deepEqual(updated.directories, ['/tmp/b', '/tmp/c'])
  assert.equal(updated.defaultDirectory, '/tmp/c')
  assert.equal(updated.createdAt, project.createdAt)
  assert.ok(Date.parse(updated.updatedAt) >= Date.parse(project.updatedAt))

  const defaultOnly = await updateProject(harness, { projectId: project.id, defaultDirectory: '/tmp/b' })
  assert.equal(defaultOnly.body.state.projects[0].defaultDirectory, '/tmp/b')

  const noDirectories = await updateProject(harness, { projectId: project.id, directories: [] })
  assert.deepEqual(noDirectories.body.state.projects[0].directories, [])
  assert.equal(Object.hasOwn(noDirectories.body.state.projects[0], 'defaultDirectory'), false)

  const cases = [
    [{ projectId: 'project-missing', name: 'x' }, 404, 'project/not-found'],
    [{ projectId: project.id, name: '' }, 400, 'invalid-name'],
    [{ projectId: project.id, color: 'red' }, 400, 'invalid-color'],
    [{ projectId: project.id, directories: ['relative'] }, 400, 'invalid-directory'],
    [{ projectId: project.id, directories: ['/tmp/a'], defaultDirectory: '/tmp/elsewhere' }, 400, 'invalid-default-directory'],
    [{}, 400, 'invalid-request'],
  ]
  for (const [payload, status, code] of cases) {
    const response = await updateProject(harness, payload)
    assert.equal(response.status, status, `payload ${JSON.stringify(payload)}`)
    assert.equal(response.body.error.code, code)
  }
})

test('project.delete removes the project and its explicit assignments', async (t) => {
  createHome(t)
  const harness = createHarness()
  t.after(() => harness.dispose())
  const first = await createProject(harness, { name: 'First' })
  const second = await createProject(harness, { name: 'Second' })
  await assignSession(harness, 'session-1', first.id)

  const deletion = await deleteProject(harness, first.id)
  assert.equal(deletion.status, 200)
  assert.equal(deletion.body.ok, true)
  assert.equal(deletion.body.result, null)
  assert.deepEqual(deletion.body.state.projects.map((project) => project.id), [second.id])
  assert.equal(Object.hasOwn(deletion.body.state.assignments, 'session-1'), false)

  const again = await deleteProject(harness, first.id)
  assert.equal(again.status, 404)
  assert.equal(again.body.error.code, 'project/not-found')

  const missing = await deleteProject(harness, undefined)
  assert.equal(missing.status, 400)
  assert.equal(missing.body.error.code, 'invalid-request')
})

test('session.assign records explicit assignments, including null', async (t) => {
  createHome(t)
  const harness = createHarness()
  t.after(() => harness.dispose())
  const project = await createProject(harness)

  const assigned = await assignSession(harness, 'session-1', project.id)
  assert.equal(assigned.status, 200)
  assert.equal(assigned.body.result, null)
  assert.deepEqual(assigned.body.state.assignments, { 'session-1': project.id })

  const cleared = await assignSession(harness, 'session-1', null)
  assert.equal(cleared.status, 200)
  assert.equal(Object.hasOwn(cleared.body.state.assignments, 'session-1'), true)
  assert.equal(cleared.body.state.assignments['session-1'], null, 'null means explicitly ungrouped')

  const unknownProject = await assignSession(harness, 'session-1', 'project-nope')
  assert.equal(unknownProject.status, 404)
  assert.equal(unknownProject.body.error.code, 'project/not-found')

  const missingProjectId = await call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: POST_HEADERS,
    body: { action: 'session.assign', payload: { sessionId: 'session-1' } },
  })
  assert.equal(missingProjectId.status, 400)
  assert.equal(missingProjectId.body.error.code, 'invalid-project-id')

  const badSession = await assignSession(harness, '', null)
  assert.equal(badSession.status, 400)
  assert.equal(badSession.body.error.code, 'invalid-request')
})

/* ------------------------------------------------------------------------- *
 * Durable state
 * ------------------------------------------------------------------------- */

test('state persists across a plugin reload', async (t) => {
  const home = createHome(t)
  const first = createHarness()
  t.after(() => first.dispose())
  const project = await createProject(first, { name: 'Durable', directories: ['/tmp/durable'], color: 'teal' })
  await assignSession(first, 'session-x', project.id)
  first.dispose()

  const second = createHarness()
  t.after(() => second.dispose())
  const response = await getState(second)
  assert.equal(response.status, 200)
  assert.equal(response.body.state.projects.length, 1)
  assert.equal(response.body.state.projects[0].name, 'Durable')
  assert.equal(response.body.state.projects[0].color, 'teal')
  assert.deepEqual(response.body.state.projects[0].directories, ['/tmp/durable'])
  assert.deepEqual(response.body.state.assignments, { 'session-x': project.id })
  assert.deepEqual(JSON.parse(readFileSync(storageFileOf(home), 'utf8')), response.body.state)
})

test('corrupt or foreign storage falls back to a valid empty state', async (t) => {
  const home = createHome(t)

  seedStorage(home, '{ this is not json')
  assert.deepEqual(await readStateWithFreshHarness(home), EMPTY_STATE)

  seedStorage(home, { version: 2, projects: [], assignments: {}, sessionCwd: {} })
  assert.deepEqual(await readStateWithFreshHarness(home), EMPTY_STATE)

  seedStorage(home, [])
  assert.deepEqual(await readStateWithFreshHarness(home), EMPTY_STATE)

  const now = new Date().toISOString()
  seedStorage(home, {
    version: 1,
    projects: [
      { id: 'project-keep', name: ' Keep ', color: 'teal', directories: ['/tmp/keep/'], createdAt: now, updatedAt: now },
      { id: 'project-broken' },
      { bogus: true },
    ],
    assignments: { 'session-1': 'project-keep', 'session-2': 42 },
    sessionCwd: { 'session-3': '/tmp/three', 'session-4': 9 },
  })
  const repaired = await readStateWithFreshHarness(home)
  assert.equal(repaired.projects.length, 1)
  assert.equal(repaired.projects[0].id, 'project-keep')
  assert.equal(repaired.projects[0].name, 'Keep')
  assert.deepEqual(repaired.projects[0].directories, ['/tmp/keep'])
  assert.deepEqual(repaired.assignments, { 'session-1': 'project-keep' })
  assert.deepEqual(repaired.sessionCwd, { 'session-3': '/tmp/three' })
})

test('atomic writes leave no temporary files behind', async (t) => {
  const home = createHome(t)
  const harness = createHarness()
  t.after(() => harness.dispose())
  await createProject(harness)
  assert.deepEqual(readdirSync(join(home, 'storages')).sort(), ['dsh-projects.json'])
})

test('a failed persistence write leaves the in-memory state unchanged', async (t) => {
  const home = createHome(t)
  // A regular file where the `storages` directory must go makes every write fail.
  writeFileSync(join(home, 'storages'), 'blocked')
  const harness = createHarness()
  t.after(() => harness.dispose())

  const mutation = await call(harness, ROUTES.mutate, {
    method: 'POST',
    headers: POST_HEADERS,
    body: { action: 'project.create', payload: { name: 'Never persisted' } },
  })
  assert.equal(mutation.status, 500)
  assert.equal(mutation.body.ok, false)
  assert.equal(mutation.body.error.code, 'storage/write-failed')

  const state = (await getState(harness)).body.state
  assert.deepEqual(state, EMPTY_STATE, 'rejected write must not be committed to memory')
})

/* ------------------------------------------------------------------------- *
 * GET health
 * ------------------------------------------------------------------------- */

test('GET /dsh-projects/health reports storage, counts and host services', async (t) => {
  const home = createHome(t)
  const services = {
    sessionController: { resolveAgent: async () => ({ agent: { id: 'agent' } }) },
    workingDirectory: { set: async () => '/tmp' },
  }
  const harness = createHarness(services)
  t.after(() => harness.dispose())
  await createProject(harness)

  const response = await call(harness, ROUTES.health)
  assert.equal(response.status, 200)
  const body = response.body
  assert.equal(body.ok, true)
  assert.equal(body.plugin, '@wxysskd/dsh-projects')
  assert.equal(body.version, 1)
  assert.deepEqual(body.routes, [
    'GET /dsh-projects/state',
    'GET /dsh-projects/health',
    'POST /dsh-projects/mutate',
    'POST /dsh-projects/cwd',
    'POST /dsh-projects/purge',
    'GET /dsh-projects/empty-sessions',
  ])
  assert.equal(body.storage.path, storageFileOf(home))
  assert.equal(body.storage.exists, true)
  assert.deepEqual(body.counts, { projects: 1, assignments: 0, sessionCwd: 0 })
  assert.deepEqual(body.services, { sessionController: true, workingDirectory: true })
  assert.ok(Number.isFinite(Date.parse(body.time)))

  const bare = createHarness()
  t.after(() => bare.dispose())
  const bareHealth = await call(bare, ROUTES.health)
  assert.deepEqual(bareHealth.body.services, { sessionController: false, workingDirectory: false })
})

/* ------------------------------------------------------------------------- *
 * POST cwd
 * ------------------------------------------------------------------------- */

test('POST /dsh-projects/cwd changes the agent cwd and records sessionCwd', async (t) => {
  const home = createHome(t)
  const calls = []
  const agent = { id: 'agent-1' }
  const harness = createHarness({
    sessionController: {
      async resolveAgent(sessionId) {
        calls.push(['resolveAgent', sessionId])
        return { agent }
      },
    },
    workingDirectory: {
      async set(target, path) {
        calls.push(['set', target, path])
        return '/canonical/project'
      },
    },
  })
  t.after(() => harness.dispose())

  const response = await changeDirectory(harness, { sessionId: 'session-1', path: '/Users/me/project/' })
  assert.equal(response.status, 200)
  assert.equal(response.body.ok, true)
  assert.equal(response.body.cwd, '/canonical/project')
  assert.equal(response.body.state.sessionCwd['session-1'], '/canonical/project')
  assert.deepEqual(calls, [
    ['resolveAgent', 'session-1'],
    ['set', agent, '/Users/me/project'],
  ])
  assert.equal(
    JSON.parse(readFileSync(storageFileOf(home), 'utf8')).sessionCwd['session-1'],
    '/canonical/project',
    'the recorded cwd is durable',
  )
})

test('POST /dsh-projects/cwd maps resolveAgent failures to 409', async (t) => {
  createHome(t)
  const reported = createHarness({
    sessionController: {
      async resolveAgent() {
        return { error: { code: 'session/not-found', message: 'no live agent' } }
      },
    },
    workingDirectory: { set: async () => '/tmp' },
  })
  t.after(() => reported.dispose())
  const reportedResponse = await changeDirectory(reported, { sessionId: 'session-1', path: '/tmp' })
  assert.equal(reportedResponse.status, 409)
  assert.equal(reportedResponse.body.error.code, 'session/not-found')
  assert.equal(reportedResponse.body.error.message, 'no live agent')

  const throwing = createHarness({
    sessionController: {
      async resolveAgent() {
        throw new Error('resolve exploded')
      },
    },
    workingDirectory: { set: async () => '/tmp' },
  })
  t.after(() => throwing.dispose())
  const throwingResponse = await changeDirectory(throwing, { sessionId: 'session-1', path: '/tmp' })
  assert.equal(throwingResponse.status, 409)
  assert.equal(throwingResponse.body.error.code, 'session/not-found')
  assert.equal(throwingResponse.body.error.message, 'resolve exploded')
})

test('POST /dsh-projects/cwd returns 400 when workingDirectory.set fails', async (t) => {
  createHome(t)
  const harness = createHarness({
    sessionController: { resolveAgent: async () => ({ agent: { id: 'agent-1' } }) },
    workingDirectory: {
      async set() {
        throw new Error('cannot change directory')
      },
    },
  })
  t.after(() => harness.dispose())

  const response = await changeDirectory(harness, { sessionId: 'session-1', path: '/tmp/other' })
  assert.equal(response.status, 400)
  assert.equal(response.body.ok, false)
  assert.equal(response.body.error.code, 'cwd/failed')
  assert.match(response.body.error.message, /cannot change directory/)

  const state = (await getState(harness)).body.state
  assert.deepEqual(state.sessionCwd, {}, 'a failed cwd change is not recorded')
})

test('POST /dsh-projects/cwd returns 501 when host services are absent', async (t) => {
  createHome(t)
  const bare = createHarness()
  t.after(() => bare.dispose())
  const bareResponse = await changeDirectory(bare, { sessionId: 'session-1', path: '/tmp' })
  assert.equal(bareResponse.status, 501)
  assert.equal(bareResponse.body.ok, false)
  assert.equal(bareResponse.body.error.code, 'service/unavailable')
  assert.match(bareResponse.body.error.message, /sessionController\.resolveAgent/)
  assert.match(bareResponse.body.error.message, /workingDirectory\.set/)

  const partial = createHarness({ sessionController: { resolveAgent: async () => ({ agent: {} }) } })
  t.after(() => partial.dispose())
  const partialResponse = await changeDirectory(partial, { sessionId: 'session-1', path: '/tmp' })
  assert.equal(partialResponse.status, 501)
  assert.match(partialResponse.body.error.message, /workingDirectory\.set/)
  assert.doesNotMatch(partialResponse.body.error.message, /sessionController\.resolveAgent/)
})

test('POST /dsh-projects/cwd validates its body', async (t) => {
  createHome(t)
  const harness = createHarness({
    sessionController: { resolveAgent: async () => ({ agent: { id: 'agent-1' } }) },
    workingDirectory: { set: async () => '/tmp' },
  })
  t.after(() => harness.dispose())

  const cases = [
    [{ path: '/tmp' }, 'invalid-request'],
    [{ sessionId: 'session-1' }, 'invalid-path'],
    [{ sessionId: 'session-1', path: 'relative/dir' }, 'invalid-path'],
    [{ sessionId: 'session-1', path: '' }, 'invalid-path'],
    [{ sessionId: 7, path: '/tmp' }, 'invalid-request'],
    [{ sessionId: '', path: '/tmp' }, 'invalid-request'],
  ]
  for (const [body, code] of cases) {
    const response = await changeDirectory(harness, body)
    assert.equal(response.status, 400, `body ${JSON.stringify(body)}`)
    assert.equal(response.body.error.code, code)
  }
})

test('POST /dsh-projects/cwd guards concurrent changes for one session', async (t) => {
  createHome(t)
  let releaseSet
  const setGate = new Promise((resolve) => {
    releaseSet = resolve
  })
  let setStarted
  const started = new Promise((resolve) => {
    setStarted = resolve
  })
  const harness = createHarness({
    sessionController: { resolveAgent: async () => ({ agent: { id: 'agent-1' } }) },
    workingDirectory: {
      async set() {
        setStarted()
        await setGate
        return '/canonical'
      },
    },
  })
  t.after(() => harness.dispose())

  const first = changeDirectory(harness, { sessionId: 'session-1', path: '/tmp/one' })
  await started
  const second = await changeDirectory(harness, { sessionId: 'session-1', path: '/tmp/two' })
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'cwd/busy')
  releaseSet()
  const firstResponse = await first
  assert.equal(firstResponse.status, 200)
  assert.equal(firstResponse.body.cwd, '/canonical')
})

/* ------------------------------------------------------------------------- *
 * Method dispatch
 * ------------------------------------------------------------------------- */

test('routes reject unsupported methods with 405 and an Allow header', async (t) => {
  createHome(t)
  const harness = createHarness()
  t.after(() => harness.dispose())

  const postState = await call(harness, ROUTES.state, { method: 'POST', headers: POST_HEADERS, body: '{}' })
  assert.equal(postState.status, 405)
  assert.equal(postState.headers.allow, 'GET')
  assert.equal(postState.body.error.code, 'method-not-allowed')

  const getMutate = await call(harness, ROUTES.mutate)
  assert.equal(getMutate.status, 405)
  assert.equal(getMutate.headers.allow, 'POST')

  const postHealth = await call(harness, ROUTES.health, { method: 'POST', headers: POST_HEADERS, body: '{}' })
  assert.equal(postHealth.status, 405)
  assert.equal(postHealth.headers.allow, 'GET')

  const putCwd = await call(harness, ROUTES.cwd, { method: 'PUT' })
  assert.equal(putCwd.status, 405)
  assert.equal(putCwd.headers.allow, 'POST')
})

/* ------------------------------------------------------------------------- *
 * Blank-session purge
 * ------------------------------------------------------------------------- */

function seedSessionLog(home, workspaceKey, sessionId, frames) {
  const directory = join(home, 'sessions', workspaceKey, sessionId)
  mkdirSync(directory, { recursive: true })
  const parts = frames === undefined
    ? [Buffer.from('fake-log')]
    : frames.map((line) => zstdCompressSync(Buffer.from(`${JSON.stringify(line)}\n`)))
  writeFileSync(join(directory, 'session.v4.jsonl.zstd'), Buffer.concat(parts))
  return directory
}

function headerLine(sessionId) {
  return { type: 'session', version: 4, id: sessionId, createdAt: Date.now(), cwd: '/tmp/work', isSeeded: false }
}

function purge(harness, body) {
  return call(harness, ROUTES.purge, { method: 'POST', headers: POST_HEADERS, body })
}

test('purge removes only blank, idle, cold session directories', async (t) => {
  const home = createHome(t)
  const blankDir = seedSessionLog(home, '--work-a--', 'session-blank-cold')
  const liveDir = seedSessionLog(home, '--work-a--', 'session-blank-live')
  const contentDir = seedSessionLog(home, '--work-a--', 'session-with-content')
  const runningDir = seedSessionLog(home, '--work-a--', 'session-blank-running')
  const services = {
    sessionController: {
      async list() {
        return {
          items: [
            { sessionId: 'session-blank-cold', blank: true, running: false },
            { sessionId: 'session-blank-live', blank: true, running: false },
            { sessionId: 'session-with-content', blank: false, running: false },
            { sessionId: 'session-blank-running', blank: true, running: true },
          ],
        }
      },
    },
    sessions: {
      get(sessionId) {
        return sessionId === 'session-blank-live' ? { id: sessionId } : undefined
      },
    },
  }
  const harness = createHarness(services)
  t.after(() => harness.dispose())

  const response = await purge(harness, { sessionIds: ['session-blank-cold', 'session-blank-live', 'session-with-content', 'session-blank-running', 'session-missing'] })
  assert.equal(response.status, 200, JSON.stringify(response.body))
  assert.deepEqual(response.body.result.purged, ['session-blank-cold'])
  const reasons = Object.fromEntries(response.body.result.skipped.map((entry) => [entry.sessionId, entry.reason]))
  assert.equal(reasons['session-blank-live'], 'live')
  assert.equal(reasons['session-with-content'], 'not-empty')
  assert.equal(reasons['session-blank-running'], 'running')
  assert.equal(reasons['session-missing'], 'not-found')
  assert.equal(existsSync(blankDir), false)
  for (const directory of [liveDir, contentDir, runningDir]) assert.equal(existsSync(directory), true)
})

test('purge reports not-materialized blanks and validates its request', async (t) => {
  createHome(t)
  const harness = createHarness({
    sessionController: {
      async list() {
        return { items: [{ sessionId: 'session-unmaterialized', blank: true, running: false }] }
      },
    },
    sessions: { get: () => undefined },
  })
  t.after(() => harness.dispose())

  const ok = await purge(harness, { sessionIds: ['session-unmaterialized'] })
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body.result.purged, [])
  assert.equal(ok.body.result.skipped[0].reason, 'not-materialized')

  const empty = await purge(harness, { sessionIds: [] })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.error.code, 'invalid-session-ids')

  const badBody = await purge(harness, [])
  assert.equal(badBody.status, 400)

  const unauth = await call(harness, ROUTES.purge, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { sessionIds: ['session-unmaterialized'] },
  })
  assert.equal(unauth.status, 403)

  const getPurge = await call(harness, ROUTES.purge)
  assert.equal(getPurge.status, 405)
  assert.equal(getPurge.headers.allow, 'POST')

  const noService = createHarness()
  t.after(() => noService.dispose())
  const unavailable = await purge(noService, { sessionIds: ['session-unmaterialized'] })
  assert.equal(unavailable.status, 501)
})

test('GET /dsh-projects/empty-sessions finds legacy empty logs and purge deletes them', async (t) => {
  const home = createHome(t)
  const legacyDir = seedSessionLog(home, '--work-a--', 'session-legacy-empty', [headerLine('session-legacy-empty')])
  // legacy backend versions keep an unversioned log filename
  renameSync(join(legacyDir, 'session.v4.jsonl.zstd'), join(legacyDir, 'session.jsonl.zstd'))
  const smallContentDir = seedSessionLog(home, '--work-a--', 'session-small-content', [
    headerLine('session-small-content'),
    { type: 'user/message', seq: 1, time: Date.now(), data: { content: 'hello' } },
  ])
  const bigDir = seedSessionLog(home, '--work-a--', 'session-big-content')
  writeFileSync(join(bigDir, 'session.v4.jsonl.zstd'), Buffer.alloc(20_000, 7))
  const blankDir = seedSessionLog(home, '--work-b--', 'session-blank-a')
  const services = {
    sessionController: {
      async list() {
        return {
          items: [
            { sessionId: 'session-legacy-empty', blank: false, running: false },
            { sessionId: 'session-small-content', blank: false, running: false },
            { sessionId: 'session-big-content', blank: false, running: false },
            { sessionId: 'session-blank-a', blank: true, running: false },
          ],
        }
      },
    },
    sessions: { get: () => undefined },
  }
  const harness = createHarness(services)
  t.after(() => harness.dispose())

  const scan = await call(harness, ROUTES.empty)
  assert.equal(scan.status, 200, JSON.stringify(scan.body))
  assert.deepEqual(scan.body.result.emptySessionIds.sort(), ['session-blank-a', 'session-legacy-empty'])

  const purgeResponse = await purge(harness, {
    sessionIds: ['session-legacy-empty', 'session-small-content', 'session-big-content', 'session-blank-a'],
  })
  assert.equal(purgeResponse.status, 200, JSON.stringify(purgeResponse.body))
  assert.deepEqual(purgeResponse.body.result.purged.sort(), ['session-blank-a', 'session-legacy-empty'])
  const reasons = Object.fromEntries(purgeResponse.body.result.skipped.map((entry) => [entry.sessionId, entry.reason]))
  assert.equal(reasons['session-small-content'], 'not-empty')
  assert.equal(reasons['session-big-content'], 'not-empty')
  assert.equal(existsSync(legacyDir), false)
  assert.equal(existsSync(blankDir), false)
  assert.equal(existsSync(smallContentDir), true)
  assert.equal(existsSync(bigDir), true)

  const postScan = await call(harness, ROUTES.empty, { method: 'POST', headers: POST_HEADERS, body: {} })
  assert.equal(postScan.status, 405)
  assert.equal(postScan.headers.allow, 'GET')
})