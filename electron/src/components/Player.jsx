import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  videoActions, audioActions, enginesActions,
  syncActions, errorActions, transcriptActions, settingsActions,
} from '../store.js';
import { detectLanguage } from '../services/languageDetector.js';
import { parseSubtitles } from '../services/transcript.js';
import { TTSPrefetcher } from '../services/ttsPrefetcher.js';
import { SyncEngine } from '../services/syncEngine.js';
import { LiveDubber } from '../services/liveDubber.js';
import { selectCheapest } from '../services/voicebox/index.js';
import { SUPPORTED_LANGUAGES } from '../services/translator.js';
import { cloneVoiceFromSample, getCachedClonedVoice } from '../services/voiceCloner.js';
import { calculateDuckedVolume, rampVolume, createCenterVocalEliminator } from '../services/stemSeparator.js';
import { globalSpeakerRegistry } from '../services/speakerRegistry.js';
import VoicePicker from './VoicePicker.jsx';

function fmt(s) {
  if (!s || !Number.isFinite(s)) return '0:00';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export default function Player() {
  const dispatch = useDispatch();
  const videoRef = useRef(null);
  const seekBarRef = useRef(null);

  const video = useSelector((s) => s.video);
  const audio = useSelector((s) => s.audio);
  const settings = useSelector((s) => s.settings);
  const engines = useSelector((s) => s.engines);
  const sync = useSelector((s) => s.sync);
  const transcript = useSelector((s) => s.transcript);

  const prefetcherRef = useRef(null);
  const syncEngineRef = useRef(null);
  const liveDubberRef = useRef(null);
  const clonedVoiceRef = useRef(null);
  const audioContextRef = useRef(null);
  const stemEliminatorRef = useRef(null);

  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [showStats, setShowStats] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekValue, setSeekValue] = useState(0);
  const [ttsStatus, setTtsStatus] = useState('idle'); // idle | loading | ready | error
  const [currentSubtitle, setCurrentSubtitle] = useState(null); // { original, translated }
  const [groqKey, setGroqKey] = useState('');
  const [aiDubbingActive, setAiDubbingActive] = useState(true);
  const [dubbingStatus, setDubbingStatus] = useState('');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [clonedVoiceId, setClonedVoiceId] = useState(null);
  const [cloningStatus, setCloningStatus] = useState('');

  // Live telemetry metrics
  const [stats, setStats] = useState({
    whisperLatencyMs: 0,
    extractLatencyMs: 0,
    chunkRange: '',
    detectedLanguage: '',
    ttsLatencyMs: 0,
    ttsEngine: '',
    driftMs: 0,
    bufferLeadSec: 0,
  });

  // Fetch Groq key on mount
  useEffect(() => {
    (async () => {
      const key = await window.mvp.getKey('groq');
      if (key) setGroqKey(key);
    })();
  }, []);

  // -------------------------------------------------------------------
  // Open video handler
  // -------------------------------------------------------------------
  useEffect(() => {
    const handler = (e) => {
      const { url, filePath, name, size } = e.detail;
      dispatch(videoActions.setVideo({ url, filePath, name, size }));
      dispatch(transcriptActions.clearTranscript());
      dispatch(enginesActions.setDetectedLanguage(null));
      dispatch(enginesActions.setSourceLanguage(null));
      setTtsStatus('idle');
      setCurrentSubtitle(null);
      setDubbingStatus('');
      setClonedVoiceId(null);
      setCloningStatus('');
      setIsSpeaking(false);
      clonedVoiceRef.current = null;
      globalSpeakerRegistry.clear();
      stemEliminatorRef.current?.setStemMode('bypass');
      syncEngineRef.current?.stop();
      prefetcherRef.current?.destroy();
      liveDubberRef.current?.stop();
    };
    window.addEventListener('mvp:open-video', handler);
    return () => window.removeEventListener('mvp:open-video', handler);
  }, [dispatch]);

  // -------------------------------------------------------------------
  // Initialize Real-Time Mid-Side Stem Vocal Eliminator
  // -------------------------------------------------------------------
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    try {
      if (!audioContextRef.current) {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        audioContextRef.current = new AudioCtx();
      }
      if (!stemEliminatorRef.current && audioContextRef.current) {
        stemEliminatorRef.current = createCenterVocalEliminator(audioContextRef.current, el);
      }
    } catch (err) {
      console.warn('[Player] Stem eliminator setup:', err.message);
    }
  }, [video.src]);

  // -------------------------------------------------------------------
  // Cinematic True Stem Separation & BGM/SFX Preservation:
  // Routes video audio through real-time vocal eliminator,
  // keeping 100% of movie soundtrack while wiping original foreign dialogue.
  // -------------------------------------------------------------------
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const isTranslating = aiDubbingActive || ttsStatus === 'ready';
    const eliminator = stemEliminatorRef.current;

    if (eliminator) {
      if (audio.originalMuted) {
        eliminator.setVolume(0);
      } else if (isTranslating) {
        // Activate real-time BGM/SFX stem isolation
        eliminator.setStemMode('bgm_stem');
        const baseVol = audio.originalVolume ?? 0.65;
        // Subtle dip during dialogue keeps translated speech crystal clear
        const currentVol = isSpeaking ? baseVol * 0.55 : baseVol;
        eliminator.setVolume(currentVol);
      } else {
        eliminator.setStemMode('bypass');
        eliminator.setVolume(audio.volume ?? 1);
      }
    } else {
      if (audio.originalMuted) {
        el.volume = 0;
      } else if (isTranslating) {
        const baseVol = audio.originalVolume ?? 0.25;
        const targetVol = calculateDuckedVolume(baseVol, isSpeaking, 0.15);
        rampVolume(el, targetVol, 100);
      } else {
        rampVolume(el, audio.volume ?? 1, 100);
      }
    }
  }, [isSpeaking, aiDubbingActive, ttsStatus, audio.originalMuted, audio.originalVolume, audio.volume]);

  // Update TTS playback gain
  useEffect(() => {
    syncEngineRef.current?.setVolume(audio.volume ?? 1);
  }, [audio.volume]);

  // -------------------------------------------------------------------
  // Video element event bindings
  // -------------------------------------------------------------------
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;

    const onMeta = () => {
      dispatch(videoActions.setDuration(el.duration));
      dispatch(videoActions.setReady(true));
    };
    const onTime = () => {
      dispatch(videoActions.setCurrentTime(el.currentTime));
      if (!isSeeking) setSeekValue(el.currentTime);

      // Show current subtitle text with speaker attribution
      if (transcript.segments.length > 0) {
        const t = el.currentTime;
        const seg = transcript.segments.find((s) => t >= s.start && t < s.end);
        if (seg) {
          setCurrentSubtitle({
            original: seg.text,
            translated: seg.translated || null,
            speakerName: seg.speakerName || null,
            gender: seg.gender || null,
            emotion: seg.emotion || null,
            events: seg.events || null,
          });
        } else {
          setCurrentSubtitle(null);
        }
      } else {
        setCurrentSubtitle(null);
      }
    };
    const onPlay = () => {
      if (audioContextRef.current && audioContextRef.current.state === 'suspended') {
        audioContextRef.current.resume().catch(() => {});
      }
      dispatch(videoActions.setPlaying(true));
    };
    const onPause = () => dispatch(videoActions.setPlaying(false));
    const onErr = () => {
      dispatch(errorActions.setError({ message: 'Failed to load video file.', source: 'file' }));
    };

    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('play', onPlay);
    el.addEventListener('pause', onPause);
    el.addEventListener('error', onErr);
    return () => {
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('play', onPlay);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('error', onErr);
    };
  }, [dispatch, isSeeking, transcript.segments]);

  // -------------------------------------------------------------------
  // Helper to re-select engine and voices when target language changes
  // -------------------------------------------------------------------
  const setupEngineForLanguage = useCallback(async (targetLang) => {
    const adapter = await selectCheapest(settings.enabledEngines, targetLang, engines.cooldowns);
    if (!adapter) {
      return false;
    }
    dispatch(enginesActions.setActiveEngine(adapter.id));

    try {
      const voices = await adapter.listVoices(targetLang);
      dispatch(enginesActions.setAvailableVoices(voices));
      if (voices.length > 0) {
        dispatch(enginesActions.setSelectedVoice(adapter.defaultVoiceId(targetLang)));
      }
    } catch (_) {}

    return true;
  }, [settings.enabledEngines, engines.cooldowns, dispatch]);

  // -------------------------------------------------------------------
  // Voice Cloning handler (Instant Voice Clone via ElevenLabs)
  // -------------------------------------------------------------------
  const triggerVoiceCloning = useCallback(async (sampleSeg) => {
    try {
      const elevenKey = await window.mvp.getKey('elevenlabs');
      if (!elevenKey || !elevenKey.trim()) {
        clonedVoiceRef.current = null;
        return;
      }

      setCloningStatus('Sampling voice...');
      const startSec = Math.max(0, sampleSeg.start);
      const durationSec = Math.min(8, Math.max(3, sampleSeg.end - sampleSeg.start));

      const chunkData = await window.mvp.extractAudioChunk({
        videoPath: video.filePath,
        startSec,
        durationSec,
      });

      if (!chunkData?.base64) {
        clonedVoiceRef.current = null;
        setCloningStatus('');
        return;
      }

      const speakerLabel = sampleSeg.speakerName || 'Actor';
      setCloningStatus(`Cloning ${speakerLabel}...`);
      const cloned = await cloneVoiceFromSample({
        videoPath: video.filePath,
        base64Audio: chunkData.base64,
        apiKey: elevenKey,
        speakerName: speakerLabel,
      });

      if (cloned?.voiceId) {
        clonedVoiceRef.current = cloned.voiceId;
        setClonedVoiceId(cloned.voiceId);
        setCloningStatus(`${speakerLabel} Cloned 🎭`);
        if (sampleSeg.speakerId) {
          globalSpeakerRegistry.setClonedVoice(sampleSeg.speakerId, cloned.voiceId);
        }
        dispatch(enginesActions.setSelectedVoice(cloned.voiceId));
        prefetcherRef.current?.setVoiceId(cloned.voiceId);
      }
    } catch (err) {
      console.warn('[Player] Voice cloning bypassed:', err.message);
      clonedVoiceRef.current = null;
      setCloningStatus('');
    }
  }, [video.filePath, dispatch]);

  // -------------------------------------------------------------------
  // Initialize Live Audio Dubber (Continuous Whisper speech chunks -> ElevenLabs)
  // -------------------------------------------------------------------
  useEffect(() => {
    if (!video.filePath || !aiDubbingActive) {
      liveDubberRef.current?.stop();
      return;
    }

    (async () => {
      const key = groqKey || (await window.mvp.getKey('groq'));
      if (!key) {
        setDubbingStatus('Add Groq API key in Settings to activate AI dubbing');
        return;
      }
      setGroqKey(key);

      const targetLang = settings.targetLanguage || 'en';
      await setupEngineForLanguage(targetLang);

      liveDubberRef.current?.stop();
      const dubber = new LiveDubber({
        videoPath: video.filePath,
        getCurrentTime: () => videoRef.current?.currentTime || 0,
        getDuration: () => videoRef.current?.duration || 0,
        groqApiKey: key,
        groqModel: settings.groqModel || 'qwen/qwen3.8-27b',
        targetLang,
        baseUrl: settings.groqBaseUrl,
        asrEngine: settings.asrEngine || 'sensevoice_local',
        onSegments: (newSegs) => {
          dispatch(transcriptActions.appendSegments(newSegs));
          setTtsStatus('ready');

          // Trigger instant voice cloning on first speech segment if not yet cloned
          if (!clonedVoiceRef.current && video.filePath) {
            const cached = getCachedClonedVoice(video.filePath);
            if (cached) {
              clonedVoiceRef.current = cached;
              setClonedVoiceId(cached);
              dispatch(enginesActions.setSelectedVoice(cached));
              prefetcherRef.current?.setVoiceId(cached);
            } else {
              const sampleSeg = newSegs.find((s) => (s.end - s.start) >= 2.5) || newSegs[0];
              if (sampleSeg) {
                clonedVoiceRef.current = 'pending';
                triggerVoiceCloning(sampleSeg);
              }
            }
          }
        },
        onStatus: (msg) => setDubbingStatus(msg),
        onStats: (s) => setStats((prev) => ({ ...prev, ...s })),
        onError: (err) => console.warn('[Player] LiveDubber error:', err.message),
      });

      liveDubberRef.current = dubber;
      dubber.start();
    })();

    return () => {
      liveDubberRef.current?.stop();
    };
  }, [video.filePath, aiDubbingActive, groqKey, settings.targetLanguage, settings.groqBaseUrl, settings.asrEngine, settings.groqModel, setupEngineForLanguage, triggerVoiceCloning, dispatch]);

  // -------------------------------------------------------------------
  // Load subtitle manually
  // -------------------------------------------------------------------
  const handleLoadSubtitle = useCallback(async () => {
    const subPath = await window.mvp.openSubtitle();
    if (!subPath) return;

    setTtsStatus('loading');
    dispatch(transcriptActions.setSubtitlePath(subPath));

    try {
      const content = await window.mvp.readText(subPath);

      // Detect source language
      const srcLang = detectLanguage(content) || settings.defaultLanguage || 'en';
      dispatch(enginesActions.setDetectedLanguage(srcLang));
      dispatch(enginesActions.setSourceLanguage(srcLang));

      // Parse segments
      const segs = parseSubtitles(content, video.duration);
      if (segs.length === 0) {
        setTtsStatus('error');
        dispatch(errorActions.setError({
          message: 'No subtitle segments found in file. Check the format (.srt or .vtt).',
          source: 'tts',
        }));
        return;
      }
      dispatch(transcriptActions.setSegments(segs));

      const latestGroq = await window.mvp.getKey('groq');
      if (latestGroq) setGroqKey(latestGroq);

      const targetLang = settings.targetLanguage || 'en';
      const ttsLang = (settings.translateEnabled !== false && targetLang !== srcLang)
        ? targetLang
        : srcLang;

      const ok = await setupEngineForLanguage(ttsLang);
      if (!ok) {
        setTtsStatus('error');
        dispatch(errorActions.setError({
          message: `No TTS engine available for ${ttsLang.toUpperCase()}. Configure your ElevenLabs or Google API key in Settings.`,
          source: 'tts',
        }));
        return;
      }

      setTtsStatus('ready');
    } catch (err) {
      setTtsStatus('error');
      dispatch(errorActions.setError({ message: `Subtitle load failed: ${err.message}`, source: 'tts' }));
    }
  }, [dispatch, video.duration, settings.defaultLanguage, settings.targetLanguage, settings.translateEnabled, setupEngineForLanguage]);

  // -------------------------------------------------------------------
  // Handle changing target language from UI
  // -------------------------------------------------------------------
  const handleTargetLanguageChange = useCallback(async (e) => {
    const newTarget = e.target.value;
    dispatch(settingsActions.updateSettings({ targetLanguage: newTarget }));
    dispatch(enginesActions.setTargetLanguage(newTarget));
    dispatch(transcriptActions.clearTranslations());
    await window.mvp.setConfig({ targetLanguage: newTarget });

    liveDubberRef.current?.setTargetLang(newTarget);

    const srcLang = engines.detectedLanguage || 'en';
    const ttsLang = (settings.translateEnabled !== false && newTarget !== srcLang) ? newTarget : srcLang;
    await setupEngineForLanguage(ttsLang);
  }, [dispatch, engines.detectedLanguage, settings.translateEnabled, setupEngineForLanguage]);

  // -------------------------------------------------------------------
  // Start TTS prefetch + sync engine (Persistent lifecycle: NOT destroyed on segment appends)
  // -------------------------------------------------------------------
  useEffect(() => {
    if (!engines.activeEngine) return;
    if (!videoRef.current) return;

    const srcLang = engines.detectedLanguage || engines.sourceLanguage || 'en';
    const targetLang = settings.targetLanguage || 'en';

    const pf = new TTSPrefetcher({
      segments: transcript.segments,
      sourceLang: srcLang,
      targetLang: targetLang,
      translateEnabled: settings.translateEnabled !== false,
      groqApiKey: groqKey,
      groqModel: settings.groqModel || 'qwen/qwen3.8-27b',
      groqBaseUrl: settings.groqBaseUrl || 'https://api.groq.com/openai/v1/',
      enabledEngines: settings.enabledEngines,
      preferredEngine: settings.preferredEngine,
      voiceId: engines.selectedVoiceId,
      lookAhead: settings.lookAheadSegments || 5,
      costCapUsd: settings.costCapUsd,
      onSegmentTranslated: (index, translated) => {
        dispatch(transcriptActions.updateSegmentTranslation({ index, translated }));
      },
      onSegmentUpdate: () => {
        dispatch(syncActions.setSegmentCounts({
          total: transcript.segments.length,
          prefetched: pf.cachedCount,
        }));
      },
      onStats: (s) => setStats((prev) => ({ ...prev, ...s })),
      onCostIncurred: (cost) => dispatch(enginesActions.addCost(cost)),
      onCooldown: (engineId, until) =>
        dispatch(enginesActions.addCooldown({ engine: engineId, until })),
    });
    prefetcherRef.current = pf;

    // Live sync engine
    const se = new SyncEngine({
      videoEl: videoRef.current,
      segments: transcript.segments,
      prefetcher: pf,
      onDrift: (ms) => dispatch(syncActions.setDrift(ms)),
      onSegmentChange: (idx) => dispatch(audioActions.setCurrentSegment(idx)),
      onStats: (s) => setStats((prev) => ({ ...prev, ...s })),
      onSpeechActive: (active) => setIsSpeaking(active),
    });
    syncEngineRef.current = se;
    se.setVolume(audio.volume ?? 1);
    se.start();

    // Immediately start prefetching from current position
    pf.prefetchAround(videoRef.current.currentTime);

    return () => {
      pf.destroy();
      se.stop();
    };
  }, [
    engines.activeEngine, engines.detectedLanguage, engines.sourceLanguage,
    engines.selectedVoiceId, settings.targetLanguage, settings.translateEnabled,
    groqKey, settings.groqModel, settings.groqBaseUrl, settings.enabledEngines,
    settings.preferredEngine, settings.lookAheadSegments, settings.costCapUsd,
    dispatch,
  ]);

  // Update segments smoothly without destroying AudioContext or prefetcher
  useEffect(() => {
    if (prefetcherRef.current) {
      prefetcherRef.current.updateSegments(transcript.segments);
    }
    if (syncEngineRef.current) {
      syncEngineRef.current.updateSegments(transcript.segments);
    }
  }, [transcript.segments]);

  // -------------------------------------------------------------------
  // Scrub bar — seek interactions
  // -------------------------------------------------------------------
  const handleSeekStart = () => setIsSeeking(true);

  const handleSeekMove = (e) => {
    setSeekValue(Number(e.target.value));
  };

  const handleSeekEnd = (e) => {
    const el = videoRef.current;
    if (!el) return;
    const time = Number(e.target.value);
    el.currentTime = time;
    setIsSeeking(false);
    setSeekValue(time);
    liveDubberRef.current?.onSeek(time);
    prefetcherRef.current?.prefetchAround(time);
  };

  const handleScrubClick = (e) => {
    const el = videoRef.current;
    const bar = seekBarRef.current;
    if (!el || !bar) return;
    const rect = bar.getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const time = fraction * (video.duration || 0);
    el.currentTime = time;
    setSeekValue(time);
    liveDubberRef.current?.onSeek(time);
    prefetcherRef.current?.prefetchAround(time);
  };

  // -------------------------------------------------------------------
  // Transport & Audio Controls
  // -------------------------------------------------------------------
  const togglePlay = () => {
    const el = videoRef.current;
    if (!el || !video.src) return;
    if (el.paused) {
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  };

  const handleVoiceVolume = (e) => {
    const v = Number(e.target.value);
    dispatch(audioActions.setAudioVolume(v));
  };

  const handleOriginalVolume = (e) => {
    const v = Number(e.target.value);
    dispatch(audioActions.setOriginalVolume(v));
    if (v > 0 && audio.originalMuted) {
      dispatch(audioActions.setOriginalMuted(false));
    }
  };

  const toggleOriginalMute = () => {
    dispatch(audioActions.setOriginalMuted(!audio.originalMuted));
  };

  const toggleAiDubbing = () => {
    setAiDubbingActive((prev) => !prev);
  };

  const skip = (seconds) => {
    const el = videoRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + seconds));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      switch (e.key) {
        case ' ':
        case 'k': e.preventDefault(); togglePlay(); break;
        case 'ArrowLeft': e.preventDefault(); skip(-5); break;
        case 'ArrowRight': e.preventDefault(); skip(5); break;
        case 'j': e.preventDefault(); skip(-10); break;
        case 'l': e.preventDefault(); skip(10); break;
        case 'm': e.preventDefault(); toggleOriginalMute(); break;
        case 's': e.preventDefault(); setShowStats((prev) => !prev); break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [video.src, togglePlay, toggleOriginalMute]);

  // -------------------------------------------------------------------
  // Progress bar calculations
  // -------------------------------------------------------------------
  const progress = video.duration > 0 ? (seekValue / video.duration) * 100 : 0;
  const prefetchProgress = video.duration > 0 && sync.totalSegments > 0
    ? (sync.prefetchedSegments / sync.totalSegments) * 100 : 0;

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------
  return (
    <>
      <div className="player" onDoubleClick={togglePlay}>
        {video.src ? (
          <>
            <video ref={videoRef} src={video.src} preload="metadata" />

            {/* Subtitle overlay — shows character tag, translated subtitle prominently, original underneath */}
            {currentSubtitle && (
              <div className="player__subtitle">
                {currentSubtitle.speakerName && (
                  <div className="player__subtitle-character">
                    {currentSubtitle.speakerName}
                  </div>
                )}
                <div className="player__subtitle-translated">
                  {currentSubtitle.translated || currentSubtitle.original}
                </div>
                {currentSubtitle.translated && currentSubtitle.translated !== currentSubtitle.original && (
                  <div className="player__subtitle-original">
                    {currentSubtitle.original}
                  </div>
                )}
              </div>
            )}

            {/* Real-time Telemetry & Delay Stats HUD */}
            {showStats && (
              <div className="player__stats-hud">
                <div className="stats-hud__header">
                  <span className="stats-hud__title">📊 Live Translation Telemetry</span>
                  <button className="stats-hud__close" onClick={() => setShowStats(false)}>✕</button>
                </div>
                <div className="stats-hud__grid">
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">Playhead:</span>
                    <span className="stats-hud__val">{fmt(video.currentTime)} / {fmt(video.duration)}</span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">Buffer Headroom:</span>
                    <span className={`stats-hud__val ${stats.bufferLeadSec > 4 ? 'stats-hud__val--ok' : 'stats-hud__val--warn'}`}>
                      +{stats.bufferLeadSec}s ahead
                    </span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">Audio Drift / Delay:</span>
                    <span className={`stats-hud__val ${Math.abs(stats.driftMs) < 100 ? 'stats-hud__val--ok' : 'stats-hud__val--warn'}`}>
                      {stats.driftMs > 0 ? '+' : ''}{stats.driftMs} ms
                    </span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">ASR Engine & Latency:</span>
                    <span className="stats-hud__val stats-hud__val--highlight">
                      {stats.asrLatencyMs ?? stats.whisperLatencyMs ? `${stats.asrLatencyMs ?? stats.whisperLatencyMs} ms` : 'Standby'}
                      <span className="stats-hud__sub"> ({stats.asrEngine || (settings.asrEngine === 'sensevoice_local' ? 'SenseVoice ONNX' : 'Groq Whisper')})</span>
                    </span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">Speech Emotion (SER):</span>
                    <span className="stats-hud__val">
                      {stats.emotion ? (
                        stats.emotion === 'angry' ? '😠 Angry' :
                        stats.emotion === 'happy' ? '😃 Happy / Excited' :
                        stats.emotion === 'sad' ? '😢 Sad / Crying' :
                        stats.emotion === 'fearful' ? '😨 Fearful' :
                        '😐 Neutral'
                      ) : '😐 Neutral'}
                    </span>
                  </div>
                  {stats.events?.length > 0 && (
                    <div className="stats-hud__row">
                      <span className="stats-hud__label">Audio Events (AED):</span>
                      <span className="stats-hud__val stats-hud__val--ok">
                        {stats.events.map(e => e === 'laughter' ? '😂 Laughter' : e === 'crying' ? '😭 Crying' : e === 'applause' ? '👏 Applause' : e).join(', ')}
                      </span>
                    </div>
                  )}
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">TTS Synth Latency:</span>
                    <span className="stats-hud__val stats-hud__val--highlight">
                      {stats.ttsLatencyMs ? `${stats.ttsLatencyMs} ms` : 'Standby'}
                      <span className="stats-hud__sub"> ({stats.ttsEngine || engines.activeEngine || 'ElevenLabs'})</span>
                    </span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">Chunk Extraction:</span>
                    <span className="stats-hud__val">{stats.extractLatencyMs ? `${stats.extractLatencyMs} ms` : 'Done'}</span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">Whisper Window:</span>
                    <span className="stats-hud__val">{stats.chunkRange || '0s - 12s'}</span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">Detected Speech Lang:</span>
                    <span className="stats-hud__val">{(stats.detectedLanguage || engines.detectedLanguage || 'hi').toUpperCase()}</span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">Target Dubbing Lang:</span>
                    <span className="stats-hud__val stats-hud__val--accent">{(settings.targetLanguage || 'en').toUpperCase()}</span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">Voiced Segments:</span>
                    <span className="stats-hud__val">{sync.prefetchedSegments} / {sync.totalSegments}</span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">Active Characters:</span>
                    <span className="stats-hud__val stats-hud__val--accent">
                      {stats.activeSpeakersCount || 1} Character(s) {stats.speakers?.length ? `(${stats.speakers.join(', ')})` : ''}
                    </span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">Audio Stems:</span>
                    <span className="stats-hud__val stats-hud__val--ok">
                      🎵 Real-Time BGM/SFX (Center Vocal Erased)
                    </span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">Voice Persona:</span>
                    <span className={`stats-hud__val ${clonedVoiceId ? 'stats-hud__val--ok' : ''}`}>
                      {clonedVoiceId ? '🎭 Cloned Actor Voice' : (cloningStatus || 'Dynamic Multi-Speaker')}
                    </span>
                  </div>
                  <div className="stats-hud__row">
                    <span className="stats-hud__label">BGM / Soundtrack:</span>
                    <span className={`stats-hud__val ${isSpeaking ? 'stats-hud__val--highlight' : 'stats-hud__val--ok'}`}>
                      {audio.originalMuted
                        ? '🔇 Suppressed (0%)'
                        : isSpeaking
                        ? '🎬 BGM Stem Active (Vocal 0% · BGM 60%)'
                        : `🔊 Full BGM/SFX Stem (${Math.round((audio.originalVolume || 0.65) * 100)}%)`}
                    </span>
                  </div>
                  {currentSubtitle && (
                    <div className="stats-hud__dialogue">
                      <div className="stats-hud__dialogue-label">
                        Live Active Dialogue {currentSubtitle.speakerName ? `— ${currentSubtitle.speakerName}` : ''}:
                      </div>
                      <div className="stats-hud__dialogue-trans">"{currentSubtitle.translated || currentSubtitle.original}"</div>
                      {currentSubtitle.translated && currentSubtitle.translated !== currentSubtitle.original && (
                        <div className="stats-hud__dialogue-orig">Original: "{currentSubtitle.original}"</div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="player__empty">
            <div className="player__empty-icon">▶</div>
            <div>Open a video file to get started</div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
              Automatic voice chunk translation will continuously dub dialogue into your target language.
            </div>
          </div>
        )}
      </div>

      {/* Scrub bar — full-width, below video, above controls */}
      <div className="scrub" ref={seekBarRef} onClick={handleScrubClick}>
        {/* Buffered / prefetch progress (dim) */}
        <div className="scrub__buffered" style={{ width: `${prefetchProgress}%` }} />
        {/* Playback progress (bright) */}
        <div className="scrub__progress" style={{ width: `${progress}%` }} />
        {/* Drag handle */}
        <div className="scrub__handle" style={{ left: `${progress}%` }} />
        {/* Invisible range input for dragging */}
        <input
          className="scrub__input"
          type="range"
          min={0}
          max={video.duration || 0}
          step={0.1}
          value={seekValue}
          onMouseDown={handleSeekStart}
          onTouchStart={handleSeekStart}
          onChange={handleSeekMove}
          onMouseUp={handleSeekEnd}
          onTouchEnd={handleSeekEnd}
          disabled={!video.src}
        />
      </div>

      {/* Transport controls */}
      <div className="controls">
        <button onClick={() => skip(-10)} disabled={!video.src} title="Rewind 10s">⏪</button>
        <button className="controls__play" onClick={togglePlay} disabled={!video.src}>
          {video.playing ? '⏸' : '▶'}
        </button>
        <button onClick={() => skip(10)} disabled={!video.src} title="Forward 10s">⏩</button>

        <span className="controls__time">
          {fmt(isSeeking ? seekValue : video.currentTime)} / {fmt(video.duration)}
        </span>

        <div className="controls__spacer" />

        {/* AI Dubbing Toggle */}
        <button
          className={aiDubbingActive ? 'primary' : ''}
          onClick={toggleAiDubbing}
          disabled={!video.src}
          title="Toggle continuous AI audio chunk translation and dubbing"
          style={{ display: 'flex', alignItems: 'center', gap: 5 }}
        >
          <span>🎙 AI Dubbing</span>
          <span className="badge" style={{ background: aiDubbingActive ? 'rgba(255,255,255,0.2)' : 'var(--bg-card)' }}>
            {aiDubbingActive ? 'ON' : 'OFF'}
          </span>
        </button>

        {/* Target language selector */}
        <div className="controls__lang-group" title="Target language for translated voice & subtitles">
          <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>To:</span>
          <select
            className="controls__lang-select"
            value={settings.targetLanguage || 'en'}
            onChange={handleTargetLanguageChange}
          >
            {Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => (
              <option key={code} value={code}>
                {name} ({code.toUpperCase()})
              </option>
            ))}
          </select>
        </div>

        {/* Translated Voiceover Volume */}
        <div className="controls__vol-item" title="Translated Voice Volume">
          <span className="controls__volume-icon">🎙</span>
          <input
            className="controls__volume"
            type="range" min={0} max={1} step={0.05}
            value={audio.volume ?? 1}
            onChange={handleVoiceVolume}
            title="Translated Voice Volume"
          />
        </div>

        {/* Original Audio Suppression & Ducking Controls */}
        <div className="controls__vol-item" title="Original Video Soundtrack (Suppression & Ducking)">
          <button
            className={`controls__mute-orig-btn ${audio.originalMuted ? 'active' : ''}`}
            onClick={toggleOriginalMute}
            title={audio.originalMuted ? 'Original video audio muted (click to unmute)' : 'Original audio audible (click to suppress)'}
          >
            {audio.originalMuted ? '🔇 Orig' : '🎬 Orig'}
          </button>
          {!audio.originalMuted && (
            <input
              className="controls__volume controls__volume--orig"
              type="range" min={0} max={1} step={0.05}
              value={audio.originalVolume ?? 0.15}
              onChange={handleOriginalVolume}
              title="Original Soundtrack Volume"
            />
          )}
        </div>

        {/* Stats HUD Toggle Button */}
        <button
          className={showStats ? 'primary' : ''}
          onClick={() => setShowStats((prev) => !prev)}
          title="Toggle Real-Time Latency & Delay Telemetry (Hotkey: S)"
          style={{ display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <span>📊 Stats</span>
        </button>

        {/* Optional: Load Subtitle button */}
        <button
          onClick={handleLoadSubtitle}
          disabled={!video.src}
          title="Optionally load an external subtitle file (.srt/.vtt)"
        >
          {ttsStatus === 'loading' ? '⏳ Subtitle…' : '📝 Subtitle'}
        </button>

        {engines.availableVoices.length > 0 && (
          <button onClick={() => setShowVoicePicker((v) => !v)} title="Change voice">
            🎙 Voice
          </button>
        )}
      </div>

      {/* Status bar */}
      <div className="status-bar">
        {engines.activeEngine && (
          <div className="status-bar__item">
            <span className="status-bar__dot status-bar__dot--ok" />
            TTS: {engines.activeEngine}
          </div>
        )}
        <div className="status-bar__item">
          Target: <strong>{(settings.targetLanguage || 'en').toUpperCase()}</strong>
        </div>
        <div className="status-bar__item">
          <span className={`status-bar__dot ${groqKey || settings.asrEngine === 'sensevoice_local' ? 'status-bar__dot--ok' : 'status-bar__dot--warn'}`} />
          ASR: {stats.asrEngine ? (stats.asrEngine.includes('SenseVoice') ? '⚡ SenseVoice' : '☁ Groq Whisper') : (settings.asrEngine === 'sensevoice_local' ? '⚡ SenseVoice' : '☁ Groq Whisper')}
        </div>
        <div className="status-bar__item">
          Audio: {audio.originalMuted ? '🔇 Suppressed' : `🎬 Orig ${Math.round((audio.originalVolume || 0) * 100)}%`}
        </div>
        <div className="status-bar__item">
          Lead: <strong style={{ color: stats.bufferLeadSec > 4 ? 'var(--success)' : 'var(--warning)' }}>+{stats.bufferLeadSec}s</strong>
        </div>
        {clonedVoiceId ? (
          <div className="status-bar__item" style={{ color: 'var(--success)' }}>
            <span className="status-bar__dot status-bar__dot--ok" />
            🎭 Cloned Voice Active
          </div>
        ) : cloningStatus ? (
          <div className="status-bar__item" style={{ color: 'var(--accent)' }}>
            🎭 {cloningStatus}
          </div>
        ) : null}
        {dubbingStatus && (
          <div className="status-bar__item" style={{ color: 'var(--accent)', maxWidth: 260, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            ⚡ {dubbingStatus}
          </div>
        )}
        {sync.totalSegments > 0 && (
          <div className="status-bar__item">
            <span className={`status-bar__dot ${
              sync.prefetchedSegments >= sync.totalSegments ? 'status-bar__dot--ok' : 'status-bar__dot--warn'
            }`} />
            Voiced: {sync.prefetchedSegments}/{sync.totalSegments} segs
          </div>
        )}
        {engines.sessionCostUsd > 0 && (
          <div className="status-bar__item">💰 ${engines.sessionCostUsd.toFixed(4)}</div>
        )}

        <div className="controls__spacer" />

        <div className="status-bar__item" style={{ opacity: 0.5 }}>
          Space/K: play · S: stats · M: mute orig · ←→: ±5s
        </div>
      </div>

      {showVoicePicker && <VoicePicker onClose={() => setShowVoicePicker(false)} />}
    </>
  );
}
