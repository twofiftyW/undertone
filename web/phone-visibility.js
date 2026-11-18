import { tr } from './i18n.js';

export function phoneVisibility(native, dialog) {
  let current = null;
  let commands = Promise.resolve();
  let timer;
  let invitationExpiry;
  let pageHidden = false;
  let retryPending = false;

  // Android handles bridge requests on multiple workers. Keep the final stop after
  // any start or renewal that has already left the WebView.
  function send(command, session) {
    const result = commands.then(() => native.invoke(command, { session }));
    commands = result.catch(() => {});
    return result;
  }

  function updateText(element, value) {
    if (element.textContent !== value) element.textContent = value;
  }

  function paint() {
    const visibility = dialog.querySelector('#phone-visibility');
    if (!visibility || !current) return;
    let message = tr('Making your phone visible…');
    if (current.name) message = tr('PCs can find this phone as “{name}” while this dialog is open.', { name: current.name });
    if (current.unavailable) message = tr('Your phone is not visible to PCs. You can still choose a PC on this phone.');
    updateText(visibility, message);

    const panel = dialog.querySelector('#phone-invitation');
    clearTimeout(invitationExpiry);
    const now = Date.now();
    current.invitations = current.invitations.filter(item => item.expires > now);
    const request = current.invitations[0];
    panel.hidden = !request;
    if (request) {
      updateText(panel.querySelector('p'), tr('“{name}” ({address}) invites you to connect.', request));
      invitationExpiry = setTimeout(paint, request.expires - now);
    }
  }

  function stop() {
    clearTimeout(timer);
    clearTimeout(invitationExpiry);
    retryPending = false;
    if (!current) return;
    const previous = current;
    current = null;
    send('link_phone_stop', previous.session).catch(() => {});
  }

  function shouldListen() {
    return !pageHidden && !document.hidden && dialog.open && dialog.dataset.kind === 'link' && dialog.querySelector('#phone-visibility');
  }

  async function listen(lease, start) {
    try {
      const result = await send(start ? 'link_phone_start' : 'link_phone_status', lease.session);
      if (lease !== current || !shouldListen()) return;
      if (result.active === false) {
        lease.unavailable = true;
        paint();
        stop();
        retryPending = true;
        timer = setTimeout(() => { retryPending = false; sync(); }, 1500);
        return;
      }
      if (result.name) lease.name = result.name;
      const request = result.invitation;
      if (request && !lease.invitations.some(item => item.address === request.address) && lease.invitations.length < 8) {
        lease.invitations.push({ ...request, expires: Date.now() + 30_000 });
      }
      lease.unavailable = false;
      paint();
      timer = setTimeout(() => listen(lease, false), 1500);
    } catch {
      if (lease !== current || !shouldListen()) return;
      lease.unavailable = true;
      paint();
      timer = setTimeout(() => { stop(); sync(); }, 6000);
    }
  }

  function sync() {
    if (!shouldListen()) { stop(); return; }
    if (retryPending) return;
    if (!current) {
      current = { session: crypto.randomUUID(), name: '', invitations: [], unavailable: false };
      listen(current, true);
    }
    paint();
  }

  function takeInvitation() {
    if (!shouldListen()) return null;
    const request = current?.invitations.shift();
    paint();
    return request?.expires > Date.now() ? request : null;
  }

  // Closing via Android Back or clicking outside the dialog bypasses the close button.
  const observer = new MutationObserver(sync);
  observer.observe(dialog, { attributes: true, attributeFilter: ['open', 'data-kind'] });
  dialog.addEventListener('close', sync);
  document.addEventListener('visibilitychange', sync);
  window.addEventListener('pagehide', () => { pageHidden = true; stop(); });
  window.addEventListener('pageshow', () => { pageHidden = false; sync(); });
  return { sync, stop, takeInvitation };
}
