// select-safe-test.mjs —— 译文面板「幂等写入 + 选区保护 + 跳过标记」专项测试
//
// 与 lib/client.js 的 [PATCH 2026-10-06 select-safe] / [PATCH 2026-10-06 skip-policy]
// 段**逐字对应**（改动 client.js 对应段须同步本文件）。覆盖：
//   - setTextIfChanged      同值不写（textContent 赋值=销毁重建文本节点）
//   - setStatus / setError  状态与错误行同值不写、hidden 语义不变
//   - renderTranslation     同译文重渲染零写入；换稿才写；选区落在面板内时
//                           延迟补写（新稿覆盖旧稿，至多一个定时器）；
//                           already-chinese 回显明示「未翻译」且不挂缓存徽章
//   - selectionTouches      选区判定（折叠/无交集/异常/无 document 均为 false）
//
// 跑法：node _analysis/select-safe-test.mjs

import assert from 'node:assert/strict'

let passed = 0
let failed = 0

// 顺序链式执行：异步用例（延迟补写）不得与后续用例并发共享 globalThis.document。
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---- 以下与 lib/client.js 补丁段逐字一致（除 t 为测试桩）----

const t = (key) => key

function panelPart(panel, role) {
  return panel.querySelector(`[data-role="${role}"]`)
}

/** Whether a live selection currently touches `node` (do not rewrite under it). */
function selectionTouches(node) {
  if (typeof document === 'undefined') return false
  const selection = typeof document.getSelection === 'function' ? document.getSelection() : null
  if (selection === null || selection.isCollapsed === true || selection.rangeCount === 0) return false
  try {
    return selection.getRangeAt(0).intersectsNode(node)
  } catch {
    return false
  }
}

/** Write `next` into `el.textContent` only when it actually differs. */
function setTextIfChanged(el, next) {
  if (el.textContent === next) return false
  el.textContent = next
  return true
}

function setStatus(panel, text) {
  const status = panelPart(panel, 'status')
  if (status === null) return
  setTextIfChanged(status, text ?? '')
  status.hidden = text === undefined || text === null || text === ''
}

function setError(panel, message) {
  const error = panelPart(panel, 'error')
  if (error === null) return
  setTextIfChanged(error, message ?? '')
  error.hidden = message === undefined || message === null || message === ''
}

function renderTranslation(panel, payload) {
  const body = panelPart(panel, 'body')
  if (body === null) return
  // 选区正落在本面板时不换文本节点，稍后补写
  // （新载荷覆盖旧载荷，只保留最新一稿；至多一个补写定时器）。
  if (selectionTouches(body)) {
    panel.__pendingPayload = payload
    if (panel.__renderTimer === undefined) {
      panel.__renderTimer = setTimeout(() => {
        panel.__renderTimer = undefined
        const pending = panel.__pendingPayload
        panel.__pendingPayload = undefined
        if (pending !== undefined && panel.isConnected === true) renderTranslation(panel, pending)
      }, 600)
    }
    return
  }
  setTextIfChanged(body, String(payload.translation ?? ''))
  body.hidden = false
  const meta = panelPart(panel, 'meta')
  if (meta !== null) {
    const route = payload.route
    const model = route === undefined || route === null ? '' : `${route.provider}/${route.model}`
    const bits = []
    if (model !== '') bits.push(model)
    // 跳过≠翻译：已含中文的回显必须明示"未翻译"，
    // 且不挂误导的「缓存」徽章（skip 返回的 cached:true 并非译文缓存命中）。
    if (payload.skipped === 'already-chinese') bits.push(t('panel.alreadyChinese'))
    else if (payload.cached === true) bits.push(t('panel.cached'))
    if (typeof payload.ms === 'number' && payload.cached !== true) bits.push(`${Math.round(payload.ms)}ms`)
    if (payload.skipped === 'truncated') bits.push(t('panel.truncated'))
    setTextIfChanged(meta, bits.join(' · '))
  }
  panel.dataset.state = 'done'
  setStatus(panel, '')
  setError(panel, '')
  const manual = panel.querySelector('[data-act="manual"]')
  if (manual !== null) manual.hidden = true
}

