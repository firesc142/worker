const { spawn } = require('child_process');
const { execSync } = require('child_process');

let ffmpegProcess = null;
let isStreaming = false;
let ffmpegAvailable = null;

function checkFfmpeg() {
  if (ffmpegAvailable !== null) return ffmpegAvailable;
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

function handleConnection(socket) {
  socket.on('audio-start', () => {
    if (!checkFfmpeg()) {
      socket.emit('audio-error', { message: 'ffmpeg is required for audio streaming. Install from https://ffmpeg.org' });
      return;
    }

    if (isStreaming) {
      socket.emit('audio-status', { streaming: true });
      return;
    }

    startAudioCapture(socket);
  });

  socket.on('audio-stop', () => {
    stopAudioCapture();
    socket.emit('audio-status', { streaming: false });
  });

  socket.on('audio-status', () => {
    socket.emit('audio-status', { streaming: isStreaming, ffmpegAvailable: checkFfmpeg() });
  });

  socket.on('disconnect', () => {
    stopAudioCapture();
  });
}

function startAudioCapture(socket) {
  const audioDevice = getAudioDevice();
  if (!audioDevice) {
    socket.emit('audio-error', { message: 'No audio loopback device found. Enable "Stereo Mix" in Windows Sound settings.' });
    return;
  }

  try {
    ffmpegProcess = spawn('ffmpeg', [
      '-f', 'dshow',
      '-i', `audio=${audioDevice}`,
      '-acodec', 'libmp3lame',
      '-ab', '128k',
      '-ar', '44100',
      '-f', 'mp3',
      'pipe:1'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    isStreaming = true;
    socket.emit('audio-status', { streaming: true });

    ffmpegProcess.stdout.on('data', (chunk) => {
      socket.emit('audio-chunk', { data: chunk.toString('base64') });
    });

    ffmpegProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        socket.emit('audio-error', { message: msg.trim() });
      }
    });

    ffmpegProcess.on('close', (code) => {
      isStreaming = false;
      ffmpegProcess = null;
      socket.emit('audio-status', { streaming: false });
    });

    ffmpegProcess.on('error', (err) => {
      isStreaming = false;
      ffmpegProcess = null;
      socket.emit('audio-error', { message: err.message });
    });
  } catch (err) {
    isStreaming = false;
    socket.emit('audio-error', { message: err.message });
  }
}

function stopAudioCapture() {
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGTERM');
    ffmpegProcess = null;
    isStreaming = false;
  }
}

function getAudioDevice() {
  try {
    const result = execSync('ffmpeg -list_devices true -f dshow -i dummy 2>&1', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return parseAudioDevice(result);
  } catch (err) {
    const output = err.stdout || err.stderr || '';
    return parseAudioDevice(output);
  }
}

function parseAudioDevice(output) {
  const lines = output.split('\n');
  const audioDevices = [];
  let inAudio = false;

  for (const line of lines) {
    if (line.includes('DirectShow audio devices')) {
      inAudio = true;
      continue;
    }
    if (inAudio && line.includes('"')) {
      const match = line.match(/"([^"]+)"/);
      if (match) {
        audioDevices.push(match[1]);
      }
    }
  }

  const preferred = ['Stereo Mix', 'CABLE Output', 'What U Hear', 'Loopback'];
  for (const pref of preferred) {
    const found = audioDevices.find(d => d.toLowerCase().includes(pref.toLowerCase()));
    if (found) return found;
  }

  return audioDevices[0] || null;
}

module.exports = { handleConnection };
