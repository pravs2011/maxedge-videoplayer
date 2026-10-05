// LiveDubber: Continuously extracts small audio chunks from the video file,
// uses SenseVoice (on-device ultra-low-latency) or Groq Whisper (cloud),
// extracts actor emotions & sound events, runs acoustic pitch + Groq diarization,
// and feeds the multi-speaker segments into the TTS & sync pipeline.

import { transcribeAndTranslateAudioChunk, translateText } from './translator.js';
import { parseSenseVoiceOutput } from './senseVoiceParser.js';
import { detectPitchAndGender, decodeAudioChunkToPcm } from './pitchDetector.js';
import { diarizeDialogueBatch } from './diarizer.js';
import { globalSpeakerRegistry } from './speakerRegistry.js';

export class LiveDubber {
  /**
   * @param {Object} opts
   * @param {string} opts.videoPath - filesystem path to video
   * @param {() => number} opts.getCurrentTime - gets video.currentTime in seconds
   * @param {() => number} opts.getDuration - gets video.duration in seconds
   * @param {string} opts.groqApiKey - Groq API key
   * @param {string} [opts.groqModel='qwen/qwen3.8-27b']
   * @param {string} [opts.targetLang='en'] - target language
   * @param {string} [opts.baseUrl='https://api.groq.com/openai/v1/']
   * @param {'sensevoice_local'|'groq_whisper'} [opts.asrEngine='sensevoice_local']
   * @param {(segments: Array<any>) => void} opts.onSegments
   * @param {(status: string) => void} [opts.onStatus]
   * @param {(stats: Object) => void} [opts.onStats]
   * @param {(err: Error) => void} [opts.onError]
   */
  constructor(opts) {
    this.videoPath = opts.videoPath;
    this.getCurrentTime = opts.getCurrentTime;
    this.getDuration = opts.getDuration || (() => 0);
    this.groqApiKey = opts.groqApiKey;
    this.groqModel = opts.groqModel || 'qwen/qwen3.8-27b';
    this.targetLang = opts.targetLang || 'en';
    this.baseUrl = opts.baseUrl || 'https://api.groq.com/openai/v1/';
    this.asrEngine = opts.asrEngine || 'sensevoice_local';

    this.onSegments = opts.onSegments || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onStats = opts.onStats || (() => {});
    this.onError = opts.onError || (() => {});

    this.chunkDuration = 12; // 12-second speech chunk (Whisper/SenseVoice sweet spot)
    this.lookAheadChunks = 4; // Keeps up to 48s lookahead ahead of playhead!

    this._processedChunks = new Set();
    this._inflightChunks = new Set();
    this._timer = null;
    this._active = false;
    this._audioCtx = null;
  }

  start() {
    if (this._active) return;
    this._active = true;
    this._poll();
    this._timer = setInterval(() => this._poll(), 1000);
  }

  stop() {
    this._active = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._inflightChunks.clear();
    if (this._audioCtx && this._audioCtx.state !== 'closed') {
      try { this._audioCtx.close(); } catch (_) {}
      this._audioCtx = null;
    }
  }

  onSeek(newTime) {
    this._poll();
  }

  setTargetLang(newLang) {
    if (this.targetLang !== newLang) {
      this.targetLang = newLang;
      this._processedChunks.clear();
      this._inflightChunks.clear();
      this._poll();
    }
  }

  setAsrEngine(engine) {
    if (this.asrEngine !== engine) {
      this.asrEngine = engine;
      this._processedChunks.clear();
      this._inflightChunks.clear();
      this._poll();
    }
  }

  async _poll() {
    if (!this._active || !this.videoPath) return;

    const currentTime = this.getCurrentTime();
    const duration = this.getDuration();
    if (duration > 0 && currentTime >= duration) return;

    // Determine base chunk index
    const baseChunkStart = Math.floor(currentTime / this.chunkDuration) * this.chunkDuration;

    for (let i = 0; i < this.lookAheadChunks; i++) {
      const chunkStart = baseChunkStart + (i * this.chunkDuration);
      if (duration > 0 && chunkStart >= duration) break;
      if (this._processedChunks.has(chunkStart) || this._inflightChunks.has(chunkStart)) {
        continue;
      }

      this._fetchAndProcessChunk(chunkStart);
    }
  }

