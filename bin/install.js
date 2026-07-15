const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.paperfly');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'server.js');
const DEFAULT_PIN = '123456';

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

function createConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    console.log(`  Created config directory: ${CONFIG_DIR}`);
  }
}

function initConfig() {
  const configPath = CONFIG_FILE;
  let config = {};

  if (fs.existsSync(configPath)) {
    config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  }

  if (!config.pinHash) {
    config.pinHash = hashPin(DEFAULT_PIN);
    console.log(`  Default PIN set to: ${DEFAULT_PIN}`);
    console.log('  Change it with: paperfly set-pin');
  }

  if (!config.sessionSecret) {
    config.sessionSecret = crypto.randomBytes(32).toString('hex');
  }

  if (!config.port) {
    config.port = 3000;
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}



function setupStartupFolder() {
  try {
    const startupDir = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const vbsPath = path.join(startupDir, 'paperfly.vbs');
    
    // VBScript to run node script hidden
    const vbsContent = 'Set WshShell = CreateObject("WScript.Shell")\\n' +
      'WshShell.Run """' + process.execPath + '"" ""' + SERVER_SCRIPT + '""", 0, False\\n';
      
    fs.writeFileSync(vbsPath, vbsContent, 'utf-8');
    console.log('  Added to Windows Startup folder: paperfly.vbs');
    console.log('  Service will start automatically at logon.');
    return true;
  } catch (err) {
    console.log('  [!] Failed to add to Startup folder: ' + err.message);
    return false;
  }
}

function createActivityLog() {
  const logDir = path.join(CONFIG_DIR, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

async function main() {
  console.log('\n========================================');
  console.log('  Paperfly - Installation Setup');
  console.log('========================================\n');

  console.log('[1/4] Creating config directory...');
  createConfigDir();

  console.log('[2/4] Initializing configuration...');
  initConfig();
  createActivityLog();

  console.log('[3/3] Setting up auto-start...');
  setupStartupFolder();

  console.log('\n========================================');
  console.log('  Installation Complete!');
  console.log('========================================');
  console.log(`\n  Config: ${CONFIG_DIR}`);
  console.log('  Default PIN: 123456 (change with: paperfly set-pin)');
  console.log('\n  Commands:');
  console.log('    paperfly start    - Start service now');
  console.log('    paperfly stop     - Stop service');
  console.log('    paperfly status   - Check status');
  console.log('    paperfly url      - Show access URL');
  console.log('    paperfly set-pin  - Change PIN');
  console.log('');
}

main().catch((err) => {
  console.error('Installation failed:', err.message);
  process.exit(1);
});
