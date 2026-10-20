/**
 * dsh-session-translator - live model list for built-in OpenAI-compatible
 * endpoints (B站 Index-Translate).
 *
 * [PATCH 2026-10-20 builtin-models-live] 内置端点的模型清单曾经是 BUILTIN_PROVIDERS
 * 里写死的三个 id。B 站在 2026-10-20 实测把 index-mt-9b 与 index-mt-2b 打挂了
 * （非流式 500 Internal Server Error；流式是**假 200** -- 状态码 200 但 body 只有
 * 一帧 {"error":"上游连接中断: ConnectError"}）。写死的列表不会跟着对岸变化，
 * 于是面板照旧列出两个死模型，用户选中后译文走不通、又被备用路由静静接走，
 * 界面上只看到一句「翻译卡死」，没人能定位到是模型没了。
 *
 * 这里改成**实时拉取**：命中 GET <endpoint>/v1/models 的 data[].id，
 * 与 DSH 已注册渠道走 llm.listModels() 是同一条思路，只是内置端点没有
 * 注册进 llm 服务，只能自己问。
 *
 * 三条硬约束：
 *   1. **永远不抛错、永远不返回空。** 拉取失败（DNS / 5xx / 超时 / 非 JSON）
 *      一律回落到写死的兜底清单 -- 面板下拉不能因为一次网络抖动就空掉，
 *      那比列出过期模型更糟（用户连选都没得选）。
 *   2. **带 TTL 缓存**（默认 5 分钟）。/catalog 每次进面板都会调，
 *      不缓存等于每次进设置都打一次 B 站。缓存寿命远小于用户改配置的间隔，
 *      又不至于把对面一次短暂抖动长时间记住。
 *   3. fetch 可注入**仅为离线测试**，生产走全局 fetch。与
 *      anonymous.js / ollama.js 一致的注入约定。
 *
 * 实测（2026-10-20，走系统代理）：/v1/models 三次全 200（223/56/60ms），
 * 稳定返回 ["Index-Translate-35B-A3B"]；不存在的主机抛 ENOTFOUND，
 * 错误路径返 404 -- 三类失败都能被 catch 干净兜住。
 *
 * @module dsh-session-translator/builtin-models
 */

/** 拉取失败时兜底的写死清单（历史三个模型，含已下线的）。 */
const FALLBACK_MODELS = Object.freeze([
  { id: 'Index-Translate-35B-A3B', name: 'Index-Translate 35B-A3B（旗舰）' },
  { id: 'index-mt-9b', name: 'Index-Translate 9B（均衡）' },
  { id: 'index-mt-2b', name: 'Index-Translate 2B（最快）' },
])

/** 单个端点的模型清单缓存寿命。 */
const DEFAULT_TTL_MS = 5 * 60 * 1000

/** 单次拉取超时：进面板的路径上等着，不能拖太久。 */
const DEFAULT_TIMEOUT_MS = 8000

/** endpoint -> { at, models, live }。进程内共享，重启即失效。 */
const cache = new Map()

/** True when the string is an http(s) URL. */
function isHttpUrl(raw) {
  return raw.startsWith('http://') || raw.startsWith('https://')
}

/** Drop trailing slashes without a regex (keeps this file backslash-free). */
function stripTrailingSlash(base) {
  let out = base
  while (out.endsWith('/')) out = out.slice(0, -1)
  return out
}

/**
 * Ask one OpenAI-compatible endpoint which models it currently serves.
 *
 * @param endpoint - base URL, e.g. https://index-translate.bilibili.com
 * @param options - fetchImpl (tests only), timeoutMs, ttlMs, now, fallback
 * @returns { live, models } -- live is false when the list is a fallback
 */
export async function fetchBuiltinModels(endpoint, options = {}) {
  const raw = String(endpoint ?? '')
  const fallback = options.fallback ?? FALLBACK_MODELS
  if (!isHttpUrl(raw)) return { live: false, models: fallback.slice() }
  const base = stripTrailingSlash(raw)
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const cached = cache.get(base)
  if (cached !== undefined && now - cached.at < ttlMs) {
    return { live: cached.live, models: cached.models.slice() }
  }
  const models = await requestModels(base, options)
  const live = models !== null
  const resolved = live ? models : fallback.slice()
  cache.set(base, { at: now, live, models: resolved.slice() })
  return { live, models: resolved.slice() }
}

/** One HTTP round trip; null when anything goes wrong. */
async function requestModels(base, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return null
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller === null ? null : setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(base + '/v1/models', {
      headers: { accept: 'application/json' },
      signal: controller?.signal,
    })
    if (res.status !== 200) return null
    const payload = await res.json()
    const rows = Array.isArray(payload?.data) ? payload.data : []
    const seen = new Set()
    const out = []
    for (const row of rows) {
      const id = typeof row?.id === 'string' ? row.id.trim() : ''
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      const name = typeof row?.name === 'string' && row.name.trim() !== '' ? row.name.trim() : id
      out.push({ id, name })
    }
    // 空 data 视为失败而不是"这个端点没有模型"：空列表让面板下拉只剩
    // 「未设置」，用户没法恢复；判成失败还能回到兜底清单。
    return out.length === 0 ? null : out
  } catch {
    return null
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** Test seam: drop every cached list. */
export function resetBuiltinModelsCache() {
  cache.clear()
}
