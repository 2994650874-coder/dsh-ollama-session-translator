// Focused check: does the settings panel lock "Translate while streaming" on a
// cloud route and unlock it on a local endpoint?
//
// 用 page.route + 本地 http server 承载 fixture，驱动真实 client.js 渲染设置面板，
// 断言云渠道下复选框 disabled/保留勾选/not-allowed、本地渠道下可编辑。
//
// 跑法：node tools/live-lock-check.mjs
import { chromium } from 'playwright-core'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHROME = 'D:\\百分\\CentBrowser\\Application\\chrome.exe'
// import.meta.url 的中文路径会被百分号编码，必须 fileURLToPath 解码。
const ROOT = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(ROOT, '..', 'lib', 'client.js')

let passed = 0
let failed = 0
const check = (name, cond, extra) => {
  if (cond) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`)
  }
}

// React UMD：优先用仓库自带的，没有就从 unpkg 拉一份到临时目录。
const reactDir = mkdtempSync(join(tmpdir(), 'react-'))
for (const [name, url] of [
  ['react.production.min.js', 'https://unpkg.com/react@18/umd/react.production.min.js'],
  ['react-dom.production.min.js', 'https://unpkg.com/react-dom@18/umd/react-dom.production.min.js'],
]) {
  try {
    const res = await fetch(url)
    writeFileSync(join(reactDir, name), await res.text(), 'utf8')
  } catch {
    writeFileSync(join(reactDir, name), 'window.React=window.ReactDOM={createElement:()=>null,createRoot:()=>({render(){}}),Fragment:()=>null,useState:()=>[null,()=>{}],useEffect:()=>{},useRef:()=>({}),useCallback:(f)=>f,useReducer:(f)=>[0,()=>{}]}', 'utf8')
  }
}

const stateFor = (mode) =>
  JSON.stringify({
    ok: true,
    config: {
      enabled: true,
      liveTranslate: true,
      autoTranslate: true,
      foldOriginal: false,
      fontSizePx: 13,
      horizonRows: 5,
      translateErrors: true,
      targetLanguage: 'zh-CN',
      provider: mode === 'cloud' ? 'ollama' : 'http://127.0.0.1:11434',
      model: mode === 'cloud' ? 'qwen' : 'qwen2.5',
    },
    defaults: {},
    languages: [{ id: 'zh-CN', label: '中文' }],
    route: { provider: mode === 'cloud' ? 'ollama' : 'http://127.0.0.1:11434', model: 'qwen' },
    stats: {},
    liveDowngraded: mode === 'cloud',
  })

const dir = mkdtempSync(join(tmpdir(), 'livefix-'))
writeFileSync(join(dir, 'index.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>fixture</title></head>
<body><div id="root"></div>
<script>window.__ModuleLoader__ = { load(rec){ window.__record = rec } }</script>
<script src="/react.production.min.js"></script>
<script src="/react-dom.production.min.js"></script>
<script src="/client.js"></script>
</body></html>`, 'utf8')

const server = createServer((req, res) => {
  const path = req.url.split('?')[0]
  // /state 按当前 mode 返回；其余路由返回最小可用载荷，避免 404 噪音。
  if (path.startsWith('/dsh-cot-en2cn/state')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(stateFor(mode))
    return
  }
  if (path.startsWith('/dsh-cot-en2cn/catalog')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, catalog: [] }))
    return
  }
  if (path.startsWith('/dsh-cot-en2cn/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, providers: [], ollama: null }))
    return
  }
  if (path.startsWith('/dsh-cot-en2cn/')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
    return
  }
  const map = {
    '/': join(dir, 'index.html'),
    '/react.production.min.js': join(reactDir, 'react.production.min.js'),
    '/react-dom.production.min.js': join(reactDir, 'react-dom.production.min.js'),
    '/client.js': CLIENT,
  }
  const file = map[path]
  if (file === undefined) {
    res.writeHead(404)
    res.end('nope')
    return
  }
  res.writeHead(200, { 'content-type': path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8' })
  res.end(readFileSync(file, 'utf8'))
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

let mode = 'cloud'
const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage()
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message))

for (const name of ['cloud', 'local']) {
  mode = name
  await page.goto(`http://127.0.0.1:${port}/`)
  await page.waitForFunction(() => window.__record !== undefined, { timeout: 15000 })

  await page.evaluate(async () => {
    const React = window.React
    const ReactDOM = window.ReactDOM
    const mod = window.__record.factory((spec) => {
      if (spec === 'react') return React
      if (spec === 'react-dom') return ReactDOM
      if (spec === 'react/jsx-runtime') {
        return { jsx: React.createElement, jsxs: React.createElement, Fragment: React.Fragment }
      }
      return {}
    })
    const locale = {
      register() { return () => {} },
      bind() { return (k) => k },
      subscribe() { return () => {} },
    }
    const ctx = {
      get(service) {
        if (service === 'slots') {
          return {
            inject(slot, factory) { return factory() },
            register(def, comp) {
              window.__slot = { def, comp }
              return () => {}
            },
          }
        }
        if (service === 'locale') return locale
        return undefined
      },
      effect(fn) { return fn() },
    }
    mod.apply(ctx)
    const host = document.createElement('div')
    document.body.appendChild(host)
    ReactDOM.createRoot(host).render(React.createElement(window.__slot.comp))
    await new Promise((r) => setTimeout(r, 1500))
    window.__text = host.textContent
  })

  const result = await page.evaluate(() => ({
    boxes: Array.from(document.querySelectorAll('input[type=checkbox]')).map((el) => ({
      disabled: el.disabled,
      checked: el.checked,
      cursor: el.style.cursor,
      title: el.title,
    })),
    text: window.__text ?? '',
  }))

  // fixture 里 locale.bind() 被 stub 成 (k)=>k，所以文案显示的是 key 名。
  // 这里同时接受中文与 key 两种形态。
  const NOTICE = /流式翻译已自动关闭|row\.liveDowngraded/
  const LOCK_HINT = /流式翻译仅本地渠道|setting\.liveLockedHint/

  console.log(`\n=== ${name === 'cloud' ? '云渠道' : '本地端点'} ===`)
  const live = result.boxes[1]
  if (live === undefined) {
    failed += 1
    console.log('  FAIL 找不到 liveTranslate 复选框（校验到的复选框数：' + result.boxes.length + '）')
    continue
  }
  if (name === 'cloud') {
    check('云渠道：流式复选框被禁用', live.disabled === true, 'disabled=' + live.disabled)
    check('云渠道：勾选状态保留', live.checked === true, 'checked=' + live.checked)
    check('云渠道：禁用光标', live.cursor === 'not-allowed', 'cursor=' + live.cursor)
    check('云渠道：有 tooltip 说明', typeof live.title === 'string' && live.title.length > 0, 'title=' + live.title)
    check('云渠道：出现锁定说明（替换原 hint）', LOCK_HINT.test(result.text), '')
    check('云渠道：面板显示降级说明', NOTICE.test(result.text), '')
  } else {
    check('本地：流式复选框可编辑', live.disabled === false, 'disabled=' + live.disabled)
    check('本地：仍保留勾选', live.checked === true, 'checked=' + live.checked)
    check('本地：无降级说明', !NOTICE.test(result.text), '')
    check('本地：显示原 hint 而非锁定说明', !LOCK_HINT.test(result.text), '')
  }
}

await browser.close()
server.close()
console.log(`\nlive-lock-check: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
