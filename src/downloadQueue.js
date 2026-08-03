const EventEmitter = require('events');
const fs = require('fs');
const tidalApi = require('./tidalApi');
const { decryptSecurityToken, decryptFile } = require('./decryption');
const { writeTrackTags } = require('./tags');
const { getTrackPath } = require('./paths');

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
      return [this._push(reqShim, resolved.data, album, quality)];
    }

    if (resolved.type === 'album') {
      const { tracks } = await tidalApi.getItems(reqShim, noopRes, resolved.data.id, 'album');
      return tracks.map((t, i) => {
        t.trackNumberOnPlaylist = i + 1;
        return this._push(reqShim, t, resolved.data, quality);
      });
    }

    if (resolved.type === 'playlist') {
      const { tracks } = await tidalApi.getItems(reqShim, noopRes, resolved.data.uuid, 'playlist');
      const ids = [];
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        t.trackNumberOnPlaylist = i + 1;
        const album = await tidalApi.getAlbum(reqShim, noopRes, t.album.id);
        ids.push(this._push(reqShim, t, album, quality));
      }
      return ids;
    }

    throw new Error(`Type non téléchargeable: ${resolved.type}`);
  }

  _push(reqShim, track, album, quality) {
    const item = {
      id: ++this._seq,
      title: track.version ? `${track.title} (${track.version})` : track.title,
      artist: track.artists?.[0]?.name || track.artist?.name || '',
      status: 'queued',
      progress: 0,
      error: null,
      path: null,
    };
    item.task = () => this._downloadTrack(reqShim, item, track, album, quality);
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

  async _downloadTrack(reqShim, item, track, album, quality) {
    const stream = await tidalApi.getStreamUrl(reqShim, noopRes, track.id, quality);
    const finalPath = getTrackPath(track, stream, album);
    const partPath = finalPath + '.part';

    await this._downloadSegments(stream.urls, partPath, (progress) => {
      item.progress = progress;
      this._emitUpdate(item);
    });

    if (stream.encryptionKey) {
      item.status = 'decrypting';
      this._emitUpdate(item);
      const { key, nonce } = decryptSecurityToken(stream.encryptionKey);
      await decryptFile(partPath, finalPath, key, nonce);
      fs.unlinkSync(partPath);
    } else {
      fs.renameSync(partPath, finalPath);
    }

    item.status = 'tagging';
    this._emitUpdate(item);

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

    item.status = 'done';
    item.progress = 100;
    item.path = finalPath;
    this._emitUpdate(item);
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
