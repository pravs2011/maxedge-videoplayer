import React, { useState, useEffect, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { settingsActions } from '../store.js';
import { SUPPORTED_LANGUAGES } from '../services/translator.js';
import { checkLocalSenseVoice, downloadSenseVoice } from '../services/localModelManager.js';

export default function Settings({ onClose }) {
  const dispatch = useDispatch();
  const settings = useSelector((s) => s.settings);
  const engines = useSelector((s) => s.engines);

  // Local form state
  const [form, setForm] = useState({
    preferredEngine: settings.preferredEngine || 'auto',
    syncMode: settings.syncMode || 'live',
    defaultLanguage: settings.defaultLanguage || 'en',
    targetLanguage: settings.targetLanguage || 'en',
    translateEnabled: settings.translateEnabled !== false,
    asrEngine: settings.asrEngine || 'sensevoice_local',
    groqModel: settings.groqModel || 'qwen/qwen3.8-27b',
    groqBaseUrl: settings.groqBaseUrl || 'https://api.groq.com/openai/v1/',
    bufferSeconds: settings.bufferSeconds ?? 5,
    lookAheadSegments: settings.lookAheadSegments ?? 3,
    costCapUsd: settings.costCapUsd ?? 2.0,
    retryAttempts: settings.retryAttempts ?? 3,
  });

  const [keys, setKeys] = useState({ elevenlabs: '', google: '', groq: '' });

  // SenseVoice model states
  const [modelStatus, setModelStatus] = useState({ ready: false, checking: true, error: null });
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadStage, setDownloadStage] = useState('');

  // Check SenseVoice model on mount
  useEffect(() => {
    let mounted = true;
    checkLocalSenseVoice().then((res) => {
      if (mounted) {
        setModelStatus({ ready: !!res.ready, checking: false, error: res.error || null });
      }
    });
    return () => { mounted = false; };
  }, []);

  const handleDownloadModel = async () => {
    setDownloading(true);
    setDownloadProgress(0);
    setDownloadStage('Starting download...');
    try {
      await downloadSenseVoice((prog) => {
        if (prog.percent !== undefined) setDownloadProgress(prog.percent);
        if (prog.file) setDownloadStage(`Downloading ${prog.file}...`);
        if (prog.status === 'ready') setDownloadStage('Model ready!');
      });
      const check = await checkLocalSenseVoice();
      setModelStatus({ ready: !!check.ready, checking: false, error: null });
    } catch (err) {
      setModelStatus((prev) => ({ ...prev, error: err.message }));
    } finally {
      setDownloading(false);
    }
  };

  // Load stored keys on mount
  useEffect(() => {
    (async () => {
      const el = await window.mvp.getKey('elevenlabs');
      const go = await window.mvp.getKey('google');
      const gq = await window.mvp.getKey('groq');
      setKeys({ elevenlabs: el || '', google: go || '', groq: gq || '' });
    })();
  }, []);

  const handleChange = (field) => (e) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const handleCheckbox = (field) => (e) =>
    setForm((f) => ({ ...f, [field]: e.target.checked }));

  const handleNumber = (field) => (e) =>
    setForm((f) => ({ ...f, [field]: Number(e.target.value) }));

  const handleKeySave = useCallback(async () => {
    // Persist keys to OS keychain
    await window.mvp.setKey('elevenlabs', keys.elevenlabs);
    await window.mvp.setKey('google', keys.google);
    await window.mvp.setKey('groq', keys.groq);

    // Persist settings
    const updated = {
      ...form,
      enabledEngines: [
        ...(keys.elevenlabs ? ['elevenlabs'] : []),
        ...(keys.google ? ['google'] : []),
      ],
    };
    dispatch(settingsActions.updateSettings(updated));
    await window.mvp.setConfig(updated);
    onClose();
  }, [dispatch, form, keys, onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="settings" onClick={(e) => e.stopPropagation()}>
        <h2>Settings</h2>

        {/* --- AI Speech Recognition & Translation Section --- */}
        <div className="settings__section">
          <h3 style={{ fontSize: 14, color: 'var(--accent)', marginTop: 12, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span>⚡ AI Speech Recognition (ASR) & Translation</span>
          </h3>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginTop: 8, marginBottom: 12 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={form.translateEnabled}
              onChange={handleCheckbox('translateEnabled')}
            />
            <span style={{ color: 'var(--text)', fontSize: 13, fontWeight: 500 }}>
              Enable AI Subtitle & Voice Translation
            </span>
          </label>

          <label>Speech Recognition (ASR) Engine</label>
          <select value={form.asrEngine} onChange={handleChange('asrEngine')}>
            <option value="sensevoice_local">⚡ SenseVoice Local (On-Device, ~60ms, Emotion-Aware)</option>
            <option value="groq_whisper">☁ Groq Whisper Large v3 (Cloud, ~450ms)</option>
          </select>

          {form.asrEngine === 'sensevoice_local' && (
            <div className="settings__model-card">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                <span style={{ fontWeight: 600, fontSize: 13, color: modelStatus.ready ? 'var(--success)' : 'var(--warning)' }}>
                  {modelStatus.checking
                    ? 'Checking SenseVoice model...'
                    : modelStatus.ready
                    ? '✅ SenseVoice Model Ready'
                    : '⚠️ SenseVoice Model Not Downloaded'}
                </span>
                {modelStatus.ready && (
                  <span className="badge" style={{ background: 'rgba(86, 211, 100, 0.15)', color: '#56d364', fontSize: 11, padding: '2px 8px' }}>
                    ON-DEVICE INT8
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.4, marginBottom: 8 }}>
                {modelStatus.ready
                  ? 'Model files (model.int8.onnx & tokens.txt) are installed. Transcribes audio in ~60ms locally with SER emotion tags and audio events.'
                  : 'Requires ~140 MB one-time download. Enables sub-70ms real-time local transcription without sending speech to third-party clouds.'}
              </div>

              {downloading ? (
                <div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-dim)', marginBottom: 4 }}>
                    <span>{downloadStage || 'Downloading...'}</span>
                    <span>{downloadProgress}%</span>
                  </div>
                  <div className="settings__progress-bar">
                    <div className="settings__progress-fill" style={{ width: `${downloadProgress}%` }} />
                  </div>
                </div>
              ) : !modelStatus.ready ? (
                <button
                  type="button"
                  className="primary"
                  onClick={handleDownloadModel}
                  style={{ width: '100%', fontSize: 12, padding: '6px 12px', marginTop: 4 }}
                >
                  📥 Download SenseVoice Model (~140 MB)
                </button>
              ) : null}

              {modelStatus.error && (
                <div style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>
                  {modelStatus.error}
                </div>
              )}
            </div>
          )}

          <label style={{ marginTop: 12 }}>Target Language (Translate To)</label>
          <select value={form.targetLanguage} onChange={handleChange('targetLanguage')}>
            {Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => (
              <option key={code} value={code}>
                {name} ({code.toUpperCase()})
              </option>
            ))}
          </select>

          <label>Groq API Key</label>
          <input
            type="password"
            value={keys.groq}
            onChange={(e) => setKeys((k) => ({ ...k, groq: e.target.value }))}
            placeholder="gsk_..."
          />
          <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 3 }}>
            Groq provides ultra-fast LLM inference for live subtitle & voice translation (and cloud Whisper fallback).
          </div>

          <label>Groq Model</label>
          <input
            type="text"
            value={form.groqModel}
            onChange={handleChange('groqModel')}
            placeholder="qwen/qwen3.8-27b"
          />

          <label>Groq Base URL</label>
          <input
            type="text"
            value={form.groqBaseUrl}
            onChange={handleChange('groqBaseUrl')}
            placeholder="https://api.groq.com/openai/v1/"
          />
        </div>

        {/* --- Text-to-Speech Engines Section --- */}
        <div className="settings__section" style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <h3 style={{ fontSize: 14, color: 'var(--accent)', marginBottom: 8 }}>
            🎙 TTS Audio Engines (VoiceBox)
          </h3>

          <label>ElevenLabs API Key</label>
          <input
            type="password"
            value={keys.elevenlabs}
            onChange={(e) => setKeys((k) => ({ ...k, elevenlabs: e.target.value }))}
            placeholder="xi-..."
          />

          <label>Google Cloud TTS API Key</label>
          <input
            type="password"
            value={keys.google}
            onChange={(e) => setKeys((k) => ({ ...k, google: e.target.value }))}
            placeholder="AIza..."
          />

          <label>Preferred TTS Engine</label>
          <select value={form.preferredEngine} onChange={handleChange('preferredEngine')}>
            <option value="auto">Auto (cheapest available)</option>
            <option value="elevenlabs">ElevenLabs</option>
            <option value="google">Google Cloud TTS</option>
          </select>
        </div>

        {/* --- Playback & Buffering Section --- */}
        <div className="settings__section" style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <h3 style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 8 }}>
            ⚙ Playback & Synchronization
          </h3>

          <label>Sync Mode</label>
          <select value={form.syncMode} onChange={handleChange('syncMode')}>
            <option value="live">Live (recommended for large files)</option>
            <option value="reencode">Re‑encode (offline merge)</option>
          </select>

          <label>Default Source Language (Fallback if detection fails)</label>
          <select value={form.defaultLanguage} onChange={handleChange('defaultLanguage')}>
            {Object.entries(SUPPORTED_LANGUAGES).map(([code, name]) => (
              <option key={code} value={code}>
                {name} ({code.toUpperCase()})
              </option>
            ))}
          </select>

          <label>Buffer Seconds: {form.bufferSeconds}</label>
          <input
            type="range" min={1} max={15} step={1}
            value={form.bufferSeconds}
            onChange={handleNumber('bufferSeconds')}
          />

          <label>Look-Ahead Segments: {form.lookAheadSegments}</label>
          <input
            type="range" min={1} max={10} step={1}
            value={form.lookAheadSegments}
            onChange={handleNumber('lookAheadSegments')}
          />

          <label>Cost Cap (USD per session): ${form.costCapUsd}</label>
          <input
            type="range" min={0.5} max={20} step={0.5}
            value={form.costCapUsd}
            onChange={handleNumber('costCapUsd')}
          />

          <label>Retry Attempts: {form.retryAttempts}</label>
          <input
            type="range" min={0} max={10} step={1}
            value={form.retryAttempts}
            onChange={handleNumber('retryAttempts')}
          />
        </div>

        {/* Session cost */}
        {engines.sessionCostUsd > 0 && (
          <p style={{ marginTop: 16, fontSize: 12, color: 'var(--text-dim)' }}>
            Session cost so far: <strong>${engines.sessionCostUsd.toFixed(4)}</strong>
          </p>
        )}

        {/* Actions */}
        <div className="settings__actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={handleKeySave}>Save</button>
        </div>
      </div>
    </div>
  );
}
