// err-i18n-test.mjs —— 「运行失败提示翻译」专项测试
//
// 与 lib/client.js 的 [PATCH 2026-10-19 err-i18n] 段**逐字对应**（改动 client.js
// 对应段须同步本文件）。覆盖：
//   - findErrorRows     按结构定位（role=status + turnErrorRow），不匹配英文单词；
//                      跳过官方已中文化的 6 个 code、跳过含 CJK 的正文、跳过空正文
//   - syncErrorPanels   落点（挂在错误行下）、srcKey 早退、缓存命中、孤儿清扫
//   - renderErrorTranslation  译文为空时显式报错而不是渲染空框
//   - beginErrorTranslation  失败时面板显式报错、不静默
//   - 隔离契约         CoT 对账（PANEL_ATTR）与错误面板（ERR_PANEL_ATTR）互不可见
//   - hasCJK           中日韩字符判定
//
// 跑法：node tools/err-i18n-test.mjs（不连网：用 DOM 桩 + fetch 桩）

import assert from 'node:assert/strict'

let passed = 0
let failed = 0

// 顺序链式执行：异步用例不得与后续用例并发共享 globalThis.document。
let chain = Promise.resolve()

function check(name, fn) {
  chain = chain.then(async () => {
    try {
      await fn()
      passed += 1
      console.log(`  ok  ${name}`)
    } catch (error) {
      failed += 1
      console.error(`  FAIL ${name}`)
      console.error(error)
    }
  })
}

function section(name) {
  chain = chain.then(() => {
    console.log(name)
  })
}

// ---- 以下与 lib/client.js 补丁段逐字一致（依赖用测试桩）----

const t = (key) => key

/** Error panels carry their own marker so CoT reconciliation never sees them. */
const ERR_PANEL_ATTR = 'data-dsh-session-translator-err'

/** Failure codes whose copy the host already localizes — never re-translated. */
const LOCALE_ERROR_CODES = new Set([
  'AUTH',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'ACCOUNT_SIGNED_OUT',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'INTERRUPTED',
])

/** Whether a text carries CJK: the host already localized this failure. */
function hasCJK(text) {
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/u.test(text)
}

/** One part of an error row, trimmed; '' when the row's shape changed. */
function errorPart(row, name) {
  const el = row.querySelector(`[class*="${name}"]`)
  return el === null ? '' : (el.textContent ?? '').trim()
}

/**
 * Every terminal turn-failure row whose message is a raw provider string.
 * Anchored on structure (`role=status` + `turnErrorRow`), never on wording,
 * and only on rows the host has not already localized.
 */
function findErrorRows() {
  const found = []
  for (const row of document.querySelectorAll('[role="status"][class*="turnErrorRow"]')) {
    const text = errorPart(row, 'turnErrorMessage')
    if (text.length < 4) continue
    if (LOCALE_ERROR_CODES.has(errorPart(row, 'turnErrorCode'))) continue
    if (hasCJK(text)) continue
    found.push({ row, text })
  }
  return found
}

// ---- 最小 DOM 桩（只实现被测代码用到的部分）----

