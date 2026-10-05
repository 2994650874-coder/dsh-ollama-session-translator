/**
 * dsh-cot-en2cn — Ollama discovery and direct transport.
 * [PATCH 2026-10-05 ollama-discover]
 *
 * A running Ollama answers two questions by itself: where it is, and which
 * models it serves. This module probes the candidate endpoints, lists the live
 * models, and — when a route's provider is an `http(s)://` endpoint — speaks
 * the OpenAI-compatible `/v1/chat/completions` protocol directly. That makes a
 * local model usable with zero configuration: no `cordis.patch.yml` provider
 * registration, no API key.
 *
 * Routes whose provider is a plain name keep using the DSH model channel; this
 * module only owns the endpoint-addressed ones.
 *
 * Dependency-free on purpose (see package.json `dependencies`); `fetch` is the
 * Node 22 global, injectable for tests.
 *
 * @module dsh-cot-en2cn/ollama
 */

/** Endpoints probed when neither env var points anywhere. */
const DEFAULT_ENDPOINTS = ['http://127.0.0.1:11434', 'http://localhost:11434']

/**
 * Normalize one endpoint hint to `scheme://host[:port]`, dropping any path.
 *
 * @param raw - e.g. `127.0.0.1:11434`, `http://localhost:11434/`, `https://gpu.box:11434`.
 * @returns the normalized endpoint, or `''` when it is not http(s).
 */
export function normalizeOllamaEndpoint(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return ''
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`
  let url
  try {
    url = new URL(candidate)
  } catch {
    return ''
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
  return `${url.protocol}//${url.host}`
}

/**
 * The endpoints to probe, in preference order.
 *
 * `DSH_COT_EN2CN_OLLAMA` (comma-separated) replaces the whole list — a user
 * escape hatch and a deterministic hook for tests. Otherwise `OLLAMA_HOST`
 * leads, then the two loopback defaults.
 *
 * @param env - environment map (defaults to `process.env`).
 * @returns normalized, de-duplicated endpoints in preference order.
 */
export function ollamaCandidateEndpoints(env = process.env) {
  const out = []
  const push = (raw) => {
    const endpoint = normalizeOllamaEndpoint(raw)
    if (endpoint !== '' && !out.includes(endpoint)) out.push(endpoint)
  }
  const explicit = String(env?.DSH_COT_EN2CN_OLLAMA ?? '').split(',')
  if (explicit.some((entry) => entry.trim() !== '')) {
    for (const entry of explicit) push(entry)
    return out
  }
  push(env?.OLLAMA_HOST)
  for (const endpoint of DEFAULT_ENDPOINTS) push(endpoint)
  return out
}

/** Map one `/api/tags` or `/v1/models` row to a model entry. */
function modelEntry(row) {
  const id = String(row?.name ?? row?.model ?? row?.id ?? '')
  return {
    id,
    name: id,
    parameterSize: typeof row?.details?.parameter_size === 'string' ? row.details.parameter_size : '',
    size: Number.isFinite(row?.size) ? row.size : 0,
  }
}

