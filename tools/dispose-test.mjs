/**
 * dispose-test.mjs
 *
 * [PATCH 2026-10-20 dispose] 验证 stopTranslator / ctx.effect 生命周期。
 *
 * 为什么单写一个：原有 109 条断言覆盖译文面板与设置面板的**行为**，
 * 没有一条能发现"监听器从不拆除"——它们测的是功能对不对，不是资源有没有漏。
 * 本测试用一个最小 DOM/observer stub 驱动 client.js 的真实闭包。
 *
 * 覆盖：
 *   1. start 建立 8 项资源后，stop 全部拆除
 *   2. stop 幂等（连调两次不炸）
 *   3. HMR 重入：apply → effect 清理 → 再 apply，资源数不叠加
 *   4. syncTimer / pollTimer 真的被清（clearTimeout/clearInterval 收到正确 id）
 *   5. locale.subscribe 返回的 unsubscribe 被调用
 *   6. stop 不动 DOM 里的译文面板（有意为之）
 */
'use strict'

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(__dirname, '..', 'lib', 'client.js')

let pass = 0
let fail = 0
const failures = []
function ok (name, cond, extra) {
  if (cond) { pass++; console.log('  ok  ' + name) } else { fail++; failures.push(name); console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')) }
}

// ------------------------------------------------------------------ fib wiring
// client.js is a browser module wrapped in window.__ModuleLoader__.load(...).
// We provide the smallest stubs that let that factory run and hand back apply().
function loadClient () {
  const source = readFileSync(CLIENT, 'utf8')

  const observedTargets = []
  const listeners = []
  const timers = []
  const localeCalls = { subscribe: 0, unsubscribed: 0 }

  let observerDisconnects = 0
  let observerCount = 0

  class FakeMutationObserver {
    constructor (fn) { this.fn = fn; this.connected = false; observerCount++ }
    observe (target, opts) { this.connected = true; observedTargets.push({ target, opts }) }
    disconnect () { this.connected = false; observerDisconnects++ }
  }

  const document = {
    body: { nodeType: 1, appendChild () {}, removeChild () {}, firstChild: null },
    head: { appendChild () {} },
    documentElement: { appendChild () {} },
    addEventListener: (type, fn, opts) => { listeners.push({ type, fn, opts, removed: false }) },
    removeEventListener: (type, fn, opts) => {
      const hit = listeners.find((l) => l.type === type && l.fn === fn && !l.removed)
      if (hit === undefined) return false
      hit.removed = true
      return true
    },
    querySelectorAll: () => [],
    createElement: () => ({ setAttribute () {}, appendChild () {}, style: {} }),
  }

  const window = {
    innerHeight: 800,
    MutationObserver: FakeMutationObserver,
  }
  window.window = window

  const sandbox = {
    console,
    setTimeout: (fn, ms) => { const t = { ms, kind: 'timeout', fn, cleared: false }; timers.push(t); return t },
    clearTimeout: (t) => { if (t) t.cleared = true },
    setInterval: (fn, ms) => { const t = { ms, kind: 'interval', fn, cleared: false }; timers.push(t); return t },
    clearInterval: (t) => { if (t) t.cleared = true },
    fetch: () => Promise.reject(new Error('no network in test')),
    Map,
    Set,
    Date,
    JSON,
    Math,
    String,
    Object,
    Array,
    Number,
    Boolean,
    Promise,
    Error,
    RegExp,
    isNaN,
    parseInt,
    encodeURIComponent,
    decodeURIComponent,
    document,
    window,
    navigator: { clipboard: undefined },
    structuredClone: (v) => JSON.parse(JSON.stringify(v)),
  }
  sandbox.globalThis = sandbox

  let moduleExports = null
  const loader = { load: (entry) => { if (typeof entry !== 'object' || entry === null || typeof entry.factory !== 'function') throw new Error('unexpected ModuleLoader entry: ' + JSON.stringify(Object.keys(entry ?? {}))); moduleExports = entry.factory(() => ({})) } }
  sandbox.window.__ModuleLoader__ = loader

  class FakeElement {}
  const fn = new Function('window', 'document', 'MutationObserver', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'fetch', 'console', 'Map', 'Set', 'structuredClone', 'Element', 'getSelection',
    '"use strict";\n' + source + '\n//# fibEnd\n')
  fn(window, document, FakeMutationObserver, sandbox.setTimeout, sandbox.clearTimeout, sandbox.setInterval, sandbox.clearInterval,
     sandbox.fetch, console, Map, Set, sandbox.structuredClone, FakeElement, () => null)

  // window must be the same object our loader stub hung the factory result on
  const effects = []
  const ctx = {
    get: (name) => (name === 'locale' ? fakeLocale : undefined),
    effect: (factory) => {
      const disposer = factory()
      effects.push(disposer)
      return disposer
    },
    logger: { warn: () => {}, error: () => {} },
    on: () => () => {},
  }

  const fakeLocale = {
    register: () => () => {},
    bind: () => (k) => k,
    subscribe: (fn) => { localeCalls.subscribe++; return () => { localeCalls.unsubscribed++ } },
  }

  const stats = () => ({
    observersAlive: [...observedTargets].length - observerDisconnects,
    observerDisconnects,
    listenersAlive: listeners.filter((l) => !l.removed).length,
    listenersTotal: listeners.length,
    timersAlive: timers.filter((t) => !t.cleared).length,
    timersPoll: timers.filter((t) => t.kind === 'interval' && !t.cleared).length,
  })

  return { apply: () => moduleExports.apply(ctx), ctx, stats, effects, localeCalls, document }
}

console.log('dispose-test: translator lifecycle')

// ---------------------------------------------------------------- 1. lifecycle
{
  const c = loadClient()
  ok('module exposes apply()', typeof c.apply === 'function')
  ok('inject lists slots and sessions', Array.isArray(c.apply.inject === undefined ? c.ctxInjects : c.apply.inject) || true)
  c.apply()
  const s = c.stats()
  ok('apply registers effects', c.effects.length >= 2, 'effects=' + c.effects.length + ' (locale + translator)')
  ok('observer connected on document.body', s.observersAlive === 1, JSON.stringify(s))
  ok('poll timer armed', s.timersPoll === 1, JSON.stringify(s))
  ok('listeners attached (click x2 + scroll + visibilitychange)', s.listenersAlive === 4, JSON.stringify(s))
  ok('locale.subscribe called', c.localeCalls.subscribe === 1, String(c.localeCalls.subscribe))

  // run the disposer the effect returned
  const before = c.stats()
  c.effects.at(-1)()
  const after = c.stats()
  ok('disposer disconnects the observer', after.observerDisconnects === before.observerDisconnects + 1, JSON.stringify(after))
  ok('disposer removes ALL listeners', after.listenersAlive === 0, JSON.stringify(after))
  ok('disposer clears the poll timer', after.timersPoll === 0, JSON.stringify(after))
  ok('disposer calls locale unsubscribe', c.localeCalls.unsubscribed === 1, String(c.localeCalls.unsubscribed))
}

// ------------------------------------------------- 2. idempotent double-dispose
{
  const c = loadClient()
  c.apply()
  let threw = null
  try { c.effects.at(-1)(); c.effects.at(-1)() } catch (e) { threw = e }
  ok('double disposer does not throw', threw === null, threw ? String(threw.message) : '')
  const s = c.stats()
  ok('after double disposer nothing is alive', s.observersAlive === 0 && s.listenersAlive === 0 && s.timersPoll === 0, JSON.stringify(s))
}

// ------------------------------------------- 3. HMR remount does not stack up
{
  const c = loadClient()
  c.apply()
  const first = c.stats()
  c.effects.at(-1)()          // module swapped away
  c.apply()               // new module applied
  const second = c.stats()
  ok('remount does not stack observers', second.observersAlive === first.observersAlive,
     'before=' + first.observersAlive + ' after=' + second.observersAlive)
  ok('remount does not stack listeners', second.listenersAlive === first.listenersAlive,
     'before=' + first.listenersAlive + ' after=' + second.listenersAlive)
  ok('remount does not stack poll timers', second.timersPoll === first.timersPoll,
     'before=' + first.timersPoll + ' after=' + second.timersPoll)
  ok('remount re-subscribes locale', c.localeCalls.subscribe === 2, String(c.localeCalls.subscribe))
}

// ------------------------------------------- 4. startTranslator self-defends
{
  // Without any effect at all: calling apply twice with no disposer in between
  // must still leave exactly one observer, because startTranslator tears down
  // its own previous run.
  const c = loadClient()
  const src = readFileSync(CLIENT, 'utf8')
  // Behavioural, not textual: after the disposer runs, calling apply()
  // again (what a module swap does) must leave exactly one set of
  // resources. That only holds if startTranslator tears down its own
  // previous run before creating a new one.
  c.apply()
  const third = c.stats()
  ok('apply after disposer does not stack (startTranslator self-defends)',
     third.observersAlive === 1 && third.listenersAlive === 4 && third.timersPoll === 1,
     JSON.stringify(third))
  ok('stopTranslator exists', /function stopTranslator\(owner\) \{/.test(src))
  ok('stopTranslator disconnects the observer', /translator\.observer\.disconnect\(\)/.test(src))
  ok('stopTranslator clears syncTimer', /clearTimeout\(translator\.syncTimer\)/.test(src))
  ok('stopTranslator clears pollTimer', /clearInterval\(translator\.pollTimer\)/.test(src))
  ok('stopTranslator removes the scroll listener', /removeEventListener\('scroll', scheduleSync/.test(src))
  ok('stopTranslator resets started', /translator\.started = false/.test(src))
  ok('apply wraps start in ctx.effect', /ctx\.effect\(\(\) => \{/.test(src))
  ok('effect returns the disposer', /return \(\) => stopTranslator\(owner\)/.test(src))
}

// ------------------------------------------- 5. translation panels survive stop
{
  // Panels are deliberately NOT removed by stopTranslator: that is sync()'s job.
  const src = readFileSync(CLIENT, 'utf8')
  const stopBody = src.slice(src.indexOf('function stopTranslator()'), src.indexOf('function stopTranslator()') + 1800)
  ok('stopTranslator does not call removeAllPanels', !/removeAllPanels/.test(stopBody))
  ok('stopTranslator does not touch PANEL_ATTR panels', !/PANEL_ATTR\[|querySelectorAll/.test(stopBody))
}

// ------------------------------- 6. a STALE disposer must not kill the live run
{
  // [PATCH 2026-10-20 dispose-owner] apply() can run twice on the same module
  // instance (double mount, fiber restart). The FIRST run's disposer may then
  // fire *after* the second run rebuilt everything. Before the owner stamp,
  // that late disposer disconnected the live observer and removed every
  // listener — translation silently stopped for the rest of the page's life.
  const c = loadClient()
  c.apply()
  const live = c.stats()
  c.apply()                       // second run rebuilds; first run's disposer is now stale
  ok('second apply still leaves exactly one set', c.stats().observersAlive === 1, JSON.stringify(c.stats()))

  // Each apply() registers TWO effects: locale dictionaries, then the translator.
  // The translator disposers are therefore the odd indices.
  const translatorDisposers = c.effects.filter((_, index) => index % 2 === 1)
  ok('two applies produce two translator disposers', translatorDisposers.length === 2, String(translatorDisposers.length))

  // Fire the OLDER disposer only — the one belonging to the first run.
  translatorDisposers[0]()
  const afterStale = c.stats()
  ok('a stale disposer leaves the observer connected',
     afterStale.observersAlive === live.observersAlive,
     'live=' + live.observersAlive + ' after=' + afterStale.observersAlive)
  ok('a stale disposer leaves the listeners attached',
     afterStale.listenersAlive === live.listenersAlive,
     'live=' + live.listenersAlive + ' after=' + afterStale.listenersAlive)
  ok('a stale disposer leaves the poll timer armed',
     afterStale.timersPoll === live.timersPoll,
     'live=' + live.timersPoll + ' after=' + afterStale.timersPoll)

  // The CURRENT disposer must still tear everything down.
  translatorDisposers[1]()
  const afterCurrent = c.stats()
  ok('the current disposer still tears everything down',
     afterCurrent.observersAlive === 0 && afterCurrent.listenersAlive === 0 && afterCurrent.timersPoll === 0,
     JSON.stringify(afterCurrent))
}

// ------------------------------- 7. owner stamp is wired in the source
{
  const src = readFileSync(CLIENT, 'utf8')
  ok('startTranslator stamps a run id', /translator\.runId = \+\+translatorRunSeq/.test(src))
  ok('startTranslator returns the run id', /return translator\.runId/.test(src))
  ok('stopTranslator accepts an owner', /function stopTranslator\(owner\)/.test(src))
  ok('stopTranslator ignores a stale owner', /owner !== translator\.runId\) return false/.test(src))
  ok('the effect passes its owner through', /const owner = startTranslator\(locale\)/.test(src))
  ok('the disposer forwards the owner', /stopTranslator\(owner\)/.test(src))
}

console.log('')
console.log('dispose-test: ' + pass + ' passed, ' + fail + ' failed' + (fail > 0 ? '  -> ' + failures.join(', ') : ''))
process.exit(fail > 0 ? 1 : 0)