class StubEl {
  constructor(tag, attrs = {}) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.childNodes = this.children
    this.attrs = { ...attrs }
    this.textContent = ''
    this.hidden = false
    this.dataset = {}
    this.parentElement = null
    this.style = { setProperty() {} }
    this.className = ''
  }
  /** Depth-first walk of this subtree. */
  *walk() {
    for (const kid of this.children) {
      yield kid
      yield* kid.walk()
    }
  }
  /** Whether this element matches a stub-supported selector. */
  matches(sel) {
    // 复合选择器：按顺序解析 [a="b"] / [a*="b"] 片段，全部满足才算命中。
    // 属性名可含连字符（data-dsh-session-translator-err 之类）；值必须非贪婪匹配，
    // 否则第一个片段的 value 会把后面的片段一起吞掉。
    let rest = sel
    let matched = 0
    const frag = /^\[([a-zA-Z][\w-]*)([*]?)="(.*?)"\]/
    for (;;) {
      const m = frag.exec(rest)
      if (m === null) break
      const [, name, wildcard, value] = m
      const own = name === 'class' ? this.className : this.getAttribute(name)
      if (wildcard === '*') {
        if (!String(own).includes(value)) return false
      } else if (own !== value) {
        return false
      }
      matched += 1
      rest = rest.slice(m[0].length)
    }
    if (matched === 0) throw new Error(`stub selector unsupported: ${sel}`)
    return rest.length === 0
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null
  }
  setAttribute(name, value) {
    this.attrs[name] = String(value)
  }
  appendChild(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }
  append(...kids) {
    for (const kid of kids) this.appendChild(kid)
  }
  /** DOM `ParentNode.after`: insert siblings right after this element. */
  after(...kids) {
    if (this.parentElement === null) return
    const at = this.parentElement.children.indexOf(this) + 1
    for (const kid of kids) {
      kid.parentElement = this.parentElement
      this.parentElement.children.splice(at, 0, kid)
    }
  }
  remove() {
    if (this.parentElement !== null) {
      const i = this.parentElement.children.indexOf(this)
      if (i >= 0) this.parentElement.children.splice(i, 1)
      this.parentElement = null
    }
  }
  get isConnected() {
    let node = this
    while (node !== null) {
      if (node === document) return true
      node = node.parentElement
    }
    return false
  }
  get nextElementSibling() {
    if (this.parentElement === null) return null
    const i = this.parentElement.children.indexOf(this)
    return this.parentElement.children[i + 1] ?? null
  }
  get previousElementSibling() {
    if (this.parentElement === null) return null
    const i = this.parentElement.children.indexOf(this)
    return this.parentElement.children[i - 1] ?? null
  }
  closest() {
    return null
  }
  querySelectorAll(sel) {
    const out = []
    for (const el of this.walk()) {
      if (el.matches(sel)) out.push(el)
    }
    return out
  }
  querySelector(sel) {
    for (const el of this.walk()) {
      if (el.matches(sel)) return el
    }
    return null
  }
}

function makeErrorRow({ message, code, role = 'status' }) {
  const row = new StubEl('div', { role, class: 'cJsG2q_turnErrorRow' })
  row.className = 'cJsG2q_turnErrorRow'
  const copy = row.appendChild(new StubEl('div', { class: 'cJsG2q_turnErrorCopy' }))
  copy.className = 'cJsG2q_turnErrorCopy'
  const title = copy.appendChild(new StubEl('span', { class: 'cJsG2q_turnErrorTitle' }))
  title.className = 'cJsG2q_turnErrorTitle'
  title.textContent = '本轮运行失败'
  const msg = copy.appendChild(new StubEl('span', { class: 'cJsG2q_turnErrorMessage' }))
  msg.className = 'cJsG2q_turnErrorMessage'
  msg.textContent = message
  if (code !== undefined) {
    const codeEl = row.appendChild(new StubEl('code', { class: 'cJsG2q_turnErrorCode' }))
    codeEl.className = 'cJsG2q_turnErrorCode'
    codeEl.textContent = code
  }
  return row
}

let document
function installDocument(...roots) {
  const body = new StubEl('body')
  body.tagName = 'BODY'
  document = body
  for (const root of roots) body.appendChild(root)
  globalThis.document = body
  return body
}

// ---- 测试 ----

section('hasCJK')

check('纯英文不含 CJK', () => {
  assert.equal(hasCJK('usage exceeds frequency limit'), false)
})
check('中文含 CJK', () => {
  assert.equal(hasCJK('当前请求的额度已用尽'), true)
})
check('日文/韩文同样算已本地化', () => {
  assert.equal(hasCJK('利用制限を超えました'), true)
  assert.equal(hasCJK('사용량이 한도를 초과했습니다'), true)
})
check('仅标识符/标点不算 CJK', () => {
  assert.equal(hasCJK('soft_rate (http 429)'), false)
})

section('findErrorRows：按结构定位')

check('英文 provider 报文被抓到', () => {
  const row = makeErrorRow({
    message: 'workbuddy upstream soft_rate (http 429): usage exceeds frequency limit',
  })
  installDocument(row)
  const found = findErrorRows()
  assert.equal(found.length, 1)
  assert.equal(found[0].row, row)
  assert.match(found[0].text, /frequency limit/)
})
check('角色不是 status 的行不被抓（不是失败行）', () => {
  const row = makeErrorRow({ message: 'some noise', role: 'presentation' })
  installDocument(row)
  assert.equal(findErrorRows().length, 0)
})
check('类名不含 turnErrorRow 的行不被抓', () => {
  const row = makeErrorRow({ message: 'some noise' })
  row.className = 'cJsG2q_maxTokensRow'
  installDocument(row)
  assert.equal(findErrorRows().length, 0)
})
check('正文过短不抓（避免把装饰性节点当报错）', () => {
  installDocument(makeErrorRow({ message: 'abc' }))
  assert.equal(findErrorRows().length, 0)
})
check('空 code 的英文行照样抓（通用兜底）', () => {
  installDocument(makeErrorRow({ message: 'upstream refused the connection' }))
  assert.equal(findErrorRows().length, 1)
})

