/**
 * dsh-projects — Host half.
 *
 * Durable project state plus the same-origin HTTP routes the Projects client
 * bundle talks to inside DSH Desktop:
 *
 *   GET  /dsh-projects/state   -> { ok, state }
 *   GET  /dsh-projects/health  -> { ok, plugin, version, routes, storage, counts, services, time }
 *   POST /dsh-projects/mutate  -> { ok, state, result }   (project.create|update|delete, session.assign)
 *   POST /dsh-projects/cwd     -> { ok, cwd, state }      (real agent working-directory change)
 *
 * The HTTP state is authoritative in memory; every mutation is persisted to
 * `$DSH_HOME/storages/dsh-projects.json` (DSH_HOME defaults to `~/.dsh`) with an
 * atomic temp-file + rename write before it is acknowledged. A missing, corrupt
 * or foreign-versioned file falls back to an empty, valid `ProjectData`.
 *
 * Only `node:` builtins are imported: this file runs in the Desktop host
 * process through the Cordis loader, not in the browser bundle.
 */
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export const name = 'dsh-projects'

/** Persisted ProjectData format version. */
export const STATE_VERSION = 1

/** Project accent ids; must stay in sync with src/client/data.js PROJECT_COLORS. */
export const PROJECT_COLORS = Object.freeze(['blue', 'green', 'orange', 'purple', 'pink', 'teal', 'gray'])

/** Hard request-body cap for the POST routes (64 KiB). */
export const BODY_LIMIT_BYTES = 64 * 1024

const MAX_NAME_LENGTH = 200
const MAX_DIRECTORIES = 32
const MAX_PATH_LENGTH = 4096
const MAX_ID_LENGTH = 1024

const ROUTE_STATE = '/dsh-projects/state'
const ROUTE_HEALTH = '/dsh-projects/health'
const ROUTE_MUTATE = '/dsh-projects/mutate'
const ROUTE_CWD = '/dsh-projects/cwd'
const ROUTE_PURGE = '/dsh-projects/purge'
const ROUTE_EMPTY = '/dsh-projects/empty-sessions'

const ROUTE_TABLE = Object.freeze([
  { method: 'GET', path: ROUTE_STATE },
  { method: 'GET', path: ROUTE_HEALTH },
  { method: 'POST', path: ROUTE_MUTATE },
  { method: 'POST', path: ROUTE_CWD },
  { method: 'POST', path: ROUTE_PURGE },
  { method: 'GET', path: ROUTE_EMPTY },
])

/* ------------------------------------------------------------------------- *
 * Mounting
 * ------------------------------------------------------------------------- */

/**
 * Cordis entry. Mounts the routes once the host `webServer` service is
 * available; `host.effect` makes the registration disposable with the plugin.
 * @param {object} ctx - cordis host context.
 */
export function apply(ctx) {
  if (ctx === null || typeof ctx !== 'object' || typeof ctx.inject !== 'function') {
    throw new TypeError('dsh-projects: apply() requires a cordis host context')
  }
  ctx.inject(['webServer'], (host) => {
    host.effect(() => mountRoutes(host.webServer, ctx), 'dsh-projects: http routes')
  })
}

/**
 * Register the four exact-path routes on the host web server.
 * @param {{ register(route: object): (() => void) }} webServer - host web-server service.
 * @param {object} ctx - cordis host context, used for lazy service lookup.
 * @returns {() => void} disposer removing every route.
 */
export function mountRoutes(webServer, ctx) {
  if (webServer === null || typeof webServer !== 'object' || typeof webServer.register !== 'function') {
    throw new TypeError('dsh-projects: webServer.register is unavailable')
  }
  const store = createStore()
  const disposers = [
    webServer.register({
      kind: 'exact',
      path: ROUTE_STATE,
      handler: (request, response) => route(response, () => handleState(request, response, store)),
    }),
    webServer.register({
      kind: 'exact',
      path: ROUTE_HEALTH,
      handler: (request, response) => route(response, () => handleHealth(request, response, store, ctx)),
    }),
    webServer.register({
      kind: 'exact',
      path: ROUTE_MUTATE,
      handler: (request, response) => route(response, () => handleMutate(request, response, store)),
    }),
    webServer.register({
      kind: 'exact',
      path: ROUTE_CWD,
      handler: (request, response) => route(response, () => handleCwd(request, response, store, ctx)),
    }),
    webServer.register({
      kind: 'exact',
      path: ROUTE_PURGE,
      handler: (request, response) => route(response, () => handlePurge(request, response, store, ctx)),
    }),
    webServer.register({
      kind: 'exact',
      path: ROUTE_EMPTY,
      handler: (request, response) => route(response, () => handleEmptySessions(request, response, store, ctx)),
    }),
  ]
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose()
      } catch {
        // A route already removed by the host: nothing left to dispose.
      }
    }
  }
}

