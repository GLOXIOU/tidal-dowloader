require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const {
  startDeviceLogin,
  pollDeviceLogin,
  buildSessionCookie,
  readSession,
  clearSession,
} = require('./src/tidalAuth');
const tidalApi = require('./src/tidalApi');
const downloadQueue = require('./src/downloadQueue');
const { refreshFromGist } = require('./src/apiKeys');

const REQUIRED_ENV = ['JWT_SECRET'];
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length) {
  console.error(`Variables d'environnement manquantes : ${missing.join(', ')}. Copie .env.example vers .env.`);
  process.exit(1);
}

refreshFromGist();

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function requireTidalAuth(req, res, next) {
  const session = readSession(req);
  if (!session || !session.accessToken) {
    return res.status(401).json({ error: 'not_authenticated' });
  }
  req.tidal = session;
  next();
}

app.get('/api/session', (req, res) => {
  const session = readSession(req);
  if (!session?.accessToken) return res.json({ authenticated: false });
  res.json({ authenticated: true, email: session.email || null });
});

app.post('/auth/tidal/login', async (req, res) => {
  try {
    const data = await startDeviceLogin();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/auth/tidal/poll', async (req, res) => {
  try {
    const result = await pollDeviceLogin();
    if (!result.done) return res.json({ done: false });

    buildSessionCookie(res, result.session);
    res.json({ done: true });
  } catch (err) {
    res.status(400).json({ error: err.message, code: err.code });
  }
});

app.post('/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/search', requireTidalAuth, async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'q est requis.' });

  try {
    const data = await tidalApi.search(req, res, q, { limit: 15 });
    res.json(data);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, needReconnect: !!err.needReconnect });
  }
});

app.post('/api/resolve', requireTidalAuth, async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Merci de fournir un lien Tidal.' });

  try {
    const resolved = await tidalApi.getByUrl(req, res, url);
    res.json(resolved);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, needReconnect: !!err.needReconnect });
  }
});

app.get('/api/playlists', requireTidalAuth, async (req, res) => {
  try {
    const playlists = await tidalApi.getUserPlaylists(req, res);
    res.json({ playlists });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, needReconnect: !!err.needReconnect });
  }
});

app.post('/api/download', requireTidalAuth, async (req, res) => {
  const { type, id, quality } = req.body || {};
  if (!type || !id) return res.status(400).json({ error: 'type et id sont requis.' });

  try {
    let resolved;
    if (type === 'track') resolved = { type, data: await tidalApi.getTrack(req, res, id) };
    else if (type === 'album') resolved = { type, data: await tidalApi.getAlbum(req, res, id) };
    else if (type === 'playlist') resolved = { type, data: await tidalApi.getPlaylist(req, res, id) };
    else return res.status(400).json({ error: `Type non supporté: ${type}` });

    const ids = await downloadQueue.enqueueFromResolved(req.tidal, resolved, quality || 'hifi');
    res.json({ queued: ids });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message, needReconnect: !!err.needReconnect });
  }
});

app.get('/api/queue', requireTidalAuth, (req, res) => {
  res.json({ items: downloadQueue.list() });
});

app.get('/api/queue/stream', requireTidalAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(`data: ${JSON.stringify({ items: downloadQueue.list() })}\n\n`);

  const onUpdate = (item) => res.write(`data: ${JSON.stringify({ item })}\n\n`);
  downloadQueue.on('update', onUpdate);

  req.on('close', () => downloadQueue.off('update', onUpdate));
});

app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`tidal-dowloader lancé sur http://localhost:${PORT}`);
});
