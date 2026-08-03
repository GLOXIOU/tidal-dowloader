// Ported from tidal_dl/tidal.py (Tidal-Media-Downloader, Apache-2.0): search, catalog lookups,
// stream-manifest resolution (BTS + DASH), lyrics, covers. Talks to Tidal's private API
// (api.tidalhifi.com / api.tidal.com / listen.tidal.com) using the device-flow access token from
// tidalAuth.js. Wrapped with the same auto-refresh-on-401 pattern used in shazam-to-platform's
// src/tidalApi.js.

const { XMLParser } = require('fast-xml-parser');
const { refreshAccessToken, buildSessionCookie } = require('./tidalAuth');

const API_BASE = 'https://api.tidalhifi.com/v1/';
const LISTEN_BASE = 'https://listen.tidal.com/v1/';
const RESOURCES_BASE = 'https://resources.tidal.com/images/';

const Type = ['album', 'track', 'video', 'playlist', 'artist', 'mix'];

async function withAutoRefresh(req, res, fn) {
  try {
    return await fn(req.tidal);
  } catch (err) {
    if (err.status !== 401 || !req.tidal.refreshToken) throw err;

    const refreshed = await refreshAccessToken(req.tidal.refreshToken);
    if (!refreshed) {
      const e = new Error('Session Tidal expirée, merci de te reconnecter.');
      e.status = 401;
      e.needReconnect = true;
      throw e;
    }

    req.tidal = refreshed;
    buildSessionCookie(res, refreshed);
    return await fn(req.tidal);
  }
}

