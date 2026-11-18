export function formatTime(value) {
  const seconds = Number.isFinite(Number(value)) ? Math.max(0, Math.floor(Number(value))) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function escapeHTML(value = "") {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function fileMetadata(filename) {
  const name = filename.replace(/\.[^.]+$/, "").replace(/_/g, " ").trim();
  const separator = name.indexOf(" - ");
  return separator > 0
    ? { artist: name.slice(0, separator).trim(), title: name.slice(separator + 3).trim() || name }
    : { artist: "Your files", title: name || "Untitled" };
}

export function nextIndex(index, length, { direction = 1, shuffle = false, repeat = "off", ended = false, random = Math.random } = {}) {
  if (!length) return -1;
  if (ended && repeat === "one") return index;
  if (shuffle && length > 1) return (index + 1 + Math.floor(random() * (length - 1))) % length;
  const next = index + direction;
  if (next >= 0 && next < length) return next;
  if (repeat === "all") return (next + length) % length;
  return -1;
}

export function matches(track, query) {
  return `${track.title} ${track.artist} ${track.genre || ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

export function emptyLibrary() {
  return { version: 1, tracks: {}, liked: [], imports: [], playlists: [], recent: [], followedArtists: [], downloads: {}, volume: 0.8 };
}

export function rankTracks(list, query) {
  const words = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) || [];
  const q = words(query);
  const normalized = q.join(" ");
  const variants = ["slowed", "reverb", "sped", "remix", "cover", "extended", "lyrics", "hour"];
  const score = (track) => {
    const title = words(track.title), artist = words(track.artist), terms = new Set([...title, ...artist]);
    let value = 100 * q.filter((word) => terms.has(word)).length / Math.max(1, q.length);
    if (normalized === title.join(" ") || normalized === artist.join(" ")) value += 30;
    if (normalized === [...artist, ...title].join(" ") || normalized === [...title, ...artist].join(" ")) value += 35;
    value -= 12 * variants.filter((word) => title.includes(word) && !q.includes(word)).length;
    if (track.kind === "song") value += 3;
    return value;
  };
  const unique = new Map();
  for (const track of list) if (!unique.has(track.id)) unique.set(track.id, track);
  return [...unique.values()].sort((a, b) => score(b) - score(a));
}

export function sortReleases(releases, filter = "all", sort = "date") {
  return [...releases].filter((r) => filter === "all" || (filter === "albums" ? r.type.toLowerCase() === "album" : r.type.toLowerCase() !== "album"))
    .sort((a, b) => sort === "name" ? a.title.localeCompare(b.title) : (b.releaseDate || b.year || "").localeCompare(a.releaseDate || a.year || ""));
}

export function sortPlaylists(playlists) {
  return [...playlists].sort((a, b) => {
    const ap = Number(a.pinnedAt) || 0, bp = Number(b.pinnedAt) || 0;
    if (!!ap !== !!bp) return ap ? -1 : 1;
    return ap && bp ? bp - ap : (Number(b.lastPlayedAt) || 0) - (Number(a.lastPlayedAt) || 0);
  });
}

export function queueEntries(tracks, playlistId = null, key = () => crypto.randomUUID()) {
  return tracks.filter(track => track.source !== 'unmatched').map(track => track.queueKey ? track : { ...track, queueKey: key(), playlistId });
}

export function insertUpNext(queue, index, added, active) {
  const result = [...queue];
  result.splice(active ? index + 1 : 0, 0, ...added);
  return { queue: result, index: active ? index : 0 };
}

export function listeningArtists(recent, liked, followed) {
  const chosen = new Map();
  const add = artist => {
    const name = String(artist?.name || '').trim();
    if (!name || ['unknown artist', 'your files', 'youtube'].includes(name.toLowerCase())) return;
    const key = name.normalize('NFKC').toLowerCase();
    const id = /^mono:artist:\d{17,20}$/.test(artist.id || '') ? artist.id : '';
    if (!chosen.has(key) || id && !chosen.get(key).id) chosen.set(key, { name: name.slice(0, 160), id });
  };
  for (const track of [...recent, ...liked]) {
    if (track.source === 'unmatched' || track.kind === 'video') continue;
    for (const artist of track.artists?.length ? track.artists : [{ name: track.artist }]) add(artist);
  }
  followed.forEach(add);
  return [...chosen.values()].slice(0, 4);
}

export function playableSelection(tracks, index) {
  const playable = tracks.filter(track => track.source !== 'unmatched');
  if (!tracks[index] || !playable.length) return { tracks: [], index: -1 };
  const before = tracks.slice(0, index).filter(track => track.source !== 'unmatched').length;
  return { tracks: playable, index: before % playable.length };
}

export function moveQueueEntry(queue, index, from, to) {
  if (![from, to].every(n => Number.isInteger(n) && n >= 0 && n < queue.length)) return { queue, index };
  const current = queue[index];
  const result = [...queue];
  result.splice(to, 0, result.splice(from, 1)[0]);
  return { queue: result, index: result.indexOf(current) };
}
