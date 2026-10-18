/**
 * Shared visual kit for the Projects sidebar (contract: docs/CONTRACT.md,
 * "Visual kit"). Every component here renders plain DOM + inline SVG; no
 * `@deepseek-ai/*` imports and no external icon fonts.
 *
 * Styling lives in ./styles.css and is injected once by index.jsx. The shipped
 * DSH design-system values (menu surface, dialog shell, buttons, inputs, status
 * dots) were copied from the Desktop install so this kit looks native in both
 * light and dark themes.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function cx(...values) {
  let out = ''
  for (const value of values) {
    if (value === undefined || value === null || value === false || value === '') continue
    out = out === '' ? String(value) : `${out} ${String(value)}`
  }
  return out
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/** DOMRect-like input (or {x,y,width,height}) -> plain rect with all edges. */
function normalizeRect(rect) {
  if (rect === null || rect === undefined) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }
  const left = typeof rect.left === 'number' ? rect.left : typeof rect.x === 'number' ? rect.x : 0
  const top = typeof rect.top === 'number' ? rect.top : typeof rect.y === 'number' ? rect.y : 0
  const width = typeof rect.width === 'number' ? rect.width : typeof rect.right === 'number' ? rect.right - left : 0
  const height = typeof rect.height === 'number' ? rect.height : typeof rect.bottom === 'number' ? rect.bottom - top : 0
  const right = typeof rect.right === 'number' ? rect.right : left + width
  const bottom = typeof rect.bottom === 'number' ? rect.bottom : top + height
  return { left, top, width, height, right, bottom }
}

/* -------------------------------------------------------------------------- */
/* overlay stack (Escape / focus handling for stacked overlays)                */
/* -------------------------------------------------------------------------- */

const overlayStack = []

function topOverlay() {
  return overlayStack.length > 0 ? overlayStack[overlayStack.length - 1] : null
}

const FOCUSABLE_SELECTOR =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'

function isVisibleFocusable(element) {
  return !element.closest('[inert], [hidden]')
}

/**
 * Return focus to the element that opened an overlay.
 *
 * Browser "focus fixup" after a focused subtree is removed is racy relative to
 * React's passive-effect cleanup, so restore on the next frame instead, and only
 * when nothing else (another overlay, a freshly focused control) claimed focus.
 */
function scheduleFocusRestore(element) {
  if (!(element instanceof HTMLElement) || !element.isConnected) return
  requestAnimationFrame(() => {
    if (!element.isConnected || overlayStack.length > 0) return
    const active = document.activeElement
    if (active !== null && active !== document.body && active.isConnected) return
    element.focus({ preventScroll: true })
  })
}

/* -------------------------------------------------------------------------- */
/* Icon                                                                        */
/* -------------------------------------------------------------------------- */

/*
 * All artwork is a 24x24 grid drawn with `currentColor` so a single icon set
 * follows the theme (label color tokens) without duplicated light/dark paths.
 */
