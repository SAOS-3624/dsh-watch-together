# Changelog

All notable changes to **dsh-watch-together** are documented here.
This package starts its own version line at `0.0.7` — it is not a continuation of `dsh-video-storyboard`.

## [Unreleased]

Two rounds of real-watch reports (2026-10-31 evening). The common shape: the plugin knew something,
and the model (or the user) never found out.

Round two — "stop when the signal says stop". Round one — "speak before you look", "notice a new
film", "don't stack two sentences", "don't wait a minute for a video we can already identify".

### Stop when the signal says stop: hangup, dead source, switched video

Reported as "换片或者我都关浏览器了还在念台词" and "关了悬浮窗 AI 还是会自动调出来，根本不会自动结束".
Both were the same shape: the plugin knew the source was gone, and kept talking anyway.

- **Speech now requires a believable position.** The line queue only fired when the position was
  `fresh`, or `extrapolated` within `SAFETY_AFTER_MS` (20 s — the normal gap between probes).
  Before, the only thing excluded was `paused`; `estimate()` happily extrapolates a dead source
  forward and `pos` stays finite, so closing the browser kept reading lines out for minutes.
  Nothing is spoken on an `unknown` position, and the position-unknown give-up dropped from
  10 min to 5 min (the watch should not sit there pretending).
- **Closing the floating window is a hangup, treated like an interjection.** The window is the only
  way to talk mid-watch, so closing it means "I'm done":
  - the clock stops and **really wakes the model** — `wake:false` (the default) used to silence this
    too, because it shared the `wake` path with the segment-end reminder. User actions (hangup,
    video changed, video ended, seek, unreadable position, high-frequency mode) now use a separate
    always-real channel (`wakeSignal`), and the message says **do not call watch_together again and
    do not read out any more lines**;
  - the guard is stored on the loop and can be turned on later (`resumed` path used to freeze it,
    so a window opened by an earlier call was never guarded);
  - the next tool call **does nothing at all**: no frame, no clock, no window (`[hangup]` result).
    `sameWatch` previously required `args.input`, which the model never sends — so every call looked
    like "a new watch" and re-opened the window the user had just closed.
- `wakeWithRetry` called an undefined `note()` in its failure branch (a `ReferenceError` swallowed by
  the ticker). Real wakes can fail, so it was reachable; now it records into `loop.logs`.

Tests: 247 pass, +4 in `test/hangup-guard.test.mjs` (dead source sends nothing, live source still
speaks, hangup wakes with the right wording, post-hangup call is inert).

### Interjections: speak first, then look

Reported as "它一声不吭先去 zoom，回来才说话". The root cause was not the model: a normal reply
never reaches the floating window — only `say` does and only `say` is spoken. So "think, then look,
then answer" was, from the user's side, complete silence for tens of seconds.

- One wording, one place (`src/interject.js`) for all five entry points (during a build, during the
  lookahead fill, during a blocking wait, `waitUntil`, `nextLine`). It now says exactly what to do:
  `watch_together({ say: "我看一眼", speakNow: true })` — one call, words written before any frame
  is built. `lines` and `say` can ride in the same call, so "台词优先" no longer means "stay silent".
- Unanswered interjections are **tracked**: the next tool result ends with `[未回应] …你还没回`,
  until a call actually carries `say` (expires after 3 min). Previously the reminder existed only
  inside the message that woke the model, which it had already scrolled past.
- `waitUntil` / `nextLine` called a function that **did not exist** (`chatResult`) — an interjection
  during either wait threw `ReferenceError` and the tool failed. Defined, and it reuses the same wording.
- Waiting for a video to appear returned a result **without `text`**, which the host's `output.schema`
  requires. That path now returns a proper result.

### Reply vs. scripted line: 12-second guard

Reported as "说话和插话的回复离太近，把后面那句改一下". Two lines spoken back to back on a serial
TTS chain means the second one either drifts or is dropped by the adapter (queue > 3.5 s → `skipped`).

- `say` now marks the voice engine busy for its full spoken length (`src/reply-guard.js`), so the
  loop stops feeding scripted lines while a reply is still playing. Previously only the loop's own
  lines updated that clock — a reply was invisible to it.
