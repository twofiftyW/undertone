import {
  accountSnapshot, activateAccountLibrary, applyAccountSnapshot, decodeSnapshot, encodeSnapshot,
  mergeAccountSnapshots, sameSnapshot
} from './account-library.js';
import { accountOrigin } from './account-config.js';
import { escapeHTML as h } from './core.js';
import { tr } from './i18n.js';

const KEY = 'undertone.account.session';
const TOKEN = /^[a-f0-9]{64}$/;
const GITHUB_URL = 'https://github.com/login/device';
const POLL_INTERVAL = 60000;
const EDIT_DELAY = 1600;

const messages = {
  invalid_invite: 'That invite code is invalid, expired, or has already been used.',
  invite_required: 'You need an invite code to register an Undertone account.',
  sign_in_expired: 'The sign-in code expired or was declined. Start again.',
  try_later: 'Too many sign-in attempts. Try again in a minute.',
  too_large: 'This library is too large to sync. It is still saved on this device.',
  invalid_library: 'The account returned a library that this version couldn’t read.',
  owner_required: 'Only the Undertone owner can generate invite codes.',
  signed_out: 'Your session expired. Sign in again to resume sync.',
  unavailable: 'Couldn’t reach the account service. Try again.',
  offline: 'Sync will retry when Undertone can connect.'
};

function validAccount(value) {
  return /^[1-9]\d{0,19}$/.test(value?.id || '') && typeof value?.login === 'string';
}

async function request(path, { token, method = 'GET', body, etag } = {}) {
  const headers = new Headers();
  if (token) headers.set('Authorization', 'Bearer ' + token);
  if (etag) headers.set(method === 'PUT' ? 'If-Match' : 'If-None-Match', etag);
  if (body !== undefined) headers.set('Content-Type', path === 'library' ? 'text/plain' : 'application/json');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const reply = await fetch(accountOrigin + '/v1/' + path, {
      method, headers, body, credentials: 'omit', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal: controller.signal
    });
    return { ok: reply.ok, status: reply.status, headers: reply.headers, text: await reply.text() };
  } finally {
    clearTimeout(timeout);
  }
}

function readAccountReply(reply) {
  let data;
  try { data = JSON.parse(reply.text); }
  catch { data = {}; }
  if (!reply.ok) throw new Error(data.error || 'unavailable');
  return data;
}

