import test from "node:test";
import assert from "node:assert/strict";
import { nextIndex, escapeHTML, fileMetadata, formatTime, matches, rankTracks, sortReleases, emptyLibrary } from "../web/core.js";
import { insertUpNext, listeningArtists, nextQueueIndex, shuffleQueueKeys, playlistRowPositions, removePlaylistEntry } from '../web/core.js';
import { appLanguage, countLabel, setLanguage, tr } from '../web/i18n.js';
import { isFileDrag, searchTracks } from '../web/core.js';
import { savedTrackMetadata, isDuplicateImport } from '../web/library.js';

test('new entries come first in Up next without replacing the active occurrence', () => {
  const active = { id: 'duplicate', queueKey: 'active' };
  const added = [{ id: 'duplicate', queueKey: 'addition' }, { id: 'third' }];
  const before = [{ id: 'earlier' }, active, { id: 'later' }];
  const result = insertUpNext(before, 1, added, true);
  assert.equal(result.queue[result.index], active);
  assert.deepEqual(result.queue.slice(2), [...added, before[2]]);
  assert.deepEqual(insertUpNext([active], 0, added, false), { queue: [...added, active], index: 0 });
});

test('home derives artist order from listening, with likes and follows filling empty spots', () => {
  const artist = { name: 'Sade', id: 'mono:artist:152942198986379264' };
  const recentlyPlayed = [{ source: 'youtube', artist: 'Sade' }, { source: 'local', artist: 'Björk' }, { source: 'local', artist: 'Your files' }];
  const result = listeningArtists(recentlyPlayed, [{ source: 'monochrome', artists: [artist] }], [{ name: 'Boards of Canada' }]);
  assert.deepEqual(result, [artist, { name: 'Björk', id: '' }, { name: 'Boards of Canada', id: '' }]);
  assert.deepEqual(listeningArtists([], [], []), []);
});

test('Russian labels use Russian plurals and leave formatted artist names intact', () => {
  const before = appLanguage();
  try {
    setLanguage('ru');
    assert.equal(tr('Your library'), 'Медиатека');
    assert.equal(tr('More from {artist}', { artist: 'A & B' }), 'Ещё от A & B');
    assert.deepEqual([1, 2, 5, 11, 21].map(n => countLabel(n)), ['1 трек', '2 трека', '5 треков', '11 треков', '21 трек']);
    setLanguage('en');
    assert.equal(tr('Your library'), 'Your library');
  } finally { setLanguage(before); }
});

test("queue boundaries and imported metadata", () => {
  assert.equal(nextIndex(2, 3), -1);
  assert.equal(nextIndex(2, 3, { repeat: "all" }), 0);
  assert.equal(nextIndex(0, 3, { direction: -1 }), -1);
  assert.equal(nextIndex(1, 3, { repeat: "one", ended: true }), 1);
  assert.equal(nextIndex(1, 3, { repeat: "one" }), 2);
  assert.equal(nextIndex(0, 0), -1);
  assert.deepEqual(fileMetadata("Artist - Song_title.flac"), { artist: "Artist", title: "Song title" });
  assert.deepEqual(fileMetadata("my.song.mp3"), { artist: "Your files", title: "my.song" });
  assert.equal(formatTime(Infinity), "0:00");
  assert.equal(formatTime(126.9), "2:06");
  assert.equal(formatTime(-3), "0:00");
  assert.equal(escapeHTML('<img src="x">'), "&lt;img src=&quot;x&quot;&gt;");
  assert.ok(matches({ title: "Song", artist: "An artist" }, " ARTIST "));
  assert.deepEqual(emptyLibrary().followedArtists, []);
});

test('removing a sorted playlist row deletes only that occurrence in the stored playlist', () => {
  const ids = ['A', 'B', 'missing', 'A', 'C'];
  const displayed = ['C', 'A', 'A', 'B'].map(id => ({ id }));
  const rows = playlistRowPositions(ids, displayed);
  assert.deepEqual(rows, [4, 0, 3, 1]);
  assert.equal(removePlaylistEntry(ids, rows[2], 'A'), true);
  assert.deepEqual(ids, ['A', 'B', 'missing', 'C']);
  assert.equal(removePlaylistEntry(ids, rows[2], 'A'), false, 'a stale menu cannot remove another track');
});