  async _fetchAndProcessChunk(startTime) {
    if (this._inflightChunks.has(startTime) || !this._active) return;
    this._inflightChunks.add(startTime);

    try {
      this.onStatus(`Analyzing audio [${startTime}s - ${startTime + this.chunkDuration}s]...`);

      let asrEngineUsed = 'Groq Whisper Large v3';
      let asrLatencyMs = 0;
      let detectedLang = 'en';
      let emotionDetected = 'neutral';
      let eventsDetected = [];
      let segmentsToEmit = [];
      let chunkRawBase64 = null;

      // 1. Try On-Device SenseVoice if enabled
      let senseVoiceSuccess = false;
      if (this.asrEngine === 'sensevoice_local' && window.mvp?.transcribeSenseVoice) {
        try {
          const tSense0 = performance.now();
          const senseRes = await window.mvp.transcribeSenseVoice({
            videoPath: this.videoPath,
            startTime,
            duration: this.chunkDuration,
          });

          if (senseRes && senseRes.ok) {
            senseVoiceSuccess = true;
            asrEngineUsed = 'SenseVoice (Local On-Device)';
            asrLatencyMs = senseRes.latencyMs || Math.round(performance.now() - tSense0);

            const parsed = parseSenseVoiceOutput(senseRes.raw, startTime, this.chunkDuration);
            detectedLang = parsed.lang || 'en';
            emotionDetected = parsed.emotion;
            eventsDetected = parsed.events;

            if (parsed.text && parsed.text.trim()) {
              let translated = parsed.text;
              const target = this.targetLang || 'en';
              const needTrans = target.slice(0, 2).toLowerCase() !== detectedLang.slice(0, 2).toLowerCase();

              if (needTrans && this.groqApiKey) {
                try {
                  translated = await translateText({
                    text: parsed.text,
                    sourceLang: detectedLang,
                    targetLang: target,
                    apiKey: this.groqApiKey,
                    model: this.groqModel,
                    baseUrl: this.baseUrl,
                  });
                } catch (trErr) {
                  console.warn('[LiveDubber] SenseVoice text translation failed, using raw text:', trErr.message);
                }
              }

              segmentsToEmit = [{
                start: startTime,
                end: startTime + this.chunkDuration,
                text: parsed.text,
                translated,
                emotion: parsed.emotion,
                events: parsed.events,
                hasHumanNonVerbal: parsed.hasHumanNonVerbal,
              }];
            }
          }
        } catch (sErr) {
          console.warn('[LiveDubber] SenseVoice local inference failed, falling back to Groq Whisper:', sErr.message);
        }
      }

      // 2. Fallback to Cloud Groq Whisper if SenseVoice was not used or failed
      if (!senseVoiceSuccess) {
        if (!this.groqApiKey) {
          throw new Error('SenseVoice model is not ready and no Groq API key is provided.');
        }

        const tExtract0 = performance.now();
        const chunkRes = await window.mvp.extractAudioChunk({
          videoPath: this.videoPath,
          startTime,
          duration: this.chunkDuration,
        });
        const extractLatencyMs = Math.round(performance.now() - tExtract0);

        if (!chunkRes.ok || !chunkRes.data) {
          throw new Error(chunkRes.error || 'Failed to extract audio chunk from video.');
        }
        chunkRawBase64 = chunkRes.data;

        this.onStatus(`Groq Whisper translating [${startTime}s - ${startTime + this.chunkDuration}s]...`);
        const tWhisper0 = performance.now();
        const result = await transcribeAndTranslateAudioChunk({
          base64Data: chunkRes.data,
          startTime,
          apiKey: this.groqApiKey,
          targetLang: this.targetLang,
          baseUrl: this.baseUrl,
        });
        asrLatencyMs = Math.round(performance.now() - tWhisper0);
        asrEngineUsed = 'Groq Whisper Large v3';
        detectedLang = result.detectedLanguage || 'en';
        segmentsToEmit = result.segments || [];
      }

      this._processedChunks.add(startTime);

      // 3. Multi-Speaker Diarization & Gender Extraction
      if (segmentsToEmit.length > 0) {
        this.onStatus(`Diarizing characters & vocal pitch...`);
        const acousticHints = {};

        // Extract pitch hints if audio buffer is available
        if (chunkRawBase64) {
          try {
            if (!this._audioCtx || this._audioCtx.state === 'closed') {
              this._audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            const { pcm, sampleRate } = await decodeAudioChunkToPcm(chunkRawBase64, this._audioCtx);

            segmentsToEmit.forEach((seg, idx) => {
              const relStart = Math.max(0, seg.start - startTime);
              const relEnd = Math.min(this.chunkDuration, seg.end - startTime);
              const startSample = Math.floor(relStart * sampleRate);
              const endSample = Math.floor(relEnd * sampleRate);

              if (endSample > startSample + 512 && startSample < pcm.length) {
                const segSlice = pcm.subarray(startSample, Math.min(pcm.length, endSample));
                const pitch = detectPitchAndGender(segSlice, sampleRate);
                if (pitch.gender !== 'unknown') {
                  acousticHints[idx] = pitch.gender;
                }
              }
            });
          } catch (_) {}
        }

        // Contextual Diarization pass via Groq LLM
        const diarized = await diarizeDialogueBatch({
          segments: segmentsToEmit,
          apiKey: this.groqApiKey,
          model: this.groqModel,
          baseUrl: this.baseUrl,
          acousticHints,
        });

        // Register speakers in globalSpeakerRegistry
        diarized.forEach((d) => {
          if (d.speakerId) {
            globalSpeakerRegistry.registerSpeaker(d.speakerId, {
              name: d.speakerName,
              gender: d.gender,
            });
          }
        });

        segmentsToEmit = diarized;
      }

      const activeSpeakers = globalSpeakerRegistry.getAllSpeakers();

      this.onStats({
        asrEngine: asrEngineUsed,
        asrLatencyMs,
        whisperLatencyMs: asrLatencyMs,
        chunkRange: `${startTime}s - ${startTime + this.chunkDuration}s`,
        segmentsFound: segmentsToEmit.length,
        detectedLanguage: detectedLang,
        activeSpeakersCount: activeSpeakers.length,
        speakers: activeSpeakers.map((s) => `${s.gender === 'female' ? '♀' : '♂'} ${s.id}`),
        emotion: emotionDetected,
        events: eventsDetected,
      });

      if (segmentsToEmit.length > 0) {
        this.onSegments(segmentsToEmit);
        const emotionIcon = emotionDetected === 'happy' ? '😃' : emotionDetected === 'angry' ? '😠' : emotionDetected === 'sad' ? '😢' : '⚡';
        this.onStatus(`${emotionIcon} Ready: ${segmentsToEmit.length} lines · ${asrLatencyMs}ms`);
      } else {
        this.onStatus(`Chunk [${startTime}s]: Ambience / No dialogue`);
      }
    } catch (err) {
      console.warn(`[liveDubber] Chunk at ${startTime}s failed:`, err.message);
      this.onError(err);
    } finally {
      this._inflightChunks.delete(startTime);
    }
  }
}

export default LiveDubber;
