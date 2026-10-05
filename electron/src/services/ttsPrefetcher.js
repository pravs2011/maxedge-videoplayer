// TTS prefetcher — look-ahead buffering with an in-memory segment cache.
// Requests TTS for upcoming transcript segments before the playhead reaches
// them so playback never stalls waiting for the TTS API.
// Integrates real-time AI translation (Groq / fallback) so audio and subtitles
// are voiced in the desired target language.

import { synthesizeWithFallback, getAdapterById } from './voicebox/index.js';
import { translateText } from './translator.js';
import { globalSpeakerRegistry } from './speakerRegistry.js';

/**
 * @typedef {Object} CachedSegment
 * @property {number} index
 * @property {Uint8Array|null} audio — MP3 bytes, or null if still pending
 * @property {'pending'|'done'|'error'} status
 * @property {string} [engineUsed]
 */

export class TTSPrefetcher {
  /**
   * @param {Object} opts
   * @param {{ start:number, end:number, text:string, translated?:string }[]} opts.segments
   * @param {string} [opts.langCode] — fallback language
   * @param {string} [opts.sourceLang] — original subtitle language
   * @param {string} [opts.targetLang] — language to translate to and voice out
   * @param {boolean} [opts.translateEnabled=true]
   * @param {string} [opts.groqApiKey]
   * @param {string} [opts.groqModel]
   * @param {string} [opts.groqBaseUrl]
   * @param {string[]} opts.enabledEngines
   * @param {string} opts.preferredEngine
   * @param {string} [opts.voiceId]
   * @param {number} [opts.lookAhead=3] — how many segments to prefetch ahead
   * @param {number} [opts.costCapUsd=2.0]
   * @param {(index:number, translated:string) => void} [opts.onSegmentTranslated]
   * @param {(update: { index:number, status:string, error?:string }) => void} [opts.onSegmentUpdate]
   * @param {(cost: number) => void} [opts.onCostIncurred]
   * @param {(engineId:string, until:number) => void} [opts.onCooldown]
   */
  constructor(opts) {
    this.segments = opts.segments;
    this.sourceLang = opts.sourceLang || opts.langCode || 'en';
    this.targetLang = opts.targetLang || opts.langCode || 'en';
    this.langCode = this.targetLang;
    this.translateEnabled = opts.translateEnabled !== false;

    this.groqApiKey = opts.groqApiKey || '';
    this.groqModel = opts.groqModel || 'qwen/qwen3.8-27b';
    this.groqBaseUrl = opts.groqBaseUrl || 'https://api.groq.com/openai/v1/';

    this.enabledEngines = opts.enabledEngines || [];
    this.preferredEngine = opts.preferredEngine || 'auto';
    this.voiceId = opts.voiceId || null;
    this.lookAhead = opts.lookAhead ?? 3;
    this.costCapUsd = opts.costCapUsd ?? 2.0;

    this.onSegmentTranslated = opts.onSegmentTranslated || (() => {});
    this.onSegmentUpdate = opts.onSegmentUpdate || (() => {});
    this.onCostIncurred = opts.onCostIncurred || (() => {});
    this.onCooldown = opts.onCooldown || (() => {});
    this.onStats = opts.onStats || (() => {});

    /** @type {Map<number, CachedSegment>} */
    this.cache = new Map();

    this.cooldowns = {};
    this.totalCostUsd = 0;
    this._inflight = new Set(); // segment indices currently being fetched
    this._translating = new Set();
    this._lastCurrentTime = 0;
    this._destroyed = false;
  }

  /** Update segments without destroying cached audio buffers */
  updateSegments(newSegments) {
    this.segments = newSegments;
    if (this._lastCurrentTime !== undefined) {
      this.prefetchAround(this._lastCurrentTime);
    }
  }

  /** Update active voice ID (e.g. when cloned voice becomes available) */
  setVoiceId(voiceId) {
    this.voiceId = voiceId;
  }

  /** Has audio for a segment been fetched? */
  has(index) {
    const c = this.cache.get(index);
    return c?.status === 'done';
  }

  /** Get the audio bytes for a segment, or null. */
  getAudio(index) {
    const c = this.cache.get(index);
    return c?.status === 'done' ? c.audio : null;
  }

  /** How many segments are fully cached? */
  get cachedCount() {
    let n = 0;
    for (const c of this.cache.values()) if (c.status === 'done') n++;
    return n;
  }

  /**
   * Called every time the video playhead moves — triggers prefetch for
   * the next `lookAhead` segments that aren't already cached / in-flight.
   * @param {number} currentTime — video.currentTime (seconds)
   */
  async prefetchAround(currentTime) {
    if (this._destroyed) return;
    this._lastCurrentTime = currentTime;

    // Find the first segment whose END is after currentTime
    let baseIdx = this.segments.findIndex((s) => s.end > currentTime);
    if (baseIdx === -1) return; // past end of transcript

    const maxIdx = Math.min(baseIdx + this.lookAhead, this.segments.length);

    // Pre-translate upcoming segments proactively so subtitles update smoothly
    const shouldTranslate = this.translateEnabled &&
      this.targetLang.toLowerCase().slice(0, 2) !== this.sourceLang.toLowerCase().slice(0, 2);

    if (shouldTranslate) {
      const translateLimit = Math.min(baseIdx + this.lookAhead + 3, this.segments.length);
      for (let j = baseIdx; j < translateLimit; j++) {
        const seg = this.segments[j];
        if (seg && !seg.translated && !this._translating.has(j)) {
          this._pretranslateSegment(j);
        }
      }
    }

    for (let i = baseIdx; i < maxIdx; i++) {
      if (this.cache.has(i) || this._inflight.has(i)) continue;
      // don't exceed cost cap
      if (this.totalCostUsd >= this.costCapUsd) break;
      this._fetchSegment(i); // fire-and-forget
    }
  }

