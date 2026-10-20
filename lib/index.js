/**
 * dsh-cot-en2cn — host half.
 *
 * Owns the settings document and the translation engine, and exposes them to
 * the browser half over same-origin routes:
 *
 *   GET  /dsh-cot-en2cn/state          effective config + engine counters
 *   PUT  /dsh-cot-en2cn/config         persist one settings section
 *   POST /dsh-cot-en2cn/translate      translate one thinking block
 *   GET  /dsh-cot-en2cn/providers      model routes DSH currently advertises
 *   GET  /dsh-cot-en2cn/models         models of one provider route; without
 *                                      ?provider=, Ollama auto-discovery
 *   POST /dsh-cot-en2cn/cache/clear    drop the translation cache
 *
 * The plugin never writes to the session log. The original English reasoning is
 * what the model produced and what the transcript keeps; only the browser adds
 * a Chinese reading aid next to it.
 *
 * @module dsh-cot-en2cn
 */
import { DEFAULT_CONFIG, TARGET_LANGUAGES, normalizeConfig } from './config.js'
import { createTranslationEngine } from './engine.js'
// [PATCH 2026-10-05 ollama-discover] Ollama 自动发现 + http(s) provider 直连。
import { createOllamaClient, discoverOllama } from './ollama.js'
// [PATCH 2026-10-20 builtin-bing] Bing / Google 匿名翻译（非 OpenAI 协议）。
import { createBingClient } from './anonymous.js'
import { createConfigStore, createSessionCache, sanitizeSessionKey, sessionCacheKey } from './store.js'
import { fetchBuiltinModels } from './builtin-models.js'

export const name = 'dsh-session-translator'

// `webServer` is the last service to register in the web profile, so waiting
// for it also guarantees `llm` and `agentDefaultModel` are live by then.
export const inject = ['webServer']

/**
 * Keep in sync with package.json.
 *
 * [PATCH 2026-10-20 version-drift] 这个常量停在 `0.1.0` 很久了（改名、0.2.1、
 * 0.2.1-1、0.2.1-2 都没跟），于是 `/state` 一直对面板报 0.1.0，用户排查时
 * 会以为装的是老版本。单靠"记得改"必然再漂，所以 `tools/smoke.mjs` 加了一条
 * 断言直接比对 package.json 的 version —— 以后忘改会立刻测试失败。
 */
const VERSION = '0.2.1-2'

const ROUTE_PREFIX = '/dsh-session-translator'
const ROUTES = {
  state: `${ROUTE_PREFIX}/state`,
  config: `${ROUTE_PREFIX}/config`,
  translate: `${ROUTE_PREFIX}/translate`,
  providers: `${ROUTE_PREFIX}/providers`,
  models: `${ROUTE_PREFIX}/models`,
  // [PATCH 2026-10-19 model-catalog] 对话页可选模型清单（provider + models 两层）。
  catalog: `${ROUTE_PREFIX}/catalog`,
  // [PATCH 2026-10-19 route-test] 主路由/备用路由连通性自检。
  test: `${ROUTE_PREFIX}/test`,
  cacheClear: `${ROUTE_PREFIX}/cache/clear`,
}

/**
 * [PATCH 2026-10-19 builtin-index-translate] 内置渠道。
 *
 * Index-Translate 是 B 站的免费公共翻译 API（OpenAI 兼容、无需 key），不是
 * DSH 注册的模型渠道——`llm.listProviders()` 里永远没有它。但它是本插件
 * 最合适的默认翻译后端（免费、质量好、markdown 保真），所以作为**内置渠道**
 * 硬编码在目录最前面：面板下拉里能直接选，不需要用户手填端点 URL。
 *
 * 限制（实测）：非流式 >3000 字必 504；并发 2 路 × 2000 字会挂 1 个。
 * 所以默认 `maxChunkChars` 建议 1800、`concurrency` 建议 2。
 */
