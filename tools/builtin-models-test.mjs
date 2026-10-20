/**
 * dsh-session-translator - offline test for lib/builtin-models.js.
 *
 * [PATCH 2026-10-20 builtin-models-live] 这条链路此前**零覆盖**：/catalog 在
 * host-integration.mjs 里没有任何断言，改坏了只会静静回归。这里用注入的假
 * fetch 把四种结局都钉住：活列表、请求失败、非 200、空 data。
 *
 * Run: node tools/builtin-models-test.mjs
 */
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')

const { fetchBuiltinModels, resetBuiltinModelsCache } = await import(
  pathToFileURL(join(lib, 'builtin-models.js')).href
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

const BASE = 'https://index-translate.bilibili.com'
const FALLBACK = Object.freeze([
  { id: 'Index-Translate-35B-A3B', name: 'Index-Translate 35B-A3B（旗舰）' },
  { id: 'index-mt-9b', name: 'Index-Translate 9B（均衡）' },
])

/** A fetch stand-in that answers with a fixed 200 body. */
function okFetch(ids) {
  return async () => ({
    status: 200,
    json: async () => ({ data: ids.map((id) => ({ id, name: id })) }),
  })
}

await test('a live endpoint reports its real model ids', async () => {
  resetBuiltinModelsCache()
  const out = await fetchBuiltinModels(BASE, {
    fetchImpl: okFetch(['Index-Translate-35B-A3B']),
    fallback: FALLBACK,
  })
  assert.equal(out.live, true)
  assert.deepEqual(out.models.map((m) => m.id), ['Index-Translate-35B-A3B'])
})

await test('a dead model disappears from the list entirely', async () => {
  resetBuiltinModelsCache()
  // 2026-10-20 实测：B 站 /v1/models 只剩旗舰，9B/2b 不在列表里。
  const out = await fetchBuiltinModels(BASE, {
    fetchImpl: okFetch(['Index-Translate-35B-A3B']),
    fallback: FALLBACK,
  })
  const ids = out.models.map((m) => m.id)
  assert.ok(!ids.includes('index-mt-9b'), 'a retired model must not be offered')
})

await test('a brand new model appears without a code change', async () => {
  resetBuiltinModelsCache()
  const out = await fetchBuiltinModels(BASE, {
    fetchImpl: okFetch(['Index-Translate-99B-A3B', 'index-mt-9b']),
    fallback: FALLBACK,
  })
  assert.deepEqual(out.models.map((m) => m.id), ['Index-Translate-99B-A3B', 'index-mt-9b'])
})

await test('a failed request falls back instead of emptying the dropdown', async () => {
  resetBuiltinModelsCache()
  const out = await fetchBuiltinModels(BASE, {
    fetchImpl: async () => { throw new TypeError('fetch failed') },
    fallback: FALLBACK,
  })
  assert.equal(out.live, false)
  assert.deepEqual(out.models.map((m) => m.id), ['Index-Translate-35B-A3B', 'index-mt-9b'])
})

await test('a non-200 status falls back rather than trusting the body', async () => {
  resetBuiltinModelsCache()
  const out = await fetchBuiltinModels(BASE, {
    fetchImpl: async () => ({ status: 500, json: async () => ({ data: [{ id: 'x' }] }) }),
    fallback: FALLBACK,
  })
  assert.equal(out.live, false)
  assert.equal(out.models.length, 2)
})

await test('an empty data array falls back (an empty dropdown is worse)', async () => {
  resetBuiltinModelsCache()
  const out = await fetchBuiltinModels(BASE, {
    fetchImpl: okFetch([]),
    fallback: FALLBACK,
  })
  assert.equal(out.live, false)
  assert.equal(out.models.length, 2)
})

await test('malformed json falls back', async () => {
  resetBuiltinModelsCache()
  const out = await fetchBuiltinModels(BASE, {
    fetchImpl: async () => ({ status: 200, json: async () => { throw new SyntaxError('bad json') } }),
    fallback: FALLBACK,
  })
  assert.equal(out.live, false)
  assert.equal(out.models.length, 2)
})

await test('duplicate ids and blank ids are dropped, order preserved', async () => {
  resetBuiltinModelsCache()
  const out = await fetchBuiltinModels(BASE, {
    fetchImpl: okFetch(['a', '', 'b', 'a']),
    fallback: FALLBACK,
  })
  assert.deepEqual(out.models.map((m) => m.id), ['a', 'b'])
})

await test('a missing name falls back to the id', async () => {
  resetBuiltinModelsCache()
  const out = await fetchBuiltinModels(BASE, {
    fetchImpl: async () => ({ status: 200, json: async () => ({ data: [{ id: 'solo' }] }) }),
  })
  assert.deepEqual(out.models, [{ id: 'solo', name: 'solo' }])
})

await test('a non-http provider is never fetched', async () => {
  resetBuiltinModelsCache()
  let called = 0
  const out = await fetchBuiltinModels('bing', {
    fetchImpl: async () => { called += 1; return { status: 200, json: async () => ({ data: [] }) } },
    fallback: FALLBACK,
  })
  assert.equal(called, 0)
  assert.equal(out.live, false)
  assert.equal(out.models.length, 2)
})

await test('the list is cached within the ttl window', async () => {
  resetBuiltinModelsCache()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { status: 200, json: async () => ({ data: [{ id: 'm' + calls }] }) }
  }
  const first = await fetchBuiltinModels(BASE, { fetchImpl, fallback: FALLBACK, now: 0 })
  const second = await fetchBuiltinModels(BASE, { fetchImpl, fallback: FALLBACK, now: 1000 })
  assert.equal(calls, 1, 'a second call inside the ttl must not hit the network')
  assert.deepEqual(first.models.map((m) => m.id), second.models.map((m) => m.id))
})

