import React from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { enginesActions } from '../store.js';

export default function VoicePicker({ onClose }) {
  const dispatch = useDispatch();
  const voices = useSelector((s) => s.engines.availableVoices);
  const selectedId = useSelector((s) => s.engines.selectedVoiceId);
  const activeEngine = useSelector((s) => s.engines.activeEngine);

  const handleSelect = (voiceId) => {
    dispatch(enginesActions.setSelectedVoice(voiceId));
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="settings" style={{ width: 400 }} onClick={(e) => e.stopPropagation()}>
        <h2>
          Select Voice
          {activeEngine && (
            <span className="badge badge--accent" style={{ marginLeft: 8 }}>
              {activeEngine}
            </span>
          )}
        </h2>

        {voices.length === 0 ? (
          <p style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 12 }}>
            No voices loaded. Load a subtitle file first so the language can be detected,
            then voices will appear here.
          </p>
        ) : (
          <div className="voice-picker">
            {voices.map((v) => (
              <div
                key={v.id}
                className={`voice-picker__item ${v.id === selectedId ? 'voice-picker__item--active' : ''}`}
                onClick={() => handleSelect(v.id)}
              >
                <strong>{v.name}</strong>
                <span style={{ marginLeft: 8, fontSize: 11, opacity: 0.6 }}>
                  {v.language} · {v.id.slice(0, 12)}…
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="settings__actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
