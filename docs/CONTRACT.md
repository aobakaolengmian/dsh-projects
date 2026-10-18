# dsh-projects — implementation contract (v1, frozen)

Goal: a Claude-Desktop-style **Projects** experience for **DSH Desktop only**.
The shipped sidebar browses Sessions grouped by Workspace. We replace that
sidebar region with a project-first browser. Conversations belong to projects;
a conversation is created in (or moved onto) any directory, and an existing
conversation can switch its session working directory.

Product target: `~/.dsh/profiles/desktop` (the Desktop app profile). The Web
profile is untouched.

## Architecture

Two halves in one bundle package `@local/dsh-projects`:

1. **Host half** (`index.js`, plain ESM, runs in the Desktop host process):
   - Durable project state in `$DSH_HOME/storages/dsh-projects.json`
     (`DSH_HOME` env var, default `~/.dsh`), atomic writes.
   - HTTP routes on the existing DSH web server (same pattern as the
     `dsh-plugin` community plugin, which registers `/dsh-plugin-hub/*`):
     - `GET  /dsh-projects/state`
     - `POST /dsh-projects/mutate`  (requires content-type json + `x-dsh-projects: 1`)
     - `POST /dsh-projects/cwd`     (requires content-type json + `x-dsh-projects: 1`)
     - `GET  /dsh-projects/health`
   - `POST /dsh-projects/cwd` resolves the session's Agent host-side and calls
     the mounted `ctx.workingDirectory.set(agent, path)` service, so changing a
     conversation's directory is a real, durable, model-visible working-directory
     change (the same mechanism as the shipped `working_directory` tool).

2. **Client half** (`client.js`, a `window.__ModuleLoader__.load({id, factory})`
   browser module, built from `src/client/*`):
   - Registers into the existing `sidebar.workspaces` single slot with
     `priority: -1`, shadowing the shipped `ui-workspace` browser. The shipped
     entry stays registered underneath, so a crash of our component abdicates
     our entry and the original sidebar comes back automatically.
   - Renders: header (title / search / new project / view options), project
     sections with their Sessions, a pinned section, and an "Other
     conversations" area grouped by Workspace for Sessions outside any project.
   - Creates Sessions through the existing client services:
     `ctx.workspaces.create({path})` → `ctx.sessions.create({workspaceId})` →
     record the project assignment → `ctx.uiWorkspace.openSession(id)`.
   - Session row actions use the shipped services:
     `ctx.sessions.using(...reference.binding.session.rename(title))`,
     `ctx.uiWorkspace.pinSession/unpinSession/archiveSession/unarchiveSession/forkSession`,
     `navigator.clipboard.writeText`, and our `POST /dsh-projects/cwd`.

## Hard constraints

- Do **not** import any `@deepseek-ai/*` package from the client bundle.
  Allowed runtime `require`s in the browser module table: `react`,
  `react-dom`, `react/jsx-runtime`. Everything else comes from `ctx` services
  or from our own modules compiled into the bundle.
- Do not render a second app root, do not touch other plugins' DOM.
- Styles: only `--dsw-*` theme tokens for UI surfaces/text/states; literal
  colors only for project accent artwork. All CSS class names are prefixed
  `pj-`. The CSS lives in `src/client/styles.css` and is injected once by
  `src/client/index.jsx` in an effect on `document.head` (same pattern the
  shipped `ui-workspace` uses for its CSS module).
- UI copy goes through the `t` prop (locale namespace `projects`).
- Client module id in `__ModuleLoader__.load` must equal the package name
  `@local/dsh-projects`.

## Build & dev loop

```
node scripts/build.mjs     # src/client/* -> client.js (esbuild + loader wrapper)
node harness/build.mjs     # mock harness bundle (harness/src -> harness/dist)
node harness/shoot.mjs     # Playwright screenshots -> harness/shots/*.png
node --test tests/         # host plugin tests (blocked on host API task)
```

`node_modules` already contains esbuild/react/react-dom/playwright (installed).
`refs/` contains extracted references from the running DSH install:

- `refs/ws-browser-region.css`, `refs/ws-session-row.css` — shipped sidebar CSS
  (copy spacing, sizes, hover behavior from here; rename classes to `pj-`).
- `refs/theme-tokens.css`, `refs/theme-base_css_default.css` — real theme token
  values; the mock harness loads these, so use only tokens that appear here.
- `refs/dsh-api-*.d.ts` — generated Host/Client contract types for Session and
  Workspace controllers (for reference only; the client uses `ctx` services).

## Shared data contract

