/**
 * dsh-cot-en2cn — durable settings document.
 *
 * The plugin keeps its own config rather than a settings namespace, so it
 * needs no schema library and no host service beyond `webServer`. The file
 * lives beside the other plugin state in `$DSH_HOME/storages/cot-en2cn/`, which
 * survives plugin upgrades, reinstalls, and `dsh plugin remove`.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave a
 * half-written document behind.
 *
 * @module dsh-cot-en2cn/store
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize } from 'node:path'
import { CONFIG_FILE_NAME, DEFAULT_CONFIG, STORAGE_DIR_NAME, normalizeConfig } from './config.js'
import { hashText } from './text.js'

/**
 * Resolve the DeepSeek Harness home with the same precedence the harness uses:
 * `$DSH_HOME` when set to something other than whitespace, else `~/.dsh`.
 *
 * @param env - environment mapping (defaults to `process.env`).
 * @returns the absolute harness home directory.
 */
export function resolveDshHome(env = process.env) {
  const configured = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  if (configured !== '') return normalize(isAbsolute(configured) ? configured : join(process.cwd(), configured))
  return join(homedir(), '.dsh')
}

/** Absolute path of the settings document for one harness home. */
export function configFilePath(home) {
  return join(home, 'storages', STORAGE_DIR_NAME, CONFIG_FILE_NAME)
}

/**
 * Create the config store.
 *
 * @param options - `home` overrides the resolved harness home (tests).
 * @returns `{ path, load, save }`, where `load` never throws and `save` reports
 *   its own failure to the caller.
 */
