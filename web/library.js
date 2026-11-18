// A metadata-only PC copy can list a local track before the phone has its audio.
export async function isDuplicateImport(listed, track, bytes, androidDevice) {
  if (!listed || !androidDevice) return listed;
  return !!(track?.nativePath && track.fileId && await androidDevice.invoke("has_audio", { id: track.fileId, bytes }));
}

export function savedTrackMetadata(track, previous) {
  // YouTube song and video views share an ID. Playing its video must keep a saved song downloadable.
  const keepSong = track.source === 'youtube' && track.kind === 'video' && previous?.source === 'youtube' && previous.kind !== 'video';
  const { queueKey, playlistId, ...metadata } = keepSong ? previous : track;
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

export function replaceLibraryTrack(library, oldId, candidate) {
  const original = library.tracks[oldId];
  const existing = library.tracks[candidate.id] || {};
  const spotifyUris = [...new Set([...(existing.spotifyUris || []), ...(candidate.spotifyUris || []), original?.importRecord?.uri].filter(Boolean))];
  const track = { ...candidate, spotifyUris };
  library.tracks[track.id] = track;
  if (oldId !== track.id) delete library.tracks[oldId];
  library.liked = [...new Set(library.liked.map(id => id === oldId ? track.id : id))];
  library.recent = [...new Set(library.recent.map(id => id === oldId ? track.id : id))];
  for (const playlist of library.playlists) playlist.trackIds = playlist.trackIds.map(id => id === oldId ? track.id : id);
  return track;
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
