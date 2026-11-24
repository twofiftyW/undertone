import { tr } from './i18n.js';

const notices = {
  loading: 'Loading lyrics…',
  instrumental: 'This track is instrumental.',
  missing: 'No lyrics found for this recording.',
  unavailable: 'No lyrics found for this recording.',
  error: 'Couldn’t load lyrics. Check your connection and try again.',
};

export function createLyricsView({ dialog, openDialog, closeDialog, dialogTop }) {
  const isOpen = () => dialog.open && dialog.dataset.kind === 'lyrics';
  let scroller, follow, rows = [], active = -1, following = true, lastScrollTop = 0;

  function followLine() {
    const row = rows[active];
    if (!row || !following || !scroller.clientHeight) return;
    const viewport = scroller.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    const inset = Math.min(48, viewport.height * 0.15);
    if (bounds.top < viewport.top + inset || bounds.bottom > viewport.bottom - inset) {
      scroller.scrollTop += bounds.top - viewport.top - Math.max(0, (viewport.height - bounds.height) / 2);
      lastScrollTop = scroller.scrollTop;
    }
  }

  function show(track) {
    if (!isOpen()) {
      openDialog(`${dialogTop(tr('Lyrics'))}
        <p class="lyrics-track" dir="auto"></p>
        <p class="lyrics-status" role="status"></p>
        <button type="button" class="secondary-btn lyrics-load" data-action="lyrics-retry" hidden></button>
        <div class="lyrics-scroll" role="region" tabindex="0" hidden></div>
        <div class="lyrics-footer" hidden><span>LRCLIB</span><button type="button" class="text-button lyrics-follow" hidden></button></div>
        <p class="lyrics-note" role="status" hidden></p>`, 'lyrics');
      scroller = dialog.querySelector('.lyrics-scroll');
      scroller.setAttribute('aria-label', tr('Lyrics'));
      follow = dialog.querySelector('.lyrics-follow');
      follow.textContent = tr('Back to current line');
      follow.addEventListener('click', () => {
        scroller.focus({ preventScroll: true });
        following = true;
        follow.hidden = true;
        followLine();
      });
      scroller.addEventListener('scroll', () => {
        if (!rows.length || Math.abs(scroller.scrollTop - lastScrollTop) <= 1) return;
        following = false;
        follow.hidden = false;
      });
    }
    dialog.querySelector('.lyrics-track').textContent = [track.title, track.artist].filter(Boolean).join(' · ');
    render({ kind: 'loading' });
  }

  function render({ kind, lines, text, storageFailed }) {
    if (!isOpen()) return;
    const status = dialog.querySelector('.lyrics-status');
    const load = dialog.querySelector('.lyrics-load');
    const note = dialog.querySelector('.lyrics-note');
    const hasLyrics = kind === 'timed' || kind === 'plain';
    rows = [];
    active = -1;
    following = true;
    follow.hidden = true;
    status.textContent = notices[kind] ? tr(notices[kind]) : '';
    status.hidden = !status.textContent;
    load.hidden = kind !== 'idle' && kind !== 'error';
    if (!load.hidden) load.textContent = tr(kind === 'error' ? 'Retry' : 'Load lyrics');
    note.textContent = storageFailed ? tr('Couldn’t save lyrics for offline use.') : '';
    note.hidden = !storageFailed;
    scroller.replaceChildren();
    scroller.hidden = !hasLyrics;
    dialog.querySelector('.lyrics-footer').hidden = !hasLyrics;

    if (kind === 'timed') {
      const fragment = document.createDocumentFragment();
      rows = lines.map(line => {
        if (!line.text) return null;
        const row = document.createElement('p');
        row.className = 'lyrics-line';
        row.dir = 'auto';
        row.textContent = line.text;
        fragment.append(row);
        return row;
      });
      scroller.append(fragment);
    } else if (kind === 'plain') {
      const plain = document.createElement('p');
      plain.className = 'lyrics-plain';
      plain.dir = 'auto';
      plain.textContent = text;
      scroller.append(plain);
    }
    scroller.scrollTop = 0;
    lastScrollTop = scroller.scrollTop;
  }

  function highlight(index) {
    if (!isOpen() || active === index) return;
    rows[active]?.removeAttribute('aria-current');
    active = index;
    rows[active]?.setAttribute('aria-current', 'true');
    followLine();
  }

  return { show, render, highlight, isOpen, close() { if (isOpen()) closeDialog(); } };
}