test('shuffle plays each occurrence once, goes back in order, and wraps only on repeat all', () => {
  const queue = [{ id: 'A', queueKey: 'first' }, { id: 'B', queueKey: 'middle' }, { id: 'A', queueKey: 'last' }];
  const order = shuffleQueueKeys(queue, 'middle', [], () => 0);
  assert.deepEqual(order, ['middle', 'last', 'first']);
  const next = (index, options) => nextQueueIndex(queue, index, order, options);
  assert.equal(next(1, { ended: true }), 2);
  assert.equal(next(1, { ended: false }), 2);
  assert.equal(next(2, { ended: true }), 0);
  assert.equal(next(0, { ended: true }), -1);
  assert.equal(next(0, { ended: false }), -1);
  assert.equal(next(0, { direction: -1 }), 2);
  assert.equal(next(1, { direction: -1 }), -1);
  assert.equal(next(0, { ended: true, repeat: 'all' }), 1);
  assert.equal(next(0, { ended: true, repeat: 'one' }), 0);
  const pair = queue.slice(0, 2), pairOrder = shuffleQueueKeys(pair, 'first');
  assert.equal(nextQueueIndex(pair, 0, pairOrder, { ended: true }), 1);
  assert.equal(nextQueueIndex(pair, 1, pairOrder, { ended: true }), -1);
});

test('shuffle prunes removed entries, incorporates new ones and resets for a new queue or toggle', () => {
  const entries = (...keys) => keys.map(queueKey => ({ queueKey }));
  const original = entries('a', 'b', 'c');
  const previous = shuffleQueueKeys(original, 'b', [], () => 0);
  assert.deepEqual(previous, ['b', 'c', 'a']);
  const edited = entries('a', 'b', 'd', 'e');
  const updated = shuffleQueueKeys(edited, 'b', previous, () => 0);
  assert.deepEqual(updated, ['b', 'a', 'e', 'd']);
  const added = insertUpNext(edited, 1, entries('explicit'), true);
  assert.equal(added.queue[nextQueueIndex(added.queue, 1, null, {})].queueKey, 'explicit');
  assert.deepEqual(shuffleQueueKeys(edited, 'a', [], () => 0.999), ['a', 'b', 'd', 'e']);
  assert.deepEqual(shuffleQueueKeys(entries('x', 'y'), 'y', previous), ['y', 'x']);
});

test('removing the active shuffled song starts a fresh order on the next selection', () => {
  const queue = ['A', 'B', 'C'].map(queueKey => ({ queueKey }));
  const original = shuffleQueueKeys(queue, 'A', [], () => 0.999);
  const remaining = queue.filter(entry => entry.queueKey !== 'B');
  const stopped = shuffleQueueKeys(remaining, undefined, original);
  assert.deepEqual(stopped, []);
  const resumed = shuffleQueueKeys(remaining, 'A', stopped);
  assert.equal(remaining[nextQueueIndex(remaining, 0, resumed, { ended: true })].queueKey, 'C');
});

test("search ranks originals and preserves canonical metadata when video results arrive", () => {
  const original = { id: "youtube:original", title: "Close Eyes", artist: "DVRST", kind: "song", album: { id: "album" } };
  const slowed = { id: "youtube:slowed", title: "Close Eyes Slowed Reverb", artist: "DVRST", kind: "song" };
  const unrelated = { id: "youtube:other", title: "Close Eyes", artist: "Someone else", kind: "song" };
  const ranked = rankTracks([unrelated, slowed, original, { ...original, artist: "Uploader", album: null }], "DVRST Close Eyes");
  assert.equal(ranked[0].id, original.id);
  assert.deepEqual(ranked[0].album, { id: "album" });
  assert.equal(ranked.length, 3);
  assert.equal(rankTracks([original, slowed], "DVRST Close Eyes Slowed Reverb")[0].id, slowed.id);
});