  /**
   * Helper to pre-translate a segment asynchronously.
   */
  async _pretranslateSegment(index) {
    if (this._destroyed || this._translating.has(index)) return;
    this._translating.add(index);
    try {
      const seg = this.segments[index];
      if (!seg || seg.translated) return;
      const translated = await translateText({
        text: seg.text,
        sourceLang: this.sourceLang,
        targetLang: this.targetLang,
        apiKey: this.groqApiKey,
        model: this.groqModel,
        baseUrl: this.groqBaseUrl,
      });
      if (seg && !seg.translated) {
        seg.translated = translated;
        this.onSegmentTranslated(index, translated);
      }
    } catch (err) {
      console.warn(`[prefetcher] pre-translation failed for segment ${index}:`, err.message);
    } finally {
      this._translating.delete(index);
    }
  }

  /**
   * Fetch TTS audio for one segment, translating first if needed.
   * @param {number} index
   */
  async _fetchSegment(index) {
    if (this._inflight.has(index) || this._destroyed) return;
    this._inflight.add(index);

    const seg = this.segments[index];
    this.cache.set(index, { index, audio: null, status: 'pending' });
    this.onSegmentUpdate({ index, status: 'pending' });

    try {
      let textToSpeak = seg.text;
      const shouldTranslate = this.translateEnabled &&
        this.targetLang.toLowerCase().slice(0, 2) !== this.sourceLang.toLowerCase().slice(0, 2);

      if (shouldTranslate) {
        if (!seg.translated) {
          const translated = await translateText({
            text: seg.text,
            sourceLang: this.sourceLang,
            targetLang: this.targetLang,
            apiKey: this.groqApiKey,
            model: this.groqModel,
            baseUrl: this.groqBaseUrl,
          });
          seg.translated = translated;
          this.onSegmentTranslated(index, translated);
        }
        textToSpeak = seg.translated || seg.text;
      }

      const ttsLang = shouldTranslate ? this.targetLang : this.sourceLang;

      // Multi-Speaker Voice Persona Selection:
      // Match voice to character gender and identity
      let segmentVoiceId = this.voiceId;
      const targetEngine = this.preferredEngine !== 'auto' ? this.preferredEngine : (this.enabledEngines[0] || 'elevenlabs');
      if (seg.speakerId) {
        segmentVoiceId = globalSpeakerRegistry.getVoiceForSpeaker(seg.speakerId, targetEngine, ttsLang) || this.voiceId;
      } else if (seg.gender) {
        segmentVoiceId = globalSpeakerRegistry.getVoiceForSpeaker(`speaker_${seg.gender}`, targetEngine, ttsLang) || this.voiceId;
      }

      // Guard for pure human non-verbal sounds (laughter, weeping, applause):
      // Don't voice over natural laughter or crying; let the original performance stay untouched
      if (seg.hasHumanNonVerbal && (!textToSpeak || textToSpeak.trim().length === 0)) {
        this.cache.set(index, { index, audio: null, status: 'done', engineUsed: 'foley-passthrough' });
        this.onSegmentUpdate({ index, status: 'done' });
        return;
      }

      const ttsStart = performance.now();
      const { audio, engineUsed, charCount } = await synthesizeWithFallback({
        text: textToSpeak,
        langCode: ttsLang,
        voiceId: segmentVoiceId,
        emotion: seg.emotion,
        enabledEngines: this.enabledEngines,
        preferredEngine: this.preferredEngine,
        cooldowns: this.cooldowns,
        onCooldown: (engineId, until) => {
          this.cooldowns[engineId] = until;
          this.onCooldown(engineId, until);
        },
      });
      const ttsLatencyMs = Math.round(performance.now() - ttsStart);

      this.cache.set(index, { index, audio, status: 'done', engineUsed });
      this.onSegmentUpdate({ index, status: 'done' });
      this.onStats({ ttsLatencyMs, engineUsed, charCount, cachedCount: this.cachedCount });

      // Track cost
      const adapter = getAdapterById(engineUsed);
      if (adapter) {
        const cost = (charCount / 1000) * adapter.estimateCostPer1kChars(ttsLang);
        this.totalCostUsd += cost;
        this.onCostIncurred(cost);
      }
    } catch (err) {
      console.error(`[prefetcher] segment ${index} failed:`, err.message);
      this.cache.set(index, { index, audio: null, status: 'error' });
      this.onSegmentUpdate({ index, status: 'error', error: err.message });
    } finally {
      this._inflight.delete(index);
    }
  }

  /** Invalidate all cached segments and reset. */
  clear() {
    this.cache.clear();
    this._inflight.clear();
    this._translating.clear();
    this.totalCostUsd = 0;
    this.cooldowns = {};
  }

  /** Stop all in-flight fetches. */
  destroy() {
    this._destroyed = true;
    this._inflight.clear();
    this._translating.clear();
  }
}

export default TTSPrefetcher;
