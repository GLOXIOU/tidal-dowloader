const EventEmitter = require('events');
const fs = require('fs');
const tidalApi = require('./tidalApi');
const { decryptSecurityToken, decryptFile } = require('./decryption');
const { writeTrackTags } = require('./tags');
const { getTrackPath, getSingleTrackPath, getPlaylistTrackPath } = require('./paths');

const MAX_CONCURRENT = 3; // items de la queue (morceaux seuls / batches) en parallèle
const TRACKS_PER_BATCH_CONCURRENT = 3; // morceaux en parallèle à l'intérieur d'une playlist/album
const SEGMENTS_CONCURRENT = 6; // segments audio en parallèle par morceau

const noopRes = { cookie() {}, clearCookie() {} };

/**
 * Exécute `tasks.length` jobs avec au plus `limit` en vol simultanément.
 * `worker(index)` doit gérer lui-même les erreurs qu'il ne veut pas propager.
 */
async function runPool(count, limit, worker) {
  let idx = 0;
  const size = Math.max(1, Math.min(limit, count));
  const runners = Array.from({ length: size }, async () => {
    while (idx < count) {
      const my = idx++;
      await worker(my);
    }
  });
  await Promise.all(runners);
}

class DownloadQueue extends EventEmitter {
  constructor() {
    super();
    this.items = [];
    this.active = 0;
    this._seq = 0;
  }

  list() {
    return this.items.map((item) => this._public(item));
  }

  _public(item) {
    const { task, ...pub } = item;
    return pub;
  }

  _emitUpdate(item) {
    this.emit('update', this._public(item));
  }

  async enqueueFromResolved(session, resolved, quality) {
    const reqShim = { tidal: { ...session } };

    if (resolved.type === 'track') {
      const album = await tidalApi.getAlbum(reqShim, noopRes, resolved.data.album.id);
      return [this._pushTrack(reqShim, resolved.data, album, quality)];
    }

    if (resolved.type === 'album' || resolved.type === 'playlist') {
      return [await this._pushBatch(reqShim, resolved, quality)];
    }

    throw new Error(`Type non téléchargeable: ${resolved.type}`);
  }

  _pushTrack(reqShim, track, album, quality) {
    const item = {
      id: ++this._seq,
      kind: 'track',
      title: track.version ? `${track.title} (${track.version})` : track.title,
      sub: track.artists?.[0]?.name || track.artist?.name || '',
      cover: album?.cover || null,
      status: 'queued',
      progress: 0,
      error: null,
      path: null,
    };
    item.task = () => this._downloadOneTrack(reqShim, item, track, album, quality, { type: 'single' });
    this.items.unshift(item);
    this._emitUpdate(item);
    this._schedule();
    return item.id;
  }

  async _pushBatch(reqShim, resolved, quality) {
    const isPlaylist = resolved.type === 'playlist';
    const listId = isPlaylist ? resolved.data.uuid : resolved.data.id;
    const { tracks } = await tidalApi.getItems(reqShim, noopRes, listId, isPlaylist ? 'playlist' : 'album');

    const item = {
      id: ++this._seq,
      kind: 'batch',
      title: resolved.data.title,
      sub: `0/${tracks.length} titres`,
      cover: isPlaylist ? resolved.data.squareImage || resolved.data.image : resolved.data.cover,
      status: 'queued',
      progress: 0,
      total: tracks.length,
      doneCount: 0,
      error: null,
      path: null,
    };
    item.task = () => this._downloadBatch(reqShim, item, tracks, resolved.data, isPlaylist, quality);
    this.items.unshift(item);
    this._emitUpdate(item);
    this._schedule();
    return item.id;
  }

  _schedule() {
    while (this.active < MAX_CONCURRENT) {
      const next = this.items.find((i) => i.status === 'queued');
      if (!next) break;
      next.status = 'downloading';
      this.active++;
      this._emitUpdate(next);
      Promise.resolve(next.task())
        .catch((err) => {
          next.status = 'error';
          next.error = err.message;
        })
        .finally(() => {
          this.active--;
          this._emitUpdate(next);
          this._schedule();
        });
    }
  }

