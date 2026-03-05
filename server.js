const express = require('express');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');

// Allow self-signed/untrusted HTTPS certs (common on seedbox webUIs)
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const app = express();
app.use(express.json());
// Serve static files with cache control
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// ========== CONFIG ==========
// Config path can be set externally for packaged Electron apps (app.asar is read-only)
let CONFIG_PATH = process.env.CONFIG_DIR ? path.join(process.env.CONFIG_DIR, 'config.json') : path.join(__dirname, 'config.json');
function setConfigPath(p) { CONFIG_PATH = p; config = loadConfig(); if (!fs.existsSync(CONFIG_PATH)) saveConfig(config); }

const REQUESTS_DIR_OVERRIDE = { dir: process.env.CONFIG_DIR || null };
function setRequestsPath(p) { REQUESTS_DIR_OVERRIDE.dir = p; }

const DEFAULT_CONFIG = {
  seedbox: { qbitUrl: '', qbitUsername: '', qbitPassword: '', sftpHost: '', sftpPort: 22, sftpUsername: '', sftpPassword: '', sftpRemotePath: '' },
  paths: { staging: '', nasMovies: '', nasTVShows: '', nasKidsMovies: '', nasAsianMovies: '', nasAsianShows: '', nasAnimeMovies: '', nasAnimeShows: '' },
  prowlarr: { url: '', apiKey: '' },
  tmdb: { apiKey: '' },
  plex: {},
  preferences: {
    quality: '1080p',      // preferred quality: 1080p, 4k, 720p, any
    maxSizeGB: 4,          // max torrent size in GB for movies
    maxSizeGBTV: 60,       // max torrent size in GB for TV
    minSeeders: 5,         // minimum seeders
  },
  server: { port: 3000, pin: '' }
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
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let config = loadConfig();

// ========== PUSH NOTIFICATIONS (VAPID) ==========
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
    await webpush.sendNotification(subscription, JSON.stringify(payload));
  } catch (e) {
    if (e.statusCode === 410 || e.statusCode === 404) {
      // Subscription expired — remove it from any matching requests
      const reqs = loadRequests();
      const cleaned = reqs.map(r => {
        if (JSON.stringify(r.pushSubscription) === JSON.stringify(subscription)) {
          const { pushSubscription, ...rest } = r;
          return rest;
        }
        return r;
      });
      saveRequests(cleaned);
    }
  }
}


function requireAuth(req, res, next) {
  if (!config.server.pin) return next(); // no pin = no auth
  const pin = req.headers['x-pin'] || req.query.pin;
  if (pin === config.server.pin) return next();
  res.status(401).json({ error: 'Invalid PIN' });
}

// ========== QBITTORRENT ==========
let qbitCookie = null;

