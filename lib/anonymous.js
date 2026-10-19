/**
 * dsh-session-translator — anonymous (key-free) translation transport.
 *
 * [PATCH 2026-10-20 builtin-bing] Bing 的匿名翻译接口**不是** OpenAI 兼容协议，
 * `createOllamaClient` 那条端点直连的路走不通，所以单独一个模块：把引擎的
 * `{ system, messages, maxTokens, signal }` 请求翻译成对方的原生请求，再按
 * `llm.stream()` 的形状吐回 `text-delta` / `finish`。
 *
 * 端点与参数取自宿主自带插件 `@deepseek-ai/dsh-experimental-translator`
 * （asar 内 `lib/types/provider.js`，2026-10-20 从 asar 核实并实测可用）：
 *
 *   Bing   POST https://edge.microsoft.com/translate/translatetext?to=<tag>&isEnterpriseClient=false
 *          body: ["待翻译文本"]        → [{"translations":[{"text":"译文"}]}]
 *
 * **为什么只做 Bing、不做 Google**：同款 Google 匿名端点
 * （`translate.googleapis.com/translate_a/single`）在本机实测不通——直连
 * `fetch failed`（10s 超时），走代理返回 HTTP 429。列进下拉只会得到一个必然
 * 失败的选择，所以不做。
 *
 * 三条硬约束：
 *   1. **一次性返回整段，没有 SSE。** 引擎的静默看门狗只看「有没有新 chunk」，
 *      等待期间必须周期性吐 `{type:'heartbeat'}`（引擎只认 text-delta 和
 *      finish，其它类型直接忽略），否则大块文本会被 fallbackIdleMs 误判成卡死。
 *   2. **不发 system 提示词。** 匿名接口只有「翻译这段文本」一个语义，把插件的
 *      中文系统提示塞进去会被当正文一起翻掉。只发用户文本。
 *   3. **不带 cookie、不带凭据、不跟随重定向**（与官方实现一致，避免被当成
 *      浏览器会话或跳到登录页）。
 *
 * 已知质量边界：Bing 会把行内反引号改写成中文引号（`` `x` `` → “x”），
 * 代码块围栏也可能被改。作为兜底可接受，逐字保真的场景请用主路由。
 *
 * 依赖为零（见 package.json `dependencies`），`fetch` 可注入以便离线测试。
 *
 * @module dsh-session-translator/anonymous
 */

/** Bing 匿名翻译端点（官方 dsh-experimental-translator 的同款默认值）。 */
export const BING_ENDPOINT = 'https://edge.microsoft.com/translate/translatetext'

/** 等待期间的心跳间隔：必须明显小于引擎的 fallbackIdleMs（默认 5000ms）。 */
const DEFAULT_HEARTBEAT_MS = 1000

/**
 * Map one plugin target language id onto Bing's tag vocabulary.
 *
 * Bing 用 `zh-Hans` / `zh-Hant`，不认 `zh-CN` / `zh-TW`；其余标签原样透传。
 *
 * @param tag - target language id from settings (`zh-CN`, `zh-TW`, `en`, `ja`).
 * @returns the Bing-compatible tag.
 */
export function bingLanguageTag(tag) {
  const lower = String(tag ?? '').toLowerCase()
  if (['zh', 'zh-cn', 'zh-sg', 'zh-hans'].includes(lower)) return 'zh-Hans'
  if (['zh-tw', 'zh-hk', 'zh-mo', 'zh-hant'].includes(lower)) return 'zh-Hant'
  return String(tag ?? '')
}

/** Flatten the one user message the engine hands over into plain text. */
function userText(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : []
  for (const message of messages) {
    const content = message?.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const joined = content.map((part) => (typeof part === 'string' ? part : String(part?.text ?? ''))).join('')
      if (joined !== '') return joined
    }
    if (content !== undefined && content !== null) return String(content)
  }
  return ''
}

/** A timer that never keeps the process alive on its own. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Await one whole-response translation while keeping the engine's watchdog fed.
 *
 * @param pending - promise resolving the translated text.
 * @param signal - caller signal (aborts the wait as well as the fetch).
 * @param heartbeatMs - silence window to bridge with heartbeat chunks.
 * @returns an async generator of `heartbeat` chunks, then one `text-delta`.
 */
async function* awaitTranslation(pending, signal, heartbeatMs) {
  let settled = false
  let value
  let failure
  pending.then(
    (result) => {
      settled = true
      value = result
    },
    (error) => {
      settled = true
      failure = error
    },
  )
  while (!settled) {
    await Promise.race([pending.then(() => undefined, () => undefined), sleep(heartbeatMs)])
    if (settled) break
    if (signal?.aborted === true) throw signal.reason ?? new Error('翻译调用被中断')
    yield { type: 'heartbeat' }
  }
  if (failure !== undefined) throw failure
  yield { type: 'text-delta', text: value }
}

/** Read one JSON payload, turning a body failure into a readable message. */
async function readJson(response, label) {
  try {
    return await response.json()
  } catch (error) {
    throw new Error(`${label} 返回了无法解析的响应：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** One Bing anonymous round trip. */
async function bingTranslate(fetchImpl, endpoint, target, text, signal) {
  const url = new URL(endpoint)
  url.searchParams.set('to', bingLanguageTag(target))
  url.searchParams.set('isEnterpriseClient', 'false')
  let response
  try {
    response = await fetchImpl(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([text]),
      redirect: 'error',
      credentials: 'omit',
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true) throw error
    throw new Error(`无法连接 Bing 翻译（${url.host}）：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!response.ok) {
    let detail = ''
    try {
      detail = String(await response.text()).slice(0, 200)
    } catch {
      /* the status alone has to suffice */
    }
    throw new Error(`Bing 翻译请求失败（HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}`)
  }
  const payload = await readJson(response, 'Bing')
  const translated = Array.isArray(payload) ? payload[0]?.translations?.[0]?.text : undefined
  if (typeof translated !== 'string') throw new Error('Bing 没有返回译文内容')
  return translated
}

/**
 * Build an `llm.stream()`-shaped client for Bing's anonymous translator.
 *
 * @param options - `fetchImpl` / `endpoint` / `heartbeatMs` for tests.
 * @returns `{ stream(request) }`.
 */
export function createBingClient(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const endpoint = typeof options.endpoint === 'string' && options.endpoint !== '' ? options.endpoint : BING_ENDPOINT
  const heartbeatMs = Number.isFinite(options.heartbeatMs) ? Math.max(50, Math.floor(options.heartbeatMs)) : DEFAULT_HEARTBEAT_MS
  return {
    async *stream(request) {
      if (typeof fetchImpl !== 'function') throw new Error('Bing 翻译不可用：当前运行时没有 fetch')
      const text = userText(request)
      if (text.trim() === '') {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      const pending = bingTranslate(fetchImpl, endpoint, request?.targetLanguage ?? 'zh-CN', text, request?.signal)
      for await (const chunk of awaitTranslation(pending, request?.signal, heartbeatMs)) yield chunk
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}
