const os = require('os');
const { getConfig, updateConfig } = require('./config');

let tunnelInstance = null;
let currentUrl = null;

async function pushUrlToWorker(url) {
  const config = getConfig();
  const workerUrl = config.urlWorker?.endpoint;
  const apiKey = config.urlWorker?.apiKey;
  const machineId = config.machineId;
  const machineName = config.machineName || os.hostname();

  if (!workerUrl || !apiKey || !machineId) return;

  try {
    const response = await fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      body: JSON.stringify({ url, machineId, machineName, status: 'online', ts: Date.now() })
    });
    if (response.ok) {
      console.log('[tunnel] URL pushed to worker');
    } else {
      console.error(`[tunnel] Failed to push URL to worker: ${response.status}`);
    }
  } catch (err) {
    console.error(`[tunnel] Error pushing URL to worker: ${err.message}`);
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
    const response = await fetch(`${baseUrl}/api/pin`, {
      headers: { 'X-API-Key': apiKey }
    });
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

let tunnelPort = null;
let reconnecting = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_RECONNECT_DELAY = 5000;

async function startTunnel(port) {
  tunnelPort = port;
  reconnectAttempts = 0;
  return launchTunnel(port, true);
}

async function launchTunnel(port, isFirstAttempt) {
  let Tunnel;
  try {
    Tunnel = require('cloudflared/lib/tunnel').Tunnel;
  } catch (err) {
    console.error(`[tunnel] cloudflared module not available: ${err.message}`);
    console.error('[tunnel] Install with: npm install cloudflared');
    return isFirstAttempt ? null : undefined;
  }

  try {
    return new Promise((resolve) => {
      const t = Tunnel.quick(`http://localhost:${port}`);
      tunnelInstance = t;

      t.on('url', (url) => {
        currentUrl = url;
        reconnecting = false;
        reconnectAttempts = 0;
        updateConfig({ tunnel: { url: currentUrl } });
        console.log(`[tunnel] Connected: ${currentUrl}`);
        pushUrlToWorker(currentUrl);
        if (isFirstAttempt) resolve(currentUrl);
      });

      t.on('error', (err) => {
        console.error(`[tunnel] Error: ${err.message || err}`);
      });

      t.on('exit', (code) => {
        console.log(`[tunnel] Process exited (code ${code})`);
        tunnelInstance = null;
        currentUrl = null;
        if (tunnelPort && !reconnecting) {
          scheduleReconnect();
        }
      });

      if (isFirstAttempt) {
        setTimeout(() => {
          if (!currentUrl) {
            console.error('[tunnel] Cloudflare tunnel timed out after 30s');
            try { t.stop(); } catch {}
            tunnelInstance = null;
            resolve(null);
            if (tunnelPort) {
              scheduleReconnect();
            }
          }
        }, 30000);
      }
    });
  } catch (err) {
    console.error(`[tunnel] Cloudflare tunnel spawn failed: ${err.message}`);
    if (isFirstAttempt) {
      if (tunnelPort) scheduleReconnect();
      return null;
    }
  }
}

function scheduleReconnect() {
  if (reconnecting) return;
  reconnectAttempts++;
  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error(`[tunnel] Giving up after ${MAX_RECONNECT_ATTEMPTS} attempts. Use 'paperfly restart' to try again.`);
    return;
  }
  reconnecting = true;
  const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
  console.log(`[tunnel] Reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay / 1000}s...`);
  setTimeout(() => reconnectTunnel(), delay);
}

async function reconnectTunnel() {
  if (!tunnelPort) return;
  reconnecting = false;
  console.log('[tunnel] Attempting reconnect...');
  await launchTunnel(tunnelPort, false);
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
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey
      },
      body: JSON.stringify({ machineId })
    });
    console.log('[tunnel] Offline notification sent');
  } catch (err) {
    console.error(`[tunnel] Failed to send offline notification: ${err.message}`);
  }
}

async function stopTunnel() {
  reconnecting = false;
  tunnelPort = null;
  await notifyOffline();
  if (tunnelInstance) {
    const inst = tunnelInstance;
    tunnelInstance = null;
    if (inst.stop) {
      inst.stop();
    } else if (inst.close) {
      inst.close();
    }
    console.log('[tunnel] Stopped');
  }
}

function getTunnelUrl() {
  return currentUrl;
}

module.exports = { startTunnel, stopTunnel, getTunnelUrl };
