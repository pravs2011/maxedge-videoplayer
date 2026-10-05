// Electron main process — window, mvp:// byte-range protocol, keychain, IPC, FFmpeg.
const { app, BrowserWindow, protocol, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const https = require('https');
const http = require('http');
const { spawn, execFile } = require('child_process');

const VIDEO_EXT = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.ogv']);

let mainWindow = null;
let ffmpegPath = null;

// ---------------------------------------------------------------------------
// Custom privileged protocol: mvp://local/<absolute-path>
// Streams local files with HTTP Range support so 3-4 GB videos are never
// loaded into memory — only the byte window the <video> element asks for.
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  { scheme: 'mvp', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

function mimeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm',
    '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo',
    '.ogv': 'video/ogg'
  }[ext] || 'application/octet-stream';
}

function parseRangeHeader(rangeHeader, size) {
  // "bytes=start-end" | "bytes=start-" | "bytes=-suffix"
  const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader || '');
  if (!m) return null;
  let start = m[1] === '' ? null : parseInt(m[1], 10);
  let end = m[2] === '' ? null : parseInt(m[2], 10);
  if (start === null && end === null) return null;
  if (start === null) {            // suffix range: last N bytes
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) return null;   // unsatisfiable
  return { start, end };
}

function registerMvpProtocol() {
  protocol.handle('mvp', async (request) => {
    try {
      const u = new URL(request.url);
      // mvp://local/<absolute path with slashes>
      const filePath = decodeURIComponent(u.pathname);
      const stat = await fsp.stat(filePath);
      const rangeHeader = request.headers.get('range');
      const range = rangeHeader ? parseRangeHeader(rangeHeader, stat.size) : null;

      const start = range ? range.start : 0;
      const end = range ? range.end : stat.size - 1;
      const stream = fs.createReadStream(filePath, { start, end });

      return new Response(stream, {
        status: range ? 206 : 200,
        headers: {
          'Content-Type': mimeFor(filePath),
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {})
        }
      });
    } catch (err) {
      return new Response(`Not found: ${err.message}`, { status: 404 });
    }
  });
}

// Convert an absolute filesystem path to an mvp:// URL the <video> can stream.
function toMvpUrl(filePath) {
  return `mvp://local${filePath.split(path.sep).join('/')}`;
}

// ---------------------------------------------------------------------------
// Keychain (keytar) — one entry per TTS engine. Falls back to a local JSON
// file (keys obfuscated, not plaintext) if keytar cannot load native module.
// ---------------------------------------------------------------------------
const SERVICE = 'MAXEDGE_VIDEO_PLAYER';
// Keys saved before the rename live under this legacy service name.
const LEGACY_SERVICE = 'MAXVIDEO_PLAYER';
const keyFile = () => path.join(app.getPath('userData'), 'keys.json');

async function keyGet(engine) {
  try {
    const keytar = require('keytar');
    const v = await keytar.getPassword(SERVICE, engine);
    if (v) return v;
    // Fall back to keys saved under the pre-rename service name
    const legacy = await keytar.getPassword(LEGACY_SERVICE, engine);
    if (legacy) return legacy;
  } catch (_) { /* fall through to file */ }
  try {
    const all = JSON.parse(await fsp.readFile(keyFile(), 'utf8'));
    const stored = all[engine];
    if (!stored) return '';
    // Values are stored as base64 in the fallback file
    return Buffer.from(stored, 'base64').toString('utf8');
  } catch (_) { return ''; }
}

