/**
 * dsh-cot-en2cn — settings shape and clamping.
 *
 * Deliberately dependency-free: no schema library is imported, so the plugin
 * loads from a linked source directory as happily as from an installed
 * package. The host validates every value with {@link normalizeConfig} before
 * it is stored or used, which also makes a hand-edited config file safe.
 *
 * @module dsh-cot-en2cn/config
 */
import { TARGET_LANGUAGES } from './languages.js'

export { TARGET_LANGUAGES }

/** Directory (under `$DSH_HOME/storages`) that holds this plugin's state. */
export const STORAGE_DIR_NAME = 'cot-en2cn'

/** File name of the persisted settings document. */
export const CONFIG_FILE_NAME = 'config.json'

/** Effective defaults; also the fallback when no file exists yet. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  autoTranslate: true,
  liveTranslate: false,
  targetLanguage: 'zh-CN',
  provider: '',
  model: '',
  disableThinking: true,
  // [PATCH 2026-10-19 panel-split-limits] 默认值按实测收敛：
  //   · 2000：B站 Index-Translate 免费端点 3000 字硬 504，留 33% 余量。
  //   · 50000：单轮思考的实际中位数远低于此，超出部分本就该截断。
  maxChunkChars: 2000,
  maxInputChars: 50000,
  timeoutMs: 120000,
  concurrency: 2,
  cacheEntries: 600,
  skipMostlyChinese: true,
  foldOriginal: false,
  // [PATCH 2026-10-19 err-i18n] 错误提示翻译（默认开）：只在官方未中文化该错误时介入。
  translateErrors: true,
  fontSizePx: 13,
  // [PATCH 2026-10-02 mode-horizon] 地平线行数：自动翻译时，翻译视口内思考行 + 上下各 N 行。
  horizonRows: 5,
  // [PATCH 2026-10-19 fallback-route] 备用路由：主路由失败（504/超时/静默卡死）时
  // 用这一对 provider/model 重试一次。留空 = 不启用备用，行为与旧版完全一致。
  fallbackProvider: '',
  fallbackModel: '',
  // [PATCH 2026-10-19 fallback-route] 静默看门狗：连续 N 毫秒没有新 token 就判定卡死，
  // 主动中断并切备用路由。0 = 关闭看门狗（只靠 timeoutMs 总超时）。
  // 实测健康流式的 token 间隔中位数 26ms、最大 315ms，5000ms 有 14 倍余量。
  fallbackIdleMs: 5000,
  // [PATCH 2026-10-19 fallback-chunk] 备用路由自己的分块模板。
  // 备用路由通常是付费 API（无免费端点的长度限制），把块拉大能减少请求次数，
  // 从而少付"每个块都要重带一次系统提示"的钱。0 = 跟随主路由的 maxChunkChars。
  fallbackChunkChars: 0,
})

const BOOLEAN_KEYS = ['enabled', 'autoTranslate', 'liveTranslate', 'disableThinking', 'skipMostlyChinese', 'foldOriginal', 'translateErrors']

const NUMBER_BOUNDS = {
  maxChunkChars: [200, 20000],
  maxInputChars: [500, 200000],
  timeoutMs: [5000, 600000],
  concurrency: [1, 8],
  cacheEntries: [0, 5000],
  fontSizePx: [11, 18],
  horizonRows: [0, 40],
  // [PATCH 2026-10-19 fallback-route] 0 = 关闭看门狗；上限 120s 防止误设成天文数字。
  fallbackIdleMs: [0, 120000],
  // [PATCH 2026-10-19 fallback-chunk] 0 表示"跟随主路由"，上限与 maxChunkChars 一致。
  fallbackChunkChars: [0, 20000],
}

const LANGUAGE_IDS = new Set(TARGET_LANGUAGES.map((entry) => entry.id))

/**
 * Coerce one possibly-hostile settings document into the effective config:
 * unknown keys are dropped, numbers are clamped, strings are trimmed, and an
 * unknown language falls back to the default.
 *
 * @param value - raw settings document (file content, request body, or memory).
 * @returns a fresh, fully populated config object.
 */
export function normalizeConfig(value) {
  const input = typeof value === 'object' && value !== null ? value : {}
  const next = { ...DEFAULT_CONFIG }
  for (const key of BOOLEAN_KEYS) {
    if (typeof input[key] === 'boolean') next[key] = input[key]
  }
  for (const [key, [min, max]] of Object.entries(NUMBER_BOUNDS)) {
    const raw = input[key]
    if (typeof raw === 'number' && Number.isFinite(raw)) next[key] = Math.min(max, Math.max(min, Math.round(raw)))
  }
  const language = typeof input.targetLanguage === 'string' ? input.targetLanguage.trim() : ''
  next.targetLanguage = LANGUAGE_IDS.has(language) ? language : DEFAULT_CONFIG.targetLanguage
  next.provider = typeof input.provider === 'string' ? input.provider.trim() : ''
  next.model = typeof input.model === 'string' ? input.model.trim() : ''
  // [PATCH 2026-10-19 fallback-route] 备用路由同样是纯字符串字段，trim 后原样保留。
  next.fallbackProvider = typeof input.fallbackProvider === 'string' ? input.fallbackProvider.trim() : ''
  next.fallbackModel = typeof input.fallbackModel === 'string' ? input.fallbackModel.trim() : ''
  return next
}
