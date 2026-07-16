const os = require('os');
const { getConfig, updateConfig } = require('./config');

let tunnelInstance = null;
let currentUrl = null;
let heartbeatInterval = null;

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
      console.log('[tunnel] URL pushed to worker successfully');
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

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (currentUrl) {
      pushUrlToWorker(currentUrl);
    }
  }, 30 * 1000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

let tunnelPort = null;
let reconnecting = false;

async function startTunnel(port) {
  tunnelPort = port;
  return launchTunnel(port, true);
}

async function launchTunnel(port, isFirstAttempt) {
  try {
    const { Tunnel } = require('cloudflared/lib/tunnel');

    return new Promise((resolve) => {
      const t = Tunnel.quick(`http://localhost:${port}`);
      tunnelInstance = t;

      t.on('url', (url) => {
        currentUrl = url;
        reconnecting = false;
        updateConfig({ tunnel: { url: currentUrl } });
        console.log(`[tunnel] Connected: ${currentUrl}`);
        pushUrlToWorker(currentUrl);
        startHeartbeat();
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
          reconnecting = true;
          console.log('[tunnel] Scheduling reconnect in 5s...');
          setTimeout(() => reconnectTunnel(), 5000);
        }
      });

      if (isFirstAttempt) {
        setTimeout(() => {
          if (!currentUrl) {
            console.error('[tunnel] Cloudflare tunnel timed out after 30s');
            console.error('[tunnel] Check: is cloudflared binary available? Is network connected?');
            t.stop();
            tunnelInstance = null;
            resolve(null);
            // Retry after timeout
            if (tunnelPort) {
              reconnecting = true;
              console.log('[tunnel] Will retry in 10s...');
              setTimeout(() => reconnectTunnel(), 10000);
            }
          }
        }, 30000);
      }
    });
  } catch (err) {
    console.error(`[tunnel] Cloudflare tunnel failed: ${err.message}`);
    console.error('[tunnel] Ensure cloudflared is installed: npm ls cloudflared');
    if (isFirstAttempt) {
      // Retry on failure
      if (tunnelPort) {
        reconnecting = true;
        console.log('[tunnel] Will retry in 10s...');
        setTimeout(() => reconnectTunnel(), 10000);
      }
      return null;
    }
  }
}

async function reconnectTunnel() {
  if (!tunnelPort) return;
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
  stopHeartbeat();
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
