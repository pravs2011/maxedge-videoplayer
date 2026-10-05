// VoiceBox adapter registry — cost-aware engine selection + automatic fallback.
//
// Each adapter implements:
//   id: string
//   displayName: string
//   hasKey(): Promise<boolean>
//   supportsLanguage(langCode): boolean
//   listVoices(langCode): Promise<Voice[]>
//   defaultVoiceId(langCode): string
//   synthesize({ text, langCode, voiceId, onChunk }): Promise<Uint8Array>
//   estimateCostPer1kChars(langCode?): number
//

import elevenLabsAdapter from './elevenlabs.js';
import googleAdapter from './google.js';

/** @typedef {{ id:string, name:string, language:string, preview?:string|null }} Voice */

// All known adapters in registration order
const ALL_ADAPTERS = [elevenLabsAdapter, googleAdapter];

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

/**
 * Return adapters that are enabled AND have a stored API key.
 * @param {string[]} enabledIds — e.g. ['elevenlabs', 'google']
 * @returns {Promise<object[]>} adapters with valid keys
 */
export async function getAvailableAdapters(enabledIds) {
  const results = [];
  for (const adapter of ALL_ADAPTERS) {
    if (!enabledIds.includes(adapter.id)) continue;
    if (await adapter.hasKey()) results.push(adapter);
  }
  return results;
}

/**
 * Pick the cheapest available adapter that supports `langCode`.
 * @param {string[]} enabledIds
 * @param {string} langCode
 * @param {Record<string,number>} [cooldowns] — { engineId: expiryTimestamp }
 * @returns {Promise<object|null>}
 */
export async function selectCheapest(enabledIds, langCode, cooldowns = {}) {
  const adapters = await getAvailableAdapters(enabledIds);
  const now = Date.now();
  const eligible = adapters
    .filter((a) => a.supportsLanguage(langCode))
    .filter((a) => !(cooldowns[a.id] && cooldowns[a.id] > now));

  if (eligible.length === 0) return null;
  eligible.sort((a, b) => a.estimateCostPer1kChars(langCode) - b.estimateCostPer1kChars(langCode));
  return eligible[0];
}

/**
 * Select a specific adapter by id.
 */
export function getAdapterById(id) {
  return ALL_ADAPTERS.find((a) => a.id === id) || null;
}

// ---------------------------------------------------------------------------
// Synthesise with automatic fallback
// ---------------------------------------------------------------------------

const COOLDOWN_MS = 30_000;

/**
 * Synthesise text with the best available engine, falling back on errors.
 *
 * @param {{ text:string, langCode:string, voiceId?:string,
 *           enabledEngines:string[], preferredEngine:string|'auto',
 *           cooldowns:Record<string,number>, onChunk?:(bytes:Uint8Array)=>void,
 *           onEngineSwitch?:(engineId:string)=>void,
 *           onCooldown?:(engineId:string, until:number)=>void
 *         }} opts
 * @returns {Promise<{ audio:Uint8Array, engineUsed:string, charCount:number }>}
 */
export async function synthesizeWithFallback(opts) {
  const { text, langCode, enabledEngines, preferredEngine, cooldowns } = opts;
  const charCount = text.length;

  // Build ordered list: preferred first, then cheapest of the rest
  let orderedAdapters = [];
  if (preferredEngine && preferredEngine !== 'auto') {
    const pref = getAdapterById(preferredEngine);
    if (pref) orderedAdapters.push(pref);
  }
  const avail = await getAvailableAdapters(enabledEngines);
  const now = Date.now();
  const rest = avail
    .filter((a) => !orderedAdapters.find((o) => o.id === a.id))
    .filter((a) => a.supportsLanguage(langCode))
    .filter((a) => !(cooldowns[a.id] && cooldowns[a.id] > now))
    .sort((a, b) => a.estimateCostPer1kChars(langCode) - b.estimateCostPer1kChars(langCode));
  orderedAdapters = [...orderedAdapters, ...rest];

  if (orderedAdapters.length === 0) {
    throw new Error('No TTS engines available — check API keys and enabled engines in Settings.');
  }

  let lastErr = null;
  for (const adapter of orderedAdapters) {
    try {
      if (opts.onEngineSwitch) opts.onEngineSwitch(adapter.id);

      const audio = await adapter.synthesize({
        text,
        langCode,
        voiceId: opts.voiceId || adapter.defaultVoiceId(langCode),
        emotion: opts.emotion,
        onChunk: opts.onChunk,
      });
      return { audio, engineUsed: adapter.id, charCount };
    } catch (err) {
      console.warn(`[voicebox] ${adapter.id} failed:`, err.message);
      lastErr = err;

      // Cool down on 401 (invalid key), rate-limit (429), or server error (>= 500)
      const status = err.status || err.response?.status;
      if (status === 401 || status === 429 || status >= 500) {
        const until = Date.now() + (status === 401 ? 600_000 : COOLDOWN_MS); // 10 min for invalid key
        if (opts.onCooldown) opts.onCooldown(adapter.id, until);
      }
    }
  }

  throw lastErr || new Error('All TTS engines failed.');
}

export default {
  ALL_ADAPTERS,
  getAvailableAdapters,
  selectCheapest,
  getAdapterById,
  synthesizeWithFallback,
};
