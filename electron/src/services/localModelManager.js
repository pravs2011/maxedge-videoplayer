// LocalModelManager: Manages local on-device ASR models (SenseVoice)
// and handles download tracking and status checks via Electron IPC.

export async function checkLocalSenseVoice() {
  if (!window.mvp?.checkSenseVoiceModel) {
    return { ready: false, error: 'IPC bridge not available' };
  }
  try {
    return await window.mvp.checkSenseVoiceModel();
  } catch (err) {
    return { ready: false, error: err.message };
  }
}

export async function downloadSenseVoice(onProgress) {
  if (!window.mvp?.downloadSenseVoiceModel) {
    throw new Error('IPC bridge not available');
  }

  let cleanup = null;
  if (onProgress && window.mvp.onSenseVoiceProgress) {
    cleanup = window.mvp.onSenseVoiceProgress((data) => {
      onProgress(data);
    });
  }

  try {
    const res = await window.mvp.downloadSenseVoiceModel();
    if (!res.ok) {
      throw new Error(res.error || 'Failed to download SenseVoice model.');
    }
    return res;
  } finally {
    if (cleanup) cleanup();
  }
}

export default {
  checkLocalSenseVoice,
  downloadSenseVoice,
};
