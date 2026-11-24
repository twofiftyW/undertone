import { formatTime } from './core.js';
import { tr } from './i18n.js';
import { lyricsLayout, showLyricsTrack } from './lyrics-layout.js';

const notices = {
  loading: 'Loading lyrics…',
  instrumental: 'This track is instrumental.',
  missing: 'No lyrics found for this recording.',
  error: 'Couldn’t load lyrics. Check your connection and try again.',
};

export function createLyricsView({ dialog, openDialog, closeDialog, seekPlayback }) {
  const isOpen = () => dialog.open && dialog.dataset.kind === 'lyrics';
  const find = selector => dialog.querySelector(selector);
  let scroller, follow, seek, elapsed, durationLabel, play, resize;
  let rows = [], active = -1, tabStop, following = true;
  let length = 0, loading = false, scrubbing = false;

  function center(row, animate) {
    if (!row || !scroller.clientHeight) return;
    const viewport = scroller.getBoundingClientRect();
    const line = row.getBoundingClientRect();
    const distance = line.top - viewport.top - Math.max(0, (viewport.height - line.height) / 2);
    if (Math.abs(distance) < 1) return;
    const smooth = animate && Math.abs(distance) < viewport.height * 1.5 && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: scroller.scrollTop + distance, behavior: smooth ? 'smooth' : 'auto' });
  }

  function setTabStop(row) {
    if (!row || row === tabStop) return;
    if (tabStop) tabStop.tabIndex = -1;
    tabStop = row;
    row.tabIndex = 0;
  }

  function readManually() {
    if (!following || !rows.length) return;
    following = false;
    follow.hidden = false;
    scroller.scrollTo({ top: scroller.scrollTop, behavior: 'auto' });
  }

  function resumeFollowing() {
    following = true;
    follow.hidden = true;
    const row = rows[active] || tabStop;
    setTabStop(row);
    center(row, true);
    (row || scroller).focus({ preventScroll: true });
  }

  function bindScroller() {
    scroller.addEventListener('wheel', readManually, { passive: true });
    scroller.addEventListener('touchmove', readManually, { passive: true });
    scroller.addEventListener('pointerdown', event => {
      if (event.target === scroller && event.pointerType === 'mouse') readManually();
    });
    scroller.addEventListener('keydown', event => {
      const row = event.target.closest('.lyrics-line');
      if (!row) return;
      let next;
      switch (event.key) {
        case 'ArrowUp': next = row.previousElementSibling; break;
        case 'ArrowDown': next = row.nextElementSibling; break;
        case 'Home': next = scroller.firstElementChild; break;
        case 'End': next = scroller.lastElementChild; break;
        case 'PageDown': case 'PageUp': readManually(); return;
        default: return;
      }
      event.preventDefault();
      if (!next) return;
      readManually();
      setTabStop(next);
      next.focus({ preventScroll: true });
      center(next, false);
    });
    scroller.addEventListener('click', event => {
      const row = event.target.closest('.lyrics-line');
      if (!row || !seekPlayback(Number(row.dataset.time))) return;
      // A tap can target the current line after manual scrolling, too.
      following = true;
      follow.hidden = true;
      setTabStop(row);
      center(row, true);
    });
    follow.addEventListener('click', resumeFollowing);
  }

  function rangePosition() { return Number(seek.value) / Number(seek.max) * length; }
  function paintRange() {
    seek.style.setProperty('--fill', (Number(seek.value) / Number(seek.max) * 100) + '%');
    seek.setAttribute('aria-valuetext', formatTime(rangePosition()) + ' / ' + formatTime(length));
  }

  function show(track) {
    if (!isOpen()) {
      openDialog(lyricsLayout(), 'lyrics');
      scroller = find('.lyrics-scroll');
      follow = find('.lyrics-follow');
      follow.textContent = tr('Back to current line');
      seek = find('.lyrics-seek');
      elapsed = find('.lyrics-elapsed');
      durationLabel = find('.lyrics-duration');
      play = find('.lyrics-play');
      bindScroller();
      seek.addEventListener('input', () => {
        scrubbing = true;
        elapsed.textContent = formatTime(rangePosition());
        paintRange();
      });
      seek.addEventListener('change', () => {
        scrubbing = false;
        seekPlayback(rangePosition());
      });
      seek.addEventListener('pointerup', () => { scrubbing = false; });
      seek.addEventListener('pointercancel', () => { scrubbing = false; });
      seek.addEventListener('blur', () => { scrubbing = false; });
      if (window.ResizeObserver) {
        resize?.disconnect();
        resize = new ResizeObserver(() => { if (isOpen() && following) center(rows[active], false); });
        resize.observe(scroller);
      }
    }
    scrubbing = false;
    showLyricsTrack(dialog, track);
    render({ kind: 'loading' });
  }

  function render({ kind, lines, text, storageFailed }) {
    if (!isOpen()) return;
    const status = find('.lyrics-status');
    const load = find('.lyrics-load');
    const note = find('.lyrics-note');
    const hasLyrics = kind === 'timed' || kind === 'plain';
    rows = [];
    active = -1;
    tabStop = null;
    following = true;
    follow.hidden = true;
    status.textContent = notices[kind] ? tr(notices[kind]) : '';
    status.hidden = !status.textContent;
    load.hidden = kind !== 'error';
    if (!load.hidden) load.textContent = tr('Retry');
    note.textContent = storageFailed ? tr('Couldn’t save lyrics for offline use.') : '';
    note.hidden = !storageFailed;
    scroller.replaceChildren();
    scroller.dataset.kind = kind;
    scroller.hidden = !hasLyrics;
    scroller.tabIndex = kind === 'timed' ? -1 : 0;
    find('.lyrics-footer').hidden = !hasLyrics;

    if (kind === 'timed') {
      const fragment = document.createDocumentFragment();
      rows = lines.map((line, index) => {
        if (!line.text) return null;
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'lyrics-line';
        row.dir = 'auto';
        row.tabIndex = -1;
        row.dataset.lineIndex = String(index);
        row.dataset.time = String(line.time);
        row.textContent = line.text;
        row.setAttribute('aria-label', formatTime(line.time) + ' · ' + line.text);
        fragment.append(row);
        return row;
      });
      setTabStop(fragment.firstElementChild);
      scroller.append(fragment);
    } else if (kind === 'plain') {
      const plain = document.createElement('p');
      plain.className = 'lyrics-plain';
      plain.dir = 'auto';
      plain.textContent = text;
      scroller.append(plain);
    }
    scroller.scrollTop = 0;
  }

  function highlight(index) {
    if (!isOpen() || active === index) return;
    const old = active;
    rows[old]?.removeAttribute('aria-current');
    active = index;
    const row = rows[index];
    if (!row) return;
    row.setAttribute('aria-current', 'true');
    if (following) {
      if (!scroller.contains(document.activeElement)) setTabStop(row);
      center(row, old !== -1);
    }
  }

  function playback(playing, busy) {
    if (!isOpen()) return;
    loading = busy;
    play.querySelector('use').setAttribute('href', playing ? '#i-pause' : '#i-play');
    play.setAttribute('aria-label', tr(playing ? 'Pause' : 'Play'));
    play.setAttribute('aria-busy', String(busy));
    seek.disabled = loading || !length;
  }

  function progress(position, duration) {
    if (!isOpen()) return;
    const durationChanged = duration !== length;
    length = duration;
    seek.disabled = loading || !length;
    const total = formatTime(duration);
    if (durationLabel.textContent !== total) durationLabel.textContent = total;
    if (scrubbing) return;
    const time = formatTime(position);
    if (elapsed.textContent !== time) elapsed.textContent = time;
    const value = String(length ? Math.round(Math.min(1, Math.max(0, position / length)) * Number(seek.max)) : 0);
    if (seek.value !== value || durationChanged || !seek.hasAttribute('aria-valuetext')) {
      seek.value = value;
      paintRange();
    }
  }

  return { show, render, highlight, playback, progress, isOpen, close() { if (isOpen()) closeDialog(); } };
}
