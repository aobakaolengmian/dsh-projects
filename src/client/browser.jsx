/**
 * Project-first sidebar browser for the Projects plugin.
 *
 * Renders into the shipped `sidebar.workspaces` slot (shadowing the workspace
 * browser) and receives:
 *   - owner props: `wide`, `expandSidebar`
 *   - `t(key, params)` locale seat (namespace `projects`)
 *   - `actions` (host-backed mutations, see actions.js)
 *   - bound hooks: `useProjectState`, `useUiState` (plugin stores) and the
 *     root-provided `useSessions`, `useWorkspaces`, `useSessionStatus`.
 *
 * Every visible string goes through `t(...)`; every mutation goes through
 * `actions` inside try/catch and surfaces failures with a toast. The visual
 * kit is imported from `./ui.jsx`; CSS class names are the frozen `pj-` list.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  PROJECT_COLORS,
  allVisibleSessionIds,
  basename,
  buildSidebarModel,
  colorIdAt,
  matchSession,
  normalizePath,
  resolveProjectColor,
  samePath,
  timeLabel,
} from './data.js'
import {
  Button,
  FolderGlyph,
  Icon,
  IconButton,
  Menu,
  Modal,
  Spinner,
  StatusDot,
  TextField,
  Toast,
} from './ui.jsx'

// ---------------------------------------------------------------------------
// Fallbacks and pure helpers
// ---------------------------------------------------------------------------

const EMPTY_SESSIONS = { ids: [], byId: {} }
const EMPTY_WORKSPACES = { items: [], pinnedSessionIds: [], archivedSessionIds: [] }
const EMPTY_PROJECT_STATE = { phase: 'loading', data: null, error: null }
const EMPTY_UI_STATE = Object.freeze({
  collapsedProjects: [],
  collapsedGroups: [],
  showArchived: false,
  otherExpanded: true,
})
const EMPTY_STATUS = new Map()

/** Sessions rendered before the "show more" affordance inside a workspace group. */
const GROUP_PAGE_SIZE = 8

/** Toast lifetime in ms (archive toast keeps the undo action longer). */
const TOAST_DURATION = 4200
const UNDO_TOAST_DURATION = 7000

/** Read a bound store hook defensively; the selector returns the full snapshot. */
function useStoreSnapshot(hook, fallback) {
  if (typeof hook !== 'function') return fallback
  const snapshot = hook((value) => value)
  if (snapshot === undefined || snapshot === null) return fallback
  return snapshot
}

/** Re-render relative times once a minute. */
function useNow(intervalMs = 60_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

function isCurrentSession(row) {
  return ((row?.retainedBy?.mainView ?? 0) > 0)
}

/**
 * Map an entry of `useSessionStatus` to a `StatusDot` state.
 * Returns null for idle sessions (the row shows an empty leading unit).
 */
function statusOf(statusMap, sessionId) {
  let status
  if (statusMap instanceof Map) status = statusMap.get(sessionId)
  else if (statusMap !== null && typeof statusMap === 'object') status = statusMap[sessionId]
  if (status === undefined || status === null) return null
  if (status.pendingInteraction === 'approval') return { state: 'warning', labelKey: 'status.approval' }
  if (status.pendingInteraction === 'plan-review') return { state: 'warning', labelKey: 'status.planReview' }
  if (status.pendingInteraction === 'question') return { state: 'warning', labelKey: 'status.answer' }
  if (status.running) return { state: 'running', labelKey: 'status.running' }
  if (status.completionUnread) return { state: 'done', labelKey: 'status.done' }
  return null
}

function errorMessage(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error ?? '')
}

function projectColorOf(project) {
  return resolveProjectColor(project?.color)
}

function anchorRectFromEvent(event) {
  const target = event?.currentTarget
  if (target !== null && target !== undefined && typeof target.getBoundingClientRect === 'function') {
    return target.getBoundingClientRect()
  }
  return null
}

/** Menu items take a rendered node (the kit places it in its icon slot). */
function menuIcon(name) {
  return <Icon name={name} size={14} />
}

const DIALOG_STACK = { display: 'flex', flexDirection: 'column', gap: 14 }
const DIALOG_ROW = { display: 'flex', alignItems: 'center', gap: 8 }
const DIALOG_LABEL = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 12,
  lineHeight: '18px',
}
const DIALOG_HINT = {
  color: 'var(--dsw-alias-label-tertiary)',
  fontSize: 12,
  lineHeight: '18px',
}
const DIALOG_ACTIONS = { display: 'flex', justifyContent: 'flex-end', gap: 8 }
const TRUNCATE = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}
/** Static section headers (pinned / search results) are not clickable. */
const STATIC_GROUP_HEADER = { cursor: 'default', background: 'transparent' }
/** Rail buttons are 36px (shipped); inline keeps them independent of CSS order. */
const RAIL_BUTTON_SIZE = { width: 36, height: 36 }

// ---------------------------------------------------------------------------
// Browser root
// ---------------------------------------------------------------------------