  async _downloadBatch(reqShim, item, tracks, listData, isPlaylist, quality) {
    let done = 0;
    let lastError = null;
    const pathCtx = isPlaylist ? { type: 'playlist', playlistTitle: listData.title } : { type: 'album' };

    // Plusieurs morceaux du batch en parallèle, au lieu d'un par un.
    await runPool(tracks.length, TRACKS_PER_BATCH_CONCURRENT, async (i) => {
      const track = tracks[i];
      track.trackNumberOnPlaylist = i + 1;
      try {
        const album = isPlaylist ? await tidalApi.getAlbum(reqShim, noopRes, track.album.id) : listData;
        await this._downloadOneTrack(reqShim, null, track, album, quality, pathCtx);
        done++;
      } catch (err) {
        lastError = err;
      }
      item.doneCount = done;
      item.progress = Math.round((done / tracks.length) * 100);
      item.sub = `${done}/${tracks.length} titres`;
      this._emitUpdate(item);
    });

    if (done === 0) throw lastError || new Error("Aucun titre n'a pu être téléchargé.");

    item.status = 'done';
    item.progress = 100;
    if (done < tracks.length) item.error = `${tracks.length - done} titre(s) n'ont pas pu être téléchargés.`;
    this._emitUpdate(item);
  }

  async _downloadOneTrack(reqShim, item, track, album, quality, pathCtx = { type: 'album' }) {
    const stream = await tidalApi.getStreamUrl(reqShim, noopRes, track.id, quality);
    const finalPath =
      pathCtx.type === 'single'
        ? getSingleTrackPath(track, stream)
        : pathCtx.type === 'playlist'
          ? getPlaylistTrackPath(track, stream, pathCtx.playlistTitle)
          : getTrackPath(track, stream, album);
    const partPath = finalPath + '.part';

    await this._downloadSegments(stream.urls, partPath, (progress) => {
      if (!item) return;
      item.progress = progress;
      this._emitUpdate(item);
    });

    if (stream.encryptionKey) {
      if (item) {
        item.status = 'decrypting';
        this._emitUpdate(item);
      }
      const { key, nonce } = decryptSecurityToken(stream.encryptionKey);
      await decryptFile(partPath, finalPath, key, nonce);
      fs.unlinkSync(partPath);
    } else {
      fs.renameSync(partPath, finalPath);
    }

    if (item) {
      item.status = 'tagging';
      this._emitUpdate(item);
    }

    // Contributeurs, paroles et cover sont indépendants : on les récupère en parallèle
    // plutôt que d'attendre chacun l'un après l'autre.
    const [contributors, lyrics, coverBuffer] = await Promise.all([
      tidalApi.getTrackContributors(reqShim, noopRes, track.id).catch(() => null),
      tidalApi
        .getLyrics(reqShim, noopRes, track.id)
        .then((res) => res?.subtitles || null)
        .catch(() => null),
      tidalApi.getCoverData(album.cover),
    ]);

    const composers = (contributors?.items || []).filter((c) => c.role === 'Composer').map((c) => c.name);

    writeTrackTags(finalPath, {
      title: track.title,
      version: track.version,
      artists: (track.artists?.length ? track.artists : [track.artist]).filter(Boolean).map((a) => a.name),
      albumArtists: (album.artists?.length ? album.artists : [album.artist]).filter(Boolean).map((a) => a.name),
      album: album.title,
      copyright: track.copyRight,
      trackNumber: track.trackNumberOnPlaylist || track.trackNumber,
      trackCount: album.numberOfTracks,
      discNumber: track.volumeNumber,
      discCount: album.numberOfVolumes,
      composers,
      isrc: track.isrc,
      lyrics,
      coverBuffer,
      year: album.releaseDate ? Number(String(album.releaseDate).slice(0, 4)) : undefined,
    });

    if (item) {
      item.status = 'done';
      item.progress = 100;
      item.path = finalPath;
      this._emitUpdate(item);
    }
  }

  async _downloadSegments(urls, destPath, onProgress) {
    const out = fs.createWriteStream(destPath);
    let writeError = null;
    out.on('error', (err) => {
      writeError = err;
    });

    try {
      let doneCount = 0;
      let nextToWrite = 0;
      const pending = new Map();

      // Écrit sur disque, dans l'ordre, tous les segments déjà téléchargés
      // qui font suite au dernier écrit (les segments peuvent finir dans le désordre
      // puisqu'ils sont fetchés en parallèle).
      const flushReady = async () => {
        while (pending.has(nextToWrite)) {
          if (writeError) throw writeError;
          const buf = pending.get(nextToWrite);
          pending.delete(nextToWrite);
          const canContinue = out.write(buf);
          if (!canContinue) {
            await new Promise((resolve) => out.once('drain', resolve));
          }
          nextToWrite++;
          doneCount++;
          onProgress(Math.round((doneCount / urls.length) * 100));
        }
      };

      await runPool(urls.length, SEGMENTS_CONCURRENT, async (i) => {
        const res = await fetch(urls[i]);
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        pending.set(i, buf);
        await flushReady();
      });

      if (writeError) throw writeError;
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
  }
}

module.exports = new DownloadQueue();