/** Fetch one endpoint's live model list (native `/api/tags`, then `/v1/models`). */
async function fetchOllamaModels(fetchImpl, endpoint, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const response = await fetchImpl(`${endpoint}/api/tags`, { signal })
    if (response.ok) {
      const data = await response.json()
      const rows = Array.isArray(data?.models) ? data.models : []
      const models = rows.map(modelEntry).filter((entry) => entry.id !== '')
      if (models.length > 0) return models
    }
  } catch {
    /* fall through to the OpenAI-compatible listing */
  }
  const response = await fetchImpl(`${endpoint}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`Ollama 模型列表请求失败（HTTP ${response.status}）`)
  const data = await response.json()
  const rows = Array.isArray(data?.data) ? data.data : []
  return rows.map(modelEntry).filter((entry) => entry.id !== '')
}

/**
 * Probe the candidate endpoints and report the first Ollama standing.
 *
 * Probing runs in parallel but the winner is picked in preference order, so a
 * configured `OLLAMA_HOST` beats the loopback defaults deterministically.
 *
 * @param options - `endpoints` overrides the candidates, `fetchImpl`/`timeoutMs` for tests.
 * @returns `{ found, endpoint, models, probed }`.
 */
export async function discoverOllama(options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const endpoints = options.endpoints ?? ollamaCandidateEndpoints(options.env ?? process.env)
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 1500
  const probed = [...endpoints]
  if (typeof fetchImpl !== 'function' || endpoints.length === 0) {
    return { found: false, endpoint: '', models: [], probed }
  }
  const results = await Promise.all(
    endpoints.map(async (endpoint) => {
      try {
        return { endpoint, models: await fetchOllamaModels(fetchImpl, endpoint, timeoutMs) }
      } catch {
        return null
      }
    }),
  )
  const hit = results.find((entry) => entry !== null)
  if (hit === undefined) return { found: false, endpoint: '', models: [], probed }
  return { found: true, endpoint: hit.endpoint, models: hit.models, probed }
}

/** Flatten a message's content (string or typed parts) into plain text. */
function messageText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : String(part?.text ?? '')))
      .join('')
  }
  return String(content ?? '')
}

/** Map an OpenAI `finish_reason` onto the engine's finish-kind vocabulary. */
function finishReason(raw) {
  if (raw === 'length') return { kind: 'max-tokens' }
  if (raw === 'tool_calls') return { kind: 'tool-calls' }
  return { kind: 'stop' }
}

/**
 * Build an `llm.stream()`-shaped client for one Ollama endpoint.
 *
 * The request carries `system`, `messages`, `maxTokens`, `model` and `signal`;
 * the stream yields one `text-delta` and one `finish`, exactly what
 * `lib/engine.js` consumes. Ollama's `/v1/chat/completions` is called without
 * streaming: translations are short and a single round trip is simpler to
 * reason about than SSE reassembly.
 *
 * @param endpoint - the Ollama endpoint (normalized internally).
 * @param options - `fetchImpl` for tests.
 * @returns `{ stream(request) }`.
 */
export function createOllamaClient(endpoint, options = {}) {
  const base = normalizeOllamaEndpoint(endpoint)
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  return {
    async *stream(request) {
      if (base === '') throw new Error(`Ollama 地址无效：${String(endpoint)}`)
      const messages = []
      const system = typeof request?.system === 'string' ? request.system : ''
      if (system !== '') messages.push({ role: 'system', content: system })
      for (const message of request?.messages ?? []) {
        messages.push({ role: String(message?.role ?? 'user'), content: messageText(message) })
      }
      const body = {
        model: String(request?.model ?? ''),
        messages,
        stream: false,
      }
      const maxTokens = Number.isFinite(request?.maxTokens) ? Math.floor(request.maxTokens) : 0
      if (maxTokens > 0) body.max_tokens = maxTokens
      let response
      try {
        response = await fetchImpl(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: request?.signal,
        })
      } catch (error) {
        if (request?.signal?.aborted) throw error
        throw new Error(`无法连接 Ollama（${base}）：${error instanceof Error ? error.message : String(error)}`)
      }
      if (!response.ok) {
        let detail = ''
        try {
          detail = String(await response.text()).slice(0, 300)
        } catch {
          /* the status alone has to suffice */
        }
        throw new Error(`Ollama 请求失败（${base}，HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}`)
      }
      let data
      try {
        data = await response.json()
      } catch (error) {
        throw new Error(`Ollama 返回了无法解析的响应：${error instanceof Error ? error.message : String(error)}`)
      }
      const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined
      const text = typeof choice?.message?.content === 'string' ? choice.message.content : ''
      if (text === '') {
        const reason = typeof data?.error?.message === 'string' ? data.error.message : ''
        throw new Error(`Ollama 没有返回译文内容${reason === '' ? '' : `：${reason}`}`)
      }
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: finishReason(choice?.finish_reason) }
    },
  }
}

/** The defaults, exposed for documentation and tests. */
export const OLLAMA_DEFAULT_ENDPOINTS = Object.freeze([...DEFAULT_ENDPOINTS])