async function keySet(engine, value) {
  try {
    const keytar = require('keytar');
    if (value) { await keytar.setPassword(SERVICE, engine, value); return true; }
    await keytar.deletePassword(SERVICE, engine);
    return true;
  } catch (_) { /* fall through to file */ }
  let all = {};
  try { all = JSON.parse(await fsp.readFile(keyFile(), 'utf8')); } catch (_) {}
  if (value) all[engine] = Buffer.from(value).toString('base64'); else delete all[engine];
  await fsp.writeFile(keyFile(), JSON.stringify(all, null, 2), { mode: 0o600 });
  return true;
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------
const configFile = () => path.join(app.getPath('userData'), 'settings.json');
async function configGet() {
  try { return JSON.parse(await fsp.readFile(configFile(), 'utf8')); }
  catch (_) { return null; }
}
async function configSet(partial) {
  const cur = (await configGet()) || {};
  const next = { ...cur, ...partial };
  await fsp.writeFile(configFile(), JSON.stringify(next, null, 2));
  return next;
}

// ---------------------------------------------------------------------------
// FFmpeg re-encode (stream copy — video is never re-compressed)
// ---------------------------------------------------------------------------
function resolveFfmpeg() {
  if (ffmpegPath) return ffmpegPath;
  try { ffmpegPath = require('ffmpeg-static'); } catch (_) { ffmpegPath = 'ffmpeg'; }
  return ffmpegPath;
}

async function freeDiskBytes(dir) {
  try {
    const { stdout } = await new Promise((res, rej) =>
      execFile('df', ['-Pk', dir], (e, o, err) => (e ? rej(err || e) : res({ stdout: o }))));
    const line = stdout.trim().split('\n').pop().split(/\s+/);
    return parseInt(line[3], 10) * 1024;   // available KB → bytes
  } catch (_) { return Number.POSITIVE_INFINITY; } // unknown → don't block
}

ipcMain.handle('reencode:start', async (event, { videoPath, audioPath }) => {
  const outPath = videoPath.replace(/(\.[^.]+)$/, '.translated$1');
  const inSize = (await fsp.stat(videoPath)).size;

  const avail = await freeDiskBytes(path.dirname(outPath));
  if (avail < inSize * 1.1) {
    return { ok: false, error: `Not enough free disk space (need ~${Math.ceil(inSize / 1e9)} GB).` };
  }

  const args = ['-y', '-i', videoPath, '-i', audioPath,
    '-c', 'copy', '-map', '0:v', '-map', '1:a', '-shortest', outPath];
  const proc = spawn(resolveFfmpeg(), args);
  const win = BrowserWindow.fromWebContents(event.sender);

  return new Promise((resolve) => {
    let buf = '';
    proc.stderr.on('data', (d) => {
      buf += d.toString();
      const m = [...buf.matchAll(/time=(\d+):(\d+):(\d+)\.(\d+)/g)].pop();
      if (m && win && !win.isDestroyed()) {
        const secs = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
        win.webContents.send('reencode:progress', { seconds: secs, output: outPath });
      }
      if (buf.length > 8192) buf = buf.slice(-2048);
    });
    proc.on('close', (code) => {
      if (code === 0) resolve({ ok: true, output: outPath });
      else resolve({ ok: false, error: `FFmpeg exited with code ${code}` });
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

// ---------------------------------------------------------------------------
// IPC surface exposed through preload.js
// ---------------------------------------------------------------------------
ipcMain.handle('dialog:openVideo', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open video',
    filters: [{ name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'mov', 'avi', 'm4v', 'ogv'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const filePath = res.filePaths[0];
  return { filePath, url: toMvpUrl(filePath), name: path.basename(filePath),
           size: (await fsp.stat(filePath)).size };
});

ipcMain.handle('dialog:openSubtitle', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: 'Open subtitle',
    filters: [{ name: 'Subtitles', extensions: ['srt', 'vtt', 'txt'] }],
    properties: ['openFile']
  });
  return res.canceled ? null : res.filePaths[0];
});

ipcMain.handle('file:readText', async (_e, filePath) => fsp.readFile(filePath, 'utf8'));
ipcMain.handle('config:get', () => configGet());
ipcMain.handle('config:set', (_e, partial) => configSet(partial));
ipcMain.handle('key:get', (_e, engine) => keyGet(engine));
ipcMain.handle('key:set', (_e, engine, value) => keySet(engine, value));
ipcMain.handle('app:openPath', (_e, p) => shell.openPath(p));

ipcMain.handle('audio:extractChunk', async (_event, { videoPath, startTime, duration = 8 }) => {
  const ffmpeg = resolveFfmpeg();
  const start = Math.max(0, startTime);
  const args = [
    '-ss', String(start),
    '-t', String(duration),
    '-i', videoPath,
    '-vn',
    '-acodec', 'libmp3lame',
    '-ar', '16000',
    '-ac', '1',
    '-b:a', '64k',
    '-f', 'mp3',
    'pipe:1'
  ];

  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, args);
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    let errBuf = '';
    proc.stderr.on('data', (d) => {
      errBuf += d.toString();
      if (errBuf.length > 2048) errBuf = errBuf.slice(-1024);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        const buf = Buffer.concat(chunks);
        resolve({ ok: true, data: buf.toString('base64'), size: buf.length, duration });
      } else {
        resolve({ ok: false, error: `FFmpeg chunk failed (code ${code}): ${errBuf}` });
      }
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

ipcMain.handle('audio:extractBgmStem', async (_event, { videoPath, startTime, duration = 8 }) => {
  const ffmpeg = resolveFfmpeg();
  const start = Math.max(0, startTime);
  const args = [
    '-ss', String(start),
    '-t', String(duration),
    '-i', videoPath,
    '-vn',
    '-af', 'pan=stereo|c0=c0-c1|c1=c1-c0',
    '-acodec', 'libmp3lame',
    '-ar', '44100',
    '-ac', '2',
    '-b:a', '128k',
    '-f', 'mp3',
    'pipe:1'
  ];

  return new Promise((resolve) => {
    const proc = spawn(ffmpeg, args);
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    let errBuf = '';
    proc.stderr.on('data', (d) => {
      errBuf += d.toString();
      if (errBuf.length > 2048) errBuf = errBuf.slice(-1024);
    });
    proc.on('close', (code) => {
      if (code === 0) {
        const buf = Buffer.concat(chunks);
        resolve({ ok: true, data: buf.toString('base64'), size: buf.length, duration });
      } else {
        resolve({ ok: false, error: `FFmpeg BGM stem failed: ${errBuf}` });
      }
    });
    proc.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
});

// ---------------------------------------------------------------------------
// SenseVoice Local On-Device Speech Recognition (sherpa-onnx)
// ---------------------------------------------------------------------------
const SENSEVOICE_DIR = () => path.join(app.getPath('userData'), 'models', 'sensevoice');
const SENSEVOICE_MODEL_FILE = () => path.join(SENSEVOICE_DIR(), 'model.int8.onnx');
const SENSEVOICE_TOKENS_FILE = () => path.join(SENSEVOICE_DIR(), 'tokens.txt');

const SENSEVOICE_URLS = {
  model: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',
  tokens: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/tokens.txt',
};

let senseVoiceRecognizer = null;

function checkSenseVoiceReady() {
  const modelPath = SENSEVOICE_MODEL_FILE();
  const tokensPath = SENSEVOICE_TOKENS_FILE();
  const modelExists = fs.existsSync(modelPath) && fs.statSync(modelPath).size > 100 * 1024 * 1024;
  const tokensExist = fs.existsSync(tokensPath) && fs.statSync(tokensPath).size > 100 * 1024;
  return {
    ready: modelExists && tokensExist,
    modelPath,
    tokensPath,
  };
}

function downloadFileWithRedirect(urlStr, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const makeRequest = (currentUrl, redirectCount = 0) => {
      if (redirectCount > 5) {
        return reject(new Error('Too many redirects while downloading model file.'));
      }

      const client = currentUrl.startsWith('https') ? https : http;
      const req = client.get(currentUrl, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          const redirectUrl = new URL(res.headers.location, currentUrl).href;
          return makeRequest(redirectUrl, redirectCount + 1);
        }

        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} downloading ${currentUrl}`));
        }

        const total = parseInt(res.headers['content-length'] || '0', 10);
        let transferred = 0;
        const tempPath = `${destPath}.tmp`;
        const fileStream = fs.createWriteStream(tempPath);

        res.on('data', (chunk) => {
          transferred += chunk.length;
          if (onProgress && total > 0) {
            const percent = Math.min(100, Math.round((transferred / total) * 100));
            onProgress({ percent, transferred, total });
          }
        });

        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close(() => {
            try {
              if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
              fs.renameSync(tempPath, destPath);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        });

        fileStream.on('error', (err) => {
          try { fs.unlinkSync(tempPath); } catch (_) {}
          reject(err);
        });
      });

      req.on('error', reject);
    };

    makeRequest(urlStr);
  });
}

ipcMain.handle('sensevoice:checkModel', async () => {
  return checkSenseVoiceReady();
});

ipcMain.handle('sensevoice:downloadModel', async (event) => {
  const dir = SENSEVOICE_DIR();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const win = BrowserWindow.fromWebContents(event.sender);
  const sendProgress = (p) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('sensevoice:download-progress', p);
    }
  };

  try {
    sendProgress({ status: 'downloading', file: 'tokens.txt', percent: 0 });
    await downloadFileWithRedirect(SENSEVOICE_URLS.tokens, SENSEVOICE_TOKENS_FILE());

    sendProgress({ status: 'downloading', file: 'model.int8.onnx', percent: 0 });
    await downloadFileWithRedirect(SENSEVOICE_URLS.model, SENSEVOICE_MODEL_FILE(), (prog) => {
      sendProgress({ status: 'downloading', file: 'model.int8.onnx', ...prog });
    });

    sendProgress({ status: 'ready', percent: 100 });
    return { ok: true };
  } catch (err) {
    sendProgress({ status: 'error', error: err.message });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('audio:transcribeSenseVoice', async (_event, { videoPath, startTime, duration = 12 }) => {
  const t0 = performance.now();
  const readyInfo = checkSenseVoiceReady();
  if (!readyInfo.ready) {
    return { ok: false, error: 'SenseVoice model not downloaded yet. Please download it in Settings.' };
  }

  try {
    if (!senseVoiceRecognizer) {
      const sherpa = require('sherpa-onnx');
      senseVoiceRecognizer = sherpa.createOfflineRecognizer({
        offlineModelConfig: {
          senseVoice: {
            model: readyInfo.modelPath,
            language: '', // auto
            useInverseTextNormalization: 1,
          },
          tokens: readyInfo.tokensPath,
          numThreads: 4,
          provider: 'cpu',
          debug: 0,
        }
      });
    }

    const ffmpeg = resolveFfmpeg();
    const start = Math.max(0, startTime);
    const args = [
      '-ss', String(start),
      '-t', String(duration),
      '-i', videoPath,
      '-vn',
      '-acodec', 'pcm_s16le',
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      'pipe:1'
    ];

    const wavBuffer = await new Promise((resolve, reject) => {
      const proc = spawn(ffmpeg, args);
      const chunks = [];
      proc.stdout.on('data', (d) => chunks.push(d));
      let errBuf = '';
      proc.stderr.on('data', (d) => {
        errBuf += d.toString();
        if (errBuf.length > 2048) errBuf = errBuf.slice(-1024);
      });
      proc.on('close', (code) => {
        if (code === 0) resolve(Buffer.concat(chunks));
        else reject(new Error(`FFmpeg wav extraction failed: ${errBuf}`));
      });
      proc.on('error', reject);
    });

    const sherpa = require('sherpa-onnx');
    const wave = sherpa.readWaveFromBinaryData(wavBuffer);
    if (!wave || !wave.samples || wave.samples.length === 0) {
      return { ok: true, raw: '', startTime, duration, latencyMs: Math.round(performance.now() - t0) };
    }

    const stream = senseVoiceRecognizer.createStream();
    stream.acceptWaveform(wave.sampleRate, wave.samples);
    senseVoiceRecognizer.decode(stream);
    const res = senseVoiceRecognizer.getResult(stream);
    stream.free();

    const latencyMs = Math.round(performance.now() - t0);
    return {
      ok: true,
      raw: res.text || '',
      startTime,
      duration,
      latencyMs,
    };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Math.round(performance.now() - t0) };
  }
});

// ---------------------------------------------------------------------------
// Window lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 800,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173';
  const isDev = !app.isPackaged;
  if (isDev) {
    mainWindow.loadURL(devUrl);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  registerMvpProtocol();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
