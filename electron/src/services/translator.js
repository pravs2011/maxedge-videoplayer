// AI-powered subtitle translation service using Groq (OpenAI-compatible API)
// with automatic fallback to public translation API if key is absent.

import axios from 'axios';

export const SUPPORTED_LANGUAGES = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  hi: 'Hindi',
  ar: 'Arabic',
  ru: 'Russian',
  nl: 'Dutch',
  pl: 'Polish',
  tr: 'Turkish',
  sv: 'Swedish',
  da: 'Danish',
  fi: 'Finnish',
  nb: 'Norwegian',
  uk: 'Ukrainian',
  cs: 'Czech',
  ro: 'Romanian',
  hu: 'Hungarian',
  el: 'Greek',
  th: 'Thai',
  vi: 'Vietnamese',
  id: 'Indonesian',
  ms: 'Malay',
};

// In-memory cache for translations: "srcLang:targetLang:text" -> "translatedText"
const translationCache = new Map();

/**
 * Get language name from code
 * @param {string} code 
 * @returns {string}
 */
export function getLanguageName(code) {
  if (!code) return 'English';
  const clean = code.toLowerCase().slice(0, 2);
  return SUPPORTED_LANGUAGES[clean] || code;
}

/**
 * Clean up translated text returned by LLM
 * @param {string} raw 
 * @returns {string}
 */
function cleanOutput(raw) {
  if (!raw) return '';
  let cleaned = raw.trim();
  // Remove markdown quotes or backticks if wrapped
  cleaned = cleaned.replace(/^[`"'\u201c\u201d\u00ab\u00bb]+|[`"'\u201c\u201d\u00ab\u00bb]+$/g, '').trim();
  // Remove common LLM prefixes like "Translation: " or "Translated text: "
  cleaned = cleaned.replace(/^(Translation|Translated text|Output):\s*/i, '').trim();
  return cleaned;
}

/**
 * Translate using Groq OpenAI-compatible Chat Completions API
 * Default model: qwen/qwen3.8-27b
 * Base URL: https://api.groq.com/openai/v1/
 */
async function translateWithGroq({
  text,
  sourceLang,
  targetLang,
  apiKey,
  model = 'qwen/qwen3.8-27b',
  baseUrl = 'https://api.groq.com/openai/v1/',
}) {
  const cleanBase = (baseUrl || 'https://api.groq.com/openai/v1/').replace(/\/+$/, '');
  const endpoint = `${cleanBase}/chat/completions`;

  const srcName = getLanguageName(sourceLang);
  const tgtName = getLanguageName(targetLang);

  const systemPrompt = `You are a real-time subtitle and voiceover translator. Translate the text from ${srcName} to ${tgtName}.
Guidelines:
1. Provide a natural, conversational translation that fits spoken dialogue and timing.
2. Return ONLY the translated sentence.
3. Do NOT include quotes, explanations, prefixes, commentary, or markdown.`;

  const response = await axios.post(
    endpoint,
    {
      model: model || 'qwen/qwen3.8-27b',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: text },
      ],
      temperature: 0.2,
      max_tokens: 512,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    }
  );

  const raw = response.data?.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Empty response from Groq translation model');
  return cleanOutput(raw);
}

/**
 * Free fallback translation (Google Web Translate endpoint)
 * Used when no Groq key is supplied or when Groq is temporarily unreachable.
 */
