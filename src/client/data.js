/**
 * Pure data helpers and client-side stores for the Projects sidebar.
 *
 * No React and no `@deepseek-ai/*` imports here so the module can be unit-tested
 * in plain Node (tests/). The browser bundle compiles it into client.js.
 */

/** Project accent palette. Literal colors are artwork-only (folder glyph / dot). */
export const PROJECT_COLORS = [
  { id: 'blue', value: '#4d93f8' },
  { id: 'green', value: '#22c55e' },
  { id: 'orange', value: '#f59e0b' },
  { id: 'purple', value: '#8b5cf6' },
  { id: 'pink', value: '#ec4899' },
  { id: 'teal', value: '#14b8a6' },
  { id: 'gray', value: '#979da6' },
]

export function resolveProjectColor(color) {
  const found = PROJECT_COLORS.find((entry) => entry.id === color)
  return found === undefined ? PROJECT_COLORS[0].value : found.value
}

export function colorIdAt(index) {
  return PROJECT_COLORS[index % PROJECT_COLORS.length].id
}

/** Normalize a directory path for identity comparison (trailing separators, backslashes). */
export function normalizePath(path) {
  if (typeof path !== 'string') return ''
  let value = path.replace(/\\/g, '/')
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1)
  return value
}

export function samePath(left, right) {
  const a = normalizePath(left)
  const b = normalizePath(right)
  return a !== '' && a === b
}

/** Last path segment accepting both separators; '' for empty input. */
export function basename(path) {
  const value = normalizePath(path)
  if (value === '') return ''
  const at = value.lastIndexOf('/')
  return at === -1 ? value : value.slice(at + 1) || value
}

export function pad2(value) {
  return String(value).padStart(2, '0')
}

/**
 * Coarse relative-time buckets for sidebar labels.
 * @param updatedAt epoch ms (0/undefined tolerated)
 * @param now epoch ms
 */
export function relativeTime(updatedAt, now) {
  const at = typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : 0
  const delta = Math.max(0, now - at)
  if (at === 0 || delta < 60_000) return { unit: 'now', n: 0 }
  if (delta < 3_600_000) return { unit: 'minute', n: Math.max(1, Math.floor(delta / 60_000)) }
  if (delta < 86_400_000) return { unit: 'hour', n: Math.max(1, Math.floor(delta / 3_600_000)) }
  if (delta < 7 * 86_400_000) return { unit: 'day', n: Math.max(1, Math.floor(delta / 86_400_000)) }
  const date = new Date(at)
  return { unit: 'date', n: 0, date: { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() } }
}

/** Localized sidebar time label; `t` is the projects locale seat. */
export function timeLabel(updatedAt, now, t) {
  const bucket = relativeTime(updatedAt, now)
  if (bucket.unit === 'now') return t('time.now')
  if (bucket.unit === 'date') return t('time.date', { y: bucket.date.y, m: bucket.date.m, d: bucket.date.d })
  return t(`time.${bucket.unit}`, { n: bucket.n })
}

function rowOf(sessions, sessionId) {
  if (sessions === undefined || sessions === null) return undefined
  const byId = sessions.byId
  if (byId === undefined || byId === null) return undefined
  return byId[sessionId]
}

/**
 * Resolve the project a session belongs to.
 * Explicit assignment wins (including `null` = explicitly ungrouped), then the
 * first project whose directories contain the session directory.
 * @returns {object | null}
 */
export function resolveSessionProject(session, projectData) {
  if (projectData === undefined || projectData === null) return null
  const projects = Array.isArray(projectData.projects) ? projectData.projects : []
  const byId = new Map(projects.map((project) => [project.id, project]))
  const assignments = projectData.assignments ?? {}
  if (Object.prototype.hasOwnProperty.call(assignments, session.id)) {
    const assigned = assignments[session.id]
    if (assigned === null || assigned === undefined) return null
    return byId.get(assigned) ?? null
  }
  const cwd = session.cwd
  if (typeof cwd !== 'string' || cwd === '') return null
  for (const project of projects) {
    if (!Array.isArray(project.directories)) continue
    if (project.directories.some((directory) => samePath(directory, cwd))) return project
  }
  return null
}