/** Run one route handler and translate thrown errors into the JSON envelope. */
async function route(response, handler) {
  try {
    await handler()
  } catch (error) {
    sendError(response, error)
  }
}

/* ------------------------------------------------------------------------- *
 * HTTP helpers
 * ------------------------------------------------------------------------- */

/** Expected failure with an HTTP status and a stable machine-readable code. */
class HttpError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}

function badRequest(code, message) {
  return new HttpError(400, code, message)
}

function errorMessage(error) {
  if (error instanceof Error && error.message !== '') return error.message
  if (typeof error === 'string' && error !== '') return error
  return String(error)
}

function sendJson(response, status, value, headers = {}) {
  if (response.headersSent === true || response.writableEnded === true) return
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    ...headers,
  })
  response.end(JSON.stringify(value))
}

function sendError(response, error) {
  if (error instanceof HttpError) {
    sendJson(response, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  sendJson(response, 500, {
    ok: false,
    error: { code: 'internal-error', message: errorMessage(error) },
  })
}

function sendMethodNotAllowed(response, allow) {
  sendJson(response, 405, {
    ok: false,
    error: { code: 'method-not-allowed', message: `method not allowed; use ${allow}` },
  }, { allow })
}

/** Read a request header as a lower-cased value; arrays from Node are folded to their first entry. */
function headerValue(request, name) {
  const headers = request !== null && typeof request === 'object' ? request.headers : undefined
  if (headers === null || typeof headers !== 'object') return undefined
  const value = headers[name]
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined
  return value
}

/**
 * Guard shared by both POST routes: JSON content type and the
 * `x-dsh-projects: 1` custom header (the header is what a cross-site form or
 * `no-cors` fetch cannot set without a preflight).
 */
function requirePostHeaders(request) {
  const contentType = String(headerValue(request, 'content-type') ?? '').toLowerCase()
  const mediaType = contentType.split(';')[0].trim()
  if (mediaType !== 'application/json') {
    throw new HttpError(415, 'unsupported-media-type', 'content-type must be application/json')
  }
  if (String(headerValue(request, 'x-dsh-projects') ?? '') !== '1') {
    throw new HttpError(403, 'forbidden', 'x-dsh-projects: 1 header is required')
  }
}

/**
 * Read and parse a JSON body, rejecting anything above BODY_LIMIT_BYTES.
 * A declared content-length over the limit is rejected before reading.
 */
async function readJsonBody(request) {
  const declared = Number(headerValue(request, 'content-length'))
  if (Number.isFinite(declared) && declared > BODY_LIMIT_BYTES) throw bodyTooLarge()

  const chunks = []
  let size = 0
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > BODY_LIMIT_BYTES) throw bodyTooLarge()
      chunks.push(buffer)
    }
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw badRequest('invalid-body', `failed to read request body: ${errorMessage(error)}`)
  }

  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw badRequest('invalid-json', 'request body must be JSON')
  try {
    return JSON.parse(text)
  } catch {
    throw badRequest('invalid-json', 'request body is not valid JSON')
  }
}

function bodyTooLarge() {
  return new HttpError(413, 'payload-too-large', `request body exceeds ${BODY_LIMIT_BYTES} bytes`)
}

/* ------------------------------------------------------------------------- *
 * ProjectData shape, validation and sanitizing
 * ------------------------------------------------------------------------- */

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key)

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptyState() {
  return { version: STATE_VERSION, projects: [], assignments: {}, sessionCwd: {} }
}

function cloneState(state) {
  return structuredClone(state)
}

/** Client-compatible path identity: forward slashes, no trailing separator. */
function comparablePath(value) {
  let result = value.replace(/\\/g, '/')
  while (result.length > 1 && result.endsWith('/')) result = result.slice(0, -1)
  return result
}

function samePath(left, right) {
  const a = comparablePath(left)
  const b = comparablePath(right)
  return a !== '' && a === b
}

