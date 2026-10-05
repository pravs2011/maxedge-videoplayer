# Technical Specification

## 1. Overview

**MAXVIDEO_PLAYER** is an Electron‐based single‐page video player that automatically generates synthetic audio from a video’s transcript or subtitle file using pluggable Text‐to‐Speech (TTS) engines — **ElevenLabs**, **Google Cloud TTS**, or any **VoiceBox**‑compatible provider — behind one common adapter interface. The player supports any language for which a configured engine offers a voice, detects the language automatically or allows manual selection, streams the video via a normal HTML5 `<video>` element (including local files of **3–4 GB+** via byte‑range reads), and synchronises the generated audio with the video playback in real time. Users can either play the TTS audio live in parallel (recommended for large files) or re‐encode the video with a new audio track.

---

## 2. Functional Requirements

| # | Feature | Description |
|---|---------|-------------|
| FR‐01 | Video loading | Load local video files or remote URLs (HTTP/HTTPS, HLS, DASH). |
| FR‐02 | Language detection | Detect language from embedded metadata, subtitle (.srt/.vtt), or transcript text. |
| FR‐03 | Voice selection | Map detected language to an appropriate voice ID for the active engine. |
| FR‐04 | Transcript extraction | Extract subtitles or generate transcript via optional OCR if no subtitles. |
| FR‐05 | Audio generation | Request the active TTS engine to synthesize the transcript. |
| FR‐06 | Live sync mode | Stream TTS audio to the browser and keep it aligned with the video timeline. |
| FR‐07 | Re‐encoding mode | Use FFmpeg to merge the original video with the generated TTS audio into a new file. |
| FR‐08 | UI controls | Play, pause, seek, volume, sync mode toggle, engine picker, voice picker, language picker, cost dashboard. |
| FR‐09 | Configuration | Persist one API key per engine, sync mode, default language, audio buffering settings, cost cap. |
| FR‐10 | Error handling | Graceful degradation if all engines fail, language unsupported, or video corrupt. |
| FR‐11 | Logging | Structured logs for debugging and telemetry (non‐personal data only). |
| FR‐12 | Security | Store API keys encrypted in the OS keychain. |
| FR‐13 | Platform support | Run on Windows, macOS, and Linux (x64). |
| FR‐14 | Large‐file streaming | Support 3–4 GB+ video files with memory‐efficient streaming and instant seek, using a custom protocol handler for byte‑range reads. |
| FR‐15 | Multi‐engine TTS | Select between ElevenLabs, Google Cloud TTS, and VoiceBox engines; default engine chosen automatically by lowest estimated cost for the detected language. |
| FR‐16 | Engine fallback | If the selected engine returns 429/401/5xx or times out, automatically fall back to the next enabled engine and retry. |
| FR‐17 | Real‐time TTS prefetch | Prefetch TTS audio for upcoming transcript segments ahead of the playhead into a disk‑backed cache so playback never stalls. |
| FR‐18 | Cost controls | Show estimated and incurred TTS cost; enforce an optional per‑session cost cap. |

---

## 3. Non‐Functional Requirements

| # | Requirement | Specification |
|---|-------------|--------------|
| NFR‐01 | Performance | Audio buffering must keep up with playback; sync drift < 200 ms. |
| NFR‐02 | Responsiveness | UI should respond within 150 ms for all user actions. |
| NFR‐03 | Resource usage | Peak CPU < 50 % on a typical desktop; memory < 1 GB regardless of video file size. |
| NFR‐04 | Security | API keys never logged; no network traffic beyond HTTPS to TTS providers. |
| NFR‐05 | Reliability | 99.9 % availability of local playback; retry logic with exponential back‑off for network failures. |
| NFR‐06 | Extensibility | Adding a new TTS engine requires only a new adapter implementing the VoiceBox interface — no player changes. |
| NFR‐07 | Localization | UI supports dynamic language changes (English, Spanish, French, German, Italian, Portuguese, …). |
| NFR‐08 | Seek latency | < 500 ms to first frame after seeking anywhere in a 3–4 GB local file. |
| NFR‐09 | Startup | A 4 GB local video begins playback within 2 s of selection (metadata read only, no full load). |

---

## 4. System Architecture

