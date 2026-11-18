// The native worker owns matching while the UI is closed. Only the library's current
// owner applies results, so an import cannot overwrite edits made in the UI.
export function spotifyJobClient({ request, apply, save, update, onError, visible }) {
  let state = { state: 'idle' };
  let chain = Promise.resolve();
  let timer;
  let lastError = '';

  function queue(action) {
    const result = chain.then(action);
    chain = result.catch(() => {});
    return result;
  }

  function publish(next) {
    state = next;
    update(state);
  }

  function schedule(delay) {
    clearTimeout(timer);
    if (visible()) timer = setTimeout(refresh, delay);
  }

  async function sync() {
    const status = await request('spotify_job_status', {});
    publish(status);
    if (status.pending > 0) {
      let after = 0;
      const results = [];
      while (results.length < Math.min(status.pending, 256)) {
        const page = await request('spotify_job_results', { jobId: status.jobId, after, limit: 32 });
        if (page.jobId !== status.jobId || !page.items.length) break;
        const last = page.items[page.items.length - 1].seq;
        if (last <= after) throw new Error('Could not read the next import results.');
        results.push(...page.items);
        after = last;
      }
      if (results.length) {
        apply(results);
        // If the activity dies before acknowledgement, replaying the same IDs
        // safely skips tracks already replaced or manually removed.
        await save();
        await request('spotify_job_ack', { jobId: status.jobId, through: after });
        publish(await request('spotify_job_status', {}));
      }
    }
    lastError = '';
    if (state.pending > 0 || state.serviceActive || (state.state === 'running' && state.serviceActive !== false)) {
      schedule(state.pending > 0 ? 120 : 1300);
    }
  }

  function refresh() {
    clearTimeout(timer);
    if (!visible()) return Promise.resolve();
    return queue(sync).catch(error => {
      const message = String(error.message || error);
      if (message !== lastError) onError(error);
      lastError = message;
      schedule(5000);
    });
  }

  function command(name, args) {
    clearTimeout(timer);
    return queue(async () => {
      publish(await request('spotify_job_' + name, args));
    }).finally(() => schedule(0));
  }

  return { refresh, command, withLibrary: queue, get state() { return state; } };
}