const ICONS = {
  chevron: <path d="m9 18 6-6-6-6" />,
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  dots: (
    <>
      <circle cx="5" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.35" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.35" fill="currentColor" stroke="none" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </>
  ),
  close: (
    <>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </>
  ),
  folder: (
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  ),
  'folder-open': (
    <path d="m6 14 1.45-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.55 6a2 2 0 0 1-1.94 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2" />
  ),
  'folder-plus': (
    <>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
      <path d="M12 10v6" />
      <path d="M9 13h6" />
    </>
  ),
  chat: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />,
  pin: (
    <>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1Z" />
    </>
  ),
  'pin-off': (
    <>
      <path d="M3 3l18 18" />
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h9" />
      <path d="M15 12.2V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1" />
    </>
  ),
  trash: (
    <>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </>
  ),
  pen: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </>
  ),
  archive: (
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="M10 12h4" />
    </>
  ),
  unarchive: (
    <>
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <path d="m9 13 3-3 3 3" />
      <path d="M12 10v8" />
    </>
  ),
  fork: (
    <>
      <circle cx="12" cy="18" r="3" />
      <circle cx="6" cy="6" r="3" />
      <circle cx="18" cy="6" r="3" />
      <path d="M18 9v1a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9" />
      <path d="M12 12v3" />
    </>
  ),
  move: (
    <>
      <path d="M5 9 2 12l3 3" />
      <path d="m9 5 3-3 3 3" />
      <path d="m15 19-3 3-3-3" />
      <path d="m19 9 3 3-3 3" />
      <path d="M2 12h20" />
      <path d="M12 2v20" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </>
  ),
  expand: (
    <>
      <path d="M15 3h6v6" />
      <path d="M9 21H3v-6" />
      <path d="m21 3-7 7" />
      <path d="m3 21 7-7" />
    </>
  ),
  collapse: (
    <>
      <path d="M4 14h6v6" />
      <path d="M20 10h-6V4" />
      <path d="m14 10 7-7" />
      <path d="m3 21 7-7" />
    </>
  ),
  project: (
    <>
      <path d="m12 2 10 5-10 5L2 7Z" />
      <path d="m2 17 10 5 10-5" />
      <path d="m2 12 10 5 10-5" />
    </>
  ),
  panel: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </>
  ),
}

/** Alternate names a caller might reasonably use for the same glyph. */
const ICON_ALIASES = {
  more: 'dots',
  ellipsis: 'dots',
  'more-horizontal': 'dots',
  'more-vertical': 'dots',
  x: 'close',
  edit: 'pen',
  pencil: 'pen',
  duplicate: 'copy',
  'chevron-right': 'chevron',
  'chevron-down': 'chevron',
  'folder-close': 'folder',
  'folder-closed': 'folder',
  archivebox: 'archive',
  unarchivebox: 'unarchive',
  sidebar: 'panel',
  layers: 'project',
  maximize: 'expand',
  minimize: 'collapse',
}

const ICON_FALLBACK = <circle cx="12" cy="12" r="8" />

