// Subtitle parser — converts .srt and .vtt files into time-aligned segments.
// Each segment: { start: seconds, end: seconds, text: string }

/**
 * Parse a timestamp string into seconds.
 * Supported formats:
 *   00:01:23,456  (SRT)
 *   00:01:23.456  (VTT)
 *   01:23.456     (VTT short)
 */
function parseTimestamp(ts) {
  ts = ts.trim().replace(',', '.');
  const parts = ts.split(':');
  if (parts.length === 3) {
    return (+parts[0]) * 3600 + (+parts[1]) * 60 + parseFloat(parts[2]);
  }
  if (parts.length === 2) {
    return (+parts[0]) * 60 + parseFloat(parts[1]);
  }
  return parseFloat(ts) || 0;
}

/**
 * Parse SRT content.
 * @param {string} content
 * @returns {{ start:number, end:number, text:string }[]}
 */
export function parseSrt(content) {
  const segments = [];
  // Split on blank lines (one or more) → blocks
  const blocks = content.replace(/\r\n/g, '\n').split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 2) continue;

    // Find the timestamp line (contains " --> ")
    const tsIdx = lines.findIndex((l) => l.includes('-->'));
    if (tsIdx === -1) continue;

    const [startStr, endStr] = lines[tsIdx].split('-->');
    const start = parseTimestamp(startStr);
    const end = parseTimestamp(endStr);

    // Everything after the timestamp line is subtitle text
    const text = lines
      .slice(tsIdx + 1)
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\{[^}]+\}/g, '')
      .trim();

    if (text && end > start) {
      segments.push({ start, end, text });
    }
  }

  return segments;
}

/**
 * Parse VTT content.
 * @param {string} content
 * @returns {{ start:number, end:number, text:string }[]}
 */
export function parseVtt(content) {
  // VTT is structurally similar to SRT after stripping the header
  const stripped = content.replace(/^WEBVTT[^\n]*\n/i, '').replace(/^NOTE[^\n]*\n/gm, '');
  return parseSrt(stripped);
}

/**
 * Parse plain text (no timestamps) — treat the whole text as a single segment
 * that spans the duration of the video.
 * @param {string} text
 * @param {number} duration — video duration in seconds
 * @returns {{ start:number, end:number, text:string }[]}
 */
export function parsePlainText(text, duration) {
  if (!text || !text.trim()) return [];

  // Try to split by sentences for more granular segments
  const sentences = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentences.length <= 1 || duration <= 0) {
    return [{ start: 0, end: duration || 60, text: text.trim() }];
  }

  // Distribute sentences evenly across the video duration
  const segDuration = duration / sentences.length;
  return sentences.map((s, i) => ({
    start: i * segDuration,
    end: (i + 1) * segDuration,
    text: s,
  }));
}

/**
 * Auto-detect format and parse.
 * @param {string} content — raw file content
 * @param {number} [duration=0] — video duration for plain-text fallback
 * @returns {{ start:number, end:number, text:string }[]}
 */
export function parseSubtitles(content, duration = 0) {
  if (!content) return [];
  const trimmed = content.trim();

  if (trimmed.startsWith('WEBVTT')) return parseVtt(trimmed);
  if (/\d+\s*\n\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->/.test(trimmed)) return parseSrt(trimmed);

  // Fallback: plain text
  return parsePlainText(trimmed, duration);
}

export default { parseSrt, parseVtt, parsePlainText, parseSubtitles };