- Lines scheduled within 12 s of a reply are **withdrawn from the batch and handed back** to the
  model (`[lines·太近]`) with instructions to rewrite them around what was just said, or drop them.
  Withdrawn, not silently deleted: the user asked for "改一下", not "少一句".

### Switching videos is noticed in ~2 s, not ~15 s

- The per-tick bridge read (every 2 s) now does the switch / end-of-video / big-jump checks, and
  keeps the `dur`/`url` baseline up to date. Before, all three lived in the 15-second CDP probe
  branch only, so a switch could go unnoticed for a quarter of a minute — while the clock kept
  computing segment boundaries against the old film.
- The blocking wait in `watch-run` now compares each read against the film it started with and
  returns `[video-changed]` immediately. **This was the only reliable path**: the loop's wake goes
  through `followup()`, which is delivered *after* the current tool call returns — and that call was
  busy waiting.
- `sourceSwitched()` centralises the test, and `Number(null) === 0` is explicitly guarded: a
  not-yet-known duration used to look like a "0-second film" and stop the watch instantly.

### Cold start: don't wait a full minute for a video we can already identify

- The extension only reports while the tab is **visible** — and "一起看" is usually typed in another
  window. The position went stale after 5 s, the plugin concluded "no video", and sat in the 60 s
  wait. It now falls back to a **stale** sample (up to 2 min) to identify the film, marks the
  position `stale`, and lets the next fresh reading correct it.
- Automatic waiting (no `waitForVideo`) dropped from 60 s to **20 s**; explicit `waitForVideo: true`
  stays at 120 s.
- `probeBrowser()` is skipped when the extension already reports: one probe is `listTargets`
  (1.2 s) plus up to 8×1.5 s of CDP round-trips — pure overhead for a `browser:` line the extension
  just answered. The line now reads `browser: extension reporting <title> playing 03:20`.

Tests: 243 pass (`node --test`), 6 of them new in `test/interject-reply.test.mjs`.

## [0.0.7] — 2026-10-31 (first release)

The first published version. One tool, `watch_together`: it follows the user's real playback
position, hands the model one storyboard + transcript per segment just before that segment ends,
and speaks the scripted lines at the second they belong to.

**Licence: Apache-2.0** (the package was developed under MIT and switched before the first
public release, to match `dsh-video-storyboard`). `LICENSE` is the full text, `NOTICE` states
what the project deliberately does **not** do — no hosted video, no uploaded position, no DRM or
paywall bypass, no bundled TTS engine.

### Repo hygiene — the extension's manifest and icons were never committed

`.gitignore` carried `manifest*.json` and `*.png` (meant for CLI artifacts). Those two rules also
swallowed `extension/manifest.json` and `extension/icons/*.png`, so a clone would have shipped an
extension **with no manifest** — completely broken, and nothing would have failed until someone tried
to load it. Both are now force-added, and the ignore rules are anchored (`/*.png`, `/*.meta.json`) so
they can only ever catch files at the repo root. Also: `* cookies*.txt` (a pattern with a space, which
never matched anything) is gone, `__pycache__` is out of the npm tarball via a new `.npmignore`, and
`npm test` no longer requires the sibling `dsh-video-storyboard` checkout — it falls back to the
installed copy, so a clone can run the suite.

### Docs — one page per service, and the stale one is gone

`docs/WATCH.zh.md` still explained how to configure things around the **OS media session (SMTC)**,
which was deleted a while ago: wrong rationale, wrong `confidence` values, wrong defaults. Deleted.
Replaced by [`docs/CONFIG.zh.md`](docs/CONFIG.zh.md): ffmpeg → yt-dlp + cookies → subtitles/ASR →
browser extension (9377) → debug port (9333) → voice (`voice.json` + `tts.json`) → floating window →
cache locations → a one-page troubleshooting table. Every entry says **what breaks if you skip it**.

`README.md` got a 30-second start, a "what to configure" table, a corrected parameter table
(`depth` is auto-by-time now, `lookahead` was missing), a CLI table that matches the 15 real
subcommands, a privacy note for the extension, and a dev section. `docs/VOICE.zh.md` gained
`state: 'skipped'` and a correction: `at` is a **playback second**, not a wall-clock timestamp.

