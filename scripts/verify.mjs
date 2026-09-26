/**
 * dsh-turn-speed verification suite.
 *
 * Runs BOTH halves without a browser:
 *   - the browser bundle is materialized through a stub `window.__ModuleLoader__`
 *     against a minimal DOM, so the fold math, the dialog patcher (including
 *     React-reconciliation repair), and the real `apply()` path through
 *     `ctx.sessions` are exercised;
 *   - the node half is imported and its `/turn-speed-api` handler is driven
 *     with fake requests.
 *
 * The factory returns its own `module.exports`, so exports are captured from
 * the return value — exactly what the platform loader consumes.
 *
 * Usage: node scripts/verify.mjs
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

let checks = 0
const failures = []
/** Assert one labelled condition. */
function ok(label, condition) {
  checks += 1
  if (!condition) failures.push(label)
}
/** Assert one labelled primitive equality. */
function eq(label, actual, expected) {
  checks += 1
  if (actual !== expected) failures.push(`${label}: actual=${String(actual)} expected=${String(expected)}`)
}
/** Assert approximate numeric equality. */
function near(label, actual, expected, epsilon = 0.05) {
  checks += 1
  if (typeof actual !== 'number' || Math.abs(actual - expected) > epsilon) {
    failures.push(`${label}: actual=${String(actual)} expected鈮?{String(expected)}`)
  }
}

//#region minimal DOM
/** One element with just enough DOM for the selectors this plugin uses. */
class El {
  constructor(tagName, doc) {
    this.tagName = String(tagName).toUpperCase()
    this.ownerDocument = doc
    this.attributes = new Map()
    this.childNodes = []
    this.parentNode = null
    this.__text = ''
  }
  get children() {
    return this.childNodes
  }
  get childElementCount() {
    return this.childNodes.length
  }
  get textContent() {
    let out = this.__text
    for (const child of this.childNodes) out += child.textContent
    return out
  }
  set textContent(value) {
    this.childNodes = []
    this.__text = String(value)
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value))
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }
  removeAttribute(name) {
    this.attributes.delete(name)
  }
  appendChild(child) {
    child.parentNode = this
    this.childNodes.push(child)
    return child
  }
  removeChild(child) {
    const at = this.childNodes.indexOf(child)
    if (at >= 0) this.childNodes.splice(at, 1)
    child.parentNode = null
    return child
  }
  /** Matches `tag`, `[attr]`, `[attr="v"]`, `tag[attr]`, `tag[attr="v"]`. */
  static matches(node, selector) {
    const parsed = /^([a-zA-Z]*)(?:\[([\w-]+)(?:="([^"]*)")?\])?$/.exec(selector)
    if (parsed === null) return false
    const tag = parsed[1]
    const attr = parsed[2]
    const value = parsed[3]
    if (tag !== '' && node.tagName !== tag.toUpperCase()) return false
    if (attr === undefined) return true
    const actual = node.getAttribute(attr)
    if (actual === null) return false
    return value === undefined || actual === value
  }
  descendants(out = []) {
    for (const child of this.childNodes) {
      if (child instanceof El) {
        out.push(child)
        child.descendants(out)
      }
    }
    return out
  }
  querySelector(selector) {
    for (const node of this.descendants()) if (El.matches(node, selector)) return node
    return null
  }
  querySelectorAll(selector) {
    return this.descendants().filter((node) => El.matches(node, selector))
  }
}

/** A document with a head, a body, a `lang`, and the selector entry points used. */
function makeDocument(lang = 'zh-CN') {
  const doc = {
    documentElement: { lang },
    body: null,
    head: null,
    createElement: (tag) => new El(tag, doc),
    querySelector: (selector) => doc.body.querySelector(selector),
    querySelectorAll: (selector) => doc.body.querySelectorAll(selector)
  }
  doc.body = new El('body', doc)
  doc.head = new El('head', doc)
  return doc
}

/** Build the shipped dialog: a `<dl data-session-stats-details>` with React's rows. */
function mountDialog(doc, reactRows = 2) {
  const dl = new El('dl', doc)
  dl.setAttribute('data-session-stats-details', 'true')
  for (let index = 0; index < reactRows; index += 1) {
    dl.appendChild(new El('dt', doc))
    dl.appendChild(new El('dd', doc))
  }
  doc.body.appendChild(dl)
  return dl
}
//#endregion

//#region bundle materialization
/**
 * Materialize the browser bundle.
 * @param doc - the document the bundle will see.
 * @param overrides - window overrides (e.g. a throwing fetch).
 * @returns the exports, the fetch log, and the interval callbacks.
 */
