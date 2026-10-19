/**
 * dsh-cot-en2cn — browser check.
 *
 * Loads the real `lib/client.js` in headless Chrome against a fixture page that
 * mimics ui-chat's reasoning rows, with a stub of the plugin's own routes. It
 * then asserts on the DOM Chrome prints back:
 *
 *   - a Chinese panel appears only under the rows a reader can actually read
 *     (expanded, or tall enough to be open, and no longer streaming)
 *   - two rows with the same text cost exactly one translate request
 *   - the original reasoning text is never touched
 *   - panel buttons do not bubble into the row's own expand/collapse handler
 *   - the master switch removes every panel again
 *   - the settings section mounts and renders its controls
 *
 * Run: node tools/browser-check.mjs [--chrome <path>]
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const chromeFlag = process.argv.indexOf('--chrome')
const CHROME_CANDIDATES = [
  chromeFlag === -1 ? undefined : process.argv[chromeFlag + 1],
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((value) => typeof value === 'string' && value !== '')

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (chrome === undefined) {
  process.stdout.write('no Chrome/Edge found; skipping the browser check\n')
  process.exit(0)
}

// [PATCH 2026-10-19 portable-react-umd] 原来这里硬编码了 P:\\dsh\\... 这类
// 原作者个人路径。路径不存在时**不报错**，而是让 settings fixture 被静默跳过
// （输出只剩一行 "skip no React UMD build found"），第三方机器等于少测一半且
// 毫无提示。改成按优先级解析：显式参数 → 本机 DSH profile → 常见全局路径 →
// 临时目录缓存 → 联网拉取，全失败才跳过（并且这次会**明确说出来**）。
const firstExisting = (candidates) => candidates.find((candidate) => existsSync(candidate))

/** DSH profile 的 node_modules 里通常有 react / react-dom（DSH 桌面版自带）。 */
function dshProfileReactCandidates() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const react = []
  const reactDom = []
  for (const profile of ['desktop', 'web']) {
    const nm = join(home, 'profiles', profile, 'node_modules')
    for (const file of ['react.development.js', 'react.production.min.js']) {
      react.push(join(nm, 'react', 'umd', file))
    }
    for (const file of ['react-dom.development.js', 'react-dom.production.min.js']) {
      reactDom.push(join(nm, 'react-dom', 'umd', file))
    }
  }
  return { react, reactDom }
}

const profileUmd = dshProfileReactCandidates()

const REACT_UMD = [
  ...(process.env.COT_EN2CN_REACT ? [process.env.COT_EN2CN_REACT] : []),
  ...profileUmd.react,
  '/usr/lib/node_modules/react/umd/react.development.js',
  '/usr/local/lib/node_modules/react/umd/react.development.js',
]
const REACT_DOM_UMD = [
  ...(process.env.COT_EN2CN_REACT_DOM ? [process.env.COT_EN2CN_REACT_DOM] : []),
  ...profileUmd.reactDom,
  '/usr/lib/node_modules/react-dom/umd/react-dom.development.js',
  '/usr/local/lib/node_modules/react-dom/umd/react-dom.development.js',
]

/** 联网拉 UMD 到临时目录（CDN 走 unpkg，与 live-lock-check.mjs 同一策略）。 */
async function fetchUmd(dir, name, url) {
  const target = join(dir, name)
  if (existsSync(target)) return target
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return undefined
    writeFileSync(target, await res.text(), 'utf8')
    return target
  } catch {
    return undefined
  }
}

// 本地都找不到时联网兜底，避免"静默少测一半"。
let reactFile = firstExisting(REACT_UMD)
let reactDomFile = firstExisting(REACT_DOM_UMD)
if (reactFile === undefined || reactDomFile === undefined) {
  const umdCache = mkdtempSync(join(tmpdir(), 'session-translator-react-'))
  if (reactFile === undefined) {
    reactFile = await fetchUmd(umdCache, 'react.development.js', 'https://unpkg.com/react@18/umd/react.development.js')
  }
  if (reactDomFile === undefined) {
    reactDomFile = await fetchUmd(umdCache, 'react-dom.development.js', 'https://unpkg.com/react-dom@18/umd/react-dom.development.js')
  }
  // 明确告知走了哪条路，别让人以为测的是"仓库自带 React"。
  if (reactFile !== undefined && reactDomFile !== undefined) {
    process.stdout.write(`react UMD: fetched to ${umdCache}\n`)
  } else {
    process.stdout.write('react UMD: not found locally and the CDN fetch failed\n')
  }
}