test('file drags use the browser format in both interface languages', () => {
  const before = appLanguage();
  try {
    for (const lang of ['en', 'ru']) {
      setLanguage(lang);
      assert.equal(isFileDrag({ types: ['Files'] }), true);
      assert.equal(isFileDrag({ types: ['text/plain'] }), false);
      assert.equal(isFileDrag(null), false);
    }
  } finally { setLanguage(before); }
});

test('a YouTube result can be played in either tab without changing a saved song into a video', () => {
  const song = { id: 'youtube:ao4RCon11eY', remoteId: 'ao4RCon11eY', source: 'youtube', kind: 'song', title: 'Song', artist: 'Artist', spotifyUris: ['saved-uri'] };
  const video = { ...song, title: 'Official video', kind: 'video', spotifyUris: [] };
  const results = { tracks: rankTracks([song], 'Song'), videos: rankTracks([video, video], 'Song') };
  assert.deepEqual(searchTracks(results, 'songs'), [song]);
  assert.deepEqual(searchTracks(results, 'videos'), [video]);
  assert.deepEqual(searchTracks({ tracks: [song] }, 'videos'), []);
  assert.equal(canDownload(searchTracks(results, 'videos')[0]), false);
  const saved = savedTrackMetadata({ ...video, queueKey: 'playing', playlistId: 'queue' }, song);
  assert.deepEqual(saved, song);
  assert.equal(canDownload(saved), true);
  assert.deepEqual(savedTrackMetadata(video), video);
  assert.deepEqual(savedTrackMetadata(song, video), song);
});

test("discography category filters and sorting leave the source collection intact", () => {
  const releases = [{ title: "Z", year: "2022", type: "Album" }, { title: "B", year: "2025", type: "Single" }, { title: "A", year: "2024", type: "EP" }];
  assert.deepEqual(sortReleases(releases, "albums").map(r => r.title), ["Z"]);
  assert.deepEqual(sortReleases(releases, "singles").map(r => r.title), ["B", "A"]);
  assert.deepEqual(sortReleases(releases, "all", "name").map(r => r.title), ["A", "B", "Z"]);
  assert.deepEqual(sortReleases(releases).map(r => r.title), ["B", "A", "Z"]);
  assert.deepEqual(releases.map(r => r.title), ["Z", "B", "A"]);
});

import { LinuxPlayer } from '../web/player.js';
import { sortPlaylists, queueEntries, moveQueueEntry, playableSelection } from '../web/core.js';

test('pinned playlists stay above recently played playlists without changing their stored order', () => {
  const list = [{ id: 'old' }, { id: 'played', lastPlayedAt: 50 }, { id: 'pinned', pinnedAt: 10, lastPlayedAt: 1 }, { id: 'latest-pin', pinnedAt: 20 }];
  assert.deepEqual(sortPlaylists(list).map(p => p.id), ['latest-pin', 'pinned', 'played', 'old']);
  list[0].lastPlayedAt = 100;
  assert.deepEqual(sortPlaylists(list).map(p => p.id), ['latest-pin', 'pinned', 'old', 'played']);
  list[2].pinnedAt = 0;
  assert.deepEqual(sortPlaylists(list).map(p => p.id), ['latest-pin', 'old', 'played', 'pinned']);
  assert.deepEqual(list.map(p => p.id), ['old', 'played', 'pinned', 'latest-pin']);
});

test('queue edits preserve the playing occurrence when the same song appears twice', () => {
  const track = { id: 'same', source: 'local' };
  let id = 0;
  const queue = queueEntries([track, track, { id: 'third', source: 'local' }, { source: 'unmatched' }], 'playlist', () => String(++id));
  assert.equal(queue.length, 3);
  assert.notEqual(queue[0].queueKey, queue[1].queueKey);
  assert.equal(queue[0].playlistId, 'playlist');
  const moved = moveQueueEntry(queue, 1, 2, 0);
  assert.equal(moved.index, 2);
  assert.equal(moved.queue[moved.index], queue[1]);
  assert.equal(moveQueueEntry(moved.queue, 2, 2, 0).index, 0);
  assert.equal(moveQueueEntry(queue, 1, -1, 9).queue, queue);
  assert.equal(queueEntries(queue)[0].queueKey, queue[0].queueKey);
  const selection = playableSelection([track, { source: 'unmatched' }, track], 2);
  assert.equal(selection.index, 1, 'Starting the second copy jumped to the first copy');
  assert.equal(playableSelection([{ source: 'unmatched' }, track], 0).index, 0);
  assert.equal(playableSelection([{ source: 'unmatched' }], 0).index, -1);
});