function sortSessionIds(ids, sessions) {
  const rows = ids
    .map((id) => rowOf(sessions, id))
    .filter((row) => row !== undefined)
  rows.sort((left, right) => {
    if (Boolean(left.blank) !== Boolean(right.blank)) return left.blank ? -1 : 1
    return (right.updatedAt ?? 0) - (left.updatedAt ?? 0)
  })
  return rows.map((row) => row.id)
}

/**
 * Build the complete sidebar model for the current snapshots.
 *
 * @param {object} input
 * @param {object} input.sessions - ctx.sessions.list snapshot
 * @param {object} input.workspaces - ctx.workspaces.list snapshot
 * @param {object | null} input.projectData - host project state
 * @param {object} input.uiState - persisted sidebar UI state
 * @param {string} [input.currentSessionId] - the open conversation; a blank
 *   session is only visible while it is the current one (the Host keeps one
 *   reusable blank per workspace and stale blanks accumulate otherwise)
 * @param {string[]|Set<string>} [input.hiddenEmptySessionIds] - Sessions the Host
 *   classified as holding no conversation content (legacy empty logs); hidden
 *   unless they are the current conversation
 * @returns {{pinned: string[], projects: Array, ungrouped: Array,
 *            projectBySession: Map, visibleCount: number, totalCount: number}}
 */