// ------------------------------------------------------------------ stub host

const REASONING_A = 'I should check whether the settings service is even mounted before calling register on it.'
const REASONING_B = 'This block is collapsed, so a reader cannot see it and it must not be translated.'
const REASONING_C = 'The geometry fallback has to catch rows a build renders open without the data-expanded attribute on them.'
const REASONING_D = 'Streaming blocks are only translated when live translation is switched on explicitly.'

// [PATCH 2026-10-19 dropdown-row-squash] 模型下拉的回归样本：真机上
// workbuddy-ai 注册了 12 个模型，正是"候选总高超过 maxHeight 260px → flex
// 压缩每一行 → overflow:hidden 裁掉下半截"的触发条件。模型少时不会出现，
// 所以 fixture 必须真的给够数量，否则这条断言等于没测。
const SQUASH_MODELS = [
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-1-20250805',
  'claude-haiku-4-5-20251001',
  'gpt-5-2025-08-07',
  'gpt-5-mini-2025-08-07',
  'gemini-2-5-pro',
  'gemini-2-5-flash',
  'deepseek-v3-1',
  'deepseek-r1-0528',
  'qwen3-max',
  'kimi-k2-0905',
  'glm-4-6',
].map((id) => ({ id, name: id }))

const CATALOG = [
  { id: 'workbuddy-ai', name: 'WorkBuddy AI', models: SQUASH_MODELS },
  { id: 'ollama', name: 'Ollama', models: [{ id: 'qwen2.5', name: 'qwen2.5' }] },
]

