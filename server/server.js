const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { getConfig, CONFIG_DIR } = require('./config');
const { router: authRouter, requireAuth, socketAuthMiddleware } = require('./auth');
const { startTunnel, stopTunnel, getTunnelUrl } = require('./tunnel');

const config = getConfig();
const PORT = config.port || 3000;
const PID_FILE = path.join(CONFIG_DIR, 'server.pid');

const app = express();
const server = http.createServer(app);

const sessionMiddleware = session({
  secret: config.session_secret || config.sessionSecret || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000
  }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

app.use(authRouter);
app.use(requireAuth);
app.use(express.static(path.join(__dirname, '../public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.get('/api/tunnel/url', (req, res) => {
  res.json({ url: getTunnelUrl() });
});

const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 10 * 1024 * 1024
});

io.engine.use(sessionMiddleware);
io.use((socket, next) => {
  const req = socket.request;
  if (!req.session) {
    sessionMiddleware(req, {}, () => {
      socketAuthMiddleware(socket, next);
    });
  } else {
    socketAuthMiddleware(socket, next);
  }
});

// Register socket handlers (wrapped in try/catch for modules not yet built)
const handlers = ['screen', 'monitors', 'privacy', 'terminal', 'clipboard', 'audio', 'wol'];
const loadedHandlers = {};

handlers.forEach((name) => {
  try {
    loadedHandlers[name] = require(`./${name}`);
  } catch (err) {
    console.log(`[server] Module ./${name} not yet available: ${err.message}`);
  }
});

io.on('connection', (socket) => {
  console.log(`[server] Client connected: ${socket.id}`);

  socket.on('ping-latency', (callback) => {
    if (typeof callback === 'function') callback();
  });

  Object.entries(loadedHandlers).forEach(([name, handler]) => {
    if (handler && typeof handler.handleConnection === 'function') {
      try {
        handler.handleConnection(socket, io);
      } catch (err) {
        console.error(`[server] Error in ${name}.handleConnection: ${err.message}`);
      }
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(`[server] Client disconnected: ${socket.id} (${reason})`);
    Object.entries(loadedHandlers).forEach(([name, handler]) => {
      if (handler && typeof handler.handleDisconnect === 'function') {
        try {
          handler.handleDisconnect(socket);
        } catch (err) {
          console.error(`[server] Error in ${name}.handleDisconnect: ${err.message}`);
        }
      }
    });
  });
});

// Mount file routes (REST-based)
try {
  const filesRouter = require('./files');
  app.use('/api/files', filesRouter);
} catch (err) {
  console.log(`[server] Files module not yet available: ${err.message}`);
}

// Write PID file
function writePidFile() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

async function start() {
  writePidFile();

  server.listen(PORT, '127.0.0.1', async () => {
    console.log(`[server] Running on http://127.0.0.1:${PORT}`);
    const url = await startTunnel(PORT);
    if (url) {
      console.log(`[server] Remote access: ${url}`);
    } else {
      console.log('[server] Tunnel not connected yet. Run `remote-desktop url` to check later.');
    }
  });
}

function shutdown() {
  console.log('\n[server] Shutting down...');
  stopTunnel();
  removePidFile();
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error('[server] Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[server] Unhandled rejection:', err);
});

start();

module.exports = { app, server, io };