function materialize(doc, overrides = {}) {
  const requests = []
  const intervals = []
  const retries = []
  const timeouts = []
  const observers = []
  const win = {
    location: { href: 'http://127.0.0.1:3080/' },
    requestAnimationFrame(callback) {
      callback()
      return 1
    },
    setInterval(callback) {
      intervals.push(callback)
      return intervals.length
    },
    clearInterval() {},
    fetch(url, init) {
      requests.push({ url, init })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) })
    },
    ...overrides
  }
  win.document = doc
  const sandbox = {
    window: win,
    document: doc,
    navigator: { language: 'zh-CN' },
    console: { log() {}, warn() {}, error() {} },
    // Both timer kinds are captured rather than scheduled, so the test decides
    // when a debounced report or a service-waiting retry happens.
    setTimeout(callback) {
      timeouts.push(callback)
      return timeouts.length
    },
    clearTimeout(id) {
      timeouts[id - 1] = null
    },
    setInterval(callback) {
      retries.push(callback)
      return retries.length
    },
    clearInterval(id) {
      retries[id - 1] = null
    },
    MutationObserver: class {
      constructor(callback) {
        this.callback = callback
        this.disconnected = false
        observers.push(this)
      }
      observe() {}
      disconnect() {
        this.disconnected = true
        const at = observers.indexOf(this)
        if (at >= 0) observers.splice(at, 1)
      }
    }
  }
  const context = vm.createContext(sandbox)
  let registration = null
  win.__ModuleLoader__ = { load: (record) => { registration = record } }
  vm.runInContext(readFileSync(join(root, 'lib', 'client.js'), 'utf8'), context, { filename: 'client.js' })
  const requires = []
  const exports = registration.factory((spec) => {
    requires.push(spec)
    throw new Error(`unexpected require(${spec})`)
  })
  /** Run every pending timeout once. */
  const drainTimeouts = () => {
    const pending = timeouts.splice(0, timeouts.length)
    for (const callback of pending) if (typeof callback === 'function') callback()
  }
  /** Run every scheduled service-waiting retry. */
  const drainRetries = (rounds = 1) => {
    for (let round = 0; round < rounds; round += 1) {
      for (let index = 0; index < retries.length; index += 1) {
        const callback = retries[index]
        if (typeof callback === 'function') callback()
      }
    }
  }
  return { exports, requests, intervals, retries, timeouts, observers, drainTimeouts, drainRetries, registration, requires, window: win }
}
//#endregion

//#region event scaffolding
/** One window entry carrying a durable event. */
const entry = (event) => ({ type: 'event', event })
/** One window entry carrying a transient (client-only) event. */
const transient = (event) => ({ type: 'transient', event })
/** The client-only live chunk event for one text token. */
const liveChunk = (turn, step, time, text) => ({
  type: 'assistant/live-chunk',
  seq: time,
  time,
  data: { attemptId: 'a1', turn, step, chunk: { type: 'text-delta', index: 0, text } }
})

/** One settled turn with a sampled step. */
function sampledTurn(turn, { start, stepStart, firstToken, messageAt, tokens, end, stream }) {
  return [
    entry({ type: 'turn/start', time: start, data: { turn } }),
    entry({ type: 'step/start', time: stepStart, data: { turn, step: 1 } }),
    transient(liveChunk(turn, 1, firstToken, 'x')),
    entry({
      type: 'assistant/message',
      time: messageAt,
      data: { turn, step: 1, message: { role: 'assistant' }, stream: stream ?? [], usage: { outputTokens: tokens } }
    }),
    entry({ type: 'step/end', time: messageAt + 5, data: { turn, step: 1 } }),
    entry({ type: 'turn/end', time: end, data: { turn, reason: 'completed' } })
  ]
}
//#endregion

/**
 * A self-contained `sessions` service handle for one session id, with its own
 * listener sets, so a test case cannot pollute another's subscription counts.
 * @returns the service plus the sets it tracks listeners in.
 */
function sessionsFor(id, entries) {
  const sourceListeners = new Set()
  const listListeners = new Set()
  const source = {
    getSnapshot: () => ({ entries, hasMore: false, revision: 1, change: { kind: 'replace', entries } }),
    subscribe: (listener) => {
      sourceListeners.add(listener)
      return () => sourceListeners.delete(listener)
    }
  }
  return {
    service: {
      list: {
        getSnapshot: () => ({ current: id }),
        subscribe: (listener) => {
          listListeners.add(listener)
          return () => listListeners.delete(listener)
        }
      },
      binding: (asked) => (asked === id ? { eventSource: source } : undefined)
    },
    sourceListeners,
    listListeners
  }
}

