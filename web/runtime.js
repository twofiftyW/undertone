const device = window.UndertoneDevice;
const pending = new Map();
window.__undertoneReply = (id, reply) => {
  const task = pending.get(id);
  if (!task) return;
  pending.delete(id);
  clearTimeout(task.timer);
  if (reply.error) task.reject(new Error(reply.error));
  else task.resolve(reply.data);
};

function bridgeRequest(send, timeout = 240000) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('This request took too long. Check your connection and retry.')); }, timeout);
    pending.set(id, { resolve, reject, timer });
    try { send(id); } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function request(operation, args = {}) {
  const timeout = operation === 'link_pull' ? 24 * 60 * 60 * 1000 : operation === 'download_track' ? 620000 : 240000;
  return bridgeRequest(id => device.request(id, operation, JSON.stringify(args)), timeout);
}

function call(method, ...args) {
  const result = JSON.parse(device[method](...args));
  if (result.error) throw new Error(result.error);
  return result.data;
}

async function invoke(command, args, options) {
  if (command === 'get_app_icon') return call('getAppIcon');
  if (command === 'set_app_icon') return call('setAppIcon', args.id);
  if (command === "load_library") return call("loadLibrary");
  if (command === "save_library") {
    const json = typeof args.library === 'string' ? args.library : JSON.stringify(args.library);
    return bridgeRequest(id => device.saveLibraryAsync(id, json));
  }
  if (command === "has_audio") return call("hasAudio", args.id, args.bytes);
  if (command === "delete_audio") return call("deleteAudio", args.id);
  if (command === "platform") return "android";
  if (command === 'spotify_help') return call('spotifyHelp');
  if (['music', 'list_downloads', 'offline_file', 'download_track', 'remove_download', 'link_status', 'link_discover', 'link_phone_start', 'link_phone_status', 'link_phone_stop', 'link_pair', 'link_forget', 'link_pull'].includes(command)) return request(command, args);
  if (command === 'parse_spotify') {
    const file = args instanceof Blob ? args : new Blob([args]);
    const token = call('beginImport');
    try {
      for (let start = 0; start < file.size; start += 262144) {
        const bytes = new Uint8Array(await file.slice(start, start + 262144).arrayBuffer());
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          call('appendImport', token, btoa(String.fromCharCode(...bytes.subarray(offset, offset + 32768))));
        }
      }
      const parsed = await request('parse_spotify', { token, filename: options.headers['x-import-name'] });
      for (const collection of parsed.collections) {
        const { firstPage, pageCount } = collection;
        delete collection.firstPage;
        delete collection.pageCount;
        collection.tracks = [];
        for (let i = 0; i < pageCount; i++) {
          collection.tracks.push(...JSON.parse(device.importPage(token, firstPage + i)));
          if (i % 8 === 7) await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
      return parsed;
    } finally {
      call('endImport', token);
    }
  }
  if (command === "save_audio") {
    const id = options.headers["x-audio-id"];
    call("beginAudio", id);
    // Small bridge messages avoid Android's IPC and JavaScript argument limits.
    for (let offset = 0; offset < args.length; offset += 32768) {
      call("appendAudio", id, btoa(String.fromCharCode(...args.subarray(offset, offset + 32768))));
      if (offset % 262144 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return call("finishAudio", id);
  }
  throw new Error("Unknown native command");
}

export const nativeRuntime = window.__TAURI__?.core || (device ? { invoke, convertFileSrc: (path) => call("audioURL", path) } : null);

export async function parseSpotifyFile(file) {
  const content = device ? file : new Uint8Array(await file.arrayBuffer());
  return nativeRuntime.invoke('parse_spotify', content, { headers: { 'x-import-name': encodeURIComponent(file.name) } });
}

export async function musicRequest(operation, args = {}) {
  if (window.__TAURI__?.core) return window.__TAURI__.core.invoke("music", { operation, args });
  if (device) return request('music', { operation, args });
  const response = await fetch("/api/music", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operation, args }) });
  const reply = await response.json();
  if (!response.ok || reply.error) throw new Error(reply.error || "The music engine is unavailable");
  return reply.data;
}
