// Main application logic
const socket = io({
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: Infinity
});

let connected = false;
let latency = 0;
let latencyInterval = null;

// Session check
(async function checkAuth() {
  try {
    const res = await fetch('/api/auth/status');
    const data = await res.json();
    if (!data.authenticated) {
      window.location.href = '/login.html';
    }
  } catch (e) {
    window.location.href = '/login.html';
  }
})();

// Tab switching
document.querySelectorAll('.tab[data-tab]').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    const target = document.getElementById(tab.dataset.tab + '-tab');
    if (target) target.classList.add('active');
    window.dispatchEvent(new CustomEvent('tab-change', { detail: tab.dataset.tab }));
  });
});

// Logout
document.getElementById('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

// Connection status
socket.on('connect', () => {
  connected = true;
  updateStatus('Connected', 'success');
  startLatencyCheck();
});

socket.on('disconnect', () => {
  connected = false;
  updateStatus('Disconnected', 'danger');
  stopLatencyCheck();
});

socket.on('reconnecting', () => {
  updateStatus('Reconnecting...', 'warning');
});

socket.on('reconnect', () => {
  connected = true;
  updateStatus('Reconnected', 'success');
  showNotification('Reconnected to server', 'success');
});

// Latency measurement
function startLatencyCheck() {
  latencyInterval = setInterval(() => {
    const start = Date.now();
    socket.emit('ping-latency', () => {
      latency = Date.now() - start;
      updateLatencyDisplay();
    });
  }, 2000);
}

function stopLatencyCheck() {
  if (latencyInterval) clearInterval(latencyInterval);
}

// Status bar update
function updateStatus(text, type) {
  const el = document.getElementById('connection-status');
  if (el) {
    const icon = el.querySelector('i');
    if (icon) icon.className = 'fas fa-circle text-' + type;
    el.childNodes[el.childNodes.length - 1].textContent = ' ' + text;
  }
}

function updateLatencyDisplay() {
  const el = document.getElementById('latency-display');
  if (el) el.textContent = latency + ' ms';
}

// Toast notifications
function showNotification(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.innerHTML = '<span>' + message + '</span><button class="toast-close">&times;</button>';
  container.appendChild(toast);
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  setTimeout(() => {
    toast.classList.add('toast-fade');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Mobile detection
function isMobile() {
  return window.innerWidth < 768 || 'ontouchstart' in window;
}

// Utility: format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Utility: format date
function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Tunnel URL display
async function fetchAndShowTunnelUrl() {
  try {
    const res = await fetch('/api/tunnel/url');
    if (!res.ok) return;
    const data = await res.json();
    const el = document.getElementById('tunnel-url');
    if (!el) return;
    if (data.url) {
      el.innerHTML = '<i class="fas fa-link"></i> <a href="' + data.url + '" target="_blank" rel="noopener noreferrer" class="tunnel-link">' + data.url + '</a>';
      el.title = 'Remote access URL — click to open';
    } else {
      el.innerHTML = '<i class="fas fa-link"></i> <span class="tunnel-no-url">No tunnel URL yet</span>';
      el.title = 'Start the Paperfly service to get a tunnel URL';
    }
  } catch (e) {
    // silently ignore if endpoint not available
  }
}

// Fetch tunnel URL on load and every 30 seconds
fetchAndShowTunnelUrl();
setInterval(fetchAndShowTunnelUrl, 30000);

// Inject top-right & bottom-left CRT corner brackets into the screen container
document.addEventListener('DOMContentLoaded', () => {
  const sc = document.querySelector('.screen-container');
  if (sc) {
    const tr = document.createElement('div');
    tr.className = 'corner-tr';
    const bl = document.createElement('div');
    bl.className = 'corner-bl';
    sc.appendChild(tr);
    sc.appendChild(bl);
  }
});