`ProjectData` (the product state persisted host-side; also returned by the
state/mutate/cwd routes):

```ts
interface Project {
  id: string                 // "project-<uuid>"
  name: string
  color: string              // one of PROJECT_COLORS ids: blue|green|orange|purple|pink|teal|gray
  directories: string[]      // absolute paths; order matters, first = default when no defaultDirectory
  defaultDirectory?: string  // absolute path, always one of directories
  createdAt: string          // ISO
  updatedAt: string          // ISO
}
interface ProjectData {
  version: 1
  projects: Project[]
  assignments: Record<string, string | null> // sessionId -> projectId; null = "explicitly no project"
  sessionCwd: Record<string, string>         // last directory recorded by POST /cwd
}
```

Membership resolution (client, `data.js`):

1. `assignments[sessionId]` present → `null` means ungrouped, otherwise that
   project id (even if the project was deleted → treat as ungrouped).
2. Otherwise implicit: the first project whose `directories` contains
   `session.cwd` (canonical string compare via `samePath`).
3. Otherwise ungrouped.

Sessions shown: from the live Session list (`sessions.ids` / `sessions.byId`),
excluding `origin === 'subagent'`; archived sessions only when
`uiState.showArchived` (archived ids come from the Workspace snapshot). Blank
sessions are shown (title = `t('session.new')`) so "New Session" rows are
reachable.

Session list row fields available to the UI (from `ctx.sessions.list`):

```ts
{ id, displayTitle, title?, cwd?, running, blank, updatedAt, parentId?,
  origin?: 'subagent', retainedBy: Record<string, number> /* mainView */,
  projectionValues?, formatStatus? }
```

Workspace snapshot (`ctx.workspaces.list`): `{ items: [{workspaceId, path,
title, sessionIds, createdAt, updatedAt}], pinnedSessionIds, archivedSessionIds,
phase, state }`.

Session status hook (`useSessionStatus` from the slot kit):
`Map<sessionId, { running?: boolean, pendingInteraction?: 'approval' |
'plan-review' | 'question', completionUnread: boolean }>`.

Current conversation: the session row with `(row.retainedBy.mainView ?? 0) > 0`.

## Client plugin registration

`src/client/index.jsx` does (Lead owns this file):

```js
export const inject = ['slots', 'locale', 'sessions', 'workspaces', 'uiWorkspace']

export function apply(ctx) {
  // locale dictionaries (zh/en), style tag effect, stores, actions
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register({
    name: 'sidebar.workspaces',
    priority: -1,
    locale: 'projects',
    inject: () => ({ actions, hooks: { projectState, uiState } }),
  }, Browser))
}
```

The registered component (`Browser`, from `src/client/browser.jsx`) receives:

- Owner props from the sidebar shell: `wide: boolean`, `expandSidebar(): void`.
- `t(key, params?)` translation seat for namespace `projects`.
- `actions` — object described below (a plain prop).
- Hooks bound from our `hooks` sources:
  - `useProjectState(selector)` → `{ phase: 'loading' | 'ready' | 'error',
    data: ProjectData | null, error: string | null }`
  - `useUiState(selector)` → `{ collapsedProjects: string[],
    collapsedGroups: string[], showArchived: boolean, otherExpanded: boolean }`
- Root-provided hooks already used by the shipped browser (always present in
  this Desktop composition):
  - `useSessions(selector)` → session list snapshot (shape above)
  - `useWorkspaces(selector)` → workspace snapshot (shape above)
  - `useSessionStatus(selector)` → status Map (shape above)

Do not use `renderSlot` (our entry declares no children; the shipped
`ui-workspace` entry still owns the child slot declarations).

## `actions` API (implemented in `src/client/actions.js`, Lead owns)

All async unless noted. Failures reject with an `Error` whose `.message` is
user-displayable; archive may reject with `.code === 'workspace/session-active'`
(the conversation still has running work).

