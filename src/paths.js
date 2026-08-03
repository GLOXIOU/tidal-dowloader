const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, '..', 'settings.json');
const ILLEGAL_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

function sanitize(name) {
  return String(name ?? '').replace(ILLEGAL_CHARS, '_').trim() || 'unknown';
}

function getSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { downloadDir: process.env.DOWNLOAD_DIR || './downloads' };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function getBaseDir() {
  const { downloadDir } = getSettings();
  const resolved = path.resolve(downloadDir || './downloads');
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function getAlbumDir(album) {
  const artist = sanitize(album?.artists?.[0]?.name || album?.artist?.name || 'Unknown Artist');
  const title = sanitize(album?.title || 'Unknown Album');
  const dir = path.join(getBaseDir(), artist, title);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extensionForStream(stream) {
  const codec = (stream?.codec || '').toUpperCase();
  return /FLAC|MQA/.test(codec) ? '.flac' : '.m4a';
}

function getTrackPath(track, stream, album) {
  const dir = getAlbumDir(album);
  const num = String(track.trackNumberOnPlaylist || track.trackNumber || 0).padStart(2, '0');
  const title = sanitize(track.version ? `${track.title} (${track.version})` : track.title);
  return path.join(dir, `${num} - ${title}${extensionForStream(stream)}`);
}

function getCoverPath(album) {
  return path.join(getAlbumDir(album), 'cover.jpg');
}

module.exports = { getSettings, saveSettings, getBaseDir, getAlbumDir, getTrackPath, getCoverPath, sanitize };
