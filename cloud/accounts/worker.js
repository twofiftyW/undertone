const DAY = 86400;
const INVITE = /^[a-f0-9]{32}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const REVISION = /^(0|[a-f0-9-]{36})$/;
const LIBRARY_LIMIT = 24 * 1024 * 1024;
const now = () => Math.floor(Date.now() / 1000);
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const random = size => hex(crypto.getRandomValues(new Uint8Array(size)));
const hash = async value => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, If-Match, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '86400',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff'
};

const json = (value, status = 200) => Response.json(value, { status, headers });
const failure = (error, status) => json({ error }, status);
const empty = (status, etag) => new Response(null, { status, headers: etag ? { ...headers, ETag: etag } : headers });
const tag = revision => '"' + revision + '"';

class BodyTooLarge extends Error {}

async function readBody(request, limit) {
  if (Number(request.headers.get('Content-Length')) > limit) throw new BodyTooLarge();
  if (!request.body) return '';
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new BodyTooLarge();
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join('');
  } finally {
    reader.releaseLock();
  }
}

function publicAccount(row, env) {
  return { id: row.id, login: row.login, owner: row.id === env.OWNER_GITHUB_ID };
}

function session(db, tokenHash) {
  return db.prepare(`SELECT accounts.id, login, revision FROM sessions
    JOIN accounts ON accounts.id = sessions.account_id
    WHERE sessions.hash = ? AND sessions.expires_at > ?`).bind(tokenHash, now()).first();
}

async function githubPost(path, fields) {
  const response = await fetch('https://github.com' + path, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: new URLSearchParams(fields),
    redirect: 'manual'
  });
  const result = await response.json();
  if (!response.ok && !result.error) throw new Error('GitHub sign-in failed');
  return result;
}

async function startSignIn(request, env) {
  if (!env.GITHUB_CLIENT_ID || !/^[1-9]\d*$/.test(env.OWNER_GITHUB_ID || '')) return failure('unavailable', 503);
  if (env.SIGN_IN_LIMIT && !(await env.SIGN_IN_LIMIT.limit({ key: request.headers.get('CF-Connecting-IP') || 'local' })).success) {
    return failure('try_later', 429);
  }
  let body;
  try {
    body = JSON.parse(await readBody(request, 1024));
  } catch (error) {
    if (error instanceof BodyTooLarge) throw error;
    return failure('invalid_request', 400);
  }
  if (!body || typeof body.invite !== 'string') return failure('invalid_request', 400);
  const code = body.invite.trim().toLowerCase();
  if (code && !INVITE.test(code)) return failure('invalid_invite', 400);
  const inviteHash = code ? await hash(code) : null;
  if (inviteHash && !await env.DB.prepare('SELECT 1 FROM invites WHERE hash = ? AND expires_at > ?').bind(inviteHash, now()).first()) {
    return failure('invalid_invite', 403);
  }
  const grant = await githubPost('/login/device/code', { client_id: env.GITHUB_CLIENT_ID });
  if (!grant.device_code || !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(grant.user_code || '') ||
      !Number.isSafeInteger(grant.expires_in) || !Number.isSafeInteger(grant.interval)) return failure('unavailable', 503);
  const token = random(32);
  const created = now();
  const interval = Math.max(5, grant.interval);
  const expiresAt = created + Math.min(900, grant.expires_in);
  await env.DB.prepare('INSERT INTO sign_ins VALUES (?, ?, ?, ?, ?, ?)')
    .bind(await hash(token), grant.device_code, inviteHash, expiresAt, interval, created + interval).run();
  return json({ token, code: grant.user_code, interval, expiresAt });
}

async function pollSignIn(env, tokenHash) {
  const db = env.DB;
  const active = await session(db, tokenHash);
  if (active) return json(publicAccount(active, env));
  const time = now();
  const flow = await db.prepare('SELECT * FROM sign_ins WHERE hash = ? AND expires_at > ?').bind(tokenHash, time).first();
  if (!flow) return failure('sign_in_expired', 401);
  const pending = (interval) => json({ interval }, 202);
  if (flow.next_poll > time) return pending(flow.next_poll - time);
  const reserved = await db.prepare('UPDATE sign_ins SET next_poll = ? WHERE hash = ? AND next_poll = ?')
    .bind(time + flow.interval, tokenHash, flow.next_poll).run();
  if (!reserved.meta.changes) return pending(flow.interval);
  const grant = await githubPost('/login/oauth/access_token', {
    client_id: env.GITHUB_CLIENT_ID,
    device_code: flow.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  });
  if (grant.error === 'authorization_pending') return pending(flow.interval);
  if (grant.error === 'slow_down') {
    const interval = Math.max(flow.interval + 5, Number(grant.interval) || 0);
    await db.prepare('UPDATE sign_ins SET interval = ?, next_poll = ? WHERE hash = ?')
      .bind(interval, now() + interval, tokenHash).run();
    return pending(interval);
  }
  if (['access_denied', 'expired_token', 'incorrect_device_code'].includes(grant.error)) {
    await db.prepare('DELETE FROM sign_ins WHERE hash = ?').bind(tokenHash).run();
    return failure('sign_in_expired', 401);
  }
  if (!grant.access_token) return failure('unavailable', 503);
  const response = await fetch('https://api.github.com/user', {
    headers: { Authorization: 'Bearer ' + grant.access_token, Accept: 'application/vnd.github+json', 'User-Agent': 'Undertone Accounts' },
    redirect: 'manual'
  });
  if (!response.ok) return failure('unavailable', 503);
  const profile = await response.json();
  const id = String(profile.id);
  const login = profile.login;
  if (!/^[1-9]\d{0,19}$/.test(id) || !/^[a-zA-Z0-9-]{1,39}$/.test(login || '')) return failure('unavailable', 503);
  const verifiedAt = now();
  const [, , signedIn] = await db.batch([
    db.prepare(`INSERT INTO accounts (id, login, invite_hash)
       SELECT ?, ?, hash FROM invites
       WHERE hash = ? AND expires_at > ? AND (reserved_for IS NULL OR reserved_for = ?)
       ON CONFLICT(id) DO NOTHING`).bind(id, login, flow.invite_hash, verifiedAt, id),
    db.prepare('UPDATE accounts SET login = ? WHERE id = ? AND login <> ?').bind(login, id, login),
    db.prepare(`INSERT INTO sessions (hash, account_id, expires_at)
       SELECT ?, id, ? FROM accounts WHERE id = ? ON CONFLICT(hash) DO NOTHING`).bind(tokenHash, verifiedAt + 90 * DAY, id),
    db.prepare('DELETE FROM sign_ins WHERE hash = ?').bind(tokenHash)
  ]);
  if (!signedIn.meta.changes && !await session(db, tokenHash)) {
    return failure(flow.invite_hash ? 'invalid_invite' : 'invite_required', 403);
  }
  return json(publicAccount({ id, login }, env));
}

