const EventEmitter = require('events');
const fs = require('fs');
const tidalApi = require('./tidalApi');
const { decryptSecurityToken, decryptFile } = require('./decryption');
const { writeTrackTags } = require('./tags');
const { getTrackPath, getSingleTrackPath, getPlaylistTrackPath } = require('./paths');

const MAX_CONCURRENT = 3;
const noopRes = { cookie() {}, clearCookie() {} };

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

    for (let i = 0; i < tracks.length; i++) {
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
    }

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

    let contributors = null;
    try {
      contributors = await tidalApi.getTrackContributors(reqShim, noopRes, track.id);
    } catch {
      contributors = null;
    }
    let lyrics = null;
    try {
      lyrics = (await tidalApi.getLyrics(reqShim, noopRes, track.id))?.subtitles || null;
    } catch {
      lyrics = null;
    }
    const coverBuffer = await tidalApi.getCoverData(album.cover);

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
    try {
      let done = 0;
      for (const url of urls) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        await new Promise((resolve, reject) => out.write(buf, (err) => (err ? reject(err) : resolve())));
        done++;
        onProgress(Math.round((done / urls.length) * 100));
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
  }
}

module.exports = new DownloadQueue();
