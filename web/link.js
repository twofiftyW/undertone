import { escapeHTML as h } from './core.js';
import { tr } from './i18n.js';
import { phoneVisibility } from './phone-visibility.js';

export function deviceLink({ native, android, platform, openDialog, dialogTop, dialog, copied, prepare, toast }) {
  let state = {};
  let busy = false;
  let note = '';
  let timer;
  let choosing = false;
  let pairing = null;
  let phoneScan = null;
  let requestPolling;
  const presence = android && native ? phoneVisibility(native, dialog) : null;

  function visible(element) {
    return dialog.open && dialog.dataset.kind === 'link' && dialog.contains(element);
  }

  function chooser() {
    return `<form id="link-form"><fieldset class="link-pair-fields">
      <label class="dialog-field" for="link-device">${h(tr("Available PCs"))}</label>
      <select class="dialog-input" id="link-device" name="device" required>
        <option value="" disabled selected>${h(tr("Choose a PC"))}</option>
        <optgroup label="${h(tr("Available PCs"))}"></optgroup>
        <option value="manual">${h(tr("Enter an address manually"))}</option>
      </select>
      <div class="link-search"><span class="link-message" id="link-search-status" role="status"></span>
        <button type="button" class="secondary-btn" data-action="link-rescan">${h(tr("Search again"))}</button>
      </div>
      <div id="link-manual" hidden>
        <label class="dialog-field" for="link-address">${h(tr("PC ADDRESS"))}</label>
        <input class="dialog-input" id="link-address" name="address" placeholder="192.168.1.10:47832" autocomplete="off" required disabled>
      </div>
      <div class="dialog-buttons">${state.paired ? `<button type="button" class="secondary-btn" data-action="link-cancel-choice">${h(tr("Cancel"))}</button>` : ''}
        <button type="submit" class="primary-btn">${h(tr("Confirm on this phone"))}</button>
      </div></fieldset></form>`;
  }

  function pairedControls() {
    const disabled = busy ? 'disabled' : '';
    return `<p class="link-connected">${h(tr("Paired with"))} <strong>${h(state.address)}</strong></p>
      <label class="link-audio"><input id="link-audio" type="checkbox" checked ${disabled}>${h(tr("Copy saved audio for offline listening"))}</label>
      <p class="dialog-description">${h(tr("Adds PC Liked Songs and updates the copied PC playlists. Your phone’s own playlists stay. Keep Undertone open until copying finishes."))}</p>
      <button class="primary-btn" data-action="link-pull" ${disabled}>${busy ? tr("Copying…") : tr("Copy from PC")}</button>
      <div class="dialog-buttons"><button class="secondary-btn" data-action="link-switch" ${disabled}>${h(tr("Choose another PC"))}</button>
        <button class="secondary-btn" data-action="link-forget" ${disabled}>${h(tr("Forget PC"))}</button></div>`;
  }

  async function discover(form) {
    const refresh = form.querySelector('[data-action="link-rescan"]');
    if (refresh.disabled) return;
    refresh.disabled = true;
    const status = form.querySelector('#link-search-status');
    status.textContent = tr("Searching for PCs…");
    let devices = [];
    let summary;
    try {
      devices = await native.invoke('link_discover');
      summary = devices.length ? tr('PCs found: {count}', { count: devices.length }) : tr("No PCs found.");
    } catch {
      summary = tr("Search unavailable. You can enter the address manually.");
    }
    if (!visible(form)) return;
    const select = form.elements.device;
    const previous = select.value;
    const group = select.querySelector('optgroup');
    const invitedAddress = select.querySelector('#invited-pc')?.value;
    group.replaceChildren(...devices.filter(pc => pc.address !== invitedAddress).map(pc => new Option(`${pc.name} · ${pc.address}`, pc.address)));
    select.value = previous;
    if (select.selectedIndex < 0) select.value = '';
    status.textContent = summary;
    refresh.disabled = false;
  }
  function phonePicker() {
    return `<section id="phone-picker">
      <label class="dialog-field" for="link-phone">${h(tr("Available phones"))}</label>
      <select class="dialog-input" id="link-phone">
        <option value="" disabled selected>${h(tr("Choose a phone"))}</option>
      </select>
      <div class="link-search"><span class="link-message" id="phone-search-status" role="status"></span>
        <button type="button" class="secondary-btn" data-action="link-rescan-phones">${h(tr("Search again"))}</button>
      </div>
      <button type="button" class="primary-btn" data-action="link-invite" disabled>${h(tr("Invite phone"))}</button>
    </section>`;
  }

  async function discoverPhones(panel) {
    const select = panel.querySelector('#link-phone');
    const refresh = panel.querySelector('[data-action="link-rescan-phones"]');
    const invite = panel.querySelector('[data-action="link-invite"]');
    const status = panel.querySelector('#phone-search-status');
    if (refresh.disabled) return;
    refresh.disabled = true;
    invite.disabled = true;
    select.disabled = true;
    status.textContent = tr('Searching for phones…');
    let devices = [];
    let summary;
    try {
      // The desktop scan owns a UDP socket until its reply window closes.
      phoneScan ??= native.invoke('link_discover_phones').finally(() => { phoneScan = null; });
      devices = await phoneScan;
      summary = devices.length ? tr('Phones found: {count}', { count: devices.length }) : tr('No phones found. Open Connect PC on the phone and search again.');
    } catch (error) {
      const message = String(error.message || error);
      summary = message === 'Phone search needs UDP port 47834. Try again when the port is free.' ? tr(message) : tr('Phone search unavailable. You can still connect from the phone.');
    }
    if (!visible(panel)) return;
    const previous = select.value;
    select.replaceChildren(select.options[0], ...devices.map(phone => {
      const option = new Option(`${phone.name} · ${phone.address}`, phone.id);
      option.dataset.address = phone.address;
      option.dataset.name = phone.name;
      return option;
    }));
    select.value = previous;
    if (select.selectedIndex < 0) select.value = '';
    status.textContent = summary;
    refresh.disabled = false;
    select.disabled = !devices.length;
    invite.disabled = !select.value;
  }

  async function invitePhone(panel) {
    const select = panel.querySelector('#link-phone');
    const phone = select.selectedOptions[0];
    const refresh = panel.querySelector('[data-action="link-rescan-phones"]');
    if (!phone?.value || refresh.disabled) return;
    const invite = panel.querySelector('[data-action="link-invite"]');
    const status = panel.querySelector('#phone-search-status');
    invite.disabled = refresh.disabled = select.disabled = true;
    status.textContent = tr('Sending invitation…');
    try {
      await native.invoke('link_invite_phone', { id: phone.value, address: phone.dataset.address });
      if (visible(panel)) status.textContent = tr('Invitation sent to “{name}”. Confirm on the phone, then approve here.', { name: phone.dataset.name });
    } catch {
      if (visible(panel)) status.textContent = tr('The phone did not respond. Open Connect PC on the phone and search again.');
    } finally {
      if (visible(panel)) invite.disabled = refresh.disabled = select.disabled = false;
    }
  }

  function phonePresence() {
    return `<p id="phone-visibility" class="link-message" role="status"></p>
      <div id="phone-invitation" class="link-connected" hidden>
        <p role="status"></p>
        <div class="dialog-buttons">
          <button type="button" class="secondary-btn" data-action="link-dismiss-invite">${h(tr("Dismiss"))}</button>
          <button type="button" class="primary-btn" data-action="link-accept-invite" ${busy ? 'disabled' : ''}>${h(tr("Choose this PC"))}</button>
        </div>
      </div>`;
  }

  function acceptInvitation() {
    if (busy) return;
    const request = presence.takeInvitation();
    if (!request) return;
    if (state.paired && !choosing) { choosing = true; note = ''; render(); }
    const form = dialog.querySelector('#link-form');
    const select = form.elements.device;
    const invited = new Option(`${request.name} · ${request.address}`, request.address);
    invited.id = 'invited-pc';
    select.querySelector('#invited-pc')?.remove();
    for (const option of [...select.querySelectorAll('optgroup option')]) {
      if (option.value === request.address) option.remove();
    }
    select.add(invited, select.querySelector('optgroup'));
    select.value = request.address;
    select.dispatchEvent(new Event('change'));
    form.requestSubmit();
  }

  function render() {
    const message = `<p class="link-message link-feedback" role="status">${h(tr(note))}</p>`;
    if (!android) {
      openDialog(`${dialogTop(tr("Connect your phone"))}<p class="dialog-description">${h(tr("Open Settings → Devices on your phone and select this PC. Confirm on both devices."))}</p>
        ${state.running ? `${busy ? '' : phonePicker()}<div id="pc-pairing-requests"></div>
          <label class="dialog-field" for="pc-address">${h(tr("PC ADDRESS"))}</label><input class="dialog-input link-value" id="pc-address" readonly value="${h(state.addresses?.[0] || tr("No local Wi-Fi address found"))}">
          ${state.addresses?.length > 1 ? `<p class="dialog-description">${h(tr("Other address:"))} ${h(state.addresses.slice(1).join(', '))}</p>` : ''}
          <div class="dialog-buttons"><button class="secondary-btn" data-action="link-stop" ${busy ? 'disabled' : ''}>${h(tr("Turn connection off"))}</button></div>`
        : `<button class="primary-btn" data-action="link-start" ${busy ? 'disabled' : ''}>${busy ? tr("Starting…") : tr("Enable phone connection")}</button>`}
        ${state.running && state.firewall ? `<button class="secondary-btn" data-action="link-firewall">${h(tr("Allow phone through firewall"))}</button>` : ''}
        ${state.running && platform === 'windows' ? `<p class="dialog-description">${h(tr("If the phone cannot connect, allow Undertone’s Python runtime on private networks in Windows Firewall."))}</p>` : ''}
        ${state.pairedDevices ? `<button class="text-button" data-action="link-revoke">${h(tr("Forget paired phones"))}</button>` : ''}
        ${message}`, 'link');
      renderPairingRequests();
      const picker = dialog.querySelector('#phone-picker');
      if (picker && !busy) {
        picker.querySelector('select').addEventListener('change', event => {
          picker.querySelector('[data-action="link-invite"]').disabled = !event.target.value;
        });
        discoverPhones(picker);
      }
    } else {
      const pairingForm = !state.paired || choosing;
      const progress = busy && state.total ? `<progress class="link-progress" max="${state.total}" value="${state.done || 0}"></progress><p class="dialog-description">${h(tr('{done} / {total} audio files checked', { done: state.done || 0, total: state.total }))}</p>` : '';
      openDialog(`${dialogTop(tr("Connect to your PC"))}<p class="dialog-description">${h(tr("On your PC, open Settings → Devices and enable the connection. Keep both devices on the same Wi-Fi."))}</p>${phonePresence()}${pairingForm ? chooser() : pairedControls()}${message}${pairingForm ? '' : progress}`, 'link');
      presence.sync();
      if (pairingForm) {
        const form = dialog.querySelector('#link-form');
        const select = form.elements.device;
        select.addEventListener('change', () => {
          const manual = select.value === 'manual';
          form.querySelector('#link-manual').hidden = !manual;
          form.elements.address.disabled = !manual;
          if (manual) form.elements.address.focus();
        });
        discover(form);
      }
    }
  }
  function renderPairingRequests() {
    const box = dialog.querySelector('#pc-pairing-requests');
    if (!visible(box)) return;
    const requests = state.pairingRequests || [];
    const signature = JSON.stringify(requests);
    if (box.dataset.requests === signature) return;
    box.dataset.requests = signature;
    box.innerHTML = requests.map(request => `<div class="pair-request">
      <strong>${h(request.name)}</strong><small>${h(request.address)}</small>
      <div class="dialog-buttons">
        <button class="secondary-btn" data-action="link-confirm-pair" data-id="${h(request.id)}">${h(tr("Decline"))}</button>
        <button class="primary-btn" data-action="link-confirm-pair" data-id="${h(request.id)}" data-approved="true">${h(tr("Confirm on this PC"))}</button>
      </div></div>`).join('');
  }

  async function pollPairingRequests() {
    if (busy || !visible(dialog.querySelector('#pc-pairing-requests'))) return;
    try {
      state = await native.invoke('link_status');
      renderPairingRequests();
    } catch {}
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
    presence?.stop();
    choosing = false;
    note = '';
    openDialog(`${dialogTop(tr(android ? "Connect to your PC" : "Connect your phone"))}<p class="dialog-description" id="link-loading" role="status">${h(tr("Checking connection…"))}</p>`, 'link');
    const loading = dialog.querySelector('#link-loading');
    if (pairing) await pairing.catch(() => {});
    let nextState = {};
    try { nextState = await native.invoke('link_status'); }
    catch (error) { if (visible(loading)) note = String(error.message || error); }
    if (!visible(loading)) return;
    state = nextState;
    render();
    if (!android && !requestPolling) {
      requestPolling = setInterval(pollPairingRequests, 1000);
    }
  }
  const actions = {
    'device-link': show,
    'link-confirm-pair': async button => {
      const box = button.closest('#pc-pairing-requests');
      const approved = button.dataset.approved === 'true';
      button.disabled = true;
      try {
        await native.invoke('link_confirm_pair', { id: button.dataset.id, approved });
        await pollPairingRequests();
        if (visible(box)) dialog.querySelector('.link-feedback').textContent = tr(approved ? 'Pairing approved.' : 'Pairing declined.');
      } catch (error) {
        if (visible(box)) dialog.querySelector('.link-feedback').textContent = tr(String(error.message || error));
      } finally { button.disabled = false; }
    },
    'link-rescan-phones': button => discoverPhones(button.closest('#phone-picker')),
    'link-invite': button => invitePhone(button.closest('#phone-picker')),
    'link-accept-invite': acceptInvitation,
    'link-dismiss-invite': () => presence.takeInvitation(),
    'link-rescan': button => discover(button.form),
    'link-switch': () => { choosing = true; note = ''; render(); },
    'link-cancel-choice': () => { choosing = false; note = ''; render(); },
    'link-start': async () => { await prepare(); if (dialog.open && dialog.dataset.kind === 'link') await run('link_start'); },
    'link-stop': () => run('link_stop'),
    'link-forget': () => run('link_forget'),
    'link-revoke': () => run('link_revoke'),
    'link-firewall': async () => { const result = await run('link_firewall'); if (result !== null && dialog.open && dialog.dataset.kind === 'link') dialog.querySelector('.link-feedback').textContent = tr("Undertone is allowed on your local Wi-Fi network."); },
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
    const form = dialog.querySelector('#link-form');
    if (!form || busy || !form.reportValidity()) return;
    const { device, address } = form.elements;
    const target = device.value === 'manual' ? address.value.trim() : device.value;
    const submitButton = form.querySelector('[type="submit"]');
    const acceptButton = dialog.querySelector('[data-action="link-accept-invite"]');
    form.querySelector('fieldset').disabled = true;
    if (acceptButton) acceptButton.disabled = true;
    submitButton.textContent = tr("Waiting for the PC to confirm…");
    const message = dialog.querySelector('.link-feedback');
    message.textContent = tr("Confirm this phone in Settings → Devices on your PC.");
    busy = true;
    try {
      pairing = native.invoke('link_pair', { address: target, name: platform === 'ios' ? 'iPhone' : 'Android phone' });
      const result = await pairing;
      state = result;
      choosing = false;
      note = tr("Paired. Tap Copy from PC to bring your library over.");
    } catch (error) {
      if (visible(form)) message.textContent = tr(String(error.message || error));
      return;
    } finally {
      pairing = null;
      busy = false;
      form.querySelector('fieldset').disabled = false;
      if (acceptButton) acceptButton.disabled = false;
      submitButton.textContent = tr("Confirm on this phone");
    }
    if (visible(form)) render();
  }
  return { actions, submit, open: show };
}
