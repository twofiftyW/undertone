const ID = /^[a-z0-9][a-z0-9:_.-]{0,199}$/i;
const LIBRARY_FIELDS = ['liked', 'imports', 'playlists', 'followedArtists'];
const TRACK_FIELDS = ['id', 'remoteId', 'source', 'kind', 'title', 'artist', 'genre', 'duration',
  'explicit', 'isrc', 'year', 'views', 'addedAt'];
const PLAYLIST_FIELDS = ['id', 'name', 'pinnedAt', 'importedFrom', 'importedAt', 'spotifyImportKey', 'syncDevice', 'syncId'];
const RECORD_FIELDS = ['title', 'artist', 'album', 'uri', 'duration', 'isrc'];
const validId = value => typeof value === 'string' && ID.test(value) && !(value in Object.prototype);
const ids = values => Array.isArray(values) ? values.filter(validId) : [];
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const choose = (base, local, remote) => same(base, local) ? remote : local;
const httpsImage = value => typeof value === 'string' && value.startsWith('https://') ? value : '';
const fields = (record, keys) => Object.fromEntries(keys
  .filter(key => ['string', 'boolean'].includes(typeof record?.[key]) || Number.isFinite(record?.[key]))
  .map(key => [key, record[key]]));

function trackMetadata(track) {
  if (!validId(track?.id) || typeof track.title !== 'string' || typeof track.artist !== 'string') return null;
  if (!['monochrome', 'youtube', 'audius', 'local', 'unmatched'].includes(track.source)) return null;
  return {
    ...fields(track, TRACK_FIELDS),
    ...(track.source === 'monochrome' && typeof track.recordingId === 'string' && /^[0-9]{17,20}$/.test(track.recordingId)
      ? { recordingId: track.recordingId } : {}),
    artwork: httpsImage(track.artwork),
    artists: Array.isArray(track.artists) ? track.artists.filter(a => typeof a?.name === 'string')
      .map(a => ({ id: validId(a.id) ? a.id : '', name: a.name })) : [],
    album: fields(track.album, ['id', 'title']),
    ...(track.importRecord ? { importRecord: fields(track.importRecord, RECORD_FIELDS) } : {}),
    ...(Array.isArray(track.spotifyUris) ? { spotifyUris: ids(track.spotifyUris) } : {}),
    ...(Array.isArray(track.spotifyImportIds) ? { spotifyImportIds: ids(track.spotifyImportIds) } : {})
  };
}

export function accountSnapshot(library = {}) {
  const liked = [...new Set(ids(library.liked))];
  const imports = [...new Set(ids(library.imports))];
  const playlists = (library.playlists || []).filter(p => validId(p?.id) && typeof p.name === 'string').map(p => ({
    ...fields(p, PLAYLIST_FIELDS),
    trackIds: ids(p.trackIds),
    ...(Array.isArray(p.spotifyAppendKeys) ? { spotifyAppendKeys: ids(p.spotifyAppendKeys) } : {})
  }));
  const followedArtists = (library.followedArtists || []).filter(a => validId(a?.id) && typeof a.name === 'string')
    .map(a => ({ id: a.id, name: a.name, artwork: httpsImage(a.artwork), seedTrack: trackMetadata(a.seedTrack) }));
  const referenced = new Set([...liked, ...imports, ...playlists.flatMap(p => p.trackIds)]);
  const tracks = Object.fromEntries([...referenced].sort().flatMap(id => {
    const track = trackMetadata(library.tracks?.[id]);
    return track?.id === id ? [[id, track]] : [];
  }));
  return { version: 1, liked, imports, playlists, followedArtists, tracks };
}

export function decodeSnapshot(text) {
  if (!text) return accountSnapshot();
  const value = JSON.parse(text);
  if (value?.version !== 1 || !value.tracks || Array.isArray(value.tracks) ||
      !LIBRARY_FIELDS.every(key => Array.isArray(value[key]))) {
    throw new Error('invalid_library');
  }
  return accountSnapshot(value);
}

export const encodeSnapshot = library => JSON.stringify(library);
export const sameSnapshot = same;

function mergeCollection(base, local, remote, key, mergeItem = choose) {
  if (same(base, local)) return remote;
  if (same(base, remote) || same(local, remote)) return local;
  const baseline = new Map(base.map(item => [key(item), item]));
  const here = new Map(local.map(item => [key(item), item]));
  const there = new Map(remote.map(item => [key(item), item]));
  const order = new Set([...here.keys()].filter(id => !baseline.has(id)).concat([...there.keys()], [...here.keys()]));
  const result = [];
  for (const id of order) {
    const before = baseline.get(id);
    const a = here.get(id);
    const b = there.get(id);
    if (same(a, before)) { if (b !== undefined) result.push(b); }
    else if (same(b, before) || same(a, b)) { if (a !== undefined) result.push(a); }
    else if (a !== undefined && b !== undefined) result.push(mergeItem(before, a, b));
  }
  return result;
}

