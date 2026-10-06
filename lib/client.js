/**
 * dsh-cot-en2cn — browser half (web platform).
 *
 * Two surfaces, one job: let a Chinese reader read the model's English
 * chain-of-thought without editing it.
 *
 *  1. Inline translator. Reasoning rows are shipped by ui-chat's `ReasoningRow`
 *     and there is no slot for a single reasoning block, so this half is a
 *     progressive enhancement over the rendered DOM: it finds each thinking row
 *     (`[data-variant="think"]`), and once the row is expanded it appends a
 *     Chinese translation panel right under the reasoning text. The original
 *     English is never touched, moved, or hidden — remove this plugin and the
 *     GUI is byte-identical to the stock one.
 *
 *  2. Settings section under Settings → Plugins: master switch, translation
 *     model, target language, budget knobs, cache controls and a live test box.
 *
 * Everything it needs from the host arrives over `/dsh-cot-en2cn/*`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-cot-en2cn',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    /** Host routes, all same-origin. */
    const API = {
      state: '/dsh-cot-en2cn/state',
      config: '/dsh-cot-en2cn/config',
      translate: '/dsh-cot-en2cn/translate',
      providers: '/dsh-cot-en2cn/providers',
      models: '/dsh-cot-en2cn/models',
      cacheClear: '/dsh-cot-en2cn/cache/clear',
    }

    const LOCALE_NS = 'cot-en2cn'
    /** A thinking block shorter than this is not worth a model call. */
    const MIN_CHARS = 12
    /** Throttle for the DOM reconcile pass. */
    const SYNC_INTERVAL_MS = 220
    /** Live-chasing cadence: how often a still-streaming block may re-translate. */
    const LIVE_DEBOUNCE_MS = 1400
    /** How often the translator re-reads the host config. */
    const CONFIG_POLL_MS = 15000
    /** Client-side translation cache entries. */
    const CLIENT_CACHE_LIMIT = 400

    const PANEL_ATTR = 'data-dsh-cot-en2cn'

    const MESSAGES = {
      zh: {
        section: 'dsh-ollama-session-translator',
        'status.label': '状态',
        'badge.on': '已开启',
        'badge.off': '已关闭',
        'badge.error': '连接失败',
        'row.cache': '译文缓存',
        'row.route': '翻译模型',
        'row.configPath': '配置文件',
        'row.lastError': '最近一次错误',
        'row.lastCall': '最近一次调用',
        'heading.basic': '基础',
        'setting.enabled': '启用 CoT 中文翻译',
        'setting.enabledHint': '在每段「思考」下方显示中文译文，原文不改动。',
        'setting.auto': '展开时自动翻译',
        'setting.autoHint': '关闭后，每段思考需要手动点「翻译」。',
        'heading.mode': '翻译模式',
        'setting.modeAuto': '自动翻译',
        'setting.modeManual': '手动翻译',
        'setting.modeHint': '自动：进入视野即翻译（地平线 ±N 行）；手动：不自动翻译，每段点「待翻译」。',
        'setting.horizon': '地平线行数（上下各 N 条）',
        'setting.horizonHint': '翻译当前视口内的思考，并向上/向下各多翻 N 条；数值越大预翻越多。',
        'setting.live': '思考过程中也翻译',
        'setting.liveHint': '模型还在思考时就翻译（会重复调用模型，费 token）。',
        'heading.model': '翻译模型',
        'setting.provider': 'Provider',
        'setting.model': '模型',
        'setting.modelHint': '留空 = 不翻译：未设置时译文面板直接提示「翻译模型未设置」，绝不自动使用付费默认模型。翻译是纯体力活，建议选便宜快的小模型。',
        'button.fetchModels': '拉取模型列表',
        'button.clearRoute': '清空（不翻译）',
        'models.ollamaFound': '发现 Ollama',
        'models.ollamaMissing': '未发现本地 Ollama（确认已启动；也可手动填 Provider/模型）',
        'models.viaDsh': '走 DSH 模型渠道',
        'models.viaDirect': '直连 Ollama',
        'models.pickHint': '点模型即填入：',
        'models.unset': '未设置（不翻译）',
        'setting.disableThinking': '关闭思考（推荐）',
        'setting.disableThinkingHint': '借用辅助请求通道，让翻译请求不产生思考 token。',
        'heading.advanced': '高级',
        'setting.language': '目标语言',
        'setting.chunk': '单块字符数',
        // [PATCH 2026-10-05 maxinput-panel] 单次输入上限露出到面板（config.js 已双登记）。
        'setting.maxInput': '单次输入上限（超出截断）',
        'setting.concurrency': '并发请求数',
        'setting.timeout': '单次超时',
        'setting.cacheEntries': '服务端缓存条数',
        'setting.skipChinese': '跳过已是中文的思考',
        'setting.fold': '穿透式折叠翻译',
        'setting.foldHint': '官方思考保持折叠，译文面板顶替正文位置显示（进入视野即翻译）；折叠条仍可点开看原文。',
        'setting.fontSize': '译文文字大小',
        'unit.chars': '字符',
        'unit.seconds': '秒',
        'unit.entries': '条',
        'unit.px': 'px',
        'unit.rows': '条',
        'heading.test': '试译',
        'test.placeholder': '粘贴一段英文思维链，点「试译」看看效果',
        'button.test': '试译',
        'button.clearCache': '清空服务端缓存',
        'button.save': '保存',
        'button.reset': '恢复默认',
        'save.saved': '已保存',
        'save.failed': '保存失败',
        'test.running': '翻译中…',
        'test.failed': '翻译失败',
        'panel.title': '中文译文',
        'panel.cached': '缓存',
        'panel.settling': '模型还在思考，结束后自动翻译…',
        'panel.live': '边思考边翻译…',
        'panel.waiting': '展开后自动翻译',
        'panel.loading': '翻译中…',
        'panel.retry': '重新翻译',
        'panel.copy': '复制',
        'panel.copied': '已复制',
        'panel.collapse': '收起',
        'panel.expand': '展开',
        'panel.failed': '翻译失败',
        'panel.pending': '待翻译',
        'panel.showOriginal': '显示原文',
        'panel.hideOriginal': '隐藏原文',
        'panel.truncated': '原文过长，仅翻译了前一部分',
        'panel.alreadyChinese': '原文已含中文 · 未翻译',
      },
      en: {
        section: 'dsh-ollama-session-translator',
        'status.label': 'Status',
        'badge.on': 'Enabled',
        'badge.off': 'Disabled',
        'badge.error': 'Connection error',
        'row.cache': 'Translation cache',
        'row.route': 'Translation model',
        'row.configPath': 'Config file',
        'row.lastError': 'Last error',
        'row.lastCall': 'Last call',
        'heading.basic': 'Basics',
        'setting.enabled': 'Enable CoT translation',
        'setting.enabledHint': 'Show a Chinese translation under every thinking block; the original is untouched.',
        'setting.auto': 'Translate on expand',
        'setting.autoHint': 'When off, each block needs a manual click.',
        'heading.mode': 'Translation mode',
        'setting.modeAuto': 'Auto translate',
        'setting.modeManual': 'Manual translate',
        'setting.modeHint': 'Auto: translate rows as they enter view (horizon ±N rows); Manual: no auto translation, click "Translate" per block.',
        'setting.horizon': 'Horizon rows (N above & below)',
        'setting.horizonHint': 'Translate the thinking rows in view plus N rows above and below; a larger value pre-translates more.',
        'setting.live': 'Translate while streaming',
        'setting.liveHint': 'Translate while the model is still thinking (repeated calls, more tokens).',
        'heading.model': 'Translation model',
        'setting.provider': 'Provider',
        'setting.model': 'Model',
        'setting.modelHint': 'Empty = no translation: the panel shows a "model not set" error instead of silently using the paid default model. A cheap fast model is usually enough.',
        'button.fetchModels': 'Fetch models',
        'button.clearRoute': 'Clear (no translation)',
        'models.ollamaFound': 'Ollama found',
        'models.ollamaMissing': 'No local Ollama found (start it, or type Provider/model manually)',
        'models.viaDsh': 'via DSH model channel',
        'models.viaDirect': 'direct connection',
        'models.pickHint': 'Click a model to fill in:',
        'models.unset': 'Not set (no translation)',
        'setting.disableThinking': 'Disable thinking (recommended)',
        'setting.disableThinkingHint': 'Routes the call through the auxiliary channel so it spends no reasoning tokens.',
        'heading.advanced': 'Advanced',
        'setting.language': 'Target language',
        'setting.chunk': 'Characters per chunk',
        // [PATCH 2026-10-05 maxinput-panel] expose maxInputChars in the panel.
        'setting.maxInput': 'Max input per block (clips beyond)',
        'setting.concurrency': 'Concurrent requests',
        'setting.timeout': 'Request timeout',
        'setting.cacheEntries': 'Host cache entries',
        'setting.skipChinese': 'Skip reasoning already in Chinese',
        'setting.fold': 'Pass-through folded translation',
        'setting.foldHint': 'Keep the official thinking row folded and let the translation panel take the body position (rows translate as they enter view); the folded strip still opens the original.',
        'setting.fontSize': 'Translation font size',
        'unit.chars': 'chars',
        'unit.seconds': 's',
        'unit.entries': 'entries',
        'unit.px': 'px',
        'unit.rows': 'rows',
        'heading.test': 'Try it',
        'test.placeholder': 'Paste an English chain of thought and press Translate',
        'button.test': 'Translate',
        'button.clearCache': 'Clear host cache',
        'button.save': 'Save',
        'button.reset': 'Reset to defaults',
        'save.saved': 'Saved',
        'save.failed': 'Save failed',
        'test.running': 'Translating…',
        'test.failed': 'Translation failed',
        'panel.title': 'Chinese',
        'panel.cached': 'cached',
        'panel.settling': 'Still thinking — translating when it settles…',
        'panel.live': 'Translating while it thinks…',
        'panel.waiting': 'Translate on expand',
        'panel.loading': 'Translating…',
        'panel.retry': 'Retranslate',
        'panel.copy': 'Copy',
        'panel.copied': 'Copied',
        'panel.collapse': 'Collapse',
        'panel.expand': 'Expand',
        'panel.failed': 'Translation failed',
        'panel.pending': 'Translate',
        'panel.showOriginal': 'Show original',
        'panel.hideOriginal': 'Hide original',
        'panel.truncated': 'Source was long; only the first part was translated',
        'panel.alreadyChinese': 'Already Chinese · left untranslated',
      },
    }

    let t = (key) => MESSAGES.zh[key] ?? key

    // [PATCH 2026-10-01 session-cache] 当前会话 id 来源（apply 里绑 sessions 服务）。
    // 翻译请求带上它，宿主把译文缓存写进该会话自己的文件夹（会话删除随之删除）。
    let sessionKeySource = () => ''
    function currentSessionKey() {
      try {
        const key = sessionKeySource()
        if (typeof key === 'string' && key !== '') return key
      } catch {
        /* fall through to the URL fallback */
      }
      // [PATCH 2026-10-01 session-cache] 兜底：从页面 URL 提取会话 id（服务缺席
      // 或形状不符时仍可归属；前缀形态优先、裸 UUID 次之，真实文件夹由宿主把关）。
      try {
        const href = String(window.location?.href ?? '')
        const prefixed = href.match(
          /session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
        )
        if (prefixed !== null) return prefixed[0]
        const bare = href.match(
          /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
        )
        return bare === null ? '' : bare[0]
      } catch {
        return ''
      }
    }

    // ---------------------------------------------------------------- utilities

    /** Cheap synchronous content hash (djb2 xor), stable inside one page. */
    function hashText(text) {
      let hash = 5381
      for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) + hash) ^ text.charCodeAt(i)
      }
      return (hash >>> 0).toString(36)
    }

    function readJson(response) {
      return response.json().then(
        (value) => {
          if (!response.ok) {
            const message = value !== null && typeof value === 'object' && typeof value.error === 'string'
              ? value.error
              : `HTTP ${response.status}`
            throw new Error(message)
          }
          return value
        },
        () => {
          throw new Error(`HTTP ${response.status}`)
        },
      )
    }

    function postJson(url, body) {
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
      }).then(readJson)
    }

    function putJson(url, body) {
      return fetch(url, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(body),
      }).then(readJson)
    }

    // ------------------------------------------------------- inline translator

    /**
     * The inline translator. Deliberately plain DOM code: the reasoning row is
     * rendered by another package and has no slot, so this enhancement only
     * ever *adds* a sibling node next to the reasoning body.
     */
    const translator = {
      /** Live host config; `null` until the first successful fetch. */
      config: null,
      /** text hash -> translation. */
      cache: new Map(),
      /** text hash -> in-flight promise, so two rows never pay twice. */
      inflight: new Map(),
      observer: null,
      syncTimer: null,
      pollTimer: null,
      /** Set once `apply` has run; the router may call apply only once. */
      started: false,
    }

    function clientCacheGet(key) {
      const value = translator.cache.get(key)
      if (value === undefined) return undefined
      translator.cache.delete(key)
      translator.cache.set(key, value)
      return value
    }

    function clientCacheSet(key, value) {
      translator.cache.delete(key)
      translator.cache.set(key, value)
      while (translator.cache.size > CLIENT_CACHE_LIMIT) {
        translator.cache.delete(translator.cache.keys().next().value)
      }
    }

    function fetchState() {
      return fetch(API.state, { cache: 'no-store' }).then(readJson)
    }

    function requestTranslation(text, force) {
      const key = hashText(text)
      const running = translator.inflight.get(key)
      if (running !== undefined) return running
      const sessionKey = currentSessionKey()
      const task = postJson(API.translate, force === true ? { text, force: true, sessionKey } : { text, sessionKey }).then((payload) => {
        if (payload.ok !== true) throw new Error(String(payload.error ?? 'translation failed'))
        return payload
      })
      translator.inflight.set(key, task)
      const settle = () => {
        if (translator.inflight.get(key) === task) translator.inflight.delete(key)
      }
      task.then(settle, settle)
      return task
    }

    /**
     * Find every reasoning row currently in the document.
     *
     * Primary anchor is the stable `data-variant="think"` attribute shipped by
     * ui-chat's ReasoningRow; the class-substring fallbacks keep the plugin
     * working if that attribute is ever renamed.
     *
     * @returns the reasoning row elements.
     */
    function findReasoningRoots() {
      const roots = document.querySelectorAll('[data-variant="think"]')
      if (roots.length > 0) return Array.from(roots)
      const found = new Set()
      for (const body of document.querySelectorAll('[class*="thinkBody"]')) {
        const root = body.closest('[data-state]')
        if (root !== null) found.add(root)
      }
      return Array.from(found)
    }

    /** The reasoning text container inside one row. */
    function findReasoningBody(root) {
      const direct = root.querySelector('[class*="thinkBody"]')
      if (direct !== null) return direct
      const candidates = Array.from(root.querySelectorAll('div'))
      for (let i = candidates.length - 1; i >= 0; i -= 1) {
        const node = candidates[i]
        if (node.getAttribute('data-variant') !== null) continue
        if ((node.textContent ?? '').length > 0) return node
      }
      return null
    }

    /** Whether one reasoning row is currently opened by the user. */
    function isOpen(root) {
      if (root.hasAttribute('data-expanded')) return true
      // A collapsed row is a fixed-height strip (~24px). Measuring the real box
      // also covers builds that keep the body mounted behind `overflow:hidden`.
      return root.getBoundingClientRect().height > 48
    }

    const CSS = `
.dsh-cot-en2cn-panel{box-sizing:border-box;margin:6px 0 2px;padding:6px 10px 8px calc(22px + var(--dsh-content-font-delta,0px));border-left:2px solid var(--dsw-alias-state-business-primary,rgba(77,107,254,.65));background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.06));border-radius:0 6px 6px 0;color:var(--dsw-alias-label-secondary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));overflow-wrap:anywhere}
.dsh-cot-en2cn-head{display:flex;align-items:center;gap:8px;margin-bottom:2px;font-size:11px;color:var(--dsw-alias-label-caption,var(--dsw-alias-label-tertiary));user-select:none}
.dsh-cot-en2cn-title{font-weight:600;letter-spacing:.02em}
.dsh-cot-en2cn-meta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.8}
.dsh-cot-en2cn-actions{display:flex;gap:6px;flex:none}
.dsh-cot-en2cn-btn{border:0;background:transparent;color:inherit;cursor:pointer;padding:0 2px;font:inherit;opacity:.75;text-decoration:underline;text-underline-offset:2px}
.dsh-cot-en2cn-btn:hover{opacity:1}
.dsh-cot-en2cn-body{white-space:pre-wrap;word-break:break-word}
.dsh-cot-en2cn-body[data-collapsed='true']{display:block;max-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));overflow:hidden;white-space:nowrap;text-overflow:ellipsis;cursor:pointer;opacity:.72}
.dsh-cot-en2cn-body[data-collapsed='true']:hover{opacity:1}
.dsh-cot-en2cn-status{opacity:.7;font-style:italic}
.dsh-cot-en2cn-error{color:var(--dsw-state-error-primary,#d94b4b);white-space:pre-wrap}
.dsh-cot-en2cn-panel[data-fontsize] .dsh-cot-en2cn-body,.dsh-cot-en2cn-panel[data-fontsize] .dsh-cot-en2cn-status,.dsh-cot-en2cn-panel[data-fontsize] .dsh-cot-en2cn-error{font-size:var(--dsh-cot-en2cn-font-size,inherit)}
.dsh-cot-en2cn-orig{margin:6px 0 2px;padding:4px 8px;border-left:2px dashed var(--dsw-alias-border-l2,rgba(127,127,127,.35));color:var(--dsw-alias-label-tertiary);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:pre-wrap;word-break:break-word}
.dsh-cot-en2cn-panel[data-mode='fold']{margin:0;padding:4px 0 4px calc(22px + var(--dsh-content-font-delta,0px));border-left:0;background:transparent;border-radius:0;color:var(--dsw-alias-label-secondary)}
.dsh-cot-en2cn-panel[data-mode='fold'] .dsh-cot-en2cn-head{margin-bottom:0;opacity:1}
.dsh-cot-en2cn-panel[data-mode='fold'] .dsh-cot-en2cn-title,.dsh-cot-en2cn-panel[data-mode='fold'] .dsh-cot-en2cn-meta,.dsh-cot-en2cn-panel[data-mode='fold'] .dsh-cot-en2cn-btn:not([data-act='orig']){opacity:0;pointer-events:none;transition:opacity .12s}
.dsh-cot-en2cn-panel[data-mode='fold']:hover .dsh-cot-en2cn-title,.dsh-cot-en2cn-panel[data-mode='fold']:hover .dsh-cot-en2cn-meta,.dsh-cot-en2cn-panel[data-mode='fold']:hover .dsh-cot-en2cn-btn:not([data-act='orig']),.dsh-cot-en2cn-panel[data-mode='fold']:focus-within .dsh-cot-en2cn-title,.dsh-cot-en2cn-panel[data-mode='fold']:focus-within .dsh-cot-en2cn-meta,.dsh-cot-en2cn-panel[data-mode='fold']:focus-within .dsh-cot-en2cn-btn:not([data-act='orig']){opacity:.8;pointer-events:auto}
.dsh-cot-en2cn-panel[data-mode='fold'] .dsh-cot-en2cn-btn[data-act='orig']{opacity:.55}
.dsh-cot-en2cn-panel[data-mode='fold'] .dsh-cot-en2cn-btn[data-act='orig']:hover{opacity:1}
.dsh-cot-en2cn-panel[data-mode='fold'] .dsh-cot-en2cn-btn[data-act='manual']:not([hidden]){opacity:.9;pointer-events:auto}
`
    let styleInjected = false

    function injectStyle() {
      if (styleInjected) return
      styleInjected = true
      const style = document.createElement('style')
      style.setAttribute('data-dsh-cot-en2cn-style', '1')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    function panelButton(action, label) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'dsh-cot-en2cn-btn'
      button.setAttribute('data-act', action)
      button.textContent = label
      return button
    }

    /** Create the (still empty) panel element for one reasoning body. */
    function createPanel() {
      const panel = document.createElement('div')
      panel.className = 'dsh-cot-en2cn-panel'
      panel.setAttribute(PANEL_ATTR, 'panel')

      const head = document.createElement('div')
      head.className = 'dsh-cot-en2cn-head'
      head.setAttribute('data-role', 'head')

      const title = document.createElement('span')
      title.className = 'dsh-cot-en2cn-title'
      title.setAttribute('data-role', 'title')
      title.textContent = t('panel.title')

      const meta = document.createElement('span')
      meta.className = 'dsh-cot-en2cn-meta'
      meta.setAttribute('data-role', 'meta')

      const actions = document.createElement('span')
      actions.className = 'dsh-cot-en2cn-actions'
      actions.setAttribute('data-role', 'actions')

      const showOriginal = panelButton('orig', t('panel.showOriginal'))
      showOriginal.hidden = true
      const retry = panelButton('retry', t('panel.retry'))
      const copy = panelButton('copy', t('panel.copy'))
      // [PATCH 2026-10-02 mode-horizon] 「待翻译」按钮：手动翻译模式的主触发；默认隐藏，
      // 仅在手动待译/失败时显示。放在「显示原文」之前（紧跟标题+meta 之后）。
      const manual = panelButton('manual', t('panel.pending'))
      manual.hidden = true
      const toggle = panelButton('toggle', t('panel.collapse'))
      actions.append(manual, showOriginal, retry, copy, toggle)

      head.append(title, meta, actions)

      const status = document.createElement('div')
      status.className = 'dsh-cot-en2cn-status'
      status.setAttribute('data-role', 'status')
      status.hidden = true

      const error = document.createElement('div')
      error.className = 'dsh-cot-en2cn-error'
      error.setAttribute('data-role', 'error')
      error.hidden = true

      const body = document.createElement('div')
      body.className = 'dsh-cot-en2cn-body'
      body.setAttribute('data-role', 'body')
      body.hidden = true

      const orig = document.createElement('div')
      orig.className = 'dsh-cot-en2cn-orig'
      orig.setAttribute('data-role', 'orig')
      orig.hidden = true

      panel.append(head, status, error, body, orig)
      return panel
    }

    function panelPart(panel, role) {
      return panel.querySelector(`[data-role="${role}"]`)
    }

    // [PATCH 2026-10-06 select-safe] 幂等写入 + 选区保护。textContent 赋值会销毁
    // 旧文本节点并新建文本节点，即使内容一字不变；正在拖选的 Range 边界随节点删除
    // 收拢到 (body, 0)=正文开头（表现为"选中间一段会把前面的译文一并带入选区"），
    // 下一次重写再把选区清空（"松开鼠标选区即被解除"）。因此：同值不写；用户正在
    // 面板内选中时延迟写入。同步维护 _analysis\select-safe-test.mjs。
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
      // [PATCH 2026-10-06 select-safe] 选区正落在本面板时不换文本节点，稍后补写
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
        // [PATCH 2026-10-06 skip-policy] 跳过≠翻译：已含中文的回显必须明示"未翻译"，
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

    // [PATCH 2026-10-01 live-cadence] 追赶式流式：live 模式下译文随思考推进按节拍
    // 刷新。响应按提交顺序单调渲染（旧的慢响应不覆盖新译文；旧文本的部分译文照常
    // 渲染，下一轮追上）。同步维护 _analysis\live-cadence-test.mjs。

    /** Submission order for one panel's live-chasing calls. */
    function nextLiveSeq(panel) {
      panel.__liveSeq = (panel.__liveSeq ?? 0) + 1
      return panel.__liveSeq
    }

    /** Whether a response may render: only the newest not-yet-superseded one. */
    function claimLiveRender(panel, seq) {
      if (seq <= (panel.__liveRenderedSeq ?? 0)) return false
      panel.__liveRenderedSeq = seq
      return true
    }

    /** Cadence rule: at most one timer pending and one call in flight per panel. */
    function shouldScheduleLive(panel) {
      return panel.__liveTimer === undefined && panel.dataset.state !== 'loading'
    }

    function beginTranslation(panel, text, key, force) {
      panel.__sourceText = text
      panel.dataset.srcKey = key
      panel.dataset.srcLength = String(text.length)
      panel.dataset.state = 'loading'
      setError(panel, '')
      setStatus(panel, t('panel.loading'))
      const manual = panel.querySelector('[data-act="manual"]')
      if (manual !== null) manual.hidden = true
      const seq = nextLiveSeq(panel)
      requestTranslation(text, force)
        .then((payload) => {
          clientCacheSet(key, payload)
          if (!panel.isConnected || !claimLiveRender(panel, seq)) return
          renderTranslation(panel, payload)
        })
        .catch((error) => {
          if (!panel.isConnected || !claimLiveRender(panel, seq)) return
          panel.dataset.state = 'error'
          setStatus(panel, '')
          setError(panel, `${t('panel.failed')}：${error instanceof Error ? error.message : String(error)}`)
          const manual = panel.querySelector('[data-act="manual"]')
          if (manual !== null) manual.hidden = false
        })
    }

    // [PATCH 2026-10-01 fold-original] 穿透式折叠翻译：折叠行文本源（React fiber
    // 只读）、面板归属/插入点迁移、地平线延译。同步维护 _analysis\fold-mode-test.mjs。
    /**
     * React attaches its fiber to every DOM node as `__reactFiber$<random>`.
     * Used read-only: a folded ReasoningRow unmounts its body and renders only
     * the summary line, so the full source text lives in the row's props.
     */
    function reactFiberOf(node) {
      for (const key of Object.keys(node)) {
        if (key.startsWith('__reactFiber$')) return node[key]
      }
      return null
    }

    /** ReasoningRow's own props carry `{ text, running }`. */
    function isRowProps(props) {
      return (
        props !== null &&
        typeof props === 'object' &&
        typeof props.text === 'string' &&
        typeof props.running === 'boolean'
      )
    }

    /** The raw `text` prop of the owning ReasoningRow, or '' when unreadable. */
    function rawRowText(root) {
      let fiber = reactFiberOf(root)
      for (let depth = 0; fiber !== null && depth < 16; depth += 1) {
        const props = fiber.memoizedProps
        if (isRowProps(props)) return String(props.text).trim()
        fiber = fiber.return
      }
      return ''
    }

    /**
     * Source text for one row. Fold mode prefers the raw prop text — available
     * while the row is folded and stable across expand/collapse (so the cache
     * key does not change under the reader) — and falls back to the rendered
     * body text; inline mode keeps the rendered body text it always used.
     */
    function rowSourceText(root, body, foldMode) {
      const domText = body === null ? '' : (body.textContent ?? '').trim()
      if (!foldMode) return domText
      const raw = rawRowText(root)
      return raw.length > 0 ? raw : domText
    }

    /** The panel belonging to one row, wherever a previous mode left it. */
    function findPanel(root, body) {
      const next = root.nextElementSibling
      if (next !== null && next.getAttribute(PANEL_ATTR) === 'panel') return next
      const host = body !== null ? (body.parentElement ?? root) : root
      const inHost = host.querySelector(`:scope > [${PANEL_ATTR}="panel"]`)
      if (inHost !== null) return inHost
      return root.querySelector(`:scope > [${PANEL_ATTR}="panel"]`)
    }

    /**
     * Put the panel where the active mode wants it: fold mode keeps it outside
     * the row (the row clips its own overflow), inline mode right under the
     * body. Moves only when misplaced, so reconcile never fights the observer.
     */
    function placePanel(panel, root, body, foldMode) {
      if (foldMode) {
        if (root.nextElementSibling !== panel) root.after(panel)
        return
      }
      const anchor = body ?? root
      if (anchor.nextElementSibling !== panel) anchor.after(panel)
    }

    /**
     * Fold mode pre-translates a moving band around the viewport: every row
     * intersecting it plus config.horizonRows rows above and below. Folded rows are
     * short (~24px), so a screen-based horizon would cover dozens of them and
     * read as "translate everything"; a row band stays proportional. Rows
     * outside the band are deferred until scrolling brings them near; rows
     * that already have a panel are never deferred again.
     */
    // [PATCH 2026-10-02 mode-horizon] 地平线行数可配置（默认 5），由 config.horizonRows 传入。
    const DEFAULT_HORIZON_ROWS = 5
    function visibleBand(roots, limit, horizon = DEFAULT_HORIZON_ROWS) {
      if (typeof window === 'undefined') return { lo: 0, hi: limit - 1 }
      const height = window.innerHeight
      let lo = -1
      let hi = -1
      for (let i = 0; i < limit; i += 1) {
        const rect = roots[i].getBoundingClientRect()
        if (rect.bottom >= 0 && rect.top <= height) {
          if (lo < 0) lo = i
          hi = i
        }
      }
      if (lo < 0) return { lo: 0, hi: -1 }
      return { lo: Math.max(0, lo - horizon), hi: Math.min(limit - 1, hi + horizon) }
    }

    /** Reconcile one reasoning row with its panel. */
    function syncRow(root, config, inBand) {
      const foldMode = config.foldOriginal === true
      const body = findReasoningBody(root)
      if (body === null && !foldMode) return null
      if (!foldMode && !isOpen(root)) return null
      let panel = findPanel(root, body)
      if (foldMode && panel === null && !inBand) return null
      const text = rowSourceText(root, body, foldMode)
      if (text.length < MIN_CHARS) return null
      const running = root.getAttribute('data-state') === 'running'

      if (panel === null) panel = createPanel()
      placePanel(panel, root, body, foldMode)
      panel.dataset.mode = foldMode ? 'fold' : 'inline'
      const showOriginal = panel.querySelector('[data-act="orig"]')
      if (showOriginal !== null) {
        showOriginal.hidden = !foldMode
        // [PATCH 2026-10-01 orig-link] 标签随官方行展开状态对账（直接点细条也同步）。
        const label = root.hasAttribute('data-expanded') ? t('panel.hideOriginal') : t('panel.showOriginal')
        if (showOriginal.textContent !== label) showOriginal.textContent = label
      }
      panel.style.setProperty('--dsh-cot-en2cn-font-size', `${config.fontSizePx ?? 13}px`)
      panel.setAttribute('data-fontsize', '1')
      const meta = panelPart(panel, 'meta')
      if (meta !== null && panel.dataset.state !== 'done') setTextIfChanged(meta, '')
      panel.__sourceText = text
      const orig = panelPart(panel, 'orig')
      if (orig !== null && orig.hidden !== true && orig.textContent !== text) orig.textContent = text

      const key = hashText(text)
      if (panel.dataset.srcKey === key && panel.dataset.state !== 'idle') return panel

      const cached = clientCacheGet(key)
      if (cached !== undefined) {
        // [PATCH 2026-10-06 select-safe] 缓存命中渲染必须同样记 srcKey：否则上面的
        // 早退守卫永不命中，每轮 sync 都会重渲染，而重写本身又触发 MutationObserver
        // → 220ms 自维持重写循环，译文文本节点永久每秒重建数次，选区无法存活。
        panel.dataset.srcKey = key
        renderTranslation(panel, cached)
        return panel
      }
      if (config.autoTranslate !== true) {
        // [PATCH 2026-10-02 mode-horizon] 手动翻译：不自动翻译，面板保持紧凑（正文隐藏），
        // 显示「待翻译」按钮；去掉「展开后自动翻译」这一对手动模式有误导的提示。
        panel.dataset.srcKey = key
        panel.dataset.state = 'idle'
        setStatus(panel, '')
        const manual = panel.querySelector('[data-act="manual"]')
        if (manual !== null) manual.hidden = false
        return panel
      }
      if (running && config.liveTranslate !== true) {
        // Hold the panel open with an honest status instead of translating a
        // half-finished block: the text is still changing, and a translation of
        // it would be thrown away. An empty srcKey lets the settle re-enter.
        panel.dataset.srcKey = ''
        panel.dataset.state = 'settling'
        setStatus(panel, t('panel.settling'))
        const manual = panel.querySelector('[data-act="manual"]')
        if (manual !== null) manual.hidden = true
        return panel
      }
      if (running && config.liveTranslate === true) {
        // [PATCH 2026-10-01 live-cadence] 追赶式流式：每 LIVE_DEBOUNCE_MS 一个节拍，
        // 有在飞的调用就等它落地，否则拿最新原文发起下一轮——译文在思考期间一段段
        // 刷新追赶；思考结束由 settle 路径出全量终稿。
        panel.dataset.srcKey = key
        if (shouldScheduleLive(panel)) {
          panel.dataset.state = 'streaming'
          setStatus(panel, t('panel.live'))
          panel.__liveTimer = setTimeout(() => {
            panel.__liveTimer = undefined
            const current = panel.__sourceText
            if (!panel.isConnected || typeof current !== 'string' || current.length < MIN_CHARS) return
            beginTranslation(panel, current, hashText(current), false)
          }, LIVE_DEBOUNCE_MS)
        }
        return panel
      }
      beginTranslation(panel, text, key, false)
      return panel
    }

    /** One reconcile pass over every reasoning row in the document. */
    function sync() {
      const config = translator.config
      if (config === null) return
      if (config.enabled !== true) {
        removeAllPanels()
        return
      }
      const keep = new Set()
      const roots = findReasoningRoots()
      const limit = Math.min(roots.length, 80)
      const horizon = typeof config.horizonRows === 'number' ? config.horizonRows : DEFAULT_HORIZON_ROWS
      const band = config.foldOriginal === true ? visibleBand(roots, limit, horizon) : { lo: 0, hi: limit - 1 }
      for (let i = 0; i < limit; i += 1) {
        const panel = syncRow(roots[i], config, i >= band.lo && i <= band.hi)
        if (panel !== null) keep.add(panel)
      }
      for (const panel of document.querySelectorAll(`[${PANEL_ATTR}="panel"]`)) {
        if (!keep.has(panel)) panel.remove()
      }
    }

    function removeAllPanels() {
      for (const panel of document.querySelectorAll(`[${PANEL_ATTR}="panel"]`)) panel.remove()
    }

    function safeSync() {
      try {
        sync()
      } catch (error) {
        console.warn('cot-en2cn: reconcile failed', error)
      }
    }

    function scheduleSync() {
      if (translator.syncTimer !== null) return
      translator.syncTimer = setTimeout(() => {
        translator.syncTimer = null
        safeSync()
      }, SYNC_INTERVAL_MS)
    }

    // [PATCH 2026-10-01 orig-link] 「显示原文」与官方思考行联动 + 译文一行预览收起。
    // 事件胶水（GUI 验收）；纯逻辑仍由 _analysis\fold-mode-test.mjs 覆盖。

    /** The reasoning row a panel belongs to (fold: previous sibling; inline: ancestor). */
    function rowOfPanel(panel) {
      const inside = panel.closest('[data-variant="think"]')
      if (inside !== null) return inside
      const prev = panel.previousElementSibling
      return prev !== null && prev.matches('[data-variant="think"]') ? prev : null
    }

    /** Click a host control without letting it focus (headers scroll on focus). */
    function quietClick(control) {
      control.focus = () => {}
      try {
        control.click()
      } finally {
        delete control.focus
      }
    }

    /** Collapse/expand the translation body into a one-line preview. */
    function setBodyCollapsed(panel, collapsed) {
      const body = panelPart(panel, 'body')
      if (body === null) return
      body.setAttribute('data-collapsed', collapsed ? 'true' : 'false')
      const toggle = panel.querySelector('[data-act="toggle"]')
      if (toggle !== null) {
        const label = collapsed ? t('panel.expand') : t('panel.collapse')
        if (toggle.textContent !== label) toggle.textContent = label
      }
    }

    /**
     * One delegated click listener for every panel action. Delegation means
     * panels survive React re-renders without re-binding anything.
     */
    function onDocumentClick(event) {
      const target = event.target
      if (!(target instanceof Element)) return
      const panel = target.closest(`[${PANEL_ATTR}="panel"]`)
      if (panel === null) return
      // [PATCH 2026-10-01 orig-link] 收起态的译文预览条可点（= 展开）。
      const preview = panelPart(panel, 'body')
      if (
        preview !== null &&
        preview.getAttribute('data-collapsed') === 'true' &&
        preview.contains(target)
      ) {
        event.preventDefault()
        event.stopPropagation()
        setBodyCollapsed(panel, false)
        return
      }
      const button = target.closest(`[${PANEL_ATTR}="panel"] [data-act]`)
      if (button === null) return
      const action = button.getAttribute('data-act')
      event.preventDefault()
      event.stopPropagation()
      const body = panelPart(panel, 'body')
      if (action === 'copy') {
        const text = body === null ? '' : body.textContent ?? ''
        if (text !== '' && navigator.clipboard !== undefined) {
          navigator.clipboard.writeText(text).then(
            () => {
              button.textContent = t('panel.copied')
              setTimeout(() => {
                button.textContent = t('panel.copy')
              }, 1200)
            },
            () => {},
          )
        }
        return
      }
      if (action === 'toggle') {
        if (body === null) return
        setBodyCollapsed(panel, body.getAttribute('data-collapsed') !== 'true')
        return
      }
      if (action === 'orig') {
        // [PATCH 2026-10-01 orig-link] 联动官方思考行：点「显示原文」= 展开/收起
        // 原生思考行（原文在其原生位置显示）；按钮标签随 data-expanded 对账。
        const row = rowOfPanel(panel)
        const control = row === null ? null : row.querySelector('[data-disclosure-row]')
        if (control !== null) {
          quietClick(control)
          return
        }
        // 兜底：找不到官方开关时退回面板内原文块。
        const orig = panelPart(panel, 'orig')
        if (orig === null) return
        const showing = orig.hidden !== true
        orig.hidden = showing
        if (!showing) orig.textContent = panel.__sourceText ?? ''
        const label = showing ? t('panel.showOriginal') : t('panel.hideOriginal')
        button.textContent = typeof label === 'string' && label !== '' ? label : showing ? '显示原文' : '隐藏原文'
        return
      }
      if (action === 'retry' || action === 'manual') {
        const source = panel.__sourceText
        if (typeof source !== 'string' || source.length === 0) return
        beginTranslation(panel, source, hashText(source), action === 'retry')
      }
    }

    /**
     * Start the inline translator. Idempotent: the client router may apply the
     * plugin once per page, but a hot reload can call it again.
     *
     * @param locale - optional client locale service, for panel copy.
     */
    function startTranslator(locale) {
      if (translator.started) return
      if (typeof document === 'undefined') return
      translator.started = true
      injectStyle()

      translator.observer = new MutationObserver(() => {
        scheduleSync()
      })
      translator.observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-expanded', 'data-state'],
      })
      document.addEventListener('click', onDocumentClick, true)
      // Fold mode translates on approach, so any scroll re-runs the pass.
      document.addEventListener('scroll', scheduleSync, { capture: true, passive: true })

      const refresh = () => {
        fetchState()
          .then((payload) => {
            translator.config = payload.config ?? null
            safeSync()
          })
          .catch((error) => {
            // A failed poll leaves the last known config in place; the settings
            // panel is where the user sees the connection error.
            console.warn('cot-en2cn: state fetch failed', error)
          })
      }
      refresh()
      translator.pollTimer = setInterval(refresh, CONFIG_POLL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') refresh()
      })
      if (locale !== undefined) {
        try {
          locale.subscribe(() => scheduleSync())
        } catch {
          /* locale is best-effort */
        }
      }
      safeSync()
    }

    // ------------------------------------------------------------ settings UI

    const styles = {
      panel: { display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)' },
      row: { display: 'flex', alignItems: 'center', gap: 8 },
      column: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { flex: 1, color: 'var(--dsw-alias-label-secondary)' },
      hint: { fontSize: 12, opacity: 0.65, marginTop: -2 },
      heading: { margin: 0, fontSize: 12, fontWeight: 600, opacity: 0.7, marginTop: 12 },
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 },
      badgeBase: { display: 'inline-block', padding: '2px 10px', borderRadius: 999, fontSize: 12, border: '1px solid var(--dsw-alias-border-l2)', whiteSpace: 'nowrap' },
      badgeOn: { color: 'var(--dsw-state-success-primary, #2f9e44)' },
      badgeOff: { color: 'var(--dsw-alias-label-tertiary)' },
      badgeErr: { color: 'var(--dsw-state-error-primary, #d94b4b)' },
      error: { color: 'var(--dsw-state-error-primary, #d94b4b)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      input: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-primary)', padding: '4px 8px', font: 'inherit', minWidth: 0 },
      number: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-primary)', padding: '4px 8px', font: 'inherit', width: 92 },
      textarea: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-primary)', padding: '6px 8px', font: 'inherit', minHeight: 72, resize: 'vertical' },
      button: { minHeight: 30, padding: '0 12px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 15, background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', font: 'inherit' },
      checkbox: { width: 16, height: 16, accentColor: 'var(--dsw-alias-label-primary)', cursor: 'pointer' },
      result: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '8px 10px', maxHeight: 260, overflow: 'auto', background: 'var(--dsw-alias-bg-layer-1, transparent)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, opacity: 0.8 },
    }

    const NUMBER_FIELDS = [
      { key: 'maxChunkChars', label: 'setting.chunk', unit: 'unit.chars' },
      // [PATCH 2026-10-05 maxinput-panel] 单次输入上限：翻译一个思考块时的总字符闸
      // （超出截断并提示）；分块大小由 maxChunkChars 控制，两者独立。
      { key: 'maxInputChars', label: 'setting.maxInput', unit: 'unit.chars' },
      { key: 'concurrency', label: 'setting.concurrency', unit: 'unit.entries' },
      { key: 'timeoutMs', label: 'setting.timeout', unit: 'unit.seconds', scale: 1000 },
      { key: 'cacheEntries', label: 'setting.cacheEntries', unit: 'unit.entries' },
      { key: 'fontSizePx', label: 'setting.fontSize', unit: 'unit.px' },
    ]

    const BOOLEAN_FIELDS = [
      { key: 'enabled', label: 'setting.enabled', hint: 'setting.enabledHint' },
      { key: 'liveTranslate', label: 'setting.live', hint: 'setting.liveHint' },
      { key: 'disableThinking', label: 'setting.disableThinking', hint: 'setting.disableThinkingHint' },
      { key: 'skipMostlyChinese', label: 'setting.skipChinese', hint: null },
      { key: 'foldOriginal', label: 'setting.fold', hint: 'setting.foldHint' },
    ]

    function createSection(translate, locale) {
      function Section() {
        const [state, setState] = React.useState(null)
        const [draft, setDraft] = React.useState(null)
        const [error, setError] = React.useState('')
        const [notice, setNotice] = React.useState('')
        const [testInput, setTestInput] = React.useState('')
        const [testResult, setTestResult] = React.useState(null)
        const [testing, setTesting] = React.useState(false)
        const [models, setModels] = React.useState(null)
        // Text fields edit a local draft; the 5s status poll must not clobber
        // half-typed provider/model values.
        const dirty = React.useRef(false)

        const apply = React.useCallback((payload) => {
          setState(payload)
          if (!dirty.current) setDraft(payload.config)
        }, [])

        const refresh = React.useCallback(() => {
          fetchState()
            .then((payload) => {
              apply(payload)
              setError('')
            })
            .catch((reason) => setError(String(reason && reason.message ? reason.message : reason)))
        }, [apply])

        React.useEffect(() => {
          refresh()
          const timer = setInterval(refresh, 5000)
          return () => clearInterval(timer)
        }, [refresh])

        const save = (patch) => {
          const next = { ...(draft ?? {}), ...patch }
          dirty.current = false
          setDraft(next)
          putJson(API.config, { section: next })
            .then((payload) => {
              apply(payload)
              setNotice(translate('save.saved'))
              setError('')
              setTimeout(() => setNotice(''), 1500)
            })
            .catch((reason) => {
              setError(`${translate('save.failed')}：${reason && reason.message ? reason.message : reason}`)
            })
        }

        const runTest = () => {
          const text = testInput.trim()
          if (text === '') return
          setTesting(true)
          setTestResult(null)
          postJson(API.translate, { text })
            .then((payload) => {
              setTestResult({ ok: true, text: String(payload.translation ?? ''), meta: payload })
            })
            .catch((reason) => {
              setTestResult({ ok: false, text: String(reason && reason.message ? reason.message : reason) })
            })
            .then(() => setTesting(false))
        }

        const clearCache = () => {
          postJson(API.cacheClear, {})
            .then((payload) => {
              if (state !== null) setState({ ...state, stats: payload.stats })
              setNotice(translate('button.clearCache'))
              setTimeout(() => setNotice(''), 1500)
            })
            .catch((reason) => setError(String(reason && reason.message ? reason.message : reason)))
        }

        // [PATCH 2026-10-05 ollama-discover] 拉取模型列表 = 自动发现：探测本地
        // Ollama（地址 + 在线模型），点模型即填入；DSH 已注册渠道的模型同时进
        // 候选列表（datalist），手输也照旧可用。
        const fetchModels = () => {
          fetch(API.models, { cache: 'no-store' })
            .then(readJson)
            .then((payload) => {
              setModels(payload)
              setError('')
            })
            .catch((reason) => setError(String(reason && reason.message ? reason.message : reason)))
        }

        let badge = [translate('badge.off'), styles.badgeOff]
        if (error !== '') badge = [translate('badge.error'), styles.badgeErr]
        else if (state !== null) {
          badge = state.config.enabled ? [translate('badge.on'), styles.badgeOn] : [translate('badge.off'), styles.badgeOff]
        }

        const stats = state === null ? null : state.stats
        const route = state === null ? null : state.route

        const numberInput = (field) => {
          const scale = field.scale ?? 1
          const value = draft === null ? '' : String(Math.round((draft[field.key] ?? 0) / scale))
          return h(
            'div',
            { style: styles.row, key: field.key },
            h('span', { style: styles.label }, translate(field.label)),
            h('input', {
              type: 'number',
              style: styles.number,
              value,
              onChange: (event) => {
                const raw = Number(event.target.value)
                if (!Number.isFinite(raw)) return
                save({ [field.key]: Math.round(raw * scale) })
              },
            }),
            field.unit === null ? null : h('span', { style: styles.hint }, translate(field.unit)),
          )
        }

        const booleanRow = (field) =>
          h(
            'div',
            { key: field.key, style: styles.column },
            h(
              'div',
              { style: styles.row },
              h('span', { style: styles.label }, translate(field.label)),
              h('input', {
                type: 'checkbox',
                style: styles.checkbox,
                checked: draft !== null && draft[field.key] === true,
                onChange: (event) => save({ [field.key]: event.target.checked }),
              }),
            ),
            field.hint === null || field.hint === undefined
              ? null
              : h('div', { style: styles.hint }, translate(field.hint)),
          )

        // [PATCH 2026-10-02 mode-horizon] 地平线行数输入（仅自动翻译模式下显示）。
        const horizonInput = () => {
          const value = draft === null ? '' : String(draft.horizonRows ?? DEFAULT_HORIZON_ROWS)
          return h(
            'div',
            { style: styles.column },
            h(
              'div',
              { style: styles.row },
              h('span', { style: styles.label }, translate('setting.horizon')),
              h('input', {
                type: 'number',
                style: styles.number,
                value,
                onChange: (event) => {
                  const raw = Number(event.target.value)
                  if (!Number.isFinite(raw)) return
                  save({ horizonRows: Math.round(raw) })
                },
              }),
              h('span', { style: styles.hint }, translate('unit.rows')),
            ),
            h('div', { style: styles.hint }, translate('setting.horizonHint')),
          )
        }

        // [PATCH 2026-10-02 mode-horizon] 自动/手动翻译互斥选择，映射到 autoTranslate。
        const modeSection = () => {
          const isAuto = draft === null || draft.autoTranslate === true
          const radio = (checked, onSelect, label) =>
            h(
              'label',
              { style: { ...styles.row, gap: 6, cursor: 'pointer' } },
              h('input', { type: 'radio', name: 'cot-en2cn-mode', style: styles.checkbox, checked, onChange: onSelect }),
              h('span', null, label),
            )
          return h(
            'div',
            { style: styles.column },
            h(
              'div',
              { style: styles.row },
              radio(isAuto, () => save({ autoTranslate: true }), translate('setting.modeAuto')),
              radio(!isAuto, () => save({ autoTranslate: false }), translate('setting.modeManual')),
            ),
            h('div', { style: styles.hint }, translate('setting.modeHint')),
            isAuto ? horizonInput() : null,
          )
        }

        const languageOptions = state === null
          ? []
          : state.languages.map((entry) => h('option', { key: entry.id, value: entry.id }, entry.label))

        const modelListId = 'dsh-cot-en2cn-models'

        // [PATCH 2026-10-05 ollama-discover] 候选 = Ollama 在线模型 + DSH 渠道配置的模型。
        const modelOptions =
          models === null
            ? []
            : [
                ...((models.ollama && models.ollama.models) || []).map((entry) => entry.id),
                ...(models.providers ?? []).flatMap((entry) => (entry.models ?? []).map((model) => model.id)),
              ]

        return h(
          'div',
          { style: styles.panel },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, translate('status.label')),
            h('span', { style: { ...styles.badgeBase, ...badge[1] } }, badge[0]),
            notice !== '' ? h('span', { style: styles.hint }, notice) : null,
          ),
          error !== '' ? h('div', { style: styles.error }, error) : null,
          h(
            'div',
            { style: styles.card },
            h(
              'div',
              { style: styles.row },
              h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('row.route')),
              h('span', { style: styles.mono }, route === null ? '…' : route.source === 'unset' ? translate('models.unset') : `${route.provider || '—'} / ${route.model || '—'}`),
            ),
            h(
              'div',
              { style: styles.row },
              h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('row.cache')),
              h('span', null, stats === null ? '…' : `${stats.cacheSize} · hit ${stats.hits} · call ${stats.requests}`),
            ),
            stats !== null && stats.lastMs !== null
              ? h(
                  'div',
                  { style: styles.row },
                  h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('row.lastCall')),
                  h('span', null, `${stats.lastRoute ?? '—'} · ${stats.lastMs}ms`),
                )
              : null,
            stats !== null && stats.lastError !== null
              ? h(
                  'div',
                  { style: styles.row },
                  h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('row.lastError')),
                  h('span', { style: styles.error }, stats.lastError),
                )
              : null,
            state !== null && state.configPath
              ? h(
                  'div',
                  { style: styles.row },
                  h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('row.configPath')),
                  h('span', { style: styles.mono }, state.configPath),
                )
              : null,
          ),
          h('div', { style: styles.heading }, translate('heading.basic')),
          draft === null ? null : BOOLEAN_FIELDS.slice(0, 2).map(booleanRow),
          h('div', { style: styles.heading }, translate('heading.mode')),
          draft === null ? null : modeSection(),
          h('div', { style: styles.heading }, translate('heading.model')),
          h(
            'div',
            { style: styles.column },
            h(
              'div',
              { style: styles.row },
              h('span', { style: styles.label }, translate('setting.provider')),
              h('input', {
                style: { ...styles.input, flex: 1 },
                value: draft === null ? '' : draft.provider,
                placeholder: 'ollama-local / deepseek / http://127.0.0.1:11434',
                onChange: (event) => {
                  dirty.current = true
                  setDraft({ ...draft, provider: event.target.value })
                },
                onBlur: (event) => save({ provider: event.target.value }),
              }),
            ),
            h(
              'div',
              { style: styles.row },
              h('span', { style: styles.label }, translate('setting.model')),
              h('input', {
                style: { ...styles.input, flex: 1 },
                value: draft === null ? '' : draft.model,
                list: modelOptions.length === 0 ? undefined : modelListId,
                placeholder: translate('setting.modelHint'),
                onChange: (event) => {
                  dirty.current = true
                  setDraft({ ...draft, model: event.target.value })
                },
                onBlur: (event) => save({ model: event.target.value }),
              }),
            ),
            models === null
              ? null
              : h(
                  'div',
                  { style: styles.column },
                  models.ollama !== undefined && models.ollama !== null && models.ollama.found
                    ? h(
                        'div',
                        { style: styles.column },
                        h(
                          'div',
                          { style: styles.hint },
                          `${translate('models.ollamaFound')}：${models.ollama.endpoint}（${
                            models.ollama.via === 'dsh' ? translate('models.viaDsh') : translate('models.viaDirect')
                          }）· ${translate('models.pickHint')}`,
                        ),
                        h(
                          'div',
                          { style: { ...styles.row, flexWrap: 'wrap' } },
                          (models.ollama.models ?? []).map((entry) =>
                            h(
                              'button',
                              {
                                key: entry.id,
                                style: styles.button,
                                type: 'button',
                                onClick: () => save({ provider: models.ollama.provider, model: entry.id }),
                              },
                              entry.id,
                            ),
                          ),
                        ),
                      )
                    : h('div', { style: styles.hint }, translate('models.ollamaMissing')),
                ),
            modelOptions.length === 0
              ? null
              : h('datalist', { id: modelListId }, modelOptions.map((id) => h('option', { key: id, value: id }))),
            h(
              'div',
              { style: styles.row },
              h('button', { style: styles.button, type: 'button', onClick: fetchModels }, translate('button.fetchModels')),
              h(
                'button',
                { style: styles.button, type: 'button', onClick: () => save({ provider: '', model: '' }) },
                translate('button.clearRoute'),
              ),
            ),
            h('div', { style: styles.hint }, translate('setting.modelHint')),
          ),
          draft === null ? null : BOOLEAN_FIELDS.slice(2).map(booleanRow),
          h('div', { style: styles.heading }, translate('heading.advanced')),
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, translate('setting.language')),
            h(
              'select',
              {
                style: styles.input,
                value: draft === null ? 'zh-CN' : draft.targetLanguage,
                onChange: (event) => save({ targetLanguage: event.target.value }),
              },
              languageOptions,
            ),
          ),
          draft === null ? null : NUMBER_FIELDS.map(numberInput),
          h(
            'div',
            { style: styles.row },
            h('button', { style: styles.button, type: 'button', onClick: clearCache }, translate('button.clearCache')),
            h(
              'button',
              {
                style: styles.button,
                type: 'button',
                onClick: () => {
                  if (state !== null && state.defaults !== undefined) save(state.defaults)
                },
              },
              translate('button.reset'),
            ),
          ),
          h('div', { style: styles.heading }, translate('heading.test')),
          h('textarea', {
            style: styles.textarea,
            value: testInput,
            placeholder: translate('test.placeholder'),
            onChange: (event) => setTestInput(event.target.value),
          }),
          h(
            'div',
            { style: styles.row },
            h(
              'button',
              { style: styles.button, type: 'button', onClick: runTest, disabled: testing || testInput.trim() === '' },
              testing ? translate('test.running') : translate('button.test'),
            ),
          ),
          testResult === null
            ? null
            : h(
                'div',
                { style: { ...styles.result, ...(testResult.ok ? {} : styles.error) } },
                testResult.ok ? testResult.text : `${translate('test.failed')}：${testResult.text}`,
              ),
        )
      }

      function LocaleAwareSection() {
        const [, bump] = React.useReducer((count) => count + 1, 0)
        React.useEffect(() => {
          if (locale === undefined || typeof locale.subscribe !== 'function') return undefined
          return locale.subscribe(() => bump())
        }, [])
        return h(Section)
      }

      return LocaleAwareSection
    }

    // ------------------------------------------------------------------- wiring

    function apply(ctx) {
      const locale = ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('locale') : undefined

      if (locale !== undefined && typeof locale.register === 'function') {
        try {
          ctx.effect(() => {
            const disposers = [
              locale.register(LOCALE_NS, 'zh', MESSAGES.zh),
              locale.register(LOCALE_NS, 'en', MESSAGES.en),
            ]
            return () => {
              for (const dispose of disposers) dispose()
            }
          })
        } catch (error) {
          console.warn('cot-en2cn: locale registration failed', error)
        }
      }
      if (locale !== undefined && typeof locale.bind === 'function') {
        const bound = locale.bind(LOCALE_NS)
        t = (key, params) => bound(key, params)
      }

      // [PATCH 2026-10-01 session-cache] 绑定 sessions 服务取当前会话 id。**迟后
      // 解析**：服务可能在 apply 之后才挂上 ctx（session-manager 全部在事件时刻
      // 现读 ctx.X 正是这个原因）——所以每次请求现场取，绝不提前快照服务对象。
      if (ctx !== undefined) {
        sessionKeySource = () => {
          let sessions
          try {
            sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
          } catch {
            sessions = undefined
          }
          if (sessions === undefined) sessions = ctx.sessions
          // [PATCH 2026-10-02 session-cache-fix] 0.2 的 sessions.list.getSnapshot()
          // 没有 `.current`（快照形状是 { byId, ids, phase }），旧代码永远拿到
          // undefined → sessionKey 恒为空 → 译文缓存从不落盘、每次重开都重翻。
          // 当前会话 = 被 mainView 持有的那条（与官方 dsh-client-ui-session 判定一致）。
          const snap = sessions?.list?.getSnapshot?.()
          const byId = snap?.byId
          let currentId = ''
          if (byId !== null && typeof byId === 'object') {
            for (const [id, rec] of Object.entries(byId)) {
              if (rec !== null && typeof rec === 'object' && (rec.retainedBy?.mainView ?? 0) > 0) {
                currentId = id
                break
              }
            }
          }
          return currentId
        }
      }

      // The inline translator is independent of the slot system: start it even
      // when no slots service is mounted.
      try {
        startTranslator(locale)
      } catch (error) {
        console.warn('cot-en2cn: inline translator failed to start', error)
      }

      const slots = ctx !== undefined && typeof ctx.get === 'function' ? ctx.get('slots') : undefined
      if (slots === undefined) return
      const Section = createSection(t, locale)
      slots.inject('settings.section', () =>
        slots.register(
          {
            name: 'settings.section',
            id: 'cot-en2cn',
            order: 240,
            label: () => t('section'),
          },
          Section,
        ),
      )
    }

    module.exports.apply = apply
    // [PATCH 2026-10-01 session-cache] sessions 必须声明进 inject 才会挂到 ctx
    // 上（未声明时 get('sessions') 静默返回 undefined——首次部署即此坑）。
    module.exports.inject = ['slots', 'sessions']
    return module.exports
  },
})