### `doctor` — three levels, because "not configured" is not "broken"

`FAIL` used to be printed for things that are merely "not set up yet": a missing cookie file (only
needed for Bilibili), a closed debug port (the extension is the recommended channel), an extension
that is loaded but has no video playing. First-run users read that as "something is broken" and went
to reinstall the extension. Now: **OK / WAIT / FAIL**, only `plugin` and `ffmpeg` are fatal, and when
the extension has checked in but nothing is playing, `doctor` says `READY — 播个视频就能读到位置`
instead of "both position channels are down".

### Performance — the chat watcher no longer re-reads the whole log every 150 ms

The blocking-wait loop polls `chat.jsonl` every 150 ms. Each poll re-read `readChat()` and parsed
every line, so a two-hour session (thousands of entries) was decoding hundreds of KB several times a
second, and getting slower the longer the session ran. `makeChatWatcher()` now keeps a byte offset
and reads **only what was appended since last time** (falling back to a full re-read if the file
shrank, i.e. it was cleared). Measured on a 5000-line log: **0.061 ms per poll, independent of file
size**. `appendChat()` also stopped parsing the whole log to keep `at` monotonic — it reads the last
4 KB instead.

### Tool description — pacing is now a rule the model can follow

`watch_together`'s description tells the model to keep lines **≥ 6 s apart** and why: speech is
serialized, so a denser draft is thinned at runtime (engine busy → next line held; past the late
grace → dropped). The three previous rounds of "台词太早 / 太密" all came from the model not knowing
this budget.

### Fixed — speech piled up in the engine queue, and an interjection could no longer break a blocked wait

Two reports in one message: "吐字太快，台词会挤到一起，只有上一句念完才到下一句，话太密会导致语音越来越
滞后" and "悬浮窗插话不能让他从等待中出来 —— 这个功能之前是好的".

**The voice queue.** `examples/voice-edge-tts` chains every `due` event onto an unbounded serial promise
("two lines never overlap"). Lines are now scheduled at the right second, so when they arrive faster
than the engine can speak them the chain simply grows: speech drifts further from the picture with
every line, and the caption (written on `spoken`) drifts with it.

- `src/watch-loop.js` — the clock now keeps a **voice budget**: after handing out a line it records
  `voiceBusyUntil = now + speechSeconds(len)` and will not hand out the next one while the engine is
  still talking. A line that misses its window by more than the late grace is dropped by `dueLine`
  as usual: **speak one line less rather than one line later**.
- `src/speech.js` — `speechSeconds(chars)`: full spoken duration (`0.35 + chars/5`, 0.8–30 s).
  `speechLag()` stays as it was — that one answers "when may I start talking", this one answers
  "how long is the engine busy".
- `examples/voice-edge-tts` — safety net: if a queued line has been waiting more than 3.5 s it is
  **abandoned** (logged) instead of spoken, and the queue empties immediately.
- `src/speech-bus.js` / `src/chat-store.js` — a fourth state, `skipped`: the adapter reports that it
  gave up on a line, and `attachSpeechToChat` cancels the pending fallback timer for it. Without this
  the 2.5 s fallback would paint a caption for a line that was never spoken.

**The interjection.** `chat.jsonl` is a **consuming** channel: `poll()` marks a message read. The
blocking wait and the watch loop share one watcher, and the loop's handler is `followup()` — which
cannot interrupt a session that is sitting inside a tool call (the message is only processed when
the turn ends). So whichever polled first decided the outcome, and the loop (every 2 s) sometimes
won: the interjection was swallowed, the wait's `poll()` never saw it, and the user's "stop, I have a
question" did nothing until the segment ended.

- `src/interrupt.js` — `enterChatWait()` / `chatWaiterCount()`: whoever is blocking on purpose
  **owns** the channel. `raceChat()` (storyboard build, prefetch) registers too.
- `src/watch-loop.js` — `wakeOnChat` is skipped entirely while `chatWaiterCount() > 0`. The wake path
  still works when the model is idle (no waiter), which is its whole purpose.