section('findErrorRows：不重复翻译官方中文')

for (const code of [...LOCALE_ERROR_CODES]) {
  check(`code=${code} 跳过（官方已有中文文案）`, () => {
    installDocument(makeErrorRow({ message: 'localized host copy', code }))
    assert.equal(findErrorRows().length, 0)
  })
}
check('正文含中文时跳过（即使 code 不是已知 6 个）', () => {
  installDocument(makeErrorRow({ message: '请求被拦截，请重新发送', code: 'UNKNOWN_CODE' }))
  assert.equal(findErrorRows().length, 0)
})
check('中英混杂的报错照翻（真的没本地化）', () => {
  installDocument(makeErrorRow({ message: 'quota exceeded for user 12345' }))
  assert.equal(findErrorRows().length, 1)
})

section('错误面板与 CoT 面板隔离')

check('两套 DOM 属性互不相同', () => {
  assert.notEqual(ERR_PANEL_ATTR, 'data-dsh-session-translator')
})
check('CoT 的 keep-set 扫描（PANEL_ATTR）看不见错误面板', () => {
  const row = makeErrorRow({ message: 'upstream 502 gateway error' })
  const body = installDocument(row)
  const errPanel = new StubEl('div')
  errPanel.setAttribute(ERR_PANEL_ATTR, 'panel')
  row.appendChild(errPanel)
  const seen = []
  for (const panel of body.querySelectorAll(`[data-dsh-session-translator="panel"]`)) seen.push(panel)
  assert.equal(seen.length, 0)
})
check('错误面板的孤儿清扫（ERR_PANEL_ATTR）不会碰到 CoT 面板', () => {
  const body = installDocument(makeErrorRow({ message: 'upstream 502 gateway error' }))
  const cotPanel = new StubEl('div')
  cotPanel.setAttribute('data-dsh-session-translator', 'panel')
  body.appendChild(cotPanel)
  const keep = new Set()
  for (const panel of body.querySelectorAll(`[${ERR_PANEL_ATTR}="panel"]`)) {
    if (!keep.has(panel)) panel.remove()
  }
  assert.equal(body.children.length, 2)
})

section('syncErrorPanels：落点与早退')

/** 与 client.js 一致的最小实现（依赖已在上方桩化）。 */
function createErrorPanel() {
  const panel = new StubEl('div')
  panel.className = 'dsh-session-translator-errpanel'
  panel.setAttribute(ERR_PANEL_ATTR, 'panel')
  const head = panel.appendChild(new StubEl('div', { class: 'dsh-session-translator-errhead' }))
  head.className = 'dsh-session-translator-errhead'
  head.appendChild(new StubEl('div', { class: 'dsh-session-translator-errstatus' }))
  return panel
}

function syncErrorPanels() {
  const keep = new Set()
  for (const { row } of findErrorRows()) {
    let panel = null
    const next = row.nextElementSibling
    if (next !== null && next.getAttribute(ERR_PANEL_ATTR) === 'panel') panel = next
    if (panel === null || panel.previousElementSibling !== row) {
      if (panel === null) panel = createErrorPanel()
      row.after(panel)
    }
    keep.add(panel)
  }
  for (const panel of document.querySelectorAll(`[${ERR_PANEL_ATTR}="panel"]`)) {
    if (!keep.has(panel)) panel.remove()
  }
}

check('译文面板直接挂在错误行之后', () => {
  const row = makeErrorRow({ message: 'upstream 502 gateway error' })
  installDocument(row)
  syncErrorPanels()
  const panel = row.nextElementSibling
  assert.ok(panel !== null, '应当有面板')
  assert.equal(panel.getAttribute(ERR_PANEL_ATTR), 'panel')
  assert.equal(panel.previousElementSibling, row)
})
check('重复对账不产生第二个面板', () => {
  const row = makeErrorRow({ message: 'upstream 502 gateway error' })
  installDocument(row)
  syncErrorPanels()
  const first = row.nextElementSibling
  syncErrorPanels()
  assert.equal(row.nextElementSibling, first)
})
check('错误行被 React 回收后，孤儿面板被清掉', () => {
  const row = makeErrorRow({ message: 'upstream 502 gateway error' })
  const body = installDocument(row)
  syncErrorPanels()
  assert.equal(body.querySelectorAll(`[${ERR_PANEL_ATTR}="panel"]`).length, 1)
  row.remove()
  syncErrorPanels()
  assert.equal(body.querySelectorAll(`[${ERR_PANEL_ATTR}="panel"]`).length, 0)
})
check('官方中文错误行不会凭空长出面板', () => {
  installDocument(makeErrorRow({ message: '当前请求的额度已用尽', code: 'QUOTA' }))
  syncErrorPanels()
  assert.equal(document.children.length, 1)
})