// [PATCH 2026-10-20 builtin-bing] 内置渠道分两种传输：
//   · `openai`  — OpenAI 兼容端点（Index-Translate / Ollama / 任意自定义），走
//                 `createOllamaClient`，SSE 流式，看门狗按 token 判活。
//   · `bing`    — Bing 匿名翻译（edge.microsoft.com/translate/translatetext），
//                 整段返回、无 key、无流式。端点与参数与宿主自带
//                 `dsh-experimental-translator` 完全一致（2026-10-20 从 asar
//                 内核实并实测）。
//
// 匿名渠道的模型 id 是占位符：对方的协议里没有模型这个概念，但插件路由要求
// provider/model 成对非空，所以给一个固定 id。
//
// **不做 Google**：同款匿名端点（translate.googleapis.com/translate_a/single）
// 在本机实测不通——直连 fetch failed、走代理 429。列进下拉只会多一个必然失败
// 的选项。
const BUILTIN_PROVIDERS = [
  {
    id: 'https://index-translate.bilibili.com',
    name: 'Index-Translate（B站免费）',
    builtin: true,
    kind: 'openai',
    models: [
      { id: 'Index-Translate-35B-A3B', name: 'Index-Translate 35B-A3B（旗舰）' },
      { id: 'index-mt-9b', name: 'Index-Translate 9B（均衡）' },
      { id: 'index-mt-2b', name: 'Index-Translate 2B（最快）' },
    ],
  },
  {
    id: 'bing',
    name: 'Bing 翻译（匿名·免费）',
    builtin: true,
    kind: 'bing',
    models: [{ id: 'bing-translate', name: 'Bing 翻译（无需 key）' }],
  },
]

/** Provider id -> transport kind, for the facade dispatch below. */
const BUILTIN_KINDS = new Map(BUILTIN_PROVIDERS.map((entry) => [entry.id, entry.kind]))

/** A translate body carries at most one clipped reasoning block. */
const MAX_BODY_BYTES = 1024 * 1024
/** Absolute ceiling for one submitted text, before settings clamping. */
const MAX_TEXT_CHARS = 200000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

// [PATCH 2026-10-05 ollama-discover] 把发现的 Ollama 对应到已注册的 DSH 渠道：
// 先比模型名重合（渠道配置的模型与在线模型对得上就是它），再认约定俗成的
// `ollama-local`；都对不上返回 null，调用方改用端点地址直连。
function matchOllamaProvider(providers, ollama) {
  const normalize = (id) => String(id).replace(/:latest$/i, '')
  const live = new Set(ollama.models.map((entry) => normalize(entry.id)))
  for (const entry of providers) {
    const overlap = (entry.models ?? []).some((model) => live.has(normalize(model.id)))
    if (overlap) return entry.id
  }
  if (providers.some((entry) => entry.id === 'ollama-local')) return 'ollama-local'
  return null
}

// [PATCH 2026-10-01 session-cache] 从页面地址提取会话 id（前缀形态优先、裸 UUID
// 次之）。裸形态可能命中别的 UUID——由 resolveSessionDir 以真实会话文件夹把关，
// 匹配不到就不写，不会污染别的会话。
function extractSessionKey(url) {
  const text = String(url ?? '')
  const prefixed = text.match(/session-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)
  if (prefixed !== null) return prefixed[0]
  const bare = text.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/)
  return bare === null ? '' : bare[0]
}

function isLoopbackAddress(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/** Same-origin browser mutation guard, mirroring the shipped plugins. */
function isSameOriginMutation(req) {
  const host = req.headers.host
  const origin = req.headers.origin
  if (typeof host !== 'string') return false
  let hostname
  try {
    hostname = new URL(`http://${host}`).hostname
  } catch {
    return false
  }
  const loopbackHost = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  if (typeof origin === 'string' && origin !== 'null') {
    try {
      const parsed = new URL(origin)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        // A web Origin must exactly match the Host: a real cross-origin page
        // stays rejected even when it omits Sec-Fetch-Site.
        return parsed.host === host && loopbackHost
      }
      // Non-web schemes (desktop shell `app:` / `file:`) fall through below.
    } catch {
      /* unparseable Origin falls through below */
    }
  }
  // [PATCH 2026-10-01 local, revert by restoring this function] The DSH
  // desktop shell / sandboxed webviews report no Origin, or `Origin: null`,
  // and may omit Sec-Fetch-Site — the shipped check 403'd every state-changing
  // call from the app's own GUI (translate & config-save both died with
  // "只接受本机、同源"). The socket is already loopback-only here (enforced by
  // the caller), so treat the local GUI as same-origin unless the browser
  // explicitly marks the request cross-site. Cross-origin pages in the
  // browser still send `Sec-Fetch-Site: cross-site` (or a mismatched Origin)
  // and stay rejected.
  const site = req.headers['sec-fetch-site']
  return loopbackHost && site !== 'cross-site' && site !== 'same-site'
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', String(Buffer.byteLength(body)))
  res.end(body)
}

