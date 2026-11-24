import { tr } from './i18n.js';
import { rememberCoverColors, sampleCover, savedCoverColors } from './cover-palette.js';

const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

export function lyricsLayout() {
  return `<div class="lyrics-backdrop" aria-hidden="true"><img alt="" hidden></div>
    <div class="lyrics-stage">
      <h2 class="lyrics-heading" id="dialog-title">${icon('lyrics')}${tr('Lyrics')}</h2>
      <button type="button" class="lyrics-close" data-action="close-dialog" aria-label="${tr('Close dialog')}" autofocus>${icon('close')}</button>
      <div class="lyrics-recording">
        <div class="lyrics-cover" aria-hidden="true"><span class="lyrics-vinyl"></span><img alt="" hidden></div>
        <div class="lyrics-metadata"><h3 class="lyrics-title" dir="auto"></h3><p class="lyrics-artist" dir="auto"></p></div>
      </div>
      <div class="lyrics-reader">
        <div class="lyrics-scroll" role="region" aria-label="${tr('Lyrics')}" tabindex="0" hidden></div>
        <div class="lyrics-feedback">
          <p class="lyrics-status" role="status"></p>
          <button type="button" class="lyrics-load" data-action="lyrics-retry" hidden></button>
        </div>
        <div class="lyrics-footer" hidden><span class="lyrics-credit">LRCLIB</span><button type="button" class="lyrics-follow" hidden></button></div>
        <p class="lyrics-note" role="status" hidden></p>
      </div>
      <div class="lyrics-player">
        <div class="lyrics-timeline">
          <input type="range" class="lyrics-seek" aria-label="${tr('Seek through track')}" min="0" max="1000" value="0" disabled>
          <span class="lyrics-elapsed">0:00</span><span class="lyrics-duration">0:00</span>
        </div>
        <div class="lyrics-controls">
          <button type="button" class="lyrics-previous" data-action="previous" aria-label="${tr('Previous track')}">${icon('prev')}</button>
          <button type="button" class="lyrics-play" data-action="play-pause" aria-label="${tr('Play')}">${icon('play')}</button>
          <button type="button" class="lyrics-next" data-action="next" aria-label="${tr('Next track')}">${icon('next')}</button>
        </div>
      </div>
    </div>`;
}

export function showLyricsTrack(dialog, track) {
  dialog.querySelector('.lyrics-title').textContent = track.title;
  dialog.querySelector('.lyrics-artist').textContent = track.artist || '';
  const youtube = track.source === 'youtube' && /^[\w-]{11}$/.test(track.remoteId || '');
  const artwork = track.artwork || track.album?.artwork || (youtube ? `https://i.ytimg.com/vi/${track.remoteId}/hqdefault.jpg` : '');
  const previous = dialog.querySelector('.lyrics-cover img');
  if (previous.getAttribute('src') === artwork) return;
  const backdrop = dialog.querySelector('.lyrics-backdrop');
  const blurred = backdrop.querySelector('img');
  blurred.hidden = true;
  blurred.removeAttribute('src');
  resetColors(backdrop);
  const cover = new Image();
  cover.alt = '';
  cover.hidden = true;
  previous.replaceWith(cover);
  if (!artwork) return;
  const saved = savedCoverColors(artwork);
  if (saved) setColors(backdrop, saved);
  else cover.crossOrigin = 'anonymous';
  cover.onload = () => {
    if (!cover.isConnected) return;
    cover.hidden = false;
    if (saved) return;
    let colors;
    try { colors = sampleCover(cover); } catch { /* Some CDNs allow display but disallow reading pixels. */ }
    if (colors) {
      setColors(backdrop, colors);
      rememberCoverColors(artwork, colors);
    } else {
      blurred.src = artwork;
      blurred.hidden = false;
    }
  };
  cover.onerror = () => {
    if (!cover.isConnected || !cover.hasAttribute('crossorigin')) return;
    // A display-only image still supplies a blurred backdrop without canvas access.
    cover.removeAttribute('crossorigin');
    cover.src = artwork;
  };
  cover.src = artwork;
}

function resetColors(backdrop) {
  for (const name of ['--lyrics-wash', '--lyrics-glow', '--lyrics-base']) backdrop.style.removeProperty(name);
}

function setColors(backdrop, [hue, saturation, lightness, secondary]) {
  backdrop.style.setProperty('--lyrics-wash', `hsl(${hue}, ${saturation}%, ${lightness}%)`);
  backdrop.style.setProperty('--lyrics-glow', `hsl(${secondary}, ${saturation}%, ${lightness - 7}%)`);
  backdrop.style.setProperty('--lyrics-base', `hsl(${hue}, ${saturation}%, ${Math.round(lightness / 3)}%)`);
}
