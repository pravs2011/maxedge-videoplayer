# PRD

- **MAXVIDEO_PLAYER** is an Electron‐based video player that can take an ElevenLabs API key, a Google Cloud TTS key, or a generic VoiceBox token and automatically generate synthetic audio in the language of the video. The workflow is:

1. Detect the language of the video (or of an optional subtitle/metadata file).
2. **Select an appropriate TTS engine and voice for that language** (ElevenLabs, Google TTS, or VoiceBox) — cheapest configured engine by default.
3. Stream the video using a normal HTML5 `<video>` element.
4. Generate TTS audio from the video’s transcript (or from a supplied text) using the chosen engine.
5. Synchronise the generated audio with the video playback, either by:
   - Re‐encoding the video with the new audio track, or
   - Playing the TTS audio in parallel and keeping it in sync with the video timeline.

The result is a single‐page app that works for any language supported by the selected engine (ElevenLabs, Google, etc.) as long as the language can be detected.

---

## Goals

- Provide a user‐friendly interface for playing videos with automatically generated audio.
- Support all languages offered by the configured TTS engines (ElevenLabs, Google Cloud TTS, …).
- Ensure audio–video synchronization with minimal latency.
- Deliver a lightweight, cross‐platform Electron application.
- Play **very large video files (3–4 GB and above)** in real time with instant seeking, without loading the whole file into memory.
- Provide **real‐time translation audio**: TTS must be generated and buffered *ahead* of the playhead so playback never stalls waiting for the TTS service.
- Minimise TTS cost by **automatically selecting the cheapest engine** per language, with manual override.

## Features

- **Language Detection**: Auto‐detect video language using metadata, subtitles, or transcript analysis.
- **Multi‐Engine TTS (VoiceBox)**: Common adapter interface with implementations for **ElevenLabs**, **Google Cloud TTS**, and any additional VoiceBox‑compatible engine.
- **Cost‐Aware Engine Selection**: A cost estimator picks the cheapest enabled engine for the detected language; the user can override the choice in Settings.
- **Engine Fallback**: If the selected engine fails (rate limit, auth, server error), automatically fall back to the next enabled engine.
- **Voice Selection**: Map detected language to an appropriate voice for the chosen engine.
- **Audio Generation**: Stream TTS audio from the selected engine in real‐time.
- **Real‐time Translation Pipeline**: The transcript is split into time‐aligned segments; TTS is prefetched for upcoming segments so translation audio is always ready before the playhead reaches them.
- **Large File Support (3–4 GB+)**: Local files are streamed from disk via byte‐range reads — the whole file is never loaded into memory. Seek/scrub is instant and does not require re‐reading the file.
- **Sync Options**: Offer both re‐encoding (offline) and live sync (online) modes. Live sync is the recommended mode for multi‐GB files because it avoids producing a second multi‐GB output file.
- **Electron Shell**: Single‐page UI with HTML5 `<video>` element and custom controls.
- **Configuration**: API key storage (one per engine, in OS keychain), language preferences, sync mode toggle, buffering/look‐ahead settings, per‑session cost cap.
- **Error Handling**: Graceful degradation if all engines fail or the language is unsupported.

## Technical Design

- **Electron**: Main process launches a renderer with a single HTML page.
- **Renderer**: Handles `<video>` playback, audio stream handling, UI controls.
- **Large‐file streaming**: Local videos are served to the `<video>` element through a custom Electron protocol handler that performs byte‐range (partial) reads from disk — the file is never read whole into memory. Remote videos use standard HTTP Range requests.
- **Language Detection**: Use existing libraries or custom heuristic parsing of subtitle files.
- **VoiceBox abstraction**: A common `synthesize(text, lang, voiceId)` interface with per‐engine adapters (ElevenLabs, Google TTS). The active adapter is chosen by the cost estimator or by the user's manual override, with automatic fallback on errors.
- **Real‐time translation**: Transcript is chunked into time‐aligned segments; TTS for upcoming segments is prefetched into a disk‑backed segment cache ahead of the playhead.
- **Sync Mechanism**:
  - Re‐encode: Use FFmpeg (stream copy — no video re‐compression) to merge video and TTS audio offline.
  - Live: Buffer TTS audio and align timestamps with video currentTime.
- **State Management**: Minimal Redux‐style store for playback state, audio sync, and engine settings.

## User Flow