async function readJsonBody(req) {
  req.setEncoding('utf8')
  let text = ''
  for await (const chunk of req) {
    text += chunk
    if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new Error('请求体过大（超过 1 MiB）')
  }
  if (text.length === 0) throw new Error('请求体不能为空')
  const value = JSON.parse(text)
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('请求体必须是 JSON 对象')
  return value
}

export async function apply(ctx) {
  const webServer = ctx.get('webServer')

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`session-translator: ${message}`)
    } catch {
      /* logger is optional */
    }
  }
  const info = (message) => {
    try {
      ctx.logger?.info?.(`session-translator: ${message}`)
    } catch {
      /* logger is optional */
    }
  }

  // ------------------------------------------------------------------ settings

  const store = createConfigStore()
  // [PATCH 2026-10-01 session-cache] 译文缓存随会话文件夹存删（见 store.js）。
  const sessionCache = createSessionCache()
  // 面包屑：最近一次请求的会话归属（GET /state 可读，排障用）。
  const sessionCacheDebug = { lastKey: '', lastResolved: '' }
  const loaded = store.load()
  let config = loaded.config
  if (loaded.source === 'file') info(`settings loaded from ${store.path}`)
  else if (loaded.source === 'invalid') {
    warn(`settings file unusable (${loaded.error ?? 'unknown'}); falling back to defaults`)
  }

  // -------------------------------------------------------------------- engine

  /**
   * Resolve the route one translation call uses: the explicit provider/model
   * pair from settings.
   *
   * [PATCH 2026-10-05 no-default-fallback] An empty pair is an explicit
   * failure. Translation must never silently fall back to the agent default
   * model — that route may be a paid API, and a quiet fallback both spends
   * money and hides a missing setting. The caller reports the reason next to
   * the thinking block instead.
   */
  function currentRoute() {
    if (config.provider !== '' && config.model !== '') {
      return { provider: config.provider, model: config.model, source: 'override' }
    }
    throw new Error(
      '翻译模型未设置：请在 设置 → 插件 →「dsh-session-translator」里选择 Provider 和模型（留空即不翻译，不会自动使用付费默认模型）',
    )
  }

  // [PATCH 2026-10-05 ollama-discover] provider 是 http(s) 端点时直连该 Ollama
  // （OpenAI 兼容 /v1），本地模型零配置可用、不依赖 DSH provider 注册；其余
  // provider 走 DSH 模型渠道，行为与原先完全一致。
  //
  // [PATCH 2026-10-20 builtin-bing] 再加一条：内置的 `bing` 匿名渠道不是 OpenAI
  // 协议，单独分派到 anonymous.js 的客户端。它和端点直连一样「不是 DSH 渠道」，
  // 所以同样在 llm 服务不可用时照常工作。
  const llmFacade = {
    stream(request) {
      const provider = String(request?.provider ?? '')
      const kind = BUILTIN_KINDS.get(provider)
      // 目标语言随请求下发：匿名接口的 language tag 映射要用它。引擎已经带了
      // `targetLanguage`，这里只做兜底（旧调用方/测试可能不带）。
      const routed = { ...request, targetLanguage: request?.targetLanguage ?? config.targetLanguage }
      if (kind === 'bing') return createBingClient().stream(routed)
      if (/^https?:\/\//i.test(provider)) return createOllamaClient(provider).stream(request)
      const llm = ctx.get('llm')
      if (llm === undefined || typeof llm.stream !== 'function') {
        throw new Error('LLM 服务不可用：请确认 DSH 已配置可用的模型提供方')
      }
      return llm.stream(request)
    },
  }

  const engine = createTranslationEngine({
    getConfig: () => config,
    getLlm: () => llmFacade,
    getRoute: currentRoute,
    log: (level, message) => {
      if (level === 'warn') warn(message)
      else info(message)
    },
  })

  function statePayload() {
    let route
    if (config.provider === '' || config.model === '') {
      // [PATCH 2026-10-05 no-default-fallback] 空路由是显式状态（unset），不是故障。
      route = { provider: config.provider, model: config.model, source: 'unset' }
    } else {
      try {
        route = currentRoute()
      } catch (error) {
        route = { provider: '', model: '', source: 'unavailable', error: errorMessage(error) }
      }
    }
    // [PATCH 2026-10-19 fallback-route] 面板要能看到备用路由是否真的生效，
    // 否则用户以为配了兜底，实际 provider/model 空着一条都没用上。
    let fallback = null
    if (config.fallbackProvider !== '' && config.fallbackModel !== '') {
      fallback = {
        provider: config.fallbackProvider,
        model: config.fallbackModel,
        idleMs: config.fallbackIdleMs,
        // [PATCH 2026-10-19 fallback-chunk] 0 表示跟随主路由；面板据此显示"继承"。
        chunkChars: config.fallbackChunkChars,
      }
    }
    return {
      ok: true,
      version: VERSION,
      config,
      defaults: DEFAULT_CONFIG,
      configPath: store.path,
      configSource: loaded.source,
      route,
      fallback,
      // [PATCH 2026-10-19 live-local-only] 告知面板「流式翻译被服务端降级了」，
      // 避免用户以为勾了却悄悄不生效（UI 锁之外的第二道说明）。
      liveDowngraded: config.liveDowngraded === true,
      stats: engine.state(),
      sessionCache: sessionCacheDebug,
      languages: TARGET_LANGUAGES,
    }
  }

  // -------------------------------------------------------------------- routes

  function route(path, handler) {
    if (webServer === undefined) return
    ctx.effect(() => {
      try {
        return webServer.register({ kind: 'exact', path, handler })
      } catch (error) {
        warn(`route register failed (${path}): ${errorMessage(error)}`)
        return () => {}
      }
    }, `dsh-session-translator: ${path}`)
  }

  /** Reject anything that is not this machine's own browser. */
  function guardLocal(req, res, method) {
    if (!isLoopbackAddress(req.socket?.remoteAddress)) {
      sendJson(res, 403, { ok: false, error: '该接口仅允许本机访问' })
      return false
    }
    if (req.method !== method) {
      res.setHeader('allow', method)
      sendJson(res, 405, { ok: false, error: `只接受 ${method}` })
      return false
    }
    return true
  }

  route(ROUTES.state, async (req, res) => {
    if (!guardLocal(req, res, 'GET')) return
    sendJson(res, 200, statePayload())
  })

  route(ROUTES.config, async (req, res) => {
    if (req.method !== 'PUT' && req.method !== 'POST') {
      res.setHeader('allow', 'PUT, POST')
      sendJson(res, 405, { ok: false, error: '只接受 PUT/POST' })
      return
    }
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !isSameOriginMutation(req)) {
      sendJson(res, 403, { ok: false, error: '配置写入需要来自本机、同源的浏览器请求' })
      return
    }
    const contentType = req.headers['content-type']
    if (typeof contentType !== 'string' || !contentType.toLowerCase().includes('application/json')) {
      sendJson(res, 415, { ok: false, error: '请用 application/json 提交配置' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const section = body.section
      if (typeof section !== 'object' || section === null || Array.isArray(section)) {
        throw new Error('缺少 section 对象')
      }
      const next = normalizeConfig({ ...config, ...section })
      store.save(next)
      config = next
      sendJson(res, 200, statePayload())
    } catch (error) {
      sendJson(res, 400, { ok: false, error: errorMessage(error) })
    }
  })

  route(ROUTES.translate, async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: '只接受 POST' })
      return
    }
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !isSameOriginMutation(req)) {
      // Loopback alone is not enough: a cross-origin page in the user's own
      // browser could otherwise trigger paid model calls it cannot even read.
      sendJson(res, 403, { ok: false, error: '翻译接口只接受本机、同源的浏览器请求' })
      return
    }
    try {
      const body = await readJsonBody(req)
      const text = body.text
      if (typeof text !== 'string') throw new Error('text 必须是字符串')
      if (text.length > MAX_TEXT_CHARS) throw new Error(`text 过长（上限 ${MAX_TEXT_CHARS} 字符）`)
      if (!config.enabled) {
        sendJson(res, 200, { ok: true, translation: text, skipped: 'disabled', chunks: 0, cached: true, ms: 0 })
        return
      }
      // [PATCH 2026-10-01 session-cache] 读穿/写穿会话级译文缓存：命中即回、不打
      // 模型；结果落进该会话自己的文件夹（会话删除随之删除）。force 跳过读取。
      // 归属三源：body.sessionKey → Referer（页面地址，旧客户端包也能归属）→ 无。
      let sessionKey = sanitizeSessionKey(body.sessionKey)
      let keySource = typeof body.sessionKey === 'string' ? body.sessionKey : '(无字段)'
      if (sessionKey === '') {
        const found = extractSessionKey(req.headers?.referer)
        if (found !== '') {
          sessionKey = sanitizeSessionKey(found)
          keySource = `referer:${found}`
        }
      }
      sessionCacheDebug.lastKey = keySource
      sessionCacheDebug.lastResolved = sessionKey === '' ? '' : sessionCache.file(sessionKey) ?? ''
      const activeRoute = currentRoute()
      const cacheKey = sessionCacheKey(activeRoute.provider, activeRoute.model, config.targetLanguage, text)
      if (sessionKey !== '' && body.force !== true) {
        const hit = sessionCache.get(sessionKey, cacheKey)
        if (hit !== undefined) {
          sendJson(res, 200, { ok: true, ...hit })
          return
        }
      }
      // [PATCH 2026-10-19 manual-save] 试译同样接受草稿覆盖：面板上改了模型
      // 还没点保存就试译，测的应该是改后的配置。覆盖只活一次请求，不写盘。
      const draftConfig = body.config !== undefined && typeof body.config === 'object' && body.config !== null
        ? normalizeConfig(body.config)
        : null
      const result = draftConfig === null
        ? await engine.translate(text, { force: body.force === true })
        : await createTranslationEngine({
            getConfig: () => draftConfig,
            getLlm: () => llmFacade,
            getRoute: () => {
              if (draftConfig.provider === '' || draftConfig.model === '') throw new Error('翻译模型未设置')
              return { provider: draftConfig.provider, model: draftConfig.model, source: 'override' }
            },
            log: () => {},
          }).translate(text, { force: true })
      if (sessionKey !== '' && draftConfig === null) sessionCache.put(sessionKey, cacheKey, result)
      sendJson(res, 200, result)
    } catch (error) {
      // Model and route failures are reported in-band so the panel can render
      // the reason next to the block that failed.
      sendJson(res, 502, { ok: false, error: errorMessage(error), stats: engine.state() })
    }
  })

  // [PATCH 2026-10-19 route-test] 状态卡片上的两个「测试」按钮：分别验证主路由
  // 和备用路由能不能真的翻一句话。刻意**不写缓存**——测试的意义是打一次真实
  // 请求看结果，缓存命中会让人误以为"通了"。
  route(ROUTES.test, async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: '只接受 POST' })
      return
    }
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !isSameOriginMutation(req)) {
      sendJson(res, 403, { ok: false, error: '测试接口只接受本机、同源的浏览器请求' })
      return
    }
    // [PATCH 2026-10-20 test-target-scope] target 必须在 try **外面**声明。
    // 旧实现写在 try 里、却在 catch 里读，于是"主路由测试失败"这条路径本身抛
    // ReferenceError（target is not defined），被 webServer 兜成 HTTP 400 +
    // 空 body —— 面板拿到的是一个没有任何原因的空响应，用户只看到测试按钮
    // 转一圈什么也没说。成功路径读不到 catch，所以只有"失败时"才暴露。
    let target = 'primary'
    try {
      const body = await readJsonBody(req)
      target = body.target === 'fallback' ? 'fallback' : 'primary'
      // [PATCH 2026-10-19 manual-save] 面板改成"编辑草稿 + 手动保存"后，用户
      // 很可能改完还没点保存就来测。测试要测**草稿**而不是磁盘上的旧值，否则
      // 会出现"改了没生效"的错觉。这里接受一份可选覆盖，只在本次测试生效，
      // 绝不写盘。
      const effective = body.config !== undefined && typeof body.config === 'object' && body.config !== null
        ? normalizeConfig(body.config)
        : config
      let route
      if (target === 'fallback') {
        if (effective.fallbackProvider === '' || effective.fallbackModel === '') {
          sendJson(res, 200, { ok: false, target, error: '备用路由未设置' })
          return
        }
        route = { provider: effective.fallbackProvider, model: effective.fallbackModel, source: 'fallback' }
      } else {
        if (effective.provider === '' || effective.model === '') {
          sendJson(res, 200, { ok: false, target, error: '翻译模型未设置' })
          return
        }
        route = { provider: effective.provider, model: effective.model, source: 'override' }
      }
      // [PATCH 2026-10-20 test-sample-friendly] 固定样本：一句读起来像人话的英文，
      // 让面板上那行结果读起来像自检报告，而不是一句莫名的报错。
      //
      // 为什么是**英文**而不是中文：引擎默认开 skipMostlyChinese（见 engine.js 的
      // translate()），中文样本会被判"已是中文"直接跳过——返回的是原文、耗时 0ms、
      // 模型一次都没被调用。那种"测试通过"是假的。发英文样本才真的会跑一遍模型。
      // 判定阈值在 text.js 的 looksChinese()（latin<=16 或 cjk>=latin*6），
      // 中英混杂的样本是否触发取决于字符比例，属于不可控变量，所以不用中文。
      //
      // 标识符 `harness-dsh-session-translator` 刻意原样保留（不译成中文）：
      // ① 一眼认出这行回声是哪个插件发出的；② 它是个压力点——会乱改标识符的
      // 渠道在自检里当场露馅，正好接替旧样本 dsh.profile.bundles 的职责。
      // 系统提示词第 3 条（"包名原样保留"）约束着模型不许动它。
      const EN_PROBE_SAMPLE = [
        'Hello, this is harness-dsh-session-translator.',
        'We are now testing whether the translation function is working normally.',
        'A returned latency means the route is live.',
      ].join(' ')
      const sample = typeof body.text === 'string' && body.text.trim() !== ''
        ? body.text.trim().slice(0, 500)
        : EN_PROBE_SAMPLE
      const startedAt = Date.now()
      // [PATCH 2026-10-20 test-target] 自检**只测这一条**，不借备用路由兜底：
      // 否则"主路由挂了但备用通了"会被报成「主路由测试通过」，自检就失去意义。
      // 同理，测备用路由时也要把备用配置清掉，避免它把自己当兜底再试一次。
      const probeConfig = { ...effective, fallbackProvider: '', fallbackModel: '' }
      const probe = createTranslationEngine({
        getConfig: () => probeConfig,
        getLlm: () => llmFacade,
        getRoute: () => route,
        log: () => {},
      })
      const result = await probe.translate(sample, { force: true })
      sendJson(res, 200, {
        ok: true,
        target,
        route: { provider: route.provider, model: route.model },
        translation: result.translation,
        chunks: result.chunks,
        ms: Date.now() - startedAt,
      })
    } catch (error) {
      // [PATCH 2026-10-20 test-target] 失败时也要回报**测的是哪条**路由。
      // 旧实现把 target 写死成 'primary'，于是"测备用路由失败"会被面板标成
      // 「主路由：…」，与真正的失败来源不符。
      //
      // [PATCH 2026-10-20 test-message-honest] 自检刻意清空了备用配置（见上面
      // probeConfig），引擎于是会报「备用路由未设置（渠道与模型都为空），因此
      // 没有重试」。对用户来说这是**假话**：他明明配了 bing/bing-translate，
      // 面板上下一行还显示备用路由测试通过。这里把那段原因换掉，改成如实说明
      // "自检不启用兜底"，否则用户会去反复检查一个根本没坏的配置。
      const raw = errorMessage(error)
      const honest = raw.replace(
        /；备用路由未设置（[^）]*），因此没有重试/,
        '；自检只测这一条路由，不启用备用兜底（配置本身不受影响）',
      )
      sendJson(res, 200, { ok: false, target, error: honest })
    }
  })

  route(ROUTES.providers, async (req, res) => {
    if (!guardLocal(req, res, 'GET')) return
    const llm = ctx.get('llm')
    if (llm === undefined || typeof llm.listProviders !== 'function') {
      sendJson(res, 200, { ok: false, error: 'LLM 服务不可用', providers: [] })
      return
    }
    try {
      const providers = llm.listProviders().map((entry) => ({ id: entry.id, name: entry.name ?? entry.id }))
      sendJson(res, 200, { ok: true, providers })
    } catch (error) {
      sendJson(res, 200, { ok: false, error: errorMessage(error), providers: [] })
    }
  })

  // [PATCH 2026-10-19 model-catalog] 对话页可选模型清单：面板要把「我能选什么」
  // 原样端上来，而不是让用户手打 provider/model。这里只读 llm 服务，不发请求。
  route(ROUTES.catalog, async (req, res) => {
    if (!guardLocal(req, res, 'GET')) return
    const llm = ctx.get('llm')
    // [PATCH 2026-10-19 builtin-index-translate] 内置渠道不依赖 llm 服务：
    // 即使 DSH 没有任何注册渠道，Index-Translate 也应该能选。
    // [PATCH 2026-10-20 builtin-models-live] 但模型清单不再用写死的三个：
    // B 站随时会上下线模型（2026-10-20 实测 9B/2B 已挂，/v1/models 只剩旗舰），
    // 写死会让面板列出点不动的死模型。这里对 openai 型内置端点实时问一次
    // /v1/models，失败则回落写死清单（fetchBuiltinModels 的契约：
    // 永不抛错、永不返回空）。Bing 没有 OpenAI 兼容的 models 端点，仍是写死。
    const providers = []
    // [PATCH 2026-10-20 catalog-probe-warning] 探测失败的内置端点单独记下来，
    // 让面板能对用户说清"这份清单是旧的，而且是对岸的问题"。
    const probeFailed = []
    for (const entry of BUILTIN_PROVIDERS) {
      let models = entry.models.map((model) => ({ id: model.id, name: model.name }))
      if (entry.kind === 'openai') {
        const live = await fetchBuiltinModels(entry.id, { fallback: models })
        models = live.models
        if (!live.live) probeFailed.push(entry.id)
      }
      providers.push({ id: entry.id, name: entry.name, builtin: true, models, live: probeFailed.includes(entry.id) ? false : true })
    }
    if (llm === undefined || typeof llm.listProviders !== 'function') {
      // [PATCH 2026-10-20 catalog-probe-warning] 早退也要带 probeFailed：
      // 面板无条件读这个字段，少了它就把「探测失败」当成「没这回事」。
      sendJson(res, 200, { ok: true, providers, probeFailed })
      return
    }
    try {
      if (typeof llm.listProviders === 'function') {
        for (const entry of llm.listProviders()) {
          let models = []
          if (typeof llm.listModels === 'function') {
            try {
              models = (await llm.listModels(entry.id)).map((model) => ({ id: model.id, name: model.name ?? model.id }))
            } catch {
              models = []
            }
          }
          // 只回有模型的渠道：空渠道选不了任何东西，列出来只会让人误点。
          if (models.length === 0) continue
          providers.push({ id: entry.id, name: entry.name ?? entry.id, models })
        }
      }
    } catch (error) {
      // [PATCH 2026-10-20 catalog-keeps-builtin] 原来这里回 providers: []，
      // 于是一次 llm 抖动会把内置渠道也一起抹掉 -- 内置渠道不依赖 llm，
      // 它们本来是全好的（现在还是实时拉的，更有价值）。至少把内置那份带回去，
      // 并用 warning 说明注册渠道没读到，面板据此显示而不是静默少一批。
      sendJson(res, 200, { ok: true, providers, probeFailed, warning: errorMessage(error) })
      return
    }
    // [PATCH 2026-10-20 catalog-probe-warning] 主路径也要带 probeFailed。
    // 早退分支和 catch 分支都带了，唯独正常返回这条漏了 —— 面板于是只在外网
    // 异常时才看得到「探测失败」，正常路径永远看不到，等于白做。
    sendJson(res, 200, { ok: true, providers, probeFailed })
  })

  route(ROUTES.models, async (req, res) => {
    if (!guardLocal(req, res, 'GET')) return
    const llm = ctx.get('llm')
    let provider = ''
    try {
      provider = new URL(req.url ?? '/', 'http://localhost').searchParams.get('provider') ?? ''
    } catch {
      provider = ''
    }
    // 兼容旧客户端：?provider=xxx 仍只回该渠道配置的模型清单。
    if (provider !== '') {
      if (llm === undefined || typeof llm.listModels !== 'function') {
        sendJson(res, 200, { ok: false, error: 'LLM 服务不可用', models: [] })
        return
      }
      try {
        const models = await llm.listModels(provider)
        sendJson(res, 200, { ok: true, models: models.map((entry) => ({ id: entry.id, name: entry.name ?? entry.id })) })
      } catch (error) {
        sendJson(res, 200, { ok: false, error: errorMessage(error), models: [] })
      }
      return
    }
    // [PATCH 2026-10-05 ollama-discover] 无 provider 参数 = 自动发现：探测
    // Ollama（地址 + 在线模型），并附上 DSH 已注册渠道的模型清单。
    const providers = []
    if (llm !== undefined && typeof llm.listProviders === 'function') {
      for (const entry of llm.listProviders()) {
        let models = []
        if (typeof llm.listModels === 'function') {
          try {
            models = (await llm.listModels(entry.id)).map((model) => ({ id: model.id, name: model.name ?? model.id }))
          } catch {
            models = []
          }
        }
        providers.push({ id: entry.id, name: entry.name ?? entry.id, models })
      }
    }
    let ollama
    try {
      ollama = await discoverOllama()
    } catch (error) {
      ollama = { found: false, endpoint: '', models: [], probed: [], error: errorMessage(error) }
    }
    const mapped = ollama.found ? matchOllamaProvider(providers, ollama) : null
    sendJson(res, 200, {
      ok: true,
      ollama: {
        found: ollama.found,
        endpoint: ollama.endpoint,
        probed: ollama.probed,
        models: ollama.models,
        // 面板点选模型时写入 provider 的值：能对上已注册 DSH 渠道就走渠道
        // （配置/缓存连续），对不上就填端点地址直连，永远可用。
        provider: mapped ?? ollama.endpoint,
        via: mapped === null ? 'direct' : 'dsh',
      },
      providers,
    })
  })

  route(ROUTES.cacheClear, async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: '只接受 POST' })
      return
    }
    if (!isLoopbackAddress(req.socket?.remoteAddress) || !isSameOriginMutation(req)) {
      sendJson(res, 403, { ok: false, error: '仅允许本机同源请求' })
      return
    }
    const cleared = engine.clearCache()
    sendJson(res, 200, { ok: true, cleared, stats: engine.state() })
  })

  if (webServer === undefined) warn('webServer service missing; routes NOT registered')
  else info(`ready (routes under ${ROUTE_PREFIX})`)
}

export { DEFAULT_CONFIG }
