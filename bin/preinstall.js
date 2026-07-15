const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.paperfly');
const PID_FILE = path.join(CONFIG_DIR, 'server.pid');

function killRunningProcess() {
  if (!fs.existsSync(PID_FILE)) return;

  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
    console.log(`[preinstall] Attempting to stop Paperfly process (PID: ${pid}) to release file locks...`);
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
    console.log(`[preinstall] Successfully stopped running service.`);
  } catch (err) {
    console.log(`[preinstall] Error stopping service: ${err.message}`);
  }
}

killRunningProcess();
