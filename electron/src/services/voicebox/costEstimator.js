// Cost-per-1M-characters pricing table (USD) for each engine + language tier.
// Prices are approximate list prices as of 2026; update when needed.
// "standard" = base tier, "premium" = neural/wavenet/turbo voices.

const PRICING = {
  elevenlabs: {
    // ElevenLabs charges per character. Starter ≈ $5/100k chars → $50/1M chars.
    // Scale plan ≈ $30/1M chars.
    default: 30,
  },
  google: {
    // Google WaveNet ≈ $16/1M chars, Standard ≈ $4/1M chars, Neural2 ≈ $16/1M.
    standard: 4,
    wavenet: 16,
    neural2: 16,
    default: 16,   // we default to WaveNet quality
  },
};

/**
 * Estimate the cost (USD) of synthesising `charCount` characters with a given engine.
 * @param {string} engineId — 'elevenlabs' | 'google'
 * @param {number} charCount
 * @param {string} [voiceTier='default'] — voice quality tier
 * @returns {number} estimated cost in USD
 */
export function estimateCost(engineId, charCount, voiceTier = 'default') {
  const tiers = PRICING[engineId];
  if (!tiers) return Infinity;
  const perMillion = tiers[voiceTier] ?? tiers.default ?? Infinity;
  return (charCount / 1_000_000) * perMillion;
}

/**
 * costPer1kChars — convenience method used by the adapter registry for sorting.
 * @param {string} engineId
 * @param {string} [voiceTier='default']
 * @returns {number} USD per 1 000 characters
 */
export function costPer1kChars(engineId, voiceTier = 'default') {
  const tiers = PRICING[engineId];
  if (!tiers) return Infinity;
  const perMillion = tiers[voiceTier] ?? tiers.default ?? Infinity;
  return (1_000 / 1_000_000) * perMillion;
}

/**
 * Pick the cheapest engine from a list of enabled engine IDs.
 * @param {string[]} enabledEngines — e.g. ['elevenlabs', 'google']
 * @param {string} [voiceTier='default']
 * @returns {string|null} cheapest engine id, or null if list empty
 */
export function cheapestEngine(enabledEngines, voiceTier = 'default') {
  if (!enabledEngines.length) return null;
  let best = null;
  let bestCost = Infinity;
  for (const id of enabledEngines) {
    const c = costPer1kChars(id, voiceTier);
    if (c < bestCost) { bestCost = c; best = id; }
  }
  return best;
}

export default { estimateCost, costPer1kChars, cheapestEngine, PRICING };
