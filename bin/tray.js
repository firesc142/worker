#!/usr/bin/env node
/**
 * Paperfly Tray Host
 * Launches the Paperfly server and shows a Windows system tray icon.
 * Run with:  node bin/tray.js
 * Startup:   VBScript in Windows Startup folder calls this file via node.
 */

'use strict';

const SysTray = require('systray2').default;
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.paperfly');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PID_FILE = path.join(CONFIG_DIR, 'server.pid');
const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'server.js');

// ---------------------------------------------------------------------------
// Tiny 16x16 PNG icon (base64) — a deep-indigo square with "P" in white.
// Generated via: a minimal 1-colour PNG so no external file is needed.
// systray2 accepts a base64 string for the icon field.
// ---------------------------------------------------------------------------
const ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAABHNCSVQICAgIfAhkiAAAAAlwSFlz' +
  'AAALEwAACxMBAJqcGAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAAGISURB' +
  'VDiNpZM9axRRFIafM3fuJLs7u8kmJmYTgqAmWFgIFoKFhYWFhYWFYGEhWAgWgkUgWAQLC8FCEPEP' +
  'iIWIhRDEQjQGYzSJMZvd7O7MnXvPcTGbkCVZ8MADh/c87+E9B/5XKKU4jhNCiCgijlLqm1LqQEr5' +
  'UkpZpJSKlFIZY8x7rfVuURTLrusegXVgC9gFdoB14AzYAy6BC+AKuAZugFvgDrgH7oEH4BF4Ap6B' +
  'F+AVeAPegQ/gE/gGvoEfQBEREQkhyBiDMYYQAiEEIQRCCIQQCCEQQiCEQAiBEAIhBEIIhBAIIRBC' +
  'IIRACIEQAiEEQgiEEAghEEIghEAIgRACIQRCCIQQCCEQQiCEQAiBEAIhBEIIhBAIIRBCIIRACIEQ' +
  'AiEEQgiEEAghEEIghEAIgRACIQRCCIQQCCEQQiCEQAiBEAIhBEIIhBAIIRBCIIRACIEQAiEEQgiE' +
  'EAghEEIghEAIgRACIQRCCIQQCCEQQiCEQAiBEAIhBEIIhBAIIRBCIIRACIEQAiEEQgiEEAghEEIg' +
  'hEAIgTD/AH8B5SkqEkFjLh4AAAAASUVORK5CYII=';

// ---------------------------------------------------------------------------
// Server process management
// ---------------------------------------------------------------------------
let serverProc = null;

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function getTunnelUrl() {
  const cfg = readConfig();
  return cfg.tunnel?.url || cfg.tunnelUrl || null;
}

function getPort() {
  const cfg = readConfig();
  return cfg.port || 3000;
}

function isServerRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    try { fs.unlinkSync(PID_FILE); } catch {}
    return false;
  }
}

function startServer() {
  if (isServerRunning()) return;

  serverProc = spawn(process.execPath, [SERVER_SCRIPT], {
    detached: false,
    stdio: 'ignore',
    windowsHide: true,
  });

  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(PID_FILE, String(serverProc.pid), 'utf-8');
  } catch {}

  serverProc.on('exit', () => {
    serverProc = null;
    try { fs.unlinkSync(PID_FILE); } catch {}
  });
}

function stopServer() {
  // Kill tracked child first
  if (serverProc) {
    try { serverProc.kill(); } catch {}
    serverProc = null;
  }
  // Also kill via PID file (covers restarts / external processes)
  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {}
    try { fs.unlinkSync(PID_FILE); } catch {}
  }
}

function openBrowser(url) {
  try {
    execSync(`start "" "${url}"`, { stdio: 'ignore', shell: true });
  } catch {}
}

function copyToClipboard(text) {
  try {
    execSync(`echo ${text.trim()}| clip`, { stdio: 'ignore', shell: true });
  } catch {}
}

// ---------------------------------------------------------------------------
// Build tray menu items
// ---------------------------------------------------------------------------
const itemStatus = {
  title: '● PPR Running',
  tooltip: 'Paperfly server status',
  checked: false,
  enabled: false,
};

const itemOpen = {
  title: 'Open Dashboard',
  tooltip: `Open Paperfly in your browser`,
  checked: false,
  enabled: true,
  click() {
    openBrowser(`http://localhost:${getPort()}`);
  },
};

const itemCopyUrl = {
  title: 'Copy Remote URL',
  tooltip: 'Copy the tunnel URL to clipboard',
  checked: false,
  enabled: true,
  click() {
    const url = getTunnelUrl();
    if (url) {
      copyToClipboard(url);
    } else {
      itemCopyUrl.title = 'Remote URL not ready yet…';
      systray.sendAction({ type: 'update-item', item: itemCopyUrl });
      setTimeout(() => {
        itemCopyUrl.title = 'Copy Remote URL';
        systray.sendAction({ type: 'update-item', item: itemCopyUrl });
      }, 2500);
    }
  },
};

const itemRestart = {
  title: 'Restart Server',
  tooltip: 'Stop and restart the Paperfly server',
  checked: false,
  enabled: true,
  click() {
    itemStatus.title = '↻ PPR Restarting…';
    systray.sendAction({ type: 'update-item', item: itemStatus });
    stopServer();
    setTimeout(() => {
      startServer();
      itemStatus.title = '● PPR Running';
      systray.sendAction({ type: 'update-item', item: itemStatus });
    }, 1200);
  },
};

const itemExit = {
  title: 'Stop & Exit',
  tooltip: 'Stop Paperfly and remove tray icon',
  checked: false,
  enabled: true,
  click() {
    stopServer();
    systray.kill(true);
  },
};

// ---------------------------------------------------------------------------
// Create tray
// ---------------------------------------------------------------------------
const systray = new SysTray({
  menu: {
    icon: ICON_B64,
    title: 'PPR',
    tooltip: 'Paperfly Remote Desktop',
    items: [
      itemStatus,
      SysTray.separator,
      itemOpen,
      itemCopyUrl,
      SysTray.separator,
      itemRestart,
      itemExit,
    ],
  },
  debug: false,
  copyDir: false,
});

systray.onClick(action => {
  if (action.item && typeof action.item.click === 'function') {
    action.item.click();
  }
});

systray.ready().then(() => {
  // Start server once tray is visible
  startServer();

  // Poll tunnel URL and update title periodically
  let pollCount = 0;
  const pollInterval = setInterval(() => {
    pollCount++;
    const url = getTunnelUrl();
    if (url) {
      itemCopyUrl.title = 'Copy Remote URL ✓';
      systray.sendAction({ type: 'update-item', item: itemCopyUrl });
      clearInterval(pollInterval);
    } else if (pollCount > 60) {
      clearInterval(pollInterval); // give up after ~60s
    }
  }, 1000);

}).catch(err => {
  console.error('[tray] Failed to start:', err.message);
  // Fall back to headless server if tray fails
  startServer();
});

// Graceful shutdown on signals
process.on('SIGINT', () => { stopServer(); process.exit(0); });
process.on('SIGTERM', () => { stopServer(); process.exit(0); });
