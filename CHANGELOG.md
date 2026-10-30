# Changelog

All notable changes to **dsh-watch-together** are documented here.
This package starts its own version line at `0.1.0` — it is not a continuation of `dsh-video-storyboard`.

## [Unreleased]

### Added — a browser extension, so you never open a special window again

Position used to require a browser started with `--remote-debugging-port`, and Chromium 136+ refuses
that flag on the default profile — so users had to keep a second, separate browser window open just
for watching. That was the whole reason this package felt like it needed a "special browser".

`extension/` is an MV3 extension that reads `<video>.currentTime` from the page you are actually
watching and POSTs it to the plugin's own localhost server (`127.0.0.1:9377/api/position`). After a
one-time install it works in **your normal browser**, with your bookmarks and your logins.

- `src/position-bridge.js` — the receiving end: writes each report to
  `<cache>/position.json` (temp file + atomic rename) and treats anything older than 5 s as absent.
  It goes through a file rather than memory because the CLI is a **different process** and has to
  be able to read it too.
- `POST /api/position` and `GET /api/position` on the existing chat server, with CORS and a
  Private-Network-Access opt-in (a page on https://bilibili.com talking to 127.0.0.1 needs both).
- `readPositionOrNull()` now tries the extension report when CDP is not configured or returns
  nothing, so every existing call site gets the new channel for free.
- `doctor` grew an `extension` row and now treats "either channel works" as ready instead of
  insisting on the debug port.
- `docs/BRIDGE.zh.md` — step-by-step install guide written for someone who has never heard of a
  manifest file, including the eight failure modes people actually hit.
- `node watch.mjs install-extension` (and `scripts/install-extension.cmd`) does everything that
  *can* be automated: copies the extension to `%LOCALAPPDATA%\\dsh-watch-together\\extension` so it
  survives moving the repo, puts that path on the clipboard, and opens `edge://extensions`.
  The last three clicks cannot be automated — Chrome 137 removed `--load-extension` from branded
  builds and extension installs are HMAC-protected, deliberately, because silent install is the
  malware channel. The guide says so plainly instead of pretending otherwise.
- **The extension now says hello on load** (`POST /api/hello`, persisted as `extension.json`).
  Without it, "extension not installed" and "installed but no video playing" look identical from the
  outside — both are silence. `doctor` and `bridge` can now tell them apart.
- `extension/welcome.html` opens on install/update: the three verification steps, plus what each
  popup state means. Install is the one moment the user has no idea what to expect.
- `install-extension` no longer just prints and quits: it keeps the window open and **watches until
  the extension proves it is loaded** (`✓ 扩展装上了`), then until a real position arrives
  (`✅ 全部完成`). One double-click now covers install *and* verification, and the window cannot
  vanish mid-instruction because it is still polling.
- `node watch.mjs install-extension --steps` re-prints just the three clicks without touching any
  file — for when the window scrolled past or was closed.
- `install-extension` now waits for Enter when it has a TTY, so the instructions cannot vanish
  before being read (running it from an IDE "Run" button has no TTY, which is the common way this
  happened).
- `ensureWatchBrowser(port, url)` now passes the film through: with `launchBrowser: true`, saying
  "陪我看这个 <link>" opens the dedicated window **at that link** instead of the Bilibili homepage.
  That is the zero-install path — no extension, no port config, at the cost of watching in that
  window. Both paths coexist; neither requires the other.
- `node watch.mjs bridge` (and `scripts/bridge.cmd`) starts just the position receiver and says
  "✓ 收到上报" on the first report. Without it, a user who installs the extension and immediately
  looks at the popup sees "not connected" — because the server only runs during `watch_together`
  or `watch.mjs chat`, and concludes the install failed.

### Added — you can interrupt almost any wait, and it picks up where it left off

Every blocking wait in `watch_together` can now be interrupted by a message in the chat box, and in
all cases the answer is "reply to them, then call again with the same arguments" — the tool resumes:

- **Building a segment** (8–10 s, longer with ASR) and **filling the lookahead buffer** (up to 4
  segments serially, 30 s+) — the most pointless kind of waiting, now interruptible.
- **Waiting for the video to appear** (`waitForVideo`, up to 2 min).
- **Waiting for a condition** (`waitUntil`) and **waiting for the next line** (`nextLine`).
- Waiting to the delivery point and `cue` already listened; they now share one watcher (below).

The interrupted work is **not cancelled**: the storyboard keeps building in the background and lands
in the cache, so the follow-up call returns it immediately instead of rebuilding it.

New `src/interrupt.js`:
- `raceChat(promise)` — polls the chat while a slow promise runs; returns `interrupted` with the
  message, or `done`. Wakes on whichever happens first (the promise settling, or the next poll tick).
  The first version slept a fixed 500 ms per tick, which added half a second to *every* build —
  enough that playback passed the delivery point and the blocking wait returned instantly.
- `sleepWithChat(ms)` — sleep that can be cut short by a message.
- `chatWatcherShared()` — **one watcher for the whole process.** `makeChatWatcher()` baselines at
  creation time, so a fresh one per wait silently dropped anything the user said while the model was
  thinking, in the gap between two waits.

### Added — you can interrupt almost any wait, and it picks up where it left off

Every blocking wait in `watch_together` can now be interrupted by a message in the chat box, and in
all cases the answer is "reply to them, then call again with the same arguments" — the tool resumes:

- **Building a segment** (8–10 s, longer with ASR) and **filling the lookahead buffer** (up to 4
  segments serially, 30 s+) — the most pointless kind of waiting, now interruptible.
- **Waiting for the video to appear** (`waitForVideo`, up to 2 min).
- **Waiting for a condition** (`waitUntil`) and **waiting for the next line** (`nextLine`).
- Waiting to the delivery point and `cue` already listened; they now share one watcher (below).

The interrupted work is **not cancelled**: the storyboard keeps building in the background and lands
in the cache, so the follow-up call returns it immediately instead of rebuilding it.

New `src/interrupt.js`:
- `raceChat(promise)` — polls the chat while a slow promise runs; returns `interrupted` with the
  message, or `done`. Wakes on whichever happens first (the promise settling, or the next poll tick).
  The first version slept a fixed 500 ms per tick, which added half a second to *every* build —
  enough that playback passed the delivery point and the blocking wait returned instantly.
- `sleepWithChat(ms)` — sleep that can be cut short by a message.
- `chatWatcherShared()` — **one watcher for the whole process.** `makeChatWatcher()` baselines at
  creation time, so a fresh one per wait silently dropped anything the user said while the model was
  thinking, in the gap between two waits.

### Added — it now reacts to what you do mid-video

Auditing the whole flow against the user's checklist surfaced three gaps where the plugin behaved
correctly but **never told the model**, leaving it silent until the user poked it:

- **Video ended / video changed now wake the model once.** Previously they only stopped the loop, so
  the model sat blocked on the previous segment with no idea the film was over or had been replaced.
- **Large seeks (>60 s, forward or backward) wake the model once** with where the user jumped to and
  from, with a 3-minute cooldown. Position tracking was already correct — it was the model that had
  no idea. Rewatching does not re-speak already-spoken segments (no immediate-repeat chatter).
- **Only the visible tab reports** (`document.visibilityState`), plus a report on `visibilitychange`.
  Every tab with a `<video>` reports once per second; with two such tabs open the server received
  alternating positions and the plugin interpreted it as the user scrubbing wildly.
- The simulator can now jump the playhead (`seeks: [{at, to}]`), and there are four new scenario
  tests covering: video changed wakes once, video ended wakes once, seek forward wakes once, rewatch
  wakes once and does not re-speak.

Note the jump check must run **before** the anchor is refreshed — comparing the new reading against
the already-updated anchor measures zero. That was the first (failed) version.

### Fixed

- **`bin/watch.mjs chat` ran its own copy of the chat server** — an inline `http.createServer` plus
  duplicated copies of both HTML templates (92 lines). The copies had drifted: it served `/`,
  `/widget`, `/api/messages`, `/api/say` but **not `/api/position` or `/api/hello`**. So running
  only `watch.mjs chat` (instead of `bridge`) meant extension reports hit 404 and the CLI path could
  never read a position. It also never called `attachSpeechToChat()`, so that chat box showed user
  messages but no script lines. It now uses `startChatServer()` + `attachSpeechToChat()` like the
  plugin and `bridge` do, and the duplicated templates are deleted.
- **`watch.mjs reply` wrote straight to the stream** with `appendChat('assistant', …)`, so the text
  appeared in the chat box but was never handed to speech subscribers — a TTS adapter stayed silent
  while the page showed the words. It now uses `appendAssistantSay()`, which writes the stream *and*
  emits the speech event, matching what `watch_together({say})` does.

### Fixed

- **`bin/watch.mjs chat` ran its own copy of the chat server** — an inline `http.createServer` plus
  duplicated copies of both HTML templates (92 lines). The copies had drifted: it served `/`,
  `/widget`, `/api/messages`, `/api/say` but **not `/api/position` or `/api/hello`**. So running
  only `watch.mjs chat` (instead of `bridge`) meant extension reports hit 404 and the CLI path could
  never read a position. It also never called `attachSpeechToChat()`, so that chat box showed user
  messages but no script lines. It now uses `startChatServer()` + `attachSpeechToChat()` like the
  plugin and `bridge` do, and the duplicated templates are deleted.
- **`watch.mjs reply` wrote straight to the stream** with `appendChat('assistant', …)`, so the text
  appeared in the chat box but was never handed to speech subscribers — a TTS adapter stayed silent
  while the page showed the words. It now uses `appendAssistantSay()`, which writes the stream *and*
  emits the speech event, matching what `watch_together({say})` does.

### Fixed

- **The plugin passed the browser's debug port to `ensureChatSession()`**, so the chat server tried
  to bind 9333 — the port the browser is already using. The bind failed, the error was swallowed,
  and the chat box silently never came up in DSH. It now uses the chat port (9377) as intended.
  This also mattered for the extension: that server is where reports land.

### Removed — the OS media session (SMTC) backend is gone

Position used to have two sources: the browser's DevTools port, and Windows' system media controls
(read by a bundled `watch_smtc.py`). **SMTC is deleted**, along with everything that only existed
because of it:

- `src/watch-probe.js` (121 lines) and `src/watch_smtc.py` (62 lines)
- `src/resolve-playing.js` (153 lines) — it reversed a *title* into a source by searching filenames
  and then Bilibili. With CDP the page URL is the source, so this whole "guess the film" path is
  gone (it was also the thing most likely to pick the wrong video)
- the `winrt` Python dependency (three packages) and the interpreter search
- most of the extrapolation policy in `position.js`: the cap drops 180 s → 60 s, `FRESH_MS`
  becomes 5 s, and the safety margin now only applies after a *missed* read
- `pickSession` / `probePlayback` / `describeStatus` and the `probe` injection point

Rationale: SMTC's `Position` only refreshes on player events (measured gaps of 143 s and 216 s), so
treating it as a live position required extrapolating, and extrapolating over a wrong pause means
every later segment is built on a wrong cursor. The benefit — "watch in whatever player you like" —
did not survive contact with how it actually behaved.

What you give up: you now watch inside the dedicated browser window
(`scripts/start-edge-debug.cmd`). Chromium 136+ refuses to open a DevTools port on the default
profile, so that window necessarily has its own profile and needs a one-time login.

### Fixed

- **`loop.built` / `loop.dur` / `loop.sourceUrl` leaked across films.** Starting a second watch
  session reused the previous film's duration, so the first read of the new film looked like a
  "video changed" event and stopped the loop immediately; `built` made prefetch skip segments it had
  built for the old film. Both are now reset when the source changes.
- **`startWatchLoop` used `Date.now()` for the anchor while pricing time off its injected clock**,
  which made every simulated read look minutes old. It now uses the injected clock.
- **The CLI's `pos()` never read SMTC at all**, so the CLI was browser-only even while the plugin
  had a fallback. Moot now that SMTC is gone, but it is why the tool seemed to demand a special
  browser.

## [0.1.0] — 2026-10-30

First release as a standalone plugin. The feature existed inside `dsh-video-storyboard` 0.4.x as
`src/watch/`; it is now its own package with its own entry point, its own version, and a one-way
dependency on `dsh-video-storyboard`.

### Added

- **`watch_together`** — watch a video together with a text-only agent. Instead of one whole-film
  storyboard, it follows the user's **real playback position** and hands over one segment at a time,
  `lead` seconds before the segment ends. The next segment is built while the user is still watching
  the current one, so delivery is perceived as instant (4/4 measured deliveries at 0.0 s).
- **Ramp-up start.** Segment lengths grow `[60, 120, 180, 240]` → `segment`, so the first line lands
  around 45 s instead of after a full 5-minute batch. `ramp: []` disables the ladder.
- **Double buffering.** `depth: 2` keeps the current batch plus the next one built, and starts the
  one after that while the user watches.
- **Playback position straight from the page.** It reads `<video>.currentTime` over the DevTools
  protocol, so the value is exact, and the page URL becomes the source (`file:///D:/x.mp4` → local
  path) — no searching, no downloading, no asking. Never released with the OS media session (SMTC)
  backend documented below: SMTC's `Position` only refreshes on events, so using it as a live
  position meant extrapolating, and a wrong position poisons every later segment.
- **Honest confidence levels.** The plugin reads every 15 s and extrapolates in between, which is
  normal and self-correcting. What it refuses to do is keep extrapolating after it has *missed* a
  read: past 20 s it demands an extra 5 s of margin before speaking, and past 60 s it stops
  guessing and asks for `cursor` instead.
- **The speech seam, with no engine.** `src/speech-bus.js` exposes `onSpeech(handler, { voice })`,
  `emitSpeech()`, `speechEvents()` and `lastSpeech()`. The plugin ships no engine, no default
  adapter and no voice parameters; `watch_together` results carry `speech: [{ at, text, state }]`
  and the loop emits `state: 'due'` when a line is actually due.
- **Adapters loaded by path.** `~/.dsh/voice.json` `{ "adapter": "<path or module>" }` (or
  `DSH_VOICE_ADAPTER`) is `import()`ed once at startup; the module exports `attach(api)` and returns
  a detach. Nothing is bundled, and a failure only logs a warning.
- **`examples/voice-edge-tts/`** — a working adapter (edge-tts → `ffplay` → system-voice fallback).
  It prints `[voice 03:11.4] <line>` to stderr for every line that comes due; that log, not the
  audio, is what you want when checking *when* text fires.
- **One text stream for the chat box.** `chat.jsonl` carries `line` (scripted), `assistant`
  (interjection) and `user`, with `say: true` marking the speakable ones.
  `watch_together({ say: "…" })` is how the model gets its interjection in — the plugin cannot read a
  normal reply. `attachSpeechToChat()` subscribes with `voice: false`, so a display-only consumer can
  never silence the loop.
- **A localhost chat page** (`/` full view, `/widget` capsule) with an `/api/messages` long-poll and
  an `/api/say` callback. This is the only channel that actually reaches a blocked `watch_together`
  call — messages typed into the host's own input box are appended to the session log *after* the
  blocking call returns (measured: 42 s of polling, 0 bytes written).
- **`examples/floating-chat/window.py`** — a real floating window without a browser: frameless,
  always-on-top, translucent, stdlib tkinter only. Reads the same `chat.jsonl`.
- **`bin/watch.mjs`** — a CLI shell for sessions that have no `watch_together` tool. It imports the
  same `src/`, so behaviour cannot drift from the plugin.

### Fixed

- **The CLI imported pre-refactor paths** (`src/browser-time.js`, `src/pipeline.js`, …) that no
  longer exist, so `bin/watch.mjs` could not even start. All imports now resolve through the
  `dsh-video-storyboard` package name.

### Changed

- `detachAdapters()` no longer reaches into the bus's private subscriber map; it calls
  `__resetSpeech()` from `speech-bus.js`.
- `watch-run.js` imported `./watch.js` twice; merged into one import.

### Known limits

- **Speaker separation is not attempted.** Measured on the reference machine: per-sentence cam++
  embeddings split single-speaker material into 6 speakers; demucs pre-separation made no difference
  (median similarity 0.62 → 0.61); FunASR's `ClusterBackend` returns "one speaker" outright below 20
  speech segments — short clips are outside its operating range by design.
- **Interjection audio can collide with a line already being spoken.** Windows mixes both SAPI
  instances, so `say` occupies `quiet-until.json` before speaking and `cue` skips lines inside that
  window (it skips rather than defers — deferring desynchronises from the picture). The remaining
  gap is the 3–8 s while a line is mid-speech, which cannot be cut short.
- **CRLF-less assumption.** The chat page replaces `__PORT__` in the templates per start; changing
  the port while a browser tab is already open requires a reload.
