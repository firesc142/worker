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
      body: JSON.stringify({ url, machineId, machineName })
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
        updateConfig({ pin_hash: data.pin_hash });
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
  }, 5 * 60 * 1000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

async function startTunnel(port) {
  try {
    const { Tunnel } = require('cloudflared/lib/tunnel');

    return new Promise((resolve) => {
      const t = Tunnel.quick(`http://localhost:${port}`);
      tunnelInstance = t;

      t.on('url', (url) => {
        currentUrl = url;
        updateConfig({ tunnel: { mode: 'cloudflare', url: currentUrl } });
        console.log(`[tunnel] Connected: ${currentUrl}`);
        pushUrlToWorker(currentUrl);
        startHeartbeat();
        resolve(currentUrl);
      });

      t.on('error', (err) => {
        console.error(`[tunnel] Error: ${err.message || err}`);
      });

      t.on('exit', (code) => {
        console.log(`[tunnel] Process exited (code ${code})`);
        tunnelInstance = null;
        stopHeartbeat();
      });

      setTimeout(() => {
        if (!currentUrl) {
          console.error('[tunnel] Cloudflare tunnel timed out, trying localtunnel...');
          t.stop();
          tunnelInstance = null;
          startLocaltunnel(port).then(resolve);
        }
      }, 30000);
    });
  } catch (err) {
    console.error(`[tunnel] Cloudflare tunnel failed: ${err.message}`);
    return startLocaltunnel(port);
  }
}

async function startLocaltunnel(port) {
  try {
    const localtunnel = require('localtunnel');
    const config = getConfig();
    const tunnelConfig = config.tunnel || {};
    const subdomain = tunnelConfig.subdomain || undefined;
    const opts = { port };
    if (subdomain) opts.subdomain = subdomain;

    const lt = await localtunnel(opts);
    currentUrl = lt.url;
    tunnelInstance = lt;

    updateConfig({ tunnel: { mode: 'localtunnel', url: currentUrl } });
    console.log(`[tunnel] Fallback connected: ${currentUrl}`);
    pushUrlToWorker(currentUrl);
    startHeartbeat();

    lt.on('close', () => {
      console.log('[tunnel] Connection closed');
      tunnelInstance = null;
      stopHeartbeat();
    });

    return currentUrl;
  } catch (err) {
    console.error(`[tunnel] All tunnel methods failed: ${err.message}`);
    return null;
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
  stopHeartbeat();
  await notifyOffline();
  if (tunnelInstance) {
    if (tunnelInstance.stop) {
      tunnelInstance.stop();
    } else if (tunnelInstance.close) {
      tunnelInstance.close();
    }
    tunnelInstance = null;
    console.log('[tunnel] Stopped');
  }
}

function getTunnelUrl() {
  return currentUrl;
}

module.exports = { startTunnel, stopTunnel, getTunnelUrl };
