/**
 * Host half of dsh-plugin-title-suggest.
 *
 * Generates a title suggestion for a session using the same service the
 * built-in session-title provider streams through (`ctx.llm`), and exposes it
 * to the browser half over one exact HTTP route.
 *
 * Why an HTTP route rather than a Typert Remote:
 *   Generated Remotes depend on the repository's Typert code-generation step,
 *   which an out-of-tree plugin cannot participate in. `ctx.webServer` is a
 *   plain named-route registry, so a standalone plugin can own one exact path.
 *
 * Why this never calls `sessionTitle.rename()`:
 *   A rename pins the session and stops automatic title revisions. The
 *   suggestion is a candidate string the user copies into the rename input, so
 *   the built-in title system keeps sole ownership of the real title.
 */

import { randomUUID } from 'node:crypto'

/** Exact route path owned by this plugin (exact match; cannot shadow the SPA fallback). */
const ROUTE_PATH = '/plugin/title-suggest'

/**
 * Build the user message for the helper request.
 *
 * This mirrors `createUserMessage` from `@deepseek-ai/dsh-llm` without
 * importing it. A standalone plugin linked outside the profile's node_modules
 * cannot resolve the harness packages (Node walks up from the plugin's own
 * directory and never reaches the app's node_modules), and a runtime import
 * there fails the whole profile boot. The construction is reproduced rather
 * than depended upon because it is small and stable: a user-role message with
 * a fresh UUID identity. The shipped helper additionally applies
 * `brandString()` (a compile-time-only identity function) and deep-freezes the
 * result; neither has runtime effect on what the adapter reads.
 *
 * @param text - the framed prompt text.
 * @returns a message object the LLM runtime accepts.
 */
function createUserMessage(text) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [Object.freeze({ type: 'text', text })],
    source: Object.freeze({ kind: 'plugin', plugin: 'dsh-plugin-title-suggest' }),
  })
}

/** Settings defaults, mirrored by the browser half so both agree without a round trip. */
const DEFAULT_SETTINGS = {
  /** Compose the suggestion from these parts, in this order. */
  showModel: true,
  showFreeText: true,
  showSummary: true,

  /** Text placed between the selected parts. */
  separator: ' · ',

  /** Refresh the suggestion each time the rename dialog opens. */
  autoRefresh: true,

  /**
   * Fixing rule: when the session already carries a user-authored title, reuse
   * the last suggestion instead of regenerating, so a hand-named session does
   * not quietly drift.
   */
  keepWhenPinned: true,

  /** How many of the most recent human messages feed the summary. */
  recentMessageCount: 3,

  /** Output budget for the helper request. */
  maxOutputTokens: 96,

  /** End-to-end deadline for the helper request. */
  timeoutMs: 30000,
}

/** In-memory cache of the last suggestion per session, backing `keepWhenPinned`. */
const lastSuggestionBySession = new Map()

/**
 * System instruction for the summary.
 *
 * Deliberately restated here rather than importing the shipped provider's
 * private helper: the plugin must not depend on an unexported internal.
 */
function summarySystemPrompt() {
  return [
    'Summarize the most recent task in this AI coding-assistant session.',
    'Return only the summary on one line, in plain text using the same natural language the user wrote in,',
    'with no quotes, prefix, explanation, Markdown, XML, or terminal control characters.',
    'Aim for roughly 12 CJK characters or 6 words.',
  ].join(' ')
}

/** Strip control characters and collapse whitespace, mirroring title normalization. */
function normalizeLine(text) {
  return String(text)
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Read a request body as UTF-8 text, bounded against a malformed client. */
function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > limitBytes) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Send a JSON response; never cached, since a suggestion is per-session state. */
function sendJson(res, status, payload) {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * Reject anything that is not a loopback, same-origin browser request.
 *
 * The route is owned as an exact path outside the `/api` prefix, so
 * `dsh-client-connection` does not authenticate it. The server binds loopback
 * only, and this guard narrows it further: it blocks DNS-rebinding (foreign
 * Host), cross-site browser requests, and any non-local peer.
 */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false

  const host = request.headers.host
  if (typeof host !== 'string') return false

  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') {
    return false
  }

  if (request.headers['sec-fetch-site'] === 'cross-site') return false

  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Collect the most recent human messages, oldest first.
 *
 * Matches the built-in provider's eligibility rule exactly: a genuine
 * `user/message` event whose source kind is `user`, carrying at least one
 * non-empty text block. Plugin-sourced injected messages are excluded.
 */
function recentHumanMessages(session, count) {
  const events = session.snapshotEvents()
  if (!Array.isArray(events)) return []

  const collected = []
  for (const event of events) {
    if (event?.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue

    const content = event.data.content
    if (!Array.isArray(content)) continue

    const text = content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (normalizeLine(text).length === 0) continue

    collected.push({ seq: event.seq, text })
  }

  return collected.slice(-Math.max(1, count))
}

/** True when the session's newest title event was authored by the user. */
function hasUserTitle(session) {
  const events = session.snapshotEvents()
  if (!Array.isArray(events)) return false
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type !== 'session/title') continue
    return events[i].data?.source?.kind === 'user'
  }
  return false
}

