/**
 * dsh-session-translator — 匿名翻译渠道（Bing）单元测试。
 *
 * 不碰外网：全部用注入的 `fetchImpl` 假实现，验证请求形状、响应解析、
 * 语言 tag 映射、看门狗心跳与错误透传。
 *
 * Run: node tools/anonymous-test.mjs
 */
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')

const { BING_ENDPOINT, bingLanguageTag, createBingClient } = await import(
  pathToFileURL(join(lib, 'anonymous.js')).href
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

/** Collect one client's whole stream. */
async function drain(client, request) {
  const chunks = []
  for await (const chunk of client.stream(request)) chunks.push(chunk)
  return chunks
}

/** A fake Response carrying JSON. */
function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => value,
    text: async () => JSON.stringify(value),
  }
}

process.stdout.write('anonymous transports\n')

await test('bingLanguageTag maps Simplified/Traditional and passes the rest through', () => {
  assert.equal(bingLanguageTag('zh-CN'), 'zh-Hans')
  assert.equal(bingLanguageTag('zh-TW'), 'zh-Hant')
  assert.equal(bingLanguageTag('zh'), 'zh-Hans')
  assert.equal(bingLanguageTag('en'), 'en')
  assert.equal(bingLanguageTag('ja'), 'ja')
})

await test('the Bing client posts one text array to the anonymous endpoint', async () => {
  const seen = []
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init })
    return jsonResponse([{ translations: [{ text: '译文来自 Bing' }] }])
  }
  const chunks = await drain(createBingClient({ fetchImpl }), {
    targetLanguage: 'zh-CN',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello world.' }] }],
  })
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['text-delta', 'finish'])
  assert.equal(chunks[0].text, '译文来自 Bing')
  assert.deepEqual(chunks[1].reason, { kind: 'stop' })

  const url = new URL(seen[0].url)
  assert.equal(`${url.origin}${url.pathname}`, BING_ENDPOINT)
  assert.equal(url.searchParams.get('to'), 'zh-Hans')
  assert.equal(url.searchParams.get('isEnterpriseClient'), 'false')
  assert.deepEqual(JSON.parse(seen[0].init.body), ['Hello world.'])
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.redirect, 'error')
  assert.equal(seen[0].init.credentials, 'omit')
  // 匿名接口没有 system 概念：绝不能把中文系统提示当正文发过去。
  assert.equal(String(seen[0].init.body).includes('翻译引擎'), false)
})

await test('the Bing client accepts a string message content too', async () => {
  let body = null
  const fetchImpl = async (_url, init) => {
    body = JSON.parse(init.body)
    return jsonResponse([{ translations: [{ text: '好' }] }])
  }
  const chunks = await drain(createBingClient({ fetchImpl }), {
    targetLanguage: 'zh-CN',
    messages: [{ role: 'user', content: 'Plain string content.' }],
  })
  assert.equal(chunks[0].text, '好')
  assert.deepEqual(body, ['Plain string content.'])
})

// 说明：宿主自带的 dsh-experimental-translator 还支持 Google 匿名端点
// （translate.googleapis.com/translate_a/single，gtx 表单）。本机实测不通
// （直连 fetch failed、走代理 429），所以本插件**不提供**该渠道，这里也就没有
// 对应用例——测一个不发货的渠道只会增加噪声。

await test('an HTTP failure surfaces the status and the body', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 429,
    headers: { get: () => 'text/plain' },
    text: async () => 'rate limited',
  })
  await assert.rejects(
    () => drain(createBingClient({ fetchImpl }), { targetLanguage: 'zh-CN', messages: [{ role: 'user', content: 'x' }] }),
    /Bing 翻译请求失败（HTTP 429）：rate limited/,
  )
})

await test('an unexpected payload fails instead of returning junk', async () => {
  const fetchImpl = async () => jsonResponse({ nope: true })
  await assert.rejects(
    () => drain(createBingClient({ fetchImpl }), { targetLanguage: 'zh-CN', messages: [{ role: 'user', content: 'x' }] }),
    /Bing 没有返回译文内容/,
  )
})

await test('a network failure is reported with the host name', async () => {
  const fetchImpl = async () => {
    throw new Error('fetch failed')
  }
  await assert.rejects(
    () => drain(createBingClient({ fetchImpl }), { targetLanguage: 'zh-CN', messages: [{ role: 'user', content: 'x' }] }),
    /无法连接 Bing 翻译（edge\.microsoft\.com）：fetch failed/,
  )
})

await test('an empty text finishes without any request', async () => {
  let called = 0
  const fetchImpl = async () => {
    called += 1
    return jsonResponse([])
  }
  const chunks = await drain(createBingClient({ fetchImpl }), {
    targetLanguage: 'zh-CN',
    messages: [{ role: 'user', content: [{ type: 'text', text: '   ' }] }],
  })
  assert.equal(called, 0)
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['finish'])
})

await test('a slow round trip is bridged with heartbeat chunks', async () => {
  // 引擎的看门狗只认「有没有新 chunk」；整段返回的接口必须自己喂心跳，否则
  // 大块文本会被 fallbackIdleMs（默认 5s）误判成卡死。
  const fetchImpl = async () => {
    await new Promise((resolve) => setTimeout(resolve, 260))
    return jsonResponse([{ translations: [{ text: '慢但成功' }] }])
  }
  const chunks = await drain(createBingClient({ fetchImpl, heartbeatMs: 60 }), {
    targetLanguage: 'zh-CN',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Slow one.' }] }],
  })
  const heartbeats = chunks.filter((chunk) => chunk.type === 'heartbeat')
  assert.ok(heartbeats.length >= 2, `expected >=2 heartbeats, got ${heartbeats.length}`)
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').length, 1)
  assert.equal(chunks[chunks.length - 1].type, 'finish')
})

await test('a fast round trip emits no heartbeat at all', async () => {
  const fetchImpl = async () => jsonResponse([{ translations: [{ text: '快' }] }])
  const chunks = await drain(createBingClient({ fetchImpl, heartbeatMs: 5000 }), {
    targetLanguage: 'zh-CN',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Fast one.' }] }],
  })
  assert.equal(chunks.filter((chunk) => chunk.type === 'heartbeat').length, 0)
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['text-delta', 'finish'])
})

await test('an already-aborted caller never issues a request', async () => {
  let called = 0
  const controller = new AbortController()
  controller.abort(new Error('reader collapsed the block'))
  const fetchImpl = async (_url, init) => {
    called += 1
    if (init.signal?.aborted === true) throw init.signal.reason
    return jsonResponse([{ translations: [{ text: '不该到这里' }] }])
  }
  await assert.rejects(
    () =>
      drain(createBingClient({ fetchImpl, heartbeatMs: 50 }), {
        targetLanguage: 'zh-CN',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Cancelled.' }] }],
        signal: controller.signal,
      }),
    /reader collapsed the block/,
  )
  assert.equal(called, 1)
})

process.stdout.write(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exitCode = 1