function validIsoString(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

function isoNow() {
  return new Date().toISOString()
}

function requireName(value) {
  if (typeof value !== 'string') throw badRequest('invalid-name', 'name must be a string')
  const trimmed = value.trim()
  if (trimmed === '') throw badRequest('invalid-name', 'name must not be empty')
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw badRequest('invalid-name', `name must be at most ${MAX_NAME_LENGTH} characters`)
  }
  return trimmed
}

function requireColor(value) {
  if (typeof value !== 'string' || !PROJECT_COLORS.includes(value)) {
    throw badRequest('invalid-color', `color must be one of: ${PROJECT_COLORS.join(', ')}`)
  }
  return value
}

function requireId(value, field) {
  if (typeof value !== 'string') throw badRequest('invalid-request', `${field} must be a non-empty string`)
  const trimmed = value.trim()
  if (trimmed === '') throw badRequest('invalid-request', `${field} must be a non-empty string`)
  if (trimmed.length > MAX_ID_LENGTH) throw badRequest('invalid-request', `${field} is too long`)
  return trimmed
}

/**
 * Canonical stored form of a directory: no redundant trailing separators.
 * The Windows drive root (`C:\`) and POSIX root (`/`) are preserved.
 */
function canonicalizePathInput(value) {
  let result = value
  while (result.length > 1 && (result.endsWith('/') || result.endsWith('\\'))) {
    if (/^[A-Za-z]:[\\/]$/.test(result)) break
    result = result.slice(0, -1)
  }
  return result
}

function requireAbsolutePath(value, field, code = 'invalid-directory') {
  if (typeof value !== 'string') throw badRequest(code, `${field} must be an absolute path`)
  const trimmed = value.trim()
  if (trimmed === '') throw badRequest(code, `${field} must not be empty`)
  if (trimmed.length > MAX_PATH_LENGTH) throw badRequest(code, `${field} is too long`)
  if (!isAbsolute(trimmed)) throw badRequest(code, `${field} must be an absolute path: ${trimmed}`)
  return canonicalizePathInput(trimmed)
}

function requireDirectories(value) {
  if (!Array.isArray(value)) {
    throw badRequest('invalid-directories', 'directories must be an array of absolute paths')
  }
  if (value.length > MAX_DIRECTORIES) {
    throw badRequest('invalid-directories', `directories supports at most ${MAX_DIRECTORIES} entries`)
  }
  const directories = []
  for (const entry of value) {
    const directory = requireAbsolutePath(entry, 'directories entry')
    if (!directories.some((existing) => samePath(existing, directory))) directories.push(directory)
  }
  return directories
}

/** Repair one stored project; returns null when the entry cannot be trusted. */
function sanitizeProject(raw) {
  if (!isPlainObject(raw)) return null
  if (typeof raw.id !== 'string' || raw.id.trim() === '') return null
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return null
  const id = raw.id.trim()
  const name = raw.name.trim()
  const directories = []
  if (Array.isArray(raw.directories)) {
    for (const entry of raw.directories) {
      if (typeof entry !== 'string') continue
      const trimmed = entry.trim()
      if (trimmed === '' || trimmed.length > MAX_PATH_LENGTH || !isAbsolute(trimmed)) continue
      const canonical = canonicalizePathInput(trimmed)
      if (!directories.some((existing) => samePath(existing, canonical))) directories.push(canonical)
    }
  }
  const color = PROJECT_COLORS.includes(raw.color) ? raw.color : PROJECT_COLORS[0]
  const createdAt = validIsoString(raw.createdAt) ?? isoNow()
  const updatedAt = validIsoString(raw.updatedAt) ?? createdAt
  const project = { id, name, color, directories, createdAt, updatedAt }
  const defaultDirectory = typeof raw.defaultDirectory === 'string'
    ? directories.find((directory) => samePath(directory, raw.defaultDirectory))
    : undefined
  if (defaultDirectory !== undefined) project.defaultDirectory = defaultDirectory
  return project
}