function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function qbitLogin() {
  const s = config.seedbox;
  if (!s.qbitUrl) throw new Error('qBittorrent URL not configured');
  const res = await fetchWithTimeout(`${s.qbitUrl.replace(/\/$/, '')}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `username=${encodeURIComponent(s.qbitUsername)}&password=${encodeURIComponent(s.qbitPassword)}`,
  }, 5000);
  if (res.ok) {
    const c = res.headers.get('set-cookie');
    if (c) qbitCookie = c.split(';')[0];
  } else {
    throw new Error('qBittorrent login failed');
  }
}

async function qbitRequest(endpoint, method = 'GET', body = null) {
  const base = config.seedbox.qbitUrl.replace(/\/$/, '');
  if (!base) throw new Error('qBittorrent URL not configured');
  if (!qbitCookie) await qbitLogin();
  const opts = { method, headers: { 'Cookie': qbitCookie || '' } };
  if (body) { opts.body = body; opts.headers['Content-Type'] = 'application/x-www-form-urlencoded'; }
  const res = await fetchWithTimeout(`${base}${endpoint}`, opts, 5000);
  if (res.status === 403) { qbitCookie = null; await qbitLogin(); return qbitRequest(endpoint, method, body); }
  return res;
}

async function addAndDetect(url, searchName) {
  try {
    const base = config.seedbox.qbitUrl.replace(/\/$/, '');
    const beforeR = await qbitRequest('/api/v2/torrents/info');
    const beforeTs = await beforeR.json();
    const beforeHashes = new Set(beforeTs.map(t => t.hash));

    let addBody, addContentType;
    if (url.startsWith('magnet:')) {
      addBody = `urls=${encodeURIComponent(url)}`;
      addContentType = 'application/x-www-form-urlencoded';
    } else {
      // Download .torrent file first (Prowlarr proxy URLs)
      const prowlarrHeaders = {};
      if (config.prowlarr.apiKey) prowlarrHeaders['X-Api-Key'] = config.prowlarr.apiKey;
      let torrentResp;
      try {
        torrentResp = await fetch(url, { headers: prowlarrHeaders, redirect: 'follow' });
      } catch (fetchErr) {
        // Fallback: let qBit try the URL directly
        if (!qbitCookie) await qbitLogin();
        const directR = await fetch(`${base}/api/v2/torrents/add`, {
          method: 'POST',
          headers: { 'Cookie': qbitCookie || '', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `urls=${encodeURIComponent(url)}`
        });
        if (!directR.ok) throw new Error('Could not download torrent file and qBit also rejected URL');
        addBody = null;
      }

      if (torrentResp) {
        if (!torrentResp.ok) throw new Error(`Prowlarr returned ${torrentResp.status}`);
        const contentType = torrentResp.headers.get('content-type') || '';
        const finalUrl = torrentResp.url || url;

        if (finalUrl.startsWith('magnet:')) {
          addBody = `urls=${encodeURIComponent(finalUrl)}`;
          addContentType = 'application/x-www-form-urlencoded';
        } else if (contentType.includes('text/plain') || contentType.includes('text/html')) {
          const text = await torrentResp.text();
          if (text.trim().startsWith('magnet:')) {
            addBody = `urls=${encodeURIComponent(text.trim())}`;
            addContentType = 'application/x-www-form-urlencoded';
          } else {
            throw new Error(`Expected torrent but got ${contentType}`);
          }
        } else {
          const torrentBuf = Buffer.from(await torrentResp.arrayBuffer());
          const boundary = '----MediaCompanion' + Date.now();
          const header = `--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="torrent.torrent"\r\nContent-Type: application/x-bittorrent\r\n\r\n`;
          addBody = Buffer.concat([Buffer.from(header), torrentBuf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
          addContentType = `multipart/form-data; boundary=${boundary}`;
        }
      }
    }

    if (addBody !== null && addBody !== undefined) {
      if (!qbitCookie) await qbitLogin();
      const addR = await fetch(`${base}/api/v2/torrents/add`, {
        method: 'POST',
        headers: { 'Cookie': qbitCookie || '', 'Content-Type': addContentType },
        body: addBody
      });
      if (!addR.ok) return { success: false, error: `qBittorrent rejected torrent: ${addR.status}` };
    }

    // Poll for new torrent
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const afterR = await qbitRequest('/api/v2/torrents/info');
      const afterTs = await afterR.json();
      const newT = afterTs.find(t => !beforeHashes.has(t.hash));
      if (newT) return { success: true, hash: newT.hash, name: newT.name };
    }

    // Fallback: match by name
    if (searchName) {
      const norm = (s) => s.toLowerCase().replace(/[\.\-\_\(\)\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
      const sn = norm(searchName);
      const finalR = await qbitRequest('/api/v2/torrents/info');
      const finalTs = await finalR.json();
      const match = finalTs.find(t => norm(t.name).startsWith(sn.split(' ').slice(0, 3).join(' ')));
      if (match) return { success: true, hash: match.hash, name: match.name };
    }

    return { success: true, hash: null, name: null };
  } catch (e) { return { success: false, error: e.message }; }
}

// ========== PROWLARR ==========
async function prowlarrSearch(query, searchType = 'search') {
  const cfg = config.prowlarr;
  if (!cfg.url || !cfg.apiKey) throw new Error('Prowlarr not configured');
  const base = cfg.url.replace(/\/$/, '');
  const headers = { 'X-Api-Key': cfg.apiKey, 'Accept': 'application/json' };

  // Get enabled torrent indexers
  const idxRes = await fetch(`${base}/api/v1/indexer`, { headers });
  if (!idxRes.ok) throw new Error(`Failed to get indexers: ${idxRes.status}`);
  const allIndexers = await idxRes.json();
  const torrentIndexers = allIndexers.filter(i => i.enable && i.protocol === 'torrent');
  if (!torrentIndexers.length) throw new Error('No enabled torrent indexers');
  console.log(`[prowlarr] Searching ${torrentIndexers.length} indexers for "${query}" (type: ${searchType})`);

  // Search all indexers in parallel
  const searches = torrentIndexers.map(async (idx) => {
    try {
      const url = `${base}/api/v1/search?query=${encodeURIComponent(query)}&indexerIds=${idx.id}&type=${searchType}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        console.log(`[prowlarr] ${idx.name}: HTTP ${res.status}`);
        return [];
      }
      const data = await res.json();
      console.log(`[prowlarr] ${idx.name}: ${data.length} results`);
      return data;
    } catch (e) {
      console.log(`[prowlarr] ${idx.name}: error — ${e.message}`);
      return [];
    }
  });

  const outcomes = await Promise.all(searches);
  const allResults = [];
  for (const results of outcomes) {
    for (const r of results) {
      let dlUrl = r.downloadUrl || r.magnetUrl || null;
      if (!dlUrl && r.guid && r.guid.startsWith('magnet:')) dlUrl = r.guid;
      allResults.push({
        title: r.title, size: r.size,
        seeders: r.seeders || 0, leechers: r.leechers || 0,
        indexer: r.indexer, downloadUrl: dlUrl,
        publishDate: r.publishDate,
        categories: (r.categories || []).map(c => c.id),
      });
    }
  }
  allResults.sort((a, b) => b.seeders - a.seeders);
  console.log(`[prowlarr] Total: ${allResults.length} results`);
  return allResults;
}

// ========== TMDB ==========
const tmdbCache = new Map();

async function tmdbSearch(query, type = 'movie') {
  const apiKey = config.tmdb.apiKey;
  if (!apiKey) return [];

  const cacheKey = `${type}:${query}`;
  if (tmdbCache.has(cacheKey)) return tmdbCache.get(cacheKey);

  // Extract year if present
  const yearMatch = query.match(/\((\d{4})\)/) || query.match(/\b((?:19|20)\d{2})\b/);
  const year = yearMatch ? yearMatch[1] : null;
  const cleanQuery = query.replace(/\(?\d{4}\)?/, '').trim();

  const mapResults = (data, t) => (data.results || []).slice(0, 10).map(r => ({
    id: r.id,
    title: r.title || r.name,
    year: (r.release_date || r.first_air_date || '').slice(0, 4),
    overview: (r.overview || '').slice(0, 200),
    poster: r.poster_path ? `https://image.tmdb.org/t/p/w300${r.poster_path}` : null,
    rating: r.vote_average ? r.vote_average.toFixed(1) : null,
    type: t,
  }));

  const doSearch = async (q, yr) => {
    const endpoint = type === 'tv' ? 'search/tv' : 'search/movie';
    const yearParam = yr ? `&${type === 'tv' ? 'first_air_date_year' : 'year'}=${yr}` : '';
    const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${apiKey}&query=${encodeURIComponent(q)}${yearParam}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    return mapResults(await res.json(), type);
  };

  // Try 1: exact query with year
  let results = await doSearch(cleanQuery, year);

  // Try 2: without year
  if (results.length === 0 && year) {
    results = await doSearch(cleanQuery, null);
  }

  // Try 3: fuzzy — join short fragments that might be typos (e.g. "gho busters" → "ghostbusters")
  // Also try the query with spaces collapsed between short words
  if (results.length === 0 && cleanQuery.includes(' ')) {
    const words = cleanQuery.split(/\s+/);
    // Try merging adjacent short words (handles "gho busters" → "ghobusters" which TMDB may fuzzy match)
    const merged = words.reduce((acc, w) => {
      if (acc.length && (acc[acc.length - 1].length <= 4 || w.length <= 4)) {
        acc[acc.length - 1] += w;
      } else {
        acc.push(w);
      }
      return acc;
    }, []).join(' ');
    if (merged !== cleanQuery) {
      results = await doSearch(merged, null);
    }
  }

  // Try 4: just search each word individually and take the first that returns results
  if (results.length === 0 && cleanQuery.length >= 3) {
    const words = cleanQuery.split(/\s+/).filter(w => w.length >= 3);
    for (const word of words) {
      results = await doSearch(word, null);
      if (results.length > 0) break;
    }
  }

  tmdbCache.set(cacheKey, results);
  return results;
}

