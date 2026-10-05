// Google Cloud TTS adapter — implements the VoiceBox interface.
import axios from 'axios';

const BASE = 'https://texttospeech.googleapis.com/v1';

// Default WaveNet voice mapping (language → voice name).
const DEFAULT_VOICES = {
  en: 'en-US-Wavenet-D',
  es: 'es-ES-Wavenet-B',
  fr: 'fr-FR-Wavenet-C',
  de: 'de-DE-Wavenet-B',
  it: 'it-IT-Wavenet-A',
  pt: 'pt-BR-Wavenet-B',
  ja: 'ja-JP-Wavenet-B',
  ko: 'ko-KR-Wavenet-A',
  zh: 'cmn-CN-Wavenet-A',
  hi: 'hi-IN-Wavenet-A',
  ar: 'ar-XA-Wavenet-A',
  ru: 'ru-RU-Wavenet-A',
};

// Map 2-letter lang code to Google's BCP-47 prefix
function langToBcp47(lang) {
  const map = {
    en: 'en-US', es: 'es-ES', fr: 'fr-FR', de: 'de-DE', it: 'it-IT',
    pt: 'pt-BR', ja: 'ja-JP', ko: 'ko-KR', zh: 'cmn-CN', hi: 'hi-IN',
    ar: 'ar-XA', ru: 'ru-RU', nl: 'nl-NL', pl: 'pl-PL', sv: 'sv-SE',
    tr: 'tr-TR', da: 'da-DK', fi: 'fi-FI', nb: 'nb-NO', uk: 'uk-UA',
  };
  return map[lang] || `${lang}-${lang.toUpperCase()}`;
}

/**
 * @type {import('./index.js').TTSAdapter}
 */
const googleAdapter = {
  id: 'google',
  displayName: 'Google Cloud TTS',

  async hasKey() {
    const key = await window.mvp.getKey('google');
    return !!key;
  },

  supportsLanguage(langCode) {
    // Google supports 40+ languages. Allow anything.
    return true;
  },

  async listVoices(langCode) {
    const key = await window.mvp.getKey('google');
    if (!key) return [];
    const bcp = langToBcp47(langCode);
    try {
      const { data } = await axios.get(`${BASE}/voices`, {
        params: { key, languageCode: bcp },
        timeout: 10_000,
      });
      return (data.voices || []).map((v) => ({
        id: v.name,
        name: v.name,
        language: langCode,
        gender: v.ssmlGender,
        preview: null,
      }));
    } catch (err) {
      console.warn('[google] listVoices failed:', err.message);
      return Object.entries(DEFAULT_VOICES).map(([lang, name]) => ({
        id: name, name, language: lang, preview: null,
      }));
    }
  },

  defaultVoiceId(langCode) {
    return DEFAULT_VOICES[langCode] || DEFAULT_VOICES.en;
  },

  async synthesize({ text, langCode, voiceId, onChunk }) {
    const key = await window.mvp.getKey('google');
    if (!key) throw new Error('Google Cloud TTS API key not configured.');

    const bcp = langToBcp47(langCode);
    const voiceName = voiceId || this.defaultVoiceId(langCode);

    // Google TTS returns the full audio in one response (not streaming).
    // We break the text into ≤5000-byte chunks to stay within the API limit.
    const MAX_INPUT = 4800;
    const textChunks = [];
    for (let i = 0; i < text.length; i += MAX_INPUT) {
      textChunks.push(text.slice(i, i + MAX_INPUT));
    }

    const allChunks = [];
    for (const chunk of textChunks) {
      const { data } = await axios.post(
        `${BASE}/text:synthesize`,
        {
          input: { text: chunk },
          voice: { languageCode: bcp, name: voiceName },
          audioConfig: { audioEncoding: 'MP3' },
        },
        {
          params: { key },
          timeout: 30_000,
        }
      );

      // data.audioContent is base64
      const raw = Uint8Array.from(atob(data.audioContent), (c) => c.charCodeAt(0));
      allChunks.push(raw);
      if (onChunk) onChunk(raw);
    }

    // Merge into single buffer
    const total = allChunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of allChunks) { merged.set(c, offset); offset += c.length; }
    return merged;
  },

  estimateCostPer1kChars() {
    // WaveNet: $16/1M chars → $0.016/1k chars
    return 0.016;
  },
};

export default googleAdapter;
