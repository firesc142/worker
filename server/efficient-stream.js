const zlib = require('zlib');
const captureGdi = require('./capture-gdi');
const tileDiff = require('./tile-diff');
const monitors = require('./monitors');

const MSG_DIFF = 0x01;
const MSG_KEYFRAME = 0x02;
const KEYFRAME_INTERVAL = 5000;
const HEADER_SIZE = 12;
const TILE_HEADER_SIZE = 8;

let interval = null;
let state = null;
let frameSeq = 0;
let lastKeyframe = 0;
let pendingFrame = false;
let currentFps = 15;
let active = false;
let currentSocket = null;
let keyframeHandler = null;
let lastMonitorId = null;

function start(socket, options = {}) {
  if (active) stop();

  currentFps = Math.min(30, Math.max(1, options.fps || 15));
  currentSocket = socket;

  const monitorId = monitors.getActiveMonitor();
  const bounds = monitors.getMonitorBounds(monitorId);

  captureGdi.initCapture(bounds.width, bounds.height, bounds.x, bounds.y);
  state = tileDiff.init(bounds.width, bounds.height);
  frameSeq = 0;
  lastKeyframe = 0;
  lastMonitorId = monitorId;
  pendingFrame = false;
  active = true;

  keyframeHandler = () => {
    if (active) sendKeyframe(socket);
  };
  socket.on('request-keyframe', keyframeHandler);

  sendKeyframe(socket);

  const tick = Math.floor(1000 / currentFps);
  interval = setInterval(() => {
    if (pendingFrame) return;
    captureAndSend(socket, false);
  }, tick);
}

function stop() {
  active = false;
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
  if (currentSocket && keyframeHandler) {
    currentSocket.removeListener('request-keyframe', keyframeHandler);
    keyframeHandler = null;
  }
  currentSocket = null;
  captureGdi.releaseCapture();
  state = null;
}

function setMonitor(socket, monitorId) {
  if (!active) return;
  const changed = captureGdi.reinitForMonitor(monitorId);
  if (changed) {
    const bounds = monitors.getMonitorBounds(monitorId);
    state = tileDiff.init(bounds.width, bounds.height);
    sendKeyframe(socket);
  }
}

function sendKeyframe(socket) {
  captureAndSend(socket, true);
  lastKeyframe = Date.now();
}

function captureAndSend(socket, forceKeyframe) {
  try {
    // Check if monitor changed
    const currentMonitor = monitors.getActiveMonitor();
    if (currentMonitor !== lastMonitorId) {
      lastMonitorId = currentMonitor;
      const bounds = monitors.getMonitorBounds(currentMonitor);
      captureGdi.initCapture(bounds.width, bounds.height, bounds.x, bounds.y);
      state = tileDiff.init(bounds.width, bounds.height);
      forceKeyframe = true;
    }

    const frame = captureGdi.captureFrame();
    if (!frame) return; // Native capture not available

    const width = captureGdi.getWidth();
    const height = captureGdi.getHeight();

    const now = Date.now();
    const isKeyframe = forceKeyframe || (now - lastKeyframe >= KEYFRAME_INTERVAL);

    let dirtyTiles;
    if (isKeyframe) {
      dirtyTiles = tileDiff.getAllTileIndices(state);
      state.initialized = false;
      tileDiff.findDirtyTiles(frame, state);
      lastKeyframe = now;
    } else {
      dirtyTiles = tileDiff.findDirtyTiles(frame, state);
    }

    if (dirtyTiles.length === 0) return;

    frameSeq++;
    const msgType = isKeyframe ? MSG_KEYFRAME : MSG_DIFF;

    const tileDataBuffers = [];
    const tileHeaders = [];

    for (const tileIdx of dirtyTiles) {
      const { rgb } = tileDiff.extractTileRGB(frame, tileIdx, width, height, state.cols);
      const compressed = zlib.deflateSync(rgb, { level: 1 });
      const col = tileIdx % state.cols;
      const row = Math.floor(tileIdx / state.cols);

      tileHeaders.push({ col, row, dataLength: compressed.length });
      tileDataBuffers.push(compressed);
    }

    const tileCount = dirtyTiles.length;
    const headerSection = HEADER_SIZE + tileCount * TILE_HEADER_SIZE;
    const totalDataSize = tileDataBuffers.reduce((sum, b) => sum + b.length, 0);
    const message = Buffer.alloc(headerSection + totalDataSize);

    message.writeUInt8(msgType, 0);
    message.writeUInt32LE(frameSeq, 1);
    message.writeUInt16LE(width, 5);
    message.writeUInt16LE(height, 7);
    message.writeUInt8(tileDiff.TILE_SIZE, 9);
    message.writeUInt16LE(tileCount, 10);

    let offset = HEADER_SIZE;
    for (const th of tileHeaders) {
      message.writeUInt16LE(th.col, offset);
      message.writeUInt16LE(th.row, offset + 2);
      message.writeUInt32LE(th.dataLength, offset + 4);
      offset += TILE_HEADER_SIZE;
    }

    for (const buf of tileDataBuffers) {
      buf.copy(message, offset);
      offset += buf.length;
    }

    pendingFrame = true;
    socket.volatile.emit('screen-tiles', message, () => {
      pendingFrame = false;
    });
    setTimeout(() => { pendingFrame = false; }, 500);

  } catch (err) {
    console.error('Efficient stream error:', err.message);
    pendingFrame = false;
  }
}

function isActive() { return active; }

module.exports = { start, stop, setMonitor, isActive };
