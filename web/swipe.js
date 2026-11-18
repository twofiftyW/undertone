const COMMIT_DISTANCE = 68;

export function swipeToQueue(view, add) {
  let gesture;
  let suppressClick;

  function end(event, commit = false) {
    if (gesture?.pointer !== event.pointerId) return;
    const { row, distance, horizontal } = gesture;
    gesture = null;
    row.classList.remove('swiping', 'swipe-ready');
    row.style.removeProperty('--swipe-offset');
    if (!horizontal) return;
    suppressClick = { row, until: globalThis.performance.now() + 350 };
    if (commit && distance >= COMMIT_DISTANCE && row.isConnected) add(row.dataset.trackId);
  }

  view.addEventListener('pointerdown', event => {
    if (!event.isPrimary || event.pointerType !== 'touch') return;
    const row = event.target.closest('.track-row[data-track-id]:not(.unmatched-row)');
    if (!row || event.target.closest('.row-actions, .row-source, .artist-link')) return;
    suppressClick = null;
    gesture = { row, pointer: event.pointerId, x: event.clientX, y: event.clientY, distance: 0, horizontal: false };
  });
  view.addEventListener('pointermove', event => {
    if (gesture?.pointer !== event.pointerId) return;
    const { row } = gesture;
    const dx = event.clientX - gesture.x;
    const dy = Math.abs(event.clientY - gesture.y);
    if (!gesture.horizontal) {
      if ((dy > 10 && dy >= Math.abs(dx)) || dx < -12 || !row.isConnected) { gesture = null; return; }
      if (dx < 12 || dx < dy * 1.3) return;
      gesture.horizontal = true;
      row.classList.add('swiping');
      row.setPointerCapture(event.pointerId);
    }
    gesture.distance = dx;
    row.classList.toggle('swipe-ready', dx >= COMMIT_DISTANCE);
    row.style.setProperty('--swipe-offset', `${Math.max(0, Math.min(100, dx))}px`);
  });
  view.addEventListener('pointerup', event => end(event, true));
  view.addEventListener('pointercancel', event => end(event));
  // Touch initially captures on the child button. Moving capture to the row is not cancellation.
  view.addEventListener('lostpointercapture', event => { if (event.target === gesture?.row) end(event); });
  view.addEventListener('click', event => {
    if (event.detail && suppressClick && globalThis.performance.now() < suppressClick.until && suppressClick.row.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      suppressClick = null;
    }
  }, true);
}