test('Linux prepared handoffs change the queue item without stopping or loading audio again', async () => {
  let state = { token: 0, key: '', serial: 0, position: 0, duration: 3, paused: false, ready: true };
  const calls = [];
  const native = { invoke: async (_, { operation, args }) => {
    calls.push(operation);
    if (operation === 'load') state = { ...state, token: args.token, key: args.key };
    if (operation === 'next') state = { ...state, key: args.key, serial: state.serial + 1, position: 0 };
    return { ...state };
  } };
  const player = new LinuxPlayer(native);
  try {
    const changed = [];
    let ended = 0;
    player.addEventListener('trackchange', event => changed.push(event.key));
    player.addEventListener('ended', () => ended++);
    player.setSource('/audio/first.wav', 'first');
    await player.play();
    await player.prepareNext({ key: 'second', url: '/audio/second.wav' });
    assert.equal(await player.advance('wrong'), false);
    assert.equal(await player.advance('second'), true);
    assert.deepEqual(changed, ['second']);
    assert.equal(player.src, '/audio/second.wav');
    assert.equal(calls.filter(op => op === 'load').length, 1);
    assert.equal(calls.filter(op => op === 'stop').length, 0);
    await player.prepareNext({ key: 'second', url: '/audio/second.wav' });
    state = { ...state, serial: 2, position: 0, ended: true };
    player._apply(state);
    assert.deepEqual(changed, ['second', 'second']);
    assert.equal(ended, 0, 'A stale end flag skipped the new queue entry');
    await assert.rejects(player.prepareNext({ key: 'missing' }), /file is missing/);
  } finally { player.dispose(); }
});

test('Linux skips only a confirmed preload and can recover when an earlier preparation fails', async () => {
  let state;
  let rejectSlowPrepare, signalSlowStart;
  const slowStarted = new Promise(resolve => { signalSlowStart = resolve; });
  const skips = [];
  const player = new LinuxPlayer({ invoke: async (_, { operation, args }) => {
    if (operation === 'load') state = { token: args.token, key: args.key, serial: 0, ready: true, paused: false };
    if (operation === 'prepare' && args.key === 'missing') throw new Error('Append failed');
    if (operation === 'prepare' && args.url === '/slow') {
      signalSlowStart();
      await new Promise((_, reject) => { rejectSlowPrepare = reject; });
    }
    if (operation === 'next') {
      skips.push(args.key);
      state = { ...state, key: args.key, serial: state.serial + 1 };
    }
    return { ...state };
  } });
  try {
    player.setSource('/playing', 'current');
    await player.play();
    await assert.rejects(player.prepareNext({ key: 'missing', url: '/missing' }), /Append failed/);
    assert.equal(await player.advance('missing'), false);
    const failed = assert.rejects(player.prepareNext({ key: 'retry', url: '/slow' }), /Interrupted/);
    await slowStarted;
    const premature = player.advance('retry');
    const newer = player.prepareNext({ key: 'retry', url: '/working' });
    rejectSlowPrepare(new Error('Interrupted'));
    await failed;
    await newer;
    assert.equal(await premature, false);
    assert.equal(await player.advance('retry'), true);
    assert.equal(player.entry, 'retry');
    assert.deepEqual(skips, ['retry']);
  } finally { player.dispose(); }
});

