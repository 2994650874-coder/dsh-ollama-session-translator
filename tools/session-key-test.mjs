/**
 * session-key-test.mjs
 *
 * [PATCH 2026-10-23 session-key-stable] 验证 sessionKeySource() 的会话归属判据。
 *
 * 为什么单写一个：修复前 tools/ 13 个测试文件零覆盖这段逻辑，所以
 * "切会话后新会话不出译文"能一直藏着——13 个文件全绿，功能是坏的。
 *
 * 手法沿用 dispose-test.mjs：把 client.js 源码注入 new Function 沙箱执行，
 * document / window / fetch / ctx 全部可控。
 *
 * 行为断言怎么做到的：err-i18n 的 reconcile 会为一条**未本地化的英文错误行**
 * 调用 requestTranslation()，而后者把 sessionKey 放进 POST /translate 的 body。
 * 所以造一个假错误行、跑一次同步、拦下那个 fetch，就能读到**真实的**归属结果
 * ——不是匹配源码文本，是看它到底把译文算到哪个会话头上。
 *
 * 反向验证过：把 lib/client.js 的逻辑还原成修复前的 for...break，本文件第 1、2
 * 条立刻 FAIL。所以它抓得住这个 bug，不是摆设。
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

/** Minimal element stub: only what client.js touches. */
class FakeElement {
  constructor (tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.attributes = {}
    this.dataset = {}
    this.style = { setProperty () {} }
    this.textContent = ''
    this.className = ''
    this.hidden = false
    this.isConnected = true
    this.parentElement = null
    this.previousElementSibling = null
    this.nextElementSibling = null
  }
  setAttribute (k, v) { this.attributes[k] = String(v) }
  getAttribute (k) { return Object.hasOwn(this.attributes, k) ? this.attributes[k] : null }
  hasAttribute (k) { return Object.hasOwn(this.attributes, k) }
  removeAttribute (k) { delete this.attributes[k] }
  appendChild (c) { this.children.push(c); c.parentElement = this; return c }
  append (...cs) { for (const c of cs) { this.children.push(c); c.parentElement = this } }
  removeChild (c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c }
  remove () { if (this.parentElement !== null) this.parentElement.removeChild(this) }
  after (node) {
    const host = this.parentElement
    if (host === null) return
    const i = host.children.indexOf(this)
    host.children.splice(i + 1, 0, node)
    node.parentElement = host
    node.previousElementSibling = this
    this.nextElementSibling = node
  }
  closest () { return null }
  matches () { return false }
  querySelector (sel) { return this.querySelectorAll(sel)[0] ?? null }
  querySelectorAll (sel) {
    const out = []
    const walk = (node) => {
      for (const c of node.children) {
        if (matches(c, sel)) out.push(c)
        walk(c)
      }
    }
    walk(this)
    return out
  }
}

/**
 * The two selector shapes this test needs:
 *   [role="status"][class*="turnErrorRow"]   (compound, findErrorRows)
 *   [class*="turnErrorMessage"]              (single, errorPart)
 */
function matches (el, sel) {
  const parts = sel.match(/\[[^\]]+\]/g)
  if (parts === null) return false
  for (const part of parts) {
    const m = part.match(/^\[\s*([^\]==~]+?)\s*(?:([*^$|~]?=)\s*(.*?)\s*)?\]$/)
    if (m === null) return false
    const attr = m[1].trim()
    const op = m[2]
    const want = (m[3] ?? '').replace(/^["']|["']$/g, '')
    const got = attr === 'class' ? (el.className ?? '') : el.getAttribute(attr)
    if (got === null) return false
    if (op === undefined) { if (got === '') return false; continue }
    if (op === '*=') { if (!got.includes(want)) return false; continue }
    if (op === '=') { if (got !== want) return false; continue }
    if (op === '^=') { if (!got.startsWith(want)) return false; continue }
    return false
  }
  return true
}

/**
 * Boot the bundle against one sessions snapshot, run the reconcile pass, and
 * report the sessionKey the plugin actually put on the wire.
 *
 * @param byId - fake sessions.list snapshot map (undefined is a valid case).
 * @returns { ran, sessionKey, url } captured from the intercepted fetch.
 */