```
+---------------------------------+
|         Electron Main           |
|  (Node.js runtime)              |
|  - window / app lifecycle       |
|  - mvp:// byte-range protocol   |
|  - keychain (keytar)            |
|  - FFmpeg re-encode child       |
+--------------------------------+
        |  IPC (contextBridge)
        V
+---------------------------------+       +----------------------+
|  Renderer (React SPA)           |       |  FFmpeg Subprocess   |
|  - <video> (mvp:// or https://) |<------|  (re-encode only)    |
|  - Web Audio sync engine        |       +----------------------+
|  - Redux store                  |
|  - TTS prefetcher + disk cache  |
|  - VoiceBox adapter registry    |-----> +----------------------+
|    ├─ ElevenLabsAdapter         |  HTTP | ElevenLabs TTS API   |
|    ├─ GoogleTTSAdapter          |-----> +----------------------+
|    └─ costEstimator + fallback  |  HTTP | Google Cloud TTS API |
+---------------------------------+       +----------------------+
```

*Main process* orchestrates the application lifecycle, opens the renderer window, registers a custom `mvp://` protocol that performs byte‑range reads of local files (so multi‑GB videos are never loaded whole), stores API keys via `keytar`, and spawns FFmpeg for re‐encoding. *Renderer* handles all UI, playback, TTS prefetch, and audio streaming. The renderer talks to the main process only through a minimal `preload.js` context bridge.

---

## 5. Component Design

### 5.1 Main Process (`electron/main.js`)

| Component | Responsibility |
|-----------|----------------|
| `app.js` | Electron bootstrap, window creation, IPC handlers. |
| `protocol.js` | Registers `mvp://` scheme; streams local files with `Range` header support (open/read/stat via `fs.createReadStream`). |
| `ffmpeg.js` | Wrapper for FFmpeg CLI. Handles re‐encoding jobs, progress callbacks, error handling, free‑disk‑space guard. |
| `keychain.js` | Secure storage of per‑engine API keys using `keytar`. |
| `config.js` | Persistent user configuration (JSON in `userData`). |
| `logger.js` | Structured logging (level, timestamp). |

**Byte‑range protocol (large files):**

```js
protocol.handle('mvp', async (request) => {
  const filePath = urlToPath(request.url);
  const stat = await fs.promises.stat(filePath);
  const range = request.headers.get('Range');          // e.g. "bytes=1000000-1999999"
  const { start, end } = parseRange(range, stat.size); // clamped to file size
  const stream = fs.createReadStream(filePath, { start, end });
  return new Response(stream, {
    status: range ? 206 : 200,
    headers: {
      'Content-Type': mimeFor(filePath),
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {}),
    },
  });
});
```

Only the requested byte window is ever read — memory stays flat regardless of file size.

### 5.2 Renderer Process

| Component | Responsibility |
|-----------|----------------|
| `index.html` | Root page with `<video>` element, control bar. |
| `App.jsx` | React root component, mounts Redux store. |
| `Player.jsx` | Video and audio playback logic, event listeners, sync algorithm. |
| `syncEngine.js` | Web Audio API: buffers TTS audio, keeps it aligned with `video.currentTime`. |
| `ttsPrefetcher.js` | Splits transcript into time‑aligned segments; requests TTS for the next N segments ahead; writes/reads a disk cache. |
| `VoicePicker.jsx` | Voice selection UI for the active engine. |
| `Settings.jsx` | API keys per engine, engine picker, sync mode, language defaults, cost cap. |
| `store.js` | Redux store: `video`, `audio`, `settings`, `sync`, `engines`, `errors`. |
| `languageDetector.js` | Detect language from subtitles or transcript (`franc` + heuristics). |
| `transcript.js` | Parse `.srt`/`.vtt` into `[{ start, end, text }]` segments. |
| `voicebox/` | Adapter registry (see §6). |

### 5.3 Audio‐Video Sync Algorithm

1. **Live mode** (recommended for 3–4 GB files):
   * Prefetch the first N seconds of TTS audio before playback starts.
   * On video `timeupdate`, check if the buffered audio segment matches the video time (allow drift < 200 ms).
   * If behind, request the next segment immediately; if ahead, pause audio briefly.
   * Correct drift by adjusting `AudioBufferSourceNode.playbackRate` or re‑anchoring `start(when)` time.