const server = {
  config: {
    enabled: true,
    autoTranslate: true,
    liveTranslate: false,
    targetLanguage: 'zh-CN',
    // [PATCH 2026-10-19 dropdown-row-squash] 默认渠道就用"模型很多"的那个：
    // 设置面板一渲染，「翻译模型」下拉里就有 12 个候选，才能覆盖压扁回归。
    provider: 'workbuddy-ai',
    model: SQUASH_MODELS[0].id,
    disableThinking: true,
    maxChunkChars: 3000,
    maxInputChars: 24000,
    timeoutMs: 120000,
    concurrency: 2,
    cacheEntries: 600,
    skipMostlyChinese: true,
    showOriginal: false,
    fontSizePx: 13,
  },
  translateCalls: [],
  configWrites: [],
  cacheClears: 0,
}

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req) {
  let text = ''
  for await (const chunk of req) text += chunk
  return text === '' ? {} : JSON.parse(text)
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (path === '/dsh-session-translator/state') {
    jsonResponse(res, 200, {
      ok: true,
      version: '0.1.0-test',
      config: server.config,
      defaults: { ...server.config, enabled: true, provider: '', model: '' },
      configPath: 'C:\\temp\\session-translator\\config.json',
      configSource: 'file',
      route: { provider: server.config.provider, model: server.config.model, source: 'override' },
      stats: { requests: server.translateCalls.length, hits: 0, cacheSize: 0, lastMs: 12, lastError: null, lastRoute: `${server.config.provider}/${server.config.model}` },
      languages: [
        { id: 'zh-CN', label: '简体中文' },
        { id: 'zh-TW', label: '繁體中文' },
        { id: 'en', label: 'English' },
        { id: 'ja', label: '日本語' },
      ],
    })
    return
  }

  if (path === '/dsh-session-translator/catalog') {
    // [PATCH 2026-10-19 dropdown-row-squash] 设置 fixture 需要"模型很多"的渠道
    // 才能触发下拉行被压扁；模型少时该 bug 不出现，所以这里给足 12 个。
    jsonResponse(res, 200, { ok: true, providers: CATALOG })
    return
  }

  if (path === '/dsh-session-translator/models') {
    // [PATCH 2026-10-19 dropdown-row-squash] 面板进站时 Promise.all 同时拉
    // models + catalog；缺了 models 这条，readJson 会因 404 抛错，整个
    // Promise.all 直接 reject → catalog 永远为空 → 下拉退化成输入框。
    jsonResponse(res, 200, { ok: true, providers: [], ollama: { found: false, endpoint: '', models: [], probed: [], error: null } })
    return
  }

  if (path === '/dsh-session-translator/translate') {
    const body = await readBody(req)
    server.translateCalls.push(String(body.text ?? ''))
    // A small real delay so the loading state is observable.
    await new Promise((resolve) => setTimeout(resolve, 40))
    jsonResponse(res, 200, {
      ok: true,
      translation: `【中】${String(body.text ?? '')}`,
      skipped: null,
      chunks: 1,
      cached: false,
      route: { provider: 'fake', model: 'fake-1', source: 'override' },
      ms: 40,
    })
    return
  }

  if (path === '/dsh-session-translator/config') {
    const body = await readBody(req)
    server.configWrites.push(body)
    if (body !== null && typeof body.section === 'object' && body.section !== null) {
      Object.assign(server.config, body.section)
    }
    jsonResponse(res, 200, {
      ok: true,
      version: '0.1.0-test',
      config: server.config,
      defaults: { ...server.config, enabled: true, provider: '', model: '' },
      configPath: 'C:\\temp\\session-translator\\config.json',
      configSource: 'file',
      route: { provider: server.config.provider, model: server.config.model, source: 'override' },
      stats: { requests: server.translateCalls.length, hits: 0, cacheSize: 0, lastMs: 12, lastError: null, lastRoute: `${server.config.provider}/${server.config.model}` },
      languages: [{ id: 'zh-CN', label: '简体中文' }],
    })
    return
  }

  if (path === '/dsh-session-translator/cache/clear') {
    server.cacheClears += 1
    jsonResponse(res, 200, { ok: true, cleared: 3, stats: { requests: 1, hits: 3, cacheSize: 0, lastMs: 5, lastError: null, lastRoute: 'fake/fake-1' } })
    return
  }

  if (path === '/__stats') {
    jsonResponse(res, 200, { translateCalls: server.translateCalls, configWrites: server.configWrites.length, cacheClears: server.cacheClears })
    return
  }

  if (path === '/plugins/dsh-session-translator/client.js') {
    const body = readFileSync(join(root, 'lib', 'client.js'))
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(body)
    return
  }

  if (path === '/react.js' && reactFile !== undefined) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(readFileSync(reactFile))
    return
  }

  if (path === '/react-dom.js' && reactDomFile !== undefined) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(readFileSync(reactDomFile))
    return
  }

  if (path === '/fixture.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(fixtureHtml())
    return
  }

  if (path === '/settings.html' && reactFile !== undefined && reactDomFile !== undefined) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(settingsHtml())
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

function shellFixtures() {
  return `
<style>
  body { font-family: sans-serif; margin: 0; padding: 16px; }
  .lcKema_root { display: flex; flex-direction: column; }
  .lcKema_root:not([data-expanded]) { height: 24px; overflow: hidden; }
  .lcKema_row { height: 24px; }
  .lcKema_thinkBody { white-space: pre-wrap; padding: 4px 0 4px 22px; }
  .tall { min-height: 140px; }
</style>
<div class="lcKema_root" id="row-expanded" data-variant="think" data-state="ok" data-expanded>
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_A}</div></div>
</div>
<div class="lcKema_root" id="row-duplicate" data-variant="think" data-state="ok" data-expanded>
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_A}</div></div>
</div>
<div class="lcKema_root" id="row-collapsed" data-variant="think" data-state="ok">
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_B}</div></div>
</div>
<div class="lcKema_root tall" id="row-geometry" data-variant="think" data-state="ok">
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_C}</div></div>
</div>
<div class="lcKema_root" id="row-running" data-variant="think" data-state="running" data-expanded>
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_D}</div></div>
</div>
<pre id="report"></pre>
`
}

function fixtureHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>session-translator fixture</title></head>
<body>
${shellFixtures()}
<script>
  window.__report = []
  function log(name, ok, detail) { window.__report.push({ name: name, ok: ok === true, detail: detail === undefined ? '' : String(detail) }) }
  window.onerror = function (message) { log('window.onerror', false, message) }
  window.addEventListener('unhandledrejection', function (event) { log('unhandledrejection', false, String(event.reason)) })
  window.__ModuleLoader__ = { load: function (record) { window.__pluginRecord = record } }
</script>
<script src="/plugins/dsh-session-translator/client.js"></script>
<script>
  ;(async function () {
    try {
      var record = window.__pluginRecord
      log('bundle registered', record !== undefined && record.id === 'dsh-session-translator', record && record.id)
      var plugin = record.factory(function (name) {
        if (name === 'react') return { createElement: function () { return {} } }
        throw new Error('unexpected require: ' + name)
      })
      log('apply exported', typeof plugin.apply === 'function')

      // A row-level click listener stands in for DisclosureRow's own
      // expand/collapse handling: panel buttons must never reach it.
      document.getElementById('row-expanded').addEventListener('click', function () {
        window.__rowClicked = (window.__rowClicked || 0) + 1
      })

      var sections = []
      var slots = {
        inject: function (name, callback) { callback() },
        register: function (options, component) { sections.push({ options: options, component: component }); return function () {} },
      }
      plugin.apply({ get: function (name) { return name === 'slots' ? slots : undefined }, effect: function (fn) { return fn() } })
      log('settings section registered', sections.length === 1 && sections[0].options.id === 'session-translator', sections.length)

      function panels() { return document.querySelectorAll('[data-dsh-session-translator="panel"]') }
      function translatedPanels() {
        return Array.prototype.filter.call(panels(), function (panel) { return /【中】/.test(panel.textContent) })
      }
      function panelIn(id) { var row = document.getElementById(id); return row === null ? null : row.querySelector('[data-dsh-session-translator="panel"]') }
      function waitFor(predicate, timeoutMs) {
        var deadline = Date.now() + timeoutMs
        return new Promise(function (resolve) {
          ;(function tick() {
            var value = null
            try { value = predicate() } catch (error) { value = null }
            if (value) { resolve(value); return }
            if (Date.now() > deadline) { resolve(null); return }
            setTimeout(tick, 60)
          })()
        })
      }

      var ok = await waitFor(function () { return translatedPanels().length >= 3 }, 12000)
      log('three rows translated', ok !== null, translatedPanels().length)

      var expanded = panelIn('row-expanded')
      var duplicate = panelIn('row-duplicate')
      var geometry = panelIn('row-geometry')
      log('expanded row translated', expanded !== null && /【中】/.test(expanded.textContent), expanded ? expanded.textContent.slice(0, 40) : 'missing')
      log('duplicate row translated from cache', duplicate !== null && /【中】/.test(duplicate.textContent))
      log('open-by-geometry row translated', geometry !== null && /【中】/.test(geometry.textContent))
      log('collapsed row untouched', panelIn('row-collapsed') === null)
      var runningPanel = panelIn('row-running')
      log(
        'streaming row shows a status, not a translation',
        runningPanel !== null && runningPanel.textContent.indexOf('【中】') === -1 && /自动翻译/.test(runningPanel.textContent),
        runningPanel === null ? 'no panel' : runningPanel.textContent.slice(0, 40),
      )

      // The original reasoning text must survive verbatim.
      var original = document.querySelector('#row-expanded .lcKema_thinkBody').textContent
      log('original text preserved', original === ${JSON.stringify(REASONING_A)}, original.slice(0, 30))

      var stats = await (await fetch('/__stats', { cache: 'no-store' })).json()
      log('two distinct texts, two requests', stats.translateCalls.length === 2, JSON.stringify(stats.translateCalls.map(function (t) { return t.slice(0, 20) })))
      log('identical text requested once', stats.translateCalls.filter(function (t) { return t === ${JSON.stringify(REASONING_A)} }).length === 1)
      log('collapsed text never requested', stats.translateCalls.indexOf(${JSON.stringify(REASONING_B)}) === -1)
      log('streaming text never requested', stats.translateCalls.indexOf(${JSON.stringify(REASONING_D)}) === -1)

      // Panel buttons must stop propagation into the row handler.
      window.__rowClicked = 0
      var toggle = expanded.querySelector('[data-act="toggle"]')
      var copy = expanded.querySelector('[data-act="copy"]')
      log('panel has toggle and copy', toggle !== null && copy !== null)
      toggle.click()
      copy.click()
      var body = expanded.querySelector('[data-role="body"]')
      log('toggle collapses the translation', body !== null && body.getAttribute('data-collapsed') === 'true')
      log('buttons do not bubble into the row', window.__rowClicked === 0, window.__rowClicked)
      toggle.click()
      log('toggle restores the translation', body !== null && body.getAttribute('data-collapsed') === 'false')

      // Master switch off: every panel goes away.
      await fetch('/dsh-session-translator/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ section: { enabled: false } }),
      })
      document.dispatchEvent(new Event('visibilitychange'))
      var gone = await waitFor(function () { return panels().length === 0 }, 20000)
      log('disabling removes every panel', gone !== null, panels().length)

      document.getElementById('report').textContent = JSON.stringify(window.__report)
    } catch (error) {
      log('harness crashed', false, (error && error.stack) || String(error))
      document.getElementById('report').textContent = JSON.stringify(window.__report)
    }
  })()
