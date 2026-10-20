/**
 * dsh-cot-en2cn — offline smoke test.
 *
 * Covers the parts that do not need a DSH host or a browser:
 *   - lib/text.js      chunking, script detection, hashing
 *   - lib/engine.js    cache, de-duplication, concurrency, failures, reassembly
 *   - lib/client.js    the browser bundle registers and exports the plugin face
 *
 * Run: node tools/smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')

const { chunkText, clipAtBoundary, looksChinese, normalizeText, splitTrailingSpace, hashText } = await import(
  pathToFileURL(join(lib, 'text.js')).href
)
const { cleanTranslation, createTranslationEngine, translationSystemPrompt } = await import(
  pathToFileURL(join(lib, 'engine.js')).href
)
const { DEFAULT_CONFIG, normalizeConfig } = await import(pathToFileURL(join(lib, 'config.js')).href)
const { configFilePath, createConfigStore, resolveDshHome } = await import(
  pathToFileURL(join(lib, 'store.js')).href
)

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    failed += 1
    process.stdout.write(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}\n`)
  }
}

const BASE_CONFIG = {
  enabled: true,
  autoTranslate: true,
  liveTranslate: false,
  targetLanguage: 'zh-CN',
  provider: '',
  model: '',
  disableThinking: true,
  maxChunkChars: 3000,
  maxInputChars: 24000,
  timeoutMs: 30000,
  concurrency: 2,
  cacheEntries: 100,
  skipMostlyChinese: true,
  showOriginal: false,
  fontSizePx: 13,
  // [PATCH 2026-10-19 fallback-route] 备用路由默认关闭，测试按需覆盖。
  fallbackProvider: '',
  fallbackModel: '',
  fallbackIdleMs: 0,
}

/** A fake `llm` service: yields one text block and a stop finish. */
function fakeLlm(transform, options = {}) {
  const calls = []
  const state = { active: 0, peak: 0 }
  const llm = {
    calls,
    state,
    async *stream(request) {
      calls.push(request)
      state.active += 1
      state.peak = Math.max(state.peak, state.active)
      try {
        const core = request.messages[0].content[0].text
        if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
        if (options.finish !== undefined) {
          yield { type: 'finish', reason: options.finish }
          return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: transform(core, request) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      } finally {
        state.active -= 1
      }
    },
  }
  return llm
}

function makeEngine(llm, configPatch = {}) {
  const config = { ...BASE_CONFIG, ...configPatch }
  return {
    config,
    engine: createTranslationEngine({
      getConfig: () => config,
      getLlm: () => llm,
      getRoute: () => ({ provider: 'fake', model: 'fake-1', source: 'override' }),
      log: () => {},
    }),
  }
}

process.stdout.write('text utilities\n')

await test('normalizeText trims and normalizes CRLF', () => {
  assert.equal(normalizeText('  a\r\nb  '), 'a\nb')
  assert.equal(normalizeText(undefined), '')
})

await test('hashText is stable and content sensitive', () => {
  assert.equal(hashText('abc'), hashText('abc'))
  assert.notEqual(hashText('abc'), hashText('abd'))
})

await test('looksChinese separates Chinese prose from English prose', () => {
  assert.equal(looksChinese('这是一段中文思维链，里面有几个 token 和 tool_call 之类的英文词。'), true)
  assert.equal(looksChinese('Let me check the file and then run the tests.'), false)
  assert.equal(looksChinese(''), false)
})

await test('chunkText never loses a byte and respects the ceiling', () => {
  const source = `${'para one line\n'.repeat(40)}\n${'para two '.repeat(120)}\n\nlast\n`
  for (const limit of [40, 137, 512, 3000]) {
    const chunks = chunkText(source, limit)
    assert.equal(chunks.join(''), source, `reassembly failed at limit ${limit}`)
    for (const chunk of chunks) assert.ok(chunk.length <= limit, `chunk over ${limit}`)
  }
  assert.deepEqual(chunkText('', 10), [])
  assert.deepEqual(chunkText('short', 10), ['short'])
})

await test('chunkText does not split surrogate pairs', () => {
  const source = '😀'.repeat(64)
  const chunks = chunkText(source, 21)
  assert.equal(chunks.join(''), source)
  for (const chunk of chunks) assert.equal([...chunk].every((char) => char === '😀'), true)
})

await test('clipAtBoundary ends on a paragraph boundary, not mid-sentence', () => {
  const paragraphs = [
    'First paragraph that is reasonably long and complete.',
    'Second paragraph that is also reasonably long and complete.',
    'Third paragraph that is also reasonably long and complete.',
  ]
  const text = paragraphs.join('\n\n')
  const limit = 130
  assert.ok(text.length > limit, 'fixture must exceed the limit')
  const clipped = clipAtBoundary(text, limit)
  assert.ok(clipped.length <= limit)
  // 必须停在段落边界上：结尾是 \n 且前一个非空白字符是句号。
  assert.ok(clipped.endsWith('\n'), 'clip should keep the paragraph separator')
  assert.ok(/[.!?。！？]\s*\n$/.test(clipped), 'clip should land after a sentence end')
  // 且不能是原文前缀之外的任何东西。
  assert.equal(text.slice(0, clipped.length), clipped)
})

await test('clipAtBoundary falls back to a hard cut with no boundary in range', () => {
  const solid = 'x'.repeat(500)
  const clipped = clipAtBoundary(solid, 200)
  assert.equal(clipped.length, 200)
  assert.equal(clipped, solid.slice(0, 200))
})

await test('clipAtBoundary returns the text untouched under the limit', () => {
  assert.equal(clipAtBoundary('short', 100), 'short')
})

await test('splitTrailingSpace splits content from its separator', () => {
  assert.deepEqual(splitTrailingSpace('hello\n\n'), { core: 'hello', separator: '\n\n' })
  assert.deepEqual(splitTrailingSpace('\n\n'), { core: '', separator: '\n\n' })
})

process.stdout.write('engine\n')

await test('translate returns the model text and caches it', async () => {
  const llm = fakeLlm((core) => `[zh] ${core}`)
  const { engine } = makeEngine(llm)
  const first = await engine.translate('Hello world, this is a long enough sentence.')
  assert.equal(first.ok, true)
  assert.equal(first.translation, '[zh] Hello world, this is a long enough sentence.')
  assert.equal(first.cached, false)
  assert.equal(llm.calls.length, 1)
  const second = await engine.translate('Hello world, this is a long enough sentence.')
  assert.equal(second.cached, true)
  assert.equal(llm.calls.length, 1)
  assert.equal(engine.state().cacheSize, 1)
})

await test('translate reassembles chunk separators exactly', async () => {
  const llm = fakeLlm((core) => core.toUpperCase())
  const { engine } = makeEngine(llm, { maxChunkChars: 60 })
  const source = `${'line one\n'.repeat(12)}\n${'word '.repeat(60)}\n\ntail line\n`
  const expected = normalizeText(source).toUpperCase()
  const result = await engine.translate(source)
  assert.equal(result.translation, expected)
  assert.ok(result.chunks > 1, 'expected the source to be chunked')
  assert.ok(llm.calls.length > 1)
  // Interior blank lines are structural and must survive chunking untouched.
  assert.equal(
    (result.translation.match(/\n\n/g) ?? []).length,
    (expected.match(/\n\n/g) ?? []).length,
  )
  assert.equal((result.translation.match(/\n/g) ?? []).length, (expected.match(/\n/g) ?? []).length)
})

await test('already-Chinese text skips the model', async () => {
  const llm = fakeLlm((core) => core)
  const { engine } = makeEngine(llm)
  const result = await engine.translate('这里已经是中文思考了，不需要再翻译一遍。')
  assert.equal(result.skipped, 'already-chinese')
  assert.equal(llm.calls.length, 0)
  const forced = await engine.translate('这里已经是中文思考了，不需要再翻译一遍。', { force: true })
  assert.equal(forced.skipped, null)
  assert.equal(llm.calls.length, 1)
})

await test('concurrent requests for the same text share one model call', async () => {
  const llm = fakeLlm((core) => `[zh] ${core}`, { delayMs: 20 })
  const { engine } = makeEngine(llm)
  const text = 'A single reasoning paragraph that will be requested twice at once.'
  const [a, b] = await Promise.all([engine.translate(text), engine.translate(text)])
  assert.equal(a.translation, b.translation)
  assert.equal(llm.calls.length, 1)
  assert.equal(engine.state().deduped, 1)
})

await test('the concurrency gate serializes model calls', async () => {
  const llm = fakeLlm((core) => core.toUpperCase(), { delayMs: 10 })
  const { engine } = makeEngine(llm, { maxChunkChars: 60, concurrency: 1 })
  const source = Array.from({ length: 20 }, (_, index) => `alpha beta gamma delta ${index}\n`).join('')
  const result = await engine.translate(source)
  assert.equal(result.translation, normalizeText(source).toUpperCase())
  assert.equal(llm.state.peak, 1)
  assert.ok(llm.calls.length > 1, `expected several calls, got ${llm.calls.length}`)
  assert.equal(result.chunks, llm.calls.length)
})

await test('identical chunks collapse into one model call', async () => {
  const llm = fakeLlm((core) => `[zh] ${core}`)
  const { engine } = makeEngine(llm, { maxChunkChars: 40, concurrency: 4 })
  const source = `${'same line here\n'.repeat(12)}`
  const result = await engine.translate(source)
  assert.ok(result.chunks > 1, `expected several chunks, got ${result.chunks}`)
  assert.equal(llm.calls.length, 1)
})

await test('a truncated model finish fails the call and is counted', async () => {
  const llm = fakeLlm((core) => core, { finish: { kind: 'max-tokens' } })
  const { engine } = makeEngine(llm)
  await assert.rejects(() => engine.translate('A sentence long enough to be translated.'), /截断/)
  assert.equal(engine.state().failures, 1)
  assert.match(String(engine.state().lastError), /截断/)
})

await test('an empty model reply fails the call', async () => {
  const llm = fakeLlm(() => '   ')
  const { engine } = makeEngine(llm)
  await assert.rejects(() => engine.translate('Another sentence that is long enough.'), /没有返回译文/)
})

await test('maxInputChars clips the source', async () => {
  const llm = fakeLlm((core) => `[zh] ${core}`)
  const { engine } = makeEngine(llm, { maxInputChars: 600, maxChunkChars: 200, skipMostlyChinese: false })
  const source = 'word '.repeat(400)
  const result = await engine.translate(source)
  assert.equal(result.skipped, 'truncated')
  assert.ok(result.translation.length < source.length)
})

await test('clearCache empties the cache', async () => {
  const llm = fakeLlm((core) => `[zh] ${core}`)
  const { engine } = makeEngine(llm)
  await engine.translate('Some reasoning text that needs translating.')
  assert.equal(engine.state().cacheSize, 1)
  assert.equal(engine.clearCache(), 1)
  assert.equal(engine.state().cacheSize, 0)
})

await test('cacheEntries = 0 disables caching', async () => {
  const llm = fakeLlm((core) => `[zh] ${core}`)
  const { engine } = makeEngine(llm, { cacheEntries: 0 })
  await engine.translate('Some reasoning text that needs translating.')
  await engine.translate('Some reasoning text that needs translating.')
  assert.equal(llm.calls.length, 2)
})

await test('a missing llm service fails loudly', async () => {
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG }),
    getLlm: () => undefined,
    getRoute: () => ({ provider: 'fake', model: 'fake-1', source: 'override' }),
  })
  await assert.rejects(() => engine.translate('This needs the llm service to work.'), /LLM 服务不可用/)
})

