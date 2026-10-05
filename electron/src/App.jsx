import React, { useEffect, useState, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { settingsActions, errorActions } from './store.js';
import Player from './components/Player.jsx';
import Settings from './components/Settings.jsx';

export default function App() {
  const dispatch = useDispatch();
  const error = useSelector((s) => s.errors.message);
  const settingsLoaded = useSelector((s) => s.settings.loaded);
  const [showSettings, setShowSettings] = useState(false);

  // Load persisted settings on mount
  useEffect(() => {
    (async () => {
      const cfg = await window.mvp.getConfig();
      if (cfg) dispatch(settingsActions.loadSettings(cfg));
      else dispatch(settingsActions.loadSettings({}));
    })();
  }, [dispatch]);

  // Auto-dismiss error toast after 6 s
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => dispatch(errorActions.clearError()), 6000);
    return () => clearTimeout(id);
  }, [error, dispatch]);

  const handleOpenVideo = useCallback(async () => {
    const result = await window.mvp.openVideo();
    if (!result) return;
    // Player component will pick this up via a custom event
    window.dispatchEvent(new CustomEvent('mvp:open-video', { detail: result }));
  }, []);

  // Listen for "open video" trigger from Player's empty-state button
  useEffect(() => {
    const handler = () => handleOpenVideo();
    window.addEventListener('mvp:trigger-open', handler);
    return () => window.removeEventListener('mvp:trigger-open', handler);
  }, [handleOpenVideo]);

  if (!settingsLoaded) return null; // wait for hydration

  return (
    <div className="app">
      {/* Header */}
      <header className="app__header">
        <span className="app__title">MAXEDGE VIDEO PLAYER</span>
        <div className="flex-gap">
          <button onClick={handleOpenVideo}>Open Video</button>
          <button onClick={() => setShowSettings(true)}>⚙ Settings</button>
        </div>
      </header>

      {/* Main content */}
      <div className="app__body">
        <Player />

        {/* Error toast */}
        {error && (
          <div className="error-toast" onClick={() => dispatch(errorActions.clearError())}>
            {error}
          </div>
        )}
      </div>

      {/* Settings overlay */}
      {showSettings && <Settings onClose={() => setShowSettings(false)} />}
    </div>
  );
}
