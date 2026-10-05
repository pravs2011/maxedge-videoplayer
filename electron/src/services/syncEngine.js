// Live audio-video sync engine.
// Decodes TTS MP3 segments via Web Audio API and plays them in lock-step
// with the <video> element's currentTime, correcting drift.

export class SyncEngine {
  /**
   * @param {Object} opts
   * @param {HTMLVideoElement} opts.videoEl
   * @param {{ start:number, end:number, text:string }[]} opts.segments
   * @param {import('./ttsPrefetcher.js').TTSPrefetcher} opts.prefetcher
   * @param {(driftMs:number) => void} [opts.onDrift]
   * @param {(segmentIndex:number) => void} [opts.onSegmentChange]
   */
  constructor(opts) {
    this.videoEl = opts.videoEl;
    this.segments = opts.segments;
    this.prefetcher = opts.prefetcher;
    this.onDrift = opts.onDrift || (() => {});
    this.onSegmentChange = opts.onSegmentChange || (() => {});
    this.onStats = opts.onStats || (() => {});
    this.onSpeechActive = opts.onSpeechActive || (() => {});

    /** @type {AudioContext|null} */
    this.ctx = null;
    /** @type {GainNode|null} */
    this.gain = null;
    /** @type {AudioBufferSourceNode|null} */
    this.currentSource = null;
    this.currentSegmentIdx = -1;
    this.lastDriftMs = 0;

    /** @type {Map<number, AudioBuffer>} */
    this._decoded = new Map();
    this._volume = 1;
    this._active = false;
    this._pollTimer = null;

    this._bound = {
      onSeeked: this._onSeeked.bind(this),
      onPause: this._onPause.bind(this),
      onPlay: this._onPlay.bind(this),
    };
  }

  updateSegments(newSegments) {
    this.segments = newSegments;
  }

  getBufferLeadSec(videoTime) {
    let maxCachedEnd = videoTime;
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      if (s.end > videoTime && this.prefetcher.has(i)) {
        if (s.end > maxCachedEnd) maxCachedEnd = s.end;
      }
    }
    return Math.max(0, Number((maxCachedEnd - videoTime).toFixed(1)));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start() {
    if (this._active) return;
    this._active = true;

    this.ctx = new AudioContext();
    this.gain = this.ctx.createGain();
    this.gain.gain.value = this._volume;
    this.gain.connect(this.ctx.destination);

    this.videoEl.addEventListener('seeked', this._bound.onSeeked);
    this.videoEl.addEventListener('pause', this._bound.onPause);
    this.videoEl.addEventListener('play', this._bound.onPlay);

    // Poll at 100ms intervals instead of relying on timeupdate (~250ms).
    // This catches segment transitions more precisely and retries segments
    // that weren't yet prefetched on the first check.
    this._startPolling();
  }

  stop() {
    this._active = false;
    this._stopPolling();
    this._stopCurrentSource();
    this.videoEl.removeEventListener('seeked', this._bound.onSeeked);
    this.videoEl.removeEventListener('pause', this._bound.onPause);
    this.videoEl.removeEventListener('play', this._bound.onPlay);

    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.gain = null;
    this._decoded.clear();
    this.currentSegmentIdx = -1;
  }

  setVolume(v) {
    this._volume = v;
    if (this.gain) this.gain.gain.value = v;
  }

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => this._tick(), 100);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Core tick — runs every 100ms while active
  // ---------------------------------------------------------------------------

  _tick() {
    if (!this._active || !this.videoEl || this.videoEl.paused) return;
    const t = this.videoEl.currentTime;

    // Trigger prefetch for upcoming segments
    this.prefetcher.prefetchAround(t);

    const leadSec = this.getBufferLeadSec(t);
    this.onStats({ bufferLeadSec: leadSec, driftMs: this.lastDriftMs || 0 });

    // Which segment should be playing?
    const idx = this._findSegment(t);
    if (idx === -1) return;

    // New segment? Start playing it.
    if (idx !== this.currentSegmentIdx) {
      this._playSegment(idx, t);
      return;
    }

    // Same segment — check if audio is available now (wasn't before)
    if (this.currentSource === null && this.prefetcher.has(idx)) {
      this._playSegment(idx, t);
    }
  }

  _findSegment(t) {
    // Binary-ish search for the segment containing time t
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i];
      if (t >= s.start && t < s.end) return i;
      if (s.start > t) break; // segments are sorted by start time
    }
    return -1;
  }

  // ---------------------------------------------------------------------------
  // Video event handlers
  // ---------------------------------------------------------------------------

  _onSeeked() {
    if (!this._active) return;
    this.currentSegmentIdx = -1;
    this._tick();
  }

  _onPause() {
    if (this.ctx && this.ctx.state === 'running') {
      this.ctx.suspend().catch(() => {});
    }
  }

  _onPlay() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    this.currentSegmentIdx = -1; // force re-evaluation
    this._tick();
  }

  // ---------------------------------------------------------------------------
  // Segment playback
  // ---------------------------------------------------------------------------

  async _playSegment(idx, videoTime) {
    this.currentSegmentIdx = idx;
    this.onSegmentChange(idx);
    this._stopCurrentSource(false);

    if (!this.ctx || this.ctx.state === 'closed') {
      this.onSpeechActive(false);
      return;
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => {});
    }

    const audioBytes = this.prefetcher.getAudio(idx);
    if (!audioBytes) {
      this.onSpeechActive(false);
      return; // not yet prefetched — _tick will retry
    }

    let buffer = this._decoded.get(idx);
    if (!buffer) {
      try {
        // Must copy the ArrayBuffer because decodeAudioData detaches it
        const copy = audioBytes.buffer.slice(
          audioBytes.byteOffset,
          audioBytes.byteOffset + audioBytes.byteLength
        );
        buffer = await this.ctx.decodeAudioData(copy);
        this._decoded.set(idx, buffer);
      } catch (err) {
        console.warn('[syncEngine] decodeAudioData failed for segment', idx, err);
        this.onSpeechActive(false);
        return;
      }
    }

    // Double-check we're still on this segment after async decode
    if (this.currentSegmentIdx !== idx || !this._active) {
      this.onSpeechActive(false);
      return;
    }

    const seg = this.segments[idx];
    const segDuration = seg.end - seg.start;

    // How far into this segment is the video?
    const offset = Math.max(0, videoTime - seg.start);
    if (offset >= buffer.duration) {
      this.onSpeechActive(false);
      return;
    }

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.gain);

    // Play at natural 1.0x human speaking speed.
    // Never slow down audio (< 1.0), which destroys voice timbre and causes deep slow-motion distortion.
    // If the TTS audio slightly exceeds the allotted time slot, gently compress up to 1.15x at most.
    let rate = 1.0;
    if (segDuration > 0 && buffer.duration > segDuration * 1.08) {
      rate = Math.min(1.15, buffer.duration / segDuration);
    }
    source.playbackRate.value = rate;

    source.start(0, offset);
    this.currentSource = source;
    this.onSpeechActive(true);

    const driftMs = Math.round((buffer.duration - segDuration) * 1000);
    this.lastDriftMs = driftMs;
    this.onDrift(driftMs);

    source.onended = () => {
      if (this.currentSource === source) {
        this.currentSource = null;
        this.onSpeechActive(false);
      }
    };
  }

  _stopCurrentSource(emitActive = true) {
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch (_) {}
      this.currentSource = null;
      if (emitActive) {
        this.onSpeechActive(false);
      }
    } else if (emitActive) {
      this.onSpeechActive(false);
    }
  }
}

export default SyncEngine;
