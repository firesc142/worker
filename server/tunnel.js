const net = require('net');
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { getConfig, updateConfig, CONFIG_DIR } = require('./config');

let tunnelInstance = null;
let currentUrl = null;
let tunnelPort = null;
let stopped = false;
let healthInterval = null;
let reconnectTimer = null;
let reconnectAttempts = 0;

const BASE_RECONNECT_DELAY = 2000;
const MAX_RECONNECT_DELAY = 300000;
const HEALTH_CHECK_INTERVAL = 30000;
const NETWORK_CHECK_TIMEOUT = 5000;
const FIRST_ATTEMPT_TIMEOUT = 120000;
const NETWORK_TARGETS = [
  { host: '1.1.1.1', port: 443 },
  { host: '1.0.0.1', port: 443 },
  { host: '8.8.8.8', port: 443 },
];

// --- Binary management ---

function getBinaryPaths() {
  const { DEFAULT_CLOUDFLARED_BIN } = require('cloudflared/lib/constants');
  const fallback = path.join(CONFIG_DIR, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  return { npmPath: DEFAULT_CLOUDFLARED_BIN, fallbackPath: fallback };
}

async function ensureBinary() {
  const { npmPath, fallbackPath } = getBinaryPaths();
  const constants = require('cloudflared/lib/constants');

  if (fs.existsSync(npmPath)) {
    constants.use(npmPath);
    return npmPath;
  }

  if (fs.existsSync(fallbackPath)) {
    constants.use(fallbackPath);
    return fallbackPath;
  }

  console.log('[tunnel] Cloudflared binary not found, downloading...');
  const { install } = require('cloudflared/lib/install');

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await install(fallbackPath);
      console.log('[tunnel] Cloudflared binary downloaded successfully');
      constants.use(fallbackPath);
      return fallbackPath;
    } catch (err) {
      console.error(`[tunnel] Binary download failed (attempt ${attempt}/2): ${err.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
    }
  }

  throw new Error('Failed to download cloudflared binary');
}

// --- Network readiness ---

function checkNetwork(target) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: target.host, port: target.port, timeout: NETWORK_CHECK_TIMEOUT });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
  });
}

async function waitForNetwork(maxWaitMs = 120000) {
  const start = Date.now();
  let delay = 2000;
  let targetIndex = 0;

  while (Date.now() - start < maxWaitMs) {
    if (stopped) throw new Error('stopped');

    const target = NETWORK_TARGETS[targetIndex % NETWORK_TARGETS.length];
    const online = await checkNetwork(target);
    if (online) return true;

    targetIndex++;
    console.log(`[tunnel] Waiting for network... (${Math.round((Date.now() - start) / 1000)}s elapsed)`);
    await new Promise(r => setTimeout(r, delay));
    delay = Math.min(delay * 2, 30000);
  }

  throw new Error('Network not available after ' + (maxWaitMs / 1000) + 's');
}

// --- DNS flush ---

function flushDns() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') { resolve(); return; }
    exec('ipconfig /flushdns', { timeout: 5000 }, () => resolve());
  });
}

// --- Health monitoring ---

let healthFailCount = 0;

function startHealthMonitor() {
  stopHealthMonitor();
  healthFailCount = 0;

  healthInterval = setInterval(async () => {
    if (!currentUrl || stopped) return;

    try {
      const hostname = new URL(currentUrl).hostname;
      await new Promise((resolve, reject) => {
        dns.resolve4(hostname, (err) => err ? reject(err) : resolve());
      });
      healthFailCount = 0;
    } catch {
      healthFailCount++;
      console.log(`[tunnel] Health check failed (${healthFailCount}/3)`);

      if (healthFailCount >= 3) {
        console.error('[tunnel] Tunnel appears dead, forcing reconnect');
        stopHealthMonitor();
        killTunnelProcess();
      }
    }
  }, HEALTH_CHECK_INTERVAL);
}

function stopHealthMonitor() {
  if (healthInterval) {
    clearInterval(healthInterval);
    healthInterval = null;
  }
}

function killTunnelProcess() {
  if (tunnelInstance) {
    const inst = tunnelInstance;
    tunnelInstance = null;
    currentUrl = null;
    try { if (inst.stop) inst.stop(); else if (inst.close) inst.close(); } catch {}
  }
}

// --- Worker communication ---

async function pushUrlToWorker(url, retries = 3) {
  const config = getConfig();
  const workerUrl = config.urlWorker?.endpoint;
  const apiKey = config.urlWorker?.apiKey;
  const machineId = config.machineId;
  const machineName = config.machineName || os.hostname();

  if (!workerUrl || !apiKey || !machineId) return;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(workerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: JSON.stringify({ url, machineId, machineName, status: 'online', ts: Date.now() })
      });
      if (response.ok) {
        console.log('[tunnel] URL pushed to worker');
        syncPinFromWorker();
        return;
      }
      console.error(`[tunnel] Failed to push URL to worker: ${response.status}`);
    } catch (err) {
      console.error(`[tunnel] Error pushing URL to worker (attempt ${attempt}/${retries}): ${err.message}`);
    }
    if (attempt < retries) await new Promise(r => setTimeout(r, 5000 * attempt));
  }

  syncPinFromWorker();
}

async function syncPinFromWorker() {
  const config = getConfig();
  const workerUrl = config.urlWorker?.endpoint;
  const apiKey = config.urlWorker?.apiKey;

  if (!workerUrl || !apiKey) return;

  try {
    const baseUrl = workerUrl.replace(/\/api\/url$/, '');
    const response = await fetch(`${baseUrl}/api/pin`, { headers: { 'X-API-Key': apiKey } });
    if (response.ok) {
      const data = await response.json();
      if (data.pin_hash) {
        updateConfig({ pin_hash: data.pin_hash, pinHash: null });
        console.log('[tunnel] PIN synced from worker');
      }
    }
  } catch (err) {
    console.error(`[tunnel] Error syncing PIN: ${err.message}`);
  }
}

async function notifyOffline() {
  const config = getConfig();
  const workerUrl = config.urlWorker?.endpoint;
  const apiKey = config.urlWorker?.apiKey;
  const machineId = config.machineId;

  if (!workerUrl || !apiKey || !machineId) return;

  try {
    const baseUrl = workerUrl.replace(/\/api\/url$/, '');
    await fetch(`${baseUrl}/api/offline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
      body: JSON.stringify({ machineId })
    });
    console.log('[tunnel] Offline notification sent');
  } catch (err) {
    console.error(`[tunnel] Failed to send offline notification: ${err.message}`);
  }
}

