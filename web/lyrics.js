function cleanField(value) {
  return typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
}

export function lyricsQuery(track) {
  const title = cleanField(track?.title);
  const credits = Array.isArray(track?.artists) ? track.artists : [];
  const artist = cleanField(track?.artist) || credits.map(person => cleanField(person?.name)).filter(Boolean).join(', ');
  if (!title || !artist || /^unknown artist$/i.test(artist) || (track.source === 'local' && artist === 'Your files')) return null;
  const album = cleanField(track.album?.title ?? track.album);
  const seconds = Number(track.duration);
  return { title, artist, album, duration: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : 0 };
}

export function lyricsKey(track) {
  if (!track) return '';
  const id = track.id || track.remoteId || track.fileId;
  // A queue occurrence or a better duration estimate doesn't change the recording.
  if (id) return JSON.stringify(['id', track.source || '', String(id)]);
  const query = lyricsQuery(track);
  if (!query) return '';
  return JSON.stringify(['metadata', query.artist.toLowerCase(), query.title.toLowerCase(), query.album.toLowerCase(), query.duration]);
}

export function parseLrc(source) {
  if (typeof source !== 'string') return [];
  const timeline = new Map();
  let offset = 0;
  for (const raw of source.split(/\r\n?|\n/)) {
    const line = raw.trim();
    const shift = /^\[offset:\s*([+-]?\d{1,9})\s*\]$/i.exec(line);
    if (shift) { offset = Number(shift[1]); continue; }

    // One lyric can have multiple timestamps (a repeated chorus, for example).
    const prefix = /^(?:\[\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?\]\s*)+/.exec(line)?.[0];
    if (!prefix) continue;
    const text = line.slice(prefix.length).replace(/<\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?>/g, '').trim();
    for (const [, minutes, seconds, fraction = ''] of prefix.matchAll(/\[(\d+):(\d{2})(?:[.:](\d+))?\]/g)) {
      const ms = (Number(minutes) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, '0'));
      if (!timeline.has(ms)) timeline.set(ms, new Set());
      if (text) timeline.get(ms).add(text);
    }
  }
  // Positive LRC offsets display the line earlier. A timestamp with no words
  // ends the highlight during instrumental passages and after the last lyric.
  return [...timeline].sort(([a], [b]) => a - b).map(([ms, texts]) => ({ time: (ms - offset) / 1000, text: [...texts].join('\n') }));
}

export function activeLyricIndex(lines, seconds) {
  if (!Number.isFinite(seconds)) return -1;
  let low = 0, high = lines.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (lines[mid].time <= seconds) low = mid + 1;
    else high = mid;
  }
  return low && lines[low - 1].text ? low - 1 : -1;
}

function lyricContent(record) {
  if (record.instrumental) return { kind: 'instrumental' };
  const lines = parseLrc(record.syncedLyrics);
  if (lines.some(line => line.text)) return { kind: 'timed', lines };
  const text = typeof record.plainLyrics === 'string' ? record.plainLyrics.replace(/\r\n?/g, '\n').trim() : '';
  return text ? { kind: 'plain', text } : { kind: 'missing' };
}

// The music backend keeps successful lookups on disk, including on iOS where
// the local web origin can change. A cache-only read never initiates a lookup.
export function createLyricsLoader(fetchLyrics) {
  const lookups = new Map();
  const reads = new Map();
  return async function load(track, { cacheOnly = false } = {}) {
    const query = lyricsQuery(track);
    if (!query) return cacheOnly ? null : { kind: 'missing' };
    const key = lyricsKey(track);
    const pending = cacheOnly ? reads : lookups;
    if (!pending.has(key)) {
      const request = Promise.resolve().then(() => fetchLyrics({ ...query, key, cacheOnly })).then(record => {
        if (!record) return cacheOnly ? null : { kind: 'missing' };
        const content = lyricContent(record);
        if (record.storageFailed) content.storageFailed = true;
        return content;
      }).finally(() => pending.delete(key));
      pending.set(key, request);
    }
    return pending.get(key);
  };
}
