const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');

const CONFIG_DIR = path.join(os.homedir(), '.paperfly');
const PID_FILE = path.join(CONFIG_DIR, 'server.pid');
const TASK_NAME = 'PaperflyService';

function killRunningProcess() {
  if (!fs.existsSync(PID_FILE)) return;

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
  try {
    execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    console.log(`  Stopped running process (PID: ${pid})`);
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`  Stopped running process (PID: ${pid})`);
    } catch {}
  }

  try {
    fs.unlinkSync(PID_FILE);
  } catch {}
}

function removeScheduledTask() {
  try {
    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue"`,
      { stdio: 'pipe' }
    );
    console.log('  Removed scheduled task: PaperflyService');
  } catch {
    console.log('  Scheduled task not found or already removed.');
  }
}

function promptConfigCleanup() {
  console.log(`\n  Config directory preserved at: ${CONFIG_DIR}`);
  console.log('  To remove it manually, delete that folder.');
}

function main() {
  console.log('\n========================================');
  console.log('  Paperfly - Uninstalling');
  console.log('========================================\n');

  console.log('[1/3] Stopping running service...');
  killRunningProcess();

  console.log('[2/3] Removing scheduled task...');
  removeScheduledTask();

  console.log('[3/3] Cleanup...');
  promptConfigCleanup();

  console.log('\n========================================');
  console.log('  Uninstall Complete');
  console.log('========================================\n');
}

main();