async function issueInvite(env, account) {
  if (account.id !== env.OWNER_GITHUB_ID) return failure('owner_required', 403);
  const code = random(16);
  const expiresAt = now() + 7 * DAY;
  await env.DB.prepare('INSERT INTO invites (hash, expires_at) VALUES (?, ?)').bind(await hash(code), expiresAt).run();
  return json({ code, expiresAt }, 201);
}

async function getLibrary(request, db, account) {
  const etag = tag(account.revision);
  if (request.headers.get('If-None-Match') === etag) return empty(304, etag);
  const { results } = await db.prepare(`SELECT accounts.revision, library_parts.body
    FROM accounts LEFT JOIN library_parts ON library_parts.account_id = accounts.id AND library_parts.revision = accounts.revision
    WHERE accounts.id = ? ORDER BY library_parts.part`).bind(account.id).all();
  return new Response(results.map(part => part.body || '').join(''), {
    headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8', ETag: tag(results[0].revision) }
  });
}

async function putLibrary(request, db, account) {
  const etag = request.headers.get('If-Match') || '';
  if (!etag.startsWith('"') || !etag.endsWith('"') || !REVISION.test(etag.slice(1, -1))) return failure('invalid_request', 400);
  if (etag !== tag(account.revision)) return empty(412);
  const body = await readBody(request, LIBRARY_LIMIT);
  if (!body) return failure('invalid_request', 400);
  const revision = crypto.randomUUID();
  const statements = [
    db.prepare('UPDATE accounts SET revision = ? WHERE id = ? AND revision = ?')
      .bind(revision, account.id, account.revision),
    db.prepare(`DELETE FROM library_parts WHERE account_id = ? AND revision = ?
      AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND revision = ?)`)
      .bind(account.id, account.revision, account.id, revision)
  ];
  // Each part stays comfortably below D1's per-row byte limit, including Unicode.
  for (let offset = 0, part = 0; offset < body.length; part++) {
    let end = Math.min(offset + 200000, body.length);
    const last = body.charCodeAt(end - 1);
    if (end < body.length && last >= 0xd800 && last <= 0xdbff) end--;
    statements.push(db.prepare(`INSERT INTO library_parts
      SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ? AND revision = ?)`)
      .bind(account.id, revision, part, body.slice(offset, end), account.id, revision));
    offset = end;
  }
  const [updated] = await db.batch(statements);
  return updated.meta.changes ? empty(204, tag(revision)) : empty(412);
}

async function route(request, env) {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (method === 'OPTIONS') return empty(204);
  if (method === 'GET' && path === '/health') return json({ service: 'undertone-accounts' });
  if (method === 'POST' && path === '/v1/sign-in') return startSignIn(request, env);
  if (!['/v1/sign-in/poll', '/v1/session', '/v1/invites', '/v1/library'].includes(path)) return failure('not_found', 404);
  const token = /^Bearer (\w+)$/.exec(request.headers.get('Authorization') || '')?.[1] || '';
  if (!TOKEN.test(token)) return failure('signed_out', 401);
  const tokenHash = await hash(token);
  if (method === 'POST' && path === '/v1/sign-in/poll') return pollSignIn(env, tokenHash);
  const account = await session(env.DB, tokenHash);
  if (!account) return failure('signed_out', 401);
  if (method === 'GET' && path === '/v1/session') return json(publicAccount(account, env));
  if (method === 'DELETE' && path === '/v1/session') {
    await env.DB.prepare('DELETE FROM sessions WHERE hash = ?').bind(tokenHash).run();
    return empty(204);
  }
  if (method === 'POST' && path === '/v1/invites') return issueInvite(env, account);
  if (method === 'GET' && path === '/v1/library') return getLibrary(request, env.DB, account);
  if (method === 'PUT' && path === '/v1/library') return putLibrary(request, env.DB, account);
  return failure('not_found', 404);
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof BodyTooLarge) return failure('too_large', 413);
      console.error('Undertone accounts request failed', { type: error.name });
      return failure('unavailable', 503);
    }
  },
  async scheduled(_event, env) {
    const time = now();
    const db = env.DB;
    await db.batch([
      db.prepare('DELETE FROM invites WHERE expires_at <= ?').bind(time),
      db.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(time),
      db.prepare('DELETE FROM sign_ins WHERE expires_at <= ?').bind(time)
    ]);
  }
};