2. **Re‐encoding mode**:
   * After TTS audio is fully streamed to a temporary file, launch FFmpeg with **stream copy** (no video re‑compression):
     ```bash
     ffmpeg -i input.mp4 -i audio.wav -c copy -map 0:v -map 1:a -shortest output.mp4
     ```
   * Provide progress events to UI; require free disk space ≥ input size before starting.

---

## 6. Multi‑Engine TTS (VoiceBox)

### 6.1 Adapter Interface

```ts
interface TTSAdapter {
  id: 'elevenlabs' | 'google' | string;
  displayName: string;
  supportsLanguage(langCode: string): boolean;
  listVoices(langCode: string): Promise<Voice[]>;
  synthesize(opts: {
    text: string;
    langCode: string;
    voiceId: string;
    onChunk: (bytes: Uint8Array) => void;   // streaming callback
  }): Promise<void>;
  estimateCostPer1kChars(langCode: string): number;  // USD
}
```

### 6.2 Registry & Selection (`voicebox/index.js`)

1. Register all adapters that have a valid API key and are enabled in settings.
2. On video load, after language detection: sort enabled adapters by `estimateCostPer1kChars(detectedLang)` ascending → pick cheapest that `supportsLanguage(lang)`.
3. User manual override in Settings bypasses step 2.
4. **Fallback**: on `429 / 401 / 5xx / timeout`, mark the failed adapter cool‑down (30 s), pick the next cheapest, retry the segment.

### 6.3 Adapters

**ElevenLabs** (`elevenlabs.js`)

| Element | Details |
|---------|---------|
| Endpoint | `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream` |
| Auth | `xi-api-key` header |
| Body | `{"text":"…","model_id":"eleven_multilingual_v2","voice_settings":{"stability":0.5,"similarity_boost":0.75}}` |
| Response | Streamed `audio/mpeg` |
| Rate limits | 429 → exponential back‑off + fallback |

**Google Cloud TTS** (`google.js`)

| Element | Details |
|---------|---------|
| Endpoint | `POST https://texttospeech.googleapis.com/v1/text:synthesize` |
| Auth | OAuth2 bearer token (service account JSON) or API key |
| Body | `{"input":{"text":"…"},"voice":{"languageCode":"es-ES"},"audioConfig":{"audioEncoding":"MP3"}}` |
| Response | Base64 `audioContent` (chunked client‑side for streaming) |
| Rate limits | Per‑second quota → queue + back‑off |

**Cost estimator** (`costEstimator.js`): table of USD per 1 M characters per engine/language tier; returns cheapest adapter id for a language. Incurred cost is accumulated per session and displayed in Settings.

---

## 7. Re‐encoding Pipeline (FFmpeg)

*Requirements*: FFmpeg bundled via `ffmpeg-static` or available in PATH.

*Steps*:
1. **Guard**: verify free disk space ≥ input file size + 10 % (critical for 4 GB inputs).
2. **Audio file**: write streamed TTS audio to a temp file.
3. **FFmpeg call** (stream copy — video is never re‑compressed):
   ```js
   const ffmpegArgs = [
     '-y',
     '-i', videoPath,
     '-i', audioPath,
     '-c', 'copy',
     '-map', '0:v',
     '-map', '1:a',
     '-shortest',
     outputPath
   ];
   ```
4. **Progress**: parse `time=` lines from `stderr`.
5. **Error handling**: non‑zero exit → friendly error + retry.

---

## 8. Electron Architecture

- **Main process**: Node ≥ 18, `electron@25`.
- **Renderer**: React 18 + Vite bundler (fast dev server & HMR).
- **Security**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; `preload.js` exposes a minimal IPC API only.
- **Custom protocol**: `mvp://` registered as privileged scheme for byte‑range local streaming.
- **Packaging**: `electron-builder` for cross‑platform installers; `asar` enabled.

---

## 9. State Management

Redux Toolkit slices:

```
rootReducer = combineReducers({
  video: videoSlice,      // src, duration, currentTime, buffered
  audio: audioSlice,      // playing, volume, bufferLevel
  settings: settingsSlice,// engineKeys (per engine), preferredEngine, syncMode,
                          // defaultLanguage, bufferSeconds, costCap, retryAttempts
  sync: syncSlice,        // mode: 'live'|'reencode', driftMs, prefetchedSegments
  engines: enginesSlice,  // enabled adapters, activeAdapter, cooldowns, sessionCostUsd
  errors: errorSlice
});
```