// ---- 迷你 DOM：只实现上述函数用到的表面，并统计 textContent 写入次数 ----

function el(attrs = {}, text = '') {
  const node = {
    attrs: { ...attrs },
    hidden: 'hidden' in attrs ? attrs.hidden !== false : false,
    writes: 0,
    parentElement: null,
    children: [],
    getAttribute(name) {
      return name in this.attrs ? this.attrs[name] : null
    },
    querySelector(selector) {
      const match = /\[data-(role|act)="([^"]+)"\]/.exec(selector)
      if (match === null) return null
      return this.children.find((child) => child.attrs[`data-${match[1]}`] === match[2]) ?? null
    },
  }
  let value = text
  Object.defineProperty(node, 'textContent', {
    get: () => value,
    set: (next) => {
      node.writes += 1
      value = next
    },
  })
  return node
}

function panelWith(...parts) {
  const panel = el({ 'data-dsh-cot-en2cn': 'panel' })
  panel.dataset = {}
  panel.isConnected = true
  panel.children = parts
  return panel
}

function bodyPart(text = '') {
  return el({ 'data-role': 'body' }, text)
}

// ---- selectionTouches 选区判定 ----

section('selectionTouches 选区判定')

const savedDocument = globalThis.document

check('无 document（Node/测试环境）→ false', () => {
  delete globalThis.document
  assert.equal(selectionTouches(el({})), false)
})

check('折叠选区 / 空选区 → false', () => {
  globalThis.document = { getSelection: () => ({ isCollapsed: true, rangeCount: 1 }) }
  assert.equal(selectionTouches(el({})), false)
  globalThis.document = { getSelection: () => ({ isCollapsed: false, rangeCount: 0 }) }
  assert.equal(selectionTouches(el({})), false)
  globalThis.document = { getSelection: () => null }
  assert.equal(selectionTouches(el({})), false)
})

check('展开选区：按 intersectsNode 判定', () => {
  const hit = el({})
  const miss = el({})
  globalThis.document = {
    getSelection: () => ({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ intersectsNode: (node) => node === hit }),
    }),
  }
  assert.equal(selectionTouches(hit), true)
  assert.equal(selectionTouches(miss), false)
})

check('getRangeAt 抛异常 → false（失败退化）', () => {
  globalThis.document = {
    getSelection: () => ({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => {
        throw new Error('detached')
      },
    }),
  }
  assert.equal(selectionTouches(el({})), false)
})

// ---- setTextIfChanged 幂等写入 ----

section('setTextIfChanged 幂等写入')

check('同值不写、异值才写', () => {
  const node = el({}, '译文')
  assert.equal(setTextIfChanged(node, '译文'), false)
  assert.equal(node.writes, 0)
  assert.equal(setTextIfChanged(node, '新译文'), true)
  assert.equal(node.writes, 1)
  assert.equal(node.textContent, '新译文')
})

// ---- setStatus / setError ----

section('setStatus / setError 同值不写')

check('状态同值重复设置 → 零写入，hidden 语义不变', () => {
  const panel = panelWith(el({ 'data-role': 'status' }), el({ 'data-role': 'error' }))
  const status = panel.children[0]
  const error = panel.children[1]
  setStatus(panel, '翻译中…')
  setStatus(panel, '翻译中…')
  assert.equal(status.writes, 1)
  assert.equal(status.hidden, false)
  setStatus(panel, '')
  assert.equal(status.writes, 2)
  assert.equal(status.hidden, true)
  setStatus(panel, undefined)
  assert.equal(status.writes, 2)
  assert.equal(status.hidden, true)
  setError(panel, '失败：超时')
  setError(panel, '失败：超时')
  assert.equal(error.writes, 1)
  assert.equal(error.hidden, false)
  setError(panel, null)
  assert.equal(error.writes, 2)
  assert.equal(error.hidden, true)
})

