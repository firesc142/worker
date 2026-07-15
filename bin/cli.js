#!/usr/bin/env node

const { program } = require('commander');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.paperfly');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const PID_FILE = path.join(CONFIG_DIR, 'server.pid');
const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'server.js');

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfig() {
  ensureConfigDir();
  if (fs.existsSync(CONFIG_FILE)) {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  }
  return {};
}


function isRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    fs.unlinkSync(PID_FILE);
    return false;
  }
}

function getRunningPid() {
  if (!fs.existsSync(PID_FILE)) return null;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    fs.unlinkSync(PID_FILE);
    return null;
  }
}

program
  .name('paperfly')
  .description('Paperfly - Personal Remote Desktop Service')
  .version('1.0.0');

program
  .command('start')
  .description('Start the remote desktop service')
  .action(() => {
    if (isRunning()) {
      console.log('Service is already running.');
      return;
    }

    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });

    child.unref();
    ensureConfigDir();
    fs.writeFileSync(PID_FILE, String(child.pid), 'utf-8');
    console.log(`Service started (PID: ${child.pid})`);
    console.log('Run "paperfly url" to get your access URL.');
  });

program
  .command('stop')
  .description('Stop the remote desktop service')
  .action(() => {
    const pid = getRunningPid();
    if (!pid) {
      console.log('Service is not running.');
      return;
    }

    try {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {}
    }

    if (fs.existsSync(PID_FILE)) {
      fs.unlinkSync(PID_FILE);
    }
    console.log('Service stopped.');
  });

program
  .command('restart')
  .description('Restart the remote desktop service')
  .action(() => {
    const pid = getRunningPid();
    if (pid) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
      } catch {
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
      if (fs.existsSync(PID_FILE)) {
        fs.unlinkSync(PID_FILE);
      }
      console.log('Service stopped.');
    }

    setTimeout(() => {
      const child = spawn(process.execPath, [SERVER_SCRIPT], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
      ensureConfigDir();
      fs.writeFileSync(PID_FILE, String(child.pid), 'utf-8');
      console.log(`Service restarted (PID: ${child.pid})`);
    }, 1000);
  });

program
  .command('status')
  .description('Check service status')
  .action(() => {
    if (isRunning()) {
      const pid = fs.readFileSync(PID_FILE, 'utf-8').trim();
      console.log(`Service is running (PID: ${pid})`);
    } else {
      console.log('Service is not running.');
    }
  });

program
  .command('url')
  .description('Show your remote access URL')
  .action(() => {
    const config = loadConfig();
    const tunnelUrl = config.tunnel?.url || config.tunnelUrl;
    if (tunnelUrl) {
      console.log(`\nRemote Desktop URL: ${tunnelUrl}\n`);
    } else {
      console.log('Tunnel URL not available. Make sure the service is running.');
    }
    // Also hint at the worker dashboard if configured
    const workerEndpoint = config.urlWorker?.endpoint;
    if (workerEndpoint) {
      const dashboardUrl = workerEndpoint.replace(/\/api\/url$/, '');
      console.log(`Worker Dashboard:    ${dashboardUrl}`);
    }
  });

if (process.argv.length === 2) {
  console.log(`\x1b[36m
  ____                        __ _       
 |  _ \\ __ _ _ __   ___ _ __ / _| |_   _ 
 | |_) / _\` | '_ \\ / _ \\ '__| |_| | | | |
 |  __/ (_| | |_) |  __/ |  |  _| | |_| |
 |_|   \\__,_| .__/ \\___|_|  |_| |_|\\__, |
            |_|                    |___/ 
\x1b[0m`);
  process.exit(0);
}

program.parse();
