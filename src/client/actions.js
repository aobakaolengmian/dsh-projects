/**
 * Client-side actions for the Projects sidebar. Every operation goes through the
 * shipped DSH client services, so the model-visible session state stays owned by
 * the Host. Failures reject with an Error carrying a user-displayable message.
 */
import {
  buildSidebarModel,
  samePath,
  resolveSessionProject,
} from './data.js'

function errorText(error) {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return String(error)
}

function wrapError(error) {
  if (error instanceof Error) return error
  return new Error(errorText(error))
}

/** Find a registered Workspace by path, or register one. */
async function ensureWorkspace(ctx, path) {
  const snapshot = ctx.workspaces.list.getSnapshot()
  const existing = Array.isArray(snapshot.items)
    ? snapshot.items.find((item) => samePath(item.path, path))
    : undefined
  if (existing !== undefined) return existing
  return await ctx.workspaces.create({ path })
}

function findReusableBlank(ctx, workspace) {
  const sessions = ctx.sessions.list.getSnapshot()
  const archived = new Set(ctx.workspaces.list.getSnapshot().archivedSessionIds ?? [])
  const ids = Array.isArray(sessions.ids) ? sessions.ids : []
  for (const id of ids) {
    const row = sessions.byId?.[id]
    if (row === undefined) continue
    if (!row.blank || archived.has(id)) continue
    if (typeof row.cwd === 'string' && samePath(row.cwd, workspace.path)) return id
    if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(id)) return id
  }
  return undefined
}