- `src/watch-run.js` (the `wait: true` loop), `src/watch-modes.js` (`waitUntil` / `waitForRefill` /
  `nextLine`), `src/watch-source.js` (`waitForVideo`) — all register as waiters for the duration of
  their loop.

Tests: `test/lines-timing.test.mjs` (engine busy → next line is not handed out; the overdue one is
dropped), `test/chat.test.mjs` (`skipped` writes nothing, not even the fallback),
`test/interject-anywhere.test.mjs` (the loop must not consume while a waiter is active; counter
cannot go negative).

### Fixed — scripted lines came out like a machine gun, and minutes before the picture

Reported as: "台词出现时间早了很多，而且和机关枪一样突突突一下出来一大堆，时间点都比视频早了".

The line queue is ordered by `at` (the second of the video this line is *for*) and fired by playback
position, so the pacing is only as good as the `at` values. When a line was written **without** `at`
(the model wrote prose only), `pinTimes()` decided when it would be said — and it took *the first N
subtitle sentence starts of the segment*. Sixteen lines written for a 3-minute segment were therefore
all packed into its first 62 seconds (181.6 → 244.2, measured on the live queue), i.e. one every
2–3 seconds: the clock ticks every 2 s and hands out at most one line per tick, which is exactly the
"machine gun". The last 14 of them ran one to two minutes ahead of the picture they describe.

- `src/watch-lines.js` `pinTimes()` — each line now aims at its **even share of the segment**
  (`from + i*size/n`) and snaps to the nearest subtitle start within half a slot, so the queue is
  spread over the whole segment instead of stacked at its head. Falls back to the even share when no
  start is close enough, and **never goes backwards** (the old tail fallback could emit 152.8 → 150).
- `src/watch-lines.js` `dueLine()` — pinning uses **the segment that line belongs to** (`sizeOf`),
  not the segment the user happens to be in. With the 1/2/3/4/5-minute ramp, a 60-second slot pinned
  with a 300-second size put its last lines outside the segment entirely.
- `src/watch-lines.js` `saveLines()` — `at` given as **subtitle text** was resolved only against
  `recallSegments()`, which is a 4-entry in-process cache (empty in a fresh process, and lines are
  usually written in a different turn). A miss silently became "no `at`", i.e. the head of the
  segment — the other half of "the line is way too early". Now it reads the on-disk
  `subs-<key>.json` cache first, then falls back to memory, then to a fuzzy match (≥60 % of the
  characters), and only then warns.
- `src/watch-run.js` — the delivery note pruned "past" lines with `Number(l.at)`, and
  `Number(null) === 0`: **every line without `at` was judged as second 0 and deleted** at delivery.
  The note now previews the same pinning the clock will use, so the reported "earliest …" time is the
  real one, and only lines whose *actual* time has passed are dropped (by text).
- `src/watch-run.js` — the note now lists the landing times it will use (`[lines] 落点：…`) and warns
  when the average gap is under 6 s, instead of leaving the model to guess its own pacing.
- `src/watch-loop.js` — with the extension as the position source, the anchor is now re-read **every
  tick** (a small local JSON, not CDP). Between the 15-second probes the clock extrapolated blindly,
  so after a pause the lines up to 15 s ahead were spoken **early** — extrapolation is bounded for
  lateness but nothing guarded earliness.
- `src/latency.js` `aheadSeconds()` — returns 0 instead of `NaN` when `ms` is missing. `NaN` made
  `pos` `NaN`, every comparison false, and `shouldSpeak()` reported "due" for the first unspoken
  segment at every tick.

Tests: `test/pin-times.test.mjs` (the 16-line packing regression, monotonic fallback, cues bunched at
the head), `test/watch-lines.test.mjs` (per-segment size, `at` from the on-disk subtitle cache),
`test/lines-timing.test.mjs` (a stuck video must not speak the next line early).

### Fixed — the caption appeared before the voice, because it waited on `due` instead of "actually speaking"

`attachSpeechToChat` wrote a line into `chat.jsonl` the moment `due` fired. But `due` only means
"it is time to say this": synthesis still has to happen (edge-tts does a network round trip, then a
fresh `ffplay` process — 0.6–2 s even for a short sentence). The floating window polls that file, so
the text was already on screen a beat before anything was heard.