async function translateWithFallback(text, sourceLang, targetLang) {
  try {
    const sl = (sourceLang || 'auto').slice(0, 2);
    const tl = (targetLang || 'en').slice(0, 2);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(text)}`;
    const res = await axios.get(url, { timeout: 6000 });
    if (res.data && res.data[0]) {
      const translated = res.data[0].map((item) => item[0]).join('');
      if (translated) return translated.trim();
    }
  } catch (err) {
    console.warn('[translator] free fallback translation error:', err.message);
  }
  return text; // Last resort: return original
}

/**
 * Translate a single subtitle string
 * @param {Object} opts
 * @param {string} opts.text
 * @param {string} opts.sourceLang
 * @param {string} opts.targetLang
 * @param {string} [opts.apiKey] - Groq API key
 * @param {string} [opts.model] - Groq model, default 'qwen/qwen3.8-27b'
 * @param {string} [opts.baseUrl] - Base URL, default 'https://api.groq.com/openai/v1/'
 * @returns {Promise<string>}
 */
export async function translateText({
  text,
  sourceLang = 'auto',
  targetLang = 'en',
  apiKey = '',
  model = 'qwen/qwen3.8-27b',
  baseUrl = 'https://api.groq.com/openai/v1/',
}) {
  const trimmed = (text || '').trim();
  if (!trimmed) return '';

  const s = sourceLang ? sourceLang.toLowerCase().slice(0, 2) : 'auto';
  const t = targetLang ? targetLang.toLowerCase().slice(0, 2) : 'en';

  if (s !== 'auto' && s === t) {
    return trimmed;
  }

  const cacheKey = `${s}:${t}:${trimmed}`;
  if (translationCache.has(cacheKey)) {
    return translationCache.get(cacheKey);
  }

  let result = null;
  let error = null;

  if (apiKey && apiKey.trim()) {
    try {
      result = await translateWithGroq({
        text: trimmed,
        sourceLang: s,
        targetLang: t,
        apiKey: apiKey.trim(),
        model,
        baseUrl,
      });
    } catch (err) {
      console.warn(`[translator] Groq translation failed (${err.message}), trying fallback...`);
      error = err;
    }
  }

  if (!result) {
    result = await translateWithFallback(trimmed, s, t);
  }

  if (result) {
    translationCache.set(cacheKey, result);
    return result;
  }

  if (error) throw error;
  return trimmed;
}

/**
 * Transcribe and translate an audio chunk using Groq Whisper (whisper-large-v3)
 * @param {Object} opts
 * @param {string} opts.base64Data - base64-encoded audio chunk (MP3)
 * @param {number} [opts.startTime=0] - starting timestamp of this chunk in seconds
 * @param {string} opts.apiKey - Groq API key
 * @param {string} [opts.targetLang='en'] - target language for translated text
 * @param {string} [opts.baseUrl='https://api.groq.com/openai/v1/']
 * @returns {Promise<{ segments: Array<{ start:number, end:number, text:string, translated:string }>, detectedLanguage: string }>}
 */
export async function transcribeAndTranslateAudioChunk({
  base64Data,
  startTime = 0,
  apiKey,
  targetLang = 'en',
  baseUrl = 'https://api.groq.com/openai/v1/',
}) {
  if (!apiKey || !apiKey.trim()) {
    throw new Error('Groq API key is required for AI speech translation.');
  }

  const binaryString = atob(base64Data);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  const blob = new Blob([bytes], { type: 'audio/mp3' });
  const cleanBase = (baseUrl || 'https://api.groq.com/openai/v1/').replace(/\/+$/, '');

  const isTargetEnglish = !targetLang || targetLang.toLowerCase().slice(0, 2) === 'en';
  const endpoint = isTargetEnglish
    ? `${cleanBase}/audio/translations`
    : `${cleanBase}/audio/transcriptions`;

  const formData = new FormData();
  formData.append('file', blob, 'audio.mp3');
  formData.append('model', 'whisper-large-v3');
  formData.append('response_format', 'verbose_json');
  formData.append('temperature', '0.0');

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Groq Whisper ${response.status}: ${errorBody.slice(0, 250)}`);
  }

  const data = await response.json();
  const rawSegments = data.segments || (data.text ? [{ start: 0, end: 5, text: data.text }] : []);
  const detectedLanguage = data.language || 'en';

  const processed = [];
  for (const seg of rawSegments) {
    const rawText = (seg.text || '').trim();
    if (!rawText || /^[\[\(].*?[\]\)]$/.test(rawText)) continue;

    let translated = rawText;
    if (!isTargetEnglish) {
      translated = await translateText({
        text: rawText,
        sourceLang: detectedLanguage,
        targetLang,
        apiKey,
        baseUrl,
      });
    }

    processed.push({
      start: Number((startTime + seg.start).toFixed(2)),
      end: Number((startTime + seg.end).toFixed(2)),
      text: rawText,
      translated: (translated || rawText).trim(),
    });
  }

  return {
    segments: processed,
    detectedLanguage,
    fullText: data.text || '',
  };
}

export default {
  SUPPORTED_LANGUAGES,
  getLanguageName,
  translateText,
  transcribeAndTranslateAudioChunk,
};