async function captureSessionKey (byId) {
  const source = readFileSync(CLIENT, 'utf8')

  // One terminal turn failure the host has NOT localized: raw English prose, so
  // err-i18n picks it up and asks for a translation.
  const message = new FakeElement('div')
  message.className = 'turnErrorMessage'
  message.textContent = 'upstream connection reset while streaming the response'
  const errorRow = new FakeElement('div')
  errorRow.setAttribute('role', 'status')
  errorRow.className = 'turnErrorRow'
  errorRow.appendChild(message)
  const body = new FakeElement('body')
  body.appendChild(errorRow)

  const document = {
    body,
    head: new FakeElement('head'),
    documentElement: new FakeElement('html'),
    addEventListener: () => {},
    removeEventListener: () => {},
    createElement: (tag) => new FakeElement(tag),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    visibilityState: 'visible',
  }

  const captured = { ran: false, sessionKey: undefined, url: null }
  const fetchStub = (url, init) => {
    captured.url = String(url)
    if (String(url).endsWith('/state')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          config: {
            enabled: true, translateErrors: true, autoTranslate: true,
            foldOriginal: false, horizonRows: 0, targetLanguage: 'zh-CN',
          },
        }),
      })
    }
    if (String(url).endsWith('/translate')) {
      captured.ran = true
      captured.sessionKey = JSON.parse(String(init.body)).sessionKey
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, translation: 'x' }) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) })
  }

  const window = {
    innerHeight: 800,
    MutationObserver: class { observe () {} disconnect () {} },
    // No session id here: the URL fallback must contribute nothing, so whatever
    // we read back came from sessionKeySource().
    location: { href: 'http://127.0.0.1:4416/' },
  }
  window.window = window

  let moduleExports = null
  window.__ModuleLoader__ = { load: (entry) => { moduleExports = entry.factory(() => ({})) } }

  const fn = new Function('window', 'document', 'MutationObserver', 'setTimeout', 'clearTimeout',
    'setInterval', 'clearInterval', 'fetch', 'console', 'Map', 'Set', 'structuredClone',
    'Element', 'getSelection',
    '"use strict";\n' + source + '\n//# fibEnd\n')
  fn(window, document, window.MutationObserver, () => 1, () => {}, () => 1, () => {},
    fetchStub, { warn: () => {}, error: () => {}, log: () => {} }, Map, Set,
    (v) => JSON.parse(JSON.stringify(v)), FakeElement, () => null)

  const fakeLocale = { register: () => () => {}, bind: () => (k) => k, subscribe: () => () => {} }
  const sessions = { list: { getSnapshot: () => ({ ids: [], byId, phase: 'ready' }) } }
  const ctx = {
    get: (name) => {
      if (name === 'sessions') return sessions
      if (name === 'locale') return fakeLocale
      return undefined
    },
    effect: (factory) => factory(),
    logger: { warn: () => {}, error: () => {} },
    on: () => () => {},
  }

  moduleExports.apply(ctx)
  // fetchState() is a 3-deep promise chain (fetch -> readJson -> response.json),
  // and only then does refresh() set the config and run the error reconcile.
  for (let i = 0; i < 200; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 15))
  return captured
}

console.log('session-key-test: attribution')

const ROW_A = 'session-old-1111-1111-1111-1111-111111111111'
const ROW_B = 'session-new-2222-2222-2222-2222-222222222222'

// 1. the regression itself
{
  // Both rows are held by mainView while the switch is in flight, so the old
  // code's "first Object.entries hit" made the winner depend on the order
  // manager.getListSnapshot() happened to emit.
  const c = await captureSessionKey({
    [ROW_A]: { retainedBy: { mainView: 1 }, updatedAt: 1000 },
    [ROW_B]: { retainedBy: { mainView: 1 }, updatedAt: 2000 },
  })
  ok('a translation was actually requested', c.ran === true, 'url=' + c.url)
  ok('attributes the freshest mainView row, not the first one',
     c.sessionKey === ROW_B, 'got ' + String(c.sessionKey))
}

// 2. key order must not decide the outcome
{
  const c = await captureSessionKey({
    [ROW_B]: { retainedBy: { mainView: 1 }, updatedAt: 1000 },
    [ROW_A]: { retainedBy: { mainView: 1 }, updatedAt: 2000 },
  })
  ok('updatedAt decides, not object key order',
     c.sessionKey === ROW_A, 'got ' + String(c.sessionKey))
}

// 3. a released row must not compete
{
  const c = await captureSessionKey({
    [ROW_B]: { retainedBy: { mainView: 0 }, updatedAt: 9999 },
    [ROW_A]: { retainedBy: { mainView: 1 }, updatedAt: 1000 },
  })
  ok('ignores rows the main view no longer holds',
     c.sessionKey === ROW_A, 'got ' + String(c.sessionKey))
}

// 4. a missing stamp degrades instead of throwing
{
  const c = await captureSessionKey({
    [ROW_A]: { retainedBy: { mainView: 1 } },
    [ROW_B]: { retainedBy: { mainView: 1 }, updatedAt: 1 },
  })
  ok('a missing updatedAt degrades to 0 and still resolves',
     c.sessionKey === ROW_B, 'got ' + String(c.sessionKey))
}

// 5. nothing held: the URL fallback has no session id either
{
  const c = await captureSessionKey({
    [ROW_A]: { retainedBy: { mainView: 0 }, updatedAt: 10 },
  })
  ok('no mainView row yields an empty key',
     c.sessionKey === '', 'got ' + String(c.sessionKey))
}

// 6. malformed snapshots must not break the request path
for (const [label, byId] of [
  ['empty byId', {}],
  ['undefined byId', undefined],
  ['row without retainedBy', { [ROW_A]: { updatedAt: 5 } }],
]) {
  const c = await captureSessionKey(byId)
  ok('tolerates ' + label + ' without throwing',
     c.ran === true, 'url=' + c.url + ' key=' + String(c.sessionKey))
}

console.log(`
${pass} passed, ${fail} failed`)
if (fail > 0) { console.log('failures: ' + failures.join('; ')); process.exitCode = 1 }