```
openSession(sessionId)                       // ctx.uiWorkspace.openSession
pickDirectory(): Promise<string | null>      // native/in-app directory picker
ensureWorkspace(path): Promise<WorkspaceView> // find by path or ctx.workspaces.create
newConversation(project, directory): Promise<string> // ensure workspace, reuse a
                                             // blank session in that workspace when
                                             // possible, create, assign project,
                                             // open, return sessionId
createProject({name, directories, color}): Promise<Project> // host mutate, returns created project
updateProject(projectId, patch): Promise<void>       // name/directories/color/defaultDirectory
deleteProject(projectId): Promise<void>
assignSession(sessionId, projectId | null): Promise<void>
renameSession(sessionId, title): Promise<void>
setSessionPinned(sessionId, pinned): Promise<void>
archiveSession(sessionId): Promise<void>
forceArchiveSession(sessionId): Promise<void>  // stops running work, then archives
unarchiveSession(sessionId): Promise<void>
forkSession(sessionId): Promise<string>        // returns child session id
copySessionId(sessionId): Promise<void>
changeWorkingDirectory(sessionId, path): Promise<string> // resolves canonical cwd
refreshProjectState(): Promise<void>
setUiState(patch): void                        // persisted UI state (localStorage)
workspacePathOf(sessionId): string | null      // row.cwd or sessionCwd override
projectOfSession(sessionId): Project | null    // current explicit/implicit project
```

`Project` in `newConversation(project, directory)` may be `null` (ungrouped
conversation), in which case it simply opens the new session.

## `data.js` (pure helpers, Lead owns)

```
PROJECT_COLORS: [{id, value /* hex */, labelKey}]
resolveProjectColor(color): string
normalizePath(p), samePath(a,b), basename(p)
relativeTime(updatedAt, now): { unit: 'now'|'minute'|'hour'|'day'|'date', n, date? }
buildSidebarModel({ sessions, workspaces, projectData, uiState }): {
  pinned: string[],
  projects: [{ project, sessions: string[] }],   // projects in ProjectData order
  ungrouped: [{ key, title, path, sessions: string[] }],
  projectBySession: Map<string, Project>,
}
matchSession(sessions, projectData, sessionId, query): boolean
formatCount? not needed
```

Ordering inside every section: visible blank sessions first (newest update
first among them), then non-blank by `updatedAt` descending. Pinned sessions
are excluded from project/ungrouped sections and rendered once in the global
pinned section in `pinnedSessionIds` order. Sessions in archived state are
filtered by `uiState.showArchived`.

## Visual kit (`src/client/ui.jsx` + `src/client/styles.css`, teammate owns)

Exports (browser renders only these + plain DOM):

```
Icon({name, size?, color?, className?})    // inline SVG, currentColor, names below
IconButton({label, onClick, active?, disabled?, className?, children})
StatusDot({state, label?})                 // 'running' | 'warning' | 'done' | 'idle'
Spinner({size?})
FolderGlyph({color, open?, size?})          // project accent folder artwork
Menu({open, anchorRect, items, onSelect, onClose, minWidth?})
  items: [{ id, label, icon?, checked?, danger?, disabled?, shortcut?,
            separatorBefore?, heading? }]
  - fixed-position panel near anchorRect, viewport-clamped, Escape/outside
    click closes, role="menu"/"menuitem", keyboard arrow navigation.
Modal({open, title, description?, children, footer, onClose, width?})
  - fixed overlay, Escape closes, focus first [data-autofocus] element.
TextField({value, onChange, placeholder, label?, autoFocus?, disabled?, onEnter?})
Button({variant: 'primary'|'outline'|'ghost'|'danger', onClick, children, disabled?, type?})
Toast({message, actionLabel?, onAction?, onDismiss?})  // bottom-left inside sidebar
```

Icons needed: `chevron`, `plus`, `dots`, `search`, `close`, `folder`,
`folder-open`, `folder-plus`, `chat`, `pin`, `pin-off`, `trash`, `pen`, `check`,
`copy`, `archive`, `unarchive`, `fork`, `move`, `refresh`, `expand`,
`collapse`, `project`, `panel`, `spinner` (use Spinner instead).

`styles.css` must style these class names (browser uses exactly these):

```
.pj-root .pj-root-rail .pj-header .pj-title .pj-header-actions
.pj-rail .pj-rail-btn
.pj-list .pj-section .pj-pin-section .pj-other-section
.pj-group .pj-group-header .pj-group-title .pj-group-meta .pj-group-actions
.pj-chevron .pj-chevron-open .pj-folder
.pj-session .pj-session-selected .pj-session-archived .pj-session-menu-open
.pj-session-leading .pj-session-title .pj-session-time .pj-session-actions
.pj-session-badge .pj-pin
.pj-project-accent
.pj-empty .pj-empty-state .pj-empty-action .pj-empty-hint
.pj-search .pj-search-expanded .pj-search-input .pj-search-clear
.pj-more .pj-loading .pj-error .pj-split-hint
```

