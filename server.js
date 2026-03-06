const express = require('express');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');

// ========== MANAGER URL ==========
const MANAGER_URL = process.env.MANAGER_URL || 'http://127.0.0.1:9876';

async function managerFetch(endpoint, opts = {}) {
  const url = `${MANAGER_URL}${endpoint}`;
  return fetch(url, { signal: AbortSignal.timeout(opts.timeout || 10000), ...opts });
}

// ========== SMS (proxied through Media Manager) ==========
const SMS_CONFIG_FILE = process.env.CONFIG_DIR
  ? path.join(process.env.CONFIG_DIR, 'sms-config.json')
  : path.join(__dirname, 'sms-config.json');
function loadSmsConfig() {
  try { return JSON.parse(fs.readFileSync(SMS_CONFIG_FILE, 'utf8')); } catch { return {}; }
}
function saveSmsConfig(cfg) {
  fs.writeFileSync(SMS_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
async function sendSms(message, phone, carrier) {
  if (!phone || !carrier) return;
  try {
    const r = await managerFetch('/api/sms/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, carrier, message }),
    });
    const data = await r.json();
    if (!data.success) console.log('[sms] Media Manager send failed:', data.error);
    else console.log(`[sms] Sent via Media Manager to ${phone}@${carrier}`);
  } catch (e) { console.log('[sms] Could not reach Media Manager:', e.message); }
}

// Allow self-signed certs
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));

// ========== CONFIG ==========
let CONFIG_PATH = process.env.CONFIG_DIR ? path.join(process.env.CONFIG_DIR, 'config.json') : path.join(__dirname, 'config.json');
function setConfigPath(p) { CONFIG_PATH = p; config = loadConfig(); if (!fs.existsSync(CONFIG_PATH)) saveConfig(config); }

const REQUESTS_DIR_OVERRIDE = { dir: process.env.CONFIG_DIR || null };
function setRequestsPath(p) { REQUESTS_DIR_OVERRIDE.dir = p; }

const DEFAULT_CONFIG = {
  preferences: {
    quality: '1080p',
    maxSizeGB: 4,
    maxSizeGBTV: 60,
    minSeeders: 5,
  },
  server: { port: 3000, pin: '' }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
      for (const section of Object.keys(merged)) {
        if (data[section] && typeof data[section] === 'object') Object.assign(merged[section], data[section]);
        else if (data[section] !== undefined) merged[section] = data[section];
      }
      return merged;
    }
  } catch (e) { console.error('[config] Failed to load:', e.message); }
  return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

function saveConfig(cfg) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); }
let config = loadConfig();

// ========== PUSH NOTIFICATIONS ==========
const VAPID_PATH = process.env.CONFIG_DIR
  ? path.join(process.env.CONFIG_DIR, 'vapid.json')
  : path.join(__dirname, 'vapid.json');

function getVapidKeys() {
  if (fs.existsSync(VAPID_PATH)) {
    try { return JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8')); } catch {}
  }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_PATH, JSON.stringify(keys, null, 2));
  return keys;
}

const vapidKeys = getVapidKeys();
webpush.setVapidDetails('mailto:media-companion@local', vapidKeys.publicKey, vapidKeys.privateKey);

async function sendPush(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      urgency: 'high',
      headers: { 'apns-priority': '10', 'apns-push-type': 'alert', 'interruption-level': 'time-sensitive' }
    });
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      const reqs = loadRequests();
      const cleaned = reqs.map(r => JSON.stringify(r.pushSubscription) === JSON.stringify(subscription)
        ? (({ pushSubscription, ...rest }) => rest)(r) : r);
      saveRequests(cleaned);
    }
  }
}

function requireAuth(req, res, next) {
  if (!config.server.pin) return next();
  const pin = req.headers['x-pin'] || req.query.pin;
  if (pin === config.server.pin) return next();
  res.status(401).json({ error: 'Invalid PIN' });
}

