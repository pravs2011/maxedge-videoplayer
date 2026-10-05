// PitchDetector: Analyzes vocal pitch (Fundamental Frequency F0)
// to accurately classify speaker gender (Male / Female / Child)
// using time-domain autocorrelation.

/**
 * Detect pitch (F0 in Hz) from a mono Float32Array audio buffer.
 * @param {Float32Array} pcm - raw audio samples
 * @param {number} sampleRate - e.g. 16000 or 44100
 * @returns {{ f0: number, gender: 'male'|'female'|'child'|'unknown', confidence: number }}
 */
export function detectPitchAndGender(pcm, sampleRate = 16000) {
  if (!pcm || pcm.length < 512) {
    return { f0: 0, gender: 'unknown', confidence: 0 };
  }

  // Pitch search bounds for human speech: 75 Hz to 400 Hz
  const minFreq = 75;
  const maxFreq = 400;
  const maxLag = Math.floor(sampleRate / minFreq);
  const minLag = Math.floor(sampleRate / maxFreq);

  // Compute energy to avoid analyzing silent frames
  let energy = 0;
  for (let i = 0; i < pcm.length; i++) {
    energy += pcm[i] * pcm[i];
  }
  const rms = Math.sqrt(energy / pcm.length);
  if (rms < 0.01) {
    // Silence or background noise
    return { f0: 0, gender: 'unknown', confidence: 0 };
  }

  // Use a central slice of up to 4096 samples for fast autocorrelation
  const sliceLen = Math.min(4096, pcm.length - maxLag);
  if (sliceLen <= 0) {
    return { f0: 0, gender: 'unknown', confidence: 0 };
  }
  const startIdx = Math.floor((pcm.length - sliceLen - maxLag) / 2);

  let bestLag = 0;
  let maxCorr = -1;
  const normBase = computeEnergySlice(pcm, startIdx, sliceLen);

  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    for (let i = 0; i < sliceLen; i++) {
      corr += pcm[startIdx + i] * pcm[startIdx + i + lag];
    }
    const normLag = computeEnergySlice(pcm, startIdx + lag, sliceLen);
    const denom = Math.sqrt(normBase * normLag) || 1e-6;
    const normalizedCorr = corr / denom;

    if (normalizedCorr > maxCorr) {
      maxCorr = normalizedCorr;
      bestLag = lag;
    }
  }

  if (bestLag === 0 || maxCorr < 0.35) {
    return { f0: 0, gender: 'unknown', confidence: Number(Math.max(0, maxCorr).toFixed(2)) };
  }

  // Parabolic interpolation around the peak for sub-sample precision
  const f0 = Number((sampleRate / bestLag).toFixed(1));
  const confidence = Number(Math.min(1.0, maxCorr).toFixed(2));

  // Human vocal range classification:
  // Male adult: ~85 Hz - 165 Hz (modal around 110-120 Hz)
  // Female adult: ~165 Hz - 260 Hz (modal around 200-220 Hz)
  // Child / Very high pitch: > 260 Hz
  let gender = 'male';
  if (f0 >= 165 && f0 < 265) {
    gender = 'female';
  } else if (f0 >= 265) {
    gender = 'child';
  } else if (f0 < 80) {
    gender = 'male';
  }

  return { f0, gender, confidence };
}

function computeEnergySlice(pcm, start, len) {
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const val = pcm[start + i];
    sum += val * val;
  }
  return sum || 1e-6;
}

/**
 * Decode base64 MP3 chunk into mono Float32Array PCM via Web Audio API.
 * @param {string} base64Audio
 * @param {AudioContext} [audioCtx]
 * @returns {Promise<{ pcm: Float32Array, sampleRate: number }>}
 */
export async function decodeAudioChunkToPcm(base64Audio, audioCtx) {
  const binaryString = atob(base64Audio);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const ctx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));
  const channelData = audioBuffer.getChannelData(0); // mono / left channel

  return {
    pcm: channelData,
    sampleRate: audioBuffer.sampleRate,
  };
}

export default {
  detectPitchAndGender,
  decodeAudioChunkToPcm,
};