function occurrences(list) {
  const counts = new Map();
  return list.map(id => {
    const index = counts.get(id) || 0;
    counts.set(id, index + 1);
    return { id, key: id + '|' + index };
  });
}

function mergeTrackOrder(base, local, remote) {
  if (same(base, local)) return remote;
  if (same(base, remote) || same(local, remote)) return local;
  // Match duplicate tracks by occurrence. Keep removals and additions made on either device.
  const shared = new Set(occurrences(base).map(item => item.key));
  const localOrder = occurrences(local);
  const remoteOrder = occurrences(remote);
  const localKeys = new Set(localOrder.map(item => item.key));
  const retained = remoteOrder.filter(item => shared.has(item.key) && localKeys.has(item.key));
  const retainedKeys = new Set(retained.map(item => item.key));
  const added = new Map();
  for (const list of [remoteOrder, localOrder]) {
    let after = '';
    for (const item of list) {
      if (retainedKeys.has(item.key)) after = item.key;
      else if (!shared.has(item.key)) {
        if (!added.has(after)) added.set(after, []);
        added.get(after).push(item.id);
      }
    }
  }
  const result = [...(added.get('') || [])];
  for (const item of retained) {
    result.push(item.id, ...(added.get(item.key) || []));
  }
  return result;
}

function mergePlaylist(base = {}, local, remote) {
  const fields = new Set([...Object.keys(local), ...Object.keys(remote)]);
  const playlist = Object.fromEntries([...fields].map(key => [key, choose(base[key], local[key], remote[key])]));
  playlist.trackIds = mergeTrackOrder(base.trackIds || [], local.trackIds, remote.trackIds);
  if (local.spotifyAppendKeys || remote.spotifyAppendKeys) {
    playlist.spotifyAppendKeys = mergeCollection(base.spotifyAppendKeys || [], local.spotifyAppendKeys || [],
      remote.spotifyAppendKeys || [], id => id);
  }
  return playlist;
}

export function mergeAccountSnapshots(base, local, remote) {
  if (same(base, local)) return remote;
  if (same(base, remote) || same(local, remote)) return local;
  const id = value => value;
  const itemId = item => item.id;
  const liked = mergeCollection(base.liked, local.liked, remote.liked, id);
  const imports = mergeCollection(base.imports, local.imports, remote.imports, id);
  const playlists = mergeCollection(base.playlists, local.playlists, remote.playlists, itemId, mergePlaylist);
  const followedArtists = mergeCollection(base.followedArtists, local.followedArtists, remote.followedArtists, itemId);
  const tracks = { ...base.tracks, ...remote.tracks };
  for (const [id, track] of Object.entries(local.tracks)) {
    if (!tracks[id] || !same(base.tracks[id], track)) tracks[id] = track;
  }
  return accountSnapshot({ liked, imports, playlists, followedArtists, tracks });
}

export function applyAccountSnapshot(library, snapshot) {
  const played = new Map(library.playlists.map(p => [p.id, p.lastPlayedAt]));
  for (const [id, track] of Object.entries(snapshot.tracks)) {
    const local = library.tracks[id];
    library.tracks[id] = { ...track,
      ...(local?.nativePath ? { nativePath: local.nativePath } : {}),
      ...(local?.fileId ? { fileId: local.fileId } : {}) };
  }
  library.liked = [...snapshot.liked];
  library.imports = [...snapshot.imports];
  library.playlists = snapshot.playlists.map(p => ({ ...p, trackIds: [...p.trackIds],
    ...(played.has(p.id) ? { lastPlayedAt: played.get(p.id) } : {}) }));
  library.followedArtists = structuredClone(snapshot.followedArtists);
}

export function activateAccountLibrary(library, accountId) {
  const cloud = library.cloud ||= { active: '', accounts: {} };
  if (cloud.active === accountId) return false;
  const current = accountSnapshot(library);
  if (cloud.active) cloud.accounts[cloud.active].local = current;
  else cloud.guest = current;
  const firstAccount = !Object.keys(cloud.accounts).length;
  const account = accountId ? (cloud.accounts[accountId] ||= {}) : null;
  applyAccountSnapshot(library, account ? account.local || (firstAccount ? current : accountSnapshot()) : cloud.guest);
  if (account) delete account.local;
  cloud.active = accountId;
  return true;
}