export function createConfigStore(options = {}) {
  const home = options.home ?? resolveDshHome(options.env)
  const file = configFilePath(home)

  return {
    path: file,

    /**
     * Read the persisted document.
     * @returns `{ config, source }` — `source` is `'file'`, `'defaults'`, or
     *   `'invalid'` when a file existed but could not be used.
     */
    load() {
      let raw
      try {
        raw = readFileSync(file, 'utf8')
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
          return { config: { ...DEFAULT_CONFIG }, source: 'defaults' }
        }
        return { config: { ...DEFAULT_CONFIG }, source: 'invalid', error: String(error?.message ?? error) }
      }
      try {
        const parsed = JSON.parse(raw)
        const section = typeof parsed?.config === 'object' && parsed.config !== null ? parsed.config : parsed
        return { config: normalizeConfig(section), source: 'file' }
      } catch (error) {
        return { config: { ...DEFAULT_CONFIG }, source: 'invalid', error: String(error?.message ?? error) }
      }
    },

    /**
     * Persist one config atomically.
     * @param config - the config to store (normalized again here).
     */
    save(config) {
      const next = normalizeConfig(config)
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp-${String(process.pid)}`
      try {
        writeFileSync(temporary, `${JSON.stringify({ version: 1, config: next }, null, 2)}\n`, 'utf8')
        renameSync(temporary, file)
      } catch (error) {
        try {
          rmSync(temporary, { force: true })
        } catch {
          /* best effort */
        }
        throw error
      }
      return next
    },
  }
}

// [PATCH 2026-10-01 session-cache] 会话级译文缓存：文件落在该会话自己的文件夹
// （`$DSH_HOME/sessions/<project>/<sessionId>/cot-en2cn-translations.json`），
// 会话删除时整个文件夹被移除、译文随之消失——生命周期与会话绑定，插件存储区
// 不留孤儿。同步维护 _analysis\session-cache-test.mjs。

/** File name of one session's translation cache (inside the session folder). */
export const SESSION_CACHE_FILE_NAME = 'cot-en2cn-translations.json'

/** Per-session entry ceiling (oldest entries pruned on write). */
export const SESSION_CACHE_MAX = 500

/**
 * Session ids become path segments: require an alnum-led, conservative charset
 * and a bounded length, and refuse dot segments, so a hostile value can never
 * escape the sessions tree.
 *
 * @param value - raw session key from a request body.
 * @returns the sanitized key, or '' when unusable.
 */
export function sanitizeSessionKey(value) {
  const key = typeof value === 'string' ? value.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) return ''
  if (key.includes('..')) return ''
  return key
}

/** Cache key for one request: resolved route + target language + text. */
export function sessionCacheKey(provider, model, language, text) {
  return `${provider}/${model}|${language}|${hashText(String(text))}`
}

/**
 * Resolve `<home>/sessions/<project>/<sessionKey>` by scanning project dirs
 * (the harness nests sessions one workspace level deep). Session artifacts are
 * fixed-name files (`session.v*.jsonl[.zstd]`), so an extra cache file in the
 * folder is invisible to session enumeration.
 *
 * @param home - harness home directory.
 * @param sessionKey - raw or sanitized session id.
 * @returns the session directory, or null when it does not exist.
 */
export function resolveSessionDir(home, sessionKey) {
  const key = sanitizeSessionKey(sessionKey)
  if (key === '') return null
  const root = join(home, 'sessions')
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  // 会话文件夹名与服务侧 id 可能互带 `session-` 前缀（实测两者都存在过），
  // 裸 id 与带前缀 id 都接受——按名精确匹配，无路径拼接风险。
  const bare = key.startsWith('session-') ? key.slice('session-'.length) : key
  const wanted = new Set([bare, `session-${bare}`])
  for (const project of projects) {
    if (!project.isDirectory()) continue
    let entries
    try {
      entries = readdirSync(join(root, project.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory() && wanted.has(entry.name)) return join(root, project.name, entry.name)
    }
  }
  return null
}

/**
 * Per-session translation cache: read-through before a model call, write-through
 * after it. Every failure is swallowed — a cache problem must never fail a
 * translation.
 *
 * @param options - `home` overrides the resolved harness home (tests); `max`
 *   overrides the per-session entry ceiling.
 * @returns `{ file, get, put }`.
 */
export function createSessionCache(options = {}) {
  const home = options.home ?? resolveDshHome(options.env)
  const max = options.max ?? SESSION_CACHE_MAX
  const dirs = new Map()

  function fileOf(sessionKey) {
    const key = sanitizeSessionKey(sessionKey)
    if (key === '') return null
    let dir = dirs.get(key)
    if (dir === undefined) {
      dir = resolveSessionDir(home, key)
      if (dir !== null) dirs.set(key, dir)
    }
    return dir === null ? null : join(dir, SESSION_CACHE_FILE_NAME)
  }

  function readEntries(file) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      return typeof parsed?.entries === 'object' && parsed.entries !== null ? parsed.entries : {}
    } catch {
      return {}
    }
  }

  return {
    file: fileOf,

    /** @returns a renderable payload for `key`, or undefined on miss. */
    get(sessionKey, key) {
      const file = fileOf(sessionKey)
      if (file === null) return undefined
      const entry = readEntries(file)[key]
      if (entry === undefined || typeof entry.translation !== 'string') return undefined
      return {
        translation: entry.translation,
        route: entry.route,
        skipped: entry.skipped,
        chunks: entry.chunks ?? 0,
        cached: true,
        ms: 0,
        sessionCached: true,
      }
    },

    /** Persist one engine result; prunes the oldest beyond `max`. */
    put(sessionKey, key, result) {
      const file = fileOf(sessionKey)
      if (file === null) return false
      if (typeof result?.translation !== 'string' || result.translation === '') return false
      try {
        const entries = readEntries(file)
        entries[key] = {
          translation: result.translation,
          route: result.route,
          skipped: result.skipped,
          chunks: result.chunks ?? 0,
          ts: Date.now(),
        }
        const keys = Object.keys(entries)
        if (keys.length > max) {
          keys.sort((a, b) => (entries[a].ts ?? 0) - (entries[b].ts ?? 0))
          for (const stale of keys.slice(0, keys.length - max)) delete entries[stale]
        }
        mkdirSync(dirname(file), { recursive: true })
        const temporary = `${file}.tmp-${String(process.pid)}`
        try {
          writeFileSync(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
          renameSync(temporary, file)
        } catch (error) {
          try {
            rmSync(temporary, { force: true })
          } catch {
            /* best effort */
          }
          throw error
        }
        return true
      } catch {
        return false
      }
    },
  }
}
