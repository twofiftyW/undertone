const PRELOAD_WINDOW_SECONDS = 20;

export function isStreamingAudio(source) {
  try {
    const url = new URL(source);
    return url.protocol === 'https:' && url.hostname !== 'asset.localhost';
  } catch { return false; }
}

export function inPreloadWindow(audio) {
  const remaining = audio.duration - audio.currentTime;
  return !audio.paused && remaining > 0 && remaining <= PRELOAD_WINDOW_SECONDS;
}

const mediaEvents = ['play', 'pause', 'loadedmetadata', 'timeupdate', 'ended', 'error'];

// Windows uses the WebView's media engine. Keep the element that owns the buffer.
export class BrowserPlayer extends EventTarget {
  constructor(element, createAudio = () => new Audio()) {
    super();
    this._active = element;
    this._createAudio = createAudio;
    this._next = null;
    this.entry = '';
    this._started = false;
    this._forward = event => {
      if (event.type === 'error') {
        // A failure to start already rejects play(). Events report failures after startup.
        if (!this._started || !this._active.error) return;
        this._started = false;
      }
      this._emitMediaEvent(event.type);
    };
    for (const name of mediaEvents) element.addEventListener(name, this._forward);
  }

  _emitMediaEvent(type) { this.dispatchEvent(new Event(type)); }

  get src() { return this._active.src; }
  get duration() { return this._active.duration; }
  get paused() { return this._active.paused; }
  get error() { return this._active.error; }
  get currentTime() { return this._active.currentTime; }
  set currentTime(value) { this._active.currentTime = value; }
  get volume() { return this._active.volume; }
  set volume(value) { this._active.volume = value; }
  get muted() { return this._active.muted; }
  set muted(value) { this._active.muted = value; }
  load() { this._active.load(); }
  async play() {
    const element = this._active;
    const entry = this.entry;
    this._started = false;
    await element.play();
    if (this._active === element && this.entry === entry && !element.error) this._started = true;
  }
  pause() { this._active.pause(); }

  removeAttribute(name) {
    this._active.removeAttribute(name);
    if (name === 'src') { this.entry = ''; this._started = false; }
  }

  setSource(url, key) {
    this._started = false;
    this.entry = key;
    this._active.src = url;
  }

  _release(element) {
    element.pause();
    element.removeAttribute('src');
    element.load();
  }

  async prepareNext(next) {
    if (this._next) this._release(this._next.element);
    this._next = null;
    if (!next) return;
    const element = this._createAudio();
    element.preload = 'auto';
    element.src = next.url;
    element.load();
    this._next = { key: next.key, element };
  }

  takePreloaded(key) {
    const next = this._next;
    if (next?.key !== key || next.element.error) return false;
    const previous = this._active;
    for (const name of mediaEvents) previous.removeEventListener(name, this._forward);
    this._release(previous);
    this._next = null;
    this._active = next.element;
    this._started = false;
    this.entry = key;
    this.volume = previous.volume;
    this.muted = previous.muted;
    // This element may still be loading. Calling load() or setting src here would discard its buffer.
    for (const name of mediaEvents) next.element.addEventListener(name, this._forward);
    return true;
  }
}

// Linux uses mpv for audio; the bundled interface keeps the same player controls.
export class LinuxPlayer extends EventTarget {
  constructor(native) {
    super();
    this.native = native;
    this.src = "";
    this.duration = 0;
    this.paused = true;
    this.error = null;
    this._position = 0;
    this._volume = 0.8;
    this._muted = false;
    this._version = 0;
    this._intent = 0;
    this._loaded = "";
    this._ended = false;
    this._chain = Promise.resolve();
    this._polling = false;
    this.entry = '';
    this._serial = 0;
    this._next = null;
    this._prepareRequest = 0;
    this._sources = new Map();
    this._timer = setInterval(() => this._poll(), 150);
  }

  _send(operation, args = {}) {
    const call = this._chain.then(() => this.native.invoke("playback", { operation, args }));
    this._chain = call.catch(() => {});
    return call;
  }

  _control(operation, args) {
    const version = this._version;
    this._send(operation, args).catch(error => this._fail(error, version));
  }

  _fail(error, version = this._version) {
    if (version !== this._version) return;
    const message = String(error?.message || error || "The Linux audio player could not play this recording.");
    if (this.error?.message === message) return;
    this.error = { message };
    this.paused = true;
    this.dispatchEvent(new Event("error"));
  }