`styles.css` may add internal classes for ui.jsx components (prefix `pj-`).
Values to copy from `refs/ws-browser-region.css` and `refs/ws-session-row.css`:
row heights (session 32px, project 34px, header 36px), 14px titles, 10–12px
tertiary metadata, `--dsw-radius-md` hover fill, `--dsw-alias-interactive-bg-hover`,
`--dsw-specific-sidebar-fill`, etc. The sidebar column sets
`--dsh-sidebar-inline-padding: 12px`; right side of the list area must reserve
the scrollbar edge (copy `.root/.listArea/.list` values).

## Browser component behavior (`src/client/browser.jsx`, teammate owns)

State/behavior checklist:

1. **Wide layout**: header; scrollable list with sections; footerless.
2. **Rail layout** (`wide === false`): show 2 rail buttons —
   "new project" (opens the new-project dialog after calling `expandSidebar()`)
   and "expand projects"; no list.
3. **Header**: title `t('header.title')`; search icon expands an inline input;
   plus button creates a project; `dots` menu = view options
   (`showArchived` toggle, collapse all, expand all, retry load on error).
4. **Search**: local match on session title / cwd / project name / workspace
   title; flat results list with project tag; empty state; Esc clears.
   Archived sessions appear only when `showArchived` is on.
5. **Pinned section** (if any): global pinned sessions in pin order.
6. **Project sections**: collapsible header with accent FolderGlyph, name,
   hover actions (`plus` = new conversation, `dots` = project menu). Project
   menu: new conversation, add folder, rename, delete. Collapse state persisted
   in `uiState.collapsedProjects`.
7. **Other conversations**: collapsible section (`otherExpanded`), grouped by
   Workspace (workspace title from snapshot via cwd match, else basename; blank
   cwd bucket = `t('group.uncategorized')`); groups collapsible via
   `uiState.collapsedGroups`. Hidden when empty.
8. **Session row**: leading status dot (from status map; running/warn/done) or
   unit; title (blank → `t('session.new')`, archived rows dimmed); relative
   time on the right (hidden on hover); pin glyph when pinned; hover `dots`
   action button. Click opens the session (archived sessions are not openable —
   show a toast/inline hint instead). Selected row highlight for the current
   conversation. Keyboard: Enter opens.
   Optional secondary line for project-tagged rows in pinned/search results.
9. **Session menu** (via Menu component): open, rename, pin/unpin, move to
   project (list all projects with checkmark for current + "no project"),
   change working directory, fork, copy session ID, archive/unarchive.
   Show "remove from project" only for sessions that resolve to a project.
10. **Dialogs**: new project (name + optional folder via `pickDirectory`,
    color swatch row), rename project, delete project confirm. Session rename
    dialog. Change-directory chooser = Menu with project directories
    (`defaultDirectory`/first marked as default) + "choose other directory…".
    Running archive confirmation dialog when `archiveSession` rejects with
    `.code === 'workspace/session-active'`.
11. **New conversation flow**: if the project has directories and the header
    `+` is clicked, use the default directory (defaultDirectory or first);
    the project menu's "new conversation" opens a directory chooser when there
    are multiple directories (defaults marked); if the project has no
    directory, call `pickDirectory()` and add the picked directory to the
    project. After creation, ensure the project section is expanded.
12. **Errors**: every action call is wrapped; errors surface in a Toast
    `t('toast.failed', { message })`. Loading phase shows skeleton/spinner;
    error phase shows a retry button that calls `actions.refreshProjectState`.
13. **Toasts**: transient bottom-left; archive success includes undo
    (`t('toast.undo')`) → `actions.unarchiveSession`.
14. **Empty states**: no projects and no sessions → centered empty state with
    "create project" action; project with no sessions → hint row; search empty.
15. Accessibility: buttons have `aria-label`, menus `role="menu"`, dialogs
    `role="dialog"` `aria-modal`, rows keyboard-focusable (`tabIndex=0` and
    Enter/Space activation). Do not steal global shortcuts.

## Locale keys (namespace `projects`, owned by `src/client/index.jsx`)

The full key list is in `src/client/index.jsx`. `ui-browser` must call
`t(key, params)` for every visible string, never hardcode Chinese/English.
Chinese is the primary authoring language; English mirror required.

## Ownership / write scopes

| Path | Owner |
|---|---|
| `index.js`, `cordis.patch.yml`, `package.json`, `locale/*.json` | Lead |
| `src/client/index.jsx`, `src/client/actions.js`, `src/client/data.js`, `scripts/build.mjs` | Lead |
| `src/client/browser.jsx` | `ui-browser` |
| `src/client/ui.jsx`, `src/client/styles.css` | `ui-controls` |
| `tests/*`, host route code | `host-api` |
| `harness/*`, `refs/*`, `docs/*` | Lead |