/** Validate an on-disk state blob; returns null when it is not a usable ProjectData. */
function sanitizeState(raw) {
  if (!isPlainObject(raw)) return null
  if (raw.version !== STATE_VERSION) return null
  if (!Array.isArray(raw.projects)) return null
  const projects = []
  const seen = new Set()
  for (const entry of raw.projects) {
    const project = sanitizeProject(entry)
    if (project === null || seen.has(project.id)) continue
    seen.add(project.id)
    projects.push(project)
  }
  const assignments = {}
  if (isPlainObject(raw.assignments)) {
    for (const [sessionId, projectId] of Object.entries(raw.assignments)) {
      if (sessionId === '' || sessionId.length > MAX_ID_LENGTH) continue
      if (projectId === null || typeof projectId === 'string') assignments[sessionId] = projectId
    }
  }
  const sessionCwd = {}
  if (isPlainObject(raw.sessionCwd)) {
    for (const [sessionId, directory] of Object.entries(raw.sessionCwd)) {
      if (sessionId === '' || sessionId.length > MAX_ID_LENGTH) continue
      if (typeof directory === 'string' && directory !== '') sessionCwd[sessionId] = directory
    }
  }
  return { version: STATE_VERSION, projects, assignments, sessionCwd }
}

/** Event types whose presence means a Session holds real conversation content. */
const CONTENT_EVENT_TYPES = new Set([
  'user/message',
  'assistant/message',
  'developer/message',
  'system/message',
  'tool/call',
  'tool/result',
  'agent/inbox/spliced',
  'compaction/summary',
])

/**
 * Upper bound (log bytes) for inspecting a Session's events while classifying
 * it as empty. Above it the Session is assumed to hold content; a false
 * negative only means "not deleted", never data loss.
 */
const EMPTY_SCAN_MAX_LOG_BYTES = 16 * 1024

const ZSTD_FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Cut one session log file into its concatenated zstd frames. */
function splitZstdFrames(buffer) {
  const offsets = []
  for (let index = 0; index <= buffer.length - 4; index += 1) {
    if (
      buffer[index] === ZSTD_FRAME_MAGIC[0] &&
      buffer[index + 1] === ZSTD_FRAME_MAGIC[1] &&
      buffer[index + 2] === ZSTD_FRAME_MAGIC[2] &&
      buffer[index + 3] === ZSTD_FRAME_MAGIC[3]
    ) {
      offsets.push(index)
    }
  }
  const frames = []
  for (let index = 0; index < offsets.length; index += 1) {
    frames.push(buffer.subarray(offsets[index], offsets[index + 1] ?? buffer.length))
  }
  return frames
}

/** The newest session log artifact inside one Session directory. */
function logFileOf(sessionDirectory) {
  let entries
  try {
    entries = readdirSync(sessionDirectory)
  } catch {
    return undefined
  }
  const candidates = entries.filter((name) => /^session(?:\..+)?\.jsonl(?:\.zstd)?$/.test(name)).sort()
  return candidates.length === 0 ? undefined : join(sessionDirectory, candidates[candidates.length - 1])
}

/**
 * Whether a small log holds no conversation content. Only tiny logs are read:
 * a Session with content writes one frame per event, so a one-frame (header
 * only) log is definitively empty, and named content event types are refused.
 */
function smallLogIsEmpty(file) {
  let buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return false
  }
  if (buffer.length === 0) return true
  if (buffer.length > EMPTY_SCAN_MAX_LOG_BYTES) return false
  const frames = splitZstdFrames(buffer)
  if (frames.length === 0) return false
  let sawHeader = false
  for (const frame of frames) {
    let text
    try {
      text = zstdDecompressSync(frame).toString('utf8')
    } catch {
      return false
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        return false
      }
      if (record !== null && typeof record === 'object' && record.type === 'session') {
        sawHeader = true
        continue
      }
      const type = record !== null && typeof record === 'object' ? (record.type ?? record.event?.type) : undefined
      if (typeof type === 'string' && CONTENT_EVENT_TYPES.has(type)) return false
    }
  }
  return sawHeader
}

/**
 * Whether a catalog row is a never-used Session with no conversation content.
 * Host `blank` metadata is authoritative when present; legacy Sessions whose
 * projection cache lacks it are classified from their (small) log files.
 */
function isEmptySession(item, directories) {
  if (item.blank === true) return true
  if (item.running === true) return false
  const directory = directories.get(item.sessionId)
  if (directory === undefined) return false
  const file = logFileOf(directory)
  if (file === undefined) return false
  return smallLogIsEmpty(file)
}