export function accountSettings({ dialog, dialogTop, openDialog, readLibrary, persist, onLibraryChange, native, platform, toast }) {
  let session = null;
  let flow = null;
  let busy = false;
  let storageReady = false;
  let signedInOnLoad = false;
  let signInTimer;
  let syncTimer;
  let inSync = false;
  let syncQueued = false;
  let remoteCheck = false;
  let problem = '';
  let invite = '';
  let lastSync = 0;

  function redisplay() {
    if (dialog.open && dialog.dataset.kind === 'account') open();
  }

  function status(text) {
    return text ? `<p class="dialog-description" role="status">${h(tr(text))}</p>` : '';
  }

  function action(id, label, style = 'secondary-btn', disabled = false) {
    return `<button type="button" class="${style}" data-action="${id}"${disabled ? ' disabled' : ''}>${h(tr(label))}</button>`;
  }

  function codeField(id, label, code) {
    return `<label for="${id}">${h(tr(label))}</label><input id="${id}" class="dialog-input" value="${h(code)}" readonly \
spellcheck="false" autocomplete="off" data-account-code>`;
  }

  function syncMessage() {
    if (!navigator.onLine) return messages.offline;
    return messages[problem] || (inSync ? 'Syncing library…' : lastSync ? 'Library synced' : 'Waiting to sync library…');
  }

  function updateSyncStatus() {
    if (!session || !dialog.open || dialog.dataset.kind !== 'account') return;
    const slot = dialog.querySelector('[role="status"]');
    if (slot) slot.textContent = tr(syncMessage());
    const button = dialog.querySelector('[data-action="account-sync"]');
    if (button) button.disabled = inSync || busy;
  }

  function open() {
    const header = `${dialogTop()}<h3 class="appearance-heading">${h(tr('Undertone account'))}</h3>`;
    let body;
    if (!accountOrigin) {
      body = status('Account service is unavailable in this build.');
    } else if (!storageReady) {
      body = status('Open your library before signing in.');
    } else if (session) {
      body = `<p class="dialog-description">${h(tr('Signed in as {name}', { name: session.user.login }))}</p>
        <p class="dialog-description">${h(tr('Your playlists, liked songs, and library sync between devices. Audio files are saved per device.'))}</p>
        ${status(syncMessage())}
        <div class="dialog-buttons">${action('account-sync', 'Sync now', 'secondary-btn', inSync || busy)}${action('account-out', 'Sign out', 'secondary-btn', busy)}</div>`;
      if (session.user.owner) {
        body += `<h3 class="appearance-heading">${h(tr('Invite codes'))}</h3>
          <p class="dialog-description">${h(tr('Each code works for one registration and expires after 7 days.'))}</p>
          <div class="dialog-buttons">${action('account-invite', 'Generate invite code', 'primary-btn', busy)}</div>
          ${invite ? `<div class="account-code">${codeField('account-new-invite', 'New invite code', invite)}${action('account-copy', 'Copy invite code')}</div>` : ''}`;
      }
    } else if (flow) {
      body = `<p class="dialog-description">${h(tr('Enter this code on GitHub, authorize Undertone, then return here.'))}</p>
        <div class="account-code">${codeField('account-device-code', 'GitHub sign-in code', flow.code)}${action('account-copy', 'Copy sign-in code')}</div>
        <div class="dialog-buttons">${native && platform !== 'ios' ? action('account-github', 'Open GitHub', 'primary-btn') :
          `<a class="primary-btn" href="${GITHUB_URL}"${platform === 'ios' ? '' : ' target="_blank" rel="noopener noreferrer"'}>${h(tr('Open GitHub'))}</a>`}
          ${action('account-cancel', 'Cancel')}</div>${status(messages[problem] || 'Waiting for GitHub authorization…')}`;
    } else {
      body = `<p class="dialog-description">${h(tr('New accounts need an invite code. Existing members can sign in with GitHub.'))}</p>
        <form id="account-sign-in"><label for="account-invite-code">${h(tr('Invite code (new accounts)'))}</label>
        <input id="account-invite-code" name="invite" class="dialog-input" maxlength="64" autocomplete="off" autocapitalize="none" spellcheck="false"
          value="${h(invite)}"${busy ? ' disabled' : ''}>
        <div class="dialog-buttons"><button type="submit" class="primary-btn"${busy ? ' disabled' : ''}>${h(tr(busy ? 'Starting sign-in…' : 'Sign in with GitHub'))}</button></div></form>
        ${status(messages[problem])}`;
    }
    openDialog(header + body, 'account');
  }

  async function store(value) {
    if (platform === 'ios') await native.invoke('save_account_session', { session: value });
    else if (value) localStorage.setItem(KEY, JSON.stringify(value));
    else localStorage.removeItem(KEY);
  }

  async function activate(id) {
    if (!activateAccountLibrary(readLibrary(), id)) return;
    onLibraryChange();
    await persist();
  }

  async function beginSignIn(form) {
    if (session || flow || busy || !storageReady || !accountOrigin) return;
    invite = form.elements.invite.value;
    problem = '';
    busy = true;
    redisplay();
    try {
      const reply = await request('sign-in', { method: 'POST', body: JSON.stringify({ invite }) });
      const data = readAccountReply(reply);
      if (!TOKEN.test(data.token || '') || !data.code || !data.expiresAt) throw new Error('unavailable');
      flow = data;
      signInTimer = setTimeout(pollSignIn, data.interval * 1000);
    } catch (error) {
      problem = Object.hasOwn(messages, error.message) ? error.message : 'unavailable';
    } finally {
      busy = false;
      redisplay();
    }
  }

  async function pollSignIn() {
    const current = flow;
    if (!current) return;
    let redraw = true;
    if (Date.now() >= current.expiresAt * 1000) {
      cancelSignIn();
      problem = 'sign_in_expired';
      redisplay();
      return;
    }
    try {
      const reply = await request('sign-in/poll', { token: current.token, method: 'POST' });
      const data = readAccountReply(reply);
      if (flow !== current) return;
      if (reply.status === 202) {
        redraw = Boolean(problem);
        problem = '';
        signInTimer = setTimeout(pollSignIn, Math.max(1, data.interval || current.interval) * 1000);
        return;
      }
      if (!validAccount(data)) throw new Error('unavailable');
      const value = { origin: accountOrigin, token: current.token, user: data };
      busy = true;
      try {
        await store(value);
        flow = null;
        session = value;
        invite = '';
        lastSync = 0;
        await activate(data.id);
        problem = '';
        schedule(true);
      } finally {
        busy = false;
      }
    } catch (error) {
      if (flow !== current && session?.token !== current.token) return;
      problem = Object.hasOwn(messages, error.message) ? error.message : 'unavailable';
      if (['invalid_invite', 'invite_required', 'sign_in_expired'].includes(problem)) flow = null;
      else if (flow) signInTimer = setTimeout(pollSignIn, Math.max(10, current.interval) * 1000);
    } finally {
      if (redraw) redisplay();
    }
  }

  function cancelSignIn() {
    if (busy) return;
    flow = null;
    problem = '';
    clearTimeout(signInTimer);
    redisplay();
  }

  async function clearSession(message = '') {
    clearTimeout(syncTimer);
    session = null;
    invite = '';
    lastSync = 0;
    problem = message;
    try { await store(null); }
    finally {
      await activate('');
      redisplay();
    }
  }

  function schedule(pull = false, delay = 0) {
    if (!session || !storageReady || !navigator.onLine) return;
    remoteCheck ||= pull;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sync, delay);
  }

  async function sync() {
    const current = session;
    if (!current || !navigator.onLine) return;
    if (inSync) { syncQueued = true; return; }
    const id = current.user.id;
    const library = readLibrary();
    if (library.cloud?.active !== id) return;
    const saved = library.cloud.accounts[id];
    const initial = saved.base || accountSnapshot();
    if (!remoteCheck && saved.etag && sameSnapshot(accountSnapshot(library), initial)) return;
    remoteCheck = false;
    inSync = true;
    problem = '';
    // Timer-driven sync leaves the dialog controls and keyboard focus intact.
    updateSyncStatus();
    try {
      if (signedInOnLoad) {
        const identity = readAccountReply(await request('session', { token: current.token }));
        if (current !== session) return;
        if (identity.id !== id) throw new Error('signed_out');
        const ownerChanged = current.user.owner !== identity.owner;
        current.user = identity;
        signedInOnLoad = false;
        if (ownerChanged) {
          await store(current);
          if (current !== session) return;
          redisplay();
        }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const reply = await request('library', { token: current.token, etag: saved.etag });
        if (current !== session) return;
        if (!reply.ok && reply.status !== 304) readAccountReply(reply);
        let etag = reply.headers.get('ETag');
        const remote = reply.status === 304 ? initial : decodeSnapshot(reply.text);
        if (!etag) throw new Error('unavailable');
        if (current !== session) return;
        const before = accountSnapshot(readLibrary());
        const merged = mergeAccountSnapshots(initial, before, remote);
        if (!sameSnapshot(merged, remote)) {
          const savedReply = await request('library', {
            token: current.token, method: 'PUT', etag, body: encodeSnapshot(merged)
          });
          if (current !== session) return;
          if (savedReply.status === 412) continue;
          if (!savedReply.ok) readAccountReply(savedReply);
          etag = savedReply.headers.get('ETag');
          if (!etag) throw new Error('unavailable');
        }
        const latest = accountSnapshot(readLibrary());
        const next = mergeAccountSnapshots(before, latest, merged);
        const changed = !sameSnapshot(next, latest);
        if (changed) {
          applyAccountSnapshot(readLibrary(), next);
          onLibraryChange();
        }
        if (saved.etag !== etag || changed) {
          saved.etag = etag;
          saved.base = merged;
          await persist();
        }
        if (current !== session) return;
        lastSync = Date.now();
        if (!sameSnapshot(next, merged)) schedule(false, EDIT_DELAY);
        return;
      }
      schedule(true, 2500);
    } catch (error) {
      if (current !== session) return;
      if (error.message === 'signed_out') await clearSession('signed_out');
      else problem = Object.hasOwn(messages, error.message) && error.message !== 'unavailable' ? error.message : 'offline';
    } finally {
      inSync = false;
      if (syncQueued) {
        syncQueued = false;
        schedule(remoteCheck, 400);
      }
      updateSyncStatus();
    }
  }

  async function start() {
    if (!accountOrigin) return;
    let value;
    try {
      value = platform === 'ios' ? await native.invoke('load_account_session') : JSON.parse(localStorage.getItem(KEY));
    } catch {}
    if (value?.origin === accountOrigin && TOKEN.test(value.token || '') && validAccount(value.user)) {
      session = value;
      signedInOnLoad = true;
    }
    await activate(session?.user.id || '');
    storageReady = true;
    redisplay();
    schedule(true);
    const check = () => { if (!document.hidden) schedule(true, 300); };
    setInterval(check, POLL_INTERVAL);
    window.addEventListener('online', check);
    window.addEventListener('offline', updateSyncStatus);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
  }

  return {
    open, start, submit: beginSignIn,
    changed: () => schedule(false, EDIT_DELAY),
    actions: {
      'account-github': () => native.invoke('github_sign_in'),
      'account-cancel': cancelSignIn,
      'account-sync': () => schedule(true),
      'account-out': async () => {
        if (!session || busy) return;
        const current = session;
        busy = true;
        try {
          await clearSession();
          if (navigator.onLine) await request('session', { token: current.token, method: 'DELETE' }).catch(() => {});
        } finally {
          busy = false;
          redisplay();
        }
      },
      'account-invite': async () => {
        if (!session?.user.owner || busy) return;
        const current = session;
        busy = true;
        problem = '';
        redisplay();
        try {
          const reply = await request('invites', { token: current.token, method: 'POST' });
          const data = readAccountReply(reply);
          if (session === current) invite = data.code;
        } catch (error) {
          if (session === current && error.message === 'signed_out') await clearSession('signed_out');
          else if (session === current) problem = Object.hasOwn(messages, error.message) ? error.message : 'unavailable';
        } finally {
          busy = false;
          redisplay();
        }
      },
      'account-copy': async () => {
        const input = dialog.querySelector('[data-account-code]');
        if (!input) return;
        input.focus();
        input.select();
        try {
          await navigator.clipboard.writeText(input.value);
          toast('Code copied');
        } catch {
          if (document.execCommand('copy')) toast('Code copied');
        }
      }
    }
  };
}