//#region A. bundle shape
console.log('A. bundle shape')
{
  const doc = makeDocument()
  const { exports, registration, requires } = materialize(doc)
  eq('bundle id', registration.id, 'dsh-turn-speed')
  eq('requires no seeds (adds no graph row)', requires.length, 0)
  eq('exports.apply is a function', typeof exports.apply, 'function')
  // An unresolved declared inject would stop apply() from ever running, so the
  // seat list must stay empty; the service is waited for inside apply instead.
  eq('inject declares nothing (apply must always run)', JSON.stringify(exports.inject), '[]')
  ok('internals exposed for tests', typeof exports.__internals === 'object' && exports.__internals !== null)
}
//#endregion

//#region B. fold math
console.log('B. fold math')
{
  const doc = makeDocument()
  const { exports } = materialize(doc)
  const { collectTurns, buildModel } = exports.__internals

  // Turn 1 sampled; turn 2 in flight with no settlement yet.
  const twoTurns = [...sampledTurn(1, { start: 900, stepStart: 1000, firstToken: 1200, messageAt: 5000, tokens: 400, end: 5100 }),
    entry({ type: 'turn/start', time: 6000, data: { turn: 2 } }),
    entry({ type: 'step/start', time: 6100, data: { turn: 2, step: 1 } }),
    transient(liveChunk(2, 1, 6300, 'b'))]
  const buckets = collectTurns(twoTurns, 3)
  eq('collected two turns', buckets.length, 2)
  eq('newest turn first', buckets[0].turn, 2)
  eq('older turn second', buckets[1].turn, 1)
  eq('turn 1 counted its step', buckets[1].steps, 1)
  eq('turn 2 counted no step', buckets[0].steps, 0)

  const model = buildModel(buckets, 7000)
  ok('model built', model !== null)
  eq('targets the newest sampled turn', model.turn, 1)
  eq('labels itself as a previous turn', model.isCurrent, false)
  eq('not running', model.running, false)
  near('decode TPS = 400 / (5000-1200) ms', model.decodeTps, 105.26)
  near('end-to-end TPS = 400 / (5100-900) ms', model.endToEndTps, 95.24)
  eq('TTFT average = firstToken - stepStart', model.ttftMs, 200)
  eq('run time = turn/end - turn/start', model.runMs, 4200)
  eq('output tokens', model.outputTokens, 400)
  eq('steps', model.steps, 1)

  // A retried step emits assistant/attempt more than once; the host unit takes
  // only the first first-token reading, so ours must too.
  const retried = [
    entry({ type: 'turn/start', time: 0, data: { turn: 9 } }),
    entry({ type: 'step/start', time: 100, data: { turn: 9, step: 1 } }),
    entry({ type: 'assistant/attempt', time: 150, data: { turn: 9, step: 1, stream: [{ type: 'chunk', time: 200, chunk: { type: 'text-delta', index: 0, text: 'a' } }] } }),
    entry({ type: 'assistant/attempt', time: 160, data: { turn: 9, step: 1, stream: [{ type: 'chunk', time: 250, chunk: { type: 'text-delta', index: 0, text: 'b' } }] } }),
    entry({ type: 'assistant/message', time: 1200, data: { turn: 9, step: 1, message: { role: 'assistant' }, stream: [], usage: { outputTokens: 100 } } }),
    entry({ type: 'step/end', time: 1210, data: { turn: 9, step: 1 } }),
    entry({ type: 'turn/end', time: 1300, data: { turn: 9, reason: 'completed' } })
  ]
  const retriedModel = buildModel(collectTurns(retried, 3), 2000)
  eq('first attempt wins the TTFT reading', retriedModel.ttftMs, 100)
  near('decode measured from the first attempt only', retriedModel.decodeTps, 100)

  // A step that settles twice must count once, like the host unit's openStep.
  const doubleSettle = [
    entry({ type: 'turn/start', time: 0, data: { turn: 8 } }),
    entry({ type: 'step/start', time: 100, data: { turn: 8, step: 1 } }),
    transient(liveChunk(8, 1, 200, 'x')),
    entry({ type: 'assistant/message', time: 1100, data: { turn: 8, step: 1, message: { role: 'assistant' }, stream: [], usage: { outputTokens: 100 } } }),
    entry({ type: 'assistant/message', time: 1200, data: { turn: 8, step: 1, message: { role: 'assistant' }, stream: [], usage: { outputTokens: 100 } } }),
    entry({ type: 'step/end', time: 1210, data: { turn: 8, step: 1 } }),
    entry({ type: 'turn/end', time: 1300, data: { turn: 8, reason: 'completed' } })
  ]
  const doubleModel = buildModel(collectTurns(doubleSettle, 3), 2000)
  eq('second settlement ignored', doubleModel.outputTokens, 100)
  eq('TTFT counted once', doubleModel.ttftMs, 100)

  // A running newest turn IS the target once its step settles.
  const running = [...sampledTurn(1, { start: 900, stepStart: 1000, firstToken: 1200, messageAt: 5000, tokens: 400, end: 5100 }),
    entry({ type: 'turn/start', time: 6000, data: { turn: 2 } }),
    entry({ type: 'step/start', time: 6100, data: { turn: 2, step: 1 } }),
    transient(liveChunk(2, 1, 6300, 'b')),
    entry({ type: 'assistant/message', time: 8000, data: { turn: 2, step: 1, message: { role: 'assistant' }, stream: [], usage: { outputTokens: 200 } } }),
    entry({ type: 'step/end', time: 8010, data: { turn: 2, step: 1 } })]
  const runningModel = buildModel(collectTurns(running, 3), 9000)
  eq('running turn is the target', runningModel.turn, 2)
  eq('running turn is current', runningModel.isCurrent, true)
  eq('running turn is live', runningModel.running, true)
  near('running decode TPS = 200 / (8000-6300) ms', runningModel.decodeTps, 117.65)
  eq('running clock uses now', runningModel.runMs, 3000)

  // Packed-run stream: first-token time reconstructed from time0 + cumulative dt.
  const packed = exports.__internals.streamFirstTokenTime([
    { type: 'text-chunks', index: 0, time0: 1000, dt: [10, 10], texts: ['', 'hi'] }
  ])
  eq('packed run first token = time0 + dt[0]', packed, 1010)
  const packedToolCall = exports.__internals.streamFirstTokenTime([
    { type: 'tool-call-chunks', index: 0, id: 'c1', time0: 2000, dt: [5], args: ['{}'], name: 'read' }
  ])
  eq('name-bearing tool-call run uses time0', packedToolCall, 2000)
  const emptyStream = exports.__internals.streamFirstTokenTime([])
  eq('empty stream has no token time', emptyStream, undefined)
}
//#endregion