export function buildSidebarModel({ sessions, workspaces, projectData, uiState, currentSessionId, hiddenEmptySessionIds }) {
  const showArchived = Boolean(uiState?.showArchived)
  const archived = new Set(Array.isArray(workspaces?.archivedSessionIds) ? workspaces.archivedSessionIds : [])
  const pinnedIds = Array.isArray(workspaces?.pinnedSessionIds) ? workspaces.pinnedSessionIds : []
  const workspaceItems = Array.isArray(workspaces?.items) ? workspaces.items : []
  const workspaceByPath = new Map()
  for (const workspace of workspaceItems) {
    if (typeof workspace.path === 'string') workspaceByPath.set(normalizePath(workspace.path), workspace)
  }
  const projectDataSafe = projectData ?? { projects: [], assignments: {}, sessionCwd: {} }
  const projects = Array.isArray(projectDataSafe.projects) ? projectDataSafe.projects : []
  const sessionIds = Array.isArray(sessions?.ids) ? sessions.ids : []
  const hiddenEmpty = hiddenEmptySessionIds === undefined || hiddenEmptySessionIds === null ? null : new Set(hiddenEmptySessionIds)

  const visible = []
  const projectBySession = new Map()
  for (const sessionId of sessionIds) {
    const row = rowOf(sessions, sessionId)
    if (row === undefined) continue
    if (row.origin === 'subagent') continue
    if (archived.has(sessionId) && !showArchived) continue
    // Empty/new Sessions are hidden unless they are the conversation currently
    // open in the main view (the Host keeps reusable blank Sessions around).
    if (row.blank === true && sessionId !== currentSessionId) continue
    if (hiddenEmpty !== null && hiddenEmpty.has(sessionId) && sessionId !== currentSessionId) continue
    visible.push(sessionId)
    const project = resolveSessionProject(row, projectDataSafe)
    if (project !== null) projectBySession.set(sessionId, project)
  }
  const visibleSet = new Set(visible)
  const pinnedSet = new Set(pinnedIds)
  const pinned = pinnedIds.filter((id) => visibleSet.has(id))

  const usedByProject = new Map(projects.map((project) => [project.id, []]))
  for (const sessionId of visible) {
    if (pinnedSet.has(sessionId)) continue
    const project = projectBySession.get(sessionId)
    if (project !== undefined && usedByProject.has(project.id)) usedByProject.get(project.id).push(sessionId)
  }
  // Sessions inside a project keep the workspace (directory) grouping of the
  // Host model, so moving a workspace into a project preserves its title.
  const projectSections = projects.map((project) => {
    const sessionIds = sortSessionIds(usedByProject.get(project.id) ?? [], sessions)
    const groups = new Map()
    for (const sessionId of sessionIds) {
      const row = rowOf(sessions, sessionId)
      const path = typeof row?.cwd === 'string' ? row.cwd : ''
      const key = path === '' ? '' : normalizePath(path)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(sessionId)
    }
    const directoryOrder = Array.isArray(project.directories) ? project.directories.map((directory) => normalizePath(directory)) : []
    const orderedKeys = [...groups.keys()].sort((left, right) => {
      if (left === '') return 1
      if (right === '') return -1
      const leftIndex = directoryOrder.indexOf(left)
      const rightIndex = directoryOrder.indexOf(right)
      if (leftIndex !== -1 || rightIndex !== -1) {
        if (leftIndex === -1) return 1
        if (rightIndex === -1) return -1
        return leftIndex - rightIndex
      }
      const latest = (key) => groups.get(key).reduce((max, id) => Math.max(max, rowOf(sessions, id)?.updatedAt ?? 0), 0)
      return latest(right) - latest(left)
    })
    const workspaces = orderedKeys.map((key) => {
      const workspace = key === '' ? undefined : workspaceByPath.get(key)
      return {
        key,
        path: key,
        title: workspace?.title ?? (key === '' ? '' : basename(key)),
        sessions: sortSessionIds(groups.get(key) ?? [], sessions),
      }
    })
    return { project, sessions: sessionIds, workspaces }
  })

  // Ungrouped sessions grouped by directory; sessions of deleted projects also land here.
  const ungroupedBuckets = new Map()
  for (const sessionId of visible) {
    if (pinnedSet.has(sessionId)) continue
    if (projectBySession.has(sessionId)) continue
    const row = rowOf(sessions, sessionId)
    const path = typeof row.cwd === 'string' ? row.cwd : ''
    const key = path === '' ? '' : normalizePath(path)
    if (!ungroupedBuckets.has(key)) ungroupedBuckets.set(key, [])
    ungroupedBuckets.get(key).push(sessionId)
  }
  const ungrouped = [...ungroupedBuckets.entries()].map(([key, ids]) => {
    const workspace = key === '' ? undefined : workspaceByPath.get(key)
    const title = workspace?.title ?? (key === '' ? '' : basename(key))
    const sorted = sortSessionIds(ids, sessions)
    const latest = sorted.reduce((max, id) => Math.max(max, rowOf(sessions, id)?.updatedAt ?? 0), 0)
    return { key, title, path: key, sessions: sorted, latest }
  })
  ungrouped.sort((left, right) => right.latest - left.latest)

  return {
    pinned,
    projects: projectSections,
    ungrouped,
    projectBySession,
    visibleCount: visible.length,
    totalCount: sessionIds.length,
  }
}

/**
 * Case-insensitive local search over a session's title, directory, project name
 * and workspace title.
 */
export function matchSession(sessions, workspaces, projectData, sessionId, query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (needle === '') return true
  const row = rowOf(sessions, sessionId)
  if (row === undefined) return false
  const project = resolveSessionProject(row, projectData)
  const haystack = [
    row.displayTitle,
    row.title,
    row.cwd,
    project?.name,
  ]
  const workspace = Array.isArray(workspaces?.items)
    ? workspaces.items.find((item) => samePath(item.path, row.cwd))
    : undefined
  if (workspace !== undefined) haystack.push(workspace.title)
  return haystack.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle))
}