await test('a missing route fails before any request', async () => {
  const llm = fakeLlm((core) => core)
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG }),
    getLlm: () => llm,
    getRoute: () => {
      throw new Error('没有可用的模型路由')
    },
  })
  await assert.rejects(() => engine.translate('This needs a route to work at all.'), /没有可用的模型路由/)
  assert.equal(llm.calls.length, 0)
})

await test('an empty input is a no-op', async () => {
  const llm = fakeLlm((core) => core)
  const { engine } = makeEngine(llm)
  const result = await engine.translate('   \n  ')
  assert.equal(result.skipped, 'empty')
  assert.equal(llm.calls.length, 0)
})

// [PATCH 2026-10-19 thinking-off] 关思考的正确做法是 reasoningEffort:'off'。
// 旧实现设 purpose:'session-title' 并指望适配器映射——实测适配器完全不看 purpose，
// 所以那个开关从来没生效过。
await test('thinking is disabled through reasoningEffort "off" by default', async () => {
  const llm = fakeLlm((core) => core)
  const { engine } = makeEngine(llm)
  await engine.translate('A sentence that must reach the model somehow.')
  assert.equal(llm.calls[0].reasoningEffort, 'off')
  assert.equal(llm.calls[0].purpose, undefined)
  const llm2 = fakeLlm((core) => core)
  const second = makeEngine(llm2, { disableThinking: false })
  await second.engine.translate('A sentence that must reach the model somehow.')
  assert.equal(llm2.calls[0].reasoningEffort, undefined)
})

