/**
 * dsh-turn-speed, node half.
 *
 * Two jobs:
 *
 *  1. Register the `/turn-speed-api` route on the Web server (loopback-only
 *     trust, mirroring dsh-429-guard's pattern). The browser half POSTs its own
 *     state there and the route serves it back as JSON, so this plugin can be
 *     verified end to end from a terminal — no browser console, no devtools,
 *     and no dependence on the cookie-gated index.
 *
 *  2. Persist the last report to `$DSH_HOME/storages/dsh-turn-speed.json` so a
 *     diagnosis survives a closed terminal or a reload.
 *
 * The route is diagnostics only: it is not part of the user-facing feature and
 * never touches session state. The numbers themselves are folded in the
 * browser half, from the Session Controller's event window, using the same
 * reading the host's own `sessionStats` projection takes.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The route is the plugin's only host-side surface, so it waits for the server. */
export const inject = ['webServer']

/** Route prefix shared with the browser half. */
const ROUTE_PREFIX = '/turn-speed-api'

/** Flush coalescing: the browser reports continuously while a turn streams. */
const FLUSH_DELAY_MS = 2500

/** Bound on the diagnostics body this route will buffer. */
const MAX_BODY_BYTES = 256 * 1024

/** Diagnostics file path under the harness home. */
function reportPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'dsh-turn-speed.json')
}

/**
 * Load the previous report, tolerating absence and corruption.
 * @returns the parsed report, or null.
 */
function loadReport() {
  try {
    const parsed = JSON.parse(readFileSync(reportPath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed.latest ?? null : null
  } catch (error) {
    return null
  }
}

/**
 * Host-side state shared with the route handler.
 */
class Diagnostics {
  constructor() {
    /** Latest report posted by a browser half. */
    this.latest = loadReport()
    /** Every distinct page that has reported, by href. */
    this.pages = new Map()
    /** Raw reports seen since activation. */
    this.reports = 0
    /** Reports that failed to parse. */
    this.rejected = 0
    this.timer = null
  }

  /**
   * Accept one report body.
   * @param body - raw request body.
   * @returns true when the body was a JSON object and was accepted.
   */
  accept(body) {
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch (error) {
      this.rejected += 1
      return false
    }
    if (parsed === null || typeof parsed !== 'object') {
      this.rejected += 1
      return false
    }
    this.reports += 1
    this.latest = { ...parsed, receivedAt: Date.now() }
    const href = typeof parsed.href === 'string' ? parsed.href : '(unknown page)'
    this.pages.set(href, this.latest)
    this.scheduleFlush()
    return true
  }

  /** Coalesce writes; the timer is unref'd so it never holds the process open. */
  scheduleFlush() {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush()
    }, FLUSH_DELAY_MS)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  /** Write the latest report and every page that has reported. */
  flush() {
    try {
      const path = reportPath()
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({
        latest: this.latest,
        pages: [...this.pages.values()],
        reports: this.reports,
        rejected: this.rejected,
        writtenAt: Date.now()
      }, null, 2), 'utf8')
    } catch (error) {
      console.warn('[turn-speed] report write failed:', String((error && error.message) || error))
    }
  }

  /**
   * The route's read view.
   * @returns the served payload.
   */
  snapshot() {
    return {
      ok: true,
      reports: this.reports,
      rejected: this.rejected,
      latest: this.latest,
      pages: [...this.pages.values()],
      at: Date.now()
    }
  }
}

/**
 * Whether one request comes from this machine's loopback interface. The route
 * carries no credentials, so it must never be reachable off-box.
 * @param req - incoming request.
 * @returns true when the peer is loopback.
 */
function isLoopback(req) {
  const address = req.socket && req.socket.remoteAddress
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * Send one JSON response.
 * @param res - response to write.
 * @param code - HTTP status.
 * @param payload - JSON-serializable body.
 */
function sendJson(res, code, payload) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(JSON.stringify(payload, null, 2))
}

/**
 * Buffer a request body under a hard cap.
 * @param req - incoming request.
 * @param limit - maximum accepted bytes.
 * @returns the body, or null when it exceeded the cap.
 */
function readBody(req, limit) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(null))
  })
}

/**
 * Plugin body: serve the diagnostics route.
 * @param ctx - host context carrying the Web server service.
 */
export function apply(ctx) {
  const diagnostics = new Diagnostics()

  /**
   * Route handler for every `/turn-speed-api` request.
   * @param req - incoming request.
   * @param res - response to write.
   */
  async function handle(req, res) {
    if (!isLoopback(req)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    let url
    try {
      url = new URL(req.url, 'http://localhost')
    } catch (error) {
      res.writeHead(400)
      res.end('bad request')
      return
    }
    const pathname = url.pathname

    // Liveness: proves the host half is mounted without needing a browser.
    if (pathname === ROUTE_PREFIX + '/health' && req.method === 'GET') {
      sendJson(res, 200, { ok: true, mounted: true, reports: diagnostics.reports })
      return
    }

    if (pathname === ROUTE_PREFIX + '/state' && req.method === 'GET') {
      sendJson(res, 200, diagnostics.snapshot())
      return
    }

    if (pathname === ROUTE_PREFIX + '/report' && req.method === 'POST') {
      const body = await readBody(req, MAX_BODY_BYTES)
      if (body === null) {
        sendJson(res, 413, { ok: false, error: 'body too large' })
        return
      }
      const accepted = diagnostics.accept(body)
      sendJson(res, accepted ? 200 : 400, { ok: accepted })
      return
    }

    res.writeHead(404)
    res.end('not found')
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: handle
  }), 'turn-speed: /turn-speed-api diagnostics route')

  ctx.effect(() => () => {
    if (diagnostics.timer !== null) clearTimeout(diagnostics.timer)
    diagnostics.flush()
  }, 'turn-speed: flush diagnostics on dispose')

  console.log(`[turn-speed] diagnostics route mounted at ${ROUTE_PREFIX}`)
}
