/**
 * dsh-cot-en2cn — host-side translation engine.
 *
 * One engine instance owns: the chunk-level LRU cache, in-flight de-duplication
 * (expanding the same thinking block twice costs one model call), the
 * concurrency gate, per-request deadlines, and the statistics the settings
 * panel shows.
 *
 * The engine never touches the session transcript: it takes text in and gives
 * a translation back. Everything the user sees changes in the browser only.
 *
 * @module dsh-cot-en2cn/engine
 */
import { createHash, randomUUID } from 'node:crypto'
import { TARGET_LANGUAGE_NAMES } from './languages.js'
import {
  chunkText,
  clipAtBoundary,
  estimateMaxTokens,
  looksChinese,
  normalizeText,
  splitTrailingSpace,
} from './text.js'

/** Attribution stamped on every message this plugin sends to a model. */
const PLUGIN_ID = 'dsh-session-translator'

/**
 * Build the translation instruction for one target language.
 *
 * The wording is deliberately strict: the model is a translator here, not an
 * assistant, and the output has to survive re-attachment to the original
 * separators, so structure preservation and "do not translate code" come first.
 *
 * @param target - target language id (`zh-CN`, `zh-TW`, `en`, `ja`).
 * @returns the system prompt.
 */
export function translationSystemPrompt(target) {
  const name = TARGET_LANGUAGE_NAMES[target] ?? '简体中文'
  return [
    '你是一个思维链（Chain of Thought）翻译引擎，不是助手，不要与用户对话。',
    `输入是一段大语言模型在推理阶段输出的文本，通常是英文，也可能夹带代码、路径、变量名或少量中文。请把它翻译成${name}。`,
    '',
    '硬性要求：',
    `1. 只输出${name}译文本身。不要前言、不要解释、不要「以下是译文」之类的话，也不要用代码块把整段译文包起来。`,
    '2. 完整保留原文结构：行数、空行、缩进、列表符号、编号、Markdown 标记（**、###、表格竖线等）都要对应。',
    '3. 以下内容原样保留、绝不翻译：代码片段、变量名/函数名/类名、文件名与路径、命令行与参数、URL、包名、API 与协议名、报错信息原文、数学公式与符号。',
    '4. 术语保持一致：chain-of-thought → 思维链，prompt → 提示词，context → 上下文，tool call → 工具调用，token 保留为 token。',
    '5. 原文里已经是中文的句子保持原样，不要改写、不要润色。',
    '6. 译文准确、简洁、像技术文档：不要扩写，不要总结，不要补充原文没有的信息。',
    '7. 如果输入本身不是一个完整句子（例如只有几个词或一个标识符），给出最短的对应译文即可。',
  ].join('\n')
}

/** Recursively freeze one message so adapters can rely on the immutable contract. */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/** One hand-built auxiliary user message, frozen before dispatch. */
export function buildUserMessage(text) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_ID },
  })
}

/** Trim a model reply down to the translation, unwrapping an accidental fence. */
export function cleanTranslation(raw) {
  let value = String(raw ?? '')
  const fenced = /^\s*```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```\s*$/.exec(value)
  if (fenced !== null) value = fenced[1]
  value = value.replace(/^(?:译文|翻译|Translation|Translated text)\s*[:：]\s*/i, '')
  return value.replace(/\s+$/, '')
}

/** Human-readable message for any thrown value. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * [PATCH 2026-10-19 thinking-off] Whether an error means "this route refuses
 * reasoningEffort", so the caller can retry without the field instead of failing.
 *
 * The DSH LLM facade raises UNSUPPORTED_REASONING_EFFORT in two shapes: a plain
 * LlmError message ("... does not support reasoning effort ..."), or a terminal
 * finish chunk carrying that code. Both are matched here.
 *
 * @param error - whatever the model call threw.
 * @returns true when retrying without reasoningEffort is the right move.
 */
function isUnsupportedReasoningEffort(error) {
  const message = errorMessage(error)
  return /UNSUPPORTED_REASONING_EFFORT/i.test(message) || /does not support reasoning effort/i.test(message)
}