async function apiGet(session, path, params = {}, urlpre = API_BASE) {
  const url = new URL(urlpre + path);
  url.searchParams.set('countryCode', session.countryCode);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${session.accessToken}` } });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 5;
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }
    if (res.status === 401) {
      const err = new Error('Unauthorized');
      err.status = 401;
      throw err;
    }

    const data = await res.json().catch(() => ({}));
    if (data && data.status && data.status !== 200) {
      const err = new Error(data.userMessage || `Tidal error ${data.status}`);
      err.status = data.status;
      throw err;
    }
    return data;
  }
  throw new Error('Too many requests, please retry.');
}

async function apiGetAllItems(session, path, extraParams = {}) {
  const limit = 50;
  let offset = 0;
  let total = 0;
  const out = [];
  while (true) {
    const data = await apiGet(session, path, { ...extraParams, limit, offset });
    if (typeof data.totalNumberOfItems === 'number') total = data.totalNumberOfItems;
    const items = data.items || [];
    out.push(...items);
    if ((total > 0 && out.length >= total) || items.length < limit) break;
    offset += items.length;
  }
  return out;
}

function search(req, res, query, { offset = 0, limit = 10 } = {}) {
  return withAutoRefresh(req, res, (session) =>
    apiGet(session, 'search', { query, offset, limit, types: 'ARTISTS,ALBUMS,TRACKS,VIDEOS,PLAYLISTS' }),
  );
}

function parseUrl(rawUrl) {
  if (!rawUrl.includes('tidal.com')) return { type: null, id: rawUrl };
  const url = rawUrl.toLowerCase();
  for (const type of Type) {
    const marker = `${type}/`;
    const idx = url.indexOf(marker);
    if (idx === -1) continue;
    const rest = url.slice(idx + marker.length);
    const id = rest.split('/')[0].split('?')[0];
    return { type, id };
  }
  return { type: null, id: rawUrl };
}

function getAlbum(req, res, id) {
  return withAutoRefresh(req, res, (session) => apiGet(session, `albums/${id}`));
}
function getArtist(req, res, id) {
  return withAutoRefresh(req, res, (session) => apiGet(session, `artists/${id}`));
}
function getTrack(req, res, id) {
  return withAutoRefresh(req, res, (session) => apiGet(session, `tracks/${id}`));
}
function getVideo(req, res, id) {
  return withAutoRefresh(req, res, (session) => apiGet(session, `videos/${id}`));
}
function getPlaylist(req, res, id) {
  return withAutoRefresh(req, res, (session) => apiGet(session, `playlists/${id}`));
}

async function getItems(req, res, id, type) {
  let data;
  if (type === 'playlist') data = await withAutoRefresh(req, res, (s) => apiGetAllItems(s, `playlists/${id}/items`));
  else if (type === 'album') data = await withAutoRefresh(req, res, (s) => apiGetAllItems(s, `albums/${id}/items`));
  else if (type === 'mix') data = await withAutoRefresh(req, res, (s) => apiGetAllItems(s, `mixes/${id}/items`));
  else throw new Error('invalid type');

  const tracks = [];
  const videos = [];
  for (const item of data) {
    if (item.type === 'track' && item.item?.streamReady) tracks.push(item.item);
    else videos.push(item.item);
  }
  return { tracks, videos };
}

async function getByUrl(req, res, rawUrl) {
  const { type, id } = parseUrl(rawUrl);
  if (!type) throw new Error('Lien Tidal non reconnu.');
  if (type === 'album') return { type, data: await getAlbum(req, res, id) };
  if (type === 'track') return { type, data: await getTrack(req, res, id) };
  if (type === 'video') return { type, data: await getVideo(req, res, id) };
  if (type === 'playlist') return { type, data: await getPlaylist(req, res, id) };
  if (type === 'artist') return { type, data: await getArtist(req, res, id) };
  throw new Error(`Type de lien non supporté: ${type}`);
}

const AUDIO_QUALITY = { normal: 'LOW', high: 'HIGH', hifi: 'LOSSLESS', max: 'HI_RES_LOSSLESS' };

const mpdParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name) => ['Period', 'AdaptationSet', 'Representation', 'S'].includes(name),
});

function parseMpd(xml) {
  // Strip the default namespace decl (first occurrence only), same as the Python port.
  const cleaned = xml.replace(/xmlns="[^"]+"/, '');
  const doc = mpdParser.parse(cleaned);
  const periods = doc.MPD?.Period || [];
  const tracks = [];

  for (const period of periods) {
    for (const adaptationSet of period.AdaptationSet || []) {
      if (adaptationSet.contentType !== 'audio') {
        throw new Error('Only supports audio MPDs!');
      }
      for (const rep of adaptationSet.Representation || []) {
        const segTemplate = rep.SegmentTemplate;
        const trackUrls = [segTemplate.initialization];
        const startNumber = parseInt(segTemplate.startNumber || '1', 10);

        const segTimeline = segTemplate.SegmentTimeline;
        if (segTimeline) {
          const sList = segTimeline.S || [];
          let curTime = 0;
          const segTimeList = [];
          for (const s of sList) {
            if (s.t !== undefined) curTime = parseInt(s.t, 10);
            const repeat = parseInt(s.r || '0', 10);
            for (let i = 0; i <= repeat; i++) {
              segTimeList.push(curTime);
              curTime += parseInt(s.d, 10);
            }
          }
          for (let n = startNumber; n < startNumber + segTimeList.length; n++) {
            trackUrls.push(segTemplate.media.replace('$Number$', String(n)));
          }
        }
        tracks.push(trackUrls);
      }
    }
  }
  return tracks;
}

function getSub(text, start, end) {
  const from = text.indexOf(start);
  if (from === -1) return '';
  const rest = text.slice(from + start.length);
  const to = rest.indexOf(end);
  return to === -1 ? rest : rest.slice(0, to);
}

async function getResolutionList(masterUrl) {
  const txt = await (await fetch(masterUrl)).text();
  const chunks = txt.split('#');
  const out = [];
  for (const chunk of chunks) {
    if (!chunk.includes('RESOLUTION=') || !chunk.includes('EXT-X-STREAM-INF:')) continue;
    const codec = getSub(chunk, 'CODECS="', '"');
    const httpIdx = chunk.indexOf('http');
    const m3u8Url = 'http' + chunk.slice(httpIdx + 4).trim();
    const resolution = getSub(chunk, 'RESOLUTION=', 'http').trim().split(',')[0];
    const [w, h] = resolution.split('x');
    out.push({ codec, m3u8Url, resolution, width: Number(w), height: Number(h) });
  }
  return out;
}

async function getStreamUrl(req, res, trackId, quality = 'hifi') {
  return withAutoRefresh(req, res, async (session) => {
    const params = {
      audioquality: AUDIO_QUALITY[quality] || AUDIO_QUALITY.hifi,
      playbackmode: 'STREAM',
      assetpresentation: 'FULL',
    };
    const resp = await apiGet(session, `tracks/${trackId}/playbackinfopostpaywall`, params);

    if (resp.manifestMimeType?.includes('vnd.tidal.bt')) {
      const manifest = JSON.parse(Buffer.from(resp.manifest, 'base64').toString('utf-8'));
      const url = manifest.urls[0];
      return {
        trackId,
        soundQuality: resp.audioQuality,
        codec: manifest.codecs,
        encryptionKey: manifest.keyId || '',
        url,
        urls: [url],
      };
    }
    if (resp.manifestMimeType?.includes('dash+xml')) {
      const xml = Buffer.from(resp.manifest, 'base64').toString('utf-8');
      const codec = getSub(xml, 'codecs="', '"');
      const urls = parseMpd(xml)[0];
      return {
        trackId,
        soundQuality: resp.audioQuality,
        codec,
        encryptionKey: '',
        urls,
        url: urls[0],
      };
    }
    throw new Error(`Can't get the stream URL, type is ${resp.manifestMimeType}`);
  });
}

