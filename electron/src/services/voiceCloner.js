// VoiceCloner: Instant Voice Cloning (IVC) via ElevenLabs API.
// Extracts a clean sample of the actor's voice from the video,
// creates an instant voice clone, and provides the custom voice_id
// so the translated speech sounds exactly like the original actor.

import axios from 'axios';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// In-memory cache of cloned voices per video file path: videoPath -> voiceId
const clonedVoiceCache = new Map();

/**
 * Clone an actor's voice from an audio chunk using ElevenLabs Instant Voice Cloning.
 * @param {Object} opts
 * @param {string} opts.videoPath - path to video file (used as cache key)
 * @param {string} opts.base64Audio - base64 MP3 audio data
 * @param {string} opts.apiKey - ElevenLabs API key
 * @param {string} [opts.speakerName='Actor'] - label for the cloned voice
 * @returns {Promise<{ voiceId: string, name: string, isCloned: boolean }>}
 */
export async function cloneVoiceFromSample({
  videoPath,
  base64Audio,
  apiKey,
  speakerName = 'Actor',
}) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('ElevenLabs API key is required for voice cloning.');
  }

  // Check cache
  if (videoPath && clonedVoiceCache.has(videoPath)) {
    const cachedId = clonedVoiceCache.get(videoPath);
    return {
      voiceId: cachedId,
      name: `🎭 ${speakerName} (Auto-Cloned)`,
      isCloned: true,
    };
  }

  // Decode base64 to Blob
  const binaryString = atob(base64Audio);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  const audioBlob = new Blob([bytes], { type: 'audio/mp3' });

  const voiceName = `MVP-${speakerName}-${Date.now().toString().slice(-4)}`;
  const formData = new FormData();
  formData.append('name', voiceName);
  formData.append('files', audioBlob, 'reference_sample.mp3');
  formData.append('description', 'Auto-cloned actor voice for real-time video translation');
  formData.append('labels', JSON.stringify({ source: 'maxedgevideoplayer', auto_cloned: 'true' }));

  const response = await fetch(`${ELEVENLABS_BASE}/voices/add`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey.trim(),
    },
    body: formData,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`ElevenLabs Voice Cloning ${response.status}: ${errorBody.slice(0, 200)}`);
  }

  const data = await response.json();
  const voiceId = data.voice_id;

  if (!voiceId) {
    throw new Error('No voice_id returned by ElevenLabs Voice Clone API.');
  }

  if (videoPath) {
    clonedVoiceCache.set(videoPath, voiceId);
  }

  return {
    voiceId,
    name: `🎭 ${speakerName} (Auto-Cloned)`,
    isCloned: true,
  };
}

/**
 * Check if a cloned voice is already cached for this video.
 * @param {string} videoPath 
 * @returns {string|null}
 */
export function getCachedClonedVoice(videoPath) {
  return clonedVoiceCache.get(videoPath) || null;
}

export default {
  cloneVoiceFromSample,
  getCachedClonedVoice,
};
