import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WindowsCatalogPlayer } from '../web/windows-catalog-player.js';

const trackURL = 'https://tracks.monochrome.st/track/175366268671557632';
const recordingId = '198091630517948416';
const interrupted = () => { throw new DOMException('Failed to load', 'NotSupportedError'); };
const pending = () => new Promise(() => {});

function fixture(outcomes, id, url = trackURL) {
  class TestAudio extends EventTarget {
    currentTime = 0;
    requests = [];
    reloads = 0;
    paused = true;
    load() { this.error = null; this.currentTime = 0; this.reloads++; }
    pause() { this.paused = true; }
    play() {
      this.paused = false;
      this.requests.push({ url: this.src, position: this.currentTime });
      return outcomes.shift()();
    }
    interrupt() {
      this.error = { code: 2 };
      this.dispatchEvent(new Event('error'));
    }
  }
  const element = new TestAudio();
  const player = new WindowsCatalogPlayer(element, () => id);
  player.setSource(url, 'in-queue');
  return { player, element };
}

test('healthy Windows catalog playback starts once, without reloading the media element', async () => {
  const { player, element } = fixture([() => {}], recordingId);
  await player.play();
  assert.deepEqual(element.requests, [{ url: trackURL, position: 0 }]);
  assert.equal(element.reloads, 0);
});

test('startup recovery uses the same recording and keeps the original URL for older tracks', async () => {
  for (const id of [recordingId, undefined, '../bogus']) {
    const { player, element } = fixture([interrupted, () => {}], id);
    await player.play();
    const secondURL = id === recordingId ? new URL(id, trackURL).href : trackURL;
    assert.deepEqual(element.requests.map(r => r.url), [trackURL, secondURL]);
    assert.equal(element.reloads, 1);
    assert.equal(player.entry, 'in-queue');
  }
});

test('a late network error resumes from the interruption and has a bounded retry budget', async () => {
  const { player, element } = fixture([() => {}, () => {}]);
  let reported = 0;
  player.addEventListener('error', () => reported++);
  await player.play();
  element.currentTime = 42.5;
  element.interrupt();
  await nextTurn();
  assert.deepEqual(element.requests.at(-1), { url: trackURL, position: 42.5 });
  assert.equal(reported, 0);
  element.interrupt();
  await nextTurn();
  assert.equal(reported, 1);
  assert.equal(element.requests.length, 2);
  assert.equal(element.paused, true);
});

test('a hanging Windows catalog request is retried, times out and releases the player', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { player, element } = fixture([pending, pending, () => {}]);
  const failure = assert.rejects(player.play(), { name: 'TimeoutError' });
  t.mock.timers.tick(20000);
  await nextTurn();
  assert.equal(element.requests.length, 2);
  t.mock.timers.tick(45000);
  await failure;
  assert.equal(element.paused, true);
  assert.equal(player.error.name, 'TimeoutError');
  player.setSource(trackURL, 'in-queue');
  await player.play();
  assert.equal(player.error, null);
});

test('pausing or selecting another track cancels a pending retry', async () => {
  for (const cancel of [p => p.pause(), p => p.setSource('blob:next', 'next')]) {
    let rejectRetry;
    const { player, element } = fixture([interrupted, () => new Promise((_, reject) => { rejectRetry = reject; })]);
    const canceled = assert.rejects(player.play(), { name: 'AbortError' });
    await nextTurn();
    cancel(player);
    rejectRetry(new Error('Previous request failed after cancellation'));
    await canceled;
    assert.equal(element.requests.length, 2);
    assert.equal(player.error, null);
  }
});

test('offline files, other providers and denied autoplay do not trigger a catalog retry', async () => {
  for (const url of ['http://asset.localhost/track.flac', 'https://cdn.audius.co/stream']) {
    const { player, element } = fixture([interrupted], recordingId, url);
    await assert.rejects(player.play(), { name: 'NotSupportedError' });
    assert.equal(element.reloads, 0);
  }
  const { player, element } = fixture([() => { throw new DOMException('Autoplay denied', 'NotAllowedError'); }]);
  await assert.rejects(player.play(), { name: 'NotAllowedError' });
  assert.equal(element.requests.length, 1);
});
