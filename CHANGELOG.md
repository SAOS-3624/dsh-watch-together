# Changelog

All notable changes to **dsh-watch-together** are documented here.
This package starts its own version line at `0.1.0` — it is not a continuation of `dsh-video-storyboard`.

## [Unreleased]

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
