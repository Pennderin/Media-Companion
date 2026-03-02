// ═══════════════════════════════════════════════════════════════════
// Media Companion (Docker) — PWA frontend + proxy to Media Manager
// ═══════════════════════════════════════════════════════════════════

const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MANAGER_URL = process.env.MANAGER_URL || 'http://media-manager:9876';
const PORT = parseInt(process.env.PORT) || 3000;
const CONFIG_DIR = process.env.CONFIG_DIR || '/config';
const CONFIG_PATH = path.join(CONFIG_DIR, 'companion.json');

// ========== COMPANION CONFIG ==========
const DEFAULT_CONFIG = {
  server: { port: 3000, pin: '' },
  managerUrl: MANAGER_URL,
  preferences: { quality: '1080p', maxSizeGB: 4, maxSizeGBTV: 60, minSeeders: 5 },
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return { ...DEFAULT_CONFIG, ...data };
    }
  } catch (e) { console.error('[config] Failed to load:', e.message); }
  return { ...DEFAULT_CONFIG };
}
function saveConfig(cfg) {
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) { console.error('[config] Save failed:', e.message); }
}

let config = loadConfig();
if (!fs.existsSync(CONFIG_PATH)) saveConfig(config);

// ========== EXPRESS ==========
const app = express();
app.use(express.json());

// Serve PWA static files
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// ========== PIN AUTH ==========
function requirePin(req, res, next) {
  if (!config.server.pin) return next();
  const pin = req.headers['x-pin'] || req.query.pin;
  if (pin === config.server.pin) return next();
  res.status(401).json({ error: 'Invalid PIN' });
}

// ========== LOCAL ENDPOINTS ==========
// Companion-specific config
app.get('/api/companion/config', requirePin, (req, res) => {
  res.json({ managerUrl: config.managerUrl, preferences: config.preferences, pin: !!config.server.pin });
});

app.put('/api/companion/config', requirePin, (req, res) => {
  Object.assign(config, req.body);
  saveConfig(config);
  res.json({ success: true });
});

// Request tracking (local to companion)
const REQUESTS_PATH = path.join(CONFIG_DIR, 'requests.json');

function loadRequests() {
  try { if (fs.existsSync(REQUESTS_PATH)) return JSON.parse(fs.readFileSync(REQUESTS_PATH, 'utf8')); } catch (e) {}
  return [];
}
function saveRequests(r) {
  try { fs.writeFileSync(REQUESTS_PATH, JSON.stringify(r, null, 2)); } catch (e) {} 
}

app.get('/api/requests', requirePin, (req, res) => {
  res.json(loadRequests());
});

app.post('/api/requests', requirePin, (req, res) => {
  const requests = loadRequests();
  const entry = { id: Date.now().toString(), ...req.body, timestamp: new Date().toISOString() };
  requests.unshift(entry);
  if (requests.length > 100) requests.length = 100;
  saveRequests(requests);
  res.json({ success: true, request: entry });
});

app.delete('/api/requests/:id', requirePin, (req, res) => {
  let requests = loadRequests();
  requests = requests.filter(r => r.id !== req.params.id);
  saveRequests(requests);
  res.json({ success: true });
});

// ========== PROXY TO MEDIA MANAGER SERVER ==========
// All /api/* calls that aren't companion-specific get proxied
app.use('/api', requirePin, createProxyMiddleware({
  target: config.managerUrl,
  changeOrigin: true,
  pathRewrite: { '^/api': '/api' },
  on: {
    error: (err, req, res) => {
      console.error(`[proxy] Error reaching Media Manager: ${err.message}`);
      res.status(502).json({ error: `Cannot reach Media Manager at ${config.managerUrl}: ${err.message}` });
    }
  }
}));

// Also proxy magnet, auto-grab, status, ping endpoints
for (const ep of ['/magnet', '/auto-grab', '/status', '/ping']) {
  app.use(ep, createProxyMiddleware({
    target: config.managerUrl,
    changeOrigin: true,
    on: {
      error: (err, req, res) => {
        res.status(502).json({ error: `Cannot reach Media Manager: ${err.message}` });
      }
    }
  }));
}

// PWA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== START ==========
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

app.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('  🏴‍☠️  Media Companion (Docker)');
  console.log('  ────────────────────────────');
  console.log(`  PWA:       http://localhost:${PORT}`);
  console.log(`  Network:   http://${ip}:${PORT}`);
  console.log(`  Manager:   ${config.managerUrl}`);
  console.log(`  PIN:       ${config.server.pin || '(none — open access)'}`);
  console.log('');
});