//#region C. dialog patching
console.log('C. dialog patching')
{
  const doc = makeDocument()
  const { exports } = materialize(doc)
  const { collectTurns, buildModel, syncDialog, ROW_ATTR, SEPARATOR_KEY, STYLE_ATTR } = exports.__internals
  const dl = mountDialog(doc, 2)
  const reactRows = 4 // 2 dt + 2 dd

  const window_ = sampledTurn(3, { start: 100, stepStart: 200, firstToken: 300, messageAt: 2300, tokens: 500, end: 2500 })
  const model = buildModel(collectTurns(window_, 3), 3000)

  const contributed = syncDialog(model, doc)
  eq('rows contributed', contributed, 7)
  const block = 1 + 14 // divider + 7 label/value pairs
  eq('children = React rows + divider + ours', dl.childNodes.length, reactRows + block)
  eq('turn recorded on the list', dl.getAttribute('data-turn-speed'), '3')
  ok('a divider opens our block', dl.childNodes[reactRows].tagName === 'DT')
  ok('divider is marked apart from the rows', dl.childNodes[reactRows].getAttribute(ROW_ATTR) === SEPARATOR_KEY)
  ok('divider carries no visible text', dl.childNodes[reactRows].textContent === '')
  ok('divider is hidden from the accessibility tree', dl.childNodes[reactRows].getAttribute('aria-hidden') === 'true')
  ok('first row follows the divider', dl.childNodes[reactRows + 1].getAttribute(ROW_ATTR) === 'decode')
  ok('values rendered in zh', dl.textContent.includes('本轮输出速度（TPS）'))
  ok('decode figure rendered', dl.textContent.includes('250 tok/s'))
  ok('session rows sit above the divider', dl.childNodes[reactRows - 1].getAttribute(ROW_ATTR) === null)

  // The divider must cross BOTH grid columns, or it would stop at the 16px
  // column gap and read as a stray dash rather than a separator.
  const style = doc.head.querySelector(`style[${STYLE_ATTR}]`)
  ok('a stylesheet was injected into the head', style !== null)
  ok('divider spans the full grid', style.textContent.includes('grid-column:1/-1'))
  ok('stylesheet is scoped to our separator only', style.textContent.includes(`dt[${ROW_ATTR}="${SEPARATOR_KEY}"]`))
  ok('divider reuses the dialog rule color', style.textContent.includes('--dsw-alias-border-l2'))

  // Idempotent: nothing is appended, removed, or re-styled on a second pass.
  syncDialog(model, doc)
  eq('second pass adds nothing', dl.childNodes.length, reactRows + block)
  eq('second pass adds no second stylesheet', doc.head.querySelectorAll(`style[${STYLE_ATTR}]`).length, 1)

  // Value change updates text in place.
  const slower = buildModel(collectTurns(sampledTurn(3, { start: 100, stepStart: 200, firstToken: 300, messageAt: 4300, tokens: 500, end: 4500 }), 3), 5000)
  syncDialog(slower, doc)
  eq('updated in place, no new nodes', dl.childNodes.length, reactRows + block)
  ok('new figure rendered', dl.textContent.includes('125 tok/s'))

  // React reconciliation: it appends a newly-appearing committed row AFTER our
  // block. Those two nodes are React's, so the repair must MOVE our block to the
  // end (leaving React's row in place) rather than delete anything of React's.
  dl.appendChild(new El('dt', doc))
  dl.appendChild(new El('dd', doc))
  syncDialog(slower, doc)
  eq('React row kept and our whole block re-appended after it', dl.childNodes.length, reactRows + 2 + block)
  {
    const children = dl.childNodes
    const tail = children.slice(children.length - block)
    let blockOk = tail[0].getAttribute(ROW_ATTR) === SEPARATOR_KEY
    for (let index = 0; index < 7; index += 1) {
      if (tail[1 + index * 2].tagName !== 'DT' || tail[2 + index * 2].tagName !== 'DD') blockOk = false
      if (tail[1 + index * 2].getAttribute(ROW_ATTR) === null) blockOk = false
    }
    ok('our divider and rows are again the trailing block', blockOk)
  }
  // React's appended row is still immediately before our block.
  ok('React row precedes our block', dl.childNodes[reactRows + 1].getAttribute(ROW_ATTR) === null)
  ok('text still intact after repair', dl.textContent.includes('125 tok/s'))

  // The dialog closing removes the whole panel; a null model clears our marks.
  const withRows = doc
  syncDialog(null, withRows)
  eq('all contributed rows removed', dl.querySelectorAll(`[${ROW_ATTR}]`).length, 0)
  eq('the divider is removed with them', dl.querySelectorAll(`[${ROW_ATTR}="${SEPARATOR_KEY}"]`).length, 0)
  eq('React rows untouched (including the one it appended)', dl.childNodes.length, reactRows + 2)
  eq('turn mark cleared', dl.getAttribute('data-turn-speed'), null)
  eq('key mark cleared', dl.getAttribute('data-turn-speed-keys'), null)

  // English copy switches with <html lang>.
  const enDoc = makeDocument('en-US')
  const enDl = mountDialog(enDoc, 2)
  const en = materialize(enDoc)
  en.exports.__internals.syncDialog(en.exports.__internals.buildModel(
    en.exports.__internals.collectTurns(window_, 3), 3000), enDoc)
  ok('en labels rendered', enDl.textContent.includes('This turnoutput speed (TPS)'))
}
//#endregion

