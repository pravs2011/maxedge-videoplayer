// Diarizer: Multi-Speaker Diarization & Gender/Character Attribution.
// Parses dialogue exchanges to assign consistent speaker IDs and genders,
// combining Groq LLM contextual reasoning with acoustic pitch hints.

import axios from 'axios';

/**
 * @typedef {Object} DiarizedSegment
 * @property {number} start
 * @property {number} end
 * @property {string} text
 * @property {string} [translated]
 * @property {string} speakerId — e.g. 'speaker_0', 'speaker_1'
 * @property {'male'|'female'|'child'} gender
 * @property {string} [speakerName] — descriptive label e.g. 'Speaker 1 (♂ Male)'
 */

/**
 * Diarize a batch of segments using Groq LLM dialogue analysis.
 * @param {Object} opts
 * @param {Array<{ start: number, end: number, text: string, translated?: string }>} opts.segments
 * @param {string} opts.apiKey - Groq API key
 * @param {string} [opts.model='qwen/qwen3.8-27b']
 * @param {string} [opts.baseUrl='https://api.groq.com/openai/v1/']
 * @param {Object} [opts.acousticHints] - map of segment index -> detected acoustic gender
 * @returns {Promise<DiarizedSegment[]>}
 */
export async function diarizeDialogueBatch({
  segments,
  apiKey,
  model = 'qwen/qwen3.8-27b',
  baseUrl = 'https://api.groq.com/openai/v1/',
  acousticHints = {},
}) {
  if (!segments || segments.length === 0) return [];
  if (segments.length === 1) {
    const hint = acousticHints[0] || 'male';
    return [{
      ...segments[0],
      speakerId: 'speaker_0',
      gender: hint,
      speakerName: hint === 'female' ? 'Speaker 1 (♀ Female)' : 'Speaker 1 (♂ Male)',
    }];
  }

  // If no Groq key, use fast acoustic + turn-alternation heuristic
  if (!apiKey || !apiKey.trim()) {
    return fallbackHeuristicDiarize(segments, acousticHints);
  }

  try {
    const dialogueLines = segments.map((s, idx) => {
      const hint = acousticHints[idx] ? `[Pitch hint: ${acousticHints[idx]}]` : '';
      return `${idx + 1}. [${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s]: "${s.text}" ${hint}`;
    }).join('\n');

    const prompt = `You are an expert film audio director and dialogue diarizer.
Analyze this sequence of movie dialogue lines. Identify who is speaking (Speaker 1, Speaker 2, etc.) and their gender (M for Male, F for Female).
Take conversational turns, speaker pauses, question-answer pairs, and pronouns into account.

Dialogue:
${dialogueLines}

Respond ONLY with valid JSON array in this exact schema with NO markdown and NO explanations:
[
  { "line": 1, "speaker": "Speaker 1", "gender": "M" },
  { "line": 2, "speaker": "Speaker 2", "gender": "F" }
]`;

    const cleanBaseUrl = (baseUrl || 'https://api.groq.com/openai/v1/').replace(/\/+$/, '');
    const res = await axios.post(
      `${cleanBaseUrl}/chat/completions`,
      {
        model: model || 'qwen/qwen3.8-27b',
        messages: [
          { role: 'system', content: 'You are a precise JSON-only dialogue diarizer. Output only raw JSON array.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.1,
        max_tokens: 600,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        timeout: 4000,
      }
    );

    const raw = res.data?.choices?.[0]?.message?.content?.trim() || '';
    const cleanJson = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(cleanJson);

    if (Array.isArray(parsed) && parsed.length > 0) {
      const speakerIdMap = new Map();
      let speakerCounter = 0;

      return segments.map((seg, idx) => {
        const item = parsed.find((p) => p.line === idx + 1) || parsed[idx];
        const speakerLabel = item?.speaker || 'Speaker 1';
        if (!speakerIdMap.has(speakerLabel)) {
          speakerIdMap.set(speakerLabel, `speaker_${speakerCounter++}`);
        }
        const speakerId = speakerIdMap.get(speakerLabel);

        // Determine gender (prioritize LLM contextual inference, fallback to acoustic pitch hint)
        let gender = 'male';
        if (item?.gender?.toUpperCase() === 'F' || item?.gender?.toLowerCase() === 'female') {
          gender = 'female';
        } else if (item?.gender?.toUpperCase() === 'M' || item?.gender?.toLowerCase() === 'male') {
          gender = 'male';
        } else if (acousticHints[idx]) {
          gender = acousticHints[idx];
        }

        const icon = gender === 'female' ? '♀' : '♂';
        return {
          ...seg,
          speakerId,
          gender,
          speakerName: `${speakerLabel} (${icon} ${gender === 'female' ? 'Female' : 'Male'})`,
        };
      });
    }
  } catch (err) {
    console.warn('[Diarizer] Groq LLM diarization failed, using heuristic fallback:', err.message);
  }

  return fallbackHeuristicDiarize(segments, acousticHints);
}

/**
 * Fast local heuristic diarization when LLM is unavailable or times out.
 * Groups segments by pause gaps (> 1.2s pause indicates potential speaker change)
 * and uses acoustic pitch hints.
 */
export function fallbackHeuristicDiarize(segments, acousticHints = {}) {
  let currentSpeakerNum = 0;
  let lastEnd = 0;
  const result = [];

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const pause = s.start - lastEnd;

    // A pause > 1.2s or an obvious pitch flip indicates turn change
    const prevGender = result[i - 1]?.gender;
    const currentHint = acousticHints[i];

    if (i > 0 && (pause > 1.2 || (currentHint && prevGender && currentHint !== prevGender))) {
      currentSpeakerNum = (currentSpeakerNum + 1) % 2; // alternate between Speaker 0 and 1
    }

    const gender = currentHint || (currentSpeakerNum === 1 ? 'female' : 'male');
    const speakerId = `speaker_${currentSpeakerNum}`;
    const icon = gender === 'female' ? '♀' : '♂';

    result.push({
      ...s,
      speakerId,
      gender,
      speakerName: `Speaker ${currentSpeakerNum + 1} (${icon} ${gender === 'female' ? 'Female' : 'Male'})`,
    });

    lastEnd = s.end;
  }

  return result;
}

export default {
  diarizeDialogueBatch,
  fallbackHeuristicDiarize,
};
