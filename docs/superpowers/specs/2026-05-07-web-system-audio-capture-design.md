# Web System Audio Capture — Design Spec

**Date:** 2026-05-07
**Scope:** Standalone web frontend only (`whisperlivekit/web/live_transcription.{html,css,js}`)
**Status:** Approved for implementation

## Goal

Let users transcribe **system audio** (a tab, a window, or the whole screen) alongside the microphone, from the web UI, without changing the server or the WebSocket protocol. Use case: meeting transcription where the user is one speaker and other participants come in over a Zoom/Meet/Teams tab.

## Non-goals

- Chrome extension changes — the `chrome.tabCapture` flow stays as-is. The mixing helper is written so the extension can adopt it later in a small follow-up.
- Speaker labelling as "me" vs "them". Diarization (already supported) labels speakers as "Speaker 1/2/3". Source-aware tagging is a future enhancement.
- New ASR or server-side features. The server keeps receiving one mono PCM stream per session.
- Mobile support. `getDisplayMedia` does not exist on mobile browsers.

## What real-world apps do (research summary)

- Production web transcribers (Otter web, Tactiq, Notta, Transkriptor, Deepgram-based extensions) all converge on **single mixed stream + server-side diarization**. Dual-stream ("me vs them") is a desktop-app pattern (Granola, Fathom) because those have OS-level access.
- The standard mixing pattern across Jitsi, addpipe and others uses Web Audio: two `MediaStreamAudioSourceNode`s feeding one `MediaStreamAudioDestinationNode`, then to `MediaRecorder`. Web Audio sums the two sources implicitly at the join point.
- This project does **not** use `MediaRecorder` for the audio worklet path — it pipes the worklet's `process()` output directly to a worker. So we can skip the `MediaStreamAudioDestinationNode` round-trip entirely and connect both sources straight into the existing `pcm-forwarder` `AudioWorkletNode`. The graph sums them for free.

## Browser reality (constraints)

- `getDisplayMedia({video: true, audio: true})` is the only standardised path. **`video: true` is mandatory**, even though we want audio-only. The video track is dropped immediately after acquisition.
- **Chrome/Edge desktop only.** Firefox and Safari implement the API but silently ignore the audio request (no error, no track). Mobile: not supported.
- macOS full-screen system audio requires Chrome 141+ on macOS 14.2+. Tab audio works everywhere Chrome works.
- The user must manually tick "Share audio" in the browser picker. If they don't, the returned stream has zero audio tracks — we must detect and surface this.
- The user can click "Stop sharing" in the browser toolbar at any time, ending the display track without any signal to our code beyond the track's `ended` event.

## UX

A single additive toggle alongside the existing microphone selector — no breaking change to the current flow.

```
[Microphone select ▼]   ☐ Also capture system audio  (Chrome/Edge only)
```

- **Default off.** Clicking record without it ticked behaves exactly like today.
- **When ticked:** at start-of-recording, after acquiring the mic stream, call `getDisplayMedia` to prompt the OS picker. If the user grants and ticks "Share audio", both streams are mixed. If they cancel or forget the audio checkbox, we abort with a clear status message and don't start the WebSocket.
- **Persisted** in `localStorage` like `selectedMicrophone` already is.
- **Disabled with tooltip on Firefox/Safari/mobile** (UA-sniff is acceptable here — feature-detect via `getDisplayMedia` existence and a UA hint).
- **Mid-session stop:** if the user clicks the browser's "Stop sharing" toolbar button, we keep recording mic-only and surface a small status message ("System audio sharing ended; continuing with microphone").

## Audio pipeline

```
                                                ┌─ analyser (waveform UI)
                                                │
mic MediaStreamAudioSourceNode ─────────────────┤
                                                ├──> pcm-forwarder (AudioWorkletNode)
sys MediaStreamAudioSourceNode (optional) ──────┘    │
                                                     ▼
                                          recorder_worker (resample 48k→16k, Int16 PCM)
                                                     │
                                                     ▼
                                                 WebSocket /asr
```

Key points:
- Both sources connect to **the same `audioContext`** and **the same `workletNode`**. Web Audio sums.
- The mic source still drives the `analyser` for the waveform — the visualisation stays mic-only so the user can see their own voice activity. (Mixing system audio into the visual would make the waveform cluttered and useless for monitoring mic input.)
- No `MediaStreamAudioDestinationNode` is needed; we are not handing the mixed stream to `MediaRecorder`.
- `numberOfInputs: 1, channelCount: 1` on the worklet — both sources downmix to mono at the join. This matches what the resampler worker expects today.
- For the legacy `MediaRecorder` path (when `serverUseAudioWorklet === false`): we **do** need a `MediaStreamAudioDestinationNode` because `MediaRecorder` takes a `MediaStream`. In that path only, we mix into a destination node and pass `dest.stream` to `MediaRecorder`.

## Module boundaries (small, focused additions)

New helpers in `live_transcription.js`:

