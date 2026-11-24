import test from 'node:test';
import assert from 'node:assert/strict';
import { activeLyricIndex, createLyricsLoader, createLyricsSession, lyricsKey, lyricsQuery, parseLrc } from '../web/lyrics.js';

const track = { source: 'local', id: 'local:first', title: ' North   Star ', artist: ' Звезда ', album: { title: 'Live' }, duration: 12.6 };

test('lookup uses the playing recording and its stable ID across queue entries', () => {
  assert.deepEqual(lyricsQuery({ ...track, importRecord: { title: 'An older match' } }),
    { title: 'North Star', artist: 'Звезда', album: 'Live', duration: 13 });
  assert.equal(lyricsKey(track), lyricsKey({ ...track, queueKey: 'next-copy', album: undefined, duration: 0 }));
  assert.notEqual(lyricsKey(track), lyricsKey({ ...track, id: 'local:second' }));
  const metadataOnly = { artist: 'Moon', title: 'Song', album: 'Live', duration: 90 };
  assert.equal(lyricsKey(metadataOnly), lyricsKey({ ...metadataOnly, title: ' song ', artist: 'MOON' }));
  assert.notEqual(lyricsKey(metadataOnly), lyricsKey({ ...metadataOnly, album: 'Acoustic' }));
  assert.notEqual(lyricsKey(metadataOnly), lyricsKey({ ...metadataOnly, duration: 120 }));
  assert.deepEqual(lyricsQuery({ title: 'Song', artists: [{ name: 'A' }, { name: 'B' }], duration: Infinity }),
    { title: 'Song', artist: 'A, B', album: '', duration: 0 });
});

test('missing artist from an imported filename never causes a network request', async () => {
  const load = createLyricsLoader(() => assert.fail('unexpected request'));
  for (const incomplete of [null, { title: 'Hi', artists: {} }, { ...track, artist: 'Your files' }, { ...track, artist: 'Unknown artist' }]) {
    assert.deepEqual(await load(incomplete), { kind: 'missing' });
    assert.equal(await load(incomplete, { cacheOnly: true }), null);
  }
});

test('LRC supports repeated stamps, simultaneous lines, word tags, offsets and silent gaps', () => {
  const lines = parseLrc('\ufeff[ar:Z]\r\n[00:03.1][00:09.100] <00:03.10>North <00:03.40>Star\r\n[00:03:10]Север\r\n[00:06]\r\n[01:02.005]End\r\n[offset:+100]');
  assert.deepEqual(lines, [
    { time: 3, text: 'North Star\nСевер' }, { time: 5.9, text: '' },
    { time: 9, text: 'North Star' }, { time: 61.905, text: 'End' },
  ]);
  for (const [position, expected] of [[3, 0], [5.9, -1], [9, 2], [100, 3], [0, -1], [3.1, 0], [Infinity, -1]]) {
    assert.equal(activeLyricIndex(lines, position), expected);
  }
  assert.deepEqual(parseLrc('[00:10.00]Line\n[offset:-250]'), [{ time: 10.25, text: 'Line' }]);
});

test('prefers timed lyrics with words, falls back to plain and distinguishes instrumental from missing', async () => {
  const result = record => createLyricsLoader(async () => record)(track);
  assert.deepEqual(await result({ syncedLyrics: '[00:02.50]Line', plainLyrics: 'Other' }), { kind: 'timed', lines: [{ time: 2.5, text: 'Line' }] });
  assert.deepEqual(await result({ syncedLyrics: '[ar:artist]\n[00:00.00]\n[00:90]bad', plainLyrics: 'first\r\n\r\nsecond' }),
    { kind: 'plain', text: 'first\n\nsecond' });
  assert.deepEqual(await result({ instrumental: true }), { kind: 'instrumental' });
  assert.deepEqual(await result(null), { kind: 'missing' });
  assert.deepEqual(await result({ syncedLyrics: '', plainLyrics: ' ' }), { kind: 'missing' });
});

test('two taps share a fetch, a concurrent cache-only read stays offline and a new loader uses the saved record', async () => {
  const disk = new Map();
  const requests = [];
  let finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const fetch = async ({ key, cacheOnly }) => {
    requests.push(cacheOnly);
    if (disk.has(key)) return disk.get(key);
    if (cacheOnly) return null;
    await gate;
    const record = { plainLyrics: 'Saved line' };
    disk.set(key, record);
    return record;
  };
  const load = createLyricsLoader(fetch);
  assert.equal(requests.length, 0);
  const first = load(track);
  const second = load({ ...track, queueKey: 'copy' });
  assert.equal(await load(track, { cacheOnly: true }), null);
  assert.deepEqual(requests, [false, true]);
  finish();
  assert.deepEqual(await first, { kind: 'plain', text: 'Saved line' });
  assert.deepEqual(await second, await first);
  const reopened = createLyricsLoader(fetch);
  assert.deepEqual(await reopened({ ...track, duration: 0 }, { cacheOnly: true }), await first);
  assert.deepEqual(requests, [false, true, true]);
});

test('an offline error can be retried and a failed cache write still shows the words', async () => {
  let attempts = 0;
  const load = createLyricsLoader(async () => {
    if (++attempts === 1) throw new Error('offline');
    return { plainLyrics: 'Available', storageFailed: true };
  });
  await assert.rejects(load(track), /offline/);
  assert.deepEqual(await load(track), { kind: 'plain', text: 'Available', storageFailed: true });
});

test('the open reader follows track changes and seeks without showing superseded lyrics', async () => {
  let visible = false;
  const requested = [], rendered = [], highlighted = [], replies = [];
  const session = createLyricsSession(item => {
    requested.push(item.id);
    return new Promise(resolve => replies.push(resolve));
  }, {
    isOpen: () => visible,
    show: () => { visible = true; },
    close: () => { visible = false; },
    render: result => rendered.push(result),
    highlight: index => highlighted.push(index),
  });

  const second = { ...track, id: 'local:second' };
  session.trackChanged(track);
  assert.deepEqual(requested, []);
  const firstRead = session.open(track);
  const nextRead = session.trackChanged(second);
  session.trackChanged({ ...second, queueKey: 'another-occurrence' });
  assert.deepEqual(requested, [track.id, second.id]);
  const timed = { kind: 'timed', lines: [{ time: 0, text: 'First line' }, { time: 9, text: 'Second line' }] };
  session.sync(10);
  replies[1](timed);
  await nextRead;
  replies[0]({ kind: 'plain', text: 'Words from the earlier track' });
  await firstRead;
  assert.deepEqual(rendered, [timed]);
  session.sync(1);
  assert.deepEqual(highlighted, [1, 0]);

  const closedRead = session.trackChanged(track);
  session.trackChanged(null);
  replies[2](timed);
  await closedRead;
  assert.equal(visible, false);
  session.trackChanged(second);
  session.sync(30);
  assert.equal(requested.length, 3);
  assert.deepEqual(rendered, [timed]);
  assert.deepEqual(highlighted, [1, 0]);
});