/** Read the Host catalog without activating agents. */
async function readSessionCatalog(ctx) {
  const listSessions = serviceMethod(ctx, 'sessionController', 'list')
  if (listSessions === null) {
    throw new HttpError(501, 'service/unavailable', 'host service unavailable: sessionController.list')
  }
  try {
    const catalog = await listSessions({}, undefined)
    return Array.isArray(catalog?.items) ? catalog.items : []
  } catch (error) {
    throw new HttpError(500, 'catalog/unavailable', `cannot read the session catalog: ${errorMessage(error)}`)
  }
}

/**
 * GET /dsh-projects/empty-sessions
 * Lists Sessions that hold no conversation content (including legacy empty
 * Sessions the Host catalog does not mark as blank), so the browser can hide
 * them and offer to delete them permanently.
 */
async function handleEmptySessions(request, response, store, ctx) {
  if (request.method !== 'GET') return sendMethodNotAllowed(response, 'GET')
  const items = await readSessionCatalog(ctx)
  const liveSessions = ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  const isLive = (sessionId) =>
    liveSessions !== null &&
    liveSessions !== undefined &&
    typeof liveSessions.get === 'function' &&
    liveSessions.get(sessionId) !== undefined
  const directories = findSessionDirectories(join(resolveDshHome(), 'sessions'))
  const emptySessionIds = []
  for (const item of items) {
    if (item.running === true) continue
    if (isLive(item.sessionId)) continue
    if (isEmptySession(item, directories)) emptySessionIds.push(item.sessionId)
  }
  sendJson(response, 200, { ok: true, result: { emptySessionIds } })
}

/**
 * Permanently remove never-used Sessions from disk.
 *
 * The Session log is DSH's source of truth and the public API has no "delete
 * session" operation, so this is an explicit, narrowly validated maintenance
 * route requested by the Projects UI: only Sessions whose Host catalog row says
 * `blank: true`, that are not running and not live in this Host are touched.
 * Their storage directory is found below `$DSH_HOME/sessions` and removed; the
 * caller refreshes the catalog afterwards. Conversations with content can never
 * match, so they are never deleted.
 */
async function handlePurge(request, response, store, ctx) {
  if (request.method !== 'POST') return sendMethodNotAllowed(response, 'POST')
  requirePostHeaders(request)
  const body = await readJsonBody(request)
  if (!isPlainObject(body)) throw badRequest('invalid-request', 'request body must be a JSON object')
  const requested = body.sessionIds
  if (!Array.isArray(requested) || requested.length === 0) {
    throw badRequest('invalid-session-ids', 'sessionIds must be a non-empty array')
  }
  if (requested.length > 200) throw badRequest('invalid-session-ids', 'at most 200 sessions can be purged per call')
  const sessionIds = requested.map((sessionId, index) => requireId(sessionId, `sessionIds[${index}]`))

  const liveSessions = ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
  const isLive = (sessionId) =>
    liveSessions !== null &&
    liveSessions !== undefined &&
    typeof liveSessions.get === 'function' &&
    liveSessions.get(sessionId) !== undefined

  const items = await readSessionCatalog(ctx)
  const byId = new Map(items.map((item) => [item.sessionId, item]))
  const sessionsRoot = join(resolveDshHome(), 'sessions')
  const directories = findSessionDirectories(sessionsRoot)

  const purged = []
  const skipped = []
  for (const sessionId of sessionIds) {
    const item = byId.get(sessionId)
    if (item === undefined) {
      skipped.push({ sessionId, reason: 'not-found' })
      continue
    }
    if (item.running === true) {
      skipped.push({ sessionId, reason: 'running' })
      continue
    }
    if (!isEmptySession(item, directories)) {
      skipped.push({ sessionId, reason: 'not-empty' })
      continue
    }
    if (isLive(sessionId)) {
      skipped.push({ sessionId, reason: 'live' })
      continue
    }
    const directory = directories.get(sessionId)
    if (directory === undefined) {
      skipped.push({ sessionId, reason: 'not-materialized' })
      continue
    }
    try {
      rmSync(directory, { recursive: true, force: true })
      purged.push(sessionId)
    } catch (error) {
      skipped.push({ sessionId, reason: `delete-failed: ${errorMessage(error)}` })
    }
  }
  sendJson(response, 200, { ok: true, result: { purged, skipped } })
}

/** Resolve `$DSH_HOME` the same way the storage layer does. */
function resolveDshHome() {
  const configured = process.env.DSH_HOME
  return typeof configured === 'string' && configured !== '' ? join(configured) : join(homedir(), '.dsh')
}