// ========== SMART TORRENT SELECTOR ==========
// This is the magic — picks the best torrent automatically based on user preferences.

function guessContentType(title) {
  if (/S\d{1,2}E?\d{0,2}/i.test(title) || /season|complete|series/i.test(title)) return 'tv';
  return 'movie';
}

function scoreTorrent(torrent, prefs, type) {
  let score = 0;
  const title = torrent.title;

  // Quality scoring
  const is4K = /2160p|4k|uhd/i.test(title);
  const is1080 = /1080p/i.test(title);
  const is720 = /720p/i.test(title);

  if (prefs.quality === '4k' && is4K) score += 100;
  else if (prefs.quality === '1080p' && is1080) score += 100;
  else if (prefs.quality === '720p' && is720) score += 100;
  else if (prefs.quality === 'any') {
    if (is1080) score += 80;
    else if (is4K) score += 70;
    else if (is720) score += 60;
  } else {
    // Wrong quality — penalize but don't eliminate
    if (is1080) score += 50;
    else if (is4K) score += 40;
    else if (is720) score += 30;
  }

  // Source quality bonuses
  if (/bluray|bdrip|remux/i.test(title)) score += 20;
  if (/web[\.\-\s]?dl|webrip|amzn|nf|dsnp/i.test(title)) score += 15;
  if (/hdtv/i.test(title)) score += 5;
  if (/cam|ts|telesync|hdts/i.test(title)) score -= 100; // reject cams

  // Seeders (logarithmic — diminishing returns past ~50)
  score += Math.min(Math.log2(torrent.seeders + 1) * 8, 50);

  // Size penalty — too big or too small
  const sizeGB = torrent.size / 1073741824;
  const maxSize = type === 'tv' ? prefs.maxSizeGBTV : prefs.maxSizeGB;
  if (maxSize && sizeGB > maxSize) score -= 50;
  if (sizeGB < 0.3 && type === 'movie') score -= 30; // suspiciously small movie
  if (sizeGB > 1 && sizeGB <= maxSize) score += 10; // reasonable size bonus

  // Prefer complete packs for TV
  if (type === 'tv' && /complete|season.?pack/i.test(title)) score += 25;

  // Penalize individual episodes for TV requests
  if (type === 'tv' && /S\d{1,2}E\d{1,2}/i.test(title) && !/complete|season/i.test(title)) score -= 20;

  // Prefer 1337x — its Prowlarr links don't expire (unlike ext.to which returns 410)
  if ((torrent.indexer || '').toLowerCase().includes('1337x')) score += 15;

  // Known good release groups bonus
  if (/FLUX|NTb|SPARKS|RARBG|YTS|YIFY|EVO|AMIABLE/i.test(title)) score += 10;

  // Penalize foreign language (unless explicitly in search)
  if (/\b(kor|jpn|chi|hin|fra|deu|ita|spa|rus|ara|tur|tha)\b/i.test(title)) score -= 30;
  if (/dubbed|multi/i.test(title) && !/english/i.test(title)) score -= 15;

  // Strong foreign language filter — skip non-English releases entirely
  const hasEnglishMarker = /\bENG(?:lish)?\b/i.test(title) || /\bEnG\b/.test(title) || /\bDUAL\b/i.test(title);
  const foreignRelease =
    /\bLektor\s*(PL|CZ|HU)\b/i.test(title) ||
    /\bNapisy\s*PL\b/i.test(title) ||
    /\bTRUEFRENCH\b/i.test(title) ||
    /\bFRENCH\b/i.test(title) ||
    /\bLATINO\b/i.test(title) ||
    /\bGerman\s*DL\b/i.test(title) ||
    /\biTALiAN\b/i.test(title) ||
    /\bRUSSIAN\b/i.test(title) ||
    /\bPOLISH\b/i.test(title) ||
    /\bCZECH\b/i.test(title) ||
    /\bHINDI\b/i.test(title) ||
    /\bTAMiL\b/i.test(title) ||
    /\bTELUGU\b/i.test(title) ||
    /\bKOREAN\b/i.test(title) ||
    /\bCHINESE\b/i.test(title) ||
    /\bJAPANESE\b/i.test(title) ||
    /\bARABIC\b/i.test(title) ||
    /\bTURKISH\b/i.test(title) ||
    /\bVFF\b/i.test(title) ||
    /\bVFQ\b/i.test(title) ||
    /\bHC\b/.test(title) ||
    /\bITA(?:\s|$|\b)/i.test(title) ||
    /\bRUS(?:\s|$|\b)/i.test(title) ||
    /^(?:Slepa|La|Le|El|Der|Das|Die)\s\w+\s\//i.test(title);
  if (foreignRelease && !hasEnglishMarker) score -= 500;
  if (hasEnglishMarker && !foreignRelease) score += 5; // small boost for confirmed English

  // Minimum seeders gate
  if (torrent.seeders < (prefs.minSeeders || 5)) score -= 200;

  return score;
}