await test('a route that refuses reasoningEffort is retried without it', async () => {
  let first = true
  const seen = []
  const llm = {
    async *stream(request) {
      seen.push(request.reasoningEffort)
      if (first) {
        first = false
        throw new Error('provider "free" model "m" does not support reasoning effort "off"')
      }
      yield { type: 'text-delta', text: '译好了' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const { engine } = makeEngine(llm)
  const result = await engine.translate('Some English reasoning that needs translating.')
  assert.equal(result.translation, '译好了')
  assert.deepEqual(seen, ['off', undefined])
})

await test('messages look like a hand-built plugin user message', async () => {
  const llm = fakeLlm((core) => core)
  const { engine } = makeEngine(llm)
  await engine.translate('Message shape check for the plugin source tag.')
  const message = llm.calls[0].messages[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin')
  assert.equal(message.source.plugin, 'dsh-session-translator')
  assert.equal(message.content[0].type, 'text')
  assert.equal(typeof message.id, 'string')
  assert.ok(Object.isFrozen(message))
})

await test('cleanTranslation unwraps fences and "译文：" prefixes', () => {
  assert.equal(cleanTranslation('```\n你好\n```'), '你好')
  assert.equal(cleanTranslation('```markdown\n你好\n```'), '你好')
  assert.equal(cleanTranslation('译文：你好'), '你好')
  assert.equal(cleanTranslation('你好\n\n'), '你好')
  assert.equal(cleanTranslation('```js\nconst a = 1\n```'), 'const a = 1')
})

await test('the system prompt names the target language', () => {
  assert.match(translationSystemPrompt('zh-CN'), /简体中文/)
  assert.match(translationSystemPrompt('zh-TW'), /繁體中文/)
  assert.match(translationSystemPrompt('ja'), /日本語/)
  assert.match(translationSystemPrompt('nonsense'), /简体中文/)
})

process.stdout.write('config + store\n')

await test('normalizeConfig fills defaults and drops unknown keys', () => {
  const config = normalizeConfig({ enabled: false, nope: 1 })
  assert.equal(config.enabled, false)
  assert.equal(config.autoTranslate, DEFAULT_CONFIG.autoTranslate)
  assert.equal('nope' in config, false)
  assert.deepEqual(Object.keys(config).sort(), Object.keys(DEFAULT_CONFIG).sort())
})

await test('normalizeConfig clamps numbers and rejects unknown languages', () => {
  const config = normalizeConfig({
    maxChunkChars: 999999,
    concurrency: 0,
    timeoutMs: -5,
    fontSizePx: 99,
    targetLanguage: 'klingon',
    provider: '  deepseek  ',
  })
  assert.equal(config.maxChunkChars, 20000)
  assert.equal(config.concurrency, 1)
  assert.equal(config.timeoutMs, 5000)
  assert.equal(config.fontSizePx, 18)
  assert.equal(config.targetLanguage, 'zh-CN')
  assert.equal(config.provider, 'deepseek')
})

await test('normalizeConfig ignores non-json garbage', () => {
  assert.deepEqual(normalizeConfig(null), { ...DEFAULT_CONFIG })
  assert.deepEqual(normalizeConfig('nope'), { ...DEFAULT_CONFIG })
  assert.deepEqual(normalizeConfig([1, 2]), { ...DEFAULT_CONFIG })
  assert.equal(normalizeConfig({ enabled: 'yes' }).enabled, true)
})

await test('resolveDshHome honours DSH_HOME and falls back to ~/.dsh', () => {
  assert.equal(resolveDshHome({ DSH_HOME: 'C:\\temp\\dsh-home' }), 'C:\\temp\\dsh-home')
  assert.match(resolveDshHome({}), /\.dsh$/)
  assert.match(resolveDshHome({ DSH_HOME: '   ' }), /\.dsh$/)
})

await test('the config store round-trips through a real file', () => {
  const home = mkdtempSync(join(tmpdir(), 'session-translator-'))
  try {
    const store = createConfigStore({ home })
    assert.equal(store.path, configFilePath(home))
    const missing = store.load()
    assert.equal(missing.source, 'defaults')
    assert.deepEqual(missing.config, { ...DEFAULT_CONFIG })

    store.save({ ...DEFAULT_CONFIG, enabled: false, provider: 'acme', maxChunkChars: 100000 })
    const reloaded = store.load()
    assert.equal(reloaded.source, 'file')
    assert.equal(reloaded.config.enabled, false)
    assert.equal(reloaded.config.provider, 'acme')
    // Clamped on the way in, so a hand-edited file can never inject junk.
    assert.equal(reloaded.config.maxChunkChars, 20000)

    writeFileSync(store.path, '{ this is not json', 'utf8')
    const broken = store.load()
    assert.equal(broken.source, 'invalid')
    assert.deepEqual(broken.config, { ...DEFAULT_CONFIG })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

await test('a bare config document is accepted (no version envelope)', () => {
  const home = mkdtempSync(join(tmpdir(), 'session-translator-'))
  try {
    const store = createConfigStore({ home })
    store.save({ ...DEFAULT_CONFIG, fontSizePx: 15 })
    const bare = JSON.stringify({ fontSizePx: 16 })
    writeFileSync(store.path, bare, 'utf8')
    assert.equal(store.load().config.fontSizePx, 16)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

process.stdout.write('ollama discovery + direct transport\n')

const { createOllamaClient, discoverOllama, normalizeOllamaEndpoint, ollamaCandidateEndpoints } = await import(
  pathToFileURL(join(lib, 'ollama.js')).href
)

await test('normalizeOllamaEndpoint normalizes schemes, ports, and junk', () => {
  assert.equal(normalizeOllamaEndpoint('127.0.0.1:11434'), 'http://127.0.0.1:11434')
  assert.equal(normalizeOllamaEndpoint('http://localhost:11434/'), 'http://localhost:11434')
  assert.equal(normalizeOllamaEndpoint('https://gpu.box:2244/ollama'), 'https://gpu.box:2244')
  assert.equal(normalizeOllamaEndpoint('ftp://nope'), '')
  assert.equal(normalizeOllamaEndpoint(''), '')
})

await test('ollamaCandidateEndpoints honours the env overrides and dedupes', () => {
  assert.deepEqual(ollamaCandidateEndpoints({ DSH_COT_EN2CN_OLLAMA: 'http://a:1, b:2 ,http://a:1' }), [
    'http://a:1',
    'http://b:2',
  ])
  assert.deepEqual(ollamaCandidateEndpoints({ OLLAMA_HOST: '127.0.0.1:11434' }), [
    'http://127.0.0.1:11434',
    'http://localhost:11434',
  ])
  assert.deepEqual(ollamaCandidateEndpoints({}), ['http://127.0.0.1:11434', 'http://localhost:11434'])
})

await test('discoverOllama reports the first standing endpoint in preference order', async () => {
  const fetchImpl = async (url) => {
    if (String(url).startsWith('http://dead:1')) throw new Error('ECONNREFUSED')
    return {
      ok: true,
      json: async () => ({
        models: [{ name: 'qwen-tr:latest', size: 1, details: { parameter_size: '7B' } }, { name: 'tinyllama' }],
      }),
    }
  }
  const found = await discoverOllama({ fetchImpl, endpoints: ['http://dead:1', 'http://live:2'], timeoutMs: 200 })
  assert.equal(found.found, true)
  assert.equal(found.endpoint, 'http://live:2')
  assert.deepEqual(found.models.map((entry) => entry.id), ['qwen-tr:latest', 'tinyllama'])
  assert.equal(found.models[0].parameterSize, '7B')
  const none = await discoverOllama({
    fetchImpl: async () => {
      throw new Error('down')
    },
    endpoints: ['http://dead:9'],
    timeoutMs: 200,
  })
  assert.equal(none.found, false)
  assert.deepEqual(none.probed, ['http://dead:9'])
})

await test('discoverOllama falls back to /v1/models when /api/tags is unusable', async () => {
  const fetchImpl = async (url) => {
    if (String(url).endsWith('/api/tags')) return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, json: async () => ({ data: [{ id: 'm1' }, { id: 'm2' }] }) }
  }
  const found = await discoverOllama({ fetchImpl, endpoints: ['http://x:1'], timeoutMs: 200 })
  assert.equal(found.found, true)
  assert.deepEqual(found.models.map((entry) => entry.id), ['m1', 'm2'])
})

await test('the direct client yields one text-delta and a stop finish', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) })
    // [PATCH 2026-10-19 endpoint-stream] 服务端忽略 stream:true 时回整段 JSON，
    // 客户端必须按非流式处理（content-type 不是 event-stream）。
    return {
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: '译文在这里' }, finish_reason: 'stop' }] }),
    }
  }
  const client = createOllamaClient('http://gpu:11434', { fetchImpl })
  const chunks = []
  for await (const chunk of client.stream({
    system: '你是翻译引擎',
    model: 'qwen-tr',
    maxTokens: 512,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['text-delta', 'finish'])
  assert.equal(chunks[0].text, '译文在这里')
  assert.deepEqual(chunks[1].reason, { kind: 'stop' })
  assert.equal(seen[0].url, 'http://gpu:11434/v1/chat/completions')
  assert.equal(seen[0].body.model, 'qwen-tr')
  assert.equal(seen[0].body.stream, true)
  assert.equal(seen[0].body.max_tokens, 512)
  assert.deepEqual(seen[0].body.messages, [
    { role: 'system', content: '你是翻译引擎' },
    { role: 'user', content: 'hello' },
  ])
})

await test('the direct client streams SSE deltas as they arrive', async () => {
  const seen = []
  const encoder = new TextEncoder()
  const frames = [
    'data: {"choices":[{"delta":{"content":"第一"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"段译"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ]
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) })
    let index = 0
    return {
      ok: true,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => ({
          read: async () => {
            if (index >= frames.length) return { done: true, value: undefined }
            const value = encoder.encode(frames[index])
            index += 1
            return { done: false, value }
          },
          releaseLock: () => {},
        }),
      },
    }
  }
  const client = createOllamaClient('http://gpu:11434', { fetchImpl })
  const chunks = []
  for await (const chunk of client.stream({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) {
    chunks.push(chunk)
  }
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['text-delta', 'text-delta', 'finish'])
  assert.equal(chunks[0].text, '第一')
  assert.equal(chunks[1].text, '段译')
  assert.deepEqual(chunks[2].reason, { kind: 'stop' })
  assert.equal(seen[0].body.stream, true)
})