// ========== REQUESTS LOG ==========
function getRequestsPath() {
  return REQUESTS_DIR_OVERRIDE.dir
    ? path.join(REQUESTS_DIR_OVERRIDE.dir, 'requests.json')
    : path.join(__dirname, 'requests.json');
}
function loadRequests() {
  try { const p = getRequestsPath(); if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  return [];
}
function saveRequests(reqs) {
  try { const p = getRequestsPath(); fs.writeFileSync(p, JSON.stringify(reqs, null, 2)); console.log(`[requests] Saved ${reqs.length} requests`); }
  catch (e) { console.error('[requests] Save failed:', e.message); }
}

// ========== API ROUTES ==========

app.get('/api/health', (req, res) => { res.json({ status: 'ok', app: 'Media Companion' }); });

// Push subscription
app.get('/api/push/vapid-public-key', (req, res) => { res.json({ publicKey: vapidKeys.publicKey }); });
app.post('/api/push/subscribe', requireAuth, (req, res) => { res.json({ success: true }); });

// SMS
app.get('/api/sms/config', requireAuth, (req, res) => {
  const cfg = loadSmsConfig();
  res.json({ phone: cfg.phone || '', carrier: cfg.carrier || '' });
});
app.post('/api/sms/config', requireAuth, (req, res) => {
  const { phone, carrier } = req.body;
  const existing = loadSmsConfig();
  if (phone !== undefined) existing.phone = phone;
  if (carrier !== undefined) existing.carrier = carrier;
  saveSmsConfig(existing);
  res.json({ success: true });
});
app.post('/api/sms/test', requireAuth, async (req, res) => {
  try {
    const phone = (req.body.smsPhone || '').replace(/\D/g, '');
    const carrier = req.body.smsCarrier || '';
    if (!phone || !carrier) return res.json({ success: false, error: 'Phone and carrier required' });
    const r = await managerFetch('/api/sms/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone, carrier }) });
    res.json(await r.json());
  } catch (e) { res.json({ success: false, error: 'Could not reach Media Manager: ' + e.message }); }
});

// Config
app.get('/api/config', requireAuth, (req, res) => {
  res.json({ configured: true, hasPin: !!config.server.pin, preferences: config.preferences });
});
app.post('/api/config', requireAuth, (req, res) => {
  try {
    const updates = req.body;
    if (updates.preferences) config.preferences = { ...config.preferences, ...updates.preferences };
    if (updates.server) config.server = { ...config.server, ...updates.server };
    saveConfig(config);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Plex check — proxy to Media Manager
app.get('/api/plex/check', requireAuth, async (req, res) => {
  try {
    const { title, type, year } = req.query;
    if (!title) return res.status(400).json({ error: 'Title required' });
    const params = new URLSearchParams({ title, type: type || 'movie', ...(year ? { year } : {}) });
    const r = await managerFetch(`/api/plex/check?${params}`, { timeout: 6000 });
    res.json(await r.json());
  } catch (e) { res.json({ configured: false }); }
});

// Search — proxy to Media Manager TMDB
app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });
    const params = new URLSearchParams({ q, ...(type ? { type } : {}) });
    const r = await managerFetch(`/api/tmdb/search?${params}`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// IMDB lookup — proxy
app.get('/api/imdb/:id', requireAuth, async (req, res) => {
  try {
    const r = await managerFetch(`/api/tmdb/imdb/${req.params.id}`);
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// TV details — proxy
app.get('/api/tv/:tmdbId', requireAuth, async (req, res) => {
  try {
    const r = await managerFetch(`/api/tmdb/tv/${req.params.tmdbId}`);
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tv/:tmdbId/season/:num', requireAuth, async (req, res) => {
  try {
    const r = await managerFetch(`/api/tmdb/tv/${req.params.tmdbId}/season/${req.params.num}`);
    res.status(r.status).json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ========== GET — one-tap grab via Media Manager smart-grab ==========
app.post('/api/get', requireAuth, async (req, res) => {
  try {
    let { title, year, type, tmdbId, skipPlexCheck, tvMode, tvSeason, tvEpisode } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });

    // Call Media Manager's smart-grab with our preferences
    const grabRes = await managerFetch('/api/smart-grab', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title, year, type, tmdbId, skipPlexCheck,
        tvMode, tvSeason, tvEpisode,
        preferences: config.preferences,
      }),
      timeout: 60000,
    });

    const grabData = await grabRes.json();

    // Pass through errors from smart-grab
    if (!grabRes.ok) return res.status(grabRes.status).json(grabData);

    // Log the request locally
    const requests = loadRequests();
    const pushSubscription = req.body.pushSubscription || null;
    const smsPhone = (req.body.smsPhone || '').replace(/\D/g, '');
    const smsCarrier = req.body.smsCarrier || '';
    const contentType = type || 'movie';
    const requestLabel = grabData.requestLabel || title;
    const best = grabData.torrent || {};

    const newRequest = {
      id: Date.now(),
      title: requestLabel, year, type: contentType,
      tvMode: grabData.tvMode || tvMode || null,
      tvSeason: grabData.tvSeason || tvSeason || null,
      tvEpisode: grabData.tvEpisode || tvEpisode || null,
      torrent: best.title || title,
      size: best.size || 0,
      seeders: best.seeders || 0,
      indexer: best.indexer || '',
      quality: /2160p|4k/i.test(best.title || '') ? '4K' : /1080p/i.test(best.title || '') ? '1080p' : /720p/i.test(best.title || '') ? '720p' : 'Unknown',
      method: 'media-manager',
      status: 'sent',
      timestamp: new Date().toISOString(),
      minPipelineJobId: grabData.minPipelineJobId || 0,
      pushSubscription,
      smsPhone: smsPhone || null,
      smsCarrier: smsCarrier || null,
    };

    // Deduplicate
    const deduped = requests.filter(r => {
      const sameItem = r.title === requestLabel && r.tvMode === (grabData.tvMode || tvMode || null) &&
        r.tvSeason === (grabData.tvSeason || tvSeason || null) && r.tvEpisode === (grabData.tvEpisode || tvEpisode || null);
      const samePhoneAndItem = smsPhone && r.smsPhone === smsPhone && r.title === requestLabel;
      return !sameItem && !samePhoneAndItem;
    });
    deduped.unshift(newRequest);
    if (deduped.length > 100) deduped.length = 100;
    saveRequests(deduped);

    res.json({ success: true, message: grabData.message, torrent: best });
  } catch (e) {
    console.error('[get] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ========== TOP 20 (proxy to Media Manager) ==========
app.get('/api/top/indexers', requireAuth, async (req, res) => {
  try { const r = await managerFetch('/api/prowlarr/indexers', { timeout: 5000 }); res.json(await r.json()); }
  catch (e) { res.json({ success: false, error: e.message }); }
});
app.post('/api/top/browse', requireAuth, async (req, res) => {
  try {
    const r = await managerFetch('/api/prowlarr/browse', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body), timeout: 30000,
    });
    res.json(await r.json());
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ========== REQUESTS + ENRICHMENT ==========
const stepStartTimes = {};
const notifiedIds = new Set();

app.get('/api/requests', requireAuth, async (req, res) => {
  const requests = loadRequests();
  if (!requests.length) return res.json({ success: true, requests: [] });
  try {
    const enriched = await Promise.race([
      enrichRequests(requests),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    ]);

    // Notify completed items
    const completed = enriched.filter(r => r.live?.completed);
    for (const r of completed) {
      if (!notifiedIds.has(r.id)) {
        notifiedIds.add(r.id);
        const label = r.tvMode === 'season' ? ` S${String(r.tvSeason || '').padStart(2, '0')}`
          : r.tvMode === 'episode' ? ` S${String(r.tvSeason || '').padStart(2, '0')}E${String(r.tvEpisode || '').padStart(2, '0')}` : '';
        const message = `✅ ${r.title}${label} is ready in Plex`;
        if (r.pushSubscription) {
          sendPush(r.pushSubscription, {
            title: '✅ Ready in Plex', body: `${r.title}${label} is available`,
            icon: '/icon-192.png', badge: '/icon-192.png', tag: `complete-${r.id}`,
          }).catch(e => console.log(`[push] Failed: ${e.message}`));
        }
        sendSms(message, r.smsPhone, r.smsCarrier).catch(e => console.log(`[sms] Failed: ${e.message}`));
      }
    }

    const active = enriched.filter(r => !r.live?.completed);
    if (active.length < enriched.length) saveRequests(requests.filter((_, i) => !enriched[i]?.live?.completed));
    return res.json({ success: true, requests: active });
  } catch (e) {
    console.error('[requests] Enrichment failed:', e.message);
    return res.json({ success: true, requests });
  }
});

async function enrichRequests(requests) {
  // Get torrent status from Media Manager (which proxies qBit)
  let torrents = [];
  try {
    const r = await managerFetch('/api/qbit/torrents', { timeout: 5000 });
    if (r.ok) { const data = await r.json(); torrents = data.torrents || []; }
  } catch (e) { console.log('[requests] qBit via MM unreachable:', e.message); }

  // Get pipeline status
  let pipelineJobs = [];
  try {
    const r = await managerFetch('/status', { timeout: 2000 });
    if (r.ok) { const data = await r.json(); pipelineJobs = data.jobs || []; }
  } catch {}

  const now = Date.now();

  return requests.map(r => {
    try {
      const match = torrents.find(t => {
        const tName = (t.name || '').toLowerCase();
        const rTorrent = (r.torrent || '').toLowerCase();
        return tName && rTorrent && (tName.includes(rTorrent.slice(0, 30)) || rTorrent.includes(tName.slice(0, 30)));
      });

      const pipelineJob = pipelineJobs.find(j => {
        const jName = (j.name || '').toLowerCase();
        const rTitle = (r.title || '').toLowerCase();
        const rTorrent = (r.torrent || '').toLowerCase();
        const nameMatch = (jName && rTitle && jName.includes(rTitle.slice(0, 20))) ||
          (jName && rTorrent && (jName.includes(rTorrent.slice(0, 30)) || rTorrent.includes(jName.slice(0, 30))));
        if (!nameMatch) return false;
        if (r.minPipelineJobId && j.id < r.minPipelineJobId) return false;
        return true;
      });

      if (!match && !pipelineJob) {
        const age = now - new Date(r.timestamp).getTime();
        if (age > 3600000) return { ...r, live: { pipelineStep: 'In Plex', completed: true, etaToPlex: 0 } };
        return r;
      }

      const sizeMB = ((match && match.size) || r.size || 0) / (1024 * 1024);
      const isTV = r.type === 'tv';
      const sftpSpeed = isTV ? 65 : 25;
      const sftpEstimate = Math.round(sizeMB / sftpSpeed);
      const estFileCount = isTV ? Math.max(Math.round(sizeMB / 400), 1) : 1;
      const renameEstimate = 10 + (estFileCount * 2);
      const moveEstimate = Math.round(sizeMB / 100);
      const postDownloadEstimate = sftpEstimate + renameEstimate + moveEstimate;

      const progress = match ? Math.round(match.progress * 100) : 100;
      const isDownloading = match && ['downloading', 'forcedDL', 'metaDL', 'queuedDL', 'stalledDL', 'checkingDL'].includes(match.state);
      const isSeeding = match && ['uploading', 'stalledUP'].includes(match.state);
      const isDone = progress >= 100;
      const dlEta = (match && isDownloading && match.eta > 0 && match.eta < 8640000) ? match.eta : 0;

      let pipelineStep = '';
      if (pipelineJob) {
        const step = pipelineJob.step || '';
        const pStatus = pipelineJob.status || '';
        if (pStatus === 'complete' || pStatus === 'done') return { ...r, live: { pipelineStep: 'In Plex', completed: true, etaToPlex: 0 } };
        if (pStatus === 'failed') return { ...r, live: { pipelineStep: 'Failed', completed: false, etaToPlex: 0 } };
        if (step === 'grabbing') pipelineStep = 'Starting';
        else if (step === 'waiting_torrent') pipelineStep = 'Downloading';
        else if (step === 'transferring') pipelineStep = 'Transferring';
        else if (step === 'renaming') pipelineStep = 'Renaming';
        else if (step === 'moving') pipelineStep = 'Moving to NAS';
        else pipelineStep = step || 'Processing';
      } else if (isDownloading && !isDone) pipelineStep = 'Downloading';
      else if (isDone && isSeeding) pipelineStep = 'Waiting for transfer';
      else if (isDone) pipelineStep = 'Processing';

      const rid = r.id;
      const tracked = stepStartTimes[rid];
      const stepEstimates = {
        'Starting': dlEta + postDownloadEstimate, 'Downloading': dlEta + postDownloadEstimate,
        'Waiting for transfer': postDownloadEstimate, 'Transferring': sftpEstimate + renameEstimate + moveEstimate,
        'Renaming': renameEstimate + moveEstimate, 'Moving to NAS': moveEstimate, 'Processing': postDownloadEstimate,
      };
      if (!tracked || tracked.step !== pipelineStep) {
        stepStartTimes[rid] = { step: pipelineStep, startedAt: now, totalEstimate: stepEstimates[pipelineStep] || postDownloadEstimate };
      }
      const track = stepStartTimes[rid];
      let etaToPlex;
      if (pipelineStep === 'Downloading' && dlEta > 0) {
        etaToPlex = dlEta + postDownloadEstimate;
        track.totalEstimate = etaToPlex;
      } else {
        const elapsed = Math.floor((now - track.startedAt) / 1000);
        etaToPlex = Math.max(0, track.totalEstimate - elapsed);
      }

      return {
        ...r,
        live: { pipelineStep, progress, dlspeed: match ? (match.dlspeed || 0) : 0, etaToPlex, size: match ? match.size : r.size, completed: false, seeding: !!isSeeding }
      };
    } catch (e) { return r; }
  });
}

// Queue — proxy to Media Manager qBit
app.get('/api/queue', requireAuth, async (req, res) => {
  try {
    const r = await managerFetch('/api/qbit/torrents', { timeout: 5000 });
    const data = await r.json();
    const active = (data.torrents || [])
      .filter(t => t.category !== 'Long Seed')
      .map(t => ({ name: t.name, progress: Math.round(t.progress * 100), state: t.state, size: t.size, dlspeed: t.dlspeed, eta: t.eta }));
    res.json({ success: true, torrents: active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/requests-debug', (req, res) => {
  try { const r = loadRequests(); res.json({ count: r.length, requests: r }); }
  catch (e) { res.json({ error: e.message }); }
});

// PWA fallback
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

// ========== BACKGROUND PUSH CHECKER ==========
async function checkCompletionsAndNotify() {
  const requests = loadRequests();
  const pending = requests.filter(r => r.pushSubscription && !notifiedIds.has(r.id));
  if (!pending.length) return;
  console.log(`[push-checker] Checking ${pending.length} pending requests...`);
  try {
    const enriched = await Promise.race([
      enrichRequests(pending),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
    ]);
    for (const r of enriched) {
      if (!r.live?.completed || notifiedIds.has(r.id)) continue;
      notifiedIds.add(r.id);
      const label = r.tvMode === 'season' ? ` S${String(r.tvSeason || '').padStart(2, '0')}`
        : r.tvMode === 'episode' ? ` S${String(r.tvSeason || '').padStart(2, '0')}E${String(r.tvEpisode || '').padStart(2, '0')}` : '';
      const message = `✅ ${r.title}${label} is ready in Plex`;
      if (r.pushSubscription) {
        await sendPush(r.pushSubscription, {
          title: '✅ Ready in Plex', body: `${r.title}${label} is available`,
          icon: '/icon-192.png', badge: '/icon-192.png', tag: `complete-${r.id}`,
        }).catch(e => console.log(`[push] Failed: ${e.message}`));
      }
      await sendSms(message, r.smsPhone, r.smsCarrier).catch(e => console.log(`[sms] Failed: ${e.message}`));
    }
  } catch (e) { console.log(`[push-checker] Error: ${e.message}`); }
}
setInterval(checkCompletionsAndNotify, 30000);

// ========== START ==========
function getLocalIP() {
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) { if (net.family === 'IPv4' && !net.internal) return net.address; }
  }
  return 'localhost';
}

function startServer(port) {
  const p = port || parseInt(process.env.PORT) || config.server.port || 3000;
  return new Promise((resolve) => {
    const server = app.listen(p, '0.0.0.0', () => {
      const ip = getLocalIP();
      console.log(`\n  🏴‍☠️  Media Companion`);
      console.log(`  ────────────────────`);
      console.log(`  Running on http://localhost:${p}`);
      console.log(`  Network:   http://${ip}:${p}`);
      console.log(`  Manager:   ${MANAGER_URL}`);
      console.log(`  PIN:       ${config.server.pin || '(none — open access)'}\n`);
      resolve({ server, port: p, ip });
    });
  });
}

if (require.main === module) startServer();

function reloadConfig() { config = loadConfig(); return config; }

module.exports = { app, startServer, getLocalIP, loadConfig, saveConfig, reloadConfig, config, loadRequests, setConfigPath, setRequestsPath };