function selectBestTorrent(results, type, prefs, tvMode, tvSeason) {
  if (!results.length) return null;

  // Filter by type categories
  let filtered = results;
  if (type === 'movie') {
    filtered = results.filter(r => r.categories.some(c => c >= 2000 && c < 3000) || !r.categories.length);
  } else if (type === 'tv') {
    filtered = results.filter(r => r.categories.some(c => c >= 5000 && c < 6000) || !r.categories.length);
  }
  if (!filtered.length) filtered = results; // fallback to all

  // For TV modes, further filter by torrent title patterns
  if (type === 'tv' && tvMode) {
    const sNum = tvSeason ? String(tvSeason).padStart(2, '0') : null;

    if (tvMode === 'full') {
      // Prefer complete series packs — look for "complete", "all seasons", large multi-season packs
      const fullPacks = filtered.filter(r => {
        const t = r.title.toLowerCase();
        return /complete|all.?seasons|s01.*s\d{2}|season.?1.*season.?\d/i.test(t) ||
               (r.size > 10 * 1024 * 1024 * 1024); // >10GB likely a pack
      });
      if (fullPacks.length) filtered = fullPacks;
    } else if (tvMode === 'season' && sNum) {
      // Prefer season packs for this specific season
      const seasonPacks = filtered.filter(r => {
        const t = r.title;
        // Match "S01" but NOT "S01E01" (that's a single episode)
        const seasonMatch = new RegExp(`S${sNum}(?!E\\d)`, 'i').test(t) ||
                           new RegExp(`Season.?${parseInt(sNum)}(?!\\s*E)`, 'i').test(t);
        return seasonMatch;
      });
      if (seasonPacks.length) filtered = seasonPacks;
    } else if (tvMode === 'episode') {
      // Single episodes only — keep as-is, the search query already has S01E01
    }
  }

  // Score and sort
  const scored = filtered.map(r => ({ ...r, _score: scoreTorrent(r, prefs, type) }));
  scored.sort((a, b) => b._score - a._score);

  // Return best if it passes minimum score threshold
  const best = scored[0];
  if (best._score < 0) return null; // nothing acceptable
  return best;
}

// ========== PLEX DUPLICATE CHECK ==========
// Proxies to the media-manager server which holds Plex credentials and logic