/** Resolve the provider/model route the session recorded, if any. */
function resolveRoute(session) {
  const config = session.requestHeader()?.config
  if (!config?.provider || !config?.model) return undefined
  return { provider: config.provider, model: config.model }
}

/**
 * Stream the one-line summary from the model.
 *
 * Uses `purpose: 'session-title'` so adapters apply their title-specific
 * behavior (the DeepSeek adapter disables thinking under that purpose, so the
 * whole budget goes to visible text). Only text blocks are accepted; a tool
 * call or empty output is rejected rather than producing a blank suggestion.
 */
async function generateSummary(ctx, session, messages, route, settings, signal) {
  const framed = JSON.stringify(messages.map(({ seq, text }) => ({ seq, text })))
  const system = summarySystemPrompt()

  const options = {
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage(framed)],
    system,
    maxTokens: settings.maxOutputTokens,
    sessionId: session.id,
    purpose: 'session-title',
    signal,
  }

  // Chunk vocabulary is the raw stream protocol (`text-delta` carries the
  // partial text at `chunk.text`), not the assembled block shape. Reasoning and
  // tool-call deltas are ignored: a suggestion must be visible text only.
  let text = ''
  let rejected = false
  for await (const chunk of ctx.llm.stream(options)) {
    signal?.throwIfAborted()
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk?.type === 'tool-call-delta') rejected = true
  }

  if (rejected) throw new Error('title suggestion must be text only')
  return normalizeLine(text)
}

/** Compose the suggestion from the enabled parts, honoring the separator. */
function composeSuggestion(parts, separator) {
  const chosen = parts.filter((value) => typeof value === 'string' && value.trim().length > 0)
  return chosen.join(separator)
}

/**
 * Host plugin entry.
 *
 * Injects `webserver` (route ownership), `sessions` (session lookup) and `llm`
 * (generation). No service is provided; the plugin owns only its route.
 */
export const inject = ['webServer', 'sessions', 'llm']

export function apply(ctx) {
  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      try {
        if (!isLoopbackRequest(req)) {
          sendJson(res, 403, { ok: false, error: 'loopback requests only' })
          return
        }

        // GET: hand the browser half the current defaults so the settings page
        // can render before the user changes anything.
        if (req.method === 'GET') {
          sendJson(res, 200, { ok: true, settings: DEFAULT_SETTINGS })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }

        const raw = await readBody(req)
        const parsed = raw.length === 0 ? {} : JSON.parse(raw)
        const sessionId = parsed?.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          sendJson(res, 400, { ok: false, error: 'sessionId is required' })
          return
        }

        const session = await ctx.sessions.get(sessionId)
        if (!session) {
          sendJson(res, 404, { ok: false, error: 'session not found' })
          return
        }

        const settings = { ...DEFAULT_SETTINGS, ...(parsed?.settings ?? {}) }

        // Nothing enabled means nothing to compose: skip the model call entirely
        // rather than spending it on a result that would be discarded.
        if (!settings.showModel && !settings.showFreeText && !settings.showSummary) {
          sendJson(res, 200, { ok: true, suggestion: null, reason: 'every part is disabled' })
          return
        }

        // Fixing rule: a hand-named session reuses its last suggestion.
        if (settings.keepWhenPinned && hasUserTitle(session)) {
          const cached = lastSuggestionBySession.get(sessionId)
          if (cached) {
            sendJson(res, 200, { ok: true, suggestion: cached.suggestion, model: cached.model, cached: true })
            return
          }
        }

        const messages = recentHumanMessages(session, settings.recentMessageCount)
        if (messages.length === 0) {
          sendJson(res, 200, { ok: true, suggestion: null, reason: 'no human messages yet' })
          return
        }

        const route = resolveRoute(session)
        if (!route) {
          // Without a logged route there is nothing to ask; the session has
          // never dispatched a request.
          sendJson(res, 200, { ok: true, suggestion: null, reason: 'no model route recorded yet' })
          return
        }

        const parts = []
        if (settings.showModel) parts.push(route.model)

        // Both free text and summary come from one model call: the summary IS
        // the free text. When only free text is enabled the same call serves it.
        let summary = ''
        if (settings.showFreeText || settings.showSummary) {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), settings.timeoutMs)
          try {
            summary = await generateSummary(ctx, session, messages, route, settings, controller.signal)
          } finally {
            clearTimeout(timer)
          }
        }

        if (settings.showSummary && summary) parts.push(summary)
        else if (settings.showFreeText && summary) parts.push(summary)

        const suggestion = composeSuggestion(parts, settings.separator)
        if (suggestion.length === 0) {
          sendJson(res, 200, { ok: true, suggestion: null, reason: 'model produced no text' })
          return
        }

        lastSuggestionBySession.set(sessionId, { suggestion, model: route.model })
        sendJson(res, 200, { ok: true, suggestion, model: route.model })
      } catch (error) {
        ctx.logger?.warn?.(`title-suggest: ${error?.message ?? error}`)
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  ctx.effect(() => dispose, 'title-suggest: route')
}
