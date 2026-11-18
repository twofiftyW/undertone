import { escapeHTML as h } from './core.js';
import { tr } from './i18n.js';

export function deviceLink({ native, android, platform, openDialog, dialogTop, dialog, copied, prepare, toast }) {
  let state = {};
  let busy = false;
  let note = '';
  let timer;
  function render() {
    const message = `<p class="link-message" role="status">${h(tr(note))}</p>`;
    if (!android) {
      openDialog(`${dialogTop(tr("Connect your phone"))}<p class="dialog-description">${h(tr("Open Undertone on both devices and connect them to the same Wi-Fi. On your phone, open Library → Connect PC and enter these details."))}</p>${state.running ? `<label class="dialog-field" for="pc-address">${h(tr("PC ADDRESS"))}</label><input class="dialog-input link-value" id="pc-address" readonly value="${h(state.addresses?.[0] || tr("No local Wi-Fi address found"))}">${state.addresses?.length > 1 ? `<p class="dialog-description">${h(tr("Other address:"))} ${h(state.addresses.slice(1).join(', '))}</p>` : ''}<label class="dialog-field" for="pc-code">${h(tr("PAIRING CODE · VALID FOR 10 MINUTES"))}</label><input class="dialog-input link-value" id="pc-code" readonly value="${h(state.code)}"><p class="dialog-description">${state.pairedDevices || 0} ${h(tr("paired phones. The code pairs one new phone. Your PC must stay open while copying."))}</p><div class="dialog-buttons"><button class="secondary-btn" data-action="link-start" ${busy ? 'disabled' : ''}>${h(tr("New pairing code"))}</button><button class="secondary-btn" data-action="link-stop" ${busy ? 'disabled' : ''}>${h(tr("Turn connection off"))}</button></div>` : `<button class="primary-btn" data-action="link-start" ${busy ? 'disabled' : ''}>${busy ? tr("Starting…") : tr("Enable phone connection")}</button>`}${state.running && state.firewall ? `<p class="dialog-description">${h(tr("Your Linux firewall is enabled. Allow Undertone on the local Wi-Fi network if the phone cannot connect. Linux will show a system password prompt."))}</p><button class="secondary-btn" data-action="link-firewall">${h(tr("Allow phone through firewall"))}</button>` : ''}${state.running && platform === 'windows' ? `<p class="dialog-description">${h(tr("If the phone cannot connect, allow Undertone’s Python runtime on private networks in Windows Firewall."))}</p>` : ''}${state.pairedDevices ? `<button class="text-button" data-action="link-revoke">${h(tr("Forget paired phones"))}</button>` : ''}${message}<p class="dialog-description">${h(tr("Copies playlists, Liked Songs, imported audio, and completed downloads over your local network. Songs saved only in playlists stream normally until you download them. Stop the connection when you’re finished."))}</p>`, 'link');
    } else {
      openDialog(`${dialogTop(tr("Connect to your PC"))}<p class="dialog-description">${h(tr("On your PC, open Library → Connect phone. Keep both devices on the same Wi-Fi."))}</p>${!state.paired ? `<form id="link-form"><label class="dialog-field" for="link-address">${h(tr("PC ADDRESS"))}</label><input class="dialog-input" id="link-address" placeholder="192.168.1.10:47832" autocomplete="off" required><label class="dialog-field" for="link-code">${h(tr("PAIRING CODE"))}</label><input class="dialog-input link-value" id="link-code" placeholder="xxxx-xxxx-xxxx-xxxx-123456" autocomplete="off" autocapitalize="none" spellcheck="false" required><div class="dialog-buttons"><button class="primary-btn" ${busy ? 'disabled' : ''}>${busy ? tr("Connecting…") : tr("Pair with PC")}</button></div></form>` : `<p class="link-connected">${h(tr("Paired with"))} <strong>${h(state.address)}</strong></p><label class="link-audio"><input id="link-audio" type="checkbox" checked ${busy ? 'disabled' : ''}>${h(tr("Copy saved audio for offline listening"))}</label><p class="dialog-description">${h(tr("Adds PC Liked Songs and updates the copied PC playlists. Your phone’s own playlists stay. Keep Undertone open until copying finishes."))}</p><div class="dialog-buttons"><button class="primary-btn" data-action="link-pull" ${busy ? 'disabled' : ''}>${busy ? tr("Copying…") : tr("Copy from PC")}</button><button class="secondary-btn" data-action="link-forget" ${busy ? 'disabled' : ''}>${h(tr("Forget PC"))}</button></div>`}${message}${busy && state.total ? `<progress class="link-progress" max="${state.total}" value="${state.done || 0}"></progress><p class="dialog-description">${h(tr('{done} / {total} audio files checked', { done: state.done || 0, total: state.total }))}</p>` : ''}`, 'link');
    }
  }
  async function run(operation, args = {}) {
    if (busy) return null;
    busy = true; note = ''; render();
    try {
      const result = await native.invoke(operation, args);
      state = await native.invoke('link_status');
      return result;
    } catch (error) {
      note = String(error.message || error);
      return null;
    } finally {
      busy = false;
      if (dialog.open && dialog.dataset.kind === 'link') render();
    }
  }
  async function show() {
    if (!native) { toast(tr("Device connection is available in the installed app.")); return; }
    try { state = await native.invoke('link_status'); } catch (error) { note = String(error.message || error); }
    render();
  }
  const actions = {
    'device-link': show,
    'link-start': async () => { await prepare(); const result = await run('link_start'); if (result) { state = result; render(); } },
    'link-stop': () => run('link_stop'),
    'link-forget': () => run('link_forget'),
    'link-revoke': () => run('link_revoke'),
    'link-firewall': async () => { const result = await run('link_firewall'); if (result !== null) { note = tr("Undertone is allowed on your local Wi-Fi network."); render(); } },
    'link-pull': async () => {
      const audio = document.querySelector('#link-audio')?.checked !== false;
      busy = true; note = tr("Reading the PC library…"); render();
      clearInterval(timer);
      timer = setInterval(async () => {
        try { const update = await native.invoke('link_status'); if (!busy) return; state = update; if (dialog.open && dialog.dataset.kind === 'link') render(); } catch { /* The copy reports its own connection error. */ }
      }, 2000);
      try {
        const result = await native.invoke('link_pull', { audio });
        await copied(result);
        note = tr('Playlists copied: {playlists}. New audio files: {files}.', { playlists: result.library.playlists.length, files: result.copied });
        toast(tr("PC library copied. Saved audio is ready offline."));
      } catch (error) { note = String(error.message || error); }
      finally { busy = false; clearInterval(timer); if (dialog.open && dialog.dataset.kind === 'link') render(); }
    },
  };
  async function submit() {
    const address = document.querySelector('#link-address').value.trim();
    const code = document.querySelector('#link-code').value.trim();
    const result = await run('link_pair', { address, code });
    if (result) { note = tr("Paired. Tap Copy from PC to bring your library over."); render(); }
    else {
      const field = document.querySelector('#link-address');
      if (field) field.value = address;
    }
  }
  return { actions, submit };
}
