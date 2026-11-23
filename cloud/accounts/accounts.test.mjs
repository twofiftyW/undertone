import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import {
  accountSnapshot, activateAccountLibrary, applyAccountSnapshot, decodeSnapshot, mergeAccountSnapshots
} from '../../web/account-library.js';
import { emptyLibrary } from '../../web/core.js';

const path = name => fileURLToPath(new URL(name, import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const day = 86400;
const soon = () => Math.floor(Date.now() / 1000) + day;
const raw = id => ({ id, source: 'monochrome', title: id, artist: 'Artist', nativePath: '/device/local.flac' });
const snapshot = (liked, list, name = 'Mix') => accountSnapshot({
  liked, playlists: [{ id: 'mix', name, trackIds: list }], tracks: Object.fromEntries([...liked, ...list].map(id => [id, raw(id)]))
});

test('library sync preserves distinct edits, removals, repeated tracks, and device downloads', () => {
  const base = snapshot(['song-a', 'song-b'], ['song-a', 'song-b', 'song-a']);
  const here = snapshot(['song-b', 'song-c'], ['song-a', 'song-a', 'song-c'], 'Renamed');
  const there = snapshot(['song-d', 'song-a', 'song-b'], ['song-a', 'song-b', 'song-a', 'song-d']);
  const merged = mergeAccountSnapshots(base, here, there);
  assert.deepEqual(merged.liked, ['song-c', 'song-d', 'song-b']);
  assert.deepEqual(merged.playlists[0].trackIds, ['song-a', 'song-a', 'song-d', 'song-c']);
  assert.equal(merged.playlists[0].name, 'Renamed');
  assert.equal(merged.tracks['song-a'].nativePath, undefined);
  assert.deepEqual(decodeSnapshot(JSON.stringify(merged)), merged);

  const device = emptyLibrary();
  device.downloads['song-a'] = { nativePath: '/device/local.flac' };
  device.tracks['song-a'] = raw('song-a');
  applyAccountSnapshot(device, merged);
  assert.equal(device.downloads['song-a'].nativePath, '/device/local.flac');
  assert.equal(device.tracks['song-a'].nativePath, '/device/local.flac');
  assert.equal(accountSnapshot(device).downloads, undefined);

  activateAccountLibrary(device, '11');
  assert.deepEqual(device.liked, merged.liked);
  device.liked = ['song-b'];
  activateAccountLibrary(device, '');
  assert.deepEqual(device.liked, merged.liked);
  activateAccountLibrary(device, '22');
  assert.deepEqual(device.liked, []);
  activateAccountLibrary(device, '11');
  assert.deepEqual(device.liked, ['song-b']);
  assert.equal(device.downloads['song-a'].nativePath, '/device/local.flac');
});

test('Cloudflare accounts accept only owner invites and protect concurrent library writes', async t => {
  let identity = 11;
  const miniflare = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: path('./worker.js'), compatibilityDate: '2026-11-23',
    d1Databases: { DB: 'test-accounts' }, bindings: { GITHUB_CLIENT_ID: 'test-client', OWNER_GITHUB_ID: '11' },
    cf: false,
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.host === 'github.com' && url.pathname === '/login/device/code') {
        return Response.json({ device_code: String(identity), user_code: 'TEST-CODE', interval: 5, expires_in: 900 });
      }
      if (url.host === 'github.com' && url.pathname === '/login/oauth/access_token') {
        const values = new URLSearchParams(await request.text());
        return Response.json({ access_token: values.get('device_code') });
      }
      if (url.host === 'api.github.com' && url.pathname === '/user') {
        const id = Number(request.headers.get('Authorization').slice(7));
        return Response.json({ id, login: 'account-' + id });
      }
      throw new Error('Unexpected OAuth request');
    }
  }));
  t.after(() => miniflare.dispose());
  const db = await miniflare.getD1Database('DB');
  const migration = await readFile(path('./migrations/0001_accounts.sql'), 'utf8');
  const statements = migration.replace(/^--.*$/gm, '').trim().split(/;\s*(?=CREATE |$)/).filter(Boolean);
  await db.batch(statements.map(sql => db.prepare(sql)));
  const api = (route, options = {}, token) => miniflare.dispatchFetch('http://undertone.test' + route, {
    ...options, headers: { ...options.headers, ...(token ? { Authorization: 'Bearer ' + token } : {}) }
  });
  const start = async (id, invite = '') => {
    identity = id;
    const reply = await api('/v1/sign-in', { method: 'POST', body: JSON.stringify({ invite }) });
    assert.equal(reply.status, 200, await reply.clone().text());
    const flow = await reply.json();
    await db.prepare('UPDATE sign_ins SET next_poll = 0 WHERE hash = ?').bind(hash(flow.token)).run();
    return flow.token;
  };
  const poll = token => api('/v1/sign-in/poll', { method: 'POST' }, token);
  assert.equal((await api('/v1/library')).status, 401);

  const attempted = await poll(await start(11));
  assert.equal(attempted.status, 403);
  assert.equal((await attempted.json()).error, 'invite_required');

  const firstCode = randomBytes(16).toString('hex');
  await db.prepare('INSERT INTO invites VALUES (?, ?, ?)').bind(hash(firstCode), soon(), '11').run();
  assert.equal((await poll(await start(12, firstCode))).status, 403);
  const owner = await start(11, firstCode);
  assert.deepEqual(await (await poll(owner)).json(), { id: '11', login: 'account-11', owner: true });
  assert.equal(await db.prepare('SELECT 1 FROM invites WHERE hash = ?').bind(hash(firstCode)).first(), null);

  const code = await (await api('/v1/invites', { method: 'POST' }, owner)).json();
  const a = await start(11, code.code);
  const b = await start(12, code.code);
  const c = await start(13, code.code);
  assert.equal((await poll(a)).status, 200);
  const replies = await Promise.all([poll(b), poll(c)]);
  assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 403]);
  const member = replies[0].ok ? b : c;
  const memberId = (await (await api('/v1/session', {}, member)).json()).id;
  assert.equal((await poll(await start(Number(memberId)))).status, 200);
  assert.equal((await api('/v1/invites', { method: 'POST' }, member)).status, 403);

  const expired = randomBytes(16).toString('hex');
  await db.prepare('INSERT INTO invites VALUES (?, ?, NULL)').bind(hash(expired), soon() - 2 * day).run();
  assert.equal((await api('/v1/sign-in', { method: 'POST', body: JSON.stringify({ invite: expired }) })).status, 403);
  assert.equal((await api('/v1/sign-in', { method: 'POST', body: JSON.stringify({ invite: code.code }) })).status, 403);

  const get = (token, etag) => api('/v1/library', { headers: etag ? { 'If-None-Match': etag } : {} }, token);
  const put = (token, etag, body) => api('/v1/library', { method: 'PUT', headers: { 'If-Match': etag }, body }, token);
  const blank = await get(owner);
  const initialRevision = blank.headers.get('ETag');
  assert.equal(await blank.text(), '');
  const large = JSON.stringify({ value: 'X'.repeat(199989) + '🎵' + 'ö'.repeat(1100000) });
  const small = JSON.stringify(snapshot(['song-a'], ['song-a']));
  const writes = await Promise.all([put(owner, initialRevision, large), put(a, initialRevision, small)]);
  assert.deepEqual(writes.map(reply => reply.status).sort(), [204, 412]);
  const result = await get(a);
  assert.equal(await result.text(), writes[0].ok ? large : small);
  assert.equal((await get(a, result.headers.get('ETag'))).status, 304);
  assert.equal(await (await get(member)).text(), '');
  assert.equal((await api('/v1/session', { method: 'DELETE' }, a)).status, 204);
  assert.equal((await get(a)).status, 401);
  assert.equal((await get(owner)).status, 200);
});