Delaying the voice instead (`speechLag`) would align the two, but push the voice further from the
picture, which is the one thing this plugin cannot trade away. So the **caption** moves:

- `src/speech-bus.js` — a third state, `spoken`, plus `emitSpoken(event)` for engines to report
  "audio is starting now". The adapter API gains `emitSpoken`.
- `src/chat-store.js` — writes on `spoken` when a `voice: true` subscriber exists; still writes on
  `due` when nobody will speak (the zero-dependency path must not go mute); falls back after
  `fallbackMs` (2.5 s, `DSH_WATCH_CAPTION_FALLBACK_MS`) for adapters that never report.
  Pairing is by `at|text`, not by `seq` — `spoken` is a **new** event, so `emitSpeech` gives it a
  new sequence number.
- `examples/voice-edge-tts` — reports `spoken` right before playback starts (i.e. after synthesis).
- `examples/floating-chat/window.py` — polls every 200 ms instead of 400 ms; the poll interval is
  the residual "text lags the voice" gap.

`test/chat.test.mjs` covers both new paths (waits for `spoken`; falls back when nobody reports, and
does not write twice if `spoken` arrives afterwards).

### Fixed — scripted lines never reached the chat window without a voice engine

`watch-loop.js` consumed the due line inside `if (speechSubscribers() > 0)`. That helper counts only
`voice: true` subscribers (real engines), while `attachSpeechToChat` — the one that writes lines into
`chat.jsonl`, which is exactly what the floating window reads — subscribes with `voice: false`.
So with no voice adapter, or one that failed to load, a scripted line was **never taken from the
queue at all**: not spoken, not displayed, and the queue silently accumulated.

Display and speaking are two separate things. The line is now handed out at its due moment
regardless: `emitSpeech` delivers it to every subscriber, and only a real `voice: true` subscriber
counts as "said" (`if (speechSubscribers() > 0) return;` still stops the wake, so nothing changes
when a voice engine *is* attached).

`test/lines-to-chat.test.mjs` covers both sides. The test was checked against the bug: restoring the
old condition makes the no-voice case fail while the with-voice case still passes.

### Changed — `say` no longer reads as "only to answer an interjection"

It always worked at any moment: it writes the sentence into the shared stream and hands it to
whoever listens for speech, exactly like a scripted line. But the description ended with
"use it to answer an interjection", which reads as "only after the user speaks". A model follows
that literally, so the one path for saying something **unprompted** went unused.

The description now says any time, and says it explicitly: something in the picture strikes you,
the user asks something, a thought lands while waiting for the next batch — plus
"do not wait for the user to speak first". It also states the cost, because that is what makes it
usable mid-wait: no position read, no frame built, no batch advanced, one round trip.

`test/say.test.mjs` pins the wiring — parameter → stream (one `assistant` row with `say: true`) →
speech event with `origin: 'chat'`, no image, no state advanced. The store layer was already covered
by `test/chat.test.mjs`; the uncovered part was the parameter entry itself.

### Added — an end-to-end test for "talk while the frame is building"

The mechanism already existed (`raceChat(buildSegment(...))` in `runWatchPass`), and
`test/interrupt.test.mjs` covered `raceChat` itself — but the `built.kind === 'interrupted'`
branch had **no** coverage. If a refactor ever dropped the wrapper, or `chatWatcherShared()` got
replaced with a fresh watcher per call, every existing test would still pass.

`test/interject-build.test.mjs` builds a segment that takes 1.2 s, writes a user message at 0.2 s,
and asserts all four things at once: the call returns before the build finishes, it carries that
exact message, it carries no image, and the build still completes into the cache afterwards.

### Changed — three implicit couplings now have exactly one source each

A pass over the module boundaries. Same behaviour except the `lead` fix at the end, which was a
real bug: the parameter only worked on one of the three paths that used it.

- **`handler.js` stopped preparing UI.** The floating window, the chat service and the "where do I
  type" note moved to `input-surface.js` (`createInputSurface()`). `handler` is a router again —
  three exits: quick action, one pass, start the loop. The `widgetNote` variable no longer travels
  from the top of the function to the bottom.