| Helper | Purpose |
|---|---|
| `getSystemAudioStream()` | Wraps `getDisplayMedia({video:true, audio:true})`, drops the video track, validates that an audio track came back, attaches the `ended` listener for graceful fallback. Returns the audio-only `MediaStream` or throws a typed error (`NoAudioTrackError`, `UserCancelledError`, `UnsupportedError`). |
| `connectSourcesToWorklet(audioContext, workletNode, streams)` | Creates a `MediaStreamAudioSourceNode` per stream and connects each to the given worklet node. Returns the array of source nodes so they can be disconnected on stop. |
| `mixStreamsForMediaRecorder(audioContext, streams)` | Used only on the legacy `MediaRecorder` path. Builds a `MediaStreamAudioDestinationNode`, connects all sources to it, returns `{destStream, sources}`. |
| `isSystemAudioSupported()` | Feature/UA detection for enabling the toggle. |

These are written so the extension's `isExtension` branch could later swap `chrome.tabCapture`'s stream into the same `connectSourcesToWorklet` call to mix mic+tab. Not done in this spec — but the seam is clean.

## State changes in `live_transcription.js`

New module-scoped variables:
- `let systemAudioEnabled = false;` — UI toggle state.
- `let systemAudioStream = null;` — kept so we can stop tracks on cleanup.
- `let systemAudioSourceNode = null;` — the Web Audio source node for the system stream.
- `let systemTrackEndedHandler = null;` — for cleanup.

Changes to existing functions:
- `startRecording()`: after acquiring `stream` (mic), if `systemAudioEnabled && isWebContext`, attempt `getSystemAudioStream()`. On success, in the AudioWorklet path, call `connectSourcesToWorklet(audioContext, workletNode, [systemAudioStream])`. In the `MediaRecorder` path, mix mic+system into a destination node and feed `dest.stream` to the recorder. On failure, abort recording with a status message and release the wake lock. Don't open the WebSocket if the user cancelled the system-audio dialog.
- `stopRecording()`: stop tracks on `systemAudioStream`, disconnect `systemAudioSourceNode`, remove `ended` handler, null the references.
- `updateUI()`: no functional changes — the toggle's enabled/disabled state is set once at page load.

## HTML / CSS

- New row in the settings panel under the microphone select: a checkbox + label, with a small `(Chrome/Edge only)` caption.
- Reuses existing `.field` styling. Add a `.checkbox-field` variant if the layout needs it (small change in `live_transcription.css`).
- The checkbox is disabled at page load if `isSystemAudioSupported()` returns false; tooltip explains why.

## Error handling

| Failure | Behaviour |
|---|---|
| User cancels `getDisplayMedia` picker | `NotAllowedError` → status: "System audio sharing cancelled. Click record again to retry." Wake-lock released, no WebSocket opened. |
| User forgets "Share audio" checkbox | Returned stream has 0 audio tracks → status: "No audio in shared source. Re-share and tick 'Share audio'." Wake-lock released. |
| Browser doesn't support audio (Firefox/Safari) | Toggle disabled at load time, never reachable at recording time. |
| User clicks "Stop sharing" mid-session | Track `ended` fires → disconnect system source from worklet, status: "System audio sharing ended; continuing with microphone." Recording continues. |
| Mic permission denied | Existing behaviour, unchanged. |

## Cleanup invariants

- Always stop **all** tracks on the `systemAudioStream` (both audio and any video that wasn't dropped).
- Disconnect source nodes before closing the `audioContext` (existing pattern).
- Remove the `track.ended` listener to avoid stale callbacks firing during/after stop.
- These cleanup steps run in **`stopRecording()`** and on the WebSocket `onclose` path. Both need to handle "system audio was never enabled" gracefully (early-return on null).

## Testing plan

This is a UI change. The `TestHarness` (Python, server-side) can't exercise browser code paths. Verification is manual:

1. **Mic-only regression:** Toggle off, click record, speak — confirm transcription matches today's behaviour. No regression.
2. **Mic + tab audio:** Toggle on, click record, browser picker appears, pick a YouTube tab with "Share audio" ticked, play a video while speaking — confirm transcription contains both sources, diarization labels them as different speakers.
3. **User forgets "Share audio":** Toggle on, click record, pick a tab without ticking the audio checkbox — confirm clear error, no recording started.
4. **User cancels picker:** Toggle on, click record, click Cancel in picker — confirm clear status, no recording started, ready to retry.
5. **Mid-session stop:** Start with system audio, click "Stop sharing" in toolbar — confirm status message and recording continues with mic.
6. **Firefox:** Open page in Firefox, confirm toggle is disabled with tooltip.
7. **Toggle persistence:** Tick toggle, reload page, confirm it stays ticked.

## Files touched

- `whisperlivekit/web/live_transcription.html` (~10 lines added — new settings row)
- `whisperlivekit/web/live_transcription.css` (~10 lines added — checkbox row styling)
- `whisperlivekit/web/live_transcription.js` (~120 lines added — helpers, state, integration into start/stop)

No other files. No server changes. No protocol changes.

## Future follow-ups (out of scope)

1. Apply the same `connectSourcesToWorklet` helper to the Chrome extension's `isExtension` branch so it captures `chrome.tabCapture` + mic together. Resolves the existing TODO at `live_transcription.js:530`.
2. Source-aware speaker tagging: send a small metadata frame at session start ("client thinks mic is one source, system is another") and let the server bias diarization to keep them separate, then label as "You" vs "Other".
3. Per-source gain controls in the UI, in case system audio drowns the mic or vice versa.
