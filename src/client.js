/**
 * Browser half of dsh-plugin-title-suggest.
 *
 * Injects a "suggested title" row beneath the session rename input. The row is
 * produced by a MutationObserver rather than a slot, because the rename dialog
 * renders its body as a hard-coded `[input, error?]` array and declares no slot
 * anywhere inside it. Observation is therefore the only way to reach that
 * position without patching the shipped bundle.
 *
 * Locating the dialog is done by STRUCTURE, never by class name or label text:
 *   - the CSS-module class hashes change on every build;
 *   - `aria-label` and the dialog title are localized strings.
 * The one stable signal is shape: the session rename dialog portals a
 * `div[role="dialog"][aria-modal="true"]` whose body holds an `input` as its
 * first direct child. The workspace rename dialog has a different body, so the
 * two do not collide.
 *
 * Clicking the row writes the suggestion into the input through the native
 * value setter plus a bubbling `input` event, which is what React's onChange
 * listens for. The suggestion is never applied automatically: a user-authored
 * rename pins the session in the built-in title service, so silently writing it
 * would fight the title system.
 */

import { createElement as h, useState } from 'react'

/** Inline styles are used because the plugin cannot participate in CSS-module hashing. */
const STYLES = {
  row: [
    'display:flex',
    'align-items:center',
    'gap:8px',
    'margin-top:8px',
    'padding:8px 10px',
    'border-radius:10px',
    'background:var(--dsw-alias-button-elevated-fill,rgba(127,127,127,.12))',
    'color:var(--dsw-alias-label-secondary,inherit)',
    'font-size:13px',
    'line-height:18px',
    'cursor:pointer',
    'user-select:none',
  ].join(';'),
  label: ['flex:none', 'font-size:11px', 'opacity:.7'].join(';'),
  text: ['flex:1', 'min-width:0', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap'].join(';'),
  hint: ['flex:none', 'font-size:11px', 'opacity:.6'].join(';'),
}

/** Marker attribute identifying our injected row, so re-runs never duplicate it. */
const ROW_ATTR = 'data-title-suggest-row'

/** Settings cached from the host route; the settings page writes this same shape. */
let settings = {
  showModel: true,
  showFreeText: true,
  showSummary: true,
  separator: ' · ',
  autoRefresh: true,
  keepWhenPinned: true,
  recentMessageCount: 3,
}

/** Which session id the currently rendered suggestion belongs to. */
let currentSessionId = null

/** Guards against overlapping generation requests for the same dialog. */
let inflight = null

/** Fetch the host defaults once at startup; failure just keeps the local defaults. */
async function loadSettings(ctx) {
  try {
    const response = await fetch('/plugin/title-suggest', { method: 'GET' })
    if (!response.ok) return
    const payload = await response.json()
    if (payload?.settings) settings = { ...settings, ...payload.settings }
  } catch (error) {
    ctx.logger?.warn?.(`title-suggest: settings load failed: ${error?.message ?? error}`)
  }
}

/**
 * Resolve the session the rename dialog is targeting.
 *
 * The dialog carries no session id in the DOM (it lives in React state), so
 * read the connected session from the client session store instead. The rename
 * dialog can only be opened from a session row, and at that moment the store's
 * `current` is that session: `open()` sets it before the row's menu renders.
 * Using the projection rather than scraping the DOM keeps this independent of
 * list markup.
 *
 * @returns the session id, or null when nothing is open.
 */
function resolveSessionId(ctx) {
  try {
    const snapshot = ctx.sessions?.getListSnapshot?.()
    const current = snapshot?.current
    if (typeof current === 'string' && current.length > 0) return current
  } catch (error) {
    ctx.logger?.warn?.(`title-suggest: session lookup failed: ${error?.message ?? error}`)
  }
  return null
}

/**
 * Localized titles of the workspace rename dialog.
 *
 * The session and workspace rename dialogs are structurally IDENTICAL in the
 * DOM: both portal a `div[role="dialog"][aria-modal="true"]` whose body is a
 * single autofocus `text` input, with no description and no per-dialog
 * `className`. Verified against `dsh-client-ui-workspace`, so no structural
 * test separates them. The dialog's title — surfaced as the dialog element's
 * `aria-label` — is the only distinguishing signal, and the app localizes it.
 *
 * The rule therefore EXCLUDES known workspace titles and accepts everything
 * else that matches the rename shape, rather than requiring one exact session
 * title. That keeps the row working under a locale this revision has never
 * seen. The failure direction is deliberate: the worst case is a suggestion row
 * under a same-shaped rename dialog, never a crash and never a write into a
 * field the user did not ask about (the row only writes when clicked).
 */
const WORKSPACE_RENAME_TITLES = new Set(['Rename workspace', '重命名工作区'])

/**
 * Identify the session-rename dialog among all open dialogs.
 *
 * @returns `{ dialog, input, body }`, or null when it is not open.
 */
function findRenameDialog() {
  const dialogs = document.querySelectorAll('div[role="dialog"][aria-modal="true"]')
  for (const dialog of dialogs) {
    const title = dialog.getAttribute('aria-label') ?? ''

    // Never touch the workspace rename dialog.
    if (WORKSPACE_RENAME_TITLES.has(title)) continue

    // The body holds exactly one text input.
    const inputs = dialog.querySelectorAll('input')
    if (inputs.length !== 1) continue

    const input = inputs[0]
    if (input.type !== 'text' && input.type !== '') continue

    // The rename input is the body's first element, with at most one sibling
    // (the optional error row). This also rejects the create-session dialog.
    const body = input.parentElement
    if (!body) continue
    if (body.firstElementChild !== input) continue
    if (body.children.length > 2) continue

    // Accept the dialog: its title is either the known session one, or a title
    // we cannot classify (an untranslated locale), which is still not a
    // workspace title and matches the session dialog's shape exactly.
    return { dialog, input, body }
  }
  return null
}

/** Write a value into the React-controlled input so onChange fires. */
function writeInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Ask the host half for a suggestion for this session. */
async function requestSuggestion(ctx, sessionId) {
  const response = await fetch('/plugin/title-suggest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, settings }),
  })
  if (!response.ok) throw new Error(`host returned ${response.status}`)
  return response.json()
}