---

## 10. Security & Privacy

- **API keys**: stored per engine in the OS keychain via `keytar`; never in plaintext config, never logged.
- **Network**: HTTPS only to TTS providers.
- **Sandboxing**: renderer has no Node access; all privileged ops go through `preload.js`.
- **Telemetry**: optional, opt‑in, no PII.

---

## 11. Testing Strategy

| Category | Tool | Notes |
|----------|------|-------|
| Unit | Jest + React Testing Library | Reducers, selectors, adapters, cost estimator. |
| Integration | Playwright | Load video, sync mode switch, engine switch, re‐encode progress. |
| End‐to‐End | Cypress | Renderer ↔ main IPC flows. |
| API | msw (Mock Service Worker) | Mock ElevenLabs & Google TTS responses. |
| Performance | Benchmark.js + custom harness | Sync drift, seek latency on a 4 GB fixture file, prefetch throughput. |

---

## 12. Build & Deployment

```
cd electron
npm install
npm run dev        # Vite dev server + Electron (concurrently)
npm run build      # Production renderer bundle
npm run package    # electron-builder → .exe / .dmg / .AppImage
```

---

## 13. Dependencies

- **Electron** 25.x · **React** 18.x · **Redux Toolkit** 2.x
- **Axios** 1.x (or `undici` fetch in main)
- **ffmpeg-static** 5.x · **keytar** 8.x · **franc** 5.x (language detection)
- **@google-cloud/text-to-speech** (Google adapter)
- **Vite** 5.x · **electron-builder** 24.x
- **Jest**, **Playwright**, **Cypress** (testing)

---

## 14. Roadmap

| Sprint | Goal | Duration |
|--------|------|----------|
| 1 | Core playback & TTS live sync | 2 weeks |
| 2 | Language detection + voice picker | 1 week |
| 3 | Large‑file `mvp://` protocol + seek perf | 1 week |
| 4 | TTS prefetcher + disk segment cache | 1 week |
| 5 | VoiceBox: ElevenLabs + Google adapters, cost estimator, fallback | 2 weeks |
| 6 | Re‐encoding module & UI | 2 weeks |
| 7 | Packaging & OS installers | 1 week |
| 8 | Performance tuning & CI | 1 week |
| 9 | Documentation & user guide | 1 week |

---

## 15. Appendix

### 15.1 Voice Mappings

`elevenlabs-voices.json` — `language_code → voice_id`:

```json
{
  "en": "ELEVENLABS_EN_VOICE_ID",
  "es": "ELEVENLABS_ES_VOICE_ID",
  "fr": "ELEVENLABS_FR_VOICE_ID",
  "de": "ELEVENLABS_DE_VOICE_ID",
  "it": "ELEVENLABS_IT_VOICE_ID",
  "pt": "ELEVENLABS_PT_VOICE_ID"
}
```

`google-voices.json` — `language_code → Wavenet voice name`:

```json
{
  "en": "en-US-Wavenet-D",
  "es": "es-ES-Wavenet-B",
  "fr": "fr-FR-Wavenet-C",
  "de": "de-DE-Wavenet-B",
  "it": "it-IT-Wavenet-A",
  "pt": "pt-BR-Wavenet-B"
}
```

### 15.2 Example Settings JSON (`settings.json`)

```json
{
  "preferredEngine": "auto",
  "enabledEngines": ["elevenlabs", "google"],
  "syncMode": "live",
  "defaultLanguage": "en",
  "voiceIds": { "elevenlabs": "…", "google": "…" },
  "bufferSeconds": 5,
  "lookAheadSegments": 3,
  "retryAttempts": 3,
  "costCapUsd": 2.0
}
```

(API keys are **not** stored here — they live in the OS keychain.)

---

## 16. Contact & Support

- Issue tracker: https://github.com/your-org/maxvideoplayer/issues
- Documentation: https://maxvideoplayer.readthedocs.io/
- Mailing list: devs@maxvideoplayer.org

---

*End of Technical Specification*
