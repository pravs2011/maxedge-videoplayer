import { configureStore, createSlice } from '@reduxjs/toolkit';

// ---------------------------------------------------------------------------
// Video slice — source, playback state, duration
// ---------------------------------------------------------------------------
const videoSlice = createSlice({
  name: 'video',
  initialState: {
    src: null,          // mvp:// or https:// URL
    filePath: null,     // local absolute path (for re-encode)
    fileName: null,
    fileSize: 0,        // bytes — informational for large-file warnings
    duration: 0,
    currentTime: 0,
    playing: false,
    volume: 1,
    muted: false,
    ready: false,
  },
  reducers: {
    setVideo: (state, { payload }) => {
      state.src = payload.url;
      state.filePath = payload.filePath || null;
      state.fileName = payload.name || null;
      state.fileSize = payload.size || 0;
      state.duration = 0;
      state.currentTime = 0;
      state.playing = false;
      state.ready = false;
    },
    setDuration: (state, { payload }) => { state.duration = payload; },
    setCurrentTime: (state, { payload }) => { state.currentTime = payload; },
    setPlaying: (state, { payload }) => { state.playing = payload; },
    setVolume: (state, { payload }) => { state.volume = payload; },
    setMuted: (state, { payload }) => { state.muted = payload; },
    setReady: (state, { payload }) => { state.ready = payload; },
    clearVideo: () => videoSlice.getInitialState(),
  },
});

// ---------------------------------------------------------------------------
// Audio slice — TTS playback state
// ---------------------------------------------------------------------------
const audioSlice = createSlice({
  name: 'audio',
  initialState: {
    playing: false,
    volume: 1,             // master / voice volume
    originalVolume: 0,     // 0 = completely muted/suppressed, 0.15 = ducked background
    originalMuted: true,   // whether original video audio is suppressed during translation
    bufferLevel: 0,        // 0-1, how full the look-ahead buffer is
    currentSegment: -1,    // index of the segment being played
  },
  reducers: {
    setAudioPlaying: (state, { payload }) => { state.playing = payload; },
    setAudioVolume: (state, { payload }) => { state.volume = payload; },
    setOriginalVolume: (state, { payload }) => { state.originalVolume = payload; },
    setOriginalMuted: (state, { payload }) => { state.originalMuted = payload; },
    setBufferLevel: (state, { payload }) => { state.bufferLevel = payload; },
    setCurrentSegment: (state, { payload }) => { state.currentSegment = payload; },
  },
});

// ---------------------------------------------------------------------------
// Settings slice — persisted user preferences
// ---------------------------------------------------------------------------
const settingsSlice = createSlice({
  name: 'settings',
  initialState: {
    preferredEngine: 'auto',        // 'auto' | 'elevenlabs' | 'google'
    enabledEngines: ['elevenlabs', 'google'],
    syncMode: 'live',               // 'live' | 'reencode'
    defaultLanguage: 'en',
    targetLanguage: 'en',
    translateEnabled: true,
    asrEngine: 'sensevoice_local',  // 'sensevoice_local' | 'groq_whisper'
    groqModel: 'qwen/qwen3.8-27b',
    groqBaseUrl: 'https://api.groq.com/openai/v1/',
    bufferSeconds: 5,
    lookAheadSegments: 3,
    retryAttempts: 3,
    costCapUsd: 2.0,
    loaded: false,
  },
  reducers: {
    loadSettings: (state, { payload }) => {
      if (!payload) return;
      Object.assign(state, payload, { loaded: true });
    },
    updateSettings: (state, { payload }) => {
      Object.assign(state, payload);
    },
  },
});

// ---------------------------------------------------------------------------
// Engines slice — runtime adapter state (active, cooldowns, cost)
// ---------------------------------------------------------------------------
const enginesSlice = createSlice({
  name: 'engines',
  initialState: {
    activeEngine: null,             // currently selected adapter id
    availableVoices: [],            // Voice[] from the active adapter
    selectedVoiceId: null,
    detectedLanguage: null,
    sourceLanguage: null,
    targetLanguage: 'en',
    cooldowns: {},                  // { [engineId]: expiryTimestamp }
    sessionCostUsd: 0,
    costCapReached: false,
  },
  reducers: {
    setActiveEngine: (state, { payload }) => { state.activeEngine = payload; },
    setAvailableVoices: (state, { payload }) => { state.availableVoices = payload; },
    setSelectedVoice: (state, { payload }) => { state.selectedVoiceId = payload; },
    setDetectedLanguage: (state, { payload }) => { state.detectedLanguage = payload; },
    setSourceLanguage: (state, { payload }) => { state.sourceLanguage = payload; },
    setTargetLanguage: (state, { payload }) => { state.targetLanguage = payload; },
    addCooldown: (state, { payload: { engine, until } }) => {
      state.cooldowns[engine] = until;
    },
    clearCooldown: (state, { payload }) => {
      delete state.cooldowns[payload];
    },
    addCost: (state, { payload }) => {
      state.sessionCostUsd += payload;
    },
    setCostCapReached: (state, { payload }) => {
      state.costCapReached = payload;
    },
  },
});

