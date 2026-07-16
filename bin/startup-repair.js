'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const STARTUP_DIR = path.join(
  os.homedir(),
  'AppData', 'Roaming', 'Microsoft', 'Windows',
  'Start Menu', 'Programs', 'Startup'
);
const VBS_PATH = path.join(STARTUP_DIR, 'paperfly.vbs');

function resolveRuntimePaths() {
  const trayScript = path.resolve(__dirname, 'tray.js');
  const nodeExe = process.execPath;
  return { nodeExe, trayScript };
}

function buildVbsContent(nodeExe, trayScript) {
  return (
    'Set WshShell = CreateObject("WScript.Shell")\r\n' +
    'WshShell.Run """' + nodeExe + '"" ""' + trayScript + '""", 0, False\r\n'
  );
}

/**
 * Verify VBS in Startup folder has correct paths; rewrite if stale.
 * Returns: 'ok' | 'repaired' | 'created' | 'error'
 */
function ensureStartupScript() {
  try {
    const { nodeExe, trayScript } = resolveRuntimePaths();
    const expected = buildVbsContent(nodeExe, trayScript);

    if (fs.existsSync(VBS_PATH)) {
      const current = fs.readFileSync(VBS_PATH, 'utf-8');
      if (current === expected) return 'ok';
      fs.writeFileSync(VBS_PATH, expected, 'utf-8');
      return 'repaired';
    } else {
      fs.writeFileSync(VBS_PATH, expected, 'utf-8');
      return 'created';
    }
  } catch {
    return 'error';
  }
}

module.exports = { ensureStartupScript, VBS_PATH, STARTUP_DIR };