export function createActions(ctx, projectState, uiState) {
  const ui = ctx.uiWorkspace
  const sessions = ctx.sessions
  const workspaces = ctx.workspaces

  const projectData = () => projectState.store.getSnapshot().data
  const mutate = (action, payload) => projectState.mutate(action, payload)

  const actions = {
    /** List the project's current directories, canonicalized best effort. */
    projects: () => {
      const data = projectData()
      return Array.isArray(data?.projects) ? data.projects : []
    },

    async refreshProjectState() {
      await projectState.loadWithRetry(1)
    },

    openSession(sessionId) {
      ui.openSession(sessionId)
    },

    async pickDirectory() {
      return await ui.pickDirectory()
    },

    async ensureWorkspace(path) {
      try {
        return await ensureWorkspace(ctx, path)
      } catch (error) {
        throw wrapError(error)
      }
    },

    async newConversation(project, directory) {
      const target = typeof directory === 'string' && directory !== '' ? directory : undefined
      let path = target
      if (path === undefined && project != null) {
        path = project.defaultDirectory
          ?? (Array.isArray(project.directories) && project.directories.length > 0 ? project.directories[0] : undefined)
      }
      if (path === undefined) {
        const picked = await ui.pickDirectory()
        if (picked === null) return null
        path = picked
        if (project != null) {
          const directories = Array.isArray(project.directories) ? [...project.directories] : []
          if (!directories.some((entry) => samePath(entry, path))) directories.push(path)
          try {
            await mutate('project.update', {
              projectId: project.id,
              directories,
              ...(project.defaultDirectory === undefined ? { defaultDirectory: path } : {}),
            })
          } catch (error) {
            throw wrapError(error)
          }
        }
      }
      let workspace
      let sessionId
      try {
        workspace = await ensureWorkspace(ctx, path)
        // Keep the project's directory entry canonical for implicit membership.
        if (project != null && !project.directories.some((entry) => samePath(entry, workspace.path))) {
          const directories = [...project.directories, workspace.path]
          const defaultDirectory = project.defaultDirectory === undefined ? workspace.path : project.defaultDirectory
          mutate('project.update', { projectId: project.id, directories, defaultDirectory }).catch(() => {})
        }
        const reusable = findReusableBlank(ctx, workspace)
        sessionId = await sessions.create({
          workspaceId: workspace.workspaceId,
          ...(reusable === undefined ? {} : { sessionId: reusable }),
        })
      } catch (error) {
        throw wrapError(error)
      }
      if (project != null) {
        try {
          await mutate('session.assign', { sessionId, projectId: project.id })
        } catch (error) {
          // The conversation exists; assignment is best effort with a visible error.
          throw wrapError(error)
        }
      }
      ui.openSession(sessionId)
      return sessionId
    },

    async createProject({ name, directories = [], color }) {
      try {
        const result = await mutate('project.create', {
          name,
          directories,
          ...(color === undefined ? {} : { color }),
        })
        return result?.project ?? null
      } catch (error) {
        throw wrapError(error)
      }
    },

    async updateProject(projectId, patch) {
      try {
        await mutate('project.update', { projectId, ...patch })
      } catch (error) {
        throw wrapError(error)
      }
    },

    async deleteProject(projectId) {
      try {
        await mutate('project.delete', { projectId })
      } catch (error) {
        throw wrapError(error)
      }
    },

    /** Session ids whose working directory is exactly `path` (non-subagent). */
    workspaceSessionIds(path) {
      const snapshot = sessions.list.getSnapshot()
      const ids = []
      for (const sessionId of Array.isArray(snapshot.ids) ? snapshot.ids : []) {
        const row = snapshot.byId?.[sessionId]
        if (row === undefined || row.origin === 'subagent') continue
        if (typeof row.cwd === 'string' && samePath(row.cwd, path)) ids.push(sessionId)
      }
      return ids
    },

    /**
     * Move one working directory (the sidebar's workspace group) to a project,
     * or out of every project when `projectId` is null:
     * - directory membership is moved between projects, never duplicated;
     * - every conversation in that directory gets an explicit assignment, so a
     *   stale explicit assignment cannot keep a conversation behind.
     * @returns {Promise<{sessions: number, projects: number}>} moved counts
     */
    async moveWorkspace(path, projectId) {
      if (typeof path !== 'string' || path === '') throw new Error('a workspace path is required')
      const data = projectData()
      const knownProjects = Array.isArray(data?.projects) ? data.projects : []
      let projectsChanged = 0
      try {
        for (const project of knownProjects) {
          const directories = Array.isArray(project.directories) ? project.directories : []
          const present = directories.some((directory) => samePath(directory, path))
          if (projectId !== null && project.id === projectId) {
            if (!present) {
              await mutate('project.update', { projectId: project.id, directories: [...directories, path] })
              projectsChanged += 1
            }
          } else if (present) {
            const nextDirectories = directories.filter((directory) => !samePath(directory, path))
            const patch = { projectId: project.id, directories: nextDirectories }
            if (typeof project.defaultDirectory === 'string' && samePath(project.defaultDirectory, path)) {
              patch.defaultDirectory = null
            }
            await mutate('project.update', patch)
            projectsChanged += 1
          }
        }
        const sessionIds = actions.workspaceSessionIds(path)
        for (const sessionId of sessionIds) {
          await mutate('session.assign', { sessionId, projectId })
        }
        return { sessions: sessionIds.length, projects: projectsChanged }
      } catch (error) {
        throw wrapError(error)
      }
    },

    /** The registered Workspace for a directory path, if any. */
    registeredWorkspace(path) {
      const snapshot = workspaces.list.getSnapshot()
      return (Array.isArray(snapshot.items) ? snapshot.items : []).find((item) => samePath(item.path, path))
    },

    async renameWorkspace(path, title) {
      const workspace = actions.registeredWorkspace(path)
      if (workspace === undefined) throw new Error('this directory is not a registered workspace')
      try {
        await workspaces.rename(workspace.workspaceId, title)
      } catch (error) {
        throw wrapError(error)
      }
    },

    /** Remove a directory from every project and return its sessions to Other. */
    async unprojectWorkspace(path) {
      const data = projectData()
      const knownProjects = Array.isArray(data?.projects) ? data.projects : []
      let projectsChanged = 0
      try {
        for (const project of knownProjects) {
          const directories = Array.isArray(project.directories) ? project.directories : []
          if (!directories.some((directory) => samePath(directory, path))) continue
          const nextDirectories = directories.filter((directory) => !samePath(directory, path))
          const patch = { projectId: project.id, directories: nextDirectories }
          if (typeof project.defaultDirectory === 'string' && samePath(project.defaultDirectory, path)) {
            patch.defaultDirectory = null
          }
          await mutate('project.update', patch)
          projectsChanged += 1
        }
        const sessionIds = actions.workspaceSessionIds(path)
        for (const sessionId of sessionIds) {
          await mutate('session.assign', { sessionId, projectId: null })
        }
        return { sessions: sessionIds.length, projects: projectsChanged }
      } catch (error) {
        throw wrapError(error)
      }
    },

    /**
     * Delete one workspace from the app (the shipped Workspace registry row) and
     * put its conversations back into the Other group. Never deletes sessions.
     */
    async deleteWorkspace(path) {
      const workspace = actions.registeredWorkspace(path)
      let registered = false
      try {
        if (workspace !== undefined) {
          await workspaces.delete(workspace.workspaceId)
          registered = true
        }
        const result = await actions.unprojectWorkspace(path)
        return { sessions: result.sessions, registered }
      } catch (error) {
        throw wrapError(error)
      }
    },

    /**
     * Ask the Host which Sessions hold no conversation content at all. Returns
     * `{ supported: false }` on Host versions without the scan route (the
     * client bundle hot-reloads before the Host half does).
     */
    async scanEmptySessions() {
      try {
        const response = await projectState.requestJson('/dsh-projects/empty-sessions', {
          method: 'GET',
          headers: { 'x-dsh-projects': '1' },
        })
        const ids = Array.isArray(response.result?.emptySessionIds)
          ? response.result.emptySessionIds.filter((id) => typeof id === 'string' && id !== '')
          : []
        return { supported: true, ids }
      } catch (error) {
        const code = error?.code ?? ''
        if (code === 'http-404' || code === 'http-405' || code === 'http-501' || code === 'service/unavailable') {
          return { supported: false, ids: [] }
        }
        throw wrapError(error)
      }
    },

    /**
     * Really remove never-used blank Sessions from disk through the Host route.
     * Falls back to archiving when the running Host predates the purge route
     * (the client bundle hot-reloads before the Host half does).
     */
    async purgeBlankSessions(sessionIds) {
      const ids = Array.isArray(sessionIds) ? sessionIds.filter((id) => typeof id === 'string' && id !== '') : []
      if (ids.length === 0) return { purged: 0, skipped: 0, fallback: false }
      // Tidy the workspace navigation sets first (some blanks were archived by
      // the earlier archive-based cleanup); best effort.
      const workspaceSnapshot = workspaces.list.getSnapshot()
      const archived = new Set(Array.isArray(workspaceSnapshot.archivedSessionIds) ? workspaceSnapshot.archivedSessionIds : [])
      const pinned = new Set(Array.isArray(workspaceSnapshot.pinnedSessionIds) ? workspaceSnapshot.pinnedSessionIds : [])
      for (const sessionId of ids) {
        if (archived.has(sessionId)) await ui.unarchiveSession(sessionId).catch(() => {})
        if (pinned.has(sessionId)) await ui.unpinSession(sessionId).catch(() => {})
      }
      try {
        const response = await projectState.requestJson('/dsh-projects/purge', {
          method: 'POST',
          body: JSON.stringify({ sessionIds: ids }),
        })
        const result = response.result ?? {}
        const purged = Array.isArray(result.purged) ? result.purged.length : 0
        const skippedIds = Array.isArray(result.skipped)
          ? result.skipped.map((entry) => entry?.sessionId).filter((id) => typeof id === 'string' && id !== '')
          : []
        // Sessions the Host refused to delete (still live in this app run) are
        // archived instead so the cleanup still takes effect visually; they can
        // be purged completely after the next app restart.
        let archived = 0
        for (const sessionId of skippedIds) {
          try {
            await ui.archiveSession(sessionId)
            archived += 1
          } catch {
            // ignore individual failures
          }
        }
        // Reload the Host catalog so removed Sessions disappear without restart.
        if (typeof sessions.refresh === 'function') sessions.refresh().catch(() => {})
        return { purged, archived, skipped: skippedIds.length - archived, fallback: false }
      } catch (error) {
        const code = error?.code ?? ''
        if (code !== 'http-404' && code !== 'http-405' && code !== 'http-501' && code !== 'service/unavailable') {
          throw wrapError(error)
        }
        // Older Host: archive instead, keeping the UI usable until a restart.
        let archived = 0
        for (const sessionId of ids) {
          try {
            await ui.archiveSession(sessionId)
            archived += 1
          } catch {
            // ignore individually
          }
        }
        if (archived > 0) {
          return { purged: 0, archived, skipped: ids.length - archived, fallback: true }
        }
        throw wrapError(error)
      }
    },

    async assignSession(sessionId, projectId) {
      try {
        await mutate('session.assign', { sessionId, projectId })
      } catch (error) {
        throw wrapError(error)
      }
    },

    async renameSession(sessionId, title) {
      try {
        const result = await sessions.using(sessionId, { source: 'projectsOperation' }, (reference) =>
          reference.binding.session.rename(title),
        )
        if (!result.ok) throw new Error(result.error?.message ?? 'rename failed')
      } catch (error) {
        throw wrapError(error)
      }
    },

    async setSessionPinned(sessionId, pinned) {
      try {
        if (pinned) await ui.pinSession(sessionId)
        else await ui.unpinSession(sessionId)
      } catch (error) {
        throw wrapError(error)
      }
    },

    async archiveSession(sessionId) {
      try {
        await ui.archiveSession(sessionId)
      } catch (error) {
        const wrapped = wrapError(error)
        const code = error?.rpcError?.code ?? error?.code
        if (code === 'workspace/session-active') wrapped.code = 'workspace/session-active'
        throw wrapped
      }
    },

    async forceArchiveSession(sessionId) {
      try {
        await ui.archiveSession(sessionId, { stopActivity: true })
      } catch (error) {
        throw wrapError(error)
      }
    },

    async unarchiveSession(sessionId) {
      try {
        await ui.unarchiveSession(sessionId)
      } catch (error) {
        throw wrapError(error)
      }
    },

    async forkSession(sessionId) {
      try {
        return await ui.forkSession(sessionId)
      } catch (error) {
        throw wrapError(error)
      }
    },

    async copySessionId(sessionId) {
      try {
        await navigator.clipboard.writeText(sessionId)
      } catch (error) {
        throw new Error(`clipboard: ${errorText(error)}`)
      }
    },

    async changeWorkingDirectory(sessionId, path) {
      try {
        return await projectState.changeDirectory(sessionId, path)
      } catch (error) {
        throw wrapError(error)
      }
    },

    setUiState(patch) {
      uiState.patch(patch)
    },

    workspacePathOf(sessionId) {
      const row = sessions.list.getSnapshot().byId?.[sessionId]
      return typeof row?.cwd === 'string' ? row.cwd : null
    },

    /**
     * Current model for the sidebar (exposed for menu decisions that need the
     * project of one session outside the React tree).
     */
    modelFor() {
      return buildSidebarModel({
        sessions: sessions.list.getSnapshot(),
        workspaces: workspaces.list.getSnapshot(),
        projectData: projectData(),
        uiState: uiState.store.getSnapshot(),
      })
    },

    projectOfSession(sessionId) {
      const data = projectData()
      const row = sessions.list.getSnapshot().byId?.[sessionId]
      if (row === undefined || data === null) return null
      return resolveSessionProject(row, data)
    },
  }

  return actions
}
