// ElevenLabs TTS adapter — implements the VoiceBox interface.
import axios from 'axios';

const BASE = 'https://api.elevenlabs.io/v1';

// Default voice mapping (language → voice_id). Users can override via voice picker.
const DEFAULT_VOICES = {
  en: '21m00Tcm4TlvDq8ikWAM',  // Rachel
  es: 'AZnzlk1XvdvUeBnXmlld',
  fr: 'MF3mGyEYCl7XYWbV9V6O',
  de: 'ErXwobaYiN019PkySvjV',
  it: 'VR6AewLTigWG4xSOukaG',
  pt: 'GBv7mTt0atIp3Br8iCZE',
};

/**
 * @type {import('./index.js').TTSAdapter}
 */
const elevenLabsAdapter = {
  id: 'elevenlabs',
  displayName: 'ElevenLabs',

  /** Check if apiKey was configured (called by registry). */
  async hasKey() {
    const raw = await window.mvp.getKey('elevenlabs');
    return !!(raw && raw.trim());
  },

  supportsLanguage(langCode) {
    // ElevenLabs Multilingual v2 supports 29 languages; allow anything and
    // let the API decide. Always return true so fallback logic works.
    return true;
  },

  async listVoices(langCode) {
    const raw = await window.mvp.getKey('elevenlabs');
    const key = raw ? raw.trim() : '';
    if (!key) return [];
    try {
      const { data } = await axios.get(`${BASE}/voices`, {
        headers: { 'xi-api-key': key },
        timeout: 10_000,
      });
      return (data.voices || []).map((v) => ({
        id: v.voice_id,
        name: v.name,
        language: langCode,
        preview: v.preview_url || null,
      }));
    } catch (err) {
      if (err.response?.status === 401) {
        console.warn('[elevenlabs] 401 Unauthorized: The ElevenLabs API key is invalid or expired.');
      } else {
        console.warn('[elevenlabs] listVoices failed:', err.message);
      }
      return Object.entries(DEFAULT_VOICES).map(([lang, id]) => ({
        id, name: `Default (${lang})`, language: lang, preview: null,
      }));
    }
  },

  defaultVoiceId(langCode) {
    return DEFAULT_VOICES[langCode] || DEFAULT_VOICES.en;
  },

  async synthesize({ text, langCode, voiceId, emotion, onChunk }) {
    const raw = await window.mvp.getKey('elevenlabs');
    const key = raw ? raw.trim() : '';
    if (!key) throw new Error('ElevenLabs API key not configured.');

    const vid = voiceId || this.defaultVoiceId(langCode);
    const url = `${BASE}/text-to-speech/${vid}/stream`;

    // Dynamic Emotion Modulation based on SenseVoice SER detection
    let voiceSettings = {
      stability: 0.5,
      similarity_boost: 0.8,
      style: 0.0,
      use_speaker_boost: true,
    };

    if (emotion) {
      switch (emotion.toLowerCase()) {
        case 'angry':
          voiceSettings = { stability: 0.30, similarity_boost: 0.90, style: 0.50, use_speaker_boost: true };
          break;
        case 'happy':
          voiceSettings = { stability: 0.40, similarity_boost: 0.85, style: 0.35, use_speaker_boost: true };
          break;
        case 'sad':
          voiceSettings = { stability: 0.80, similarity_boost: 0.70, style: 0.20, use_speaker_boost: false };
          break;
        case 'fearful':
          voiceSettings = { stability: 0.25, similarity_boost: 0.75, style: 0.40, use_speaker_boost: true };
          break;
        case 'disgusted':
          voiceSettings = { stability: 0.35, similarity_boost: 0.80, style: 0.30, use_speaker_boost: true };
          break;
        case 'neutral':
        default:
          voiceSettings = { stability: 0.50, similarity_boost: 0.80, style: 0.00, use_speaker_boost: true };
          break;
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': key,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: voiceSettings,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let msg = `ElevenLabs ${response.status}: ${body.slice(0, 200)}`;
      if (response.status === 401) {
        msg = 'ElevenLabs 401 Unauthorized: The API key entered in Settings is invalid, expired, or revoked. Please update it in ⚙ Settings.';
      }
      const err = new Error(msg);
      err.status = response.status;
      throw err;
    }

    const reader = response.body.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      if (onChunk) onChunk(value);
    }

    // Return full audio as a single Uint8Array
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { merged.set(c, offset); offset += c.length; }
    return merged;
  },

  estimateCostPer1kChars() {
    // ~$30/1M chars → $0.03/1k chars
    return 0.03;
  },
};

export default elevenLabsAdapter;
