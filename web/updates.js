import { escapeHTML as h } from './core.js';
import { tr } from './i18n.js';

const skipPromptKey = 'undertone.update.skipPrompt';
const declinedKey = 'undertone.update.declinedVersion';
const checkInterval = 4 * 60 * 60 * 1000;

export function appUpdates({ native, dialog, openDialog, closeDialog, dialogTop, toast, flush }) {
  const badge = document.querySelector('#update-available');
  const invoke = (operation, value) => native.invoke('app_update', { operation, value });
  const label = (text, vars) => h(tr(text, vars));
  const errorMessage = error => tr(String(error?.message || error));
  const skipPrompt = () => localStorage.getItem(skipPromptKey) === 'true';
  let installed = {};
  let offer = null;
  let lastCheck = 0;
  let checking = null;
  let installing = false;
  let prompted = '';

  function renderOffer() {
    badge.classList.toggle('hidden', !offer);
    badge.disabled = installing;
  }

  function updatePrompt() {
    if (!offer || installing) return;
    prompted = offer.version;
    openDialog(`${dialogTop(tr("Update available"))}<p class="dialog-description">${label("Undertone {version} is ready to install.", { version: offer.version })}</p>
      <label class="update-choice"><input type="checkbox" id="update-skip" ${skipPrompt() ? 'checked disabled' : ''}> ${label("Do not show again")}</label>
      <div class="dialog-buttons"><button class="secondary-btn" data-action="update-later">${label("Later")}</button><button class="primary-btn" data-action="update-install">${label("Install update")}</button></div>`, 'update-offer');
  }

  function maybePrompt() {
    if (offer && !dialog.open && !document.hidden && !installing && !skipPrompt()
        && prompted !== offer.version && localStorage.getItem(declinedKey) !== offer.version) updatePrompt();
  }

  function settings(message = '') {
    openDialog(`${dialogTop(tr("Update settings"))}
      <p class="dialog-description">${installed.version ? label("Installed version {version}", installed) : ''}</p>
      <label class="update-choice"><input type="checkbox" id="update-skip-settings" ${skipPrompt() ? 'checked' : ''}> ${label("Do not show update prompts")}</label>
      <div class="update-access">
        <strong>${label("GitHub access")}</strong>
        <p class="dialog-description">${label("For the private repository, use a fine-grained token for twofiftyW/undertone with Contents read access.")}</p>
        <label for="update-token">${label("GitHub access token")}</label>
        <input id="update-token" type="password" autocomplete="off" spellcheck="false" maxlength="270" placeholder="${label(installed.configured ? "Access saved" : "Paste token")}">
        <div class="dialog-buttons"><button class="secondary-btn" data-action="update-save-access">${label("Save access")}</button>
        ${installed.configured ? `<button class="secondary-btn" data-action="update-remove-access">${label("Remove access")}</button>` : ''}</div>
      </div>
      <p class="dialog-description" id="update-settings-status" role="status">${h(message)}</p>
      <div class="dialog-buttons"><button class="secondary-btn" data-action="update-check-now">${label("Check for updates")}</button>
      ${offer ? `<button class="primary-btn" data-action="update-open">${label("Update available")}</button>` : ''}</div>`, 'update-settings');
  }

  async function check(manual = false) {
    if (checking || installing || (!manual && Date.now() - lastCheck < checkInterval)) return;
    lastCheck = Date.now();
    if (manual && dialog.dataset.kind === 'update-settings') {
      document.querySelector('#update-settings-status').textContent = tr("Checking for updates…");
    }
    try {
      checking = invoke('check');
      ({ update: offer } = await checking);
      renderOffer();
      if (dialog.open && dialog.dataset.kind === 'update-settings') {
        if (manual) settings(offer ? tr("Update available") : tr("You’re up to date."));
      } else maybePrompt();
    } catch (error) {
      if (manual && dialog.open && dialog.dataset.kind === 'update-settings') settings(errorMessage(error));
    } finally {
      checking = null;
    }
  }

  async function updateAccess(value) {
    try {
      if (checking) await checking.catch(() => {});
      installed = await invoke('token', value);
      offer = null;
      renderOffer();
      if (dialog.open && dialog.dataset.kind === 'update-settings') {
        settings(installed.configured ? tr("Access saved") : tr("GitHub access removed."));
      }
      if (installed.configured) await check(true);
    } catch (error) {
      if (dialog.open && dialog.dataset.kind === 'update-settings') settings(errorMessage(error));
    }
  }

  function rememberPromptChoice() {
    localStorage.setItem(skipPromptKey, String(document.querySelector('#update-skip').checked));
  }

  return {
    async start() {
      dialog.addEventListener('close', maybePrompt);
      dialog.addEventListener('change', event => {
        if (event.target.id !== 'update-skip-settings') return;
        localStorage.setItem(skipPromptKey, String(event.target.checked));
        if (!event.target.checked) {
          localStorage.removeItem(declinedKey);
          prompted = '';
        }
      });
      try {
        installed = await invoke('status');
        if (installed.result === 'failed') toast(tr("Undertone couldn’t install the update. Try again."), 7000);
        if (installed.result === 'restore') toast(tr("The update was interrupted. Its backup is in the Undertone install folder."), 8500);
      } catch {}
      await check();
      window.addEventListener('focus', () => { check(); maybePrompt(); });
      document.addEventListener('visibilitychange', () => { if (!document.hidden) { check(); maybePrompt(); } });
      setInterval(() => { if (!document.hidden) check(); }, checkInterval);
    },
    get version() { return installed.version; },
    actions: {
      'update-settings': () => settings(),
      'update-check-now': () => check(true),
      'update-save-access': () => updateAccess(document.querySelector('#update-token').value),
      'update-remove-access': () => updateAccess(''),
      'update-open': updatePrompt,
      'update-later': () => {
        rememberPromptChoice();
        localStorage.setItem(declinedKey, offer.version);
        closeDialog();
      },
      'update-install': async () => {
        if (installing || !offer) return;
        rememberPromptChoice();
        installing = true;
        renderOffer();
        openDialog(`${dialogTop(tr("Installing update"))}<p class="dialog-description" role="status">${label("Downloading and installing Undertone {version}…", { version: offer.version })}</p>`, 'update-installing');
        try {
          await flush();
          await invoke('install', offer.version);
        } catch (error) {
          toast(errorMessage(error), 7500);
          if (dialog.dataset.kind === 'update-installing') closeDialog();
        } finally {
          installing = false;
          renderOffer();
        }
      },
    },
  };
}
