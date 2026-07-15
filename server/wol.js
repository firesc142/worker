const wol = require('wake_on_lan');
const os = require('os');
const path = require('path');
const fs = require('fs');

const CONFIG_DIR = path.join(os.homedir(), '.remote-desktop');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

function handleConnection(socket) {
  socket.on('wol-get-mac', () => {
    try {
      const macs = getMacAddresses();
      socket.emit('wol-mac-data', macs);
    } catch (err) {
      socket.emit('wol-error', { message: err.message });
    }
  });

  socket.on('wol-send', ({ mac, broadcastAddr }) => {
    const opts = {};
    if (broadcastAddr) opts.address = broadcastAddr;

    wol.wake(mac, opts, (err) => {
      if (err) {
        socket.emit('wol-result', { success: false, message: err.message });
      } else {
        socket.emit('wol-result', { success: true, message: `Magic packet sent to ${mac}` });
      }
    });
  });

  socket.on('wol-get-targets', () => {
    try {
      const targets = getTargets();
      socket.emit('wol-targets-data', targets);
    } catch (err) {
      socket.emit('wol-error', { message: err.message });
    }
  });

  socket.on('wol-save-targets', ({ targets }) => {
    try {
      saveTargets(targets);
      socket.emit('wol-targets-saved', { success: true });
    } catch (err) {
      socket.emit('wol-error', { message: err.message });
    }
  });
}

function getMacAddresses() {
  const interfaces = os.networkInterfaces();
  const macs = [];

  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs) {
      if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') {
        macs.push({
          iface: name,
          mac: addr.mac,
          ip: addr.address,
          family: addr.family,
        });
        break;
      }
    }
  }

  return macs;
}

function getTargets() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    return config.wol_targets || [];
  } catch {
    return [];
  }
}

function saveTargets(targets) {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    // fresh config
  }
  config.wol_targets = targets;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

module.exports = { handleConnection };