export function Icon({ name, size = 16, color, className, ...rest }) {
  const resolved = ICON_ALIASES[name] ?? name
  const content = ICONS[resolved] ?? ICON_FALLBACK
  return (
    <svg
      {...rest}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cx('pj-icon', className)}
      style={color === undefined ? undefined : { color }}
      aria-hidden="true"
      focusable="false"
      data-pj-icon={resolved}
    >
      {content}
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/* IconButton                                                                  */
/* -------------------------------------------------------------------------- */

export function IconButton({ label, onClick, active = false, disabled = false, className, children, ...rest }) {
  return (
    <button
      {...rest}
      type="button"
      className={cx('pj-icon-btn', active && 'pj-icon-btn-active', className)}
      aria-label={label}
      title={label}
      aria-pressed={active === true ? 'true' : undefined}
      data-active={active === true ? '' : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* StatusDot / Spinner                                                         */
/* -------------------------------------------------------------------------- */

// The shipped status indicator is a 10px dot (colour fills 60% of the box) or,
// while running, a 14px dashed arc that spins. Both are copied here so rows read
// exactly like the shipped Sessions list.
function SpinnerArc({ size, className, label }) {
  return (
    <svg
      className={cx('pj-spinner', className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? 'true' : undefined}
      focusable="false"
    >
      <g className="pj-spinner-motion">
        <circle className="pj-spinner-track" cx="12" cy="12" r="9.5" />
        <circle className="pj-spinner-arc" cx="12" cy="12" r="9.5" />
      </g>
    </svg>
  )
}

export function Spinner({ size = 16, className, label }) {
  return <SpinnerArc size={size} className={cx('pj-spinner-loading', className)} label={label} />
}

export function StatusDot({ state = 'idle', label, size }) {
  const normalized = state === 'ongoing' ? 'running' : state
  if (normalized === 'running') {
    return <SpinnerArc size={size ?? 14} className="pj-status-running" label={label} />
  }
  const dimension = size ?? 10
  return (
    <span
      className="pj-status-dot"
      data-state={normalized}
      style={{ width: dimension, height: dimension }}
      role={label === undefined ? undefined : 'img'}
      aria-label={label}
      aria-hidden={label === undefined ? 'true' : undefined}
    />
  )
}

/* -------------------------------------------------------------------------- */
/* FolderGlyph                                                                 */
/* -------------------------------------------------------------------------- */

/** Fallback accent values in case the caller passes a palette id, not a hex. */
const ACCENT_BY_ID = {
  blue: '#4d93f8',
  green: '#22c55e',
  orange: '#f59e0b',
  purple: '#8b5cf6',
  pink: '#ec4899',
  teal: '#14b8a6',
  gray: '#979da6',
}

function resolveAccent(color) {
  if (typeof color !== 'string' || color === '') return undefined
  if (color.startsWith('#') || color.startsWith('rgb') || color.startsWith('hsl') || color.startsWith('var(')) return color
  return ACCENT_BY_ID[color]
}

export function FolderGlyph({ color, open = false, size = 18, className }) {
  const accent = resolveAccent(color)
  const style = accent === undefined ? undefined : { color: accent }
  return (
    <svg
      className={cx('pj-folder-glyph', open && 'pj-folder-glyph-open', className)}
      viewBox="0 0 20 20"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
      style={style}
      data-open={open === true ? '' : undefined}
    >
      {open ? (
        <>
          {/* back panel (tab + body) */}
          <path
            d="M2 5.4c0-.83.67-1.5 1.5-1.5h3.32c.4 0 .78.16 1.06.44l1.24 1.24c.28.28.66.44 1.06.44h4.82c.83 0 1.5.67 1.5 1.5v1.28H2Z"
            fill="currentColor"
            opacity="0.6"
          />
          {/* front panel tilted open */}
          <path
            d="M2.02 8.9h15.96c.62 0 1.08.58.94 1.18l-1.5 6.12a2 2 0 0 1-1.94 1.54H4.2a2 2 0 0 1-1.95-1.55L.94 10.07a.95.95 0 0 1 .94-1.17Z"
            fill="currentColor"
          />
          <path d="M2.02 8.9h15.96c.2 0 .38.06.52.17H1.5c.14-.11.32-.17.52-.17Z" fill="#ffffff" opacity="0.18" />
        </>
      ) : (
        <>
          {/* tab + body */}
          <path
            d="M2 5.4c0-.83.67-1.5 1.5-1.5h3.32c.4 0 .78.16 1.06.44l1.24 1.24c.28.28.66.44 1.06.44h4.82c.83 0 1.5.67 1.5 1.5v7.06c0 .83-.67 1.5-1.5 1.5H3.5c-.83 0-1.5-.67-1.5-1.5Z"
            fill="currentColor"
            opacity="0.55"
          />
          <path d="M2 8.24h16v6.9c0 .83-.67 1.5-1.5 1.5H3.5c-.83 0-1.5-.67-1.5-1.5Z" fill="currentColor" />
          <path d="M2 8.24h16v1.1H2Z" fill="#ffffff" opacity="0.16" />
        </>
      )}
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/* Menu                                                                        */
/* -------------------------------------------------------------------------- */

function MenuItem({ item, onActivate }) {
  if (item.heading === true) {
    return (
      <div className="pj-menu-heading" role="presentation">
        {item.label}
      </div>
    )
  }
  const checked = item.checked !== undefined
  const shortcut = Array.isArray(item.shortcut) ? item.shortcut.join('+') : item.shortcut
  return (
    <button
      type="button"
      role={checked ? 'menuitemcheckbox' : 'menuitem'}
      aria-checked={checked ? (item.checked === true ? 'true' : 'false') : undefined}
      disabled={item.disabled === true}
      className={cx('pj-menu-item', item.danger === true && 'pj-menu-item-danger')}
      onClick={() => onActivate(item)}
    >
      {item.icon === undefined || item.icon === null ? null : <span className="pj-menu-item-icon">{item.icon}</span>}
      <span className="pj-menu-item-label">{item.label}</span>
      {shortcut === undefined || shortcut === '' ? null : (
        <span className="pj-menu-shortcut" aria-hidden="true">
          {shortcut}
        </span>
      )}
      {item.checked === true ? (
        <span className="pj-menu-check" aria-hidden="true">
          <Icon name="check" size={14} />
        </span>
      ) : null}
    </button>
  )
}

export function Menu({ open, anchorRect, items = [], onSelect, onClose, minWidth = 180 }) {
  const panelRef = useRef(null)
  const onCloseRef = useRef(onClose)
  const onSelectRef = useRef(onSelect)
  onCloseRef.current = onClose
  onSelectRef.current = onSelect

  const entryRef = useRef(null)
  const restoreRef = useRef(null)
  const [position, setPosition] = useState(null)

  const requestClose = useCallback(() => {
    onCloseRef.current?.()
  }, [])

  // Register as the top overlay while open (Escape / restore focus / stack).
  useEffect(() => {
    if (!open) return undefined
    const entry = { close: () => onCloseRef.current?.() }
    entryRef.current = entry
    overlayStack.push(entry)
    const previous = document.activeElement
    restoreRef.current = previous instanceof HTMLElement ? previous : null
    return () => {
      const index = overlayStack.indexOf(entry)
      if (index !== -1) overlayStack.splice(index, 1)
      if (entryRef.current === entry) entryRef.current = null
      scheduleFocusRestore(restoreRef.current)
      restoreRef.current = null
    }
  }, [open])

  // Measure + clamp to the viewport (fixed positioning).
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null)
      return
    }
    const panel = panelRef.current
    if (panel === null) return
    const rect = normalizeRect(anchorRect)
    const margin = 12
    const width = panel.offsetWidth
    const height = panel.offsetHeight
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    let left = rect.left
    if (left + width > viewportWidth - margin) left = rect.right - width
    left = clamp(left, margin, Math.max(margin, viewportWidth - width - margin))
    let top = rect.bottom + 4
    const above = rect.top - height - 4
    if (top + height > viewportHeight - margin && above >= margin) top = above
    top = clamp(top, margin, Math.max(margin, viewportHeight - height - margin))
    setPosition((previous) =>
      previous !== null && previous.left === left && previous.top === top ? previous : { left, top },
    )
  }, [open, anchorRect, items])

  // Move focus into the menu once it is laid out.
  useEffect(() => {
    if (!open) return undefined
    const frame = requestAnimationFrame(() => {
      const panel = panelRef.current
      if (panel === null) return
      const first = panel.querySelector('button:not(:disabled)')
      if (first !== null) first.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  // Keyboard: Escape closes, arrows/Home/End move between items, Tab commits.
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return
      if (topOverlay() !== entryRef.current) return
      const panel = panelRef.current
      if (panel === null) return
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault()
        event.stopImmediatePropagation()
        requestClose()
        return
      }
      if (event.key === 'Tab') {
        const active = document.activeElement
        if (
          !event.shiftKey &&
          active instanceof HTMLElement &&
          panel.contains(active) &&
          active.tagName === 'BUTTON'
        ) {
          event.preventDefault()
          event.stopImmediatePropagation()
          active.click()
          requestClose()
          return
        }
        event.preventDefault()
        event.stopImmediatePropagation()
        requestClose()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return
      const buttons = Array.from(panel.querySelectorAll('button:not(:disabled)')).filter(isVisibleFocusable)
      if (buttons.length === 0) return
      event.preventDefault()
      event.stopImmediatePropagation()
      const active = document.activeElement
      const index = buttons.indexOf(active)
      let next
      if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = buttons.length - 1
      else if (event.key === 'ArrowDown') next = index < 0 ? 0 : (index + 1) % buttons.length
      else next = index < 0 ? buttons.length - 1 : (index - 1 + buttons.length) % buttons.length
      buttons[next].focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open, requestClose])

  // Pointer outside the panel (and outside the anchor it is attached to).
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event) => {
      const panel = panelRef.current
      const target = event.target
      if (panel === null || !(target instanceof Node)) return
      if (panel.contains(target)) return
      const rect = normalizeRect(anchorRect)
      const padding = 2
      const inAnchor =
        typeof event.clientX === 'number' &&
        event.clientX >= rect.left - padding &&
        event.clientX <= rect.right + padding &&
        event.clientY >= rect.top - padding &&
        event.clientY <= rect.bottom + padding
      if (inAnchor) return
      requestClose()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, anchorRect, requestClose])

  useEffect(() => {
    if (!open) return undefined
    const onResize = () => requestClose()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [open, requestClose])

  if (!open) return null

  const activate = (item) => {
    if (item.disabled === true) return
    onSelectRef.current?.(item.id, item)
    requestClose()
  }

  let key = 0
  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      className="pj-menu"
      data-pj-menu=""
      style={{
        left: position === null ? 0 : position.left,
        top: position === null ? 0 : position.top,
        minWidth,
        visibility: position === null ? 'hidden' : undefined,
      }}
    >
      <div className="pj-menu-material" aria-hidden="true" />
      <div className="pj-menu-surface">
        {items.map((item) => {
          key += 1
          return (
            <div className="pj-menu-item-wrap" key={`${item.id ?? 'item'}-${key}`}>
              {item.separatorBefore === true ? <div className="pj-menu-separator" role="separator" /> : null}
              <MenuItem item={item} onActivate={activate} />
            </div>
          )
        })}
      </div>
    </div>,
    document.body,
  )
}

/* -------------------------------------------------------------------------- */
/* Modal                                                                       */
/* -------------------------------------------------------------------------- */

export function Modal({ open, title, description, children, footer, onClose, width, closeLabel = 'Close' }) {
  const dialogRef = useRef(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const titleId = useId()
  const descriptionId = useId()

  const entryRef = useRef(null)
  const restoreRef = useRef(null)
  const wasOpenRef = useRef(false)

  // React applies an input's `autoFocus` during commit, i.e. before any effect
  // runs. Capture the element that had focus when the dialog opened here, in the
  // render that flips open, so it can be restored on close.
  if (open && !wasOpenRef.current) {
    wasOpenRef.current = true
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  } else if (!open && wasOpenRef.current) {
    wasOpenRef.current = false
  }

  // Overlay registration + focus capture.
  useEffect(() => {
    if (!open) return undefined
    const entry = { close: () => onCloseRef.current?.() }
    entryRef.current = entry
    overlayStack.push(entry)
    return () => {
      const index = overlayStack.indexOf(entry)
      if (index !== -1) overlayStack.splice(index, 1)
      if (entryRef.current === entry) entryRef.current = null
      scheduleFocusRestore(restoreRef.current)
      restoreRef.current = null
    }
  }, [open])

  // Focus the first [data-autofocus] element (or the first focusable one).
  useEffect(() => {
    if (!open) return undefined
    const frame = requestAnimationFrame(() => {
      const dialog = dialogRef.current
      if (dialog === null) return
      const target =
        dialog.querySelector('[data-autofocus]') ??
        Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).find(isVisibleFocusable) ??
        dialog
      target.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [open])

  // Escape closes the top dialog; Tab is trapped inside it.
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return
      if (topOverlay() !== entryRef.current) return
      if (event.key === 'Escape' && !event.shiftKey) {
        event.preventDefault()
        event.stopImmediatePropagation()
        onCloseRef.current?.()
        return
      }
      if (event.key !== 'Tab') return
      const dialog = dialogRef.current
      if (dialog === null) return
      const focusables = Array.from(dialog.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisibleFocusable)
      if (focusables.length === 0) {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      if (!dialog.contains(active)) {
        event.preventDefault()
        first.focus({ preventScroll: true })
        return
      }
      if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus({ preventScroll: true })
        return
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus({ preventScroll: true })
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  if (!open) return null

  const style = typeof width === 'number' && Number.isFinite(width) ? { width: `min(${width}px, 100%)` } : undefined

  return createPortal(
    <div className="pj-modal-root" data-pj-modal="">
      <div className="pj-modal-mask" aria-hidden="true" />
      <div
        ref={dialogRef}
        className="pj-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description === undefined || description === null ? undefined : descriptionId}
        style={style}
        tabIndex={-1}
      >
        <div className="pj-modal-content">
          <div className="pj-modal-header">
            <h2 className="pj-modal-title" id={titleId}>
              {title}
            </h2>
            {onClose === undefined ? null : (
              <button
                type="button"
                className="pj-modal-close"
                aria-label={closeLabel}
                onClick={() => onCloseRef.current?.()}
              >
                <Icon name="close" size={16} />
              </button>
            )}
          </div>
          {description === undefined || description === null ? null : (
            <p className="pj-modal-description" id={descriptionId}>
              {description}
            </p>
          )}
          <div className="pj-modal-body">{children}</div>
        </div>
        {footer === undefined || footer === null ? null : <div className="pj-modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/* -------------------------------------------------------------------------- */
/* TextField / Button                                                          */
/* -------------------------------------------------------------------------- */

export function TextField({
  value,
  onChange,
  placeholder,
  label,
  autoFocus = false,
  disabled = false,
  onEnter,
  inputRef,
  maxLength,
}) {
  const generatedId = useId()
  const fieldId = `pj-field-${generatedId.replace(/[:]/g, '')}`
  const handleChange = (event) => {
    onChange?.(event.target.value, event)
  }
  const handleKeyDown = (event) => {
    if (event.key !== 'Enter' || onEnter === undefined) return
    event.preventDefault()
    onEnter(event.currentTarget.value)
  }
  return (
    <div className={cx('pj-field', disabled && 'pj-field-disabled')}>
      {label === undefined || label === null || label === '' ? null : (
        <label className="pj-field-label" htmlFor={fieldId}>
          {label}
        </label>
      )}
      <input
        ref={inputRef}
        id={fieldId}
        className="pj-input"
        type="text"
        value={value ?? ''}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        maxLength={maxLength}
        spellCheck={false}
        autoComplete="off"
        data-autofocus={autoFocus === true ? '' : undefined}
      />
    </div>
  )
}

const BUTTON_VARIANTS = {
  primary: 'pj-button-primary',
  outline: 'pj-button-outline',
  ghost: 'pj-button-ghost',
  danger: 'pj-button-danger',
}

export function Button({ variant = 'outline', onClick, children, disabled = false, type = 'button', className }) {
  return (
    <button
      type={type}
      className={cx('pj-button', BUTTON_VARIANTS[variant] ?? BUTTON_VARIANTS.outline, className)}
      data-variant={variant}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/* -------------------------------------------------------------------------- */
/* Toast                                                                       */
/* -------------------------------------------------------------------------- */

export function Toast({ message, actionLabel, onAction, onDismiss, duration = 5000 }) {
  const onDismissRef = useRef(onDismiss)
  onDismissRef.current = onDismiss
  const hasDismiss = typeof onDismiss === 'function'
  const empty = message === undefined || message === null || message === ''

  useEffect(() => {
    if (empty || !hasDismiss) return undefined
    const timer = setTimeout(() => {
      onDismissRef.current?.()
    }, duration)
    return () => clearTimeout(timer)
  }, [empty, hasDismiss, duration, message, actionLabel])

  if (empty) return null

  const runAction = () => {
    onAction?.()
    if (hasDismiss) onDismissRef.current?.()
  }

  return (
    <div className="pj-toast" role="status" aria-live="polite">
      <span className="pj-toast-message">{message}</span>
      {actionLabel === undefined || actionLabel === null || actionLabel === '' ? null : (
        <button type="button" className="pj-toast-action" onClick={runAction}>
          {actionLabel}
        </button>
      )}
    </div>
  )
}