/**
 * Build the suggestion row.
 *
 * @param ctx - client root context.
 * @param input - the rename input the row belongs to.
 * @returns the row element.
 */
function buildRow(ctx, input) {
  const row = document.createElement('div')
  row.setAttribute(ROW_ATTR, '')
  row.style.cssText = STYLES.row

  const label = document.createElement('span')
  label.style.cssText = STYLES.label
  label.textContent = 'SUGGEST'

  const text = document.createElement('span')
  text.style.cssText = STYLES.text
  text.textContent = '…'

  const hint = document.createElement('span')
  hint.style.cssText = STYLES.hint
  hint.textContent = ''

  row.append(label, text, hint)

  row.addEventListener('click', () => {
    const value = text.dataset.value
    if (!value) return
    writeInputValue(input, value)
    hint.textContent = 'applied'
    setTimeout(() => {
      hint.textContent = ''
    }, 1200)
  })

  return row
}

/** Render a message into the row without offering it as a value. */
function setRowMessage(row, message) {
  const text = row.children[1]
  text.textContent = message
  delete text.dataset.value
}

/** Render a suggestion into the row, making it clickable. */
function setRowSuggestion(row, suggestion) {
  const text = row.children[1]
  text.textContent = suggestion
  text.dataset.value = suggestion
}

/**
 * Client services this plugin requires.
 *
 * Every service touched on `ctx` must be declared here: the Cordis runtime
 * refuses access to an undeclared service ("cannot get property \"slots\"
 * without inject") and that failure takes down the whole loader entry, which
 * surfaces as "Failed to load plugins" on startup.
 *
 * - `sessions` supplies the connected-session projection used to resolve which
 *   session the rename dialog targets.
 * - `slots` is the UI contribution registry the settings section registers into.
 */
export const inject = ['sessions', 'slots']

/** Persist settings to localStorage so a choice survives a reload without host state. */
function persistSettings() {
  try {
    localStorage.setItem('dsh-title-suggest/settings', JSON.stringify(settings))
  } catch {
    // Storage can be unavailable (private mode); the in-memory value still applies.
  }
}

/** Restore settings from localStorage at startup. */
function restoreSettings() {
  try {
    const raw = localStorage.getItem('dsh-title-suggest/settings')
    if (raw) settings = { ...settings, ...JSON.parse(raw) }
  } catch {
    // A malformed record is ignored rather than breaking plugin startup.
  }
}

/**
 * One labeled toggle row.
 *
 * @param props.label - visible row label.
 * @param props.checked - current value.
 * @param props.onChange - called with the next value.
 */
function ToggleRow({ label, checked, onChange }) {
  return h(
    'label',
    {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 0',
        cursor: 'pointer',
        fontSize: '13px',
      },
    },
    h('input', {
      type: 'checkbox',
      checked,
      onChange: (event) => onChange(event.target.checked),
    }),
    h('span', null, label),
  )
}

/**
 * Logic-style segmented control for choosing which parts compose the suggestion.
 *
 * Each part toggles independently, matching the "asset export options" pattern:
 * the row shows every available element with its own on/off state, and the
 * preview underneath shows the composed result.
 */
