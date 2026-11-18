// A metadata-only PC copy can list a local track before the phone has its audio.
export async function isDuplicateImport(listed, track, bytes, androidDevice) {
  if (!listed || !androidDevice) return listed;
  return !!(track?.nativePath && track.fileId && await androidDevice.invoke("has_audio", { id: track.fileId, bytes }));
}

export function savedTrackMetadata(track, previous) {
  // YouTube song and video views share an ID. Playing its video must keep a saved song downloadable.
  const keepSong = track.source === 'youtube' && track.kind === 'video' && previous?.source === 'youtube' && previous.kind !== 'video';
  const { queueKey, playlistId, ...metadata } = keepSong ? previous : track;
  if (previous?.spotifyImportIds || track.spotifyImportIds) {
    metadata.spotifyImportIds = [...new Set([...(previous?.spotifyImportIds || []), ...(track.spotifyImportIds || [])])];
  }
  return { ...metadata, spotifyUris: [...new Set([...(previous?.spotifyUris || []), ...(track.spotifyUris || [])])] };
}

export function canDownload(track) {
  return track?.source === 'monochrome' && /^\d{17,20}$/.test(String(track.remoteId)) || track?.source === 'youtube' && track.kind !== 'video' && /^[A-Za-z0-9_-]{11}$/.test(String(track.remoteId));
}

// Check the device before resolving a network stream, including after a restart.
export async function resolveCatalogAudio(track, native, request, force = false) {
  if (native && canDownload(track)) {
    const file = await native.invoke('offline_file', { id: track.remoteId, source: track.source });
    if (file) return { ...file, url: file.nativePath, offline: true };
  }
  return request('resolve', { id: track.remoteId, source: track.source, track, force });
}