- **`watch-run.js` has one return shape.** Eleven exits each used to build their own ten-field
  object; now they all call one `pass()` closure. Adding a field is one edit instead of eleven, and
  a branch can no longer quietly forget one.
- **One segment length.** `watch-state.js` exported `WATCH_SEGMENT = 120` while `batches.js`
  declared `DEFAULT_SEGMENT = 300`; whichever fallback fired first decided how long a segment was.
  `batches.js` is now the only source, and `WATCH_SEGMENT` is gone.
- **One lead.** The delivery lead was hardcoded in three places: `batches.from()` produced
  `sayAt = to - 15`, `watch-loop.js` passed `lead: 15` to `shouldSpeak`, and only `watch-run.js`
  actually read `args.lead`. Segments no longer carry `sayAt`; `shouldSpeak` computes `to - lead`,
  and `startWatchLoop` takes `lead` from the caller. `lead: 60` now really moves the trigger point
  (checked against a 300 s segment: at 241 s, `lead=15` stays quiet, `lead=60` fires).

### Removed — no more auto-launched browsers, no more browser widget

Both were early paths from before the browser extension existed. Neither could produce a position
for the tab the user is actually watching, so both are gone rather than kept as fallbacks.

- **Auto-launching a browser**: `ensureWatchBrowser()` (`launchBrowser` + `waitForPort`), the
  `autoLaunch` flag on `runWatchPass`, the `attachOnly` parameter, and the `launchBrowser: true`
  branch in `~/.dsh/video.json`. The extension already reports `currentTime` every second from the
  page the user is on; opening a second Edge with its own profile never helped that page. When no
  position can be read the tool now asks "how far are you" instead of starting a program.
- **The browser widget page**: `GET /widget`, `WIDGET_PAGE`, `openWidgetInBrowser()`, `widgetUrl()`,
  and the `documentPictureInPicture` button in the chat page. The input box is the native tkinter
  window (`examples/floating-chat/window.py`); the HTML page stays as a read-only fallback at `/`
  (`chatPageUrl()`), and is never opened automatically.
- **Dead parameters**: `wakeOnLinesEmpty` (the handler never passed it, so its 30-line branch in
  `watch-loop.js` could never run), `title` (nothing in `src/` or in storyboard read it), and
  `segmentStart()` (every caller uses `plan.segmentAt()`). Parameter count 36 → 34.

### Fixed — interjections used to get swallowed (four different ways)

The interjection path was the one place where losing user input was silent: nothing crashed, nothing
logged, the words just never arrived. All four ways of losing them are now closed, and each one has
a regression test (`test/cli-interrupt.test.mjs` — the CLI had **no** test coverage before this).

- **Between two `cue` runs.** Every `cue` is a fresh process, and the watcher took "however many
  lines exist right now" as its baseline — so anything the user typed while the model was thinking,
  building a segment or replying was never read by anyone. The read position now lives in
  `<watch>/chat-cursor.json`: a `cue` starts from where the last one stopped, and delivers what it
  finds the moment it enters the wait. Baseline is persisted as soon as it is established, because a
  `cue` that hears nothing (the common case) otherwise leaves no cursor for the next one.
- **Two messages arriving in the same poll.** Both watchers (chat box and host session file) marked
  the whole batch as read and reported only the first, so the second was gone. They now consume up
  to the message they hand over and no further — "reply first, then take the next one".
- **Wrong conversation.** `findActiveSessionFile()` took the most recently modified session jsonl
  across *all* projects, so a chat in another window could interrupt the watch session. It now
  prefers the project matching the current directory and only falls back to global when that one has
  no active session.
- **The host writing old messages late.** WorkBuddy flushes a user's message into the session file
  *after* the reply to it. The watcher saw new bytes and treated them as a fresh interjection —
  interrupting the current turn with the message that started it. Messages whose `timestamp`
  predates the watcher are now ignored.

