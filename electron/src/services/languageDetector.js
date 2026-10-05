// Language detection from subtitle text or raw transcript.
// Uses the franc library (trigram-based) with fallback heuristics.

import { franc } from 'franc';

// franc returns ISO 639-3 codes; map the common ones to ISO 639-1.
const ISO3_TO_1 = {
  eng: 'en', spa: 'es', fra: 'fr', deu: 'de', ita: 'it', por: 'pt',
  jpn: 'ja', kor: 'ko', cmn: 'zh', zho: 'zh', hin: 'hi', ara: 'ar',
  rus: 'ru', nld: 'nl', pol: 'pl', swe: 'sv', tur: 'tr', dan: 'da',
  fin: 'fi', nob: 'nb', ukr: 'uk', ces: 'cs', ron: 'ro', hun: 'hu',
  ell: 'el', tha: 'th', vie: 'vi', ind: 'id', msa: 'ms',
};

/**
 * Detect the language of a block of text.
 * @param {string} text — at least 50 chars for reliable detection
 * @returns {string} 2-letter ISO 639-1 code, or 'en' as fallback
 */
export function detectLanguage(text) {
  if (!text || text.length < 20) return 'en';

  // Strip SRT/VTT timestamps and markup to get cleaner text
  const cleaned = text
    .replace(/\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{[^}]+\}/g, '')
    .replace(/^\d+\s*$/gm, '')
    .replace(/^WEBVTT.*$/m, '')
    .trim();

  if (cleaned.length < 20) return 'en';

  const iso3 = franc(cleaned, { minLength: 20 });
  if (iso3 === 'und') return 'en';   // undetermined
  return ISO3_TO_1[iso3] || iso3.slice(0, 2);
}

/**
 * Try to detect language from a .srt or .vtt file loaded via the preload bridge.
 * @param {string} subtitlePath — absolute path on disk
 * @returns {Promise<string>} 2-letter code
 */
export async function detectFromSubtitleFile(subtitlePath) {
  const text = await window.mvp.readText(subtitlePath);
  return detectLanguage(text);
}

export default { detectLanguage, detectFromSubtitleFile };