//#region D. activation through ctx.sessions
console.log('D. activation path')
{
  const doc = makeDocument()
  const bundle = materialize(doc)
  const dl = mountDialog(doc, 2)

  let entries = sampledTurn(4, { start: 10, stepStart: 20, firstToken: 30, messageAt: 1030, tokens: 250, end: 1100 })
  const listeners = new Set()
  const source = {
    getSnapshot: () => ({ entries, hasMore: false, revision: 1, change: { kind: 'replace', entries } }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
  const listListeners = new Set()
  const sessions = {
    list: {
      getSnapshot: () => ({ current: 'sess-1' }),
      subscribe: (listener) => {
        listListeners.add(listener)
        return () => listListeners.delete(listener)
      }
    },
    binding: (id) => (id === 'sess-1' ? { eventSource: source } : undefined)
  }
  const effects = []
  const ctx = {
    get: (name) => (name === 'sessions' ? sessions : undefined),
    effect: (callback, name) => {
      // The real contract: the callback returns a disposer.
      const disposer = callback()
      effects.push({ callback, disposer, name })
      return () => { if (typeof disposer === 'function') disposer() }
    }
  }

  bundle.exports.apply(ctx)
  bundle.drainTimeouts()
  eq('one effect registered', effects.length, 1)
  ok('effect is named for the controller', String(effects[0].name).includes('turn-speed'))
  eq('no activation failure', bundle.exports.__internals.failure(), null)

  // requestAnimationFrame renders synchronously in this environment.
  const controller = bundle.exports.__internals.controller()
  ok('controller exists', controller !== null)
  eq('rows written into the shipped dialog', dl.querySelectorAll('[data-turn-speed-row]').length, 15)
  ok('turn 4 shown as current', dl.textContent.includes('本轮输出速度（TPS）'))
  ok('value rendered', dl.textContent.includes('250 tok/s'))
  ok('reported to the host route', bundle.requests.length > 0)
  const modelReport = bundle.requests.map((sent) => JSON.parse(sent.init.body)).find((sent) => sent.model !== undefined)
  ok('a report carried the model', modelReport !== undefined)
  eq('report carries the turn', modelReport.model.turn, 4)
  eq('report carries the page', modelReport.href, 'http://127.0.0.1:3080/')
  eq('report saw the dialog', modelReport.dialogSeen, true)
  ok('every report goes to the diagnostics route', bundle.requests.every((sent) => sent.url === '/turn-speed-api/report'))
  const activation = bundle.requests.map((sent) => JSON.parse(sent.init.body)).find((sent) => sent.activated !== undefined)
  ok('an activation report was sent', activation !== undefined)
  eq('activation reported as successful', activation.activated, true)

  // A live update flows through the event subscription.
  entries = [...sampledTurn(4, { start: 10, stepStart: 20, firstToken: 30, messageAt: 1030, tokens: 250, end: 1100 }),
    ...sampledTurn(5, { start: 2000, stepStart: 2100, firstToken: 2200, messageAt: 3200, tokens: 300, end: 3300 })]
  for (const listener of listeners) listener()
  ok('newest turn now current', dl.textContent.includes('本轮输出速度（TPS）'))
  eq('list mark follows the target turn', dl.getAttribute('data-turn-speed'), '5')

  // Missing service is retried, then reported — never thrown, and never a
  // silent no-show.
  const missing = materialize(makeDocument())
  missing.exports.apply({ get: () => undefined, effect: () => () => {} })
  eq('a missing service is retried', missing.retries.filter(Boolean).length > 0, true)
  missing.drainRetries(70)
  ok('missing sessions service is reported', String(missing.exports.__internals.failure()).includes('sessions service unavailable'))

  // A throwing lookup is caught and reported.
  const throwing = materialize(makeDocument())
  throwing.exports.apply({ get: () => { throw new Error('service not ready') }, effect: () => () => {} })
  ok('throwing lookup is reported', String(throwing.exports.__internals.failure()).includes('sessions lookup threw'))

  // A service that arrives late still activates, with no reload. Its own
  // service handle, so its subscriptions cannot pollute the shared sets.
  const late = materialize(makeDocument())
  const lateDl = mountDialog(late.window.document, 2)
  let lateAvailable = false
  const lateSessions = {
    list: { getSnapshot: () => ({ current: 'sess-late' }), subscribe: () => () => {} },
    binding: () => ({ eventSource: { getSnapshot: () => ({ entries }), subscribe: () => () => {} } })
  }
  late.exports.apply({
    get: () => (lateAvailable ? lateSessions : undefined),
    effect: () => () => {}
  })
  eq('nothing rendered before the service exists', lateDl.querySelectorAll('[data-turn-speed-row]').length, 0)
  lateAvailable = true
  late.drainRetries(1)
  eq('rows appear once the service arrives', lateDl.querySelectorAll('[data-turn-speed-row]').length, 15)

  // A session whose binding is not ready yet is retried rather than stalled.
  const pending = materialize(makeDocument())
  const pendingDl = mountDialog(pending.window.document, 2)
  let bindingReady = false
  const pendingSource = {
    getSnapshot: () => ({ entries }),
    subscribe: () => () => {}
  }
  const pendingSessions = {
    list: { getSnapshot: () => ({ current: 'sess-9' }), subscribe: () => () => {} },
    binding: (id) => (bindingReady && id === 'sess-9' ? { eventSource: pendingSource } : undefined)
  }
  pending.exports.apply({ get: () => pendingSessions, effect: () => () => {} })
  eq('no rows while the binding is pending', pendingDl.querySelectorAll('[data-turn-speed-row]').length, 0)
  bindingReady = true
  pending.drainRetries(1)
  eq('rows appear once the binding resolves', pendingDl.querySelectorAll('[data-turn-speed-row]').length, 15)

  // A dead diagnostics route must not disturb the UI. Uses its own service
  // handle so it cannot pollute the shared one's listener sets.
  const offline = materialize(makeDocument(), { fetch: () => { throw new Error('network down') } })
  const offlineDl = mountDialog(offline.window.document, 2)
  const offlineSessions = {
    list: { getSnapshot: () => ({ current: 'sess-offline' }), subscribe: () => () => {} },
    binding: () => ({ eventSource: { getSnapshot: () => ({ entries }), subscribe: () => () => {} } })
  }
  offline.exports.apply({ get: () => offlineSessions, effect: () => () => {} })
  offline.drainTimeouts()
  eq('rows still written when fetch throws', offlineDl.querySelectorAll('[data-turn-speed-row]').length, 15)
  eq('no failure recorded for a dead route', offline.exports.__internals.failure(), null)

  // A session with no binding yet contributes nothing and does not throw.
  const noBinding = materialize(makeDocument())
  const emptySessions = { list: { getSnapshot: () => ({ current: undefined }), subscribe: () => () => {} }, binding: () => undefined }
  noBinding.exports.apply({ get: () => emptySessions, effect: () => () => {} })
  noBinding.drainRetries(2)
  eq('no binding records state without rows', noBinding.exports.__internals.controller().getState().hasBinding, false)
  eq('no binding is not a failure', noBinding.exports.__internals.failure(), null)

  // Disposal unsubscribes everything.
  for (const effect of effects) if (typeof effect.disposer === 'function') effect.disposer()
  eq('subscriptions dropped on dispose', listeners.size + listListeners.size, 0)
  eq('binding retry cancelled on dispose', bundle.retries.filter(Boolean).length, 0)
  eq('MutationObserver is disconnected on dispose', bundle.observers.length, 0)

  // A render must not be its own trigger: writing our rows mutates the DOM, so
  // an observer that reacted to those writes would never settle. The filter is
  // exercised with realistic records, both ways.
  const guarded = materialize(makeDocument())
  const guardedDl = mountDialog(guarded.window.document, 2)
  const guardRowAttr = guarded.exports.__internals.ROW_ATTR
  const guardTurnAttr = guarded.exports.__internals.TURN_ATTR
  guarded.exports.apply({ get: () => sessionsFor('sess-guard', entries).service, effect: () => () => {} })
  guarded.drainTimeouts()
  const guardedController = guarded.exports.__internals.controller()
  const rendersBefore = guardedController.getState().renders
  ok('an observer is installed', guarded.observers.length > 0)
  const observe = guarded.observers[0].callback

  // Our own writes: must be ignored, or render() re-triggers itself forever.
  const ourRow = guardedDl.querySelector(`[${guardRowAttr}]`)
  ok('a row of ours exists to test with', ourRow !== null)
  observe([{ type: 'childList', target: guardedDl, addedNodes: [ourRow], removedNodes: [] }])
  eq('our own appended row does not re-trigger', guardedController.getState().renders, rendersBefore)
  observe([{ type: 'childList', target: guardedDl, addedNodes: [], removedNodes: [ourRow] }])
  eq('our own removed row does not re-trigger', guardedController.getState().renders, rendersBefore)
  observe([{ type: 'attributes', target: ourRow, attributeName: guardRowAttr }])
  eq('our own attribute write does not re-trigger', guardedController.getState().renders, rendersBefore)
  observe([{ type: 'attributes', target: guardedDl, attributeName: guardTurnAttr }])
  eq('our own turn marker does not re-trigger', guardedController.getState().renders, rendersBefore)

  // React's own writes: must trigger, or the dialog opening would be missed.
  const reactRow = guardedDl.childNodes[0]
  observe([{ type: 'childList', target: guardedDl, addedNodes: [reactRow], removedNodes: [] }])
  eq('React appending a row does trigger a render', guardedController.getState().renders, rendersBefore + 1)
  const afterReact = guardedController.getState().renders
  observe([{ type: 'childList', target: guarded.window.document.body, addedNodes: [guardedDl], removedNodes: [] }])
  eq('the dialog appearing does trigger a render', guardedController.getState().renders, afterReact + 1)
  eq('rows still correct after the repair pass', guardedDl.querySelectorAll(`[${guardRowAttr}]`).length, 15)
}
//#endregion

//#region E. host half
console.log('E. host half')
{
  const home = mkdtempSync(join(tmpdir(), 'dts-home-'))
  process.env.DSH_HOME = home
  const host = await import(new URL('../lib/index.js', import.meta.url).href)

  eq('host inject waits for the web server', JSON.stringify(host.inject), JSON.stringify(['webServer']))

  const routes = []
  const effects = []
  const ctx = {
    webServer: {
      register: (route) => {
        routes.push(route)
        return () => { routes.length = 0 }
      }
    },
    effect: (callback, name) => {
      // Registering a route returns a disposer from INSIDE the effect.
      const disposer = callback()
      effects.push({ callback, disposer, name })
      return () => { if (typeof disposer === 'function') disposer() }
    }
  }
  host.apply(ctx)
  eq('one route registered', routes.length, 1)
  eq('route kind', routes[0].kind, 'prefix')
  eq('route path', routes[0].path, '/turn-speed-api')
  const handler = routes[0].handler

  /** One fake response recorder. */
  function response() {
    const record = { code: null, headers: null, body: '' }
    return {
      record,
      writeHead(code, headers) {
        record.code = code
        record.headers = headers
      },
      end(body) {
        record.body = body === undefined ? '' : String(body)
      }
    }
  }
  /** One fake request that emits its body asynchronously. */
  function request(url, method = 'GET', body = null, address = '127.0.0.1') {
    const listeners = new Map()
    return {
      url,
      method,
      socket: { remoteAddress: address },
      on(event, callback) {
        listeners.set(event, callback)
        if (event === 'data' && body !== null) setImmediate(() => callback(Buffer.from(body)))
        if (event === 'end') setImmediate(() => callback())
        return this
      },
      destroy() {}
    }
  }

  const health = response()
  await handler(request('/turn-speed-api/health'), health)
  eq('health status', health.record.code, 200)
  eq('health mounted', JSON.parse(health.record.body).mounted, true)

  const offBox = response()
  await handler(request('/turn-speed-api/state', 'GET', null, '10.1.2.3'), offBox)
  eq('non-loopback refused', offBox.record.code, 403)

  const missing = response()
  await handler(request('/turn-speed-api/nope'), missing)
  eq('unknown path', missing.record.code, 404)

  const accepted = response()
  await handler(request('/turn-speed-api/report', 'POST', JSON.stringify({ version: '0.2.0', href: 'http://x/', model: { turn: 7 } })), accepted)
  eq('report accepted', accepted.record.code, 200)

  const rejected = response()
  await handler(request('/turn-speed-api/report', 'POST', '{not json'), rejected)
  eq('malformed report rejected', rejected.record.code, 400)

  const state = response()
  await handler(request('/turn-speed-api/state'), state)
  const served = JSON.parse(state.record.body)
  eq('state counts reports', served.reports, 1)
  eq('state counts rejections', served.rejected, 1)
  eq('state serves the latest turn', served.latest.model.turn, 7)

  // Disposal runs the effect's disposer, which persists what the route collected.
  eq('two effects registered', effects.length, 2)
  for (const effect of effects) if (typeof effect.disposer === 'function') effect.disposer()
  const onDisk = JSON.parse(readFileSync(join(home, 'storages', 'dsh-turn-speed.json'), 'utf8'))
  eq('report persisted under DSH_HOME', onDisk.latest.model.turn, 7)
  eq('persisted pages recorded', onDisk.pages.length, 1)

  // A second activation reads the previous report back.
  const reloaded = []
  const host2 = await import(`${new URL('../lib/index.js', import.meta.url).href}?reload=2`)
  const secondEffects = []
  host2.apply({
    webServer: { register: (route) => { reloaded.push(route); return () => {} } },
    effect: (callback) => {
      const disposer = callback()
      secondEffects.push(disposer)
      return () => { if (typeof disposer === 'function') disposer() }
    }
  })
  const reloadState = response()
  await reloaded[0].handler(request('/turn-speed-api/state'), reloadState)
  eq('previous report restored after reload', JSON.parse(reloadState.record.body).latest.model.turn, 7)

  delete process.env.DSH_HOME
  rmSync(home, { recursive: true, force: true })
}
//#endregion

//#region report
if (failures.length > 0) {
  console.error(`\ndsh-turn-speed verify: FAILED (${failures.length}/${checks})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\ndsh-turn-speed verify: OK (${checks} checks: bundle shape, fold math, dialog patching, activation, host half)`)
//#endregion