// --- Tunnel lifecycle ---

async function startTunnel(port) {
  tunnelPort = port;
  stopped = false;
  reconnectAttempts = 0;

  updateConfig({ tunnel: { url: null } });

  try {
    await ensureBinary();
  } catch (err) {
    console.error(`[tunnel] ${err.message}`);
    console.error('[tunnel] Will retry in background...');
    scheduleReconnect();
    return null;
  }

  try {
    await waitForNetwork();
  } catch (err) {
    if (err.message === 'stopped') return null;
    console.error(`[tunnel] ${err.message}`);
    scheduleReconnect();
    return null;
  }

  return launchTunnel(port, true);
}

async function launchTunnel(port, isFirstAttempt) {
  let Tunnel;
  try {
    Tunnel = require('cloudflared/lib/tunnel').Tunnel;
  } catch (err) {
    console.error(`[tunnel] cloudflared module not available: ${err.message}`);
    if (isFirstAttempt) { scheduleReconnect(); return null; }
    return;
  }

  try {
    return new Promise((resolve) => {
      let resolved = false;
      const t = Tunnel.quick(`http://localhost:${port}`);
      tunnelInstance = t;

      t.on('url', (url) => {
        currentUrl = url;
        reconnectAttempts = 0;
        updateConfig({ tunnel: { url: currentUrl } });
        console.log(`[tunnel] Connected: ${currentUrl}`);
        pushUrlToWorker(currentUrl);
        startHealthMonitor();
        if (isFirstAttempt && !resolved) { resolved = true; resolve(currentUrl); }
      });

      t.on('error', (err) => {
        console.error(`[tunnel] Error: ${err.message || err}`);
      });

      t.on('exit', (code) => {
        console.log(`[tunnel] Process exited (code ${code})`);
        tunnelInstance = null;
        currentUrl = null;
        stopHealthMonitor();
        if (!stopped) scheduleReconnect();
      });

      if (isFirstAttempt) {
        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            console.log('[tunnel] Still connecting in background (initial timeout reached)');
            resolve(null);
          }
        }, FIRST_ATTEMPT_TIMEOUT);
      }
    });
  } catch (err) {
    console.error(`[tunnel] Cloudflare tunnel spawn failed: ${err.message}`);
    if (isFirstAttempt) { scheduleReconnect(); return null; }
  }
}

// --- Reconnection (infinite, exponential backoff, capped at 5 min) ---

function scheduleReconnect() {
  if (stopped) return;
  if (reconnectTimer) return;

  reconnectAttempts++;
  const delay = Math.min(BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1), MAX_RECONNECT_DELAY);
  console.log(`[tunnel] Reconnect in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (stopped || !tunnelPort) return;

    await flushDns();

    try {
      await waitForNetwork(60000);
    } catch (err) {
      if (err.message === 'stopped') return;
      console.error(`[tunnel] Network not ready, will retry...`);
      scheduleReconnect();
      return;
    }

    try {
      await ensureBinary();
    } catch (err) {
      console.error(`[tunnel] ${err.message}, will retry...`);
      scheduleReconnect();
      return;
    }

    console.log('[tunnel] Attempting reconnect...');
    await launchTunnel(tunnelPort, false);
  }, delay);
}

// --- Public API ---

async function stopTunnel() {
  stopped = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopHealthMonitor();
  await notifyOffline();
  killTunnelProcess();
  updateConfig({ tunnel: { url: null } });
  console.log('[tunnel] Stopped');
}

function getTunnelUrl() {
  return currentUrl;
}

module.exports = { startTunnel, stopTunnel, getTunnelUrl };