async function getVideoStreamUrl(req, res, videoId, minHeight = 1080) {
  return withAutoRefresh(req, res, async (session) => {
    const params = { videoquality: 'HIGH', playbackmode: 'STREAM', assetpresentation: 'FULL' };
    const resp = await apiGet(session, `videos/${videoId}/playbackinfopostpaywall`, params);

    if (!resp.manifestMimeType?.includes('vnd.tidal.emu')) {
      throw new Error(`Can't get the stream URL, type is ${resp.manifestMimeType}`);
    }
    const manifest = JSON.parse(Buffer.from(resp.manifest, 'base64').toString('utf-8'));
    const variants = await getResolutionList(manifest.urls[0]);
    let chosen = variants.find((v) => v.height >= minHeight) || variants[variants.length - 1];
    return chosen;
  });
}

function getTrackContributors(req, res, id) {
  return withAutoRefresh(req, res, (session) => apiGet(session, `tracks/${id}/contributors`));
}

async function getLyrics(req, res, id) {
  try {
    return await withAutoRefresh(req, res, (session) => apiGet(session, `tracks/${id}/lyrics`, {}, LISTEN_BASE));
  } catch {
    return null;
  }
}

function getCoverUrl(sid, width = '1280', height = '1280') {
  if (!sid) return null;
  return `${RESOURCES_BASE}${sid.replace(/-/g, '/')}/${width}x${height}.jpg`;
}

async function getCoverData(sid, width = '1280', height = '1280') {
  const url = getCoverUrl(sid, width, height);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function getArtistsName(artists = []) {
  return artists.map((a) => a.name).join(', ');
}

module.exports = {
  withAutoRefresh,
  apiGet,
  apiGetAllItems,
  search,
  parseUrl,
  getAlbum,
  getArtist,
  getTrack,
  getVideo,
  getPlaylist,
  getItems,
  getByUrl,
  getStreamUrl,
  getVideoStreamUrl,
  getTrackContributors,
  getLyrics,
  getCoverUrl,
  getCoverData,
  getArtistsName,
  parseMpd,
};
