const { File, Picture, ByteVector, PictureType } = require('node-taglib-sharp');

function writeTrackTags(filePath, meta) {
  const file = File.createFromPath(filePath);
  try {
    const tag = file.tag;

    tag.title = meta.version ? `${meta.title} (${meta.version})` : meta.title;
    tag.performers = meta.artists;
    tag.album = meta.album;
    tag.albumArtists = meta.albumArtists;
    tag.copyright = meta.copyright || undefined;
    tag.track = meta.trackNumber || 0;
    tag.disc = meta.discNumber || 0;
    tag.discCount = meta.discCount || 0;
    if (meta.discCount <= 1) tag.trackCount = meta.trackCount || 0;
    if (meta.composers?.length) tag.composers = meta.composers;
    if (meta.isrc) tag.isrc = meta.isrc;
    if (meta.lyrics) tag.lyrics = meta.lyrics;
    if (meta.year) tag.year = meta.year;

    if (meta.coverBuffer) {
      tag.pictures = [
        Picture.fromFullData(
          ByteVector.fromByteArray(meta.coverBuffer),
          PictureType.FrontCover,
          'image/jpeg',
          'cover',
        ),
      ];
    }

    file.save();
  } finally {
    file.dispose();
  }
}

module.exports = { writeTrackTags };