/**
 * Map sessionId -> session storage directory below the sessions root.
 * Layout: `<root>/<workspace-key>/<sessionId>/session*.jsonl*`.
 */
function findSessionDirectories(sessionsRoot) {
  const found = new Map()
  if (!existsSync(sessionsRoot)) return found
  const wanted = /^session-[A-Za-z0-9-]+$/
  const visit = (directory, depth) => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = join(directory, entry.name)
      if (wanted.test(entry.name)) {
        found.set(entry.name, child)
        continue
      }
      visit(child, depth + 1)
    }
  }
  visit(sessionsRoot, 0)
  return found
}

/* ------------------------------------------------------------------------- *
 * Durable storage
 * ------------------------------------------------------------------------- */

/** Absolute path of the state file, honoring DSH_HOME (default `~/.dsh`). */
export function resolveStorageFile() {
  const configured = process.env.DSH_HOME
  const home = typeof configured === 'string' && configured !== '' ? configured : join(homedir(), '.dsh')
  return resolve(home, 'storages', 'dsh-projects.json')
}

let temporaryCounter = 0

/** Atomic write: fsync a sibling temp file, then rename it over the target. */
function writeStateFile(file, state) {
  mkdirSync(dirname(file), { recursive: true })
  temporaryCounter += 1
  const temporary = `${file}.${process.pid}.${temporaryCounter}.tmp`
  let descriptor
  try {
    descriptor = openSync(temporary, 'w', 0o600)
    writeSync(descriptor, `${JSON.stringify(state, null, 2)}\n`, null, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporary, file)
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor)
      } catch {
        // Already closed / never opened.
      }
    }
    try {
      rmSync(temporary, { force: true })
    } catch {
      // Best-effort cleanup of the temp file.
    }
    throw error
  }
}

function loadStateFile(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`[dsh-projects] cannot read ${file}: ${errorMessage(error)}; starting empty`)
    }
    return emptyState()
  }
  try {
    const state = sanitizeState(JSON.parse(raw))
    if (state === null) {
      console.warn(`[dsh-projects] unsupported state in ${file}; starting empty`)
      return emptyState()
    }
    return state
  } catch (error) {
    console.warn(`[dsh-projects] corrupt state in ${file}: ${errorMessage(error)}; starting empty`)
    return emptyState()
  }
}

/**
 * In-memory authoritative ProjectData for one mounted plugin instance.
 * Writes are committed only after the atomic disk write succeeds, so a failed
 * write never leaves memory and disk disagreeing about what was accepted.
 */
function createStore() {
  let state = null
  const inFlightCwd = new Set()
  return {
    file: () => resolveStorageFile(),
    inFlightCwd,
    current() {
      if (state === null) state = loadStateFile(resolveStorageFile())
      return state
    },
    commit(next) {
      try {
        writeStateFile(resolveStorageFile(), next)
      } catch (error) {
        throw new HttpError(500, 'storage/write-failed', `failed to persist project state: ${errorMessage(error)}`)
      }
      state = next
      return state
    },
  }
}

/* ------------------------------------------------------------------------- *
 * Mutations
 * ------------------------------------------------------------------------- */

function mutateProjectCreate(state, payload) {
  const name = requireName(payload.name)
  const directories = payload.directories === undefined ? [] : requireDirectories(payload.directories)
  const color = payload.color === undefined ? PROJECT_COLORS[0] : requireColor(payload.color)
  const now = isoNow()
  const project = {
    id: `project-${randomUUID()}`,
    name,
    color,
    directories,
    createdAt: now,
    updatedAt: now,
  }
  if (directories.length > 0) project.defaultDirectory = directories[0]
  const next = cloneState(state)
  next.projects.push(project)
  return { next, result: { project } }
}

