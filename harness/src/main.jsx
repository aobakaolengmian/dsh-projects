/**
 * Mock harness entry: runs the real client bundle's apply() against mocked DSH
 * client services and renders the real Browser component inside the real theme
 * tokens, so the Lead can screenshot the sidebar without the Desktop app.
 */
import React from 'react'
import ReactDOM from 'react-dom'
import { createRoot } from 'react-dom/client'
import * as jsxRuntime from 'react/jsx-runtime'
import { createMocks } from './mocks.js'

const registry = new Map()
window.__ModuleLoader__ = {
  load(entry) {
    registry.set(entry.id, entry.factory)
  },
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = src
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`failed to load ${src}`))
    document.head.appendChild(script)
  })
}

function visibleError(message) {
  document.body.dataset.error = message
  const box = document.getElementById('harness-error')
  if (box !== null) {
    box.textContent = message
    box.hidden = false
  }
  console.error('[harness]', message)
}

window.addEventListener('error', (event) => visibleError(String(event.message ?? event.error)))
window.addEventListener('unhandledrejection', (event) => visibleError(String(event.reason?.message ?? event.reason)))

async function main() {
  const params = new URLSearchParams(location.search)
  const theme = params.get('theme') ?? 'light'
  const wide = params.get('wide') !== '0'
  const scenario = params.get('scenario') ?? 'default'
  const lang = params.get('lang') ?? 'zh'

  document.documentElement.dataset.platform = params.get('platform') ?? 'darwin'
  if (theme === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
  document.getElementById('sidebar').dataset.rail = wide ? '0' : '1'

  await loadScript('../client.js')
  const factory = registry.get('@wxysskd/dsh-projects')
  if (factory === undefined) throw new Error('client bundle did not register @wxysskd/dsh-projects')

  const moduleTable = {
    react: React,
    'react-dom': ReactDOM,
    'react-dom/client': { createRoot },
    'react/jsx-runtime': jsxRuntime,
    'react/jsx-dev-runtime': jsxRuntime,
  }
  const mod = factory((name) => {
    if (!(name in moduleTable)) throw new Error(`harness module table misses ${name}`)
    return moduleTable[name]
  })

  const mocks = createMocks({ scenario, lang })
  window.fetch = mocks.fetch
  mod.apply(mocks.ctx)
  window.__mocks = mocks

  const registration = mocks.getRegistration()
  if (registration === null) throw new Error('apply() registered no sidebar entry')
  const injected = typeof registration.options.inject === 'function' ? registration.options.inject() : {}
  const hooks = injected.hooks ?? {}

  const makeHook = (source) => (selector) => {
    const value = React.useSyncExternalStore(source.subscribe, source.getSnapshot)
    return typeof selector === 'function' ? selector(value) : value
  }

  const props = {
    ...injected,
    wide,
    expandSidebar: () => {},
    t: mocks.ctx.locale.bind('projects'),
    useProjectState: makeHook(hooks.projectState),
    useUiState: makeHook(hooks.uiState),
    useSessions: makeHook(mocks.sessions),
    useWorkspaces: makeHook(mocks.workspaces),
    useSessionStatus: makeHook(mocks.status),
  }
  delete props.hooks

  const Component = registration.component
  const root = createRoot(document.getElementById('app'))
  // Reproduce the shell's SlotOutlet wrapper (`display:contents` + data-slot),
  // which host plugins use as their DOM anchor.
  root.render(
    React.createElement(
      'div',
      { 'data-slot': 'sidebar.workspaces', style: { display: 'contents' } },
      React.createElement(Component, props),
    ),
  )

  // Let the initial project-state fetch settle before the screenshot.
  await new Promise((resolve) => setTimeout(resolve, 120))
  document.body.dataset.ready = '1'
}

main().catch((error) => visibleError(String(error?.stack ?? error)))