test('Linux player connects play, pause, seek, volume, and song changes to native playback', async () => {
  const calls = [];
  let state = { token: 0, position: 0, duration: 0, paused: true, ready: false, ended: false, error: null };
  const native = { invoke: async (command, { operation, args }) => {
    assert.equal(command, 'playback');
    calls.push({ operation, ...args });
    if (operation === 'load') state = { ...state, token: args.token, position: 0, duration: 132, paused: false, ready: true, ended: false };
    if (operation === 'stop') state = { ...state, token: args.token, ready: false, paused: true };
    if (operation === 'pause') state.paused = args.paused;
    if (operation === 'seek') state.position = args.seconds;
    return { ...state };
  } };
  const player = new LinuxPlayer(native);
  try {
    let plays = 0;
    player.addEventListener('play', () => plays++);
    player.load();
    player.src = 'https://tracks.monochrome.st/track/159277913216937984';
    await player.play();
    assert.equal(player.paused, false);
    assert.equal(player.duration, 132);
    assert.equal(plays, 1);
    player.pause();
    await player._chain;
    assert.equal(state.paused, true);
    player.currentTime = 40;
    player.volume = 0.4;
    player.muted = true;
    await player._chain;
    assert.equal(state.position, 40);
    assert.deepEqual(calls.filter(call => call.operation === 'volume').at(-1), { operation: 'volume', volume: 0.4, muted: true });
    await player.play();
    assert.equal(state.paused, false);
    player.removeAttribute('src');
    player.load();
    player.src = 'https://tracks.monochrome.st/track/155142491052445696';
    await player.play();
    assert.equal(state.token, 2);
    assert.equal(player.currentTime, 0);
    assert.equal(calls.filter(call => call.operation === 'load').length, 2);
  } finally { player.dispose(); }
});

test('cancelling a native load ignores its late status', async () => {
  let release;
  const player = new LinuxPlayer({ invoke: async (_, { operation, args }) => {
    if (operation === 'load') return new Promise(resolve => { release = () => resolve({ token: args.token, ready: true, paused: false, duration: 99, position: 5 }); });
    return { token: args.token || 0, ready: false, paused: true };
  } });
  try {
    player.load();
    player.src = 'https://tracks.monochrome.st/track/159277913216937984';
    const pending = player.play();
    await new Promise(resolve => setTimeout(resolve, 5));
    player.removeAttribute('src');
    player.load();
    release();
    await pending;
    await player._chain;
    assert.equal(player.paused, true);
    assert.equal(player.duration, 0);
    assert.equal(player.currentTime, 0);
  } finally { player.dispose(); }
});

test('a failed native load reports an error and can be retried', async () => {
  let attempts = 0;
  const player = new LinuxPlayer({ invoke: async (_, { operation, args }) => {
    if (operation === 'load' && ++attempts === 1) throw new Error('Recording unavailable');
    return { token: args.token || 1, ready: operation !== 'stop', paused: operation === 'stop', duration: 132, position: 0 };
  } });
  try {
    let errors = 0;
    player.addEventListener('error', () => errors++);
    player.load();
    player.src = 'https://tracks.monochrome.st/track/159277913216937984';
    await assert.rejects(player.play(), /Recording unavailable/);
    assert.equal(player.error.message, 'Recording unavailable');
    assert.equal(errors, 1);
    await player.play();
    assert.equal(attempts, 2);
    assert.equal(player.error, null);
    assert.equal(player.paused, false);
  } finally { player.dispose(); }
});

import { canDownload, resolveCatalogAudio, spotifyPlaceholder, replaceLibraryTrack } from '../web/library.js';

test('switching Linux tracks stops the old sound and ignores its delayed native errors', async () => {
  let state = { token: 0, paused: true, ready: false };
  let failPoll;
  const player = new LinuxPlayer({ invoke: async (_, { operation, args }) => {
    if (operation === 'load') state = { token: args.token, key: args.key, paused: false, ready: true };
    if (operation === 'stop') state = { token: args.token, paused: true, ready: false };
    if (operation === 'state' && failPoll === null) return new Promise((_, reject) => { failPoll = reject; });
    return state;
  } });
  try {
    player.setSource('/audio/a.wav', 'A');
    await player.play();
    // The previous track has a native state request in flight when the new track is selected.
    failPoll = null;
    const pending = player._poll();
    await new Promise(resolve => setImmediate(resolve));
    player.removeAttribute('src');
    player.load();
    failPoll(new Error('old audio disconnected'));
    await pending;
    await player._chain;
    assert.equal(state.ready, false);
    assert.equal(player.paused, true);
    assert.equal(player.src, '');
    assert.equal(player.error, null);
    assert.equal(await player.advance('A'), false);
    player.setSource('/audio/b.wav', 'B');
    await player.play();
    assert.equal(player.entry, 'B');
    assert.equal(player.paused, false);
  } finally { player.dispose(); }
});
import { mergePCLibrary } from '../web/library.js';
import { coverCollage, coverSongs } from '../web/covers.js';

