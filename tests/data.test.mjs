/**
 * Unit tests for the pure sidebar model helpers (src/client/data.js).
 * Run: node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROJECT_COLORS,
  resolveProjectColor,
  normalizePath,
  samePath,
  basename,
  relativeTime,
  buildSidebarModel,
  matchSession,
  allVisibleSessionIds,
  resolveSessionProject,
} from '../src/client/data.js'

const PROJECT = (id, overrides = {}) => ({
  id,
  name: id,
  color: 'blue',
  directories: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...overrides,
})

const SESSION = (id, overrides = {}) => ({
  id,
  displayTitle: id,
  blank: false,
  running: false,
  updatedAt: 1_000,
  retainedBy: {},
  ...overrides,
})

function snapshots(rows, overrides = {}) {
  const byId = {}
  for (const row of rows) byId[row.id] = row
  return {
    sessions: { ids: rows.map((row) => row.id), byId, phase: 'ready', projectionsBySession: {} },
    workspaces: {
      items: [
        { workspaceId: 'w1', path: '/work/a', title: 'Alpha', sessionIds: [], createdAt: '', updatedAt: '' },
        { workspaceId: 'w2', path: '/work/b', title: 'Beta', sessionIds: [], createdAt: '', updatedAt: '' },
        { workspaceId: 'w3', path: '/work/c', title: 'Gamma', sessionIds: [], createdAt: '', updatedAt: '' },
      ],
      pinnedSessionIds: [],
      archivedSessionIds: [],
      phase: 'ready',
      state: 'ready',
      error: null,
      ...overrides,
    },
  }
}

test('palette is stable and resolves unknown colors to the first accent', () => {
  assert.equal(PROJECT_COLORS.length, 7)
  assert.equal(resolveProjectColor('purple'), '#8b5cf6')
  assert.equal(resolveProjectColor('nope'), PROJECT_COLORS[0].value)
  assert.equal(resolveProjectColor(undefined), PROJECT_COLORS[0].value)
})

test('path helpers normalize separators and trailing slashes', () => {
  assert.equal(normalizePath('/a/b//'), '/a/b')
  assert.equal(normalizePath('C:\\a\\b'), 'C:/a/b')
  assert.equal(basename('/a/b/c'), 'c')
  assert.equal(basename('/'), '/')
  assert.equal(basename(''), '')
  assert.equal(samePath('/a/b/', '/a/b'), true)
  assert.equal(samePath('/a/b', '/a/c'), false)
  assert.equal(samePath('', ''), false)
})

test('relativeTime buckets', () => {
  const now = Date.UTC(2026, 9, 17, 12, 0, 0)
  assert.equal(relativeTime(now - 10_000, now).unit, 'now')
  assert.deepEqual(relativeTime(now - 5 * 60_000, now), { unit: 'minute', n: 5 })
  assert.deepEqual(relativeTime(now - 3 * 3_600_000, now), { unit: 'hour', n: 3 })
  assert.deepEqual(relativeTime(now - 2 * 86_400_000, now), { unit: 'day', n: 2 })
  assert.deepEqual(relativeTime(0, now), { unit: 'now', n: 0 })
  const old = Date.UTC(2020, 0, 2)
  assert.equal(relativeTime(old, now).unit, 'date')
  assert.equal(relativeTime(now - 30 * 86_400_000, now).unit, 'date')
})

test('membership: explicit assignment, explicit ungrouped, and implicit directory match', () => {
  const data = {
    projects: [PROJECT('p1', { directories: ['/work/a'] }), PROJECT('p2')],
    assignments: { s2: 'p2', s3: null },
    sessionCwd: {},
  }
  assert.equal(resolveSessionProject(SESSION('s1', { cwd: '/work/a/' }), data)?.id, 'p1')
  assert.equal(resolveSessionProject(SESSION('s2', { cwd: '/work/a' }), data)?.id, 'p2')
  assert.equal(resolveSessionProject(SESSION('s3', { cwd: '/work/a' }), data), null)
  assert.equal(resolveSessionProject(SESSION('s4', { cwd: '' }), data), null)
  assert.equal(resolveSessionProject(SESSION('s5'), null), null)
})

test('model: pinned first, project sections, ungrouped by workspace, archived filtered', () => {
  const rows = [
    SESSION('pinned', { cwd: '/work/a', updatedAt: 10 }),
    SESSION('a1', { cwd: '/work/a', updatedAt: 300 }),
    SESSION('a2', { cwd: '/work/a', updatedAt: 200 }),
    SESSION('b1', { cwd: '/work/b', updatedAt: 500 }),
    SESSION('blank-b', { cwd: '/work/b', blank: true, updatedAt: 100 }),
    SESSION('archived-a', { cwd: '/work/a', updatedAt: 900 }),
    SESSION('sub', { cwd: '/work/a', origin: 'subagent', updatedAt: 999 }),
    SESSION('other', { cwd: '/work/c', updatedAt: 50 }),
    SESSION('loose', { cwd: '/work/unknown', updatedAt: 40 }),
    SESSION('nodir', { updatedAt: 30 }),
  ]
  const { sessions, workspaces } = snapshots(rows, {
    pinnedSessionIds: ['pinned'],
    archivedSessionIds: ['archived-a'],
  })
  const projectData = {
    projects: [PROJECT('p1', { name: 'One', directories: ['/work/a'] })],
    assignments: { a2: 'p1' },
    sessionCwd: {},
  }
  const model = buildSidebarModel({ sessions, workspaces, projectData, uiState: { showArchived: false } })
  assert.deepEqual(model.pinned, ['pinned'])
  assert.deepEqual(model.projects[0].sessions, ['a1', 'a2'])
  // sessions keep their workspace grouping inside the project
  assert.equal(model.projects[0].workspaces.length, 1)
  assert.equal(model.projects[0].workspaces[0].title, 'Alpha')
  assert.deepEqual(model.projects[0].workspaces[0].sessions, ['a1', 'a2'])
  assert.equal(model.projectBySession.get('a1')?.id, 'p1')
  assert.equal(model.projectBySession.get('a2')?.id, 'p1')
  // ungrouped: stale blank sessions are hidden, groups by latest update
  const labels = model.ungrouped.map((group) => group.title)
  assert.deepEqual(labels, ['Beta', 'Gamma', 'unknown', ''])
  assert.deepEqual(model.ungrouped[0].sessions, ['b1'])
  assert.equal(model.ungrouped[1].sessions[0], 'other')
  assert.equal(model.ungrouped[2].sessions[0], 'loose')
  assert.equal(model.ungrouped[3].sessions[0], 'nodir')
  assert.equal(model.visibleCount, 7)
  assert.equal(allVisibleSessionIds(model).includes('sub'), false)
  assert.equal(allVisibleSessionIds(model).includes('archived-a'), false)
  assert.equal(allVisibleSessionIds(model).includes('blank-b'), false)

  // the open blank session stays visible; other blanks remain hidden
  const withCurrent = buildSidebarModel({
    sessions,
    workspaces,
    projectData,
    uiState: { showArchived: false },
    currentSessionId: 'blank-b',
  })
  assert.deepEqual(withCurrent.ungrouped[0].sessions, ['blank-b', 'b1'])
  assert.equal(withCurrent.visibleCount, 8)

  const archivedModel = buildSidebarModel({ sessions, workspaces, projectData, uiState: { showArchived: true } })
  assert.equal(archivedModel.projects[0].sessions.includes('archived-a'), true)
  assert.equal(archivedModel.visibleCount, 8)
})

test('model keeps empty projects visible and drops deleted-project assignments into ungrouped', () => {
  const rows = [
    SESSION('s1', { cwd: '/work/a', updatedAt: 10 }),
    SESSION('s2', { cwd: '/work/a', updatedAt: 20 }),
  ]
  const { sessions, workspaces } = snapshots(rows)
  const projectData = {
    projects: [PROJECT('empty', { name: 'Empty' }), PROJECT('p1', { directories: ['/work/a'] })],
    assignments: { s2: 'deleted-project' },
    sessionCwd: {},
  }
  const model = buildSidebarModel({ sessions, workspaces, projectData, uiState: {} })
  assert.equal(model.projects.length, 2)
  assert.deepEqual(model.projects[0].sessions, [])
  assert.deepEqual(model.projects[1].sessions, ['s1'])
  assert.equal(model.projectBySession.has('s2'), false)
  assert.equal(model.ungrouped[0].sessions.includes('s2'), true)
})

test('Host-scanned legacy empty sessions are hidden unless current', () => {
  const rows = [
    SESSION('legacy-empty', { cwd: '/work/a', updatedAt: 300 }),
    SESSION('real', { cwd: '/work/a', updatedAt: 200 }),
  ]
  const { sessions, workspaces } = snapshots(rows)
  const projectData = { projects: [], assignments: {}, sessionCwd: {} }
  const hidden = buildSidebarModel({ sessions, workspaces, projectData, uiState: {}, hiddenEmptySessionIds: ['legacy-empty'] })
  assert.deepEqual(allVisibleSessionIds(hidden), ['real'])
  const visibleCurrent = buildSidebarModel({
    sessions,
    workspaces,
    projectData,
    uiState: {},
    hiddenEmptySessionIds: ['legacy-empty'],
    currentSessionId: 'legacy-empty',
  })
  assert.deepEqual(allVisibleSessionIds(visibleCurrent), ['legacy-empty', 'real'])
})

test('project workspace groups follow directory order and keep titles', () => {
  const rows = [
    SESSION('b1', { cwd: '/work/b', updatedAt: 10 }),
    SESSION('a1', { cwd: '/work/a', updatedAt: 20 }),
    SESSION('x1', { cwd: '/work/x', updatedAt: 30 }),
  ]
  const { sessions, workspaces } = snapshots(rows)
  const projectData = {
    projects: [PROJECT('p1', { directories: ['/work/b', '/work/a'], defaultDirectory: '/work/b' })],
    assignments: { x1: 'p1' },
    sessionCwd: {},
  }
  const model = buildSidebarModel({ sessions, workspaces, projectData, uiState: {} })
  const groups = model.projects[0].workspaces
  assert.deepEqual(groups.map((group) => group.title), ['Beta', 'Alpha', 'x'])
  assert.deepEqual(groups[0].sessions, ['b1'])
  assert.deepEqual(groups[1].sessions, ['a1'])
  assert.deepEqual(groups[2].sessions, ['x1'])
})

test('search matches title, directory, project name and workspace title', () => {
  const rows = [SESSION('s1', { cwd: '/work/a', displayTitle: 'Fix sidebar', title: 'Fix sidebar' })]
  const { sessions, workspaces } = snapshots(rows)
  const projectData = { projects: [PROJECT('p1', { name: '桌面端改造', directories: ['/work/a'] })], assignments: {}, sessionCwd: {} }
  assert.equal(matchSession(sessions, workspaces, projectData, 's1', 'sidebar'), true)
  assert.equal(matchSession(sessions, workspaces, projectData, 's1', '/work/a'), true)
  assert.equal(matchSession(sessions, workspaces, projectData, 's1', '桌面端'), true)
  assert.equal(matchSession(sessions, workspaces, projectData, 's1', 'alpha'), true)
  assert.equal(matchSession(sessions, workspaces, projectData, 's1', 'zzz'), false)
  assert.equal(matchSession(sessions, workspaces, projectData, 'missing', 'sidebar'), false)
  assert.equal(matchSession(sessions, workspaces, projectData, 's1', '  '), true)
})
