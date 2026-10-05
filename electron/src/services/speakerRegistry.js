// SpeakerRegistry: Tracks characters across a film and maps each character
// to a consistent gender-matched voice persona (or cloned voice).

const DEFAULT_PERSONAS = {
  elevenlabs: {
    male: 'pNInz6obpgDQGcFmaJgB',    // Adam (Deep, clear, narrative male)
    female: '21m00Tcm4TlvDq8ikWAM',  // Rachel (Warm, expressive female)
    child: 'AZnzlk1XvdvUeBnXmlld',   // Domi (High-pitched, energetic)
  },
  google: {
    male: 'en-US-Wavenet-B',
    female: 'en-US-Wavenet-F',
    child: 'en-US-Wavenet-A',
  },
  kokoro: {
    male: 'am_michael',
    female: 'af_bella',
    child: 'af_sarah',
  },
  edge: {
    male: 'en-US-GuyNeural',
    female: 'en-US-JennyNeural',
    child: 'en-US-AnaNeural',
  },
};

export class SpeakerRegistry {
  constructor() {
    /** @type {Map<string, { id: string, name: string, gender: string, voiceId?: string, isCloned?: boolean }>} */
    this.speakers = new Map();
  }

  /**
   * Register or update a speaker.
   * @param {string} speakerId - e.g. 'speaker_0'
   * @param {Object} info
   * @param {string} [info.name]
   * @param {'male'|'female'|'child'} info.gender
   * @param {string} [info.voiceId]
   * @param {boolean} [info.isCloned]
   */
  registerSpeaker(speakerId, { name, gender, voiceId, isCloned }) {
    const existing = this.speakers.get(speakerId) || {};
    const updated = {
      id: speakerId,
      name: name || existing.name || (gender === 'female' ? 'Female Character' : 'Male Character'),
      gender: gender || existing.gender || 'male',
      voiceId: voiceId || existing.voiceId || null,
      isCloned: isCloned !== undefined ? isCloned : (existing.isCloned || false),
    };
    this.speakers.set(speakerId, updated);
    return updated;
  }

  /**
   * Get the assigned voice ID for a speaker on a given engine and language.
   * @param {string} speakerId
   * @param {string} engineId - 'elevenlabs' | 'google' | 'kokoro' | 'edge'
   * @param {string} [langCode='en']
   * @returns {string} voice ID to pass to TTS synthesizer
   */
  getVoiceForSpeaker(speakerId, engineId = 'elevenlabs', langCode = 'en') {
    const speaker = this.speakers.get(speakerId);
    if (speaker?.voiceId) {
      return speaker.voiceId; // custom or cloned voice takes precedence
    }

    const gender = speaker?.gender || 'male';
    const engineMap = DEFAULT_PERSONAS[engineId] || DEFAULT_PERSONAS.elevenlabs;
    return engineMap[gender] || engineMap.male;
  }

  /**
   * Set a cloned voice for a specific speaker.
   * @param {string} speakerId 
   * @param {string} voiceId 
   */
  setClonedVoice(speakerId, voiceId) {
    const existing = this.speakers.get(speakerId) || { id: speakerId, gender: 'male' };
    existing.voiceId = voiceId;
    existing.isCloned = true;
    this.speakers.set(speakerId, existing);
  }

  /**
   * List all registered speakers.
   */
  getAllSpeakers() {
    return Array.from(this.speakers.values());
  }

  /** Clear all speaker profiles on new video */
  clear() {
    this.speakers.clear();
  }
}

// Global singleton instance for active playback session
export const globalSpeakerRegistry = new SpeakerRegistry();
export default globalSpeakerRegistry;