/**
 * [PATCH 2026-10-19 fallback-route] Mark a watchdog abort so callers can tell
 * "the upstream went silent" apart from "the upstream returned an error".
 * Both are retryable, but only the former deserves the idle wording.
 *
 * @param idleMs - configured silence window in milliseconds.
 * @param cause - whatever the abort carried.
 * @returns an Error carrying the {@link IDLE_ERROR_CODE} marker.
 */
function idleError(idleMs, cause) {
  const error = new Error(`翻译卡死：连续 ${formatSeconds(idleMs)} 没有新 token`)
  error.code = IDLE_ERROR_CODE
  error.cause = cause
  return error
}

/** Render a millisecond window as a readable second count. */
function formatSeconds(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)}s` : `${Math.round(ms)}ms`
}

/** Marker set on watchdog aborts; see {@link idleError}. */
export const IDLE_ERROR_CODE = 'COT_EN2CN_IDLE'

/**
 * [PATCH 2026-10-19 fallback-route] Whether a failed chunk is worth retrying on
 * the fallback route.
 *
 * The rule is deliberately broad: a fallback the user configured exists to make
 * translation succeed, so anything short of the reader withdrawing interest is
 * worth one retry. Whitelisting error strings was the first attempt and it
 * missed real failures — a dead endpoint reports "无法连接 … fetch failed",
 * which matches none of the obvious keywords.
 *
 * @param error - the rejection from {@link callModel}.
 * @param callerSignal - the signal owned by the reader, if any.
 * @returns true when the fallback route should be attempted.
 */
function isFallbackWorthy(error, callerSignal) {
  // 读者收起/切换了思考块：翻译不再需要，重试只会白花钱。
  if (callerSignal !== undefined && callerSignal !== null && callerSignal.aborted) return false
  // 配置类错误换路由也救不了（没有 llm 服务、没有设置路由），重试是纯浪费。
  const text = errorMessage(error)
  if (/LLM 服务不可用|翻译模型未设置/.test(text)) return false
  return true
}

/** Join two optional abort signals into one, without requiring AbortSignal.any. */
function composeSignals(signals) {
  const list = signals.filter((signal) => signal !== undefined && signal !== null)
  if (list.length === 1) return list[0]
  const controller = new AbortController()
  const onAbort = (signal) => () => {
    controller.abort(signal.reason)
  }
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason)
      break
    }
    signal.addEventListener('abort', onAbort(signal), { once: true })
  }
  return controller.signal
}

/** The finish reasons that mean "this translation is unusable". */
function finishFailure(reason) {
  if (reason === undefined || reason === null) return null
  const kind = reason.kind
  if (kind === 'stop') return null
  if (kind === 'max-tokens') return new Error('模型输出被 max-tokens 截断（把「单块字符数」调小一点会更稳）')
  if (kind === 'tool-calls') return new Error('模型返回了工具调用而不是译文')
  if (kind === 'aborted') return new Error(`模型调用被中断：${errorMessage(reason.failure?.message ?? reason.failure ?? 'aborted')}`)
  // [PATCH 2026-10-01 local] Surface the adapter's failure payload for every
  // non-stop finish instead of a bare kind — "模型以 error 结束" hid the real
  // cause (e.g. context overflow) behind a generic line.
  const failure = reason.failure
  const detail = failure !== undefined && failure !== null
    ? errorMessage(typeof failure === 'object' ? (failure.message ?? failure) : failure)
    : ''
  return new Error(`模型以 ${String(kind)} 结束${detail ? `：${detail}` : '，而不是正常结束'}`)
}

/**
 * Create one translation engine.
 *
 * @param options - engine wiring.
 * @param options.getConfig - reads the live effective config.
 * @param options.getLlm - returns the `llm` service (or undefined).
 * @param options.getRoute - resolves `{ provider, model, source }` or throws.
 * @param options.log - optional `(level, message)` sink for diagnostics.
 * @returns the engine face used by the routes.
 */
export function createTranslationEngine(options) {
  const getConfig = options.getConfig
  const getLlm = options.getLlm
  const getRoute = options.getRoute
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = typeof options.now === 'function' ? options.now : () => Date.now()

  /** chunk key -> translated text (insertion order == LRU order). */
  const cache = new Map()
  /** chunk key -> in-flight promise. */
  const inflight = new Map()
  /** Waiting resolvers for the concurrency gate. */
  const waiters = []
  let active = 0

  /**
   * [PATCH 2026-10-19 thinking-off] 每个 渠道/模型 是否接受 reasoningEffort: 'off'。
   * 首次调用时探测：不支持就记 'unsupported'，之后不再传，避免每次翻译都白抛一次。
   * 探测失败的那一次本身也要能正常返回译文，所以是"先试后降级"而不是"先查再发"。
   */
  const thinkingSupport = new Map()

  const stats = {
    requests: 0,
    chunks: 0,
    hits: 0,
    deduped: 0,
    failures: 0,
    skipped: 0,
    translatedChars: 0,
    sourceChars: 0,
    lastError: null,
    lastMs: null,
    lastRoute: null,
    lastAt: null,
    // [PATCH 2026-10-19 fallback-route] 主路由失败、改走备用路由成功的次数。
    fallbacks: 0,
  }

  function cacheKey(route, target, core) {
    return createHash('sha1')
      .update(`${route.provider}\u0000${route.model}\u0000${target}\u0000${core}`, 'utf8')
      .digest('hex')
      .slice(0, 24)
  }

  /**
   * [PATCH 2026-10-20 fallback-reason] 主路由失败时，**必须**说清备用路由为什么
   * 没有接住。旧实现只在"备用也失败"时抛备用那条错误，另外两种情况（备用没配、
   * 备用和主路由是同一对）都只是把主路由的原始错误原样抛出去 —— 面板上看到的
   * 永远是一句「翻译卡死：连续 5s 没有新 token」，用户无从判断是"上游挂了"还是
   * "我的兜底压根没配"。
   *
   * 五种结局各自带一句原因：
   *   · 备用未配置（provider 或 model 留空）→ 明示"未配置备用路由，未重试"
   *   · 备用与主路由完全相同 → 明示"备用与主路由相同，已跳过"
   *   · 备用块更大、单块回退让位给整段重跑 → 明示"改由整段重跑"
   *   · 备用已尝试但失败 → 两条错误都带上，并注明哪条是备用
   *   · 备用成功 → 不报错（stats.fallbacks 已计数）
   *
   * @param primaryError - the failure from the primary route.
   * @param route - the primary route that failed.
   * @param fallback - the resolved fallback route, or null.
   * @param settings - the live settings snapshot (for the "why it is unset" wording).
   * @param fallbackError - the failure from the fallback attempt, if any.
   * @param deferredToBlock - true when the fallback was skipped here on purpose
   *   because a whole-block re-run will handle it instead.
   * @returns an Error whose message names both sides.
   */
  function annotateRouteFailure(primaryError, route, fallback, settings, fallbackError, deferredToBlock = false) {
    const primaryLabel = `${route.provider}/${route.model}`
    const primary = errorMessage(primaryError)
    // 整段重跑时 route 本身就是备用路由：这时候不能再说"主路由失败"，
    // 否则错误会把用户往错的方向带。
    const primaryName = route.source === 'fallback' ? '备用路由' : '主路由'
    let detail
    if (fallbackError !== undefined && fallbackError !== null) {
      detail = `${primaryName}（${primaryLabel}）失败：${primary}；备用路由（${fallback.provider}/${fallback.model}）也失败：${errorMessage(fallbackError)}`
    } else if (fallback === null) {
      const provider = typeof settings.fallbackProvider === 'string' ? settings.fallbackProvider.trim() : ''
      const model = typeof settings.fallbackModel === 'string' ? settings.fallbackModel.trim() : ''
      const why = provider === '' && model === ''
        ? '备用路由未设置（渠道与模型都为空）'
        : provider === ''
          ? '备用路由未设置（备用渠道为空）'
          : '备用路由未设置（备用模型为空）'
      detail = `${primaryName}（${primaryLabel}）失败：${primary}；${why}，因此没有重试`
    } else if (deferredToBlock) {
      // [PATCH 2026-10-20 fallback-reason-defer] 备用路由配了更大的块，单块回退
      // 主动让位给 translate() 的整段重跑。旧实现落到下面那条 else，于是报出
      // "备用路由与主路由相同（bing/bing-translate），已跳过"——主路由明明是
      // index-translate，两者根本不同。用户看到的就是一句自相矛盾的谎话。
      detail = `${primaryName}（${primaryLabel}）失败：${primary}；备用路由（${fallback.provider}/${fallback.model}）已改由整段重跑接替（备用块 ${settings.fallbackChunkChars} 字 > 主路由 ${settings.maxChunkChars} 字）`
    } else {
      detail = `${primaryName}（${primaryLabel}）失败：${primary}；备用路由与主路由相同（${fallback.provider}/${fallback.model}），已跳过`
    }
    const wrapped = new Error(detail)
    wrapped.code = 'TRANSLATOR_ROUTE_FAILED'
    wrapped.cause = primaryError
    return wrapped
  }

  /** Whether the resolved fallback is literally the primary route. */
  function sameRoute(route, fallback) {
    return fallback !== null && route.provider === fallback.provider && route.model === fallback.model
  }

  /**
   * [PATCH 2026-10-19 fallback-route] Resolve the configured fallback route, or
   * null when the pair is incomplete or identical to the primary one.
   *
   * @param config - the live settings snapshot.
   * @returns `{ provider, model, source: 'fallback' }` or null.
   */
  function fallbackRouteOf(config) {
    const provider = typeof config.fallbackProvider === 'string' ? config.fallbackProvider.trim() : ''
    const model = typeof config.fallbackModel === 'string' ? config.fallbackModel.trim() : ''
    if (provider === '' || model === '') return null
    return { provider, model, source: 'fallback' }
  }

  function remember(key, value) {
    const limit = Math.max(0, Math.floor(getConfig().cacheEntries))
    if (limit === 0) return
    cache.delete(key)
    cache.set(key, value)
    while (cache.size > limit) {
      const oldest = cache.keys().next().value
      cache.delete(oldest)
    }
  }

  function acquire() {
    const limit = Math.max(1, Math.floor(getConfig().concurrency))
    if (active < limit) {
      active += 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      waiters.push(resolve)
    })
  }

  function release() {
    const next = waiters.shift()
    if (next !== undefined) {
      // The slot transfers to the waiter: `active` stays as it is.
      next()
      return
    }
    if (active > 0) active -= 1
  }

  /** One model round trip for one chunk core. */
  async function callModel(core, config, route, callerSignal) {
    const llm = getLlm()
    if (llm === undefined || typeof llm.stream !== 'function') {
      throw new Error('LLM 服务不可用：请确认 DSH 已配置可用的模型提供方')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error(`翻译超时（${Math.round(config.timeoutMs / 1000)}s）`))
    }, config.timeoutMs)
    // [PATCH 2026-10-19 fallback-route] 静默看门狗：总超时（timeoutMs）拦不住
    // "连接正常但生成卡死"——实测上游 TTFB 只要 250ms，可总耗时能在 2.3s 与
    // 39.9s 之间抖动。真正的判据是"多久没有新 token"。每收到一个 chunk 就重置；
    // 连续 fallbackIdleMs 没有新 chunk 即判定卡死，抛 IDLE 标记供上层切备用路由。
    const idleMs = Number.isFinite(config.fallbackIdleMs) ? Math.floor(config.fallbackIdleMs) : 0
    let idleTimer
    let idledOut = false
    const bumpIdle = () => {
      if (idleMs <= 0) return
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        idledOut = true
        controller.abort(new Error(`翻译卡死：连续 ${formatSeconds(idleMs)} 没有新 token`))
      }, idleMs)
    }
    const signal = composeSignals([controller.signal, callerSignal])
    const request = {
      provider: route.provider,
      model: route.model,
      system: translationSystemPrompt(config.targetLanguage),
      messages: [buildUserMessage(core)],
      maxTokens: estimateMaxTokens(core),
      // [PATCH 2026-10-20 builtin-bing] 目标语言随请求下发。云渠道靠 system
      // prompt 承载它，但匿名翻译接口（Bing / Google）没有 system 概念，只能
      // 用语言 tag 指定目标语——所以要有一个结构化字段可读。
      targetLanguage: config.targetLanguage,
      signal,
    }
    // [PATCH 2026-10-19 thinking-off] 关闭思考 = 请求里带 reasoningEffort: 'off'。
    //
    // 旧实现设的是 purpose: 'session-title'，注释说"适配器会把它映射成关思考"——
    // 那是错的。dsh-llm-deepseek 的 serialize() 只读 options.reasoningEffort，
    // 全文件里 purpose 只影响 'compaction' 的 header。所以这个开关从来没生效过，
    // 每次翻译都在为隐藏的推理 token 付费。
    //
    // 但并非所有渠道都支持 off：有的免费模型只暴露固定 effort（不提供 reasoning
    // 元数据），传了会抛 UNSUPPORTED_REASONING_EFFORT。所以按 渠道/模型 缓存
    // 一次探测结果，不支持就永久退回"不传"。
    const routeKey = `${route.provider}/${route.model}`
    const thinkingMode = thinkingSupport.get(routeKey)
    if (config.disableThinking && thinkingMode !== 'unsupported') request.reasoningEffort = 'off'

    const startedAt = now()
    let text = ''
    let finish
    bumpIdle()
    try {
      for await (const chunk of llm.stream(request)) {
        bumpIdle()
        if (chunk === null || chunk === undefined) continue
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish') finish = chunk.reason
      }
    } catch (error) {
      if (signal.aborted) {
        // [PATCH 2026-10-19 fallback-route] 看门狗触发时打标记，让上层知道
        // 这次失败是"卡死"而不是"上游明确报错"，两者都该切备用路由。
        if (idledOut) throw idleError(idleMs, signal.reason ?? error)
        throw new Error(`翻译调用被中断：${errorMessage(signal.reason ?? error)}`)
      }
      // [PATCH 2026-10-19 thinking-off] 这个渠道/模型不接受 reasoningEffort:'off'。
      // 记下来、去掉该字段重试一次——用户不该因为模型不支持关思考就翻不了译。
      if (request.reasoningEffort !== undefined && isUnsupportedReasoningEffort(error)) {
        thinkingSupport.set(routeKey, 'unsupported')
        log('warn', `${routeKey} does not support reasoningEffort:"off"; retrying without it`)
        delete request.reasoningEffort
        for await (const chunk of llm.stream(request)) {
          if (chunk === null || chunk === undefined) continue
          if (chunk.type === 'text-delta') text += chunk.text
          else if (chunk.type === 'finish') finish = chunk.reason
        }
        const retryFailure = finishFailure(finish)
        if (retryFailure !== null) throw retryFailure
        const retryCleaned = cleanTranslation(text)
        if (retryCleaned.length === 0) throw new Error('模型没有返回译文')
        stats.lastMs = now() - startedAt
        return retryCleaned
      }
      throw error
    } finally {
      clearTimeout(timer)
      clearTimeout(idleTimer)
    }
    if (signal.aborted) {
      if (idledOut) throw idleError(idleMs, signal.reason ?? 'aborted')
      throw new Error(`翻译调用被中断：${errorMessage(signal.reason ?? 'aborted')}`)
    }
    const failure = finishFailure(finish)
    if (failure !== null) throw failure
    const cleaned = cleanTranslation(text)
    if (cleaned.length === 0) throw new Error('模型没有返回译文')
    stats.lastMs = now() - startedAt
    return cleaned
  }

  /**
   * Whether a distinct fallback chunk size is configured.
   *
   * [PATCH 2026-10-19 fallback-chunk] When the fallback route has its own, larger
   * chunk size, per-chunk retries must step aside: they would otherwise hammer
   * the fallback with the primary's small chunks, and the whole point of the
   * larger size (fewer requests) would never come into play.
   *
   * @param config - the live settings snapshot.
   * @returns true when the whole block should be re-run on the fallback instead.
   */
  function usesDistinctFallbackChunks(config) {
    const size = Number.isFinite(config.fallbackChunkChars) ? Math.floor(config.fallbackChunkChars) : 0
    return size > 0 && size > Math.max(1, Math.floor(config.maxChunkChars))
  }

  /** Translate one chunk core through the cache + gate. */
  function translateChunk(core, config, route, signal, force) {
    const key = cacheKey(route, config.targetLanguage, core)
    // [PATCH 2026-10-06 retry-force] force（重新翻译）必须绕过分块 LRU 读取：否则长文本
    // 的每个分块都命中缓存，"重翻"秒回一字不差的旧稿（配合面板幂等渲染=零变化，用户
    // 只看到「翻译中…」一闪）。force 仍写回缓存；inflight 去重保留（在飞的本来就是新调用）。
    const hit = force === true ? undefined : cache.get(key)
    if (hit !== undefined) {
      stats.hits += 1
      cache.delete(key)
      cache.set(key, hit)
      return Promise.resolve(hit)
    }
    const running = inflight.get(key)
    if (running !== undefined) {
      stats.deduped += 1
      return running
    }
    const task = (async () => {
      await acquire()
      try {
        stats.requests += 1
        let value
        try {
          value = await callModel(core, config, route, signal)
        } catch (error) {
          // [PATCH 2026-10-19 fallback-route] 主路由失败时切备用路由重试一次。
          // 备用路由的缓存键单独算：同一段文本在两条路由上的译文不同，混用会
          // 让"切回去"读到另一条路由的译文。
          const fallback = fallbackRouteOf(config)
          // [PATCH 2026-10-19 fallback-chunk] 配了更大的备用块时，单块回退让位给
          // translate() 里的整段重跑——否则小尺寸会把备用路由先打一遍。
          // [PATCH 2026-10-20 fallback-reason] 但"为什么没兜底"必须写进错误里，
          // 不能只是把主路由的原始错误原样抛出去。
          if (fallback === null || !isFallbackWorthy(error, signal)) {
            throw annotateRouteFailure(error, route, fallback, config, null)
          }
          // [PATCH 2026-10-20 fallback-reason-defer] 备用块更大时，单块回退让位给
          // translate() 的整段重跑——但必须如实说明"让位"，不能沿用下面
          // sameRoute 那句"与主路由相同"，否则报出的原因与事实相反。
          if (usesDistinctFallbackChunks(config)) {
            throw annotateRouteFailure(error, route, fallback, config, null, true)
          }
          if (sameRoute(route, fallback)) throw annotateRouteFailure(error, route, fallback, config, null)
          log('warn', `primary route failed (${errorMessage(error)}), retrying on ${fallback.provider}/${fallback.model}`)
          const fallbackKey = cacheKey(fallback, config.targetLanguage, core)
          const cachedFallback = cache.get(fallbackKey)
          if (cachedFallback !== undefined) {
            stats.hits += 1
            stats.fallbacks += 1
            return cachedFallback
          }
          stats.requests += 1
          try {
            value = await callModel(core, config, fallback, signal)
          } catch (fallbackError) {
            throw annotateRouteFailure(error, route, fallback, config, fallbackError)
          }
          stats.fallbacks += 1
          stats.translatedChars += value.length
          remember(fallbackKey, value)
          return value
        }
        stats.translatedChars += value.length
        remember(key, value)
        return value
      } catch (error) {
        stats.failures += 1
        stats.lastError = errorMessage(error)
        log('warn', `translate failed: ${stats.lastError}`)
        throw error
      } finally {
        release()
      }
    })()
    inflight.set(key, task)
    const settled = () => {
      if (inflight.get(key) === task) inflight.delete(key)
    }
    task.then(settled, settled)
    return task
  }

  return {
    /**
     * Translate one reasoning text.
     *
     * @param text - the source text (typically one thinking block).
     * @param options - `signal` cancels the caller's interest; `force` bypasses the already-Chinese shortcut.
     * @returns `{ ok, translation, skipped, chunks, cached, route, ms }`.
     */
    async translate(text, translateOptions = {}) {
      const startedAt = now()
      const config = getConfig()
      const normalized = normalizeText(text)
      if (normalized.length === 0) {
        return { ok: true, translation: '', skipped: 'empty', chunks: 0, cached: true, ms: 0 }
      }
      if (!translateOptions.force && config.skipMostlyChinese && looksChinese(normalized)) {
        stats.skipped += 1
        return { ok: true, translation: normalized, skipped: 'already-chinese', chunks: 0, cached: true, ms: 0 }
      }
      const truncated = normalized.length > config.maxInputChars
      // [PATCH 2026-10-19 clip-boundary] 截断点落在自然边界（段落 → 行 → 句子），
      // 不再从句子中间砍断——半个句子交给模型只会得到半个译文。
      const source = truncated ? clipAtBoundary(normalized, config.maxInputChars) : normalized
      const route = getRoute()
      stats.lastRoute = `${route.provider}/${route.model}`
      stats.lastAt = new Date().toISOString()
      stats.sourceChars += source.length

      // [PATCH 2026-10-19 fallback-chunk] 一次翻译跑完的分块计划。主路由和备用
      // 路由各用各的块大小：备用路由通常无长度限制，块拉大能减少请求次数。
      /** Turn one finished plan into the caller-visible result (throws when nothing translated). */
      const finalize = (finished) => {
        // [PATCH 2026-10-19 fallback-chunk] 全部块都失败时必须抛错，不能返回空译文：
        // 面板要据此显示"翻译失败"，调用方也要能据此判断。部分失败则保留原文继续。
        if (finished.chunks > 0 && finished.failed === finished.chunks && finished.firstError !== undefined) {
          throw finished.firstError
        }
        const translation = finished.parts.map((part) => (part.core.length === 0 ? '' : part.translation) + part.separator).join('')
        // [PATCH 2026-10-20 fallback-counter] 整段重跑成功时补记一次。
        // 单块回退在 translateChunk 里已经计过数，这里只补整段重跑这条路径，
        // 且一轮只记一次，避免多块重复累加。
        if (fallbackRan) {
          stats.fallbacks += 1
          fallbackRan = false
        }
        return {
          ok: true,
          translation,
          skipped: truncated ? 'truncated' : null,
          chunks: finished.chunks,
          failedChunks: finished.failed,
          cached: finished.cached,
          route: { provider: route.provider, model: route.model, source: route.source },
          ms: now() - startedAt,
        }
      }

      // [PATCH 2026-10-20 fallback-counter] 整段重跑也算一次备用路由执行。
      // 旧实现只在 translateChunk 的单块回退里 `stats.fallbacks += 1`，而
      // 整段重跑走的是 runPlan(fallbackRoute, …)，两处调用点都没计数 ——
      // 于是「备用路由执行次数」长期显示 0，用户以为兜底一次都没生效，
      // 实际上面板上的译文就是 Bing 出的。计数口径：一轮 translate() 里
      // 只要有块真的由备用路由翻出来，就算 1 次（多块不重复累加）。
      let fallbackRan = false

      const runPlan = async (planRoute, chunkChars, limit) => {
        const planParts = chunkText(source, chunkChars).map((chunk) => {
          const { core, separator } = splitTrailingSpace(chunk)
          return { core, separator, translation: '' }
        })
        const allPending = planParts.filter((part) => part.core.length > 0)
        // limit：探针模式只跑第一块，其余块留空（译文回退成原文），由调用方决定下一步。
        const planPending = Number.isFinite(limit) && limit > 0 ? allPending.slice(0, limit) : allPending
        stats.chunks += planPending.length
        const before = stats.requests
        const failuresBefore = stats.failures
        // allSettled：个别块失败不该让整段翻译直接抛错——失败的块保留原文，
        // 其余块照常出译文。调用方从 result.failedChunks 能看到有几块没翻出来。
        const settled = await Promise.allSettled(
          planPending.map(async (part) => {
            part.translation = await translateChunk(part.core, config, planRoute, translateOptions.signal, translateOptions.force === true)
          }),
        )
        const rejected = settled.filter((entry) => entry.status === 'rejected')
        // [PATCH 2026-10-20 fallback-counter] 这一轮只要有块真的由备用路由
        // 翻出来，就记一次备用执行。
        if (planRoute.source === 'fallback' && rejected.length < planPending.length) {
          fallbackRan = true
        }
        return {
          parts: planParts,
          chunks: planPending.length,
          cached: planPending.length > 0 && stats.requests === before,
          failed: rejected.length,
          firstError: rejected.length > 0 ? rejected[0].reason : undefined,
          failedDelta: stats.failures - failuresBefore,
        }
      }

      // [PATCH 2026-10-19 fallback-chunk] 配了独立备用块时先"探针"一块：主路由
      // 全挂的典型症状是每块都要等满 30s 网关超时，跑完 N 块才切备用等于白等
      // N×30s。先发一块，失败就直接整段走备用。
      let plan
      if (fallbackRouteOf(config) !== null && usesDistinctFallbackChunks(config)) {
        plan = await runPlan(route, config.maxChunkChars, 1)
        if (plan.failed > 0) {
          log('warn', `primary probe chunk failed on ${route.provider}; switching the whole block to ${fallbackRouteOf(config).provider}`)
          plan = await runPlan(fallbackRouteOf(config), Math.floor(config.fallbackChunkChars))
          return finalize(plan)
        }
        // 探针通过：接着跑剩下的块（探针块已缓存，不会重复请求）。
        plan = await runPlan(route, config.maxChunkChars)
      } else {
        plan = await runPlan(route, config.maxChunkChars)
      }
      // [PATCH 2026-10-19 fallback-chunk] 整段都没翻出来（每个块都失败了）时，
      // 如果备用路由配了更大的块，用它的模板整体重跑一次。单块级别的回退
      // 已经在 translateChunk 里做了；这里处理"块尺寸本身不合适"的情况——
      // 例如免费端点把 2000 字的块全部 504，而付费端点 8000 字反而能过。
      const fallbackRoute = fallbackRouteOf(config)
      const fallbackChunk = Number.isFinite(config.fallbackChunkChars) ? Math.floor(config.fallbackChunkChars) : 0
      // 只有"这一轮几乎全挂"才值得整段重跑：个别块失败已经由 translateChunk
      // 内的单块回退处理过了，整段重跑只会重复花钱。
      const nearlyAllFailed = plan.chunks > 0 && plan.failed >= Math.ceil(plan.chunks * 0.8)
      if (fallbackRoute !== null && fallbackChunk > config.maxChunkChars && nearlyAllFailed) {
        log('warn', `${plan.failed}/${plan.chunks} chunks failed on ${route.provider}; retrying the whole block on ${fallbackRoute.provider} at ${fallbackChunk} chars`)
        const primaryError = plan.firstError
        plan = await runPlan(fallbackRoute, fallbackChunk)
        // [PATCH 2026-10-20 fallback-reason] 整段重跑也全挂时，错误里要能看出
        // "两条路由都试过了"，而不是只剩最后一条路由的原始报错。
        if (plan.failed === plan.chunks && plan.chunks > 0 && primaryError !== undefined) {
          const wrapped = annotateRouteFailure(primaryError, route, fallbackRoute, config, plan.firstError)
          plan = { ...plan, firstError: wrapped }
        }
      }
      return finalize(plan)
    },

    /** Current counters plus cache occupancy, for the settings panel. */
    state() {
      return {
        ...stats,
        cacheSize: cache.size,
        inflight: inflight.size,
        active,
        queued: waiters.length,
      }
    },

    /** Drop every cached translation. */
    clearCache() {
      const size = cache.size
      cache.clear()
      return size
    },
  }
}