</script>
</body></html>`
}

function settingsHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>session-translator settings</title></head>
<body>
<div id="root"></div>
<pre id="report"></pre>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>window.__ModuleLoader__ = { load: function (record) { window.__pluginRecord = record } }</script>
<script src="/plugins/dsh-session-translator/client.js"></script>
<script>
  var SQUASH_IDS = ${JSON.stringify(SQUASH_MODELS.map((model) => model.id))}
  var SQUASH_FIRST_ID = ${JSON.stringify(SQUASH_MODELS[0].id)}
</script>
<script>
  ;(async function () {
    var report = []
    function log(name, ok, detail) { report.push({ name: name, ok: ok === true, detail: detail === undefined ? '' : String(detail) }) }
    window.onerror = function (message) { log('window.onerror', false, message) }
    try {
      var plugin = window.__pluginRecord.factory(function (name) {
        if (name === 'react') return window.React
        throw new Error('unexpected require: ' + name)
      })
      var sections = []
      var slots = {
        inject: function (name, callback) { callback() },
        register: function (options, component) { sections.push({ options: options, component: component }); return function () {} },
      }
      plugin.apply({ get: function (name) { return name === 'slots' ? slots : undefined }, effect: function (fn) { return fn() } })
      log('section registered', sections.length === 1)
      log('section label', sections.length === 1 && sections[0].options.label() === 'dsh-session-translator', sections.length === 1 ? sections[0].options.label() : '')

      var root = window.ReactDOM.createRoot(document.getElementById('root'))
      root.render(window.React.createElement(sections[0].component))

      var deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        var text = document.getElementById('root').textContent
        // 必须等 catalog 拉到、模型下拉换成「有候选」形态（触发器显示模型名）
        // 再断言，否则量到的是还没加载候选时的输入框形态。
        if (text.indexOf('翻译模型') !== -1 && text.indexOf(SQUASH_FIRST_ID) !== -1) break
        await new Promise(function (resolve) { setTimeout(resolve, 80) })
      }
      var rendered = document.getElementById('root').textContent
      // [PATCH 2026-10-19 stale-settings-assertions] 这几条断言写的是第十轮之前
      // 的旧面板（"展开时自动翻译" / "用默认模型" / 配置文件路径行），那些文案与
      // 控件早已在面板重做时删除，断言却没人更新 —— 结果永远 FAIL，掩盖真实回归。
      // 现在改成断言**当前面板的稳定锚点**：六张卡片标题 + 保存栏 + 关键控件。
      log('renders the status card', rendered.indexOf('workbuddy-ai') !== -1, rendered.slice(0, 60))
      log('renders six group cards',
        ['基础', '翻译模式', '翻译模型', '备用路由', '高级', '试译'].every(function (name) {
          return rendered.indexOf(name) !== -1
        }))
      log('renders basic switches', rendered.indexOf('启用 CoT 中文翻译') !== -1 && rendered.indexOf('思考过程中也翻译') !== -1)
      log('renders model fields', rendered.indexOf('翻译模型') !== -1 && rendered.indexOf('拉取模型列表') !== -1)
      log('renders advanced knobs', rendered.indexOf('目标语言') !== -1 && rendered.indexOf('单次请求上限') !== -1 && rendered.indexOf('并发请求数') !== -1)
      log('renders the save bar', rendered.indexOf('保存') !== -1 && rendered.indexOf('放弃改动') !== -1)
      log('renders the test box', rendered.indexOf('试译') !== -1)
      log('renders no crash text', rendered.indexOf('Something went wrong') === -1)

      var buttons = Array.prototype.slice.call(document.querySelectorAll('#root button'))
      log('has buttons', buttons.length >= 3, buttons.length)
      var clearButton = buttons.filter(function (button) { return button.textContent.indexOf('清空服务端缓存') !== -1 })[0]
      if (clearButton !== undefined) {
        clearButton.click()
        await new Promise(function (resolve) { setTimeout(resolve, 300) })
      }
      var stats = await (await fetch('/__stats', { cache: 'no-store' })).json()
      log('clear cache button hits the host', stats.cacheClears === 1, stats.cacheClears)

      // [PATCH 2026-10-19 dropdown-row-squash] 回归：模型多的渠道下，下拉每一行
      // 必须保持完整高度。曾经的 bug 是 dropdownMenu 为 flex 纵向容器，选项
      // 按钮作为 flex item 默认 flex-shrink:1，候选总高超过 maxHeight(260) 时
      // flex 先把每行从 30px 压到 18px，再被 overflow:hidden 裁掉下半截 ——
      // 表现为"下一行遮住上一行的下半截"。模型少时不会出现，所以这里必须
      // 点开一个真有 12 个候选的下拉来量。
      var trigger = Array.prototype.slice.call(document.querySelectorAll('#root button'))
        .filter(function (b) { return b.textContent.indexOf(SQUASH_FIRST_ID) !== -1 })[0]
      if (trigger === undefined) {
        log('model dropdown trigger found', false, 'no button showing ' + SQUASH_FIRST_ID)
      } else {
        trigger.click()
        await new Promise(function (resolve) { setTimeout(resolve, 250) })
        var optionButtons = Array.prototype.slice.call(document.querySelectorAll('#root button'))
          .filter(function (b) {
            var text = b.textContent.trim()
            if (/[▲▼]/.test(text)) return false
            return SQUASH_IDS.some(function (id) { return text.indexOf(id) !== -1 })
          })
        log('model dropdown lists every model', optionButtons.length === SQUASH_IDS.length,
          optionButtons.length + '/' + SQUASH_IDS.length)
        var squashed = optionButtons.filter(function (b) { return b.offsetHeight < b.scrollHeight })
        log('no model row is squashed', optionButtons.length > 0 && squashed.length === 0,
          squashed.length + '/' + optionButtons.length + ' rows clipped')
        // 行距必须 >= 行自身内容高，否则就是"下行压上行"。
        var overlap = 0
        for (var i = 1; i < optionButtons.length; i += 1) {
          var prev = optionButtons[i - 1]
          var gap = optionButtons[i].getBoundingClientRect().top - prev.getBoundingClientRect().top
          if (gap + 0.5 < prev.scrollHeight) overlap += 1
        }
        log('no model row overlaps the one above', optionButtons.length > 1 && overlap === 0,
          overlap + ' overlapping rows')
        // 下拉自己必须是可滚动容器，而不是把行压扁来塞下。
        var menu = optionButtons.length === 0 ? null : optionButtons[0].parentElement
        log('dropdown scrolls instead of shrinking rows',
          menu !== null && menu.scrollHeight > menu.clientHeight &&
            getComputedStyle(menu).overflowY === 'auto',
          menu === null ? 'no menu' : menu.scrollHeight + ' > ' + menu.clientHeight)
        trigger.click()
      }

      document.getElementById('report').textContent = JSON.stringify(report)
    } catch (error) {
      log('harness crashed', false, (error && error.stack) || String(error))
      document.getElementById('report').textContent = JSON.stringify(report)
    }
  })()
</script>
</body></html>`
}