1. User opens the app.
2. Loads a video file (local or URL) — even multi‐GB files start playing almost immediately.
3. App detects language and selects voice.
4. App selects the cheapest configured TTS engine for that language (or the user's preferred engine).
5. User chooses sync mode (live sync recommended for very large files).
6. Video plays with generated audio, translated ahead of the playhead in real time.
7. User can pause, seek (instantly, even deep into a 4 GB file), adjust volume, change engine/voice, or change settings.

## Risks & Mitigations

- **API Limits**: ElevenLabs/Google rate limits could throttle playback; cache generated TTS segments on disk and reuse them across seeks/replays.
- **Multiple API keys & billing**: Centralised key management in the OS keychain; validate keys on load; engines can be enabled/disabled individually.
- **Cost explosion**: Real‑time cost estimator and per‑session cost cap; cost dashboard in Settings.
- **Language Detection Failures**: Fallback to manual language selection.
- **Sync Drift**: Implement periodic re‐alignment checks.
- **Large Video Files (3–4 GB)**:
  * Never load the whole file into memory — stream via Range‐based reads only.
  * Re‐encoding a 4 GB file creates a second multi‐GB file and can take a long time — default to live‐sync mode for large files, warn before re‐encoding, and require enough free disk space (≈ file size).
  * Random seeking in multi‐GB files must remain instant (target < 500 ms to first frame after seek).
- **TTS Latency**: If the TTS engine is slower than real time, playback would stall — mitigate with segment prefetch (look‐ahead buffering) and a disk‑backed segment cache.
- **Subtitle/Transcript for Long Videos**: Multi‐hour videos produce very long transcripts — process them in chunks (segment‐by‐segment) rather than one monolithic TTS request.

---

## Project Structure

The application source lives under the **`electron/`** directory:

```
electron/
├── package.json              # Scripts & dependencies
├── vite.config.js            # Renderer bundler config
├── index.html                # Renderer entry HTML
├── main.js                   # Electron main process (window, protocol, IPC, FFmpeg)
├── preload.js                # Context bridge: exposes a minimal IPC API
└── src/
    ├── main.jsx              # React entry point
    ├── App.jsx               # Single-page app shell
    ├── styles.css            # Global styles
    ├── store.js              # Redux store + slices (video, audio, settings, sync, errors)
    ├── components/
    │   ├── Player.jsx        # <video> element + transport controls
    │   ├── Settings.jsx      # API keys, engine picker, sync mode, cost cap
    │   └── VoicePicker.jsx   # Voice selection for the active engine
    ├── services/
    │   ├── languageDetector.js   # Subtitle/metadata language detection
    │   ├── transcript.js         # Subtitle parsing (.srt/.vtt) → time-aligned segments
    │   ├── ttsPrefetcher.js      # Look-ahead TTS buffering + disk segment cache
    │   ├── syncEngine.js         # Live audio/video sync + drift correction
    │   ├── reencoder.js          # FFmpeg re-encode (main-process side via IPC)
    │   └── voicebox/
    │       ├── index.js          # Adapter registry + cost-aware selection + fallback
    │       ├── elevenlabs.js     # ElevenLabs adapter
    │       ├── google.js         # Google Cloud TTS adapter
    │       └── costEstimator.js  # $/1M-chars pricing → cheapest engine per language
    └── store/
        └── ...                 # Redux slice files (if split out)
```

Build & run:

```
cd electron
npm install
npm run dev        # Vite dev server + Electron
npm run build      # Production renderer bundle
npm run package    # electron-builder installers
```

---

## Roadmap

| Milestone | Description | Timeline |
|-----------|-------------|----------|
| MVP | Core playback + TTS sync for small files | 4 weeks |
| Large‐file streaming | 3–4 GB real‐time playback, instant seek | 2 weeks |
| Real‐time translation pipeline | Segment prefetch + TTS cache | 2 weeks |
| Multi‐engine VoiceBox | ElevenLabs + Google adapters, cost estimator, fallback | 2 weeks |
| Language support expansion | Add more voices | 2 weeks |
| Re‐encoding feature | Offline audio merge (with disk‐space guard) | 3 weeks |
| UI polish | Responsive design | 1 week |

---

## Acceptance Criteria

- Video loads and plays in `<video>` element.
- Language is detected or user can manually select.
- Correct TTS engine and voice are chosen automatically (cheapest enabled engine for the language).
- User can override the engine manually; failed engines fall back automatically.
- TTS audio plays in sync with video.
- Re‐encoding option merges audio successfully.
- Application runs on Windows, macOS, Linux.
- A 3–4 GB local video plays in real time with **flat memory usage** (no full‐file load) and seek latency < 500 ms.
- Translation (TTS) audio is prefetched ahead of the playhead so playback never stalls waiting for the TTS service under normal network conditions.

---

## Dependencies

- Electron
- FFmpeg (for re‐encoding)
- ElevenLabs API
- Google Cloud TTS API
- VoiceBox SDK (wrapper for multiple TTS engines)
- Node.js
- Vite, React, Redux Toolkit, Axios

---

## Contact

For questions, reach out to the project lead.
