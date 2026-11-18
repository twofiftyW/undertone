import { escapeHTML as h } from './core.js';
import { tr } from './i18n.js';

export function coverSongs(album) {
  return (album?.coverTracks?.length ? album.coverTracks : album?.tracks || []).slice(0, 4);
}

// Keep the first four in order, including repeated artwork on the same release.
export function coverCollage(album) {
  const songs = coverSongs(album);
  if (!songs.length) return '<svg class="icon" aria-hidden="true"><use href="#i-music"/></svg>';
  return `<span class="cover-collage" aria-label="${h(tr('Cover made from the first four songs'))}">${Array.from({ length: 4 }, (_, i) => {
    const song = songs[i % songs.length];
    const title = song.title || album.title || '♪';
    let hash = 0;
    for (const c of title) hash = (hash * 31 + c.codePointAt(0)) | 0;
    return `<span class="cover-tile" style="--tile-hue:${Math.abs(hash) % 360}">${song.artwork ? `<img class="cover" data-cover src="${h(song.artwork)}" alt="" loading="lazy">` : `<span>${h(title.slice(0, 2).toLocaleUpperCase())}</span>`}</span>`;
  }).join('')}</span>`;
}
