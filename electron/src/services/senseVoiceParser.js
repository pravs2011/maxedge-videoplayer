// SenseVoiceParser: Parses raw tokens from SenseVoice ASR model.
// Extracts clean spoken text, speech emotion (SER), non-verbal audio events (AED),
// and detected spoken language.

/**
 * @typedef {Object} ParsedSenseVoice
 * @property {string} text - clean spoken text without special tags
 * @property {'happy'|'sad'|'angry'|'neutral'|'fearful'|'disgusted'} emotion
 * @property {string[]} events - detected audio events e.g. ['laughter', 'applause', 'crying']
 * @property {string} lang - detected spoken language e.g. 'en', 'zh', 'ja', 'ko'
 * @property {boolean} hasHumanNonVerbal - true if segment is primarily laughter/crying
 * @property {string} raw - raw untouched output with tags
 */

const EMOTION_MAP = {
  HAPPY: 'happy',
  SAD: 'sad',
  ANGRY: 'angry',
  NEUTRAL: 'neutral',
  FEARFUL: 'fearful',
  DISGUSTED: 'disgusted',
};

const EVENT_MAP = {
  LAUGHTER: 'laughter',
  APPLAUSE: 'applause',
  CRYING: 'crying',
  COUGH: 'cough',
  SNEEZE: 'sneeze',
  SIGH: 'sigh',
  MUSIC: 'music',
  LAUGH: 'laughter',
};

/**
 * Parse raw text produced by SenseVoice model.
 * Example input: "<|zh|><|NEUTRAL|><|Speech|><|woitn|>Hello everyone<|LAUGHTER|>"
 * 
 * @param {string} rawText
 * @param {number} [startTime=0]
 * @param {number} [duration=0]
 * @returns {ParsedSenseVoice}
 */
export function parseSenseVoiceOutput(rawText, startTime = 0, duration = 0) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      text: '',
      emotion: 'neutral',
      events: [],
      lang: 'en',
      hasHumanNonVerbal: false,
      raw: '',
    };
  }

  const raw = rawText.trim();

  // 1. Extract Language Tag: <|en|>, <|zh|>, <|ja|>, <|ko|>, etc.
  const langMatch = raw.match(/<\|([a-z]{2,3})\|>/i);
  const lang = langMatch ? langMatch[1].toLowerCase() : 'en';

  // 2. Extract Emotion Tag: <|HAPPY|>, <|SAD|>, <|ANGRY|>, etc.
  const emotionMatch = raw.match(/<\|(HAPPY|SAD|ANGRY|NEUTRAL|FEARFUL|DISGUSTED)\|>/i);
  const emotionKey = emotionMatch ? emotionMatch[1].toUpperCase() : 'NEUTRAL';
  const emotion = EMOTION_MAP[emotionKey] || 'neutral';

  // 3. Extract Audio Event Tags: <|LAUGHTER|>, <|APPLAUSE|>, <|CRYING|>, etc.
  const events = [];
  const eventRegex = /<\|(LAUGHTER|APPLAUSE|CRYING|COUGH|SNEEZE|SIGH|MUSIC|LAUGH)\|>/gi;
  let match;
  while ((match = eventRegex.exec(raw)) !== null) {
    const ev = EVENT_MAP[match[1].toUpperCase()];
    if (ev && !events.includes(ev)) {
      events.push(ev);
    }
  }

  // 4. Strip all special tags <|...|> to isolate clean text
  const cleanText = raw
    .replace(/<\|[A-Za-z0-9_\-\.]+\|>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  const isLaughterOrCrying = events.includes('laughter') || events.includes('crying');
  const hasHumanNonVerbal = isLaughterOrCrying && cleanText.length < 3;

  return {
    text: cleanText,
    emotion,
    events,
    lang,
    hasHumanNonVerbal,
    raw,
  };
}

/**
 * Emotion styling parameters for ElevenLabs voice generation.
 * Adjusts voice stability, similarity boost, and style expressiveness.
 * 
 * @param {'happy'|'sad'|'angry'|'neutral'|'fearful'|'disgusted'} emotion
 * @returns {{ stability: number, similarity_boost: number, style: number, use_speaker_boost: boolean }}
 */
export function getEmotionVoiceSettings(emotion) {
  switch (emotion) {
    case 'angry':
      return { stability: 0.30, similarity_boost: 0.90, style: 0.50, use_speaker_boost: true };
    case 'happy':
      return { stability: 0.40, similarity_boost: 0.85, style: 0.35, use_speaker_boost: true };
    case 'sad':
      return { stability: 0.80, similarity_boost: 0.70, style: 0.20, use_speaker_boost: false };
    case 'fearful':
      return { stability: 0.25, similarity_boost: 0.75, style: 0.40, use_speaker_boost: true };
    case 'disgusted':
      return { stability: 0.35, similarity_boost: 0.80, style: 0.30, use_speaker_boost: true };
    case 'neutral':
    default:
      return { stability: 0.50, similarity_boost: 0.80, style: 0.00, use_speaker_boost: true };
  }
}

export default {
  parseSenseVoiceOutput,
  getEmotionVoiceSettings,
};