test('generated covers use the first four songs in order and handle missing artwork', () => {
  const album = { tracks: Array.from({ length: 5 }, (_, i) => ({ title: i === 1 ? '<Script>' : `Song ${i}`, artwork: i === 1 ? '' : `https://art.example/${i}.jpg` })) };
  assert.equal(coverSongs(album).length, 4);
  assert.equal(coverSongs({ ...album, coverTracks: [{ title: 'First listed song' }] })[0].title, 'First listed song');
  const cover = coverCollage(album);
  assert.equal((cover.match(/class="cover-tile"/g) || []).length, 4);
  assert.ok(cover.indexOf('/0.jpg') < cover.indexOf('/2.jpg'));
  assert.ok(!cover.includes('/4.jpg') && !cover.includes('<Script>'));
  assert.equal((coverCollage({ tracks: album.tracks.slice(0, 1) }).match(/class="cover-tile"/g) || []).length, 4);
});

test('copying a PC library preserves phone collections and updates stable PC copies without duplicates', () => {
  const local = emptyLibrary();
  local.volume = 0.2;
  local.playlists = [{ id: 'phone-only', name: 'Phone', trackIds: ['own'] }];
  local.liked = ['own'];
  local.downloads = { own: { nativePath: '/phone/own.flac' } };
  const incoming = { ...emptyLibrary(), tracks: { remote: { id: 'remote', title: 'PC song' } }, liked: ['remote'], playlists: [{ id: 'pc-list', name: 'PC', trackIds: ['remote', 'remote'] }] };
  const device = 'a'.repeat(32);
  const merged = mergePCLibrary(local, incoming, device);
  assert.equal(merged.volume, 0.2);
  assert.deepEqual(merged.liked, ['own', 'remote']);
  assert.equal(merged.downloads.own.nativePath, '/phone/own.flac');
  assert.deepEqual(merged.playlists[1].trackIds, ['remote', 'remote']);
  const again = mergePCLibrary(merged, { ...incoming, playlists: [{ ...incoming.playlists[0], name: 'Renamed PC' }] }, device);
  assert.equal(again.playlists.length, 2);
  assert.equal(again.playlists[1].id, merged.playlists[1].id);
  assert.equal(again.playlists[1].name, 'Renamed PC');
  assert.equal(local.playlists.length, 1);
  merged.playlists[1].pinnedAt = 100;
  merged.playlists[1].lastPlayedAt = 200;
  const pinned = mergePCLibrary(merged, incoming, device);
  assert.equal(pinned.playlists[1].pinnedAt, 100);
  assert.equal(pinned.playlists[1].lastPlayedAt, 200);
});

test('downloaded songs resolve from the device without resolving an internet stream', async () => {
  const track = { id: 'monochrome:159277913216937984', remoteId: '159277913216937984', source: 'monochrome' };
  const native = { invoke: async (name, args) => {
    assert.equal(name, 'offline_file');
    assert.equal(args.id, track.remoteId);
    return { nativePath: '/private/app/downloads/song.flac', bytes: 1000 };
  } };
  const resolved = await resolveCatalogAudio(track, native, () => { throw new Error('Offline playback tried the internet'); });
  assert.equal(resolved.url, '/private/app/downloads/song.flac');
  assert.equal(resolved.offline, true);
  assert.equal(canDownload(track), true);
  assert.equal(canDownload({ ...track, source: 'unmatched' }), false);
  assert.equal(canDownload({ source: 'youtube', kind: 'song', remoteId: 'ao4RCon11eY' }), true);
  assert.equal(canDownload({ source: 'youtube', kind: 'video', remoteId: 'ao4RCon11eY' }), false);
  const streamed = await resolveCatalogAudio(track, { invoke: async () => null }, async () => ({ url: 'https://example.org/song' }));
  assert.equal(streamed.url, 'https://example.org/song');
});