await test('the cache expires once the ttl passes', async () => {
  resetBuiltinModelsCache()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return { status: 200, json: async () => ({ data: [{ id: 'm' + calls }] }) }
  }
  await fetchBuiltinModels(BASE, { fetchImpl, fallback: FALLBACK, now: 0, ttlMs: 5000 })
  await fetchBuiltinModels(BASE, { fetchImpl, fallback: FALLBACK, now: 4000, ttlMs: 5000 })
  assert.equal(calls, 1)
  await fetchBuiltinModels(BASE, { fetchImpl, fallback: FALLBACK, now: 6000, ttlMs: 5000 })
  assert.equal(calls, 2, 'a call after the ttl must re-fetch')
})

await test('a failed list is not cached as a success', async () => {
  resetBuiltinModelsCache()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return calls === 1
      ? { status: 500, json: async () => ({ data: [] }) }
      : { status: 200, json: async () => ({ data: [{ id: 'later' }] }) }
  }
  const a = await fetchBuiltinModels(BASE, { fetchImpl, fallback: FALLBACK, now: 0, ttlMs: 5000 })
  assert.equal(a.live, false)
  // 失败也进缓存（避免把一次抖动放大成刷屏请求），但 live=false，
  // ttl 过后会再问一次。
  const b = await fetchBuiltinModels(BASE, { fetchImpl, fallback: FALLBACK, now: 1000, ttlMs: 5000 })
  assert.equal(calls, 1, 'a failure is cached too, so one outage is one request')
  assert.equal(b.live, false)
})

await test('a trailing slash is normalized so the url is not doubled', async () => {
  resetBuiltinModelsCache()
  const seen = []
  const out = await fetchBuiltinModels(BASE + '/', {
    fetchImpl: async (url) => { seen.push(url); return { status: 200, json: async () => ({ data: [{ id: 'x' }] }) } },
    fallback: FALLBACK,
  })
  assert.equal(seen[0], BASE + '/v1/models')
  assert.equal(out.models.length, 1)
})

await test('the caller cannot mutate the cached list', async () => {
  resetBuiltinModelsCache()
  const fetchImpl = okFetch(['a'])
  const first = await fetchBuiltinModels(BASE, { fetchImpl, fallback: FALLBACK })
  first.models.push({ id: 'injected', name: 'injected' })
  const second = await fetchBuiltinModels(BASE, { fetchImpl, fallback: FALLBACK })
  assert.deepEqual(second.models.map((m) => m.id), ['a'])
})

process.stdout.write(`\nbuiltin-models-test: ${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