Also in this path: interjections heard via the host input box are appended to the chat stream too
(they used to appear only in `cue`'s stdout, so the page showed a stream with a hole in it); the
chat page puts the words back in the input box when a send fails instead of losing them; and
`POST /api/say` answers `ok:false` for requests it did not write, which is what makes that recovery
possible.

### Fixed — `cue` and `say`

- `cue` no longer waits forever when the video changes underneath it. It compared against the
  segment delivery point of the *old* video, and if the new one was shorter, `deliverAt` was a
  position that would never be reached. It now detects a changed URL or duration and exits with
  `VIDEO-CHANGED` (pending lines are saved under the old source), and exits with `REWIND` when the
  user drags the progress bar back more than a minute — the model should hear about that instead of
  sitting on lines written for a position the user left.
- Two `cue` processes can no longer run at once: a state file saying `blocking` with a **live** pid
  is refused with `BUSY` (exit 1). A dead pid is taken for what it is — the residue of a killed run —
  and does not block anything. `check` mode is read-only and never takes the lock.
- `check` mode no longer leaves `cue-state.json` at `blocking`, which used to make the next run
  report "last wait was killed externally" for a run that was never waiting.
- `say` called edge-tts once by hand and then again inside `speak()` (twice the synthesis, and the
  manual attempt passed the raw configured voice, so a SAPI-style name like `Huihui` never matched
  and silently fell back). It now calls `speak()` once, which does the mapping and the fallback.
- `voices` was advertised in `help` and crashed with `cmdVoices is not defined` when called. It now
  lists the SAPI voices plus whether edge-tts is present and which voice is configured — the first
  place to look when "why am I still hearing the navigation lady" comes up.

### Added — talk instead of type: a microphone button in the floating window

`examples/floating-chat/mic.py` is a separate process the window starts from its `麦` button. It
listens, cuts what you say into utterances with the Silero VAD already sitting in `models-sherpa/`,
transcribes each one, and writes it into the **same** `chat.jsonl` the typing path uses — so a
running `cue` picks it up through the interjection cursor and the model answers without anyone
typing a character. Measured end to end on this machine (i9-12900HX, int8 paraformer):

- one model instance ≈ **284 MB** working set, loads in ~2 s
- a 3 s utterance transcribes in **0.15 s**; a 45 s one in ~1.2–3.3 s (RTF ≈ 0.05, 20× realtime)
- concurrent transcription barely queues: a 3 s short request takes 0.14 s even while a 45 s
  transcription is running

**It runs its own model by default** (`--engine local`), which is the answer to "can ASR run twice":
yes, and it is cheap. It also means the microphone never waits behind a video transcription. The
existing service cannot offer that yet — see the note below. `--engine http` shares port 8000
instead, saving 284 MB at the cost of queuing behind long audio.

**It refuses to hear itself.** The agent speaks through speakers; the microphone hears it; without a
guard that gets transcribed as if the user had said it, and the model answers its own line forever.
Every utterance is checked against `quiet-until.json` (the same window `say` and `cue` already take
before speaking) and dropped if the agent is talking.

### Added — acoustic echo cancellation, so the microphone hears you and not the computer

`examples/floating-chat/aec.py`: the microphone picks up whatever the speakers are playing, which
means the video's narration gets transcribed as if you had said it. Since neither `speexdsp` nor
`webrtc-audio-processing` builds on this machine (no C compiler, no wheels), this is a frequency-domain
adaptive filter (overlap-save FDAF, power-normalised NLMS) in numpy — one FFT per 32 ms frame.

It captures the **loopback** channel (what the computer is playing, auto-detected as the
speaker/loopback device, never "stereo mix" — that one can contain the microphone too) and subtracts
the estimated echo from the microphone. On top of that, an utterance whose energy drops below
`--echo-gate` (default 30 %) after cancellation is discarded outright: that is the hard guarantee
that pure-echo segments are never transcribed, whatever the filter is doing.

Two things that mattered more than the filter itself:

- **Double-talk detection cannot compare against the echo estimate.** At startup the filter is zero,
  so the estimate is zero, so "mic > 2 × estimate" is always true, so the filter freezes and never
  converges (first version: 498 frames frozen, 0 dB). It now compares against the **reference**
  signal (Geigel-style), which does not depend on the filter's state.
- **Measured on a synthetic but honest mixture** (real speech as the video, a different real speech
  segment as you, through a 150 ms-delayed reverberant echo path):
  ERLE **13.6 dB** during echo-only passage; the video's words in the transcript went from **25 % →
  0 %**, and an 8 s passage with nothing but video audio produced **no transcription at all**.

Tunables: `--dt-ratio` (1.4 — mic peak vs reference peak before the filter freezes), `--taps`
(8192 ≈ 512 ms of reverb tail), `--echo-gate`, `--no-aec`, `--loopback`.

Honest limits: it is a software AEC, not magic. The first second or two of your speech, right as the
filter re-converges after you start talking, is where the damage shows (a few characters in the test
above). Speaker loudness and room reverb both make it harder. **Headphones remove the problem
entirely** — with headphones there is no echo to cancel, and everything above is unnecessary.

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

### Added — closing the remaining "no one is listening" dead ends

- **Idle stop now wakes the model too.** Video-ended and video-changed already did; idle ("no movement
  for two segments") did not — and since the loop is stopped, nothing polls the chat box afterwards,
  so anything the user said next went nowhere. Now it wakes and says where it stopped.
- **Waiting is polled, not slept through.** The 500 ms tick in the blocking wait now uses
  `sleepWithChat`, so a message is noticed within ~150 ms instead of up to 500 ms later.
- **The tool description now tells the model what an interruption is:** a result carrying `chat` means
  "answer them first, then call again with the same arguments — the wait resumes, nothing is lost, and
  the image is already in the cache". Without this the model had no way to know.
- **`doctor` distinguishes "nobody is receiving" from "extension not connected".** Both look like
  silence, and the old wording told the user to reinstall the extension — but if no server is running
  on 9377 the extension cannot report at all, and reinstalling would have changed nothing.
- Stale SMTC-era wording removed from the strings the *model* reads (`input`/`cursor`/`title`
  descriptions, and the `browser:` line), which still talked about the OS media session.

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

### Removed — dead code trimmed so there is one decision path

Two functions that duplicated live logic and were never called in production are gone:

- `dueDecision` (in `src/timer.js`) — a pure "should I speak now" decision that shadowed
  `position.shouldSpeak`. Nothing in the loop ever called it; only a test exercised the abandoned
  design. The "pause too long → stop" intent it carried is now not implemented (see note below).
- `depthForBuffer` (in `src/batches.js`) — a count-based lookahead that duplicated `windowFor`,
  which the loop actually uses (position-based, so the invariant holds at every position, not just
  at segment starts). Its tests were redundant guards of that same invariant.

Net: 13 tests removed (8 for `dueDecision`, 5 for `depthForBuffer`); `windowFor`'s existing tests
already cover "lookahead ≥ N seconds at every position", so no coverage was lost.

### Changed — idle auto-stop now also covers a paused-and-abandoned video

The loop used to only stop itself on "no movement" when the last reading was a *playing* sample
(`why === 'recent-refresh'`). A paused video reports a frozen position forever — `estimate` returns
`why: 'paused'`, never stale — so pausing and walking away left the loop polling indefinitely. The
idle check now also fires on a frozen *paused* position, after the same `2 × segment` grace period,
and wakes you with "停了一会儿" so you can resume by calling `watch_together` again.

### Fixed — voice adapter no longer hard-codes a voice

`examples/voice-edge-tts/index.mjs` used to fall back to `zh-CN-XiaoxuanNeural` when
`~/.dsh/tts.json` had no `voice`. That baked one person's voice into the example, so shipping it
would have dragged that choice into everyone's install. It now falls back to the neutral
`zh-CN-YunxiNeural` and prints a one-line hint telling you to set `voice` in `~/.dsh/tts.json`
(e.g. `"voice": "zh-CN-XiaoxuanNeural"`). Nothing about the voice ships in the package — you mount
the adapter via `~/.dsh/voice.json` (or `DSH_VOICE_ADAPTER`) and pick the voice yourself.

## Earlier — 0.1.0 draft, never published (2026-10-30)

The first cut as a standalone plugin. It was not published under this number; the version line now
starts at 0.0.7, so this section is kept purely as a record of how the feature set got here. The feature existed inside `dsh-video-storyboard` 0.4.x as
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