// ------------------------------------------------------------------- run it

let passed = 0
let failed = 0
// [PATCH 2026-10-19 portable-react-umd] 跳过的 section 数：跳了不等于过了。
let skipped = 0

function check(name, ok, detail) {
  if (ok === true) {
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } else {
    failed += 1
    process.stdout.write(`  FAIL ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}\n`)
  }
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

async function dumpDom(port, path) {
  const profileDir = mkdtempSync(join(tmpdir(), 'session-translator-chrome-'))
  try {
    const { stdout } = await run(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--hide-scrollbars',
        `--user-data-dir=${profileDir}`,
        '--virtual-time-budget=30000',
        '--dump-dom',
        `http://127.0.0.1:${port}${path}`,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 180000, windowsHide: true },
    )
    return stdout
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
}

function readReport(dom) {
  const match = /<pre id="report">([\s\S]*?)<\/pre>/.exec(dom)
  if (match === null) return null
  const raw = decodeEntities(match[1]).trim()
  if (raw === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const port = httpServer.address().port

try {
  process.stdout.write(`browser check (chrome=${chrome}, port=${port})\n`)

  process.stdout.write('inline translator\n')
  const fixtureDom = await dumpDom(port, '/fixture.html')
  const fixtureReport = readReport(fixtureDom)
  if (fixtureReport === null) {
    check('fixture produced a report', false, 'no <pre id="report"> payload found')
    process.stdout.write(fixtureDom.slice(0, 2000))
  } else {
    for (const entry of fixtureReport) check(entry.name, entry.ok, entry.detail)
  }
  check('panels exist in the serialized DOM', /data-dsh-session-translator="panel"/.test(fixtureDom))

  if (reactFile !== undefined && reactDomFile !== undefined) {
    process.stdout.write('settings section\n')
    const settingsDom = await dumpDom(port, '/settings.html')
    const settingsReport = readReport(settingsDom)
    if (settingsReport === null) {
      check('settings fixture produced a report', false, 'no <pre id="report"> payload found')
      process.stdout.write(settingsDom.slice(0, 2000))
    } else {
      for (const entry of settingsReport) check(entry.name, entry.ok, entry.detail)
    }
  } else {
    // [PATCH 2026-10-19 portable-react-umd] 原来是静默 skip，第三方机器根本
    // 不知道少测了一半。改成明确写出"跳过了什么、怎么补"，并计为跳过项。
    process.stdout.write(
      'settings section\n  SKIP no React UMD build found (settings panel NOT verified)\n' +
        '       fix: set COT_EN2CN_REACT / COT_EN2CN_REACT_DOM to the UMD files, or\n' +
        '            install react + react-dom into the DSH profile node_modules\n',
    )
    skipped += 1
  }
} finally {
  httpServer.close()
}

process.stdout.write(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}\n`)
if (skipped > 0) {
  process.stdout.write('note: skipped sections were NOT verified — do not treat this run as a full pass\n')
}
if (failed > 0) process.exitCode = 1