export async function spotifyPlaceholder(record) {
  let id = record.uri;
  if (!id) {
    const key = [record.artist, record.title, record.album].join('\n');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    id = 'spotify:import:' + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  return { id, title: record.title, artist: record.artist, artists: [{ id: '', name: record.artist }], album: { id: '', title: record.album || '' }, duration: record.duration || 0, artwork: '', source: 'unmatched', importRecord: record };
}

export function appendSpotifyPreview(state, incoming) {
  const count = incoming.reduce((total, collection) => total + collection.tracks.length, state.previewCount || 0);
  if (count > 20000) throw new Error('Import up to 20,000 songs at a time. Split this export into smaller files.');
  for (const collection of incoming) state.collections.push({ ...collection, selected: true });
  state.previewCount = count;
}

export async function prepareSpotifyCollections(library, selected) {
  const known = new Map();
  for (const track of Object.values(library.tracks)) {
    if (track.source === 'unmatched') continue;
    for (const uri of track.spotifyUris || []) known.set(uri, track.id);
    for (const id of track.spotifyImportIds || []) known.set(id, track.id);
  }
  const placeholders = new Map();
  const liked = new Set();
  const playlists = [];
  const previous = library.playlists.filter(playlist => playlist.importedFrom === 'Spotify');
  const reused = new Map();
  for (const item of selected) {
    const ids = [];
    const sourceIds = [];
    for (let offset = 0; offset < item.tracks.length; offset += 128) {
      // Bound simultaneous SHA-256 operations for older exports without Spotify URIs.
      const chunk = item.tracks.slice(offset, offset + 128);
      const resolved = await Promise.all(chunk.map(async record => {
        if (known.has(record.uri)) return [record.uri, known.get(record.uri)];
        const placeholder = await spotifyPlaceholder(record);
        if (known.has(placeholder.id)) return [placeholder.id, known.get(placeholder.id)];
        if (!library.tracks[placeholder.id] && !placeholders.has(placeholder.id)) placeholders.set(placeholder.id, placeholder);
        return [placeholder.id, placeholder.id];
      }));
      for (const [sourceId, id] of resolved) {
        if (item.kind === 'liked') liked.add(id);
        else { ids.push(id); sourceIds.push(sourceId); }
      }
      if (offset + chunk.length < item.tracks.length) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (item.kind === 'liked') continue;
    const keyBytes = new TextEncoder().encode(JSON.stringify([item.sourceUrl || '', item.name, sourceIds]));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', keyBytes));
    const importKey = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    // Older imports have no fingerprint. Reuse only a complete ordered match
    // from Spotify, including every duplicate, and consume each playlist once.
    const existing = previous.find(playlist => !reused.has(playlist.id) &&
      (playlist.spotifyImportKey ? playlist.spotifyImportKey === importKey :
        playlist.name === item.name && playlist.trackIds.length === ids.length && ids.every((id, i) => id === playlist.trackIds[i])));
    if (existing) reused.set(existing.id, importKey);
    else playlists.push({ id: crypto.randomUUID(), name: item.name, trackIds: ids, importedFrom: 'Spotify', spotifyImportKey: importKey, importedAt: Date.now() });
  }
  return { placeholders, liked, playlists, reused };
}

export function replaceLibraryTracks(library, candidates) {
  const replacements = new Map();
  for (const [oldId, candidate] of candidates) {
    const original = library.tracks[oldId];
    // A user can choose a recording manually while an automatic lookup is in flight.
    if (!original?.importRecord || original.source !== 'unmatched') continue;
    const existing = library.tracks[candidate.id];
    const spotifyUris = [...new Set([...(existing?.spotifyUris || []), ...(candidate.spotifyUris || []), original.importRecord.uri].filter(Boolean))];
    const track = savedTrackMetadata({ ...candidate, spotifyUris }, existing);
    if (!original.importRecord.uri) track.spotifyImportIds = [...new Set([...(track.spotifyImportIds || []), oldId])];
    library.tracks[candidate.id] = track;
    if (oldId !== candidate.id) delete library.tracks[oldId];
    replacements.set(oldId, candidate.id);
  }
  if (replacements.size) {
    const remap = id => replacements.get(id) || id;
    library.liked = [...new Set(library.liked.map(remap))];
    library.recent = [...new Set(library.recent.map(remap))];
    for (const playlist of library.playlists) {
      if (playlist.trackIds.some(id => replacements.has(id))) playlist.trackIds = playlist.trackIds.map(remap);
    }
  }
  return replacements;
}

export function replaceLibraryTrack(library, oldId, candidate) {
  const replacements = replaceLibraryTracks(library, [[oldId, candidate]]);
  return library.tracks[replacements.get(oldId)];
}

export function mergePCLibrary(local, incoming, deviceId) {
  if (incoming?.version !== 1 || !incoming.tracks || ![incoming.liked, incoming.imports, incoming.playlists].every(Array.isArray) || !/^[a-f0-9]{32}$/.test(deviceId)) throw new Error('The PC returned an unsupported library.');
  const merged = structuredClone(local);
  for (const [id, track] of Object.entries(incoming.tracks)) {
    const previous = merged.tracks[id];
    merged.tracks[id] = { ...previous, ...track };
    if (previous?.nativePath && !track.nativePath) {
      merged.tracks[id].nativePath = previous.nativePath;
      if (previous.source === 'local' && previous.fileId) merged.tracks[id].fileId = previous.fileId;
    }
  }
  merged.liked = [...new Set([...local.liked, ...incoming.liked])];
  merged.imports = [...new Set([...local.imports, ...incoming.imports])];
  const old = local.playlists.filter(p => p.syncDevice === deviceId);
  merged.playlists = [...local.playlists.filter(p => p.syncDevice !== deviceId), ...incoming.playlists.map(p => {
    const previous = old.find(item => item.syncId === p.id);
    return { id: previous?.id || `pc:${deviceId}:${p.id}`, name: p.name, trackIds: [...p.trackIds], syncDevice: deviceId, syncId: p.id, pinnedAt: previous?.pinnedAt ?? p.pinnedAt ?? 0, lastPlayedAt: Math.max(previous?.lastPlayedAt || 0, p.lastPlayedAt || 0) };
  })];
  merged.downloads = { ...local.downloads, ...incoming.downloads };
  merged.followedArtists = [...new Map([...local.followedArtists, ...(incoming.followedArtists || [])].map(a => [a.id, a])).values()];
  return merged;
}