await test('the direct client maps finish reasons and surfaces failures', async () => {
  const truncated = createOllamaClient('http://gpu:1', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }) }),
  })
  const chunks = []
  for await (const chunk of truncated.stream({ model: 'm', messages: [] })) chunks.push(chunk)
  assert.deepEqual(chunks[1].reason, { kind: 'max-tokens' })

  const httpFail = createOllamaClient('http://gpu:1', {
    fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'boom' }),
  })
  await assert.rejects(
    async () => {
      for await (const chunk of httpFail.stream({ model: 'm', messages: [] })) void chunk
    },
    /HTTP 500.*boom/,
  )

  const down = createOllamaClient('http://gpu:1', {
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  await assert.rejects(
    async () => {
      for await (const chunk of down.stream({ model: 'm', messages: [] })) void chunk
    },
    /无法连接 Ollama/,
  )

  const empty = createOllamaClient('http://gpu:1', {
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '' } }] }) }),
  })
  await assert.rejects(
    async () => {
      for await (const chunk of empty.stream({ model: 'm', messages: [] })) void chunk
    },
    /没有返回译文/,
  )
})

process.stdout.write('package manifest\n')

await test('the reported VERSION matches package.json', async () => {
  // [PATCH 2026-10-20 version-drift] lib/index.js 的 VERSION 常量曾经停在
  // 0.1.0，跨过改名 / 0.2.1 / 0.2.1-1 / 0.2.1-2 都没跟，于是面板上的版本号
  // 一直显示老值，排查时极易误判"装的是旧包"。这条断言把"记得改"变成机械检查。
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  const source = await readFile(join(here, '..', 'lib', 'index.js'), 'utf8')
  const found = source.match(/const VERSION = '([^']+)'/)
  assert.ok(found !== null, 'lib/index.js must declare const VERSION')
  assert.equal(found[1], manifest.version)
})

