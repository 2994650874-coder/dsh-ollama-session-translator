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
      // [PATCH 2026-10-19 model-catalog] 对话页可选模型清单（provider + models）。
      catalog: '/dsh-cot-en2cn/catalog',
      // [PATCH 2026-10-19 route-test] 主路由/备用路由连通性自检。
      test: '/dsh-cot-en2cn/test',
      state: '/dsh-cot-en2cn/state',
      config: '/dsh-cot-en2cn/config',
      translate: '/dsh-cot-en2cn/translate',
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
        'row.route': '翻译模型',
        'row.lastError': '最近一次错误',
        'setting.enabled': '启用 CoT 中文翻译',
        'setting.enabledHint': '在每段「思考」下方显示中文译文，原文不改动。',
        'setting.modeAuto': '自动翻译',
        'setting.modeManual': '手动翻译',
        'setting.modeHint': '自动：进入视野即翻译（地平线 ±N 行）；手动：不自动翻译，每段点「待翻译」。',
        'setting.horizon': '地平线行数（上下各 N 条）',
        'setting.horizonHint': '翻译当前视口内的思考，并向上/向下各多翻 N 条；数值越大预翻越多。',
        'setting.live': '思考过程中也翻译',
        'setting.liveHint': '模型还在思考时就翻译（会重复调用模型，费 token）。',
        'setting.provider': '渠道 / 服务商',
        'setting.model': '模型',
        'setting.modelHint': '留空 = 不翻译：未设置时译文面板直接提示「翻译模型未设置」，绝不自动使用付费默认模型。翻译是纯体力活，建议选便宜快的小模型。',
        'button.fetchModels': '拉取模型列表',
        'button.clearRoute': '清空（不翻译）',
        'models.ollamaFound': '发现 Ollama',
        'models.viaDsh': '走 DSH 模型渠道',
        'models.viaDirect': '直连 Ollama',
        'models.unset': '未设置（不翻译）',
        'setting.disableThinking': '关闭思考（推荐）',
        'setting.disableThinkingHint': '借用辅助请求通道，让翻译请求不产生思考 token。',
        'setting.language': '目标语言',
        'setting.chunk': '单次请求上限',
        'setting.chunkHint': '默认免费服务商存在限额（B站翻译模型为 3000 字符），如已更换，可拉高数值。',
        // [PATCH 2026-10-05 maxinput-panel] 单次输入上限露出到面板（config.js 已双登记）。
        'setting.maxInput': '单次思考的翻译上限',
        'setting.maxInputHint': '单轮思考超过这个长度时，从末尾向前找第一个完整自然段处截断，超出长度只翻译前半部分，截断处往后丢弃。',
        'setting.concurrency': '并发请求数',
        'setting.skipChinese': '跳过已是中文的思考',
        'setting.fold': '穿透式折叠翻译',
        'setting.foldHint': '官方思考保持折叠，译文面板顶替正文位置显示（进入视野即翻译）；折叠条仍可点开看原文。',
        'setting.fontSize': '译文文字大小',
        'unit.chars': '字符',
        'unit.seconds': '秒',
        'unit.entries': '条',
        'unit.px': 'px',
        'unit.rows': '条',
        // [PATCH 2026-10-19 card-layout] 卡片标题与备用路由文案。
        'group.basic': '基础',
        'group.mode': '翻译模式',
        'group.model': '翻译模型',
        'group.fallback': '备用路由',
        'group.advanced': '高级',
        'group.test': '试译',
        'setting.customEndpoint': '自定义端点',
        'setting.fallbackProvider': '备用渠道 / 服务商',
        'setting.fallbackModel': '备用模型',
        'setting.fallbackHint': '主路由失败（网关 504、卡死、超时）时自动切到这一对，成功即用。留空 = 不启用兜底。',
        'setting.fallbackChunk': '备用单次请求上限',
        'setting.fallbackChunkHint': '付费服务商通常无长度限制，拉高可减少请求次数（少付重复的系统提示词）。填 0 = 跟随主路由。',
        'setting.fallbackIdle': '静默超时',
        'setting.fallbackIdleHint': '连续这么多秒没有新 token 就判定卡死并切备用路由。0 = 关闭看门狗（只靠单次超时）。',
        'row.fallback': '备用路由',
        'row.fallbackOff': '未设置',
        'stats.fallbackRuns': '备用路由执行次数',
        'test.placeholder': '粘贴一段英文思维链，点「试译」看看效果',
        'button.test': '试译',
        'button.clearCache': '清空服务端缓存',
        'button.save': '保存',
        'button.saveHint': '把当前所有改动写盘',
        'button.saveIdle': '没有未保存的改动',
        'button.discard': '放弃改动',
        'save.saving': '保存中…',
        'save.unsaved': '有未保存的改动',
        'save.nothing': '所有改动已保存',
        'button.reset': '恢复默认',
        'save.saved': '已保存',
        'save.failed': '保存失败',
        'test.running': '翻译中…',
        'test.failed': '翻译失败',
        'panel.title': '中文译文',
        'panel.cached': '缓存',
        'panel.settling': '模型还在思考，结束后自动翻译…',
        'panel.live': '边思考边翻译…',
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
        'row.route': 'Translation model',
        'row.lastError': 'Last error',
        'setting.enabled': 'Enable CoT translation',
        'setting.enabledHint': 'Show a Chinese translation under every thinking block; the original is untouched.',
        'setting.modeAuto': 'Auto translate',
        'setting.modeManual': 'Manual translate',
        'setting.modeHint': 'Auto: translate rows as they enter view (horizon ±N rows); Manual: no auto translation, click "Translate" per block.',
        'setting.horizon': 'Horizon rows (N above & below)',
        'setting.horizonHint': 'Translate the thinking rows in view plus N rows above and below; a larger value pre-translates more.',
        'setting.live': 'Translate while streaming',
        'setting.liveHint': 'Translate while the model is still thinking (repeated calls, more tokens).',
        'setting.provider': 'Channel / provider',
        'setting.model': 'Model',
        'setting.modelHint': 'Empty = no translation: the panel shows a "model not set" error instead of silently using the paid default model. A cheap fast model is usually enough.',
        'button.fetchModels': 'Fetch models',
        'button.clearRoute': 'Clear (no translation)',
        'models.ollamaFound': 'Ollama found',
        'models.viaDsh': 'via DSH model channel',
        'models.viaDirect': 'direct connection',
        'models.unset': 'Not set (no translation)',
        'setting.disableThinking': 'Disable thinking (recommended)',
        'setting.disableThinkingHint': 'Routes the call through the auxiliary channel so it spends no reasoning tokens.',
        'setting.language': 'Target language',
        'setting.chunk': 'Max characters per request',
        'setting.chunkHint': 'The free provider has a limit (B站 translation model caps at 3000 characters). Raise this if you switched to another provider.',
        // [PATCH 2026-10-05 maxinput-panel] expose maxInputChars in the panel.
        'setting.maxInput': 'Max reasoning length per translation',
        'setting.maxInputHint': 'When one reasoning block is longer, it is clipped at the last complete paragraph; only the front part is translated and everything past the cut is dropped.',
        'setting.concurrency': 'Concurrent requests',
        'setting.skipChinese': 'Skip reasoning already in Chinese',
        'setting.fold': 'Pass-through folded translation',
        'setting.foldHint': 'Keep the official thinking row folded and let the translation panel take the body position (rows translate as they enter view); the folded strip still opens the original.',
        'setting.fontSize': 'Translation font size',
        'unit.chars': 'chars',
        'unit.seconds': 's',
        'unit.entries': 'entries',
        'unit.px': 'px',
        'unit.rows': 'rows',
        // [PATCH 2026-10-19 card-layout] Card titles and fallback copy.
        'group.basic': 'Basics',
        'group.mode': 'Translation mode',
        'group.model': 'Translation model',
        'group.fallback': 'Fallback route',
        'group.advanced': 'Advanced',
        'group.test': 'Try it',
        'setting.customEndpoint': 'Custom endpoint',
        'setting.fallbackProvider': 'Fallback channel',
        'setting.fallbackModel': 'Fallback model',
        'setting.fallbackHint': 'Used once when the primary route fails (gateway 504, stall, timeout). Empty = no fallback.',
        'setting.fallbackChunk': 'Fallback max characters per request',
        'setting.fallbackChunkHint': 'Paid providers usually have no length cap; a larger chunk means fewer requests (less repeated system prompt). 0 follows the primary route.',
        'setting.fallbackIdle': 'Silence timeout',
        'setting.fallbackIdleHint': 'Switch to the fallback after this many seconds without a new token. 0 disables the watchdog (only the request timeout applies).',
        'row.fallback': 'Fallback route',
        'row.fallbackOff': 'not set',
        'stats.fallbackRuns': 'Fallback runs',
        'test.placeholder': 'Paste an English chain of thought and press Translate',
        'button.test': 'Translate',
        'button.clearCache': 'Clear host cache',
        'button.save': 'Save',
        'button.saveHint': 'Write every pending change to disk',
        'button.saveIdle': 'No unsaved changes',
        'button.discard': 'Discard',
        'save.saving': 'Saving…',
        'save.unsaved': 'Unsaved changes',
        'save.nothing': 'All changes saved',
        'button.reset': 'Reset to defaults',
        'save.saved': 'Saved',
        'save.failed': 'Save failed',
        'test.running': 'Translating…',
        'test.failed': 'Translation failed',
        'panel.title': 'Chinese',
        'panel.cached': 'cached',
        'panel.settling': 'Still thinking — translating when it settles…',
        'panel.live': 'Translating while it thinks…',
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
        'panel.alreadyChinese': 'Already Chinese · not translated',
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
    // 面板内选中时延迟写入。同步维护 tools/select-safe-test.mjs。
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
      if (meta !== null && panel.dataset.state !== 'done') meta.textContent = ''
      panel.__sourceText = text
      const orig = panelPart(panel, 'orig')
      if (orig !== null && orig.hidden !== true && orig.textContent !== text) orig.textContent = text

      const key = hashText(text)
      if (panel.dataset.srcKey === key && panel.dataset.state !== 'idle') return panel

      const cached = clientCacheGet(key)
      if (cached !== undefined) {
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
      card: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 4 },
      // [PATCH 2026-10-19 card-layout] 模块卡片：每个设置模块一个圆角框，与
      // dsh-startup-screen 的设置页视觉一致（边框 l2 + 10px 圆角 + 12/14 内距）。
      group: { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
      // 卡片标题：小号大写字母间距，比正文更弱的颜色，视觉上退到背景里。
      groupTitle: { fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--dsw-alias-label-tertiary)', margin: 0 },
      // 卡片内的字段行：标签左、控件右，整行可点。
      field: { display: 'flex', flexDirection: 'column', gap: 5 },
      fieldLabel: { fontSize: 12, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
      // [PATCH 2026-10-19 custom-dropdown] 原生 select 已全部替换为 Dropdown 组件，
      // 不再需要 select 样式（保留注释说明去向）。
      // 小圆角「次要按钮」：用于卡片内的短动作，不与主操作抢视线。
      chip: { minHeight: 26, padding: '0 10px', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 13, background: 'transparent', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', font: 'inherit', fontSize: 12 },
      chipActive: { borderColor: 'var(--dsw-alias-state-business-primary, #3964fe)', color: 'var(--dsw-alias-state-business-primary, #3964fe)' },
      // [PATCH 2026-10-19 manual-save] 无改动时的保存按钮：降透明度而非隐藏，
      // 让用户知道"按钮在哪、现在为什么点不了"。
      buttonMuted: { opacity: 0.45, cursor: 'default' },
      // [PATCH 2026-10-19 save-bar] 保存栏：与上方卡片同宽（panel 的 flex 子项
      // 天然撑满），高度只有一行按钮；按钮靠右，状态文字靠左。
      saveBar: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 10,
        background: 'var(--dsw-alias-bg-layer-1, transparent)',
      },
      // [PATCH 2026-10-19 save-button-tone] 保存按钮刻意**不设**主色态：只在
      // "灰（无可保存）↔ 普通（有改动）"两档之间切换，保存成功后直接回灰。
      // [PATCH 2026-10-19 manual-save] "有未保存改动"标记：橙色小字，不抢视线。
      unsavedBadge: { fontSize: 11, color: 'var(--dsw-alias-state-warning-primary, #e08c00)' },
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
      // [PATCH 2026-10-19 custom-dropdown] 自绘下拉：原生 <select> 在 Electron
      // 里由系统绘制弹层，父级任何一次重渲染都会把它关掉（轮询、异步 setState
      // 都会触发），而且 DSH 全局 CSS 给 select 加了背景箭头，宽 select 上会
      // 平铺成"一整片箭头"。改成按钮 + 内联展开列表，两个问题一起消失。
      dropdownRoot: { position: 'relative', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 },
      dropdownButton: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        minHeight: 30,
        padding: '4px 10px',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-3, transparent)',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        boxSizing: 'border-box',
      },
      dropdownButtonOpen: { borderColor: 'var(--dsw-alias-state-business-primary, #3964fe)' },
      dropdownLabel: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      dropdownChevron: { flex: '0 0 auto', fontSize: 10, opacity: 0.6, lineHeight: 1 },
      dropdownMenu: {
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 260,
        overflowY: 'auto',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base, #fff))',
        padding: 4,
        gap: 2,
      },
      dropdownOption: {
        display: 'block',
        width: '100%',
        padding: '5px 8px',
        border: 'none',
        borderRadius: 4,
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        font: 'inherit',
        fontSize: 12,
        textAlign: 'left',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      },
      dropdownOptionActive: { background: 'var(--dsw-alias-interactive-bg-hover-solid, rgba(127,127,127,.16))', fontWeight: 600 },
      dropdownOptionEmpty: { opacity: 0.55, cursor: 'default' },
    }

    /**
     * [PATCH 2026-10-19 number-buffer] 数字输入框：本地缓冲，失焦或回车才提交。
     *
     * 为什么不能每次按键就 edit()：save 会发 PUT /config，响应乱序回来时后到的
     * 旧值会盖掉新值（面板"回弹"）。而且输入 "8000" 的中间态 "8" 会被
     * normalizeConfig 钳到下限，等于用户填的数字被改写。
     *
     * 提交时机：blur / Enter。Esc 放弃本次编辑。
     *
     * @param props.value - 当前生效值（真实单位，不是显示单位）。
     * @param props.factor - 显示单位换算（如秒 → 毫秒传 1000）。
     * @param props.onCommit - 提交回调，参数是换算回真实单位的整数。
     */
    function NumberInput(props) {
      const factor = props.factor ?? 1
      const toText = (value) => String(Math.round((value ?? 0) / factor))
      const [buffer, setBuffer] = React.useState(null)
      // [PATCH 2026-10-19 number-buffer] 已提交但还没回显的值：save 是异步的，
      // 清空 buffer 会先显示旧值（视觉上又像"回弹"）。等 props.value 追上再清。
      const [pending, setPending] = React.useState(null)
      const effective = pending !== null && Math.round((props.value ?? 0)) === pending ? null : pending
      const shown = buffer !== null ? buffer : effective !== null ? toText(effective) : toText(props.value)
      const commit = () => {
        if (buffer === null) return
        const raw = Number(buffer)
        setBuffer(null)
        if (!Number.isFinite(raw)) return
        const next = Math.round(raw * factor)
        if (next === Math.round((props.value ?? 0))) return
        setPending(next)
        props.onCommit(next)
      }
      return h('input', {
        type: 'number',
        style: styles.number,
        value: shown,
        onChange: (event) => setBuffer(event.target.value),
        onBlur: commit,
        onKeyDown: (event) => {
          // Enter 只触发 blur，由 onBlur 统一提交：否则同一闭包里 buffer 还是
          // 旧值，blur 的 commit 和这里的 commit 会各发一次 PUT。
          if (event.key === 'Enter') {
            event.currentTarget?.blur?.()
          } else if (event.key === 'Escape') {
            setBuffer(null)
          }
        },
      })
    }

    /**
     * [PATCH 2026-10-19 custom-dropdown] 自绘下拉。
     *
     * 为什么不用原生 <select>：
     *   1. Electron 里原生弹层由系统绘制，父级任何重渲染（5 秒轮询、异步
     *      setState）都会把它关掉——"一拉就弹回去"就是这个。
     *   2. DSH 全局 CSS 给 select 配了 background-image 箭头，宽 select 上
     *      箭头会平铺成"一整片蓝色箭头"。
     *
     * @param props.label - 字段名。
     * @param props.value - 当前值。
     * @param props.options - [{ id, label }]，id 为空串表示"未设置"。
     * @param props.onChange - 选中回调。
     * @param props.placeholder - 无选项时的提示文案。
     */
    function Dropdown(props) {
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      // [PATCH 2026-10-19 custom-dropdown] 点面板外任意位置收起。用 document 级
      // 监听而不是依赖父级重渲染——父级重渲染恰恰是原生 select 弹层被关掉的原因，
      // 自绘下拉要反过来：只有用户主动点别处才收。
      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (event) => {
          const root = rootRef.current
          if (root !== null && typeof root.contains === 'function' && root.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => document.removeEventListener('mousedown', onDown, true)
      }, [open])
      const current = props.value == null ? '' : String(props.value)
      const options = Array.isArray(props.options) ? props.options : []
      const selected = options.find((entry) => entry.id === current)
      const label = selected === undefined ? (current === '' ? props.emptyLabel ?? '' : current) : selected.label
      return h(
        'div',
        { style: styles.dropdownRoot, ref: rootRef },
        h(
          'button',
          {
            type: 'button',
            style: { ...styles.dropdownButton, ...(open ? styles.dropdownButtonOpen : {}) },
            onClick: () => setOpen((value) => !value),
          },
          h('span', { style: styles.dropdownLabel }, label === '' ? (props.placeholder ?? '—') : label),
          h('span', { style: styles.dropdownChevron }, open ? '▲' : '▼'),
        ),
        open
          ? h(
              'div',
              { style: styles.dropdownMenu },
              options.length === 0
                ? h('span', { style: { ...styles.dropdownOption, ...styles.dropdownOptionEmpty } }, props.placeholder ?? '—')
                : options.map((entry) =>
                    h(
                      'button',
                      {
                        type: 'button',
                        key: entry.id === '' ? '__empty__' : entry.id,
                        style: { ...styles.dropdownOption, ...(entry.id === current ? styles.dropdownOptionActive : {}) },
                        onClick: () => {
                          setOpen(false)
                          props.onChange(entry.id)
                        },
                      },
                      entry.label,
                    ),
                  ),
            )
          : null,
      )
    }

    // [PATCH 2026-10-19 advanced-tighten] 面板只保留真正需要用户调的旋钮。
    // 移除的两项及其理由：
    //   · timeoutMs（单次超时）——被「备用路由的静默看门狗」取代：总超时会误杀
    //     慢但健康的请求（实测有 27s、36s 的正常响应），看门狗只看"多久没新 token"。
    //   · cacheEntries（服务端缓存条数）——译文已直接注入会话文件夹，服务端
    //     LRU 退化成同一次会话内的去重缓存，用户没必要关心它多大。
    // 两者仍存在于 config（引擎内部仍在用），只是不再暴露到面板。
    const NUMBER_FIELDS = [
      { key: 'maxChunkChars', label: 'setting.chunk', unit: 'unit.chars' },
      // [PATCH 2026-10-05 maxinput-panel] 单次输入上限：翻译一个思考块时的总字符闸
      // （超出截断并提示）；分块大小由 maxChunkChars 控制，两者独立。
      { key: 'maxInputChars', label: 'setting.maxInput', unit: 'unit.chars', hint: 'setting.maxInputHint' },
      { key: 'concurrency', label: 'setting.concurrency', unit: 'unit.entries' },
      { key: 'fontSizePx', label: 'setting.fontSize', unit: 'unit.px' },
    ]

    /** [PATCH 2026-10-19 advanced-tighten] 高级卡片第一行：目标语言 + 单块字符数。 */
    const ADVANCED_NUMBER_FIELDS = [
      { key: 'maxChunkChars', label: 'setting.chunk', unit: 'unit.chars' },
      { key: 'maxInputChars', label: 'setting.maxInput', unit: 'unit.chars', hint: 'setting.maxInputHint' },
      { key: 'concurrency', label: 'setting.concurrency', unit: 'unit.entries' },
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
        // [PATCH 2026-10-19 manual-save] 保存中（防重复点击）。
        const [saving, setSaving] = React.useState(false)
        const [models, setModels] = React.useState(null)
        // [PATCH 2026-10-19 route-test] 状态卡片上的两个测试按钮各自独立：
        // testingRoute 记住正在测哪一条，routeTestResult 记住最后一次结果。
        const panelRef = React.useRef(null)
        const [testingRoute, setTestingRoute] = React.useState(null)
        const [routeTestResult, setRouteTestResult] = React.useState(null)
        // Text fields edit a local draft; the 5s status poll must not clobber
        // half-typed provider/model values.
        //
        // [PATCH 2026-10-19 manual-save] dirty 既要用 ref（同步读写，供 apply()
        // 判断是否覆盖草稿）又要用 state（驱动"保存"按钮的可用态），所以两份
        // 一起维护：markDirty() 统一入口。
        const dirty = React.useRef(false)
        const [dirtyFlag, setDirtyFlag] = React.useState(false)
        const markDirty = (value) => {
          dirty.current = value
          setDirtyFlag(value)
        }

        // [PATCH 2026-10-19 poll-freeze] 下拉一拉就回收的根因：5 秒轮询拿回新对象
        // 就 setState，React 重建整棵树 → <select> 节点被换掉 → 原生弹层关闭。
        // 两道防线：① 内容没变就不 setState（省掉 99% 的无谓重渲染）；
        // ② 下拉/输入框持有焦点期间整个轮询暂停（原生弹层开着时绝不重渲染）。
        const lastPayload = React.useRef('')
        const interacting = React.useRef(false)

        const apply = React.useCallback((payload) => {
          // 用 JSON 比内容：state 里没有函数/循环引用，序列化是安全的。
          let signature
          try {
            signature = JSON.stringify(payload)
          } catch {
            signature = ''
          }
          if (signature !== '' && signature === lastPayload.current) return
          lastPayload.current = signature
          setState(payload)
          // [PATCH 2026-10-19 manual-save] 草稿有未保存改动时绝不用服务端值覆盖它，
          // 否则轮询会把用户正在编辑的内容抹掉。保存成功后由 saveAll 主动清脏。
          if (!dirty.current) setDraft(payload.config)
        }, [])

        const refresh = React.useCallback(() => {
          // 用户正在操作表单时不要打断。
          if (interacting.current) return
          fetchState()
            .then((payload) => {
              apply(payload)
              setError('')
            })
            .catch((reason) => setError(String(reason && reason.message ? reason.message : reason)))
        }, [apply])

        // [PATCH 2026-10-19 save-button-tone] Ctrl+S 保存：有改动时直接写盘，
        // 没有改动时不做任何事（不弹提示，避免噪音）。
        React.useEffect(() => {
          const onKey = (event) => {
            if (!(event.ctrlKey || event.metaKey) || event.key !== 's') return
            if (!dirty.current) return
            event.preventDefault()
            saveAllRef.current?.()
          }
          document.addEventListener('keydown', onKey)
          return () => document.removeEventListener('keydown', onKey)
        }, [])

        React.useEffect(() => {
          refresh()
          // [PATCH 2026-10-19 model-catalog] 进面板就拉一次模型清单：下拉要有
          // 候选才有意义，不能等用户先点「拉取模型列表」。
          fetchModels()
          const timer = setInterval(refresh, 5000)
          return () => clearInterval(timer)
        }, [refresh])

        // [PATCH 2026-10-19 manual-save] 面板改成"编辑草稿 + 手动保存"。
        //
        // 旧实现每次交互（改一个勾选框、选一个下拉、敲完一个数字框）都直接
        // PUT /config，问题有三个：
        //   ① 改错了没法撤销，只能改回去；
        //   ② 多个改动之间面板会闪（每次响应都整体回写 state）；
        //   ③ 5 秒轮询与写请求互相覆盖。
        //
        // 现在 edit() 只动本地草稿并置脏；真正的写盘只有 saveAll() 一处。
        const edit = (patch) => {
          const next = { ...(draft ?? {}), ...patch }
          markDirty(true)
          setDraft(next)
        }

        /** 把当前草稿整份写盘。只有「保存」按钮、以及测试前的显式确认会调用。 */
        // [PATCH 2026-10-19 save-button-tone] Ctrl+S 的监听器挂载一次就不重挂，
        // 里面拿不到最新的 draft/saving，用 ref 转口到当前闭包。
        const saveAllRef = React.useRef(null)

        const saveAll = () => {
          if (draft === null) return
          setSaving(true)
          putJson(API.config, { section: draft })
            .then((payload) => {
              // [PATCH 2026-10-19 save-button-tone] saving 与 dirty 必须一起归零：
              // 分两次更新会渲染出"灰色按钮但写着保存中…"的中间帧。
              markDirty(false)
              setSaving(false)
              // 显式回填：apply() 有签名去重，若轮询已拉过同一份 payload 会提前
              // return，草稿就停在旧值上（用户看到"保存了但值没变"）。
              if (payload !== null && payload.config !== undefined) setDraft(payload.config)
              apply(payload)
              setNotice(translate('save.saved'))
              setError('')
              setTimeout(() => setNotice(''), 1800)
            })
            .catch((reason) => {
              setError(`${translate('save.failed')}：${reason && reason.message ? reason.message : reason}`)
              setSaving(false)
            })
        }
        saveAllRef.current = saveAll

        /** 放弃草稿，回到服务端当前值。 */
        const discardDraft = () => {
          if (state === null) return
          markDirty(false)
          setDraft(state.config)
          setNotice('')
          setError('')
        }

        const runTest = () => {
          const text = testInput.trim()
          if (text === '') return
          setTesting(true)
          setTestResult(null)
          // 试译也带草稿：改了配置还没保存就试译，测的应该是改后的配置。
          postJson(API.translate, { text, force: true, config: draft ?? undefined })
            .then((payload) => {
              setTestResult({ ok: true, text: String(payload.translation ?? ''), meta: payload })
            })
            .catch((reason) => {
              setTestResult({ ok: false, text: String(reason && reason.message ? reason.message : reason) })
            })
            .then(() => setTesting(false))
        }

        // [PATCH 2026-10-19 route-test] 单条路由连通性自检：发一句固定英文，
        // 看这一条能不能翻回来。与「试译」的区别：这里指定 target，且不走缓存。
        const runRouteTest = (target) => {
          if (testingRoute !== null) return
          setTestingRoute(target)
          setRouteTestResult(null)
          // [PATCH 2026-10-19 manual-save] 带上草稿：测的是"面板上现在这份配置"，
          // 不是磁盘上的旧值。服务端只用于本次探测，不写盘。
          postJson(API.test, { target, config: draft ?? undefined })
            .then((payload) => {
              setRouteTestResult(
                payload.ok
                  ? { ok: true, target, translation: String(payload.translation ?? ''), ms: payload.ms ?? 0 }
                  : { ok: false, target, error: String(payload.error ?? '测试失败') },
              )
            })
            .catch((reason) => {
              setRouteTestResult({ ok: false, target, error: String(reason && reason.message ? reason.message : reason) })
            })
            .then(() => setTestingRoute(null))
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
        // Ollama（地址 + 在线模型），点模型即填入。
        // [PATCH 2026-10-19 custom-dropdown] 候选不再走 datalist——下拉已改自绘，
        // 候选直接以 { id, label } 数组交给 Dropdown 组件。
        const fetchModels = () => {
          // [PATCH 2026-10-19 model-catalog] 并行拉两份：models 负责 Ollama 自动
          // 发现（旧行为不变），catalog 负责"对话页能选什么"的完整清单。
          Promise.all([
            fetch(API.models, { cache: 'no-store' }).then(readJson),
            fetch(API.catalog, { cache: 'no-store' }).then(readJson).catch(() => ({ ok: false, providers: [] })),
          ])
            .then(([modelsPayload, catalogPayload]) => {
              setModels({ ...modelsPayload, catalog: catalogPayload.ok ? catalogPayload.providers : [] })
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

        // [PATCH 2026-10-19 card-layout] 把一个模块的所有行包进圆角框。
        // 空模块（children 全是 null）不渲染框，避免留下一个空壳。
        // [PATCH 2026-10-19 flatten-children] group() 的 children 里混着 .map()
        // 返回的数组（例如「高级」卡片第一项是 BOOLEAN_FIELDS.slice(2).map(...)）。
        // 补 key 时必须先压平：直接 { ...node } spread 一个数组会变成
        // {0:...,1:...} 对象，React 渲染对象当场抛错 —— 整个设置页变空白。
        const flattenChildren = (list) => {
          const out = []
          for (const item of list) {
            if (item === null || item === undefined || item === false || item === true) continue
            if (Array.isArray(item)) {
              out.push(...flattenChildren(item))
              continue
            }
            out.push(item)
          }
          return out
        }

        const group = (titleKey, children) => {
          const kids = flattenChildren(Array.isArray(children) ? children : [children])
          if (kids.length === 0) return null
          // [PATCH 2026-10-19 dropdown-stable] 每个 child 补稳定 key：条件渲染的
          // 块（Ollama 提示）出现或消失时数组长度变化，没有 key 的兄弟节点会
          // 按位置重新配对，导致 <select> 被卸载重建、原生下拉弹层直接关闭。
          return h(
            'section',
            { style: styles.group, key: titleKey },
            h('h3', { style: styles.groupTitle }, translate(titleKey)),
            ...kids.map((node, index) =>
              node !== null && typeof node === 'object' && !Array.isArray(node) && node.key === undefined
                ? { ...node, key: `${titleKey}-${index}` }
                : node,
            ),
          )
        }

        // [PATCH 2026-10-19 model-catalog] 对话页可选模型：从 /catalog 拉到的
        // provider → models 两层结构，渲染成两个联动下拉。选渠道后模型列表
        // 只显示该渠道的模型，避免把 A 渠道的模型填到 B 渠道上。
        const catalog = models !== null && Array.isArray(models.catalog) ? models.catalog : []
        const catalogProvider = catalog.find((entry) => entry.id === (draft === null ? '' : draft.provider)) ?? null
        const catalogModels = catalogProvider === null ? [] : (catalogProvider.models ?? [])

        // [PATCH 2026-10-19 custom-endpoint] 下拉只能选已注册渠道，但本插件还
        // 支持 http(s) 端点直连（Index-Translate / Ollama / 任意 OpenAI 兼容
        // 服务）。所以留一个「自定义端点」开关，切到文本输入框，两个世界都能用。
        const isEndpointValue = (value) => /^https?:\/\//i.test(String(value ?? ''))
        const providerSelect = () => {
          const current = draft === null ? '' : (draft.provider ?? '')
          const inCatalog = catalog.some((entry) => entry.id === current)
          // 已填的是端点 URL，或填了但不在目录里 → 视为自定义模式。
          const custom = current !== '' && !inCatalog
          return h(
            'div',
            { style: styles.field },
            h(
              'div',
              { style: styles.row },
              h('label', { style: styles.fieldLabel }, translate('setting.provider')),
              h(
                'button',
                {
                  type: 'button',
                  style: { ...styles.chip, ...(custom ? styles.chipActive : {}) },
                  onClick: () => {
                    // 切到自定义：把当前值原样留在输入框里，不清空。
                    if (custom) return
                    edit({ provider: isEndpointValue(current) ? current : '', model: '' })
                  },
                },
                translate('setting.customEndpoint'),
              ),
            ),
            custom
              ? h('input', {
                  style: styles.input,
                  value: current,
                  placeholder: 'https://index-translate.bilibili.com',
                  onChange: (event) => {
                    markDirty(true)
                    setDraft({ ...draft, provider: event.target.value })
                  },
                  onBlur: (event) => edit({ provider: event.target.value }),
                })
              : h(Dropdown, {
                  key: 'cot-en2cn-provider',
                  value: current,
                  emptyLabel: translate('models.unset'),
                  placeholder: translate('models.unset'),
                  options: [
                    { id: '', label: translate('models.unset') },
                    ...catalog.map((entry) => ({ id: entry.id, label: entry.builtin === true ? `${entry.name}` : `${entry.name}（${entry.id}）` })),
                  ],
                  onChange: (value) => {
                    // 换渠道时清空模型：旧模型名在新渠道上大概率不存在。
                    edit({ provider: value, model: '' })
                  },
                }),
          )
        }

        const modelSelect = () =>
          h(
            'div',
            { style: styles.field },
            h('label', { style: styles.fieldLabel }, translate('setting.model')),
            catalogModels.length === 0
              ? h('input', {
                  style: styles.input,
                  value: draft === null ? '' : draft.model,
                  placeholder: translate('setting.modelHint'),
                  onChange: (event) => {
                    markDirty(true)
                    setDraft({ ...draft, model: event.target.value })
                  },
                  onBlur: (event) => edit({ model: event.target.value }),
                })
              : h(Dropdown, {
                  key: 'cot-en2cn-model',
                  value: draft === null ? '' : draft.model,
                  emptyLabel: translate('models.unset'),
                  placeholder: translate('models.unset'),
                  options: [
                    { id: '', label: translate('models.unset') },
                    ...catalogModels.map((model) => ({ id: model.id, label: `${model.name}（${model.id}）` })),
                    ...(draft !== null && draft.model !== '' && catalogModels.every((model) => model.id !== draft.model)
                      ? [{ id: draft.model, label: draft.model }]
                      : []),
                  ],
                  onChange: (value) => edit({ model: value }),
                }),
          )

        // [PATCH 2026-10-19 card-layout] 备用路由的一对下拉：候选与主路由同源，
        // 但允许和主路由选成一样的（引擎会在两处相同时拒绝启用兜底）。
        const fallbackProviderSelect = () => {
          const current = draft === null ? '' : (draft.fallbackProvider ?? '')
          const inCatalog = catalog.some((entry) => entry.id === current)
          const custom = current !== '' && !inCatalog
          return h(
            'div',
            { style: styles.field },
            h(
              'div',
              { style: styles.row },
              h('label', { style: styles.fieldLabel }, translate('setting.fallbackProvider')),
              h(
                'button',
                {
                  type: 'button',
                  style: { ...styles.chip, ...(custom ? styles.chipActive : {}) },
                  onClick: () => {
                    if (custom) return
                    edit({ fallbackProvider: '', fallbackModel: '' })
                  },
                },
                translate('setting.customEndpoint'),
              ),
            ),
            custom
              ? h('input', {
                  style: styles.input,
                  value: current,
                  placeholder: 'https://index-translate.bilibili.com',
                  onChange: (event) => {
                    markDirty(true)
                    setDraft({ ...draft, fallbackProvider: event.target.value })
                  },
                  onBlur: (event) => edit({ fallbackProvider: event.target.value }),
                })
              : h(Dropdown, {
                  key: 'cot-en2cn-fallback-provider',
                  value: current,
                  emptyLabel: translate('models.unset'),
                  placeholder: translate('models.unset'),
                  options: [
                    { id: '', label: translate('models.unset') },
                    ...catalog.map((entry) => ({ id: entry.id, label: entry.builtin === true ? `${entry.name}` : `${entry.name}（${entry.id}）` })),
                  ],
                  onChange: (value) => edit({ fallbackProvider: value, fallbackModel: '' }),
                }),
          )
        }

        const fallbackModelSelect = () => {
          const providerId = draft === null ? '' : (draft.fallbackProvider ?? '')
          const entry = catalog.find((row) => row.id === providerId) ?? null
          const options = entry === null ? [] : (entry.models ?? [])
          const value = draft === null ? '' : (draft.fallbackModel ?? '')
          return h(
            'div',
            { style: styles.field },
            h('label', { style: styles.fieldLabel }, translate('setting.fallbackModel')),
            options.length === 0
              ? h('input', {
                  style: styles.input,
                  value,
                  placeholder: translate('setting.modelHint'),
                  onChange: (event) => {
                    markDirty(true)
                    setDraft({ ...draft, fallbackModel: event.target.value })
                  },
                  onBlur: (event) => edit({ fallbackModel: event.target.value }),
                })
              : h(Dropdown, {
                  key: 'cot-en2cn-fallback-model',
                  value,
                  emptyLabel: translate('models.unset'),
                  placeholder: translate('models.unset'),
                  options: [
                    { id: '', label: translate('models.unset') },
                    ...options.map((model) => ({ id: model.id, label: `${model.name}（${model.id}）` })),
                    ...(value !== '' && options.every((model) => model.id !== value) ? [{ id: value, label: value }] : []),
                  ],
                  onChange: (next) => edit({ fallbackModel: next }),
                }),
          )
        }

        // [PATCH 2026-10-19 limit-rows] 一行「标签 + 数字框 + 单位」+ 下面一行说明。
        // 与 numberInput 的区别：这个把标签放在控件上方（field 纵向布局），
        // 用于"每项独占一行 + 紧跟说明"的排版。
        const numberRow = (labelKey, hintKey, fieldKey, unitKey, scale) => {
          const factor = scale ?? 1
          return h(
            'div',
            { style: styles.field, key: fieldKey + '-row' },
            h(
              'div',
              { style: styles.row },
              h('span', { style: { ...styles.label, fontWeight: 600 } }, translate(labelKey)),
              h(NumberInput, {
                value: draft === null ? 0 : (draft[fieldKey] ?? 0),
                factor,
                onCommit: (raw) => edit({ [fieldKey]: raw }),
              }),
              h('span', { style: styles.hint }, translate(unitKey)),
            ),
            hintKey === null || hintKey === undefined
              ? null
              : h('div', { style: styles.hint }, translate(hintKey)),
          )
        }

        // [PATCH 2026-10-19 advanced-tighten] numberInput 支持可选 hint：把"截断
        // 落在自然段"这类真实行为写在控件下面，而不是塞进标签括号里。
        const numberInput = (field) => {
          const scale = field.scale ?? 1
          const control = h(
            'div',
            { style: styles.row, key: field.key },
            h('span', { style: styles.label }, translate(field.label)),
            h(NumberInput, {
              value: draft === null ? 0 : (draft[field.key] ?? 0),
              factor: scale,
              onCommit: (raw) => edit({ [field.key]: raw }),
            }),
            field.unit === null ? null : h('span', { style: styles.hint }, translate(field.unit)),
          )
          if (field.hint === undefined || field.hint === null) return control
          return h(
            'div',
            { style: styles.field, key: `${field.key}-wrap` },
            control,
            h('div', { style: styles.hint }, translate(field.hint)),
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
                onChange: (event) => edit({ [field.key]: event.target.checked }),
              }),
            ),
            field.hint === null || field.hint === undefined
              ? null
              : h('div', { style: styles.hint }, translate(field.hint)),
          )

        // [PATCH 2026-10-02 mode-horizon] 地平线行数输入（仅自动翻译模式下显示）。
        const horizonInput = () => {
          return h(
            'div',
            { style: styles.column },
            h(
              'div',
              { style: styles.row },
              h('span', { style: styles.label }, translate('setting.horizon')),
              h(NumberInput, {
                value: draft === null ? DEFAULT_HORIZON_ROWS : (draft.horizonRows ?? DEFAULT_HORIZON_ROWS),
                onCommit: (raw) => edit({ horizonRows: raw }),
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
              radio(isAuto, () => edit({ autoTranslate: true }), translate('setting.modeAuto')),
              radio(!isAuto, () => edit({ autoTranslate: false }), translate('setting.modeManual')),
            ),
            h('div', { style: styles.hint }, translate('setting.modeHint')),
            isAuto ? horizonInput() : null,
          )
        }

        // [PATCH 2026-10-19 poll-freeze] 焦点进入表单 → 暂停轮询；焦点离开 → 恢复。
        // 用捕获阶段包住整棵树，不必给每个控件单独挂。
        const formGuards = {
          onFocusCapture: () => {
            interacting.current = true
          },
          onBlurCapture: () => {
            // 焦点在面板内两个控件之间移动时 blur 会先于 focus 触发，
            // 用 setTimeout(0) 让同一轮事件走完再判定。
            setTimeout(() => {
              if (typeof document === 'undefined' || !document.activeElement) {
                interacting.current = false
                return
              }
              const active = document.activeElement
              interacting.current = typeof panelRef.current?.contains === 'function' ? panelRef.current.contains(active) : false
            }, 0)
          },
        }

        return h(
          'div',
          { style: styles.panel, ref: panelRef, ...formGuards },
          h(
            'div',
            { style: styles.row },
            h('span', { style: styles.label }, translate('status.label')),
            h('span', { style: { ...styles.badgeBase, ...badge[1] } }, badge[0]),
            // [PATCH 2026-10-19 manual-save] 状态卡片显示的是"已生效"的配置，
            // 草稿改动不会反映在那里——不提示的话，改了模型看到状态卡没变
            // 会以为没生效。
            dirtyFlag ? h('span', { style: styles.unsavedBadge }, translate('save.unsaved')) : null,
            notice !== '' ? h('span', { style: styles.hint }, notice) : null,
          ),
          error !== '' ? h('div', { style: styles.error }, error) : null,
          // [PATCH 2026-10-19 status-slim] 状态卡片只留"现在用的什么、能不能用"：
          //   第 1 行 翻译模型 + 测试按钮
          //   第 2 行 备用路由 + 测试按钮
          //   第 3 行 备用路由执行次数（只在对端配了才显示）
          // 译文缓存已随"直接注入对话文件夹"失去意义；配置文件路径对使用者无用；
          // 最近一次调用/错误并入行内提示，不再单占一行。
          h(
            'div',
            { style: styles.card },
            h(
              'div',
              { style: styles.row },
              h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('row.route')),
              h('span', { style: { ...styles.mono, flex: 1 } }, route === null ? '…' : route.source === 'unset' ? translate('models.unset') : `${route.provider || '—'} / ${route.model || '—'}`),
              h(
                'button',
                {
                  type: 'button',
                  style: styles.chip,
                  disabled: testingRoute !== null,
                  onClick: () => runRouteTest('primary'),
                },
                testingRoute === 'primary' ? translate('test.running') : translate('button.test'),
              ),
            ),
            h(
              'div',
              { style: styles.row },
              h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('row.fallback')),
              h(
                'span',
                { style: { ...styles.mono, flex: 1 } },
                state !== null && state.fallback !== null && state.fallback !== undefined
                  ? `${state.fallback.provider} / ${state.fallback.model}`
                  : translate('row.fallbackOff'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  style: styles.chip,
                  disabled: testingRoute !== null || state === null || state.fallback === null || state.fallback === undefined,
                  onClick: () => runRouteTest('fallback'),
                },
                testingRoute === 'fallback' ? translate('test.running') : translate('button.test'),
              ),
            ),
            state !== null && state.fallback !== null && state.fallback !== undefined
              ? h(
                  'div',
                  { style: styles.row },
                  h('span', { style: { ...styles.label, opacity: 0.65 } }, translate('stats.fallbackRuns')),
                  h('span', null, stats === null ? '…' : String(stats.fallbacks ?? 0)),
                )
              : null,
            routeTestResult === null
              ? null
              : h(
                  'div',
                  { style: { ...styles.hint, ...(routeTestResult.ok ? {} : styles.error) } },
                  routeTestResult.ok
                    ? `${routeTestResult.target === 'fallback' ? translate('row.fallback') : translate('row.route')}：${routeTestResult.translation}（${routeTestResult.ms}ms）`
                    : `${routeTestResult.target === 'fallback' ? translate('row.fallback') : translate('row.route')}：${routeTestResult.error}`,
                ),
            stats !== null && stats.lastError !== null
              ? h('div', { style: styles.error }, `${translate('row.lastError')}：${stats.lastError}`)
              : null,
          ),
          // [PATCH 2026-10-19 card-layout] 每个模块一个圆角框，视觉上与
          // dsh-startup-screen 的设置页一致：标题在框内顶部，字段纵向排列。
          group('group.basic', draft === null ? null : BOOLEAN_FIELDS.slice(0, 2).map(booleanRow)),
          group('group.mode', draft === null ? null : modeSection()),
          group('group.model', [
            providerSelect(),
            modelSelect(),
            models !== null && models.ollama !== undefined && models.ollama !== null && models.ollama.found
              ? h(
                  'div',
                  { style: styles.field },
                  h('div', { style: styles.hint }, `${translate('models.ollamaFound')}：${models.ollama.endpoint}（${models.ollama.via === 'dsh' ? translate('models.viaDsh') : translate('models.viaDirect')}）`),
                  h(
                    'div',
                    { style: { ...styles.row, flexWrap: 'wrap' } },
                    (models.ollama.models ?? []).map((entry) =>
                      h(
                        'button',
                        {
                          key: entry.id,
                          style: styles.chip,
                          type: 'button',
                          onClick: () => edit({ provider: models.ollama.provider, model: entry.id }),
                        },
                        entry.id,
                      ),
                    ),
                  ),
                )
              : null,
            h(
              'div',
              { style: { ...styles.row, flexWrap: 'wrap' } },
              h('button', { style: styles.chip, type: 'button', onClick: fetchModels }, translate('button.fetchModels')),
              h(
                'button',
                { style: styles.chip, type: 'button', onClick: () => edit({ provider: '', model: '' }) },
                translate('button.clearRoute'),
              ),
            ),
            h('div', { style: styles.hint }, translate('setting.modelHint')),
          ]),
          group('group.fallback', [
            fallbackProviderSelect(),
            fallbackModelSelect(),
            // [PATCH 2026-10-19 fallback-chunk] 备用路由自己的请求上限：付费 API
            // 通常没有免费端点的长度限制，块拉大能减少请求次数（少付重复的
            // 系统提示词）。0 = 跟随主路由。
            draft === null
              ? null
              : h(
                  'div',
                  { style: styles.field },
                  h(
                    'div',
                    { style: styles.row },
                    h('span', { style: { ...styles.label, fontWeight: 600 } }, translate('setting.fallbackChunk')),
                    h(NumberInput, {
                      value: draft.fallbackChunkChars ?? 0,
                      onCommit: (raw) => edit({ fallbackChunkChars: raw }),
                    }),
                    h('span', { style: styles.hint }, translate('unit.chars')),
                  ),
                  h('div', { style: styles.hint }, translate('setting.fallbackChunkHint')),
                ),
            h(
              'div',
              { style: styles.row },
              h('span', { style: styles.label }, translate('setting.fallbackIdle')),
              h(NumberInput, {
                value: draft === null ? 0 : (draft.fallbackIdleMs ?? 0),
                factor: 1000,
                onCommit: (raw) => edit({ fallbackIdleMs: raw }),
              }),
              h('span', { style: styles.hint }, translate('unit.seconds')),
            ),
            h('div', { style: styles.hint }, translate('setting.fallbackIdleHint')),
            h('div', { style: styles.hint }, translate('setting.fallbackHint')),
          ]),
          // [PATCH 2026-10-19 advanced-tighten] 目标语言与数字字段并排（原来
          // select 宽度 100% 被挤成独立一行）；单次超时与服务端缓存条数已随
          // 「备用路由接管超时」「译文直接注入对话文件夹」失去意义，移除。
          // [PATCH 2026-10-19 limit-rows] 目标语言独占一行；两个上限各占一行、
          // 紧跟自己的说明；两项之间空一行。数字控件与单位并排（不换行）。
          group('group.advanced', [
            draft === null ? null : BOOLEAN_FIELDS.slice(2).map(booleanRow),
            h(
              'div',
              { style: styles.field },
              h('label', { style: styles.fieldLabel }, translate('setting.language')),
              h(Dropdown, {
                key: 'cot-en2cn-language',
                value: draft === null ? 'zh-CN' : draft.targetLanguage,
                options: (state === null ? [] : state.languages).map((entry) => ({ id: entry.id, label: entry.label })),
                onChange: (value) => edit({ targetLanguage: value }),
              }),
            ),
            draft === null ? null : numberRow('setting.chunk', 'setting.chunkHint', 'maxChunkChars', 'unit.chars', 1),
            draft === null ? null : numberRow('setting.maxInput', 'setting.maxInputHint', 'maxInputChars', 'unit.chars', 1),
            draft === null ? null : NUMBER_FIELDS.slice(2).map(numberInput),
            h(
              'div',
              { style: { ...styles.row, flexWrap: 'wrap' } },
              h('button', { style: styles.chip, type: 'button', onClick: clearCache }, translate('button.clearCache')),
              h(
                'button',
                {
                  style: styles.chip,
                  type: 'button',
                  onClick: () => {
                    if (state !== null && state.defaults !== undefined) edit(state.defaults)
                  },
                },
                translate('button.reset'),
              ),
            ),
          ]),
          group('group.test', [
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
          ]),
          // [PATCH 2026-10-19 save-bar] 保存栏：独立一条，与上面的卡片同宽、
          // 高度只占一行按钮，贴在试译卡片下面。不塞进试译卡片里——保存是
          // 整个页面的动作，不属于试译模块。
          h(
            'div',
            { style: styles.saveBar },
            dirtyFlag
              ? h('span', { style: { ...styles.unsavedBadge, flex: 1 } }, translate('save.unsaved'))
              : h('span', { style: { ...styles.hint, flex: 1 } }, translate('save.nothing')),
            h(
              'button',
              {
                // 与「保存」同款同尺寸：有改动时两个按钮都是可点的白色，
                // 没有改动时两个都灰掉。保存中保持白色但不可点（避免闪灰）。
                style: { ...styles.button, ...(dirtyFlag || saving ? null : styles.buttonMuted) },
                type: 'button',
                onClick: discardDraft,
                disabled: !dirtyFlag || saving,
              },
              translate('button.discard'),
            ),
            h(
              'button',
              {
                // [PATCH 2026-10-19 save-button-tone] 只有"灰 ↔ 普通"两档，不引入
                // 第三种颜色：有改动就恢复成和「放弃改动」同款的可点样式，保存成功
                // 后重新变灰（= 页面回到默认态）。
                // saving 期间仍算"有改动"（dirty 还没清），所以保持白色只置灰不可点，
                // 视觉序列是 白 → 白(保存中) → 灰，而不是 白 → 灰 → 灰。
                style: { ...styles.button, ...(dirtyFlag || saving ? null : styles.buttonMuted) },
                type: 'button',
                onClick: saveAll,
                disabled: !dirtyFlag || saving,
                title: dirtyFlag ? translate('button.saveHint') : translate('button.saveIdle'),
              },
              saving ? translate('save.saving') : translate('button.save'),
            ),
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
