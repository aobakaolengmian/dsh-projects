/**
 * Mock client runtime for the Projects sidebar harness.
 *
 * Reproduces just enough of the DSH client plugin host to run the real
 * `src/client/index.jsx` apply() and render the real Browser component:
 * slots capture, locale dictionaries, session/workspace snapshot stores,
 * session-status map, project-state store fetch routes, and the uiWorkspace
 * actions the component calls. No production code is mocked inside the
 * component itself.
 */

export function createMocks({ scenario = 'default', lang = 'zh' } = {}) {
  const now = Date.now()
  const minutes = (n) => now - n * 60_000
  const hours = (n) => now - n * 3_600_000
  const days = (n) => now - n * 86_400_000

  const workspaces = {
    items: [
      { workspaceId: 'w1', path: '/Users/example/Badstuff/dsh-projects', title: 'dsh-projects', sessionIds: [], createdAt: new Date(days(30)).toISOString(), updatedAt: new Date(minutes(5)).toISOString() },
      { workspaceId: 'w2', path: '/Users/example/Badstuff/Hoard', title: 'Hoard', sessionIds: [], createdAt: new Date(days(20)).toISOString(), updatedAt: new Date(days(1)).toISOString() },
      { workspaceId: 'w3', path: '/Users/example/Badstuff/LLM', title: 'LLM', sessionIds: [], createdAt: new Date(days(20)).toISOString(), updatedAt: new Date(days(3)).toISOString() },
      { workspaceId: 'w4', path: '/Users/example/Badstuff/Schoolwork', title: 'Schoolwork', sessionIds: [], createdAt: new Date(days(20)).toISOString(), updatedAt: new Date(days(2)).toISOString() },
      { workspaceId: 'w5', path: '/Users/example/Badstuff/Software', title: 'Software', sessionIds: [], createdAt: new Date(days(10)).toISOString(), updatedAt: new Date(hours(4)).toISOString() },
    ],
    archivedSessionIds: ['s10', 's11'],
    pinnedSessionIds: ['s2', 's13'],
    phase: 'ready',
    state: 'ready',
    error: null,
  }

  const projects = [
    {
      id: 'project-1',
      name: '桌面端改造',
      color: 'blue',
      directories: ['/Users/example/Badstuff/dsh-projects'],
      defaultDirectory: '/Users/example/Badstuff/dsh-projects',
      createdAt: new Date(days(9)).toISOString(),
      updatedAt: new Date(minutes(5)).toISOString(),
    },
    {
      id: 'project-2',
      name: '研究项目',
      color: 'purple',
      directories: ['/Users/example/Badstuff/Hoard', '/Users/example/Badstuff/LLM'],
      createdAt: new Date(days(7)).toISOString(),
      updatedAt: new Date(days(1)).toISOString(),
    },
    {
      id: 'project-3',
      name: '课程作业',
      color: 'green',
      directories: ['/Users/example/Badstuff/Schoolwork'],
      defaultDirectory: '/Users/example/Badstuff/Schoolwork',
      createdAt: new Date(days(4)).toISOString(),
      updatedAt: new Date(minutes(30)).toISOString(),
    },
  ]

  const sessionRows = [
    { id: 's1', title: '重写项目侧栏', cwd: '/Users/example/Badstuff/dsh-projects', updatedAt: minutes(5), running: true },
    { id: 's2', title: 'DSH 插件安装调试', cwd: '/Users/example/Badstuff/dsh-projects', updatedAt: hours(2) },
    { id: 's3', blank: true, cwd: '/Users/example/Badstuff/dsh-projects', updatedAt: minutes(1) },
    { id: 's4', title: 'Hoard 数据整理', cwd: '/Users/example/Badstuff/Hoard', updatedAt: days(1) },
    { id: 's5', title: 'README 润色', cwd: '/Users/example/Badstuff/LLM', updatedAt: days(3) },
    { id: 's6', title: '论文初稿', cwd: '/Users/example/Badstuff/Schoolwork', updatedAt: minutes(30) },
    { id: 's7', title: '作业3 计算', cwd: '/Users/example/Badstuff/Schoolwork', updatedAt: days(2) },
    { id: 's8', title: '杂项会话', cwd: '/Users/example/Badstuff/Software', updatedAt: hours(4) },
    { id: 's9', title: '实验笔记', cwd: '/Users/example/Badstuff/Software', updatedAt: hours(26) },
    { id: 's10', title: '旧会话 A', cwd: '/Users/example/Badstuff/dsh-projects', updatedAt: days(10) },
    { id: 's11', title: '旧会话 B', cwd: '/Users/example/Badstuff/Software', updatedAt: days(20) },
    { id: 's12', blank: true, cwd: '/Users/example/Badstuff/Software', updatedAt: hours(1) },
    { id: 's13', title: 'Pinned 旧项目', cwd: '/Users/example/Badstuff/Software', updatedAt: days(5) },
    { id: 's14', title: 'LLM 评测', cwd: '/Users/example/Badstuff/LLM', updatedAt: minutes(40), running: true },
    { id: 's15', title: '子代理会话', cwd: '/Users/example/Badstuff/dsh-projects', updatedAt: minutes(15), origin: 'subagent' },
    { id: 's16', title: '显式移出项目', cwd: '/Users/example/Badstuff/dsh-projects', updatedAt: hours(6) },
    { id: 's17', title: '这是一个非常非常长的会话标题用于测试省略号显示效果', cwd: '/Users/example/Badstuff/Software', updatedAt: days(4) },
    { id: 's18', blank: true, cwd: '/Users/example/Badstuff/Hoard', updatedAt: hours(3) },
    { id: 's19', title: '下载目录会话', cwd: '/Users/example/Downloads', updatedAt: hours(8) },
  ]

  const assignments = { s6: 'project-3', s16: null }

  const statusMap = new Map([
    ['s1', { running: true, pendingInteraction: undefined, completionUnread: false }],
    ['s6', { running: false, pendingInteraction: 'approval', completionUnread: false }],
    ['s7', { running: false, pendingInteraction: undefined, completionUnread: true }],
    ['s14', { running: true, pendingInteraction: undefined, completionUnread: false }],
  ])

  let legacyEmptyIds = []
  if (scenario === 'legacy') {
    sessionRows.push(
      { id: 's20', title: 'Badstuff', cwd: '/Users/example/Badstuff/Software', updatedAt: days(8) },
      { id: 's21', title: 'Badstuff', cwd: '/Users/example/Badstuff/Software', updatedAt: days(9) },
      { id: 's22', title: '真实内容会话', cwd: '/Users/example/Badstuff/Software', updatedAt: days(2) },
    )
    legacyEmptyIds = ['s20', 's21']
  }

  if (scenario === 'empty') {
    workspaces.items = []
    workspaces.pinnedSessionIds = []
    workspaces.archivedSessionIds = []
    projects.length = 0
    sessionRows.length = 0
    for (const key of Object.keys(assignments)) delete assignments[key]
  }

  if (scenario === 'minimal') {
    workspaces.items = [workspaces.items[0]]
    workspaces.pinnedSessionIds = []
    workspaces.archivedSessionIds = []
    projects.length = 0
    sessionRows.length = 0
    sessionRows.push(
      { id: 's1', title: '第一次会话', cwd: '/Users/example/Badstuff/dsh-projects', updatedAt: minutes(2) },
      { id: 's2', blank: true, cwd: '/Users/example/Badstuff/dsh-projects', updatedAt: minutes(1) },
    )
    for (const key of Object.keys(assignments)) delete assignments[key]
  }

  const projectData = {
    version: 1,
    projects,
    assignments,
    sessionCwd: {},
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

  const byId = {}
  for (const row of sessionRows) {
    byId[row.id] = {
      id: row.id,
      displayTitle: row.title ?? '(blank)',
      ...(row.title === undefined ? {} : { title: row.title }),
      ...(row.cwd === undefined ? {} : { cwd: row.cwd }),
      running: row.running === true,
      blank: row.blank === true,
      updatedAt: row.updatedAt,
      retainedBy: row.id === 's1' ? { mainView: 1 } : {},
      ...(row.origin === undefined ? {} : { origin: row.origin }),
    }
  }
  const sessions = makeStore({ ids: sessionRows.map((row) => row.id), byId, phase: 'ready', projectionsBySession: {} })
  const workspaceStore = makeStore({ ...workspaces, items: [...workspaces.items] })
  const statusStore = makeStore(statusMap)

  // ── project state routes ────────────────────────────────────────────────
  function statePayload() {
    return JSON.parse(JSON.stringify(projectData))
  }

  function randomColor() {
    const palette = ['blue', 'green', 'orange', 'purple', 'pink', 'teal', 'gray']
    return palette[projectData.projects.length % palette.length]
  }

  function mutate(action, payload) {
    if (action === 'project.create') {
      const project = {
        id: `project-${projectData.projects.length + 1}`,
        name: String(payload.name ?? '').trim(),
        color: payload.color ?? randomColor(),
        directories: Array.isArray(payload.directories) ? payload.directories : [],
        ...(payload.defaultDirectory === undefined ? {} : { defaultDirectory: payload.defaultDirectory }),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      projectData.projects = [...projectData.projects, project]
      return { project }
    }
    if (action === 'project.update') {
      projectData.projects = projectData.projects.map((project) => project.id === payload.projectId ? {
        ...project,
        ...(payload.name === undefined ? {} : { name: payload.name }),
        ...(payload.color === undefined ? {} : { color: payload.color }),
        ...(payload.directories === undefined ? {} : { directories: payload.directories }),
        ...(payload.defaultDirectory === undefined ? {} : { defaultDirectory: payload.defaultDirectory }),
        updatedAt: new Date().toISOString(),
      } : project)
      return {}
    }
    if (action === 'project.delete') {
      projectData.projects = projectData.projects.filter((project) => project.id !== payload.projectId)
      for (const [sessionId, projectId] of Object.entries(projectData.assignments)) {
        if (projectId === payload.projectId) delete projectData.assignments[sessionId]
      }
      return {}
    }
    if (action === 'session.assign') {
      projectData.assignments = { ...projectData.assignments, [payload.sessionId]: payload.projectId }
      return {}
    }
    throw new Error(`unknown action ${action}`)
  }

  function jsonResponse(payload, status = 200) {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    })
  }

  async function fetchMock(input, init = {}) {
    const url = typeof input === 'string' ? input : input.url
    const method = init.method ?? 'GET'
    if (url === '/dsh-projects/empty-sessions' && method === 'GET') {
      const snapshot = sessions.getSnapshot()
      const emptySessionIds = snapshot.ids.filter((id) => {
        const row = snapshot.byId[id]
        if (row === undefined) return false
        return row.blank === true || legacyEmptyIds.includes(id)
      })
      return jsonResponse({ ok: true, result: { emptySessionIds } })
    }
    if (url === '/dsh-projects/state') {
      if (scenario === 'error') return jsonResponse({ ok: false, error: { code: 'boom', message: 'mock failure' } }, 500)
      if (scenario === 'loading') return new Promise(() => {})
      return jsonResponse({ ok: true, state: statePayload() })
    }
    if (url === '/dsh-projects/mutate' && method === 'POST') {
      const body = JSON.parse(init.body ?? '{}')
      const result = mutate(body.action, body.payload ?? {})
      return jsonResponse({ ok: true, state: statePayload(), result })
    }
    if (url === '/dsh-projects/purge' && method === 'POST') {
      const body = JSON.parse(init.body ?? '{}')
      const requested = Array.isArray(body.sessionIds) ? body.sessionIds : []
      const purged = requested.filter((id) => sessions.getSnapshot().byId[id] !== undefined)
      const snapshot = sessions.getSnapshot()
      const nextById = { ...snapshot.byId }
      for (const id of purged) delete nextById[id]
      sessions.set({
        ...snapshot,
        ids: snapshot.ids.filter((id) => !purged.includes(id)),
        byId: nextById,
      })
      return jsonResponse({ ok: true, result: { purged, skipped: [] } })
    }
    if (url === '/dsh-projects/cwd' && method === 'POST') {
      const body = JSON.parse(init.body ?? '{}')
      projectData.sessionCwd = { ...projectData.sessionCwd, [body.sessionId]: body.path }
      const row = sessions.getSnapshot().byId[body.sessionId]
      if (row !== undefined) {
        sessions.set({
          ...sessions.getSnapshot(),
          byId: { ...sessions.getSnapshot().byId, [body.sessionId]: { ...row, cwd: body.path } },
        })
      }
      return jsonResponse({ ok: true, cwd: body.path, state: statePayload() })
    }
    return jsonResponse({ ok: false, error: { code: 'not-found', message: `no mock route ${url}` } }, 404)
  }

  // ── cordis-like context ─────────────────────────────────────────────────
  let registration = null
  let dictionaries = {}

  function selectCurrent(sessionId) {
    const snapshot = sessions.getSnapshot()
    const nextById = {}
    for (const [id, row] of Object.entries(snapshot.byId)) {
      nextById[id] = { ...row, retainedBy: id === sessionId ? { mainView: 1 } : {} }
    }
    sessions.set({ ...snapshot, byId: nextById })
  }

  const ctx = {
    effect: (fn) => {
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on: () => () => {},
    get: (name) => ctx[name],
    inject: (_services, callback) => callback(ctx),
    slots: {
      inject: (_key, callback) => {
        const result = callback()
        return typeof result === 'function' ? result : () => {}
      },
      register: (options, component) => {
        registration = { options, component }
        return () => {}
      },
      provideRoot: () => {},
    },
    locale: {
      register: (_ns, dicts) => {
        dictionaries = dicts
        return () => {}
      },
      bind: () => t,
      getLocale: () => ({ id: lang }),
    },
    sessions: {
      list: sessions,
      async create(options = {}) {
        const id = `s${100 + sessions.getSnapshot().ids.length}`
        const workspace =
          options.workspaceId === undefined
            ? undefined
            : workspaceStore.getSnapshot().items.find((item) => item.workspaceId === options.workspaceId)
        const row = {
          id,
          displayTitle: '(blank)',
          blank: true,
          running: false,
          updatedAt: Date.now(),
          retainedBy: {},
          ...(workspace === undefined ? {} : { cwd: workspace.path }),
        }
        sessions.set({
          ...sessions.getSnapshot(),
          ids: [...sessions.getSnapshot().ids, id],
          byId: { ...sessions.getSnapshot().byId, [id]: row },
        })
        return id
      },
      async using(_sessionId, _options, operation) {
        return operation({
          binding: {
            session: {
              rename: async (title) => {
                const snapshot = sessions.getSnapshot()
                const row = snapshot.byId[_sessionId]
                if (row !== undefined) {
                  sessions.set({
                    ...snapshot,
                    byId: {
                      ...snapshot.byId,
                      [_sessionId]: { ...row, title, displayTitle: title },
                    },
                  })
                }
                return { ok: true }
              },
            },
          },
        })
      },
      refreshProjections: async () => {},
      refresh: async () => {},
      search: async () => ({ ok: true, value: { items: [], hasMore: false } }),
    },
    workspaces: {
      list: workspaceStore,
      async rename(workspaceId, title) {
        const snapshot = workspaceStore.getSnapshot()
        const items = snapshot.items.map((item) => (item.workspaceId === workspaceId ? { ...item, title } : item))
        workspaceStore.set({ ...snapshot, items })
        return items.find((item) => item.workspaceId === workspaceId)
      },
      async delete(workspaceId) {
        const snapshot = workspaceStore.getSnapshot()
        workspaceStore.set({ ...snapshot, items: snapshot.items.filter((item) => item.workspaceId !== workspaceId) })
      },
      async create({ path }) {
        const workspace = {
          workspaceId: `w${workspaceStore.getSnapshot().items.length + 1}`,
          path,
          title: path.split('/').filter(Boolean).pop() ?? path,
          sessionIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }
        workspaceStore.set({
          ...workspaceStore.getSnapshot(),
          items: [...workspaceStore.getSnapshot().items, workspace],
        })
        return workspace
      },
    },
    uiWorkspace: {
      openSession: (sessionId) => selectCurrent(sessionId),
      async pickDirectory() {
        return '/Users/example/Badstuff/Extensions'
      },
      async pinSession(sessionId) {
        const snapshot = workspaceStore.getSnapshot()
        workspaceStore.set({ ...snapshot, pinnedSessionIds: [sessionId, ...snapshot.pinnedSessionIds.filter((id) => id !== sessionId)] })
      },
      async unpinSession(sessionId) {
        const snapshot = workspaceStore.getSnapshot()
        workspaceStore.set({ ...snapshot, pinnedSessionIds: snapshot.pinnedSessionIds.filter((id) => id !== sessionId) })
      },
      async archiveSession(sessionId, options = {}) {
        const state = statusStore.getSnapshot().get(sessionId)
        if (state?.running === true && options?.stopActivity !== true) {
          const error = new Error('session still has running work')
          error.code = 'workspace/session-active'
          error.rpcError = { code: 'workspace/session-active', message: error.message }
          throw error
        }
        const snapshot = workspaceStore.getSnapshot()
        workspaceStore.set({ ...snapshot, archivedSessionIds: [...snapshot.archivedSessionIds, sessionId] })
      },
      async unarchiveSession(sessionId) {
        const snapshot = workspaceStore.getSnapshot()
        workspaceStore.set({ ...snapshot, archivedSessionIds: snapshot.archivedSessionIds.filter((id) => id !== sessionId) })
      },
      async forkSession(sessionId) {
        const id = `s${200 + sessions.getSnapshot().ids.length}`
        const source = sessions.getSnapshot().byId[sessionId]
        sessions.set({
          ...sessions.getSnapshot(),
          ids: [...sessions.getSnapshot().ids, id],
          byId: {
            ...sessions.getSnapshot().byId,
            [id]: { id, displayTitle: `${source?.title ?? '会话'} (2)`, title: `${source?.title ?? '会话'} (2)`, cwd: source?.cwd, blank: false, running: false, updatedAt: Date.now(), retainedBy: {} },
          },
        })
        return id
      },
    },
  }

  function interpolate(template, params) {
    if (!params) return template
    return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }

  function t(key, params) {
    const dict = dictionaries[lang] ?? dictionaries.zh ?? {}
    const template = dict[key]
    if (template === undefined) return key
    return interpolate(template, params)
  }

  return {
    ctx,
    fetch: fetchMock,
    sessions,
    workspaces: workspaceStore,
    status: statusStore,
    getRegistration: () => registration,
    projectData: () => statePayload(),
  }
}
