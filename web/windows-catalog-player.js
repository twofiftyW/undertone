import { BrowserPlayer } from './player.js';

const catalogTrack = /^https:\/\/tracks\.monochrome\.st\/track\/\d{17,20}$/;
const recordingId = /^\d{17,20}$/;

// WebView2 can report an interrupted HTTP response as an unsupported format,
// even before it has received enough of the file to identify the audio codec.
export class WindowsCatalogPlayer extends BrowserPlayer {
  constructor(element, getRecordingId) {
    super(element);
    this._getRecordingId = getRecordingId;
    this._session = null;
    this._failure = null;
  }

  get error() { return this._failure || super.error; }

  _cancelSession() {
    this._session?.controller.abort();
    this._session = null;
  }

  pause() {
    this._cancelSession();
    super.pause();
  }

  setSource(url, key) {
    this._cancelSession();
    this._failure = null;
    super.setSource(url, key);
  }

  takePreloaded(key) {
    if (!super.takePreloaded(key)) return false;
    this._cancelSession();
    this._failure = null;
    return true;
  }

  async play() {
    this._cancelSession();
    this._failure = null;
    if (!catalogTrack.test(this.src)) return super.play();
    const id = this._getRecordingId();
    const session = {
      controller: new AbortController(),
      retryURL: typeof id === 'string' && recordingId.test(id) ? new URL(id, this.src).href : this.src,
      retried: false
    };
    this._session = session;
    try {
      await this._start(session, 20000);
    } catch (error) {
      const mediaFailure = [2, 3, 4].includes(super.error?.code) ||
        ['NotSupportedError', 'NetworkError', 'EncodingError', 'TimeoutError'].includes(error?.name);
      if (!mediaFailure || error?.name === 'NotAllowedError' || error?.name === 'AbortError') throw error;
      await this._retry(session, error);
    }
  }

  async _start(session, timeout) {
    const { signal } = session.controller;
    signal.throwIfAborted();
    let timer;
    let onAbort;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new DOMException('Playback timed out', 'TimeoutError')), timeout);
      onAbort = () => reject(signal.reason);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try { await Promise.race([super.play(), deadline]); }
    finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    }
  }

  async _retry(session, error) {
    session.controller.signal.throwIfAborted();
    try {
      if (session.retried || globalThis.navigator?.onLine === false) throw error;
      session.retried = true;
      const position = this.currentTime;
      if (this.src !== session.retryURL) this._active.src = session.retryURL;
      this._active.load();
      // Before metadata arrives, currentTime sets the pending playback position.
      if (Number.isFinite(position) && position > 0) this.currentTime = position;
      await this._start(session, 45000);
    } catch (failure) {
      session.controller.signal.throwIfAborted();
      this._failure = failure;
      super.pause();
      throw failure;
    }
  }

  _emitMediaEvent(type) {
    const session = this._session;
    if (type !== 'error' || !session || super.error?.code === 1) {
      super._emitMediaEvent(type);
      return;
    }
    this._retry(session, super.error).catch(() => {
      if (this._session === session) super._emitMediaEvent('error');
    });
  }
}