  _apply(state) {
    if (state.token !== this._version || !this._loaded) return;
    const changed = Number.isInteger(state.serial) && state.serial !== this._serial;
    if (changed) {
      this._serial = state.serial;
      this.entry = state.key;
      this.src = this._sources.get(state.key) || this.src;
      this._loaded = this.src;
      this._next = null;
      this._ended = false;
      this.duration = 0;
      this.dispatchEvent(Object.assign(new Event('trackchange'), { key: state.key }));
    }
    this._position = Number(state.position) || 0;
    this.outputVolume = state.outputVolume;
    this.outputMuted = state.outputMuted;
    if (state.duration > 0 && this.duration !== state.duration) {
      this.duration = state.duration;
      this.dispatchEvent(new Event("loadedmetadata"));
    }
    if (state.error) { this._fail(state.error); return; }
    const paused = !!state.paused || !state.ready || !!state.ended && !changed;
    if (paused !== this.paused) {
      this.paused = paused;
      this.dispatchEvent(new Event(paused ? "pause" : "play"));
    }
    this.dispatchEvent(new Event("timeupdate"));
    if (state.ended && !changed && !this._ended) {
      this._ended = true;
      this.dispatchEvent(new Event("ended"));
    }
  }

  async _poll() {
    if (!this._loaded || this._polling || this.error) return;
    const version = this._version;
    this._polling = true;
    try { this._apply(await this._send("state")); }
    catch (error) { this._fail(error, version); }
    finally { this._polling = false; }
  }

  load() {
    ++this._intent;
    ++this._version;
    this._loaded = "";
    this._ended = false;
    this.duration = this._position = 0;
    this.error = null;
    this.paused = true;
    this.entry = ''; this._serial = 0; this._next = null; this._sources.clear();
    this._control("stop", { token: this._version });
    this.dispatchEvent(new Event("pause"));
  }

  removeAttribute(name) { if (name === "src") this.src = ""; }

  setSource(url, key) {
    ++this._intent; ++this._version;
    this.src = url; this.entry = key; this._serial = 0;
    this._loaded = ''; this._ended = false; this._next = null;
    this.duration = this._position = 0; this.error = null;
    this._sources.clear(); this._sources.set(key, url);
  }

  async prepareNext(next) {
    if (!this._loaded) return;
    if (next && (typeof next.url !== 'string' || !next.url)) throw new Error('The next audio file is missing.');
    const request = ++this._prepareRequest;
    const args = { token: this._version, fromKey: this.entry, serial: this._serial, ...(next || {}) };
    this._next = null;
    if (next) {
      this._sources.set(next.key, next.url);
      if (this._sources.size > 4) this._sources.delete(this._sources.keys().next().value);
    }
    const state = await this._send('prepare', args);
    this._apply(state);
    if (request === this._prepareRequest && args.token === this._version && state.token === args.token &&
        state.key === args.fromKey && state.serial === args.serial) this._next = next;
  }

  async advance(key) {
    if (this._next?.key !== key) return false;
    const version = this._version;
    try {
      const state = await this._send('next', { key });
      if (version !== this._version || state.token !== version) return false;
      this._apply(state);
      return true;
    } catch {
      // The caller can still open the selected track through a fresh load.
      return false;
    }
  }

  async play() {
    if (!this.src) throw new Error("Choose a recording before pressing Play.");
    const intent = ++this._intent;
    const version = this._version;
    this.error = null;
    try {
    if (this._loaded !== this.src || this._ended) {
      this._loaded = this.src;
      this._ended = false;
      this._apply(await this._send("load", { url: this.src, key: this.entry, token: version, volume: this._volume, muted: this._muted }));
    } else this._apply(await this._send("pause", { paused: false }));
    const deadline = Date.now() + 30000;
    while (intent === this._intent && version === this._version) {
      const state = await this._send("state");
      this._apply(state);
      if (this.error) throw new Error(this.error.message);
      if (state.token === version && state.ready && !state.paused && !state.buffering) return;
      if (Date.now() > deadline) throw new Error("The recording took too long to start. Try another result.");
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    } catch (error) {
      if (intent === this._intent && version === this._version) {
        this._loaded = "";
        this._fail(error);
        this._send("stop", { token: version }).catch(() => {});
      }
      throw error;
    }
  }

  pause() {
    ++this._intent;
    this.paused = true;
    if (this._loaded) this._control("pause", { paused: true });
    this.dispatchEvent(new Event("pause"));
  }

  get currentTime() { return this._position; }
  set currentTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0 || !this._loaded) return;
    this._position = seconds;
    this._control("seek", { seconds });
  }
  get volume() { return this._volume; }
  set volume(value) {
    this._volume = Math.max(0, Math.min(1, Number(value) || 0));
    this._setVolume();
  }
  get muted() { return this._muted; }
  set muted(value) { this._muted = !!value; this._setVolume(); }
  _setVolume() {
    if (this._loaded) this._control("volume", { volume: this._volume, muted: this._muted });
  }
  async restoreOutput() {
    this._apply(await this._send("restore_output"));
    this.muted = false;
    if (this.volume === 0) this.volume = 0.5;
  }
  dispose() { clearInterval(this._timer); this._timer = null; }
}
