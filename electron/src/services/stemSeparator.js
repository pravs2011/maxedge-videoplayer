// StemSeparator: Isolates background music & sound effects (BGM/SFX)
// from vocal dialogue, and manages real-time mid-side vocal elimination
// so the movie soundtrack stays alive behind the voiceover without foreign vocal bleed.

/**
 * Calculate the ducked volume level for background audio.
 * @param {number} baseVolume - user-selected background volume (0 to 1)
 * @param {boolean} isSpeechActive - whether voiceover is currently speaking
 * @param {number} [duckRatio=0.18] - level to duck to during dialogue (18% of base)
 * @returns {number}
 */
export function calculateDuckedVolume(baseVolume, isSpeechActive, duckRatio = 0.18) {
  if (!baseVolume || baseVolume <= 0) return 0;
  if (!isSpeechActive) return baseVolume;
  return Number((baseVolume * duckRatio).toFixed(3));
}

/**
 * Smoothly ramp HTML5 video volume to target level to avoid audio clicks/pops.
 * @param {HTMLMediaElement} mediaEl
 * @param {number} targetVolume (0 to 1)
 * @param {number} [durationMs=120]
 */
export function rampVolume(mediaEl, targetVolume, durationMs = 120) {
  if (!mediaEl) return;
  if (mediaEl._volRampTimer) {
    clearInterval(mediaEl._volRampTimer);
    mediaEl._volRampTimer = null;
  }
  const startVol = mediaEl.volume;
  const clampedTarget = Math.max(0, Math.min(1, targetVolume));
  const diff = clampedTarget - startVol;
  if (Math.abs(diff) < 0.02) {
    mediaEl.volume = clampedTarget;
    return;
  }

  const steps = 6;
  const intervalMs = Math.max(10, Math.floor(durationMs / steps));
  let step = 0;

  const timer = setInterval(() => {
    step++;
    const progress = step / steps;
    // Ease-out curve
    const current = startVol + diff * Math.sin((progress * Math.PI) / 2);
    mediaEl.volume = Math.max(0, Math.min(1, current));

    if (step >= steps) {
      clearInterval(timer);
      mediaEl._volRampTimer = null;
      mediaEl.volume = clampedTarget;
    }
  }, intervalMs);
  mediaEl._volRampTimer = timer;
}

/**
 * Real-time Web Audio Mid-Side Vocal Eliminator DSP Graph.
 * Takes the stereo film soundtrack, eliminates center-panned vocals in the human speech band
 * (250Hz - 3800Hz), while preserving wide stereo BGM, Foley effects, deep sub-bass (<220Hz),
 * and crisp treble (>4000Hz).
 * 
 * @param {AudioContext} audioCtx
 * @param {HTMLMediaElement} mediaEl
 * @returns {{
 *   setStemMode: (mode: 'bgm_stem'|'bypass'|'ducked') => void,
 *   setVolume: (v: number) => void,
 *   disconnect: () => void,
 * }}
 */
export function createCenterVocalEliminator(audioCtx, mediaEl) {
  if (!audioCtx || !mediaEl) {
    return {
      setStemMode: () => {},
      setVolume: () => {},
      disconnect: () => {},
    };
  }

  let sourceNode = mediaEl._mediaSourceNode;
  if (!sourceNode) {
    try {
      sourceNode = audioCtx.createMediaElementSource(mediaEl);
      mediaEl._mediaSourceNode = sourceNode;
    } catch (e) {
      console.warn('[StemSeparator] createMediaElementSource failed or already created:', e);
      return {
        setStemMode: () => {},
        setVolume: () => {},
        disconnect: () => {},
      };
    }
  }

  // Master output gain for BGM stem
  const outputGain = audioCtx.createGain();
  outputGain.gain.value = 1.0;
  outputGain.connect(audioCtx.destination);

  // Splitter: 0 = Left, 1 = Right
  const splitter = audioCtx.createChannelSplitter(2);
  const merger = audioCtx.createChannelMerger(2);

  // Direct bypass gain
  const bypassGain = audioCtx.createGain();
  bypassGain.gain.value = 0.0;

  // Stem processing gain
  const stemGain = audioCtx.createGain();
  stemGain.gain.value = 1.0;

  sourceNode.connect(splitter);
  sourceNode.connect(bypassGain);
  bypassGain.connect(outputGain);

  // Mid-Side subtraction for center vocal frequency band
  // Invert right channel: -R
  const invRight = audioCtx.createGain();
  invRight.gain.value = -1.0;
  splitter.connect(invRight, 1);

  // Side channel = (L - R) / 2
  const sideLeft = audioCtx.createGain();
  sideLeft.gain.value = 0.6;
  splitter.connect(sideLeft, 0);
  invRight.connect(sideLeft);

  // Side right channel = (R - L) / 2
  const invLeft = audioCtx.createGain();
  invLeft.gain.value = -1.0;
  splitter.connect(invLeft, 0);

  const sideRight = audioCtx.createGain();
  sideRight.gain.value = 0.6;
  splitter.connect(sideRight, 1);
  invLeft.connect(sideRight);

  // Sub-bass bypass (< 200 Hz) so bass drums and explosions remain thick and centered
  const bassFilter = audioCtx.createBiquadFilter();
  bassFilter.type = 'lowpass';
  bassFilter.frequency.value = 220;

  const bassGain = audioCtx.createGain();
  bassGain.gain.value = 0.8;
  splitter.connect(bassFilter, 0);
  splitter.connect(bassFilter, 1);
  bassFilter.connect(bassGain);

  // Treble shimmer bypass (> 4500 Hz) for crisp environmental Foley and air
  const trebleFilter = audioCtx.createBiquadFilter();
  trebleFilter.type = 'highpass';
  trebleFilter.frequency.value = 4500;

  const trebleGain = audioCtx.createGain();
  trebleGain.gain.value = 0.6;
  splitter.connect(trebleFilter, 0);
  splitter.connect(trebleFilter, 1);
  trebleFilter.connect(trebleGain);

  // Merge side + bass + treble into Left and Right
  sideLeft.connect(merger, 0, 0);
  bassGain.connect(merger, 0, 0);
  trebleGain.connect(merger, 0, 0);

  sideRight.connect(merger, 0, 1);
  bassGain.connect(merger, 0, 1);
  trebleGain.connect(merger, 0, 1);

  merger.connect(stemGain);
  stemGain.connect(outputGain);

  return {
    /**
     * Set stem mode:
     * 'bgm_stem': Center vocals eliminated, pristine BGM/SFX played
     * 'bypass': Original unaltered stereo track
     * 'ducked': Lowered volume
     */
    setStemMode(mode) {
      if (mode === 'bgm_stem') {
        stemGain.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.05);
        bypassGain.gain.setTargetAtTime(0.0, audioCtx.currentTime, 0.05);
      } else {
        stemGain.gain.setTargetAtTime(0.0, audioCtx.currentTime, 0.05);
        bypassGain.gain.setTargetAtTime(1.0, audioCtx.currentTime, 0.05);
      }
    },
    setVolume(v) {
      outputGain.gain.setTargetAtTime(Math.max(0, Math.min(1, v)), audioCtx.currentTime, 0.05);
    },
    disconnect() {
      try {
        outputGain.disconnect();
        bypassGain.disconnect();
        stemGain.disconnect();
      } catch (_) {}
    },
  };
}

export default {
  calculateDuckedVolume,
  rampVolume,
  createCenterVocalEliminator,
};