await test('the manifest satisfies the DSH bundle + client contract', async () => {
  const manifestPath = join(here, '..', 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  assert.equal(manifest.type, 'module')
  assert.equal(typeof manifest.name, 'string')
  assert.match(manifest.version, /^\d+\.\d+\.\d+/)
  assert.equal(manifest.license, 'MIT')

  // Bundle half: the patch file must exist, and every row it inserts must name
  // this package.
  const patchPath = manifest.dsh?.bundle?.patch
  assert.equal(typeof patchPath, 'string', 'dsh.bundle.patch is required')
  assert.ok(existsSync(join(here, '..', patchPath)), `${patchPath} is missing`)
  const patch = await readFile(join(here, '..', patchPath), 'utf8')
  assert.match(patch, new RegExp(`name:\\s*${manifest.name}`))

  // Client half: platform + an exports["./client"] the loader can resolve.
  assert.equal(manifest.dsh?.client?.platform, 'web')
  const clientExport = manifest.exports?.['./client']
  const clientPath = typeof clientExport === 'string' ? clientExport : clientExport?.default
  assert.equal(typeof clientPath, 'string', 'exports["./client"] is required')
  assert.ok(existsSync(join(here, '..', clientPath)), `${clientPath} is missing`)
  const bundle = await readFile(join(here, '..', clientPath), 'utf8')
  // The module id must be the package name: that is the key the client module
  // table uses and the URL the host serves.
  assert.match(bundle, new RegExp(`__ModuleLoader__\\.load\\(\\{\\s*id:\\s*["']${manifest.name}["']`))

  // Host half: exports["."] must exist too.
  const mainExport = manifest.exports?.['.']
  const mainPath = typeof mainExport === 'string' ? mainExport : mainExport?.default
  assert.equal(typeof mainPath, 'string')
  assert.ok(existsSync(join(here, '..', mainPath)), `${mainPath} is missing`)

  // Everything published must actually be there.
  for (const entry of manifest.files ?? []) {
    assert.ok(existsSync(join(here, '..', entry)), `files[] names a missing path: ${entry}`)
  }
})

await test('the plugin declares no runtime dependencies', async () => {
  const manifest = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf8'))
  // A linked source directory cannot resolve bare @deepseek-ai/* specifiers, so
  // the plugin must stay dependency-free to work in every install shape.
  assert.deepEqual(manifest.dependencies ?? {}, {})
  const sources = ['index.js', 'client.js', 'config.js', 'store.js', 'engine.js', 'text.js', 'languages.js', 'ollama.js', 'anonymous.js']
  for (const file of sources) {
    const source = await readFile(join(lib, file), 'utf8')
    const bare = [...source.matchAll(/^\s*import[^'"]*from\s+'([^'.][^'"]*)'/gm)].map((match) => match[1])
    for (const specifier of bare) {
      assert.ok(specifier.startsWith('node:'), `${file} imports "${specifier}"; only node: builtins are allowed`)
    }
  }
})

process.stdout.write('client bundle\n')

await test('the browser bundle registers and exports apply/inject', async () => {
  let record = null
  globalThis.window = {
    __ModuleLoader__: {
      load(value) {
        record = value
      },
    },
  }
  await import(pathToFileURL(join(lib, 'client.js')).href)
  assert.ok(record !== null, 'client.js did not call __ModuleLoader__.load')
  assert.equal(record.id, 'dsh-session-translator')
  assert.equal(typeof record.factory, 'function')
  const reactStub = {
    createElement: () => ({}),
    useState: () => [undefined, () => {}],
    useRef: () => ({ current: undefined }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useReducer: () => [0, () => {}],
    memo: (fn) => fn,
  }
  const plugin = record.factory((name) => {
    if (name === 'react') return reactStub
    throw new Error(`unexpected require("${name}")`)
  })
  assert.equal(typeof plugin.apply, 'function')
  // [PATCH 2026-10-01 session-cache] 服务声明随本地补丁扩展：sessions 用于取当
  // 前会话 id（不声明则 ctx 上取不到，缓存归属静默退化）。契约变了，断言随之。
  assert.deepEqual([...plugin.inject], ['slots', 'sessions'])
  delete globalThis.window
})

// [PATCH 2026-10-19 fallback-route] 备用路由 + 静默看门狗
process.stdout.write('fallback route\n')

await test('a 504 on the primary route is retried on the fallback route', async () => {
  const calls = []
  const llm = {
    async *stream(request) {
      calls.push(`${request.provider}/${request.model}`)
      if (request.provider === 'primary') throw new Error('HTTP 504 Gateway Time-out')
      yield { type: 'text-delta', text: '备用译文' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, fallbackProvider: 'backup', fallbackModel: 'm' }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  const result = await engine.translate('Hello world, this needs a fallback.', {})
  assert.equal(result.translation, '备用译文')
  assert.deepEqual(calls, ['primary/m', 'backup/m'])
  assert.equal(engine.state().fallbacks, 1)
})

await test('a watchdog abort retries on the fallback route', async () => {
  const calls = []
  const llm = {
    async *stream(request) {
      calls.push(`${request.provider}/${request.model}`)
      if (request.provider === 'primary') {
        yield { type: 'text-delta', text: '部分' }
        await new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
        })
        return
      }
      yield { type: 'text-delta', text: '兜底成功' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, timeoutMs: 60000, fallbackIdleMs: 100, fallbackProvider: 'backup', fallbackModel: 'm' }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  const result = await engine.translate('Watchdog fallback test input.', {})
  assert.equal(result.translation, '兜底成功')
  assert.deepEqual(calls, ['primary/m', 'backup/m'])
})

await test('no fallback is attempted when the pair is incomplete', async () => {
  const calls = []
  const llm = {
    async *stream(request) {
      calls.push(request.provider)
      throw new Error('HTTP 504 Gateway Time-out')
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, fallbackProvider: 'backup', fallbackModel: '' }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  await assert.rejects(() => engine.translate('No fallback configured here.', {}))
  assert.deepEqual(calls, ['primary'])
})

await test('a caller abort is never retried on the fallback route', async () => {
  const calls = []
  const caller = new AbortController()
  const llm = {
    async *stream(request) {
      calls.push(request.provider)
      caller.abort(new Error('reader collapsed the block'))
      throw new Error('HTTP 504 Gateway Time-out')
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, fallbackProvider: 'backup', fallbackModel: 'm' }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  await assert.rejects(() => engine.translate('Caller abort should not retry.', { signal: caller.signal }))
  assert.deepEqual(calls, ['primary'])
})

await test('the fallback result is cached under its own route key', async () => {
  let primaryFails = true
  const calls = []
  const llm = {
    async *stream(request) {
      calls.push(`${request.provider}/${request.model}`)
      if (request.provider === 'primary' && primaryFails) throw new Error('HTTP 504 Gateway Time-out')
      yield { type: 'text-delta', text: `${request.provider} 译文` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, fallbackProvider: 'backup', fallbackModel: 'm' }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  const first = await engine.translate('Cache key separation check.', {})
  assert.equal(first.translation, 'backup 译文')
  // 主路由恢复后，同一段文本必须重新走主路由，而不是读到备用路由的缓存。
  primaryFails = false
  const second = await engine.translate('Cache key separation check.', { force: true })
  assert.equal(second.translation, 'primary 译文')
  assert.deepEqual(calls, ['primary/m', 'backup/m', 'primary/m'])
})

await test('fallbackIdleMs = 0 disables the watchdog', async () => {
  const llm = {
    async *stream(request) {
      yield { type: 'text-delta', text: '慢但正常' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, fallbackIdleMs: 0, fallbackProvider: 'backup', fallbackModel: 'm' }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  const result = await engine.translate('Watchdog disabled still translates.', {})
  assert.equal(result.translation, '慢但正常')
  assert.equal(engine.state().fallbacks, 0)
})

// [PATCH 2026-10-19 fallback-chunk] 备用路由独立分块模板
process.stdout.write('fallback chunk sizing\n')

await test('the whole block is re-run at the fallback chunk size when every chunk fails', async () => {
  const calls = []
  const llm = {
    async *stream(request) {
      const text = request.messages[0].content[0].text
      calls.push({ provider: request.provider, chars: text.length })
      if (request.provider === 'primary') throw new Error('HTTP 504 Gateway Time-out')
      yield { type: 'text-delta', text: '备用译文' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, maxChunkChars: 500, maxInputChars: 100000, fallbackProvider: 'backup', fallbackModel: 'm', fallbackChunkChars: 4000 }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  const text = 'This is a sentence. '.repeat(120) // ~2400 chars → 5 chunks at 500
  const result = await engine.translate(text, {})
  assert.equal(result.translation.includes('备用译文'), true)
  // [PATCH 2026-10-19 fallback-chunk] 探针模式：主路由只发 1 块探路，失败即整段
  // 切备用。不再像早期实现那样跑完 5 块（每块 504 要等满 30s 网关超时）才切。
  const primaryCalls = calls.filter((c) => c.provider === 'primary')
  const backupCalls = calls.filter((c) => c.provider === 'backup')
  assert.equal(primaryCalls.length, 1, 'primary should only be probed with one chunk')
  assert.equal(backupCalls.length, 1, 'backup should have taken the whole block in one request')
  assert.ok(backupCalls[0].chars > 1000, 'the single backup request should be much larger')
  assert.ok(backupCalls[0].chars > primaryCalls[0].chars * 3, 'backup chunk should dwarf the probe chunk')
  // [PATCH 2026-10-20 fallback-counter] 整段重跑也算一次备用路由执行。
  // 旧实现只在单块回退里计数，整段重跑这条路从不 +1，于是面板「备用路由执行
  // 次数」长期显示 0，用户以为兜底一次都没生效（译文其实正是 Bing 出的）。
  assert.equal(engine.state().fallbacks, 1, 'a whole-block re-run must count as one fallback run')
})

await test('the whole-block re-run counts as one fallback run, not one per chunk', async () => {
  // 一轮翻译里备用路由翻了多块，计数仍然只 +1。
  const llm = {
    async *stream(request) {
      if (request.provider === 'primary') throw new Error('HTTP 504 Gateway Time-out')
      yield { type: 'text-delta', text: '备用译文' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, maxChunkChars: 500, maxInputChars: 100000, fallbackProvider: 'backup', fallbackModel: 'm', fallbackChunkChars: 4000 }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  await engine.translate('Another long block. '.repeat(150), {})
  assert.equal(engine.state().fallbacks, 1)
})

await test('no whole-block re-run when only some chunks fail', async () => {
  const calls = []
  let primaryCount = 0
  const llm = {
    async *stream(request) {
      calls.push(request.provider)
      if (request.provider === 'primary') {
        primaryCount += 1
        // 只有第一个块失败，其余成功
        if (primaryCount === 1) throw new Error('HTTP 504 Gateway Time-out')
      }
      yield { type: 'text-delta', text: 'ok' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, maxChunkChars: 500, maxInputChars: 100000, fallbackProvider: 'backup', fallbackModel: 'm', fallbackChunkChars: 4000 }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  const text = 'Another distinct sentence here. '.repeat(80)
  await engine.translate(text, {})
  // 没有整段重跑：backup 只出现在单块回退里，不会出现"整段按 4000 重切"的迹象
  const backupCalls = calls.filter((c) => c === 'backup').length
  assert.ok(backupCalls <= 2, `expected at most a couple of single-chunk fallbacks, got ${backupCalls}`)
})

await test('fallbackChunkChars = 0 keeps the primary chunk size', async () => {
  const calls = []
  const llm = {
    async *stream(request) {
      calls.push({ provider: request.provider, chars: request.messages[0].content[0].text.length })
      if (request.provider === 'primary') throw new Error('HTTP 504 Gateway Time-out')
      yield { type: 'text-delta', text: 'x' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, maxChunkChars: 500, maxInputChars: 100000, fallbackProvider: 'backup', fallbackModel: 'm', fallbackChunkChars: 0 }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  const text = 'Yet another sentence for the test. '.repeat(60)
  await engine.translate(text, {})
  const backupSizes = calls.filter((c) => c.provider === 'backup').map((c) => c.chars)
  // 0 = 跟随主路由，备用请求的块大小应与主路由一致（都很小）
  assert.ok(backupSizes.every((size) => size <= 500), `backup should follow the primary chunk size, got ${JSON.stringify(backupSizes)}`)
})

// [PATCH 2026-10-20 fallback-reason] 失败原因必须写清"备用路由为什么没接住"
process.stdout.write('fallback failure reasons\n')

await test('an unset fallback says so instead of surfacing the raw primary error', async () => {
  const llm = {
    async *stream() {
      throw new Error('翻译卡死：连续 5s 没有新 token')
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, fallbackProvider: '', fallbackModel: '' }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'https://index-translate.bilibili.com', model: 'Index-Translate-35B-A3B', source: 'override' }),
  })
  await assert.rejects(
    () => engine.translate('A sentence that will fail upstream.', {}),
    (error) => {
      assert.match(error.message, /主路由（https:\/\/index-translate\.bilibili\.com\/Index-Translate-35B-A3B）失败/)
      assert.match(error.message, /翻译卡死：连续 5s 没有新 token/)
      assert.match(error.message, /备用路由未设置（渠道与模型都为空），因此没有重试/)
      assert.equal(error.code, 'TRANSLATOR_ROUTE_FAILED')
      return true
    },
  )
})

await test('a half-set fallback names the missing field', async () => {
  const llm = {
    async *stream() {
      throw new Error('HTTP 504')
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, fallbackProvider: 'bing', fallbackModel: '' }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  await assert.rejects(
    () => engine.translate('Half configured fallback here.', {}),
    /备用路由未设置（备用模型为空），因此没有重试/,
  )
})

await test('both routes failing names both sides', async () => {
  const llm = {
    async *stream(request) {
      if (request.provider === 'primary') throw new Error('上游 504')
      throw new Error('Bing 翻译请求失败（HTTP 500）')
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, fallbackProvider: 'bing', fallbackModel: 'bing-translate' }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  await assert.rejects(
    () => engine.translate('Both routes are down right now.', {}),
    (error) => {
      assert.match(error.message, /主路由（primary\/m）失败：上游 504/)
      assert.match(error.message, /备用路由（bing\/bing-translate）也失败：Bing 翻译请求失败（HTTP 500）/)
      return true
    },
  )
})

await test('a fallback identical to the primary is reported as skipped', async () => {
  let calls = 0
  const llm = {
    async *stream() {
      calls += 1
      throw new Error('HTTP 504')
    },
  }
  const engine = createTranslationEngine({
    getConfig: () => ({ ...BASE_CONFIG, fallbackProvider: 'primary', fallbackModel: 'm' }),
    getLlm: () => llm,
    getRoute: () => ({ provider: 'primary', model: 'm', source: 'override' }),
  })
  await assert.rejects(
    () => engine.translate('Same route on both sides.', {}),
    /备用路由与主路由相同（primary\/m），已跳过/,
  )
  // 相同路由不该被真的重试一次。
  assert.equal(calls, 1)
})

await test('a distinct-chunk fallback is reported as deferred, not as "identical"', async () => {
  // [PATCH 2026-10-20 fallback-reason-defer] 回归：主路由 index-translate、备用
  // bing、备用块 10000 > 主块 500 时，单块回退让位给整段重跑。旧实现落进
  // "与主路由相同"分支，报出一句自相矛盾的话（两条路由明明不同）。
  const llm = {
    async *stream() {
      throw new Error('翻译卡死：连续 5s 没有新 token')
    },
  }
  const config = {
    ...BASE_CONFIG,
    maxChunkChars: 500,
    maxInputChars: 100000,
    fallbackProvider: 'bing',
    fallbackModel: 'bing-translate',
    fallbackChunkChars: 10000,
  }
  const engine = createTranslationEngine({
    getConfig: () => config,
    getLlm: () => llm,
    getRoute: () => ({ provider: 'https://index-translate.bilibili.com', model: 'Index-Translate-35B-A3B', source: 'override' }),
  })
  await assert.rejects(
    () => engine.translate('A block long enough to be split into several chunks by the primary size.', {}),
    (error) => {
      // 绝不能再说"与主路由相同"——两条路由并不相同。
      assert.doesNotMatch(error.message, /备用路由与主路由相同/)
      assert.match(error.message, /备用路由（bing\/bing-translate）已改由整段重跑接替/)
      return true
    },
  )
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
