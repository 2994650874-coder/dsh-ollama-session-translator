# dsh-session-translator

A Web plugin for DeepSeek Harness (DSH). When a model thinks in English, expanding the "Thinking" block automatically displays the Chinese translation right below the original text—without modifying a single byte of the original content.

```text
+-- Thinking -------------------------------------------------------------
|  Let me check whether the settings service is mounted before calling
|  register on it, otherwise the row would throw.
|
|  | 中文译文 · deepseek/deepseek-chat            [重新翻译] [复制] [收起]
|  | 我先确认 settings 服务是否真的挂载了，否则注册这一行会抛错。
+------------------------------------------------------------------------
```

## Table of Contents

- [Why This Plugin](#why-this-plugin)
- [Requirements](#requirements)
- [Installation & Setup](#installation--setup)
- [How It Works](#how-it-works)
- [Configuration Options](#configuration-options)
- [Technical Architecture & Guarantees](#technical-architecture--guarantees)
- [Code Map & Reading Path](#code-map--reading-path)
- [Privacy & Resource Usage](#privacy--resource-usage)
- [FAQ](#faq)
- [Quality Assurance](#quality-assurance)
- [Project Structure](#project-structure)
- [Changelog (maintained fork)](#changelog-maintained-fork)
- [License](#license)

## Why This Plugin

When working with reasoning models such as DeepSeek, GLM, or Gemini, chain-of-thought outputs are frequently generated in English. Reading through extensive English reasoning chains is mentally exhausting for native Chinese speakers.

`dsh-session-translator` solves this directly:
- **Zero Session Mutation**: Leaves conversation history completely untouched. It only injects a presentation panel in the browser DOM.
- **Cost & Token Efficient**: Collapsed blocks are never translated; Chinese text is skipped automatically; translations are cached on both server and client.
- **Zero Runtime Dependencies**: Uses Node.js standard library exclusively, importing zero third-party packages.

> **This repository is a maintained fork of [Eyeing0721/dsh-cot-en2cn](https://github.com/Eyeing0721/dsh-cot-en2cn).**
> Thanks to the original author. This fork adds the following on top of it:
>
> **Why it will not cause you trouble**
>
> - **Zero dependency on DSH internals**: not a single `@deepseek-ai/*` import in the repository, and `dependencies` is empty. When DSH restructures its internals, other plugins die with `import failed` — this one keeps running.
> - **No render-tree surgery**: it claims no slot and replaces no official component; it only appends its own DOM node next to the thinking block. Worst case after a DSH UI change is that the translation quietly stops appearing, never a broken chat interface.
> - **No session-data writes**: it does not write session logs, does not appear in trajectory views, and does not touch the KV cache or context compaction. Your context window stays byte-for-byte what it was before installing.
> - **No leftovers**: the translation cache lives inside each session's own folder, so uninstalling the plugin or deleting a session removes it. There is no orphaned file in a third-party directory.
> - **Compatibility**: verified on DSH Desktop 0.2.1-rc.3, but it only uses three stable APIs (`webServer`, `slots`, `locale`) and needed no change from the rc era through 0.2.1.
>
> **Feature highlights**
>
> - **Fallback route + silence watchdog**: when the primary route 504s, times out, or goes silent, retry once on a backup channel. The watchdog keys on "how long since the last new token" rather than total elapsed time (a total timeout kills slow-but-healthy requests).
> - **Independent fallback chunk size**: paid channels have no length cap, so the backup route can use a larger chunk size. When the primary route is entirely down, one probe chunk decides the switch, instead of waiting out N x 30s gateway timeouts.
> - **Built-in Index-Translate channel**: Bilibili's free translation API ships as a built-in channel ranked first in the provider list — no endpoint URL, no API key.
> - **Built-in Bing fallback**: an anonymous, key-free Bing translation channel ships as the **default fallback route** — when the primary channel dies, translation keeps working without a key, without a DSH channel registration, and without spending quota.
> - **Rebuilt settings panel**: hand-drawn dropdowns (Electron closes native popups on any parent re-render), draft + manual save (Ctrl+S included), buffered number inputs, and per-route quota settings.
> - **Environment adaptation**: adapted to DSH Desktop 0.2.1-rc.3 (relaxed same-origin checks in the desktop webview, sessions API differences, dual-strategy thinking-block DOM lookup).

## Requirements

- DSH `>=0.1.0-rc.5`
- Node.js `>=20`

## Installation & Setup

### Install from GitHub (recommended)

```bash
dsh plugin --profile desktop add https://github.com/2994650874-coder/dsh-session-translator.git
```

If the download stalls in mainland China, set a proxy for the current shell first:

```powershell
$env:HTTPS_PROXY = 'http://127.0.0.1:7897'
```

### Install from Local Directory (Development)

```bash
dsh plugin --profile desktop add /path/to/dsh-session-translator
```

> Note: If linked from a local directory, do not move or delete the source folder; otherwise, the plugin registration will break.

After installing, **restart the DSH desktop app** and refresh your browser.

### Removal

```bash
dsh plugin --profile desktop remove dsh-session-translator
```

Configuration files stored under the storages directory are preserved upon removal.

## How It Works

1. **Inline Display**: Expanding any thinking block renders the translated text directly beneath the original reasoning text. The panel features a vertical border on the left, an informational header indicating the model used, cache status, and response latency, and three action controls: `重新翻译` (Retranslate), `复制` (Copy), and `收起` (Collapse).
2. **Trigger Rules**:
   - Collapsed thinking blocks are **never translated** and incur zero cost.
   - If a block is opened while still streaming, the plugin waits until streaming completes before dispatching a translation request, displaying "模型还在思考，结束后自动翻译…".
   - Texts that are already in Chinese are **skipped immediately** without LLM invocation.
3. **Chunking & Caching**: Long inputs are split along paragraphs, line breaks, or sentences (default 3000 characters/chunk) and cached chunk-by-chunk. Up to 600 chunks are cached server-side alongside client-side memory. Re-expanding blocks or reloading pages does not trigger repeated requests.
4. **Settings UI**: Available at **Settings → Plugins → 「dsh-session-translator」**. The configuration screen includes a real-time status card (active routing, cache hits, call counts, latency, recent errors, configuration path), toggles, provider/model fields ("Fetch Models" auto-discovers a local Ollama and its live models — click a model to fill in; "Clear (no translation)" drops the route), numeric parameter inputs, cache clearing, reset options, and an inline testing sandbox.

## Configuration Options

Config file: `$DSH_HOME/storages/session-translator/config.json` (not in `settings.yaml`, no schema library). Hand-editing it is safe: every value is validated and clamped on load.

### Panel layout

Six cards plus a standalone save bar at the bottom:

```text
Status      active model / fallback route / fallback runs (each with a "Test" button)
Basics      enabled, translate while thinking
Mode        auto / manual, horizon rows
Model       channel / provider, model, fetch model list
Fallback    fallback channel, fallback model, fallback max chars per request, silence timeout
Advanced    disable thinking, skip already-Chinese, folded translate,
            target language, max chars per request, max reasoning length,
            concurrency, translation font size
Try it      paste English to preview
──────────────────────────────────────────────────────────────
Save bar    All changes saved            [Discard] [Save]
```

**The panel is draft-based with explicit save.** Every edit lands in a local draft; nothing is written until you press **Save** (or `Ctrl+S`). Unsaved changes are announced both in the header and in the save bar, and the Save button turns from grey to normal. After a successful save it returns to grey immediately, with no intermediate flash. **Discard** reverts to the server's current values.

The preview box and both "Test" buttons evaluate the **current draft** without saving — the draft is used for that one request only and is never persisted.

### Fields

| Field | Default | Meaning |
|---|---|---|
| Enable CoT translation | on | Master switch. Turning it off removes every panel; the original text is untouched. |
| Translate while thinking | off | Translate while the model is still streaming (more model calls, more tokens). |
| Translation mode | auto | Auto: translate thinking rows in view ± horizon. Manual: each block waits for a click. |
| Horizon rows | 5 | In auto mode, translate N rows above and below the viewport. |
| Channel / provider | empty | Which channel handles translation. The list is DSH's registered channels plus the **two built-in free channels (Index-Translate / Bing)**. A "custom endpoint" toggle accepts an `http(s)://` URL for any OpenAI-compatible service. **Empty means no translation** — it never silently falls back to a paid default model. |
| Model | empty | Model under the selected channel. Cleared when the channel changes. |
| Fallback channel | **Bing** | Channel to retry on when the primary route fails. Defaults to the **built-in anonymous Bing channel** (no key, no quota). Empty disables the fallback. |
| Fallback model | empty | Same as above. |
| Fallback max chars per request | 0 | The fallback route's own chunk size. Paid channels have no length cap, so a larger chunk means fewer requests. **0 follows the primary route.** |
| Silence timeout | 5000 ms | If no new token arrives for this long, the call is treated as stuck and the fallback route takes over. The criterion is "time since last token", not total elapsed time — measured healthy streams have a median 26 ms gap and a 315 ms maximum, so 5000 ms carries a 14x margin. 0 disables the watchdog. |
| Disable thinking (recommended) | on | Sends `reasoningEffort: "off"` so translation produces no hidden reasoning tokens. **Not every channel supports it**: unsupported routes are detected and retried without the field, then remembered. Measured: 3800 characters dropped from 27.2 s to 3.1 s. |
| Skip already-Chinese reasoning | on | Skip blocks that are already Chinese. Threshold: at most 16 Latin letters, or CJK >= Latin x 6. Mixed content is always translated. |
| Folded translate | off | Translate even while the block is collapsed (reads the source from the React fiber). |
| Target language | zh-CN | Also 繁體中文 / English / 日本語. |
| Max chars per request | 2000 | Characters sent to the provider **per request**. Free providers have a cap (Bilibili's model stops at 3000 characters); raise it after switching channels. Smaller is safer against max-tokens truncation but needs more requests. |
| Max reasoning length per translation | 50000 | Total character cap for **one reasoning block** (500–200000). Beyond it the text is clipped at the last complete paragraph and everything past the cut is dropped, with a "source too long" note. |
| Concurrency | 2 | Simultaneous provider requests. Free endpoints should stay at 2: measured 2 x 2000 characters is safe, 4 fails. |
| Translation font size | 13px | Affects the translation panel only. |

> **The two limits are independent.** `Max reasoning length` decides how much of one reasoning block is translated at all; `Max chars per request` decides how big each request is. Multiplying them is meaningless.

> `timeoutMs` (total per-call timeout) and `cacheEntries` (server cache size) still live in the config file and are still used by the engine, but are **no longer exposed in the panel**: a total timeout kills slow-but-healthy requests (the watchdog owns that judgement now), and translations are injected into the session folder so the server-side LRU is only a per-session dedupe cache.

## Technical Architecture & Guarantees

The plugin consists of two runtime boundaries:
- **Host Process (`lib/index.js`)**: Registers eight localhost-only, same-origin HTTP routes:
  - `GET /dsh-session-translator/state` — config + counters + effective route
  - `PUT /dsh-session-translator/config` — write the whole config (the panel's only save path)
  - `POST /dsh-session-translator/translate` — translate one text (optional one-shot draft override)
  - `GET /dsh-session-translator/providers` — registered DSH channels
  - `GET /dsh-session-translator/models` — models under a channel
  - `GET /dsh-session-translator/catalog` — channel + model catalog (built-in channel first)
  - `POST /dsh-session-translator/test` — primary / fallback route connectivity check
  - `POST /dsh-session-translator/cache/clear` — clear the server cache
  Translations are dispatched via DSH's internal `ctx.llm.stream()`, reusing existing credentials and model profiles configured in DSH; when the Provider is an `http(s)://` endpoint the plugin talks to that Ollama's OpenAI-compatible API (`/v1/chat/completions`) directly, so a local model needs zero configuration. External and non-loopback requests are blocked.
- **Browser Client (`lib/client.js`)**: Watches the active chat container using `MutationObserver`, anchors thinking blocks using the stable `data-variant="think"` attribute (with fallback class names), and mounts translation views directly into the DOM tree.

Why not use official slots: DSH does not offer a dedicated slot for individual thinking segments. Overriding `conversation.chat.node` would discard the entire assistant renderer. Lightweight DOM augmentation provides stable attachment without platform side-effects.

Four guarantees follow:

1. **Zero Session Mutation**: Translation outputs are never written to conversation records, trajectory views, KV caches, or context compression pipelines. Your context window stays byte-for-byte what it was before installing.
2. **Complete Cleanliness**: Disabling or removing the plugin restores the vanilla UI instantly.
3. **Safe Degradation**: If DSH updates its DOM structure in future versions, the plugin fails silently without breaking chat interactions.
4. **Version-proof**: it uses exactly three DSH APIs — `webServer` (route registration), `slots` (one settings card), and `locale` (zh/en strings). All three are stable surfaces, and every call is guarded by a `typeof === 'function'` check so a missing service silently skips that feature. It neither statically imports DSH internal packages nor reads or writes the DSH session-log format, so format migrations like v3 → v4 are none of its business.

### Why the translation cache cannot pollute a session

This is the most natural suspicion, so here is the detail. The cache file is named `session-translator-translations.json` and sits inside the session directory.

DSH's own session log is named `session.v4.jsonl.zstd` (or `session.v4.jsonl` uncompressed). When DSH looks up a session log it applies a strict filename match: after stripping the compression suffix the name must be `session` or `session.vN`, and it must end in `.jsonl`. `session-translator-translations.json` satisfies none of the three, so DSH skips it outright.

Moreover, reading a session opens exactly the one file that survived that filter — the directory is not enumerated. So the ~700 KB cache is invisible to both you and the model: it is only the plugin's own scratchpad.

Deleting the session removes the cache with it. Nothing is left behind.

## Code Map & Reading Path

> About to modify this plugin? Start from the table below. Line counts drift with every change; the responsibilities and key symbols are what stay stable.

### File map

| File | Lines | Responsibility |
|---|---|---|
| `lib/index.js` | ~617 | **Host entry point**. Registers the eight same-origin routes, owns the config, builds the engine, assembles `statePayload`. |
| `lib/engine.js` | ~602 | **Translation engine**. Chunking → concurrency gate → model call → cache. Fallback route, silence watchdog and probe mode live here. |
| `lib/client.js` | ~2223 | **Browser half**. Two parties: the translation panels (DOM augmentation) and the settings panel (React). |
| `lib/text.js` | ~158 | **Pure functions**. Chunking, boundary clipping, script detection, token estimation. No side effects, easiest to test. |
| `lib/config.js` | ~102 | Defaults plus `normalizeConfig` validation and clamping. |
| `lib/store.js` | ~263 | Atomic read/write for the config file and the session-level translation cache. |
| `lib/ollama.js` | ~281 | Ollama endpoint discovery and an OpenAI-compatible client (SSE streaming). |
| `lib/languages.js` | ~23 | Target-language table. |

### Find the entry point by task

| I want to change… | Look at |
|---|---|
| one control in the panel | `createSection()` in `client.js` (around L ~1293) |
| add a backend route | `ROUTES` plus the `route()` calls in `index.js` |
| chunking / clipping / Chinese detection | `text.js` |
| fallback route, watchdog, retry policy | `callModel()` and `translate()` in `engine.js` |
| translation panel rendering and interaction | the `inline translator` section of `client.js` (around L ~320) |
| config defaults / allowed ranges | `DEFAULT_CONFIG` and `NUMBER_BOUNDS` in `config.js` |

### The four sections of `lib/client.js`

The largest file is divided by banner comments into four sections:

| Section | Starts at | Contents |
|---|---|---|
| utilities | L~274 | Session key, hashing, HTTP wrappers, browser-side cache |
| inline translator | L~320 | Translation panels: DOM observer, thinking-block lookup, panel injection, selection protection, live streaming |
| settings UI | L~1030 | Settings panel: `createSection()`, `Dropdown`, `NumberInput`, the six cards |
| wiring | L~2136 | `apply(ctx)`: locale registration, sessions binding, slot mounting |

### Invariants (read before editing)

1. **The original text is never modified.** The plugin only inserts nodes into the DOM; it never touches session records, trajectory views or the KV cache.
2. **The panel is draft-based with explicit save.** `edit()` only mutates the local draft; `saveAll()` is the single path to disk.
3. **`group()` children may contain arrays** (the return value of `.map()`). Flatten them before attaching keys, or React renders an object and the whole page goes blank.
4. **Disable thinking with `reasoningEffort: 'off'`**, not `purpose`. DSH's `purpose` only affects a `compaction` header.
5. **The two limits mean different things**: `maxInputChars` decides how much of one reasoning block is translated at all, `maxChunkChars` decides how big each request is.

### Verify after editing

```bash
node tools/smoke.mjs              # 60: chunking, cache, concurrency, fallback, clamping
node tools/select-safe-test.mjs   # 11: idempotent panel writes, selection protection
node tools/dispose-test.mjs       # 40: resource lifecycle, disposer ownership
node tools/host-integration.mjs   # 17: routes, config persistence, loopback guard
```

All three must be green before committing. `browser-check.mjs` needs a real browser and fails in browserless environments.

## Privacy & Resource Usage

- **Zero Key Access**: The plugin does not manage, log, or request API keys. Calls run entirely through DSH's internal routing.
- **Predictable Overhead**: Only expanded, non-Chinese, completed thinking blocks are sent. Concurrency is throttled (default 2), with individual timeouts enforced (default 120s).
- **Fully Local**: Operates strictly between the local Node.js process and the local browser instance.

## FAQ

**Q: No translation appears after expanding a thinking block?**
A: Check the following in order:
1. Ensure "启用 CoT 中文翻译" is turned on in the settings panel.
2. Verify if the block is still actively streaming (by default, translation waits for the stream to conclude).
3. Check if the original thinking text is already Chinese (these are skipped intentionally).
4. Inspect the translation area for error banners such as timeouts.

**Q: The panel reports "翻译模型未设置" (translation model not set)?**
A: One or both of Provider/Model are empty in the plugin settings. Both must be filled; the plugin never silently falls back to the paid default model. With a local Ollama running, "Fetch Models" discovers it and fills the fields in one click.

**Q: The output is truncated due to max-tokens limits?**
A: Decrease the "单块字符数" (Chunk character limit) in settings (e.g., to 1500).

**Q: Does translation output appear in Trajectory views?**
A: No. The plugin only mounts visual nodes inside the active conversational chat view.

**Q: Could the translation cache written into the session folder be fed to the model as context?**
A: No. The cache file is `session-translator-translations.json`, while DSH only recognises names like `session.v4.jsonl.zstd` — the name must match `session` or `session.vN` and end in `.jsonl`. Our filename satisfies none of the three, so DSH skips it when looking up session logs. Reading a session opens exactly one log file; the directory is never enumerated. See "Why the translation cache cannot pollute a session" above.

**Q: Will this plugin break after a DSH upgrade?**
A: It imports no DSH internal package, claims no slot, and never touches the render tree — only the three stable APIs `webServer` / `slots` / `locale`, each guarded by an existence check. After an upgrade the worst case is that a changed thinking-block DOM stops the translation from rendering; in other words it goes quiet rather than breaking your UI.

**Q: Does it conflict with other UI extensions?**
A: No. It occupies no predefined slot IDs and does not replace core renderers. Click events inside the translation block are captured and stopped from bubbling, preventing unintentional folding of parent thinking accordions.

**Q: Which name goes in the remove/upgrade command?**
A: **`dsh-session-translator` — that is the only name.**

Since 2026-10-19 the technical package name and the display name are unified:
`package.json`'s `name`, the cordis plugin id, the `/dsh-session-translator/*`
route prefix and the `storages/session-translator` config directory are all the
same value. There are no longer two naming systems.

```bash
dsh plugin --profile desktop add    https://github.com/2994650874-coder/dsh-session-translator.git
dsh plugin --profile desktop remove dsh-session-translator
```

> History: this plugin used the technical name `dsh-cot-en2cn` (forked from the
> original author's repository). A version installed before 2026-10-19 still needs
> `dsh-cot-en2cn` to remove; after upgrading, use `dsh-session-translator`
> everywhere.

## Quality Assurance

The codebase includes **184** automated assertions that run without any external testing framework:

```bash
npm test
```

Test suite breakdown:
- `tools/smoke.mjs` (**60**): chunking reversibility (concatenated chunks match the original byte-for-byte), boundary clipping, Chinese detection thresholds, cache read/write and dedupe, the concurrency gate, failure attribution, config clamping, fallback routing (per-chunk retry / whole-block re-run at the fallback chunk size / probe mode / silence watchdog / **fallback run counting**), failure-reason wording (unset / half-set / both failed / identical to primary / deferred to a whole-block re-run), `VERSION` consistency with `package.json`, SSE stream parsing, and package manifest constraints.
- `tools/anonymous-test.mjs` (**10**): the anonymous Bing channel's request shape (one-shot text array, `to=zh-Hans`, no system prompt, no cookies), response parsing, language-tag mapping, HTTP/network/junk errors, heartbeat keep-alive (a slow call must emit heartbeats or the watchdog kills it), and an already-aborted caller issuing no request.
- `tools/select-safe-test.mjs` (**11**): idempotent panel writes (same value is never re-written), selection protection (deferred re-render while the user is selecting, at most one timer), and the already-Chinese badge contract.
- `tools/err-i18n-test.mjs` (**30**): i18n of host error notices — the shapes
  `normalizeHostError()` produces for each host error class, key coverage, and a
  fallback that never throws.
- `tools/builtin-models-test.mjs` (**15**): live model-list fetch for the built-in
  OpenAI-compatible endpoint (Bilibili Index-Translate) — parsing `GET /v1/models`,
  a newly listed model appearing without a code change, **all four failure modes
  (non-http / non-200 / empty data / malformed JSON) falling back to the written
  list and never returning empty**, dedupe and order, a missing `name` defaulting to
  the id, TTL hit and miss, a failure never cached as success, trailing-slash
  normalization, and the returned copy being immune to caller mutation.
- `tools/dispose-test.mjs` (**40**): lifecycle ownership — the eight resources are created and torn down, the disposer is idempotent, HMR re-entry does not stack, **a late disposer from an earlier run must not kill the current one** (regression: it used to stop all translation until reload), locale unsubscribe, and panels left in place on purpose.
- `tools/host-integration.mjs` (**18**): mounts the real routes inside a simulated cordis container to validate state queries, translation handling, config persistence, draft overrides that never touch disk, loopback security boundaries, the default Bing fallback, that **`/test` reports a failure as 200 + reason instead of an empty 400**, and that **`/catalog` keeps returning the built-in channels and flags a failed probe when the llm service hiccups**.
- `tools/parity-check.mjs`: compares the plugin's message payload against DSH's `createUserMessage` (skips automatically when `dsh-llm` is not resolvable).
- `tools/browser-check.mjs`: loads the real `lib/client.js` in Headless Chrome to assert expansion triggers, streaming deferral, Chinese skipping, event-propagation isolation, instant cleanup on global disable, and panel rendering. **Requires a working browser**; it fails in browserless environments.
- `tools/fold-mode-check.mjs` (**8**): browser regression for **fold mode** (`foldOriginal: true`, the user's default). A folded row's body is unmounted by React, so the source text can only come from the fiber props (`rawRowText` → `__reactFiber$` → `memoizedProps.text`); when that read fails the plugin silently falls back to the DOM summary, and a summary shorter than `MIN_CHARS` means **no translation and no error at all**. Renders a real React `ReasoningRow` and asserts a panel appears, `/translate` is really called, and the full text (not the folded summary) is sent. **Requires a working browser**.

## Project Structure

> For each file's responsibility, the reading path, and the invariants, see [Code Map & Reading Path](#code-map--reading-path) above.

```text
dsh-session-translator/
├── lib/
│   ├── index.js              # Host half: config IO + the eight same-origin routes
│   ├── engine.js             # Translation engine: chunk cache, gate, deadlines, failures
│   ├── text.js               # Chunking and script detection (pure)
│   ├── config.js             # Defaults and clamping
│   ├── store.js              # Atomic $DSH_HOME/storages/session-translator/config.json
│   ├── languages.js          # Target language table
│   └── client.js             # Browser half: DOM observer, panels, settings section
├── tools/
│   ├── browser-check.mjs     # Headless browser integration checks
│   ├── host-integration.mjs  # Host route & context integration tests
│   ├── parity-check.mjs      # Message protocol parity verification
│   ├── select-safe-test.mjs  # Idempotent writes & selection protection
│   └── smoke.mjs             # Unit and smoke test suite
├── cordis.patch.yml
├── package.json
├── README.md
├── README.en.md
└── LICENSE
```

## Version History

**Current version `0.2.1-3`, aligned with the official DSH release number.**

Versioning rules:

- **The base version always follows DSH** — when DSH releases `0.2.1`, we are `0.2.1`
- **Local features append a fourth component with a hyphen** — `0.2.1-1`, `0.2.1-2`, …
- **Fixes do not bump the version** — they ship as plain commits and are folded into the next feature release

> Why a hyphen and not a dot: `0.2.1.1` is not valid semver and is rejected by npm,
> Dependabot and CI. `0.2.1-1` is a standard prerelease — exactly "a local variant of 0.2.1".

`0.1.0` is the original author's version of
[Eyeing0721/dsh-cot-en2cn](https://github.com/Eyeing0721/dsh-cot-en2cn);
`0.1.1` – `0.1.6` are the historical numbers of the locally enhanced fork.

| Version | Date | Theme | Highlights |
|---|---|---|---|
| `0.1.0` | 2026-09-19 | **Upstream** | Eyeing0721/dsh-cot-en2cn 0.1.0: translate English chain-of-thought in place |
| `0.1.1` | 2026-10-05 | Fork baseline | Fold-through translation, chasing streaming, per-session cache, auto/manual modes, Ollama auto-discovery, explicit failure on an unset route |
| `0.1.2` | 2026-10-06 | Interaction correctness | Partial selection/copy of translations (idempotent rendering + selection guard); "retranslate" bypasses the block cache; skipped Chinese is no longer disguised |
| `0.1.3` | 2026-10-19 | Settings panel rework + dual routes | Six-card layout, model dropdowns, custom endpoint, fallback route with idle watchdog, built-in free channel |
| `0.1.4` | 2026-10-19 | Error notice translation | Interventional translation of Harness turn-failure notices; panel border fix; plugin page title renamed |
| `0.1.5` | 2026-10-19 | Channel adaptation & stability | Streaming locked by channel type; browser-check portability; model dropdown row height fix |
| `0.1.6` | 2026-10-20 | Identity unification & panel usability | Package/routes/storage renamed to dsh-session-translator; save bar moved to the top; description rewritten around capabilities |
| `0.2.1` | 2026-10-20 | Aligned with DSH | Aligned with DSH; bilingual plugin description; versioning scheme established |
| `0.2.1-1` | 2026-10-20 | **Current · first npm release** | Lifecycle teardown (`dispose`); `author` moved to the fork maintainer with the original author in `contributors`; first npm publication (prerelease channel) |

## Changelog (maintained fork)

> This repository is a maintained fork of [Eyeing0721/dsh-cot-en2cn](https://github.com/Eyeing0721/dsh-cot-en2cn).

### 2026-10-20

- **Fallback run count no longer stuck at 0** (`fallback-counter`): a whole-block re-run goes through `runPlan(fallbackRoute, …)`, and neither call site incremented `stats.fallbacks` — only the per-chunk fallback did. The `fallbackChunkChars 10000 > maxChunkChars 2400` configuration takes exactly that whole-block path, so the panel always showed "fallback runs: 0" and the user concluded the fallback never fired, while the translation on screen had in fact come from Bing. A run now counts once when any chunk was really produced by the fallback route (multiple chunks do not add up).
- **Self-check no longer lies about the fallback being unset** (`test-message-honest`): the self-check deliberately blanks the fallback config so it can "test one route only", which made the engine report "fallback not set (provider and model both empty), so no retry". But the user *had* configured `bing/bing-translate` and the row right below showed the fallback test passing — a self-contradicting falsehood. It now reads "this self-check tests only this route and does not use the fallback (your configuration is unaffected)".
- **Fold-mode browser regression** (`fold-mode-check`): `foldOriginal` appeared **zero times** in `browser-check.mjs`, yet fold mode is the default and takes a completely different text path — a folded row's body is unmounted by React, so the source can only be read from the fiber props; when that read fails the plugin silently falls back to the DOM summary, and a summary shorter than `MIN_CHARS` means **no translation and no error at all**. Eight new assertions render a real React `ReasoningRow` to cover that path.
- **Disposer ownership** (`dispose-owner`): the previous release gave `startTranslator()` a teardown path, but the teardown did not check **who** it belonged to. When `apply()` runs twice on the same module instance (double mount, fiber restart), the first run's disposer fires late and disconnects the observer plus all four listeners the second run just created — after which **nothing translates for the rest of the page's life** until a full reload. Each start now takes a monotonic `runId`, and a disposer only acts while it still owns the current run. Regression coverage: group 6 of `dispose-test.mjs`.
- **Correct failure reason** (`fallback-reason-defer`): when the fallback chunk size is larger, per-chunk fallback deliberately defers to a whole-block re-run — but the old code fell into the "fallback identical to the primary" branch and claimed the two routes were the same even when the primary was `index-translate` and the fallback `bing`. It now says "handed over to a whole-block re-run (fallback chunk N > primary M)".
- **Self-check no longer blank** (`test-target-scope`): `/test` declared `target` inside `try` and read it inside `catch`, so the **primary route failing** path itself threw `ReferenceError` and surfaced as HTTP 400 with an empty body — the panel could not show any reason. `target` is now declared outside the `try`.
- **Version reported honestly** (`version-drift`): the `VERSION` constant in `lib/index.js` was stuck at `0.1.0` through the rename, `0.2.1`, `0.2.1-1` and `0.2.1-2`, so the panel always showed an old version. It now matches `0.2.1-2`, and `smoke.mjs` asserts it against `package.json` so a future drift fails immediately.
- **Bing as the default fallback** (`builtin-bing`): a built-in `bing` channel (`edge.microsoft.com/translate/translatetext`, the same endpoint the bundled `dsh-experimental-translator` uses), set as the **default fallback route**. The fallback's only job is "still produce a translation when the primary dies", so it must need no key, no DSH channel registration and no quota — the anonymous Bing endpoint satisfies all three (measured 0.2–0.9 s, stable on 10 000-character chunks). **Google is deliberately not implemented**: the equivalent anonymous endpoint is unreachable on this network (direct `fetch failed`, 429 through the proxy).
- **Lifecycle teardown** (`dispose`): the eight resources `startTranslator()` creates (a `MutationObserver` on all of `document.body`, three document-level listeners, a 15-second poll, a 220 ms sync timer, a locale subscription and an anonymous `visibilitychange` listener) had **no teardown path** — `disconnect()` was never called anywhere in `client.js`. `dsh-client-hmr` reloads a module without reloading the page, so every hot swap stacked another set on top of a still-running one. `startTranslator` is now wrapped in `ctx.effect()`, whose disposer tears everything down; `visibilitychange` and `locale.subscribe` are named and unsubscribable. Translation behaviour is unchanged.
- **Attribution**: `author` moved from upstream `Eyeing0721` to the fork maintainer `maomao299`, with the original author in `contributors` (MIT attribution is still satisfied — LICENSE names `dsh-cot-en2cn contributors`).

### 2026-10-19

**Settings panel rebuilt**

- **Hand-drawn dropdowns** (`custom-dropdown`): native `<select>` popups are drawn by the OS in Electron, and any parent re-render closes them ("it snaps shut the moment you pull it down"). DSH's global CSS also gives `select` a background arrow that tiles into "a wall of blue arrows" on wide controls. Replaced with a button plus an inline list; both problems disappear.
- **Draft + manual save** (`manual-save`): every interaction used to `PUT /config` immediately — no undo, flicker between edits, and a 5-second poll fighting the writes. Edits now land in a local draft; only **Save** (or `Ctrl+S`) writes.
- **Buffered number inputs** (`number-buffer`): typing `8000` used to fire four writes (`8/80/800/8000`); intermediate values were clamped to the minimum and out-of-order responses overwrote the final value ("it reverts to 0"). Now one commit on blur or Enter.
- **Two-tone save button** (`save-button-tone`): grey (nothing to save) ↔ normal (pending changes), returning straight to grey after saving with no transition colour. The button stays white-but-disabled while saving so the sequence is white → white → grey rather than white → grey → grey.
- **Standalone save bar** (`save-bar`): same width as the cards above, one row tall, sitting under the preview card.
- **Status card slimmed** (`status-slim`): three rows only — what is in use and whether it works — each with a "Test" button.

**Routing and quotas**

- **Fallback route** (`fallback-route`): retry once on a backup channel, with its own cache key.
- **Silence watchdog** (`fallback-route`): keyed on "time since the last new token" rather than total elapsed time; a total timeout kills slow-but-healthy requests (27 s and 36 s responses were observed).
- **Independent fallback chunk size** (`fallback-chunk`): paid channels can use a larger chunk; when the primary route is down, one probe chunk decides the switch instead of waiting out N x 30 s gateway timeouts. Measured on 30k characters: one probe failure on the primary, then 4 successful fallback requests — versus 15 if the fallback also used 2000-character chunks.
- **Per-route quotas**: primary and fallback each have their own max characters per request.

**Built-in channel**

- **Index-Translate (Bilibili, free)** (`builtin-index-translate`): not a registered DSH channel, so it ships as a built-in entry ranked first in `/catalog` — no endpoint URL, no API key. Three models: `Index-Translate-35B-A3B` (flagship), `index-mt-9b` (balanced), `index-mt-2b` (fastest). **Measured limits**: non-streaming requests above 3000 characters always 504; concurrency 2 x 2000 characters is the safe ceiling.
- **Bing translation (anonymous, free)** (`builtin-bing`): also a built-in channel (`provider: bing`, `model: bing-translate`), endpoint `https://edge.microsoft.com/translate/translatetext` — the same one the bundled `dsh-experimental-translator` uses. It is **not** an OpenAI protocol (adapted in `lib/anonymous.js`), returns the whole translation in one response, and the client emits heartbeat chunks while waiting so the silence watchdog does not mistake a slow response for a stall. **Quality caveat**: it rewrites inline backticks into typographic quotes (`` `x` `` becomes “x”) and may mangle code fences; acceptable as a fallback, use the primary route when verbatim fidelity matters.
- **Failure reasons** (`fallback-reason`): when the primary route fails, the error now says why the fallback did not catch it — not configured (and which half is empty), identical to the primary, also failed (both errors listed), or succeeded (no error).

**Engine corrections**

- **Thinking-off mechanism fixed** (`thinking-off`): the old implementation set `purpose: 'session-title'` and assumed the adapter mapped it to a thinking-disabled request. **It does not** — `dsh-llm-deepseek`'s `serialize()` only reads `reasoningEffort`, and `purpose` only affects a `compaction` header. The switch had never taken effect. Now sends `reasoningEffort: 'off'` (what the official translator does) and degrades gracefully on channels that reject it.
- **Boundary clipping** (`clip-boundary`): `slice(0, max)` used to cut mid-sentence; half a sentence yields half a translation. Now paragraph → line → sentence fallback.
- **Endpoint mode uses SSE** (`endpoint-stream`): with `stream: false` the whole translation arrived at once, so the watchdog misjudged any healthy request slower than N seconds as stuck.

**Upstream fixes carried forward**

This fork already includes upstream's 2026-10-06 fixes and builds on them:
- `select-safe`: idempotent writes plus selection protection (deferred re-render while selecting).
- `retry-force`: `force` bypasses the per-chunk LRU, so "retranslate" no longer returns the identical cached text instantly.
- `skip-policy`: tightened the already-Chinese threshold (`latin<=16 || cjk>=latin*6`); mixed Chinese/English content is always translated.

### 2026-10-06

- **Selectable translation text** (`select-safe`): fixed selections jumping to the start and vanishing on mouse-up.
- **"Retranslate" actually retranslates** (`retry-force`): `force` bypasses the per-chunk cache.
- **Mixed content is translated** (`skip-policy`): tightened the skip threshold; skipped blocks now say "Already Chinese · not translated".

## License

[MIT](LICENSE)