// ---- renderTranslation 幂等 + 选区保护 ----

section('renderTranslation 幂等 + 选区保护')

check('同译文重渲染 → 正文零写入（文本节点不被换掉）', () => {
  const body = bodyPart('这是译文')
  const meta = el({ 'data-role': 'meta' }, 'ollama-local/qwen-tr')
  const manual = el({ 'data-act': 'manual' })
  const panel = panelWith(body, meta, manual)
  const payload = { translation: '这是译文', route: { provider: 'ollama-local', model: 'qwen-tr' } }
  renderTranslation(panel, payload)
  renderTranslation(panel, payload)
  assert.equal(body.writes, 0)
  assert.equal(meta.writes, 0)
  assert.equal(panel.dataset.state, 'done')
  assert.equal(manual.hidden, true)
})

check('换稿才写正文与 meta', () => {
  const body = bodyPart('旧稿')
  const meta = el({ 'data-role': 'meta' })
  const panel = panelWith(body, meta, el({ 'data-act': 'manual' }))
  renderTranslation(panel, { translation: '新稿', route: { provider: 'p', model: 'm' } })
  assert.equal(body.writes, 1)
  assert.equal(body.textContent, '新稿')
  assert.equal(meta.writes, 1)
  renderTranslation(panel, { translation: '定稿', route: { provider: 'p', model: 'm' }, cached: true })
  assert.equal(body.writes, 2)
  assert.equal(meta.writes, 2)
})

check('跳过回显（already-chinese）明示未翻译、不挂缓存徽章', () => {
  const body = bodyPart('')
  const meta = el({ 'data-role': 'meta' })
  const panel = panelWith(body, meta, el({ 'data-act': 'manual' }))
  renderTranslation(panel, { translation: '原文直接回显', skipped: 'already-chinese', cached: true })
  assert.equal(meta.textContent, 'panel.alreadyChinese')
  renderTranslation(panel, { translation: '真译文', route: { provider: 'p', model: 'm' }, cached: true })
  assert.equal(meta.textContent, 'p/m · panel.cached')
})

check('选区落在面板内 → 延迟补写，新稿覆盖旧稿，至多一个定时器', async () => {
  const body = bodyPart('原文甲')
  const panel = panelWith(body, el({ 'data-role': 'meta' }), el({ 'data-act': 'manual' }))
  let touching = true
  globalThis.document = {
    getSelection: () => ({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ intersectsNode: () => touching }),
    }),
  }
  renderTranslation(panel, { translation: '甲稿' })
  renderTranslation(panel, { translation: '乙稿' })
  assert.equal(body.writes, 0, '选区期间不得写入')
  assert.notEqual(panel.__renderTimer, undefined, '补写定时器已挂起')
  touching = false // 松开鼠标
  await sleep(700)
  assert.equal(body.writes, 1, '补写只落一次')
  assert.equal(body.textContent, '乙稿', '补写的是最新稿')
  assert.equal(panel.__renderTimer, undefined)
})

check('面板断开后不补写', async () => {
  const body = bodyPart('')
  const panel = panelWith(body, el({ 'data-role': 'meta' }), el({ 'data-act': 'manual' }))
  globalThis.document = {
    getSelection: () => ({
      isCollapsed: false,
      rangeCount: 1,
      getRangeAt: () => ({ intersectsNode: () => true }),
    }),
  }
  renderTranslation(panel, { translation: '甲稿' })
  panel.isConnected = false
  await sleep(700)
  assert.equal(body.writes, 0)
  assert.equal(panel.__renderTimer, undefined)
})

await chain

if (savedDocument === undefined) delete globalThis.document
else globalThis.document = savedDocument

console.log(`\nselect-safe-test: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