export function Browser({
  wide = true,
  expandSidebar,
  t,
  actions,
  useProjectState,
  useUiState,
  useSessions,
  useWorkspaces,
  useSessionStatus,
}) {
  const projectState = useStoreSnapshot(useProjectState, EMPTY_PROJECT_STATE)
  const uiState = useStoreSnapshot(useUiState, EMPTY_UI_STATE)
  const sessions = useStoreSnapshot(useSessions, EMPTY_SESSIONS)
  const workspaces = useStoreSnapshot(useWorkspaces, EMPTY_WORKSPACES)
  const statusMap = useStoreSnapshot(useSessionStatus, EMPTY_STATUS)
  const now = useNow()

  const projectData = projectState.data ?? null
  const phase = projectState.phase ?? 'loading'

  // --- local UI state ------------------------------------------------------
  const [searchExpanded, setSearchExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [menuState, setMenuState] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [toastState, setToastState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [expandedMoreGroups, setExpandedMoreGroups] = useState({})
  const [dragState, setDragState] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)
  const [emptySessionIds, setEmptySessionIds] = useState([])

  const searchInputRef = useRef(null)
  const pendingSubmenuRef = useRef(null)
  const toastSequenceRef = useRef(0)
  const lastFocusRef = useRef(null)

  // --- derived model -------------------------------------------------------
  const currentSessionId = useMemo(() => {
    const ids = Array.isArray(sessions.ids) ? sessions.ids : []
    for (const id of ids) {
      if (isCurrentSession(sessions.byId?.[id])) return id
    }
    return undefined
  }, [sessions])
  const model = useMemo(
    () =>
      buildSidebarModel({
        sessions,
        workspaces,
        projectData,
        uiState,
        currentSessionId,
        hiddenEmptySessionIds: emptySessionIds,
      }),
    [sessions, workspaces, projectData, uiState, currentSessionId, emptySessionIds],
  )
  const projects = useMemo(
    () => (Array.isArray(projectData?.projects) ? projectData.projects : []),
    [projectData],
  )
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects])
  const rows = sessions.byId ?? EMPTY_SESSIONS.byId
  const archivedSet = useMemo(
    () => new Set(Array.isArray(workspaces.archivedSessionIds) ? workspaces.archivedSessionIds : []),
    [workspaces],
  )
  const pinnedSet = useMemo(
    () => new Set(Array.isArray(workspaces.pinnedSessionIds) ? workspaces.pinnedSessionIds : []),
    [workspaces],
  )
  // Stale blank Sessions: created by the Host for "New Session" but never used.
  // They are hidden from the tree (only the open blank Session shows) and the
  // view menu offers a bulk cleanup that permanently removes them.
  const staleBlankSessionIds = useMemo(() => {
    const ids = new Set()
    for (const sessionId of Array.isArray(sessions.ids) ? sessions.ids : []) {
      const row = sessions.byId?.[sessionId]
      if (row?.blank !== true) continue
      if (row.origin === 'subagent') continue
      if (sessionId === currentSessionId) continue
      ids.add(sessionId)
    }
    for (const sessionId of emptySessionIds) {
      if (sessionId === currentSessionId) continue
      const row = sessions.byId?.[sessionId]
      if (row === undefined || row.origin === 'subagent') continue
      ids.add(sessionId)
    }
    return [...ids]
  }, [sessions, currentSessionId, emptySessionIds])
  const collapsedProjects = useMemo(
    () => new Set(Array.isArray(uiState.collapsedProjects) ? uiState.collapsedProjects : []),
    [uiState],
  )
  const collapsedGroups = useMemo(
    () => new Set(Array.isArray(uiState.collapsedGroups) ? uiState.collapsedGroups : []),
    [uiState],
  )
  const groupBySession = useMemo(() => {
    const map = new Map()
    for (const group of model.ungrouped) {
      for (const sessionId of group.sessions) map.set(sessionId, group)
    }
    return map
  }, [model])

  const trimmedQuery = query.trim()
  const searchActive = searchExpanded && trimmedQuery !== ''
  const searchResults = useMemo(() => {
    if (!searchActive) return []
    return allVisibleSessionIds(model).filter((sessionId) =>
      matchSession(sessions, workspaces, projectData, sessionId, trimmedQuery),
    )
  }, [searchActive, trimmedQuery, model, sessions, workspaces, projectData])

  // --- toasts --------------------------------------------------------------
  const showToast = useCallback((next) => {
    toastSequenceRef.current += 1
    setToastState({ ...next, id: toastSequenceRef.current })
  }, [])

  const failToast = useCallback(
    (error) => {
      showToast({ message: t('toast.failed', { message: errorMessage(error) }), duration: TOAST_DURATION })
    },
    [showToast, t],
  )

  useEffect(() => {
    if (searchExpanded && searchInputRef.current !== null) searchInputRef.current.focus()
  }, [searchExpanded])

  // Restore focus to the trigger element when a dialog closes (the kit Modal
  // handles focus-in; this avoids dropping focus back to <body>).
  useEffect(() => {
    if (dialog !== null) {
      if (lastFocusRef.current === null && typeof document !== 'undefined') {
        lastFocusRef.current = document.activeElement
      }
      return
    }
    const previous = lastFocusRef.current
    lastFocusRef.current = null
    if (previous !== null && previous !== undefined && previous.isConnected !== false && typeof previous.focus === 'function') {
      previous.focus()
    }
  }, [dialog])

  // --- small helpers -------------------------------------------------------
  // Ask the Host once per load which Sessions carry no conversation content
  // (legacy empty logs are not always marked blank by the Host catalog).
  useEffect(() => {
    if (projectState.phase !== 'ready') return undefined
    if (sessions.phase !== 'ready') return undefined
    let cancelled = false
    actions
      .scanEmptySessions()
      .then((result) => {
        if (!cancelled && result.supported) setEmptySessionIds(result.ids)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [projectState.phase, sessions.phase, actions])

  const closeMenu = useCallback(() => {
    setMenuState(null)
  }, [])

  const closeDialog = useCallback(() => {
    setDialog(null)
  }, [])

  /** Close the dialog only when the given dialog is still the open one. */
  const closeDialogIfCurrent = useCallback((target) => {
    setDialog((current) => (current === target ? null : current))
  }, [])

  function expandSidebarSafely() {
    try {
      if (typeof expandSidebar === 'function') expandSidebar()
    } catch (error) {
      failToast(error)
    }
  }

  function setUiStateSafe(patch) {
    try {
      actions.setUiState(patch)
    } catch (error) {
      failToast(error)
    }
  }

  function showArchivedToast(sessionId) {
    showToast({
      message: t('toast.archived'),
      actionLabel: t('toast.undo'),
      duration: UNDO_TOAST_DURATION,
      onAction: async () => {
        try {
          await actions.unarchiveSession(sessionId)
          showToast({ message: t('toast.unarchived') })
        } catch (error) {
          failToast(error)
        }
      },
    })
  }

  function ensureProjectExpanded(projectId) {
    if (!collapsedProjects.has(projectId)) return
    setUiStateSafe({ collapsedProjects: (uiState.collapsedProjects ?? []).filter((id) => id !== projectId) })
  }

  // --- collapse persistence ------------------------------------------------
  function toggleProjectCollapsed(projectId) {
    const next = new Set(uiState.collapsedProjects ?? [])
    if (next.has(projectId)) next.delete(projectId)
    else next.add(projectId)
    setUiStateSafe({ collapsedProjects: [...next] })
  }

  function toggleOtherExpanded() {
    setUiStateSafe({ otherExpanded: uiState.otherExpanded === false })
  }

  function toggleGroupCollapsed(groupKey) {
    const next = new Set(uiState.collapsedGroups ?? [])
    if (next.has(groupKey)) next.delete(groupKey)
    else next.add(groupKey)
    setUiStateSafe({ collapsedGroups: [...next] })
  }

  function collapseAll() {
    setUiStateSafe({
      collapsedProjects: model.projects.map((section) => section.project.id),
      collapsedGroups: model.ungrouped.map((group) => group.key),
      otherExpanded: false,
    })
  }

  function expandAll() {
    setUiStateSafe({ collapsedProjects: [], collapsedGroups: [], otherExpanded: true })
  }

  function toggleShowArchived() {
    setUiStateSafe({ showArchived: uiState.showArchived !== true })
  }

  async function retryLoad() {
    if (retrying) return
    setRetrying(true)
    try {
      await actions.refreshProjectState()
    } catch (error) {
      failToast(error)
    } finally {
      setRetrying(false)
    }
  }

  // --- session operations --------------------------------------------------
  function openSessionById(sessionId) {
    if (archivedSet.has(sessionId)) {
      showToast({ message: t('session.archivedHint') })
      return
    }
    try {
      actions.openSession(sessionId)
    } catch (error) {
      failToast(error)
    }
  }

  function openSessionMenu(sessionId, anchorRect) {
    setMenuState({ kind: 'session', sessionId, anchorRect })
  }

  function openProjectMenu(projectId, anchorRect) {
    setMenuState({ kind: 'project', projectId, anchorRect })
  }

  function openViewMenu(anchorRect) {
    setMenuState({ kind: 'view', anchorRect })
  }

  function openWorkspaceMenu(path, label, anchorRect, projectId = null) {
    setMenuState({ kind: 'workspace', path, label, projectId, anchorRect })
  }

  async function togglePin(sessionId, pinned) {
    try {
      await actions.setSessionPinned(sessionId, !pinned)
      showToast({ message: pinned ? t('toast.unpinned') : t('toast.pinned') })
    } catch (error) {
      failToast(error)
    }
  }

  async function archiveSessionFlow(sessionId) {
    try {
      await actions.archiveSession(sessionId)
      showArchivedToast(sessionId)
    } catch (error) {
      if (error !== null && typeof error === 'object' && error.code === 'workspace/session-active') {
        setDialog({ kind: 'archiveRunning', sessionId })
      } else {
        failToast(error)
      }
    }
  }

  async function forceArchiveSession(sessionId) {
    setBusy(true)
    try {
      await actions.forceArchiveSession(sessionId)
      closeDialogIfCurrent(dialog)
      showArchivedToast(sessionId)
    } catch (error) {
      failToast(error)
    } finally {
      setBusy(false)
    }
  }

  async function unarchiveSessionFlow(sessionId) {
    try {
      await actions.unarchiveSession(sessionId)
      showToast({ message: t('toast.unarchived') })
    } catch (error) {
      failToast(error)
    }
  }

  async function forkSessionFlow(sessionId) {
    try {
      await actions.forkSession(sessionId)
      showToast({ message: t('toast.forked') })
    } catch (error) {
      failToast(error)
    }
  }

  async function copySessionIdFlow(sessionId) {
    try {
      await actions.copySessionId(sessionId)
      showToast({ message: t('session.copyId.done') })
    } catch (error) {
      failToast(error)
    }
  }

  async function assignSessionFlow(sessionId, project) {
    try {
      if (project === null) {
        await actions.assignSession(sessionId, null)
        showToast({ message: t('toast.removedFromProject') })
      } else {
        await actions.assignSession(sessionId, project.id)
        showToast({ message: t('toast.moved', { name: project.name }) })
        ensureProjectExpanded(project.id)
      }
    } catch (error) {
      failToast(error)
    }
  }

  // --- drag & drop migration (session rows / workspace groups -> project) --
  const DRAG_MIME = 'application/x-dsh-projects'
  const OTHER_DROP_ID = '__other'

  function sessionProjectOf(sessionId) {
    return model.projectBySession.get(sessionId) ?? null
  }

  function startSessionDrag(event, sessionId) {
    const payload = JSON.stringify({ kind: 'session', sessionId })
    if (event.dataTransfer !== null) {
      event.dataTransfer.setData(DRAG_MIME, payload)
      event.dataTransfer.setData('text/plain', payload)
      event.dataTransfer.effectAllowed = 'move'
    }
    setDragState({ kind: 'session', sessionId })
  }

  function startWorkspaceDrag(event, path, label) {
    const payload = JSON.stringify({ kind: 'workspace', path })
    if (event.dataTransfer !== null) {
      event.dataTransfer.setData(DRAG_MIME, payload)
      event.dataTransfer.setData('text/plain', payload)
      event.dataTransfer.effectAllowed = 'move'
    }
    setDragState({ kind: 'workspace', path, label })
  }

  function endDrag() {
    setDragState(null)
    setDropTarget(null)
  }

  function handleDropDragOver(event, targetId) {
    if (dragState === null) return
    event.preventDefault()
    if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move'
    if (dropTarget !== targetId) setDropTarget(targetId)
  }

  function handleDropDragLeave(event, targetId) {
    const related = event.relatedTarget
    if (related instanceof Node && event.currentTarget.contains(related)) return
    setDropTarget((current) => (current === targetId ? null : current))
  }

  async function moveWorkspaceFlow(path, label, project) {
    try {
      const result = await actions.moveWorkspace(path, project === null ? null : project.id)
      if (project === null) {
        showToast({ message: t('toast.workspaceUnassigned', { name: label }) })
      } else {
        showToast({ message: t('toast.workspaceMoved', { name: label, project: project.name, n: result.sessions }) })
        ensureProjectExpanded(project.id)
      }
    } catch (error) {
      failToast(error)
    }
  }

  async function handleProjectDrop(event, project) {
    event.preventDefault()
    const payload = dragState
    setDragState(null)
    setDropTarget(null)
    if (payload === null) return
    if (payload.kind === 'session') {
      const current = sessionProjectOf(payload.sessionId)
      if (current !== null && current.id === project.id) return
      await assignSessionFlow(payload.sessionId, project)
      return
    }
    const group = model.ungrouped.find((entry) => entry.key === normalizePath(payload.path))
    const label = payload.label ?? group?.title ?? basename(payload.path)
    await moveWorkspaceFlow(payload.path, label, project)
  }

  async function handleOtherDrop(event) {
    event.preventDefault()
    const payload = dragState
    setDragState(null)
    setDropTarget(null)
    if (payload === null || payload.kind !== 'session') return
    if (sessionProjectOf(payload.sessionId) === null) return
    await assignSessionFlow(payload.sessionId, null)
  }

  async function changeDirectoryFlow(sessionId, path) {
    showToast({ message: t('session.changeDirectory.pending'), duration: 2000 })
    try {
      const canonical = await actions.changeWorkingDirectory(sessionId, path)
      showToast({ message: t('toast.cwdChanged', { path: canonical || path }) })
    } catch (error) {
      failToast(error)
    }
  }

  async function changeDirectoryOtherFlow(sessionId) {
    let picked
    try {
      picked = await actions.pickDirectory()
    } catch (error) {
      failToast(error)
      return
    }
    if (picked === null || picked === undefined || picked === '') return
    await changeDirectoryFlow(sessionId, picked)
  }

  async function runNewConversation(project, directory) {
    try {
      const sessionId = await actions.newConversation(project, directory)
      if (sessionId !== null && sessionId !== undefined && project !== null && project !== undefined) {
        ensureProjectExpanded(project.id)
      }
    } catch (error) {
      failToast(error)
    }
  }

  /** Header `+`: use the project default directory when there is one. */
  function newConversationFromHeader(project) {
    const directories = Array.isArray(project.directories) ? project.directories : []
    const preferred =
      typeof project.defaultDirectory === 'string' && project.defaultDirectory !== ''
        ? project.defaultDirectory
        : directories[0]
    runNewConversation(project, preferred === undefined ? undefined : preferred)
  }

  /** Project menu "new conversation": offer a directory chooser for multi-dir projects. */
  function newConversationFromMenu(project, anchorRect) {
    const directories = Array.isArray(project.directories) ? project.directories : []
    if (directories.length === 0) {
      setMenuState(null)
      runNewConversation(project, undefined)
      return
    }
    if (directories.length === 1) {
      setMenuState(null)
      runNewConversation(project, directories[0])
      return
    }
    // Chained menu: the kit Menu calls onClose after onSelect, so defer the
    // submenu to the next microtask (same pattern as the session submenus).
    requestSubmenu({ kind: 'newConversation', projectId: project.id, anchorRect })
  }

  function newConversationFromChooser(project, path) {
    runNewConversation(project, path === undefined ? undefined : path)
  }

  async function newConversationOtherFlow(project) {
    let picked
    try {
      picked = await actions.pickDirectory()
    } catch (error) {
      failToast(error)
      return
    }
    if (picked === null || picked === undefined || picked === '') return
    await runNewConversation(project, picked)
  }

  async function addFolderFlow(project) {
    let picked
    try {
      picked = await actions.pickDirectory()
    } catch (error) {
      failToast(error)
      return
    }
    if (picked === null || picked === undefined || picked === '') return
    const directories = Array.isArray(project.directories) ? project.directories : []
    if (directories.some((directory) => samePath(directory, picked))) return
    const nextDirectories = [...directories, picked]
    const patch = { directories: nextDirectories }
    if (typeof project.defaultDirectory !== 'string' || project.defaultDirectory === '') {
      patch.defaultDirectory = picked
    }
    try {
      await actions.updateProject(project.id, patch)
      showToast({ message: t('toast.folderAdded') })
    } catch (error) {
      failToast(error)
    }
  }

  // --- dialogs -------------------------------------------------------------
  function openNewProjectDialog() {
    setMenuState(null)
    setDialog({ kind: 'newProject' })
  }

  function openRailNewProject() {
    expandSidebarSafely()
    openNewProjectDialog()
  }

  async function pickDirectoryFromDialog() {
    try {
      return await actions.pickDirectory()
    } catch (error) {
      failToast(error)
      return null
    }
  }

  async function submitNewProject(values) {
    setBusy(true)
    try {
      const created = await actions.createProject(values)
      showToast({
        message: t('toast.projectCreated', { name: created?.name ?? values.name }),
      })
      closeDialogIfCurrent(dialog)
    } catch (error) {
      failToast(error)
    } finally {
      setBusy(false)
    }
  }

  async function submitRenameProject(projectId, name) {
    setBusy(true)
    try {
      await actions.updateProject(projectId, { name })
      showToast({ message: t('toast.projectUpdated') })
      closeDialogIfCurrent(dialog)
    } catch (error) {
      failToast(error)
    } finally {
      setBusy(false)
    }
  }

  async function submitDeleteProject(projectId) {
    setBusy(true)
    try {
      await actions.deleteProject(projectId)
      setUiStateSafe({
        collapsedProjects: (uiState.collapsedProjects ?? []).filter((id) => id !== projectId),
      })
      showToast({ message: t('toast.projectDeleted') })
      closeDialogIfCurrent(dialog)
    } catch (error) {
      failToast(error)
    } finally {
      setBusy(false)
    }
  }

  async function submitRenameWorkspace(path, title) {
    setBusy(true)
    try {
      await actions.renameWorkspace(path, title)
      showToast({ message: t('toast.workspaceRenamed', { name: title }) })
      closeDialogIfCurrent(dialog)
    } catch (error) {
      failToast(error)
    } finally {
      setBusy(false)
    }
  }

  async function submitDeleteWorkspace(path, label) {
    setBusy(true)
    try {
      await actions.deleteWorkspace(path)
      showToast({ message: t('toast.workspaceDeleted', { name: label }) })
      closeDialogIfCurrent(dialog)
    } catch (error) {
      failToast(error)
    } finally {
      setBusy(false)
    }
  }

  async function submitCleanupBlank() {
    const targets = [...staleBlankSessionIds]
    if (targets.length === 0) {
      closeDialogIfCurrent(dialog)
      return
    }
    setBusy(true)
    try {
      const result = await actions.purgeBlankSessions(targets)
      actions
        .scanEmptySessions()
        .then((scan) => {
          if (scan.supported) setEmptySessionIds(scan.ids)
        })
        .catch(() => {})
      let message
      if (result.fallback) {
        message = t('toast.blankArchiveFallback', { n: result.archived })
      } else if (result.purged > 0 && result.archived > 0) {
        message = t('toast.blankPartiallyPurged', { n: result.purged, m: result.archived })
      } else if (result.purged > 0) {
        message = t('toast.blankPurged', { n: result.purged })
      } else if (result.archived > 0) {
        message = t('toast.blankArchivedLive', { m: result.archived })
      } else {
        message = t('toast.blankNothing')
      }
      showToast({ message })
      closeDialogIfCurrent(dialog)
    } catch (error) {
      failToast(error)
    } finally {
      setBusy(false)
    }
  }

  async function submitRenameSession(sessionId, title) {
    setBusy(true)
    try {
      await actions.renameSession(sessionId, title)
      closeDialogIfCurrent(dialog)
    } catch (error) {
      failToast(error)
    } finally {
      setBusy(false)
    }
  }

  // --- menu ----------------------------------------------------------------
  function requestSubmenu(next) {
    pendingSubmenuRef.current = next
    setMenuState(null)
    queueMicrotask(() => {
      const pending = pendingSubmenuRef.current
      if (pending !== next) return
      pendingSubmenuRef.current = null
      setMenuState(next)
    })
  }

  function menuItemsFor(menu) {
    if (menu === null) return []
    if (menu.kind === 'view') {
      const items = [
        {
          id: 'showArchived',
          label: t('view.showArchived'),
          icon: menuIcon('archive'),
          checked: uiState.showArchived === true,
        },
        ...(staleBlankSessionIds.length > 0
          ? [{
              id: 'cleanupBlank',
              label: t('view.cleanupBlank', { n: staleBlankSessionIds.length }),
              icon: menuIcon('archive'),
              separatorBefore: true,
            }]
          : []),
        { id: 'collapseAll', label: t('view.collapseAll'), icon: menuIcon('collapse'), separatorBefore: true },
        { id: 'expandAll', label: t('view.expandAll'), icon: menuIcon('expand') },
      ]
      if (phase === 'error') {
        items.push({ id: 'retry', label: t('view.retry'), icon: menuIcon('refresh'), separatorBefore: true })
      }
      return items
    }
    if (menu.kind === 'project') {
      const project = projectById.get(menu.projectId)
      if (project === undefined) return []
      return [
        { id: 'newConversation', label: t('project.newConversation'), icon: menuIcon('plus') },
        { id: 'addFolder', label: t('project.folder.add'), icon: menuIcon('folder-plus') },
        ...(Array.isArray(project.directories) && project.directories.length > 0
          ? [{ id: 'moveDirectory', label: t('project.moveDirectory'), icon: menuIcon('move') }]
          : []),
        { id: 'renameProject', label: t('project.rename.action'), icon: menuIcon('pen'), separatorBefore: true },
        {
          id: 'deleteProject',
          label: t('project.delete.action'),
          icon: menuIcon('trash'),
          danger: true,
          separatorBefore: true,
        },
      ]
    }
    if (menu.kind === 'session') {
      const sessionId = menu.sessionId
      const row = rows[sessionId]
      const project = model.projectBySession.get(sessionId) ?? null
      const pinned = pinnedSet.has(sessionId)
      const archived = archivedSet.has(sessionId)
      const items = [
        { id: 'open', label: t('session.open'), icon: menuIcon('chat'), disabled: archived === true || row === undefined },
        { id: 'rename', label: t('session.rename'), icon: menuIcon('pen'), disabled: row === undefined },
        {
          id: 'pin',
          label: pinned ? t('session.unpin') : t('session.pin'),
          icon: menuIcon(pinned ? 'pin-off' : 'pin'),
          disabled: row === undefined,
        },
        {
          id: 'move',
          label: t('session.moveToProject'),
          icon: menuIcon('move'),
          separatorBefore: true,
          disabled: row === undefined,
        },
        { id: 'changeDirectory', label: t('session.changeDirectory'), icon: menuIcon('folder-open'), disabled: row === undefined },
        { id: 'fork', label: t('session.fork'), icon: menuIcon('fork'), disabled: row === undefined || row.blank === true },
        { id: 'copyId', label: t('session.copyId'), icon: menuIcon('copy'), disabled: row === undefined },
        archived
          ? {
              id: 'unarchive',
              label: t('session.unarchive'),
              icon: menuIcon('unarchive'),
              separatorBefore: true,
              disabled: row === undefined,
            }
          : {
              id: 'archive',
              label: t('session.archive'),
              icon: menuIcon('archive'),
              separatorBefore: true,
              disabled: row === undefined,
            },
      ]
      if (project !== null && row !== undefined) {
        items.push({
          id: 'removeFromProject',
          label: t('session.removeFromProject'),
          icon: menuIcon('close'),
          separatorBefore: true,
        })
      }
      return items
    }
    if (menu.kind === 'assign') {
      const current = model.projectBySession.get(menu.sessionId) ?? null
      const items = [{ id: '__heading', heading: true, label: t('session.moveToProject') }]
      for (const project of projects) {
        items.push({
          id: `assign:${project.id}`,
          label: project.name,
          icon: menuIcon('project'),
          checked: current !== null && current.id === project.id,
        })
      }
      items.push({
        id: 'assign:none',
        label: t('session.moveToProject.none'),
        icon: menuIcon('close'),
        checked: current === null,
        separatorBefore: true,
      })
      return items
    }
    if (menu.kind === 'workspace') {
      const project = menu.projectId === null || menu.projectId === undefined ? undefined : projectById.get(menu.projectId)
      const registered = actions.registeredWorkspace(menu.path)
      const items = []
      if (project !== undefined) {
        items.push({ id: 'newConversation', label: t('project.newConversation'), icon: menuIcon('plus') })
      }
      items.push({ id: 'moveToProject', label: t('workspace.moveToProject'), icon: menuIcon('move') })
      if (registered !== undefined) {
        items.push({ id: 'renameWorkspace', label: t('workspace.rename'), icon: menuIcon('pen') })
      }
      if (project !== undefined) {
        items.push({ id: 'removeFromProject', label: t('session.removeFromProject'), icon: menuIcon('close'), separatorBefore: true })
      }
      items.push({
        id: 'deleteWorkspace',
        label: t('workspace.delete'),
        icon: menuIcon('trash'),
        danger: true,
        separatorBefore: true,
      })
      return items
    }
    if (menu.kind === 'projectDirMove') {
      const project = projectById.get(menu.projectId)
      if (project === undefined) return []
      const directories = Array.isArray(project.directories) ? project.directories : []
      const items = [{ id: '__heading', heading: true, label: t('dirMove.title') }]
      if (directories.length === 0) {
        items.push({ id: '__empty', label: t('dirMove.empty'), icon: menuIcon('folder'), disabled: true })
      }
      for (const directory of directories) {
        items.push({
          id: `projdir:${directory}`,
          label: basename(directory) || directory,
          icon: menuIcon('folder'),
          shortcut: directory,
        })
      }
      return items
    }
    if (menu.kind === 'dirAssign') {
      const sourceProjectId = menu.sourceProjectId ?? null
      const items = [{ id: '__heading', heading: true, label: t('dirAssign.title') }]
      for (const project of projects) {
        if (project.id === sourceProjectId) continue
        items.push({
          id: `dirassign:${project.id}`,
          label: project.name,
          icon: menuIcon('project'),
        })
      }
      if (sourceProjectId !== null) {
        items.push({
          id: 'dirassign:none',
          label: t('dirAssign.none'),
          icon: menuIcon('close'),
          separatorBefore: true,
        })
      }
      return items
    }
    if (menu.kind === 'dir') {
      const sessionId = menu.sessionId
      const row = rows[sessionId]
      const project = model.projectBySession.get(sessionId) ?? null
      const directories = project !== null && Array.isArray(project.directories) ? project.directories : []
      const currentPath = typeof row?.cwd === 'string' ? row.cwd : ''
      const defaultDirectory =
        project !== null && typeof project.defaultDirectory === 'string' && project.defaultDirectory !== ''
          ? project.defaultDirectory
          : directories[0]
      const items = [{ id: '__heading', heading: true, label: t('session.changeDirectory.title') }]
      if (project !== null && directories.length === 0) {
        items.push({
          id: '__noDirectories',
          label: t('session.changeDirectory.noProject'),
          icon: menuIcon('folder'),
          disabled: true,
        })
      }
      for (const directory of directories) {
        items.push({
          id: `dir:${directory}`,
          label: directory,
          icon: menuIcon('folder'),
          checked: samePath(currentPath, directory),
          shortcut: samePath(defaultDirectory, directory) ? t('project.folder.default') : undefined,
        })
      }
      items.push({
        id: 'other',
        label: t('session.changeDirectory.other'),
        icon: menuIcon('folder-plus'),
        separatorBefore: directories.length > 0,
      })
      return items
    }
    if (menu.kind === 'newConversation') {
      const project = projectById.get(menu.projectId)
      if (project === undefined) return []
      const directories = Array.isArray(project.directories) ? project.directories : []
      const defaultDirectory =
        typeof project.defaultDirectory === 'string' && project.defaultDirectory !== ''
          ? project.defaultDirectory
          : directories[0]
      const items = [{ id: '__heading', heading: true, label: t('project.newConversation.title') }]
      for (const directory of directories) {
        items.push({
          id: `dir:${directory}`,
          label: directory,
          icon: menuIcon('folder'),
          checked: samePath(defaultDirectory, directory),
          shortcut: samePath(defaultDirectory, directory) ? t('project.folder.default') : undefined,
        })
      }
      items.push({
        id: 'other',
        label: t('session.changeDirectory.other'),
        icon: menuIcon('folder-plus'),
        separatorBefore: true,
      })
      return items
    }
    return []
  }

  function handleMenuSelect(selected) {
    const menu = menuState
    const id = typeof selected === 'string' ? selected : selected?.id
    if (menu === null || typeof id !== 'string' || id.startsWith('__')) return

    if (menu.kind === 'view') {
      setMenuState(null)
      if (id === 'showArchived') toggleShowArchived()
      else if (id === 'cleanupBlank') setDialog({ kind: 'cleanupBlank' })
      else if (id === 'collapseAll') collapseAll()
      else if (id === 'expandAll') expandAll()
      else if (id === 'retry') retryLoad()
      return
    }

    if (menu.kind === 'project') {
      const project = projectById.get(menu.projectId)
      if (project === undefined) {
        setMenuState(null)
        return
      }
      if (id === 'newConversation') {
        newConversationFromMenu(project, menu.anchorRect)
      } else if (id === 'addFolder') {
        setMenuState(null)
        addFolderFlow(project)
      } else if (id === 'moveDirectory') {
        requestSubmenu({ kind: 'projectDirMove', projectId: project.id, anchorRect: menu.anchorRect })
      } else if (id === 'renameProject') {
        setMenuState(null)
        setDialog({ kind: 'renameProject', projectId: project.id })
      } else if (id === 'deleteProject') {
        setMenuState(null)
        setDialog({ kind: 'deleteProject', projectId: project.id })
      }
      return
    }

    if (menu.kind === 'session') {
      const sessionId = menu.sessionId
      if (id === 'open') {
        setMenuState(null)
        openSessionById(sessionId)
      } else if (id === 'rename') {
        setMenuState(null)
        setDialog({ kind: 'renameSession', sessionId })
      } else if (id === 'pin') {
        setMenuState(null)
        togglePin(sessionId, pinnedSet.has(sessionId))
      } else if (id === 'move') {
        requestSubmenu({ kind: 'assign', sessionId, anchorRect: menu.anchorRect })
      } else if (id === 'changeDirectory') {
        requestSubmenu({ kind: 'dir', sessionId, anchorRect: menu.anchorRect })
      } else if (id === 'fork') {
        setMenuState(null)
        forkSessionFlow(sessionId)
      } else if (id === 'copyId') {
        setMenuState(null)
        copySessionIdFlow(sessionId)
      } else if (id === 'archive') {
        setMenuState(null)
        archiveSessionFlow(sessionId)
      } else if (id === 'unarchive') {
        setMenuState(null)
        unarchiveSessionFlow(sessionId)
      } else if (id === 'removeFromProject') {
        setMenuState(null)
        assignSessionFlow(sessionId, null)
      }
      return
    }

    if (menu.kind === 'projectDirMove') {
      if (!id.startsWith('projdir:')) {
        setMenuState(null)
        return
      }
      const path = id.slice('projdir:'.length)
      requestSubmenu({ kind: 'dirAssign', path, sourceProjectId: menu.projectId, anchorRect: menu.anchorRect })
      return
    }

    if (menu.kind === 'dirAssign') {
      const path = menu.path
      const label = basename(path) || path
      setMenuState(null)
      if (id === 'dirassign:none') {
        moveWorkspaceFlow(path, label, null)
        return
      }
      if (!id.startsWith('dirassign:')) return
      const project = projectById.get(id.slice('dirassign:'.length))
      if (project !== undefined) moveWorkspaceFlow(path, label, project)
      return
    }

    if (menu.kind === 'workspace') {
      const project = menu.projectId === null || menu.projectId === undefined ? undefined : projectById.get(menu.projectId)
      if (id === 'newConversation') {
        setMenuState(null)
        if (project !== undefined) runNewConversation(project, menu.path)
      } else if (id === 'moveToProject') {
        requestSubmenu({
          kind: 'dirAssign',
          path: menu.path,
          sourceProjectId: menu.projectId ?? null,
          anchorRect: menu.anchorRect,
        })
      } else if (id === 'renameWorkspace') {
        setMenuState(null)
        setDialog({ kind: 'renameWorkspace', path: menu.path, currentTitle: menu.label })
      } else if (id === 'removeFromProject') {
        setMenuState(null)
        moveWorkspaceFlow(menu.path, menu.label, null)
      } else if (id === 'deleteWorkspace') {
        setMenuState(null)
        setDialog({ kind: 'deleteWorkspace', path: menu.path, label: menu.label })
      }
      return
    }

    if (menu.kind === 'assign') {
      const target = id.startsWith('assign:') ? id.slice('assign:'.length) : ''
      setMenuState(null)
      if (target === 'none') assignSessionFlow(menu.sessionId, null)
      else {
        const project = projectById.get(target)
        if (project !== undefined) assignSessionFlow(menu.sessionId, project)
      }
      return
    }

    if (menu.kind === 'dir') {
      const row = rows[menu.sessionId]
      const currentPath = typeof row?.cwd === 'string' ? row.cwd : ''
      if (id === 'other') {
        setMenuState(null)
        changeDirectoryOtherFlow(menu.sessionId)
      } else if (id.startsWith('dir:')) {
        const directory = id.slice('dir:'.length)
        setMenuState(null)
        if (directory === '') return
        if (samePath(currentPath, directory)) return
        changeDirectoryFlow(menu.sessionId, directory)
      }
      return
    }

    if (menu.kind === 'newConversation') {
      const project = projectById.get(menu.projectId)
      if (project === undefined) {
        setMenuState(null)
        return
      }
      if (id === 'other') {
        setMenuState(null)
        newConversationOtherFlow(project)
      } else if (id.startsWith('dir:')) {
        const directory = id.slice('dir:'.length)
        setMenuState(null)
        if (directory === '') return
        newConversationFromChooser(project, directory)
      }
    }
  }

  // --- rendering helpers ---------------------------------------------------
  function renderSessionRow(sessionId, options = {}) {
    const row = rows[sessionId]
    if (row === undefined) return null
    const project = model.projectBySession.get(sessionId) ?? null
    let secondary
    let secondaryColor
    if (options.context === 'project') {
      if (project !== null) {
        secondary = project.name
        secondaryColor = projectColorOf(project)
      }
    } else if (options.context === 'search') {
      if (project !== null) {
        secondary = project.name
        secondaryColor = projectColorOf(project)
      } else {
        const group = groupBySession.get(sessionId)
        if (group !== undefined) {
          secondary = group.title || basename(group.path) || t('group.uncategorized')
        }
      }
    }
    const menuOpen =
      menuState !== null &&
      (menuState.kind === 'session' || menuState.kind === 'assign' || menuState.kind === 'dir') &&
      menuState.sessionId === sessionId
    return (
      <SessionRow
        key={sessionId}
        t={t}
        row={row}
        statusMap={statusMap}
        now={now}
        pinned={pinnedSet.has(sessionId)}
        selected={isCurrentSession(row)}
        archived={archivedSet.has(sessionId)}
        secondary={secondary}
        secondaryColor={secondaryColor}
        revealSecondaryOnHover={options.context === 'project'}
        menuOpen={menuOpen}
        draggable={row.blank !== true && !archivedSet.has(sessionId)}
        dragging={dragState !== null && dragState.kind === 'session' && dragState.sessionId === sessionId}
        onDragStart={(event) => startSessionDrag(event, sessionId)}
        onDragEnd={endDrag}
        onOpen={() => openSessionById(sessionId)}
        onOpenMenu={(anchorRect) => openSessionMenu(sessionId, anchorRect)}
      />
    )
  }

  function renderProjectSection(section) {
    const { project } = section
    return (
      <ProjectSection
        key={project.id}
        t={t}
        project={project}
        workspaces={section.workspaces}
        sessionIds={section.sessions}
        collapsed={collapsedProjects.has(project.id)}
        menuOpen={menuState !== null && menuState.kind === 'project' && menuState.projectId === project.id}
        dropActive={dropTarget === project.id}
        dropCandidate={dragState !== null}
        onToggle={() => toggleProjectCollapsed(project.id)}
        onNewConversation={() => newConversationFromHeader(project)}
        onOpenMenu={(anchorRect) => openProjectMenu(project.id, anchorRect)}
        onDragOver={(event) => handleDropDragOver(event, project.id)}
        onDragLeave={(event) => handleDropDragLeave(event, project.id)}
        onDrop={(event) => handleProjectDrop(event, project)}
        renderWorkspaceGroup={(group, owner) => renderWorkspaceGroupFor(group, owner)}
      />
    )
  }

  function renderWorkspaceGroupFor(group, owner) {
    const nested = owner !== null && owner !== undefined
    const storageKey = nested ? `${owner.id}:${group.key}` : group.key
    const elementKey = nested ? `${owner.id}:${group.key === '' ? '__uncategorized' : group.key}` : group.key === '' ? '__uncategorized' : group.key
    const label = group.title || basename(group.path) || t('group.uncategorized')
    const projectId = nested ? owner.id : null
    return (
      <WorkspaceGroup
        key={elementKey}
        t={t}
        group={group}
        nested={nested}
        collapsed={collapsedGroups.has(storageKey)}
        expanded={expandedMoreGroups[storageKey] === true}
        menuOpen={
          menuState !== null &&
          menuState.kind === 'workspace' &&
          menuState.path === group.path &&
          (menuState.projectId ?? null) === projectId
        }
        draggable={group.path !== ''}
        dragging={dragState !== null && dragState.kind === 'workspace' && dragState.path === group.path}
        onToggle={() => toggleGroupCollapsed(storageKey)}
        onShowMore={() => setExpandedMoreGroups((current) => ({ ...current, [storageKey]: true }))}
        onShowLess={() =>
          setExpandedMoreGroups((current) => {
            const next = { ...current }
            delete next[storageKey]
            return next
          })
        }
        onOpenMenu={(anchorRect) => openWorkspaceMenu(group.path, label, anchorRect, projectId)}
        onNewConversation={group.path === '' ? undefined : () => runNewConversation(nested ? owner : null, group.path)}
        onDragStart={(event) => startWorkspaceDrag(event, group.path, label)}
        onDragEnd={endDrag}
        renderRow={renderSessionRow}
      />
    )
  }

  function renderSections() {
    const blocks = []
    if (model.pinned.length > 0) {
      blocks.push(<PinnedSection key="pinned" t={t} sessionIds={model.pinned} renderRow={renderSessionRow} />)
    }
    for (const section of model.projects) blocks.push(renderProjectSection(section))
    if (model.ungrouped.length > 0) {
      blocks.push(
        <OtherSection
          key="other"
          t={t}
          groups={model.ungrouped}
          otherExpanded={uiState.otherExpanded !== false}
          dropActive={dropTarget === OTHER_DROP_ID}
          dropCandidate={dragState !== null && dragState.kind === 'session'}
          onToggleOther={toggleOtherExpanded}
          onDragOver={(event) => handleDropDragOver(event, OTHER_DROP_ID)}
          onDragLeave={(event) => handleDropDragLeave(event, OTHER_DROP_ID)}
          onDrop={handleOtherDrop}
          renderGroup={(group) => renderWorkspaceGroupFor(group, null)}
        />,
      )
    }
    if (blocks.length === 0) {
      blocks.push(<EmptyState key="empty" t={t} onCreateProject={openNewProjectDialog} />)
    }
    return blocks
  }

  function renderSearchResults() {
    if (searchResults.length === 0) {
      return (
        <div key="search-empty" className="pj-empty">
          {t('search.empty')}
        </div>
      )
    }
    return (
      <div key="search" className="pj-section" role="group">
        <div className="pj-group-header" style={STATIC_GROUP_HEADER}>
          <span className="pj-group-title">{t('search.results')}</span>
          <span className="pj-group-meta">{t('project.count', { n: searchResults.length })}</span>
        </div>
        {searchResults.map((sessionId) => renderSessionRow(sessionId, { context: 'search' }))}
      </div>
    )
  }

  function renderListBody() {
    if (phase === 'loading') {
      return <LoadingState key="loading" t={t} />
    }
    const blocks = []
    if (phase === 'error') {
      blocks.push(
        <ErrorState
          key="error"
          t={t}
          message={projectState.error}
          retrying={retrying}
          onRetry={retryLoad}
        />,
      )
    }
    blocks.push(searchActive ? renderSearchResults() : renderSections())
    return blocks
  }

  function renderMenu() {
    if (menuState === null) return null
    const items = menuItemsFor(menuState)
    if (items.length === 0) return null
    const minWidth =
      menuState.kind === 'assign' ||
      menuState.kind === 'dir' ||
      menuState.kind === 'newConversation' ||
      menuState.kind === 'workspace' ||
      menuState.kind === 'projectDirMove' ||
      menuState.kind === 'dirAssign'
        ? 280
        : 200
    return (
      <Menu
        key={`${menuState.kind}:${menuState.sessionId ?? menuState.projectId ?? menuState.path ?? ''}`}
        open
        anchorRect={menuState.anchorRect}
        items={items}
        minWidth={minWidth}
        onSelect={handleMenuSelect}
        onClose={closeMenu}
      />
    )
  }

  function renderDialogs() {
    if (dialog === null) return null
    if (dialog.kind === 'newProject') {
      return (
        <NewProjectDialog
          t={t}
          busy={busy}
          initialColor={colorIdAt(projects.length)}
          onPickDirectory={pickDirectoryFromDialog}
          onClose={closeDialog}
          onConfirm={submitNewProject}
        />
      )
    }
    if (dialog.kind === 'renameProject') {
      const project = projectById.get(dialog.projectId)
      if (project === undefined) return null
      return (
        <RenameProjectDialog
          t={t}
          busy={busy}
          initialName={project.name}
          onClose={closeDialog}
          onConfirm={(name) => submitRenameProject(project.id, name)}
        />
      )
    }
    if (dialog.kind === 'deleteProject') {
      const project = projectById.get(dialog.projectId)
      if (project === undefined) return null
      return (
        <DeleteProjectDialog
          t={t}
          busy={busy}
          projectName={project.name}
          onClose={closeDialog}
          onConfirm={() => submitDeleteProject(project.id)}
        />
      )
    }
    if (dialog.kind === 'renameSession') {
      const row = rows[dialog.sessionId]
      if (row === undefined) return null
      const initialTitle =
        row.blank === true
          ? ''
          : typeof row.title === 'string' && row.title !== ''
            ? row.title
            : typeof row.displayTitle === 'string'
              ? row.displayTitle
              : ''
      return (
        <RenameSessionDialog
          t={t}
          busy={busy}
          initialTitle={initialTitle}
          onClose={closeDialog}
          onConfirm={(title) => submitRenameSession(dialog.sessionId, title)}
        />
      )
    }
    if (dialog.kind === 'renameWorkspace') {
      return (
        <RenameWorkspaceDialog
          t={t}
          busy={busy}
          initialTitle={dialog.currentTitle ?? ''}
          onClose={closeDialog}
          onConfirm={(title) => submitRenameWorkspace(dialog.path, title)}
        />
      )
    }
    if (dialog.kind === 'deleteWorkspace') {
      return (
        <DeleteWorkspaceDialog
          t={t}
          busy={busy}
          workspaceName={dialog.label ?? basename(dialog.path)}
          onClose={closeDialog}
          onConfirm={() => submitDeleteWorkspace(dialog.path, dialog.label ?? basename(dialog.path))}
        />
      )
    }
    if (dialog.kind === 'cleanupBlank') {
      return (
        <CleanupBlankDialog
          t={t}
          busy={busy}
          count={staleBlankSessionIds.length}
          onClose={closeDialog}
          onConfirm={() => submitCleanupBlank()}
        />
      )
    }
    if (dialog.kind === 'archiveRunning') {
      return (
        <ArchiveRunningDialog
          t={t}
          busy={busy}
          onClose={closeDialog}
          onConfirm={() => forceArchiveSession(dialog.sessionId)}
        />
      )
    }
    return null
  }

  function renderToast() {
    if (toastState === null) return null
    const action = toastState.onAction
    return (
      <Toast
        key={toastState.id}
        message={toastState.message}
        actionLabel={toastState.actionLabel}
        duration={toastState.duration ?? TOAST_DURATION}
        onAction={
          typeof action === 'function'
            ? () => {
                setToastState(null)
                Promise.resolve()
                  .then(() => action())
                  .catch((error) => failToast(error))
              }
            : undefined
        }
        onDismiss={() => setToastState(null)}
      />
    )
  }

  function handleSearchKeyDown(event) {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    // One Escape clears the query and collapses the search (shipped behavior).
    setQuery('')
    setSearchExpanded(false)
  }

  // --- overlays shared by wide and rail layouts ----------------------------
  const overlays = (
    <>
      {renderMenu()}
      {renderDialogs()}
      {renderToast()}
    </>
  )

  // --- rail layout ---------------------------------------------------------
  if (!wide) {
    return (
      <div className="pj-root pj-root-rail">
        <div className="pj-rail">
          <IconButton
            className="pj-rail-btn"
            label={t('rail.newProject')}
            onClick={openRailNewProject}
            style={RAIL_BUTTON_SIZE}
          >
            <Icon name="folder-plus" size={20} />
          </IconButton>
          <IconButton
            className="pj-rail-btn"
            label={t('rail.expand')}
            onClick={expandSidebarSafely}
            style={RAIL_BUTTON_SIZE}
          >
            <Icon name="panel" size={20} />
          </IconButton>
        </div>
        {overlays}
      </div>
    )
  }

  // --- wide layout ---------------------------------------------------------
  return (
    <div className="pj-root">
      <BrowserHeader
        t={t}
        searchExpanded={searchExpanded}
        query={query}
        inputRef={searchInputRef}
        onExpandSearch={() => setSearchExpanded(true)}
        onCollapseSearch={() => {
          setQuery('')
          setSearchExpanded(false)
        }}
        onChangeQuery={setQuery}
        onClearSearch={() => {
          setQuery('')
          if (searchInputRef.current !== null) searchInputRef.current.focus()
        }}
        onSearchKeyDown={handleSearchKeyDown}
        onNewProject={openNewProjectDialog}
        onViewOptions={(anchorRect) => openViewMenu(anchorRect)}
      />
      <div
        className="pj-list"
        role="tree"
        aria-label={t('header.title')}
        onScroll={() => {
          // A fixed-position menu must not drift from its row when the list scrolls.
          if (menuState !== null) setMenuState(null)
        }}
      >
        {renderListBody()}
      </div>
      {overlays}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header (title / search / new project / view options)
// ---------------------------------------------------------------------------

function BrowserHeader({
  t,
  searchExpanded,
  query,
  inputRef,
  onExpandSearch,
  onCollapseSearch,
  onChangeQuery,
  onClearSearch,
  onSearchKeyDown,
  onNewProject,
  onViewOptions,
}) {
  return (
    <div className="pj-header">
      {searchExpanded ? null : <span className="pj-title">{t('header.title')}</span>}
      <div className={searchExpanded ? 'pj-search pj-search-expanded' : 'pj-search'}>
        <IconButton label={t('header.search')} onClick={searchExpanded ? onCollapseSearch : onExpandSearch}>
          <Icon name="search" size={16} />
        </IconButton>
        {searchExpanded ? (
          <input
            ref={inputRef}
            className="pj-search-input"
            type="text"
            value={query}
            placeholder={t('search.placeholder')}
            aria-label={t('search.placeholder')}
            onChange={(event) => onChangeQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        ) : null}
        {searchExpanded && query !== '' ? (
          <IconButton className="pj-search-clear" label={t('search.clear')} onClick={onClearSearch}>
            <Icon name="close" size={14} />
          </IconButton>
        ) : null}
      </div>
      {searchExpanded ? null : (
        <div className="pj-header-actions">
          <IconButton label={t('header.newProject')} onClick={onNewProject}>
            <Icon name="plus" size={16} />
          </IconButton>
          <span
            style={{ display: 'inline-flex' }}
            onClick={(event) => {
              event.stopPropagation()
              onViewOptions(anchorRectFromEvent(event))
            }}
          >
            <IconButton label={t('header.viewOptions')}>
              <Icon name="dots" size={16} />
            </IconButton>
          </span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/** Reusable collapsible section header (project / other / workspace group). */
function SectionHeader({
  t,
  collapsed,
  onToggle,
  leading,
  title,
  meta,
  actions,
  menuOpen,
  ariaLabel,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
}) {
  const collapsible = typeof onToggle === 'function'
  const className = ['pj-group-header']
  if (menuOpen) className.push('pj-session-menu-open')
  const handleKeyDown = (event) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      onToggle()
    }
  }
  return (
    <div
      className={dragging === true ? `${className.join(' ')} pj-dragging` : className.join(' ')}
      role={collapsible ? 'button' : undefined}
      tabIndex={collapsible ? 0 : undefined}
      aria-expanded={collapsible ? collapsed !== true : undefined}
      aria-label={ariaLabel}
      draggable={draggable === true ? true : undefined}
      onDragStart={draggable === true ? onDragStart : undefined}
      onDragEnd={draggable === true ? onDragEnd : undefined}
      onClick={
        collapsible
          ? (event) => {
              if (
                event.target !== null &&
                typeof event.target.closest === 'function' &&
                event.target.closest('button')
              ) {
                return
              }
              onToggle()
            }
          : undefined
      }
      onKeyDown={collapsible ? handleKeyDown : undefined}
    >
      {collapsible ? (
        <span className={collapsed ? 'pj-chevron' : 'pj-chevron pj-chevron-open'} aria-hidden="true">
          <Icon name="chevron" size={12} />
        </span>
      ) : null}
      {leading}
      <span className="pj-group-title">{title}</span>
      {meta !== undefined && meta !== null ? <span className="pj-group-meta">{meta}</span> : null}
      {actions !== undefined && actions !== null ? (
        <span className="pj-group-actions" onClick={(event) => event.stopPropagation()}>
          {actions}
        </span>
      ) : null}
    </div>
  )
}

function PinnedSection({ t, sessionIds, renderRow }) {
  return (
    <div className="pj-pin-section" role="group">
      <div className="pj-group-header" style={STATIC_GROUP_HEADER}>
        <span className="pj-folder" style={{ display: 'inline-flex' }} aria-hidden="true">
          <Icon name="pin" size={14} />
        </span>
        <span className="pj-group-title">{t('group.pinned')}</span>
        <span className="pj-group-meta">{t('project.count', { n: sessionIds.length })}</span>
      </div>
      {sessionIds.map((sessionId) => renderRow(sessionId, { context: 'project' }))}
    </div>
  )
}

function ProjectSection({
  t,
  project,
  workspaces,
  sessionIds,
  collapsed,
  menuOpen,
  dropActive,
  dropCandidate,
  onToggle,
  onNewConversation,
  onOpenMenu,
  onDragOver,
  onDragLeave,
  onDrop,
  renderWorkspaceGroup,
}) {
  const color = projectColorOf(project)
  const lead = (
    <span className="pj-folder pj-project-glyph" style={color === undefined ? undefined : { color }} aria-hidden="true">
      <Icon name="project" size={15} />
    </span>
  )
  const actions = [
    <IconButton key="new" label={t('project.newConversation')} onClick={onNewConversation}>
      <Icon name="plus" size={14} />
    </IconButton>,
    <span
      key="menu"
      style={{ display: 'inline-flex' }}
      onClick={(event) => {
        event.stopPropagation()
        onOpenMenu(anchorRectFromEvent(event))
      }}
    >
      <IconButton label={t('project.menu')}>
        <Icon name="dots" size={14} />
      </IconButton>
    </span>,
  ]
  const sectionClassName = ['pj-section']
  if (dropCandidate) sectionClassName.push('pj-drop-candidate')
  if (dropActive) sectionClassName.push('pj-drop-active')
  return (
    <div
      className={sectionClassName.join(' ')}
      role="group"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <SectionHeader
        t={t}
        collapsed={collapsed}
        onToggle={onToggle}
        leading={lead}
        title={project.name}
        meta={sessionIds.length > 0 ? t('project.count', { n: sessionIds.length }) : undefined}
        actions={actions}
        menuOpen={menuOpen}
        ariaLabel={project.name}
      />
      {collapsed ? null : sessionIds.length === 0 ? (
        <div
          className="pj-empty-hint"
          style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}
        >
          <span>{t('project.noConversations')}</span>
          <span>{t('project.startHint')}</span>
        </div>
      ) : (
        <div className="pj-project-workspaces">
          {workspaces.map((group) => renderWorkspaceGroup(group, project))}
        </div>
      )}
    </div>
  )
}

function OtherSection({
  t,
  groups,
  otherExpanded,
  dropActive,
  dropCandidate,
  onToggleOther,
  onDragOver,
  onDragLeave,
  onDrop,
  renderGroup,
}) {
  const total = groups.reduce((sum, group) => sum + group.sessions.length, 0)
  const sectionClassName = ['pj-other-section']
  if (dropCandidate) sectionClassName.push('pj-drop-candidate')
  if (dropActive) sectionClassName.push('pj-drop-active')
  return (
    <div
      className={sectionClassName.join(' ')}
      role="group"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <SectionHeader
        t={t}
        collapsed={!otherExpanded}
        onToggle={onToggleOther}
        leading={
          <span className="pj-folder" aria-hidden="true">
            <Icon name="chat" size={15} />
          </span>
        }
        title={t('group.other')}
        meta={total > 0 ? t('project.count', { n: total }) : undefined}
        ariaLabel={t('group.other')}
      />
      {otherExpanded ? groups.map((group, index) => renderGroup(group, index)) : null}
    </div>
  )
}

function WorkspaceGroup({
  t,
  group,
  nested,
  collapsed,
  expanded,
  menuOpen,
  draggable,
  dragging,
  onToggle,
  onShowMore,
  onShowLess,
  onOpenMenu,
  onNewConversation,
  onDragStart,
  onDragEnd,
  renderRow,
}) {
  const title = group.title || basename(group.path) || t('group.uncategorized')
  const visibleIds = expanded ? group.sessions : group.sessions.slice(0, GROUP_PAGE_SIZE)
  const remaining = group.sessions.length - visibleIds.length
  const showMore =
    !collapsed && remaining > 0 ? (
      <button type="button" className="pj-more" onClick={onShowMore}>
        {t('group.showMore', { n: remaining })}
      </button>
    ) : null
  const showLess =
    !collapsed && expanded && group.sessions.length > GROUP_PAGE_SIZE ? (
      <button type="button" className="pj-more" onClick={onShowLess}>
        {t('group.showLess')}
      </button>
    ) : null
  const actions =
    group.path === ''
      ? undefined
      : [
          ...(onNewConversation === undefined
            ? []
            : [
                <span
                  key="new"
                  style={{ display: 'inline-flex' }}
                  onClick={(event) => {
                    event.stopPropagation()
                    onNewConversation()
                  }}
                >
                  <IconButton label={t('workspace.newConversation')}>
                    <Icon name="plus" size={14} />
                  </IconButton>
                </span>,
              ]),
          <span
            key="menu"
            style={{ display: 'inline-flex' }}
            onClick={(event) => {
              event.stopPropagation()
              onOpenMenu(anchorRectFromEvent(event))
            }}
          >
            <IconButton label={t('workspace.menu')}>
              <Icon name="dots" size={14} />
            </IconButton>
          </span>,
        ]
  return (
    <div className={nested ? 'pj-group pj-group-nested' : 'pj-group'} role="group">
      <SectionHeader
        t={t}
        collapsed={collapsed}
        onToggle={onToggle}
        leading={
          <span className="pj-folder" aria-hidden="true">
            <Icon name={collapsed ? 'folder' : 'folder-open'} size={15} />
          </span>
        }
        title={title}
        meta={group.sessions.length > 0 ? t('project.count', { n: group.sessions.length }) : undefined}
        ariaLabel={title}
        actions={actions}
        menuOpen={menuOpen}
        draggable={draggable}
        dragging={dragging}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      />
      {collapsed ? null : visibleIds.map((sessionId) => renderRow(sessionId))}
      {showMore}
      {showLess}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Session row
// ---------------------------------------------------------------------------

function SessionRow({
  t,
  row,
  statusMap,
  now,
  pinned,
  selected,
  archived,
  secondary,
  secondaryColor,
  revealSecondaryOnHover,
  menuOpen,
  draggable,
  dragging,
  onDragStart,
  onDragEnd,
  onOpen,
  onOpenMenu,
}) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const status = statusOf(statusMap, row.id)
  const title = row.blank ? t('session.new') : row.displayTitle || row.title || t('session.new')
  const className = ['pj-session']
  if (selected) className.push('pj-session-selected')
  if (archived) className.push('pj-session-archived')
  if (menuOpen) className.push('pj-session-menu-open')
  if (dragging) className.push('pj-dragging')

  const handleKeyDown = (event) => {
    if (event.target !== event.currentTarget) return
    if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
      event.preventDefault()
      onOpen()
    }
  }

  const hasSecondary = secondary !== undefined && secondary !== null && secondary !== ''
  const showSecondary =
    hasSecondary &&
    (revealSecondaryOnHover !== true || hovered === true || focused === true || selected === true || menuOpen === true)
  return (
    <div
      className={className.join(' ')}
      role="treeitem"
      tabIndex={0}
      data-row-key={`session:${row.id}`}
      aria-selected={selected ? 'true' : 'false'}
      aria-current={selected ? 'true' : undefined}
      title={archived ? t('session.archivedHint') : title}
      draggable={draggable === true ? true : undefined}
      onDragStart={draggable === true ? onDragStart : undefined}
      onDragEnd={draggable === true ? onDragEnd : undefined}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
    >
      <span className="pj-session-leading">
        {status === null ? null : <StatusDot state={status.state} label={t(status.labelKey)} />}
      </span>
      <span className="pj-session-title">{title}</span>
      {showSecondary ? (
        <span
          className="pj-session-badge"
          title={secondary}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginLeft: 0 }}
        >
          {secondaryColor ? (
            <span
              aria-hidden="true"
              style={{ flex: 'none', width: 6, height: 6, borderRadius: '50%', background: secondaryColor }}
            />
          ) : null}
          <span style={TRUNCATE}>{secondary}</span>
        </span>
      ) : null}
      {pinned ? (
        <span className="pj-pin" title={t('session.pinned')} aria-label={t('session.pinned')}>
          <Icon name="pin" size={12} />
        </span>
      ) : null}
      <span className="pj-session-time">{timeLabel(row.updatedAt, now, t)}</span>
      <span
        className="pj-session-actions"
        onClick={(event) => {
          event.stopPropagation()
          onOpenMenu(anchorRectFromEvent(event))
        }}
      >
        <IconButton label={t('session.actions')}>
          <Icon name="dots" size={14} />
        </IconButton>
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Loading / error / empty states
// ---------------------------------------------------------------------------

function LoadingState({ t }) {
  return (
    <div className="pj-loading" role="status" aria-live="polite">
      <Spinner size={14} />
      <span>{t('view.loading')}</span>
    </div>
  )
}

function ErrorState({ t, message, retrying, onRetry }) {
  return (
    <div className="pj-error" role="alert">
      <span>{t('view.loadError', { message: errorMessage(message) })}</span>
      <div>
        <Button variant="outline" onClick={onRetry} disabled={retrying === true}>
          {retrying ? t('common.loading') : t('view.retry')}
        </Button>
      </div>
    </div>
  )
}

function EmptyState({ t, onCreateProject }) {
  return (
    <div className="pj-empty-state">
      <Icon name="project" size={36} />
      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' }}>{t('empty.title')}</span>
      <span
        style={{
          maxWidth: 220,
          textAlign: 'center',
          fontSize: 12,
          lineHeight: '18px',
          color: 'var(--dsw-alias-label-tertiary)',
        }}
      >
        {t('empty.description')}
      </span>
      <button type="button" className="pj-empty-action" onClick={onCreateProject}>
        {t('project.create')}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

function NewProjectDialog({ t, busy, initialColor, onPickDirectory, onClose, onConfirm }) {
  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  const [color, setColor] = useState(initialColor)
  const canSubmit = name.trim() !== '' && busy !== true

  async function pick() {
    const picked = await onPickDirectory()
    if (typeof picked === 'string' && picked !== '') setDirectory(picked)
  }

  function submit() {
    if (!canSubmit) return
    onConfirm({ name: name.trim(), directories: directory === '' ? [] : [directory], color })
  }

  const footer = (
    <div style={DIALOG_ACTIONS}>
      <Button variant="outline" onClick={onClose} disabled={busy === true}>
        {t('common.cancel')}
      </Button>
      <Button variant="primary" onClick={submit} disabled={!canSubmit}>
        {busy === true ? t('common.loading') : t('project.create')}
      </Button>
    </div>
  )

  return (
    <Modal
      open
      closeLabel={t('common.close')}
      title={t('project.new.title')}
      description={t('project.new.description')}
      footer={footer}
      onClose={onClose}
    >
      <div style={DIALOG_STACK}>
        <TextField
          label={t('project.name.label')}
          value={name}
          onChange={setName}
          placeholder={t('project.name.placeholder')}
          autoFocus
          disabled={busy === true}
          onEnter={submit}
        />
        <div>
          <div style={DIALOG_LABEL}>{t('project.folder.label')}</div>
          {directory === '' ? (
            <div style={DIALOG_ROW}>
              <span style={{ ...DIALOG_HINT, flex: '1 1 auto', ...TRUNCATE }}>{t('project.folder.none')}</span>
              <Button variant="outline" onClick={pick} disabled={busy === true}>
                {t('project.folder.choose')}
              </Button>
            </div>
          ) : (
            <div style={DIALOG_ROW}>
              <span style={{ flex: 'none', display: 'inline-flex' }} aria-hidden="true">
                <FolderGlyph color={resolveProjectColor(color)} size={16} open />
              </span>
              <span style={{ flex: '1 1 auto', ...TRUNCATE }} title={directory}>
                {basename(directory) || directory}
              </span>
              <IconButton label={t('project.folder.remove')} onClick={() => setDirectory('')} disabled={busy === true}>
                <Icon name="close" size={14} />
              </IconButton>
            </div>
          )}
          <div style={{ ...DIALOG_HINT, marginTop: 4 }}>{t('project.folder.pickHint')}</div>
        </div>
        <div>
          <div style={DIALOG_LABEL}>{t('project.color.label')}</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            {PROJECT_COLORS.map((entry) => {
              const selected = entry.id === color
              return (
                <button
                  key={entry.id}
                  type="button"
                  className="pj-project-accent"
                  aria-label={t('project.color.label') + ': ' + entry.id}
                  aria-pressed={selected}
                  disabled={busy === true}
                  onClick={() => setColor(entry.id)}
                  style={{
                    width: 24,
                    height: 24,
                    padding: 0,
                    borderRadius: '50%',
                    cursor: 'pointer',
                    background: entry.value,
                    boxSizing: 'border-box',
                  }}
                />
              )
            })}
          </div>
        </div>
      </div>
    </Modal>
  )
}

function RenameProjectDialog({ t, busy, initialName, onClose, onConfirm }) {
  const [name, setName] = useState(initialName)
  const canSubmit = name.trim() !== '' && busy !== true

  function submit() {
    if (!canSubmit) return
    onConfirm(name.trim())
  }

  const footer = (
    <div style={DIALOG_ACTIONS}>
      <Button variant="outline" onClick={onClose} disabled={busy === true}>
        {t('common.cancel')}
      </Button>
      <Button variant="primary" onClick={submit} disabled={!canSubmit}>
        {busy === true ? t('common.loading') : t('common.save')}
      </Button>
    </div>
  )

  return (
    <Modal open closeLabel={t('common.close')} title={t('project.rename.title')} footer={footer} onClose={onClose}>
      <TextField
        label={t('project.name.label')}
        value={name}
        onChange={setName}
        placeholder={t('project.name.placeholder')}
        autoFocus
        disabled={busy === true}
        onEnter={submit}
      />
    </Modal>
  )
}

function DeleteProjectDialog({ t, busy, projectName, onClose, onConfirm }) {
  const footer = (
    <div style={DIALOG_ACTIONS}>
      <Button variant="outline" onClick={onClose} disabled={busy === true}>
        {t('common.cancel')}
      </Button>
      <Button variant="danger" onClick={onConfirm} disabled={busy === true}>
        {busy === true ? t('common.loading') : t('project.delete.action')}
      </Button>
    </div>
  )
  return (
    <Modal
      open
      closeLabel={t('common.close')}
      title={t('project.delete.title')}
      description={t('project.delete.description')}
      footer={footer}
      onClose={onClose}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 'none', display: 'inline-flex' }} aria-hidden="true">
          <Icon name="folder" size={16} />
        </span>
        <span style={TRUNCATE}>{projectName}</span>
      </div>
    </Modal>
  )
}

function RenameWorkspaceDialog({ t, busy, initialTitle, onClose, onConfirm }) {
  const [title, setTitle] = useState(initialTitle)
  const canSubmit = title.trim() !== '' && busy !== true
  function submit() {
    if (!canSubmit) return
    onConfirm(title.trim())
  }
  const footer = (
    <div style={DIALOG_ACTIONS}>
      <Button variant="outline" onClick={onClose} disabled={busy === true}>
        {t('common.cancel')}
      </Button>
      <Button variant="primary" onClick={submit} disabled={!canSubmit}>
        {busy === true ? t('common.loading') : t('common.save')}
      </Button>
    </div>
  )
  return (
    <Modal open closeLabel={t('common.close')} title={t('wsRename.title')} footer={footer} onClose={onClose}>
      <TextField
        label={t('wsRename.field')}
        value={title}
        onChange={setTitle}
        placeholder={t('wsRename.field')}
        autoFocus
        disabled={busy === true}
        onEnter={submit}
      />
    </Modal>
  )
}

function DeleteWorkspaceDialog({ t, busy, workspaceName, onClose, onConfirm }) {
  const footer = (
    <div style={DIALOG_ACTIONS}>
      <Button variant="outline" onClick={onClose} disabled={busy === true}>
        {t('common.cancel')}
      </Button>
      <Button variant="danger" onClick={onConfirm} disabled={busy === true}>
        {busy === true ? t('common.loading') : t('workspace.delete')}
      </Button>
    </div>
  )
  return (
    <Modal
      open
      closeLabel={t('common.close')}
      title={t('wsDelete.title')}
      description={t('wsDelete.description')}
      footer={footer}
      onClose={onClose}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ flex: 'none', display: 'inline-flex' }} aria-hidden="true">
          <Icon name="folder" size={16} />
        </span>
        <span style={TRUNCATE}>{workspaceName}</span>
      </div>
    </Modal>
  )
}

function CleanupBlankDialog({ t, busy, count, onClose, onConfirm }) {
  const footer = (
    <div style={DIALOG_ACTIONS}>
      <Button variant="outline" onClick={onClose} disabled={busy === true}>
        {t('common.cancel')}
      </Button>
      <Button variant="primary" onClick={onConfirm} disabled={busy === true}>
        {busy === true ? t('common.loading') : t('cleanup.action')}
      </Button>
    </div>
  )
  return (
    <Modal
      open
      closeLabel={t('common.close')}
      title={t('cleanup.title')}
      description={t('cleanup.description', { n: count })}
      footer={footer}
      onClose={onClose}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <span style={{ flex: 'none', display: 'inline-flex', marginTop: 2 }} aria-hidden="true">
          <Icon name="archive" size={16} />
        </span>
        <span style={{ minWidth: 0, lineHeight: '20px', overflowWrap: 'anywhere' }}>{t('cleanup.hint')}</span>
      </div>
    </Modal>
  )
}

function RenameSessionDialog({ t, busy, initialTitle, onClose, onConfirm }) {
  const [title, setTitle] = useState(initialTitle)
  const canSubmit = title.trim() !== '' && busy !== true

  function submit() {
    if (!canSubmit) return
    onConfirm(title.trim())
  }

  const footer = (
    <div style={DIALOG_ACTIONS}>
      <Button variant="outline" onClick={onClose} disabled={busy === true}>
        {t('common.cancel')}
      </Button>
      <Button variant="primary" onClick={submit} disabled={!canSubmit}>
        {busy === true ? t('common.loading') : t('common.save')}
      </Button>
    </div>
  )

  return (
    <Modal open closeLabel={t('common.close')} title={t('session.rename.title')} footer={footer} onClose={onClose}>
      <TextField
        label={t('session.rename.field')}
        value={title}
        onChange={setTitle}
        placeholder={t('session.rename.field')}
        autoFocus
        disabled={busy === true}
        onEnter={submit}
      />
    </Modal>
  )
}

function ArchiveRunningDialog({ t, busy, onClose, onConfirm }) {
  const footer = (
    <div style={DIALOG_ACTIONS}>
      <Button variant="outline" onClick={onClose} disabled={busy === true}>
        {t('common.cancel')}
      </Button>
      <Button variant="danger" onClick={onConfirm} disabled={busy === true}>
        {busy === true ? t('common.loading') : t('toast.archiveStopAction')}
      </Button>
    </div>
  )
  return (
    <Modal
      open
      closeLabel={t('common.close')}
      title={t('toast.archiveStopTitle')}
      description={t('toast.archiveStopBody')}
      footer={footer}
      onClose={onClose}
    />
  )
}