function PartSegment({ value, onChange }) {
  const parts = [
    ['showModel', 'Model'],
    ['showFreeText', 'Free text'],
    ['showSummary', 'Summary'],
  ]
  return h(
    'div',
    { style: { display: 'flex', gap: '4px', marginBottom: '10px' } },
    ...parts.map(([key, label]) =>
      h(
        'button',
        {
          key,
          type: 'button',
          onClick: () => onChange({ ...value, [key]: !value[key] }),
          style: {
            flex: '1',
            padding: '6px 10px',
            borderRadius: '8px',
            cursor: 'pointer',
            fontSize: '12px',
            border: '0.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,.3))',
            background: value[key]
              ? 'var(--dsw-alias-button-primary-fill, rgba(80,140,255,.25))'
              : 'transparent',
            color: 'inherit',
            fontWeight: value[key] ? '600' : '400',
          },
        },
        label,
      ),
    ),
  )
}

/** Show the composed shape so the user sees the template before using it. */
function Preview({ value }) {
  const sample = []
  if (value.showModel) sample.push('model-name')
  if (value.showFreeText || value.showSummary) sample.push('recent task summary')
  return h(
    'div',
    {
      style: {
        padding: '8px 10px',
        borderRadius: '8px',
        fontSize: '12px',
        opacity: '0.85',
        background: 'var(--dsw-alias-button-elevated-fill, rgba(127,127,127,.12))',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
    },
    sample.length > 0 ? sample.join(value.separator) : '(nothing selected)',
  )
}

/**
 * Settings section contributed to the Settings panel.
 *
 * @param props - slot-provided props; only `close` is relevant to action rows.
 */
function TitleSuggestSettings() {
  const [local, setLocal] = useState(settings)

  const update = (patch) => {
    const next = { ...local, ...patch }
    setLocal(next)
    settings = next
    persistSettings()
  }

  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '4px 0' } },
    h('div', { style: { fontSize: '12px', opacity: '0.7', marginBottom: '6px' } }, 'Suggestion composition'),
    h(PartSegment, { value: local, onChange: (next) => update(next) }),
    h(Preview, { value: local }),
    h('div', { style: { height: '12px' } }),
    h(ToggleRow, {
      label: 'Refresh the suggestion each time the rename dialog opens',
      checked: local.autoRefresh,
      onChange: (autoRefresh) => update({ autoRefresh }),
    }),
    h(ToggleRow, {
      label: 'Keep the last suggestion for sessions you renamed yourself',
      checked: local.keepWhenPinned,
      onChange: (keepWhenPinned) => update({ keepWhenPinned }),
    }),
    h(
      'label',
      { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '6px 0', fontSize: '13px' } },
      h('span', null, 'Recent messages used for the summary'),
      h('input', {
        type: 'number',
        min: 1,
        max: 10,
        value: local.recentMessageCount,
        onChange: (event) => update({ recentMessageCount: Number(event.target.value) || 1 }),
        style: { width: '56px', padding: '2px 6px', borderRadius: '6px', border: '0.5px solid currentColor', background: 'transparent', color: 'inherit' },
      }),
    ),
  )
}

/**
 * Client plugin body: observe the document for the rename dialog, keep exactly
 * one suggestion row attached beneath its input, and contribute the settings
 * section.
 *
 * @param ctx - client root context.
 */
export function apply(ctx) {
  restoreSettings()
  loadSettings(ctx)

  const observer = new MutationObserver(() => {
    const found = findRenameDialog()
    const existing = document.querySelector(`[${ROW_ATTR}]`)

    if (!found) {
      // Dialog closed: drop the row so the next open starts clean.
      existing?.remove()
      currentSessionId = null
      inflight = null
      return
    }

    const { input, body } = found
    if (existing && existing.parentElement === body) return

    existing?.remove()
    const row = buildRow(ctx, input)
    body.append(row)

    // Resolve which session this dialog targets. The dialog carries no session
    // id in the DOM, so read it from the app's own store projection.
    const sessionId = resolveSessionId(ctx)
    if (!sessionId) {
      setRowMessage(row, 'no session selected')
      return
    }

    if (!settings.autoRefresh && currentSessionId === sessionId && inflight === null) return
    currentSessionId = sessionId

    setRowMessage(row, 'generating…')
    inflight = requestSuggestion(ctx, sessionId)
      .then((payload) => {
        if (!document.body.contains(row)) return
        if (payload?.suggestion) setRowSuggestion(row, payload.suggestion)
        else setRowMessage(row, payload?.reason ?? 'no suggestion')
      })
      .catch((error) => {
        if (document.body.contains(row)) setRowMessage(row, `unavailable: ${error.message}`)
      })
      .finally(() => {
        inflight = null
      })
  })

  observer.observe(document.body, { childList: true, subtree: true })

  ctx.effect(() => () => observer.disconnect(), 'title-suggest: observer')

  // Contribute the settings section. `settings.section` is a root-scoped list;
  // the section's own label is what the settings navigation renders.
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'title-suggest',
        order: 60,
        label: () => 'Title suggestion',
      },
      TitleSuggestSettings,
    ),
  )
}