function mutateProjectUpdate(state, payload) {
  const projectId = requireId(payload.projectId, 'projectId')
  const index = state.projects.findIndex((project) => project.id === projectId)
  if (index === -1) throw new HttpError(404, 'project/not-found', `project not found: ${projectId}`)

  const current = state.projects[index]
  const updated = { ...current }
  if (hasOwn(payload, 'name')) updated.name = requireName(payload.name)
  if (hasOwn(payload, 'color')) updated.color = requireColor(payload.color)
  if (hasOwn(payload, 'directories')) updated.directories = requireDirectories(payload.directories)

  const directories = updated.directories ?? current.directories ?? []
  if (hasOwn(payload, 'defaultDirectory')) {
    const requested = payload.defaultDirectory
    if (requested === null || requested === undefined) {
      delete updated.defaultDirectory
    } else {
      const canonical = directories.find((directory) => samePath(directory, requireAbsolutePath(requested, 'defaultDirectory')))
      if (canonical === undefined) {
        throw badRequest('invalid-default-directory', 'defaultDirectory must be one of the project directories')
      }
      updated.defaultDirectory = canonical
    }
  } else if (typeof updated.defaultDirectory === 'string') {
    const canonical = directories.find((directory) => samePath(directory, updated.defaultDirectory))
    if (canonical === undefined) {
      if (directories.length > 0) updated.defaultDirectory = directories[0]
      else delete updated.defaultDirectory
    } else {
      updated.defaultDirectory = canonical
    }
  } else if (directories.length > 0) {
    updated.defaultDirectory = directories[0]
  }
  updated.updatedAt = isoNow()

  const next = cloneState(state)
  next.projects[index] = updated
  return { next, result: null }
}

function mutateProjectDelete(state, payload) {
  const projectId = requireId(payload.projectId, 'projectId')
  if (!state.projects.some((project) => project.id === projectId)) {
    throw new HttpError(404, 'project/not-found', `project not found: ${projectId}`)
  }
  const next = cloneState(state)
  next.projects = next.projects.filter((project) => project.id !== projectId)
  // Explicit assignments to a deleted project are dropped; membership falls
  // back to the implicit cwd rule, which cannot match a deleted project.
  for (const [sessionId, assigned] of Object.entries(next.assignments)) {
    if (assigned === projectId) delete next.assignments[sessionId]
  }
  return { next, result: null }
}

function mutateSessionAssign(state, payload) {
  const sessionId = requireId(payload.sessionId, 'sessionId')
  if (!hasOwn(payload, 'projectId')) {
    throw badRequest('invalid-project-id', 'projectId is required (use null to clear the assignment)')
  }
  const projectId = payload.projectId
  if (projectId !== null) {
    if (typeof projectId !== 'string' || projectId.trim() === '') {
      throw badRequest('invalid-project-id', 'projectId must be a project id or null')
    }
    if (!state.projects.some((project) => project.id === projectId)) {
      throw new HttpError(404, 'project/not-found', `project not found: ${projectId}`)
    }
  }
  const next = cloneState(state)
  next.assignments[sessionId] = projectId
  return { next, result: null }
}

const MUTATIONS = Object.freeze({
  'project.create': mutateProjectCreate,
  'project.update': mutateProjectUpdate,
  'project.delete': mutateProjectDelete,
  'session.assign': mutateSessionAssign,
})

/* ------------------------------------------------------------------------- *
 * Lazy host-service access
 * ------------------------------------------------------------------------- */

function resolveService(ctx, serviceName) {
  try {
    if (ctx === null || typeof ctx !== 'object' || typeof ctx.get !== 'function') return undefined
    const service = ctx.get(serviceName)
    return service ?? undefined
  } catch {
    return undefined
  }
}

/** Bound method of a lazily resolved host service, or null when unavailable. */
function serviceMethod(ctx, serviceName, methodName) {
  const service = resolveService(ctx, serviceName)
  if (service === null || service === undefined) return null
  const method = service[methodName]
  return typeof method === 'function' ? method.bind(service) : null
}

/* ------------------------------------------------------------------------- *
 * Route handlers
 * ------------------------------------------------------------------------- */

function handleState(request, response, store) {
  if (request.method !== 'GET') return sendMethodNotAllowed(response, 'GET')
  sendJson(response, 200, { ok: true, state: store.current() })
}

function handleHealth(request, response, store, ctx) {
  if (request.method !== 'GET') return sendMethodNotAllowed(response, 'GET')
  const state = store.current()
  let fileExists = false
  try {
    fileExists = existsSync(store.file())
  } catch {
    fileExists = false
  }
  sendJson(response, 200, {
    ok: true,
    plugin: '@local/dsh-projects',
    version: STATE_VERSION,
    routes: ROUTE_TABLE.map((entry) => `${entry.method} ${entry.path}`),
    storage: {
      path: store.file(),
      exists: fileExists,
    },
    counts: {
      projects: state.projects.length,
      assignments: Object.keys(state.assignments).length,
      sessionCwd: Object.keys(state.sessionCwd).length,
    },
    services: {
      sessionController: serviceMethod(ctx, 'sessionController', 'resolveAgent') !== null,
      workingDirectory: serviceMethod(ctx, 'workingDirectory', 'set') !== null,
    },
    time: isoNow(),
  })
}