// ---------------------------------------------------------------------------
// Sync slice — live sync / re-encode status
// ---------------------------------------------------------------------------
const syncSlice = createSlice({
  name: 'sync',
  initialState: {
    mode: 'live',          // 'live' | 'reencode'
    driftMs: 0,
    totalSegments: 0,
    prefetchedSegments: 0,
    reencodeProgress: 0,   // seconds processed
    reencodeOutput: null,
    reencoding: false,
  },
  reducers: {
    setSyncMode: (state, { payload }) => { state.mode = payload; },
    setDrift: (state, { payload }) => { state.driftMs = payload; },
    setSegmentCounts: (state, { payload: { total, prefetched } }) => {
      state.totalSegments = total;
      state.prefetchedSegments = prefetched;
    },
    setReencodeProgress: (state, { payload }) => { state.reencodeProgress = payload; },
    setReencodeOutput: (state, { payload }) => { state.reencodeOutput = payload; },
    setReencoding: (state, { payload }) => { state.reencoding = payload; },
  },
});

// ---------------------------------------------------------------------------
// Errors slice — most recent error to display in UI
// ---------------------------------------------------------------------------
const errorSlice = createSlice({
  name: 'errors',
  initialState: {
    message: null,
    source: null,    // 'tts' | 'ffmpeg' | 'network' | 'file'
    timestamp: null,
  },
  reducers: {
    setError: (state, { payload }) => {
      state.message = payload.message;
      state.source = payload.source || null;
      state.timestamp = Date.now();
    },
    clearError: (state) => {
      state.message = null;
      state.source = null;
      state.timestamp = null;
    },
  },
});

// ---------------------------------------------------------------------------
// Transcript slice — parsed subtitle segments
// ---------------------------------------------------------------------------
const transcriptSlice = createSlice({
  name: 'transcript',
  initialState: {
    segments: [],           // [{ start, end, text, translated? }]
    subtitlePath: null,
    loaded: false,
  },
  reducers: {
    setSegments: (state, { payload }) => {
      state.segments = payload;
      state.loaded = true;
    },
    setSubtitlePath: (state, { payload }) => {
      state.subtitlePath = payload;
    },
    updateSegmentTranslation: (state, { payload: { index, translated } }) => {
      if (state.segments[index]) {
        state.segments[index].translated = translated;
      }
    },
    appendSegments: (state, { payload }) => {
      if (!Array.isArray(payload) || payload.length === 0) return;
      for (const newSeg of payload) {
        const exists = state.segments.some(
          (s) => Math.abs(s.start - newSeg.start) < 0.3 && Math.abs(s.end - newSeg.end) < 0.3
        );
        if (!exists && (newSeg.text || newSeg.translated)) {
          state.segments.push(newSeg);
        }
      }
      state.segments.sort((a, b) => a.start - b.start);
      state.loaded = state.segments.length > 0;
    },
    clearTranslations: (state) => {
      for (const s of state.segments) {
        delete s.translated;
      }
    },
    clearTranscript: () => transcriptSlice.getInitialState(),
  },
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------
const store = configureStore({
  reducer: {
    video: videoSlice.reducer,
    audio: audioSlice.reducer,
    settings: settingsSlice.reducer,
    engines: enginesSlice.reducer,
    sync: syncSlice.reducer,
    errors: errorSlice.reducer,
    transcript: transcriptSlice.reducer,
  },
});

// Export actions
export const videoActions = videoSlice.actions;
export const audioActions = audioSlice.actions;
export const settingsActions = settingsSlice.actions;
export const enginesActions = enginesSlice.actions;
export const syncActions = syncSlice.actions;
export const errorActions = errorSlice.actions;
export const transcriptActions = transcriptSlice.actions;

export default store;
