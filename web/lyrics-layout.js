import { tr } from './i18n.js';

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
  const artwork = track.artwork || '';
  for (const image of dialog.querySelectorAll('.lyrics-cover img, .lyrics-backdrop img')) {
    if (image.getAttribute('src') === artwork) continue;
    image.hidden = true;
    if (!artwork) {
      image.removeAttribute('src');
      continue;
    }
    image.onload = () => { image.hidden = false; };
    image.onerror = () => { image.hidden = true; };
    image.src = artwork;
  }
}