test('a metadata-only PC import can be filled on Android and is skipped once its audio exists', async () => {
  const incoming = emptyLibrary(), id = 'local:' + 'a'.repeat(64);
  const fileId = 'a'.repeat(64) + '.wav';
  incoming.imports = [id];
  incoming.tracks[id] = { id, fileId, source: 'local', title: 'PC recording' };
  const phone = mergePCLibrary(emptyLibrary(), incoming, 'b'.repeat(32));
  const track = phone.tracks[id];
  let present = false;
  const android = { invoke: async (command, args) => {
    assert.equal(command, 'has_audio');
    assert.deepEqual(args, { id: fileId, bytes: 48 });
    return present;
  } };
  const listed = phone.imports.includes(id);
  assert.equal(listed, true);
  assert.equal(await isDuplicateImport(listed, track, 48, android), false);
  track.nativePath = '/audio/' + fileId;
  assert.equal(await isDuplicateImport(listed, track, 48, android), false);
  present = true;
  assert.equal(await isDuplicateImport(listed, track, 48, android), true);
  assert.equal(await isDuplicateImport(listed, track, 48, null), true);
  incoming.tracks[id].fileId = 'a'.repeat(64) + '.weba';
  const refreshed = mergePCLibrary(phone, incoming, 'b'.repeat(32));
  assert.equal(refreshed.tracks[id].fileId, fileId);
  assert.equal(refreshed.tracks[id].nativePath, track.nativePath);
});

test('Android requests return asynchronously, carry provider arguments, and expose engine errors', async () => {
  const originalWindow = globalThis.window;
  globalThis.window = { UndertoneDevice: { request(id, operation, args) {
    queueMicrotask(() => window.__undertoneReply(id, operation === 'remove_download' ? { error: 'Storage unavailable' } : { data: { operation, args: JSON.parse(args) } }));
  } } };
  try {
    const runtime = await import('../web/runtime.js?android-bridge-check');
    const result = await runtime.musicRequest('search', { query: 'DVRST' });
    assert.deepEqual(result, { operation: 'music', args: { operation: 'search', args: { query: 'DVRST' } } });
    const download = await runtime.nativeRuntime.invoke('download_track', { id: 'ao4RCon11eY', source: 'youtube' });
    assert.equal(download.args.source, 'youtube');
    assert.deepEqual(await runtime.nativeRuntime.invoke('link_discover'), { operation: 'link_discover', args: {} });
    for (const operation of ['link_phone_start', 'link_phone_status', 'link_phone_stop']) {
      const args = { session: 'visible-dialog' };
      assert.deepEqual(await runtime.nativeRuntime.invoke(operation, args), { operation, args });
    }
    await assert.rejects(runtime.nativeRuntime.invoke('remove_download', { id: 'ao4RCon11eY', source: 'youtube' }), /Storage unavailable/);
  } finally { globalThis.window = originalWindow; }
});

test('Spotify matching preserves playlist positions, liked membership, and original identifiers', async () => {
  const seed = { title: 'Close Eyes', artist: 'DVRST', album: 'Close Eyes', uri: 'spotify:track:1234567890123456789012' };
  const original = await spotifyPlaceholder(seed);
  assert.equal((await spotifyPlaceholder(seed)).id, original.id);
  const library = { tracks: { [original.id]: original }, liked: [original.id], recent: [], playlists: [{ trackIds: ['before', original.id, 'after', original.id] }] };
  const track = replaceLibraryTrack(library, original.id, { id: 'monochrome:159277913216937984', title: seed.title, artist: seed.artist, source: 'monochrome' });
  assert.deepEqual(library.playlists[0].trackIds, ['before', track.id, 'after', track.id]);
  assert.deepEqual(library.liked, [track.id]);
  assert.deepEqual(track.spotifyUris, [seed.uri]);
  assert.equal(library.tracks[original.id], undefined);
});