async function plexSearch(title, type, year) {
  try {
    const managerUrl = process.env.MANAGER_URL || 'http://127.0.0.1:9876';
    const params = new URLSearchParams({ title, type: type || 'movie', ...(year ? { year } : {}) });
    const res = await fetch(`${managerUrl}/api/plex/check?${params}`, {
      headers: { 'x-api-key': process.env.MANAGER_API_KEY || '' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.configured) return null; // Plex not set up on media-manager
    return data; // { found, title, year, type }
  } catch (e) {
    console.error('[plex] Check error:', e.message);
    return null;
  }
}
// Sends the grab to the Electron app's magnet server (if running),
// or directly adds to qBittorrent.

async function sendToMediaManager(torrent, title, type) {
  let url = torrent.downloadUrl;
  if (!url) throw new Error('No download URL for selected torrent');

  // If the URL is a Prowlarr proxy link (not a direct magnet), resolve the magnet first
  // Prowlarr proxy links expire quickly, causing 410 errors
  if (url && !url.startsWith('magnet:')) {
    try {
      const managerUrl = process.env.MANAGER_URL || 'http://127.0.0.1:9876';
      console.log(`[get] Resolving magnet for: ${title}`);
      const resolveRes = await fetch(`${managerUrl}/api/prowlarr/resolve-magnet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: torrent.title, guid: torrent.guid, infoUrl: torrent.infoUrl }),
        signal: AbortSignal.timeout(30000),
      });
      if (resolveRes.ok) {
        const data = await resolveRes.json();
        if (data.success && data.downloadUrl && data.downloadUrl.startsWith('magnet:')) {
          console.log(`[get] Resolved magnet: ${data.downloadUrl.substring(0, 60)}...`);
          url = data.downloadUrl;
        }
      }
    } catch (e) {
      console.log(`[get] Magnet resolution failed, using original URL: ${e.message}`);
    }
  }

  // Try the Electron app's auto-grab endpoint (bypasses grab dialog, goes straight to pipeline)
  try {
    const managerUrl = process.env.MANAGER_URL || 'http://127.0.0.1:9876';
    const mmRes = await fetch(`${managerUrl}/auto-grab`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, title, type: type || 'movie' }),
      signal: AbortSignal.timeout(5000),
    });
    if (mmRes.ok) {
      const data = await mmRes.json();
      return { method: 'media-manager', message: data.message || `Queued in Media Manager: ${title}` };
    }
  } catch {
    // Media Manager not running — add directly to qBittorrent
  }

  // Direct fallback: add torrent to qBittorrent (no pipeline, just download)
  const result = await addAndDetect(url, title);
  if (!result.success) throw new Error(result.error || 'Failed to add torrent');

  return {
    method: 'direct',
    message: `Added to qBittorrent: ${result.name || title}`,
    hash: result.hash,
    name: result.name,
  };
}

// ========== REQUESTS LOG ==========
function getRequestsPath() {
  return REQUESTS_DIR_OVERRIDE.dir
    ? path.join(REQUESTS_DIR_OVERRIDE.dir, 'requests.json')
    : path.join(__dirname, 'requests.json');
}

function loadRequests() {
  try {
    const p = getRequestsPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {}
  return [];
}
function saveRequests(reqs) {
  try {
    const p = getRequestsPath();
    fs.writeFileSync(p, JSON.stringify(reqs, null, 2));
    console.log(`[requests] Saved ${reqs.length} requests to ${p}`);
  } catch (e) {
    console.error('[requests] Failed to save:', e.message);
  }
}

// ========== API ROUTES ==========

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'Media Companion' });
});

// ========== PUSH SUBSCRIPTION ==========
app.get('/api/push/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

app.post('/api/push/subscribe', requireAuth, (req, res) => {
  // Subscription stored per-request, not globally — just acknowledge
  res.json({ success: true });
});


app.get('/api/config', requireAuth, (req, res) => {
  // Return config without sensitive values
  res.json({
    configured: !!(config.prowlarr.url && config.seedbox.qbitUrl),
    hasPin: !!config.server.pin,
    preferences: config.preferences,
  });
});

app.post('/api/config', requireAuth, (req, res) => {
  try {
    const updates = req.body;
    config = { ...config, ...updates };
    saveConfig(config);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Check if title exists in Plex
app.get('/api/plex/check', requireAuth, async (req, res) => {
  try {
    const { title, type, year } = req.query;
    if (!title) return res.status(400).json({ error: 'Title required' });
    const result = await plexSearch(title, type || 'movie', year);
    if (result === null) return res.json({ configured: false });
    res.json({ configured: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Search TMDB (user-facing search)
app.get('/api/search', requireAuth, async (req, res) => {
  try {
    const { q, type } = req.query;
    if (!q) return res.status(400).json({ error: 'Query required' });
    if (!config.tmdb.apiKey) return res.status(500).json({ error: 'TMDB API key not configured — add it in Settings' });

    // Search both movies and TV if type not specified
    let results = [];
    if (!type || type === 'movie') {
      const movies = await tmdbSearch(q, 'movie');
      results.push(...movies);
    }
    if (!type || type === 'tv') {
      const tv = await tmdbSearch(q, 'tv');
      results.push(...tv);
    }

    // Sort by rating (best first)
    results.sort((a, b) => (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0));
    res.json({ success: true, results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// IMDB lookup via TMDB
app.get('/api/imdb/:id', requireAuth, async (req, res) => {
  try {
    const apiKey = config.tmdb.apiKey;
    if (!apiKey) return res.status(500).json({ error: 'TMDB API key not configured' });
    const url = `https://api.themoviedb.org/3/find/${req.params.id}?api_key=${apiKey}&external_source=imdb_id`;
    const tmdbRes = await fetch(url);
    if (!tmdbRes.ok) return res.status(404).json({ error: 'Not found on TMDB' });
    const data = await tmdbRes.json();
    const movie = data.movie_results?.[0];
    const tv = data.tv_results?.[0];
    const r = movie || tv;
    if (!r) return res.status(404).json({ error: 'Not found' });
    res.json({
      success: true, result: {
        id: r.id,
        title: r.title || r.name,
        year: (r.release_date || r.first_air_date || '').slice(0, 4),
        overview: (r.overview || '').slice(0, 200),
        poster: r.poster_path ? `https://image.tmdb.org/t/p/w300${r.poster_path}` : null,
        rating: r.vote_average ? r.vote_average.toFixed(1) : null,
        type: movie ? 'movie' : 'tv',
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// TMDB TV show details — seasons and episodes
app.get('/api/tv/:tmdbId', requireAuth, async (req, res) => {
  try {
    const apiKey = config.tmdb.apiKey;
    if (!apiKey) return res.status(500).json({ error: 'TMDB API key not configured' });
    const tmdbId = req.params.tmdbId;

    // Get show overview with seasons list
    const showRes = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${apiKey}`);
    if (!showRes.ok) return res.status(404).json({ error: 'Show not found on TMDB' });
    const show = await showRes.json();

    // Filter out specials (season 0) and unaired seasons
    const today = new Date().toISOString().slice(0, 10);
    const seasons = (show.seasons || [])
      .filter(s => s.season_number > 0)
      .map(s => ({
        number: s.season_number,
        name: s.name,
        episodeCount: s.episode_count,
        airDate: s.air_date,
        aired: s.air_date && s.air_date <= today,
      }));

    res.json({
      success: true,
      title: show.name,
      totalSeasons: seasons.length,
      status: show.status, // "Returning Series", "Ended", "Canceled"
      seasons,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// TMDB TV season episodes
app.get('/api/tv/:tmdbId/season/:num', requireAuth, async (req, res) => {
  try {
    const apiKey = config.tmdb.apiKey;
    if (!apiKey) return res.status(500).json({ error: 'TMDB API key not configured' });
    const { tmdbId, num } = req.params;

    const seasonRes = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${num}?api_key=${apiKey}`);
    if (!seasonRes.ok) return res.status(404).json({ error: 'Season not found' });
    const season = await seasonRes.json();

    const today = new Date().toISOString().slice(0, 10);
    const episodes = (season.episodes || []).map(ep => ({
      number: ep.episode_number,
      name: ep.name,
      airDate: ep.air_date,
      aired: ep.air_date && ep.air_date <= today,
      overview: (ep.overview || '').slice(0, 120),
    }));

    res.json({
      success: true,
      seasonNumber: season.season_number,
      name: season.name,
      episodes,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET — the magic "one tap" endpoint
// Searches Prowlarr, picks best torrent, adds to pipeline
app.post('/api/get', requireAuth, async (req, res) => {
  try {
    let { title, year, type, tmdbId, skipPlexCheck, tvMode, tvSeason, tvEpisode } = req.body;
    if (!title) return res.status(400).json({ error: 'Title required' });

    const contentType = type || 'movie';

    // Step 0a: Check if already in the pipeline queue
    if (!skipPlexCheck) {
      try {
        const managerUrl = process.env.MANAGER_URL || 'http://127.0.0.1:9876';
        const queueRes = await fetch(`${managerUrl}/api/pipeline/queue`, { signal: AbortSignal.timeout(3000) });
        if (queueRes.ok) {
          const queueData = await queueRes.json();
          const jobs = (queueData.jobs || []).filter(j => j.status !== 'done' && j.status !== 'failed' && j.status !== 'cancelled');
          
          if (jobs.length) {
            const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const reqTitle = normalize(title);
            
            // Build a label for what we're requesting to match against queue job names
            let matchLabel;
            if (contentType === 'tv' && tvMode === 'episode' && tvSeason && tvEpisode) {
              // Episode-specific: match title + SxxExx
              const sNum = String(tvSeason).padStart(2, '0');
              const eNum = String(tvEpisode).padStart(2, '0');
              matchLabel = `s${sNum}e${eNum}`;
            } else if (contentType === 'tv' && tvMode === 'season' && tvSeason) {
              // Season-specific: match title + Sxx (but not SxxExx — those are individual episodes)
              const sNum = String(tvSeason).padStart(2, '0');
              matchLabel = `s${sNum}`;
            } else {
              matchLabel = null; // Movie or full show — just match title
            }
            
            for (const job of jobs) {
              const jobName = normalize(job.name);
              // Check if job name contains the requested title
              if (!jobName.includes(reqTitle)) continue;
              
              if (contentType === 'movie') {
                // Movie: title match is enough (with optional year check)
                if (year && jobName.includes(String(year))) {
                  return res.status(409).json({ error: 'already_in_queue', message: `Already in pipeline: ${job.name}` });
                }
                // No year in request — title match alone
                if (!year) {
                  return res.status(409).json({ error: 'already_in_queue', message: `Already in pipeline: ${job.name}` });
                }
              } else if (contentType === 'tv' && matchLabel) {
                // TV with specific season/episode: must also match the SxxExx or Sxx pattern
                if (jobName.includes(matchLabel)) {
                  return res.status(409).json({ error: 'already_in_queue', message: `Already in pipeline: ${job.name}` });
                }
              } else if (contentType === 'tv' && tvMode === 'full') {
                // Full show: any job with the title is a dup
                return res.status(409).json({ error: 'already_in_queue', message: `Already in pipeline: ${job.name}` });
              }
            }
          }
        }
      } catch (e) {
        console.log('[get] Pipeline queue check failed (non-fatal):', e.message);
      }
    }

    // Step 0b: Check if already in Plex (skip for TV season/episode/latest — those have their own logic)
    if (!skipPlexCheck && (contentType === 'movie' || (contentType === 'tv' && tvMode === 'full'))) {
      const plexResult = await plexSearch(title, contentType, year);
      if (plexResult && plexResult.found) {
        return res.status(409).json({
          error: 'already_in_plex',
          message: `Already in Plex: ${plexResult.title}${plexResult.year ? ` (${plexResult.year})` : ''}`,
          plexMatch: plexResult,
        });
      }
    }

    // Build search query based on TV mode
    let searchQuery;
    let requestLabel = title;

    if (contentType === 'tv' && tvMode) {
      if (tvMode === 'full') {
        searchQuery = `${title} complete series`;
        requestLabel = `${title} (Complete Series)`;
      } else if (tvMode === 'season' && tvSeason) {
        const sNum = String(tvSeason).padStart(2, '0');
        searchQuery = `${title} S${sNum}`;
        requestLabel = `${title} Season ${tvSeason}`;
      } else if (tvMode === 'episode' && tvSeason && tvEpisode) {
        const sNum = String(tvSeason).padStart(2, '0');
        const eNum = String(tvEpisode).padStart(2, '0');
        searchQuery = `${title} S${sNum}E${eNum}`;
        requestLabel = `${title} S${sNum}E${eNum}`;
      } else if (tvMode === 'latest' && tmdbId) {
        try {
          const apiKey = config.tmdb.apiKey;
          const showRes = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${apiKey}`);
          if (showRes.ok) {
            const show = await showRes.json();
            const lastEp = show.last_episode_to_air;
            if (lastEp) {
              const sNum = String(lastEp.season_number).padStart(2, '0');
              const eNum = String(lastEp.episode_number).padStart(2, '0');
              tvSeason = lastEp.season_number; // save for fallback
              tvEpisode = lastEp.episode_number;
              searchQuery = `${title} S${sNum}E${eNum}`;
              requestLabel = `${title} S${sNum}E${eNum} (Latest)`;
            } else {
              const today = new Date().toISOString().slice(0, 10);
              const airedSeasons = (show.seasons || [])
                .filter(s => s.season_number > 0 && s.air_date && s.air_date <= today);
              if (airedSeasons.length) {
                const latest = airedSeasons[airedSeasons.length - 1];
                const sNum = String(latest.season_number).padStart(2, '0');
                searchQuery = `${title} S${sNum}`;
                requestLabel = `${title} Season ${latest.season_number} (Latest)`;
              } else {
                searchQuery = title;
                requestLabel = `${title} (Latest)`;
              }
            }
          } else {
            searchQuery = title;
            requestLabel = `${title} (Latest)`;
          }
        } catch {
          searchQuery = title;
          requestLabel = `${title} (Latest)`;
        }
      } else if (tvMode === 'latest') {
        searchQuery = title;
        requestLabel = `${title} (Latest)`;
      } else {
        searchQuery = title;
      }
    } else {
      searchQuery = year ? `${title} ${year}` : title;
    }

    // Step 1: Search Prowlarr for torrents
    let torrents = await prowlarrSearch(searchQuery);
    console.log(`[get] Searching: "${searchQuery}" => ${torrents.length} results`);

    // Fallback searches for TV when primary query finds nothing
    if (contentType === 'tv' && !torrents.length) {
      if (tvMode === 'episode' && tvSeason && tvEpisode) {
        // Episode not found — fall back to season pack
        const sNum = String(tvSeason).padStart(2, '0');
        const fallbackQuery = `${title} S${sNum}`;
        console.log(`[get] No episode torrent found, trying season pack: "${fallbackQuery}"`);
        torrents = await prowlarrSearch(fallbackQuery);
        if (torrents.length) {
          // Switch to season mode so selectBestTorrent picks a season pack
          tvMode = 'season';
          requestLabel += ' (via season pack)';
        }
      } else if (tvMode === 'latest' && tvSeason) {
        // Latest episode not found — fall back to latest season
        const sNum = String(tvSeason).padStart(2, '0');
        const fallbackQuery = `${title} S${sNum}`;
        console.log(`[get] No latest episode found, trying season: "${fallbackQuery}"`);
        torrents = await prowlarrSearch(fallbackQuery);
      } else if (tvMode === 'full') {
        const alt1 = await prowlarrSearch(`${title} complete`);
        torrents.push(...alt1);
        if (!torrents.length) {
          const alt2 = await prowlarrSearch(`${title} all seasons`);
          torrents.push(...alt2);
        }
      }
    }

    // If still nothing, try just the show name as a last resort
    if (contentType === 'tv' && !torrents.length) {
      console.log(`[get] Trying bare title: "${title}"`);
      torrents = await prowlarrSearch(title);
    }

    if (!torrents.length) return res.status(404).json({ error: 'No torrents found', query: searchQuery });

    // Step 2: Auto-select best torrent
    // For full show, prefer larger packs; for season, prefer season packs; for episode, prefer single eps
    const best = selectBestTorrent(torrents, contentType, config.preferences, tvMode, tvSeason);
    console.log(`[get] Best: ${best ? best.title + " score:" + best._score + " seeders:" + best.seeders : "NONE"}`);
    if (!best) return res.status(404).json({ error: 'No suitable torrents found', query: searchQuery });

    // Step 3: Send to pipeline
    const result = await sendToMediaManager(best, best.title, contentType);

    // Step 4: Log the request
    const requests = loadRequests();
    const pushSubscription = req.body.pushSubscription || null;
    requests.unshift({
      id: Date.now(),
      title: requestLabel, year, type: contentType,
      tvMode: tvMode || null,
      tvSeason: tvSeason || null,
      tvEpisode: tvEpisode || null,
      torrent: best.title,
      size: best.size,
      seeders: best.seeders,
      indexer: best.indexer,
      quality: /2160p|4k/i.test(best.title) ? '4K' : /1080p/i.test(best.title) ? '1080p' : /720p/i.test(best.title) ? '720p' : 'Unknown',
      method: result.method,
      status: 'sent',
      timestamp: new Date().toISOString(),
      pushSubscription,
    });
    if (requests.length > 100) requests.length = 100;
    saveRequests(requests);

    res.json({
      success: true,
      message: result.message,
      torrent: {
        title: best.title,
        size: best.size,
        seeders: best.seeders,
        indexer: best.indexer,
        score: best._score,
      }
    });
  } catch (e) {
    console.error('[get] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// View recent requests — enriched with live pipeline status + ETA to Plex
// Track when each request entered its current pipeline step
const stepStartTimes = {}; // { requestId: { step: 'transferring', startedAt: timestamp, totalEstimate: seconds } }

// ========== TOP 20 (proxy to media-manager) ==========
app.get('/api/top/indexers', requireAuth, async (req, res) => {
  try {
    const managerUrl = process.env.MANAGER_URL || 'http://127.0.0.1:9876';
    const r = await fetch(`${managerUrl}/api/prowlarr/indexers`, { signal: AbortSignal.timeout(5000) });
    const data = await r.json();
    res.json(data);
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/top/browse', requireAuth, async (req, res) => {
  try {
    const managerUrl = process.env.MANAGER_URL || 'http://127.0.0.1:9876';
    const r = await fetch(`${managerUrl}/api/prowlarr/browse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(30000),
    });
    const data = await r.json();
    res.json(data);
  } catch (e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/requests', requireAuth, async (req, res) => {
  const requests = loadRequests();
  if (!requests.length) return res.json({ success: true, requests: [] });

  try {
    const enriched = await Promise.race([
      enrichRequests(requests),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
    ]);

    // Remove completed entries and persist so they don't come back
    const active = enriched.filter(r => !r.live?.completed);
    if (active.length < enriched.length) {
      saveRequests(requests.filter((_, i) => !enriched[i]?.live?.completed));
    }

    return res.json({ success: true, requests: active });
  } catch (e) {
    console.error('[requests] Enrichment failed/timed out:', e.message);
    return res.json({ success: true, requests });
  }
});

async function enrichRequests(requests) {
  // Get torrent status from qBit (seedbox) — only for download progress/ETA
  let torrents = [];
  try {
    const r = await fetchWithTimeout(config.seedbox.qbitUrl.replace(/\/$/, '') + '/api/v2/torrents/info', {
      headers: { 'Cookie': qbitCookie || '' }
    }, 2500);
    if (r.status === 403) {
      await qbitLogin();
      const r2 = await fetchWithTimeout(config.seedbox.qbitUrl.replace(/\/$/, '') + '/api/v2/torrents/info', {
        headers: { 'Cookie': qbitCookie || '' }
      }, 2500);
      torrents = await r2.json();
    } else {
      torrents = await r.json();
    }
  } catch (e) {
    console.log('[requests] qBit unreachable:', e.message);
  }

  // Get pipeline status from Media Manager (localhost only — no network impact)
  let pipelineJobs = [];
  try {
    const managerUrl2 = process.env.MANAGER_URL || 'http://127.0.0.1:9876';
    const mmRes = await fetchWithTimeout(`${managerUrl2}/status`, {}, 2000);
    if (mmRes.ok) {
      const mmData = await mmRes.json();
      pipelineJobs = mmData.jobs || [];
    }
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
        return (jName && rTitle && jName.includes(rTitle.slice(0, 20))) ||
               (jName && rTorrent && (jName.includes(rTorrent.slice(0, 30)) || rTorrent.includes(jName.slice(0, 30))));
      });

      if (!match && !pipelineJob) {
        const age = now - new Date(r.timestamp).getTime();
        if (age > 3600000) return { ...r, live: { pipelineStep: 'In Plex', completed: true, etaToPlex: 0 } };
        return r;
      }

      // ===== ESTIMATED PIPELINE TIMES =====
      const sizeMB = ((match && match.size) || r.size || 0) / (1024 * 1024);
      const isTV = r.type === 'tv';

      // SFTP: movies ~25 MB/s single, TV ~65 MB/s aggregate concurrent
      const sftpSpeed = isTV ? 65 : 25;
      const sftpEstimate = Math.round(sizeMB / sftpSpeed);

      // Rename: 10s base + 2s per file for TV
      const estFileCount = isTV ? Math.max(Math.round(sizeMB / 400), 1) : 1;
      const renameEstimate = 10 + (estFileCount * 2);

      // Move: ~100 MB/s LAN
      const moveEstimate = Math.round(sizeMB / 100);

      // Total post-download
      const postDownloadEstimate = sftpEstimate + renameEstimate + moveEstimate;

      // Determine current step
      const progress = match ? Math.round(match.progress * 100) : 100;
      const isDownloading = match && ['downloading', 'forcedDL', 'metaDL', 'queuedDL', 'stalledDL', 'checkingDL'].includes(match.state);
      const isSeeding = match && ['uploading', 'stalledUP'].includes(match.state);
      const isPaused = match && ['pausedDL', 'pausedUP'].includes(match.state);
      const isDone = progress >= 100;
      const dlEta = (match && isDownloading && match.eta > 0 && match.eta < 8640000) ? match.eta : 0;

      let pipelineStep = '';

      // Figure out the current step
      if (pipelineJob) {
        const step = pipelineJob.step || '';
        const pStatus = pipelineJob.status || '';
        if (pStatus === 'complete') return { ...r, live: { pipelineStep: 'In Plex', completed: true, etaToPlex: 0 } };
        if (pStatus === 'failed') return { ...r, live: { pipelineStep: 'Failed', completed: false, etaToPlex: 0 } };

        if (step === 'grabbing') pipelineStep = 'Starting';
        else if (step === 'waiting_torrent') pipelineStep = 'Downloading';
        else if (step === 'transferring') pipelineStep = 'Transferring';
        else if (step === 'renaming') pipelineStep = 'Renaming';
        else if (step === 'moving') pipelineStep = 'Moving to NAS';
        else pipelineStep = step || 'Processing';
      } else if (isDownloading && !isDone) {
        pipelineStep = 'Downloading';
      } else if (isDone && (isSeeding || isPaused)) {
        pipelineStep = 'Waiting for transfer';
      } else if (isDone) {
        pipelineStep = 'Processing';
      }

      // Track step transitions — when a step changes, record start time and full estimate
      const rid = r.id;
      const tracked = stepStartTimes[rid];

      // Calculate what the TOTAL remaining estimate is when entering each step
      const stepEstimates = {
        'Starting': dlEta + postDownloadEstimate,
        'Downloading': dlEta + postDownloadEstimate,
        'Waiting for transfer': postDownloadEstimate,
        'Transferring': sftpEstimate + renameEstimate + moveEstimate,
        'Renaming': renameEstimate + moveEstimate,
        'Moving to NAS': moveEstimate,
        'Processing': postDownloadEstimate,
      };

      if (!tracked || tracked.step !== pipelineStep) {
        // Step changed — record new start time
        stepStartTimes[rid] = {
          step: pipelineStep,
          startedAt: now,
          totalEstimate: stepEstimates[pipelineStep] || postDownloadEstimate,
        };
      }

      const track = stepStartTimes[rid];
      let etaToPlex;

      if (pipelineStep === 'Downloading' && dlEta > 0) {
        // qBit is reachable and giving us a live ETA — use it directly
        etaToPlex = dlEta + postDownloadEstimate;
        // Update the tracked estimate so if qBit goes away, we have a good baseline
        track.totalEstimate = etaToPlex;
        track.startedAt = now;
      } else {
        // For all steps (including Downloading when qBit is unreachable),
        // count down from when we entered the step
        const elapsed = Math.floor((now - track.startedAt) / 1000);
        etaToPlex = Math.max(0, track.totalEstimate - elapsed);
      }

      return {
        ...r,
        live: {
          pipelineStep,
          progress,
          dlspeed: match ? (match.dlspeed || 0) : 0,
          etaToPlex,
          size: match ? match.size : r.size,
          completed: false,
          seeding: !!isSeeding,
        }
      };
    } catch (e) {
      return r;
    }
  });
}

// Queue status — query qBittorrent
app.get('/api/queue', requireAuth, async (req, res) => {
  try {
    const r = await qbitRequest('/api/v2/torrents/info');
    const torrents = await r.json();
    // Return active (non-seeding) torrents
    const active = torrents
      .filter(t => t.category !== 'Long Seed')
      .map(t => ({
        name: t.name,
        progress: Math.round(t.progress * 100),
        state: t.state,
        size: t.size,
        dlspeed: t.dlspeed,
        eta: t.eta,
      }));
    res.json({ success: true, torrents: active });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Debug: raw requests without enrichment
app.get('/api/requests-debug', (req, res) => {
  try {
    const r = loadRequests();
    res.json({ count: r.length, requests: r });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// Fallback to PWA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== EXPORTS & START ==========
function getLocalIP() {
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

// ========== BACKGROUND PUSH CHECKER ==========
// Runs every 30s, fires push to the requester when their download completes
const notifiedIds = new Set(); // prevent duplicate notifications this session

async function checkCompletionsAndNotify() {
  const requests = loadRequests();
  const pending = requests.filter(r => r.pushSubscription && !notifiedIds.has(r.id));
  if (!pending.length) return;

  try {
    const enriched = await Promise.race([
      enrichRequests(pending),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000))
    ]);

    for (const r of enriched) {
      if (!r.live?.completed || notifiedIds.has(r.id)) continue;
      notifiedIds.add(r.id);

      const label = r.tvMode === 'season' ? ` S${String(r.tvSeason || '').padStart(2, '0')}`
        : r.tvMode === 'episode' ? ` S${String(r.tvSeason || '').padStart(2, '0')}E${String(r.tvEpisode || '').padStart(2, '0')}`
        : '';

      await sendPush(r.pushSubscription, {
        title: '✅ Ready in Plex',
        body: `${r.title}${label} is available`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        tag: `complete-${r.id}`,
      });
    }
  } catch (e) {
    // Silently ignore — enrichment timeout etc.
  }
}

setInterval(checkCompletionsAndNotify, 30000);

function startServer(port) {
  const p = port || parseInt(process.env.PORT) || config.server.port || 3000;
  return new Promise((resolve) => {
    const server = app.listen(p, '0.0.0.0', () => {
      const ip = getLocalIP();
      console.log(`\n  🏴‍☠️  Media Companion`);
      console.log(`  ────────────────────`);
      console.log(`  Running on http://localhost:${p}`);
      console.log(`  Network:   http://${ip}:${p}`);
      console.log(`  PIN:       ${config.server.pin || '(none — open access)'}\n`);
      resolve({ server, port: p, ip });
    });
  });
}

// If run directly (not imported by Electron), start the server
if (require.main === module) {
  startServer();
}

function reloadConfig() {
  config = loadConfig();
  return config;
}

module.exports = { app, startServer, getLocalIP, loadConfig, saveConfig, reloadConfig, config, loadRequests, setConfigPath, setRequestsPath };
