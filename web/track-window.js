// Keep the document scrollbar at its full size, including when a collection is
// restored at an offset far beyond the rows initially visible on screen.
const rowHeight = 62;

export function trackWindowRange(count, top, viewport) {
  const buffer = Math.max(32, Math.ceil(2 * viewport / rowHeight));
  const clamp = index => Math.max(0, Math.min(count, index));
  return {
    start: clamp(Math.floor(-top / rowHeight) - buffer),
    end: clamp(Math.ceil((viewport - top) / rowHeight) + buffer),
  };
}

export class TrackWindows {
  constructor() {
    this.lists = new Map();
    // WebView dispatches document scroll before animation frames. Fill the new
    // rows immediately so a fast fling cannot paint a stale window for a frame.
    const refresh = () => this.refresh();
    window.addEventListener('scroll', refresh, { passive: true });
    window.addEventListener('resize', refresh);
  }

  clear() { this.lists.clear(); }

  placeholder(count, row) {
    const id = String(this.lists.size);
    this.lists.set(id, { count, row, start: 0, end: 0 });
    return `<div class="track-list" data-track-window="${id}" role="list" style="--track-row-height:${rowHeight}px;height:${count * rowHeight}px"></div>`;
  }

  mount(parent) {
    for (const element of parent.querySelectorAll('[data-track-window]')) {
      this.lists.get(element.dataset.trackWindow).element = element;
    }
    this.refresh();
  }

  refresh() {
    for (const list of this.lists.values()) {
      const element = list.element;
      if (!element?.isConnected) continue;
      const { start, end } = trackWindowRange(list.count, element.getBoundingClientRect().top, window.innerHeight);
      if (start === list.start && end === list.end) continue;

      const html = (first, last) => {
        let result = '';
        for (let index = first; index < last; index++) result += list.row(index);
        return result;
      };
      if (start >= list.end || end <= list.start) {
        element.innerHTML = html(start, end);
      } else {
        // Retain overlapping nodes and their decoded covers, focus and touch targets.
        for (let index = list.start; index < start; index++) element.firstElementChild.remove();
        for (let index = list.end; index > end; index--) element.lastElementChild.remove();
        if (start < list.start) element.insertAdjacentHTML('afterbegin', html(start, list.start));
        if (end > list.end) element.insertAdjacentHTML('beforeend', html(list.end, end));
      }
      element.style.paddingTop = `${start * rowHeight}px`;
      list.start = start;
      list.end = end;
    }
  }
}