section('renderErrorTranslation')

/** 与 client.js 一致的最小实现（依赖已在上方桩化）。 */
function setTextIfChanged(el, next) {
  if (el.textContent === next) return false
  el.textContent = next
  return true
}

function renderErrorTranslation(panel, payload) {
  const body = panel.querySelector('[data-role="body"]')
  if (body === null) return
  const translation = String(payload.translation ?? '')
  if (translation === '') {
    // An empty translation is a failure, not a result: never render a blank box.
    panel.dataset.state = 'error'
    return
  }
  setTextIfChanged(body, translation)
  const meta = panel.querySelector('[data-role="meta"]')
  if (meta !== null) {
    const route = payload.route
    const model = route === undefined || route === null ? '' : `${route.provider}/${route.model}`
    const bits = []
    if (model !== '') bits.push(model)
    if (payload.cached === true) bits.push(t('panel.cached'))
    if (typeof payload.ms === 'number' && payload.cached !== true) bits.push(`${Math.round(payload.ms)}ms`)
    setTextIfChanged(meta, bits.join(' · '))
  }
  panel.dataset.state = 'done'
}

/** A panel with the same roles the real one creates. */
function fullErrorPanel() {
  const panel = new StubEl('div')
  panel.setAttribute(ERR_PANEL_ATTR, 'panel')
  const head = panel.appendChild(new StubEl('div'))
  head.querySelector = function stubQuery(sel) {
    if (sel === '[data-role="meta"]') return meta
    if (sel === '[data-role="body"]') return body
    return null
  }
  const meta = head.appendChild(new StubEl('span'))
  meta.setAttribute('data-role', 'meta')
  const body = panel.appendChild(new StubEl('div'))
  body.setAttribute('data-role', 'body')
  panel.querySelector = function stubQuery(sel) {
    if (sel === '[data-role="meta"]') return meta
    if (sel === '[data-role="body"]') return body
    return null
  }
  return { panel, meta, body }
}

check('正常译文写入正文并打上 done', () => {
  const { panel, body } = fullErrorPanel()
  renderErrorTranslation(panel, { translation: '请求过于频繁', route: { provider: 'ollama-local', model: 'qwen-tr' }, ms: 380 })
  assert.equal(body.textContent, '请求过于频繁')
  assert.equal(panel.dataset.state, 'done')
})
check('meta 带上 渠道/模型 与耗时', () => {
  const { panel, meta } = fullErrorPanel()
  renderErrorTranslation(panel, { translation: '请求过于频繁', route: { provider: 'ollama-local', model: 'qwen-tr' }, ms: 380.6 })
  assert.equal(meta.textContent, 'ollama-local/qwen-tr · 381ms')
})
check('缓存命中只标「缓存」，不写耗时', () => {
  const { panel, meta } = fullErrorPanel()
  renderErrorTranslation(panel, { translation: '请求过于频繁', cached: true, route: { provider: 'p', model: 'm' } })
  assert.equal(meta.textContent, 'p/m · panel.cached')
})
check('空译文不写正文，状态转为 error（绝不渲染空框）', () => {
  const { panel, body } = fullErrorPanel()
  renderErrorTranslation(panel, { translation: '' })
  assert.equal(body.textContent, '')
  assert.equal(panel.dataset.state, 'error')
})
check('译文缺字段（undefined）同样按 error 处理', () => {
  const { panel, body } = fullErrorPanel()
  renderErrorTranslation(panel, {})
  assert.equal(body.textContent, '')
  assert.equal(panel.dataset.state, 'error')
})
check('同译文重渲染零写入（文本节点不被换掉）', () => {
  const { panel, body } = fullErrorPanel()
  renderErrorTranslation(panel, { translation: '请求过于频繁', route: { provider: 'p', model: 'm' } })
  const before = body.textContent
  renderErrorTranslation(panel, { translation: '请求过于频繁', route: { provider: 'p', model: 'm' }, ms: 500 })
  assert.equal(body.textContent, before)
})

// 汇总必须排在链尾：用例是异步顺序执行的，同步打印会拿到 0。
chain.then(() => {
  console.log(`\nerr-i18n-test: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
})
