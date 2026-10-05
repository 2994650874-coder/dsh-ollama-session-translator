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
import { createConfigStore, createSessionCache, sanitizeSessionKey, sessionCacheKey } from './store.js'

export const name = 'dsh-cot-en2cn'

// `webServer` is the last service to register in the web profile, so waiting
// for it also guarantees `llm` and `agentDefaultModel` are live by then.
export const inject = ['webServer']

/** Keep in sync with package.json. */
const VERSION = '0.1.0'

const ROUTE_PREFIX = '/dsh-cot-en2cn'
const ROUTES = {
  state: `${ROUTE_PREFIX}/state`,
  config: `${ROUTE_PREFIX}/config`,
  translate: `${ROUTE_PREFIX}/translate`,
  providers: `${ROUTE_PREFIX}/providers`,
  models: `${ROUTE_PREFIX}/models`,
  cacheClear: `${ROUTE_PREFIX}/cache/clear`,
}

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
      ctx.logger?.warn?.(`cot-en2cn: ${message}`)
    } catch {
      /* logger is optional */
    }
  }
  const info = (message) => {
    try {
      ctx.logger?.info?.(`cot-en2cn: ${message}`)
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
      '翻译模型未设置：请在 设置 → 插件 →「CoT 英文转中文」里选择 Provider 和模型（留空即不翻译，不会自动使用付费默认模型）',
    )
  }

  // [PATCH 2026-10-05 ollama-discover] provider 是 http(s) 端点时直连该 Ollama
  // （OpenAI 兼容 /v1），本地模型零配置可用、不依赖 DSH provider 注册；其余
  // provider 走 DSH 模型渠道，行为与原先完全一致。
  const llmFacade = {
    stream(request) {
      const provider = String(request?.provider ?? '')
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
    return {
      ok: true,
      version: VERSION,
      config,
      defaults: DEFAULT_CONFIG,
      configPath: store.path,
      configSource: loaded.source,
      route,
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
    }, `dsh-cot-en2cn: ${path}`)
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
      const result = await engine.translate(text, { force: body.force === true })
      if (sessionKey !== '') sessionCache.put(sessionKey, cacheKey, result)
      sendJson(res, 200, result)
    } catch (error) {
      // Model and route failures are reported in-band so the panel can render
      // the reason next to the block that failed.
      sendJson(res, 502, { ok: false, error: errorMessage(error), stats: engine.state() })
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