/** Flatten every visible session id (pinned + projects + ungrouped) for search. */
export function allVisibleSessionIds(model) {
  const ids = [...model.pinned]
  for (const section of model.projects) ids.push(...section.sessions)
  for (const group of model.ungrouped) ids.push(...group.sessions)
  return ids
}

function makeStore(initial) {
  let snapshot = initial
  const listeners = new Set()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      snapshot = next
      for (const listener of [...listeners]) listener()
    },
  }
}

/**
 * Host-backed project state: GET /dsh-projects/state, POST /dsh-projects/mutate
 * and POST /dsh-projects/cwd. The store is a `{getSnapshot, subscribe}` source
 * bound by the slot renderer into the `useProjectState` hook.
 */
export function createProjectStateStore() {
  const store = makeStore({ phase: 'loading', data: null, error: null })
  let loadAttempt = null

  const set = (next) => store.set(next)

  async function requestJson(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-dsh-projects': '1',
        ...(options.headers ?? {}),
      },
    })
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    if (!response.ok || payload === null || payload.ok !== true) {
      const message = payload?.error?.message ?? `HTTP ${response.status}`
      const error = new Error(message)
      error.code = payload?.error?.code ?? `http-${response.status}`
      throw error
    }
    return payload
  }

  async function load() {
    if (loadAttempt !== null) return loadAttempt
    loadAttempt = (async () => {
      try {
        const payload = await requestJson('/dsh-projects/state', { method: 'GET', headers: { 'x-dsh-projects': '1' } })
        set({ phase: 'ready', data: payload.state, error: null })
      } catch (error) {
        set({ phase: 'error', data: store.getSnapshot().data, error: error instanceof Error ? error.message : String(error) })
      } finally {
        loadAttempt = null
      }
    })()
    return loadAttempt
  }

  /** Retry with backoff while the Host half is still mounting its routes. */
  async function loadWithRetry(attempts = 6) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await load()
      if (store.getSnapshot().phase === 'ready') return
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)))
    }
  }

  async function mutate(action, payload = {}) {
    const response = await requestJson('/dsh-projects/mutate', {
      method: 'POST',
      body: JSON.stringify({ action, payload }),
    })
    set({ phase: 'ready', data: response.state, error: null })
    return response.result ?? null
  }

  async function changeDirectory(sessionId, path) {
    const response = await requestJson('/dsh-projects/cwd', {
      method: 'POST',
      body: JSON.stringify({ sessionId, path }),
    })
    set({ phase: 'ready', data: response.state, error: null })
    return response.cwd
  }

  return { store, load, loadWithRetry, mutate, changeDirectory, requestJson }
}

const UI_STATE_KEY = 'dsh.projects.ui.v1'
const DEFAULT_UI_STATE = Object.freeze({
  collapsedProjects: [],
  collapsedGroups: [],
  showArchived: false,
  otherExpanded: true,
})

function readUiState() {
  try {
    const raw = localStorage.getItem(UI_STATE_KEY)
    if (raw === null) return { ...DEFAULT_UI_STATE }
    const parsed = JSON.parse(raw)
    return {
      collapsedProjects: Array.isArray(parsed.collapsedProjects) ? parsed.collapsedProjects.map(String) : [],
      collapsedGroups: Array.isArray(parsed.collapsedGroups) ? parsed.collapsedGroups.map(String) : [],
      showArchived: parsed.showArchived === true,
      otherExpanded: parsed.otherExpanded !== false,
    }
  } catch {
    return { ...DEFAULT_UI_STATE }
  }
}

/** Persisted sidebar viewing state (collapses, archived filter). */
export function createUiStateStore() {
  const store = makeStore(readUiState())
  const persist = (state) => {
    try {
      localStorage.setItem(UI_STATE_KEY, JSON.stringify(state))
    } catch {
      // private mode / quota: viewing state is best effort
    }
  }
  return {
    store,
    patch: (patch) => {
      const next = { ...store.getSnapshot(), ...patch }
      store.set(next)
      persist(next)
    },
  }
}