async function handleMutate(request, response, store) {
  if (request.method !== 'POST') return sendMethodNotAllowed(response, 'POST')
  requirePostHeaders(request)
  const body = await readJsonBody(request)
  if (!isPlainObject(body)) throw badRequest('invalid-request', 'request body must be a JSON object')
  if (typeof body.action !== 'string' || body.action.trim() === '') {
    throw badRequest('invalid-action', 'action must be a non-empty string')
  }
  const mutate = MUTATIONS[body.action]
  if (mutate === undefined) throw badRequest('unknown-action', `unknown action: ${body.action}`)
  const payload = body.payload === undefined ? {} : body.payload
  if (!isPlainObject(payload)) throw badRequest('invalid-payload', 'payload must be a JSON object')

  const { next, result } = mutate(store.current(), payload)
  store.commit(next)
  sendJson(response, 200, { ok: true, state: next, result })
}

/**
 * Change a session's real working directory: resolve the live Agent host-side
 * through `sessionController.resolveAgent`, then call
 * `workingDirectory.set(agent, path)` — the same mechanism as the shipped
 * `working_directory` tool. The resolved canonical cwd is recorded in
 * `state.sessionCwd[sessionId]` and persisted.
 */
async function handleCwd(request, response, store, ctx) {
  if (request.method !== 'POST') return sendMethodNotAllowed(response, 'POST')
  requirePostHeaders(request)
  const body = await readJsonBody(request)
  if (!isPlainObject(body)) throw badRequest('invalid-request', 'request body must be a JSON object')
  const sessionId = requireId(body.sessionId, 'sessionId')
  const requestedPath = requireAbsolutePath(body.path, 'path', 'invalid-path')

  const resolveAgent = serviceMethod(ctx, 'sessionController', 'resolveAgent')
  const setWorkingDirectory = serviceMethod(ctx, 'workingDirectory', 'set')
  const missing = []
  if (resolveAgent === null) missing.push('sessionController.resolveAgent')
  if (setWorkingDirectory === null) missing.push('workingDirectory.set')
  if (missing.length > 0) {
    throw new HttpError(501, 'service/unavailable', `host service unavailable: ${missing.join(', ')}`)
  }

  // Reentrancy guard: one in-flight cwd change per session; a concurrent click
  // must not race two host-side directory changes.
  if (store.inFlightCwd.has(sessionId)) {
    throw new HttpError(409, 'cwd/busy', 'a working-directory change is already in progress for this session')
  }
  store.inFlightCwd.add(sessionId)
  try {
    let resolved
    try {
      resolved = await resolveAgent(sessionId)
    } catch (error) {
      throw new HttpError(409, 'session/not-found', errorMessage(error))
    }
    const agent = resolved !== null && typeof resolved === 'object' ? resolved.agent : undefined
    if (agent === undefined || agent === null) {
      const detail = resolved !== null && typeof resolved === 'object' ? resolved.error : undefined
      const code = detail !== null && typeof detail === 'object' && typeof detail.code === 'string' && detail.code !== ''
        ? detail.code
        : 'session/not-found'
      const message = detail !== null && typeof detail === 'object' && typeof detail.message === 'string'
        ? detail.message
        : `session is not available: ${sessionId}`
      throw new HttpError(409, code, message)
    }

    let cwd
    try {
      cwd = await setWorkingDirectory(agent, requestedPath)
    } catch (error) {
      throw new HttpError(400, 'cwd/failed', errorMessage(error))
    }
    if (cwd !== null && typeof cwd === 'object' && typeof cwd.cwd === 'string') cwd = cwd.cwd
    if (typeof cwd !== 'string' || cwd.trim() === '') {
      throw new HttpError(400, 'cwd/failed', 'workingDirectory.set did not return a directory')
    }

    const next = cloneState(store.current())
    next.sessionCwd[sessionId] = cwd
    store.commit(next)
    sendJson(response, 200, { ok: true, cwd, state: next })
  } finally {
    store.inFlightCwd.delete(sessionId)
  }
}
