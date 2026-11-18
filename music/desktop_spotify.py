"""Control a durable Spotify import from the desktop app or run its detached worker."""
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import threading

# The bundled Windows interpreter doesn't add the script directory to sys.path.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import spotify_job

COMMANDS = {'spotify_job_start', 'spotify_job_status', 'spotify_job_results', 'spotify_job_ack',
            'spotify_job_pause', 'spotify_job_resume'}


def lock_busy(error):
    # sqlite_errorcode was added in Python 3.11. The Linux build also uses the
    # system interpreter on distributions that ship Python 3.10.
    return getattr(error, 'sqlite_errorcode', None) in (5, 6) or str(error) == 'database is locked'


def worker_active(root):
    # The worker holds an exclusive transaction in a separate lock database.
    # SQLite releases it even on a crash, and journal reads/writes remain independent.
    path = root / 'spotify-worker.lock'
    if not path.exists():
        return False
    with closing(sqlite3.connect(path, timeout=0)) as lock:
        try:
            lock.execute('PRAGMA user_version').fetchone()
        except sqlite3.OperationalError as error:
            if lock_busy(error):
                return True
            raise
    return False


def acknowledge_startup():
    # Only the short startup handshake uses the parent connection. A controller
    # which closed before our acknowledgement must not stop a committed import.
    try:
        print('ready', flush=True)
    except BrokenPipeError:
        pass
    with open(os.devnull, 'w') as sink:
        os.dup2(sink.fileno(), sys.stdout.fileno())


def run_worker(root):
    starting = True
    while True:
        terminal = None
        with closing(sqlite3.connect(root / 'spotify-worker.lock', timeout=2)) as lock:
            try:
                lock.execute('BEGIN EXCLUSIVE')
            except sqlite3.OperationalError as error:
                if not lock_busy(error):
                    raise
                # A simultaneous start already owns this library.
                if starting:
                    acknowledge_startup()
                return
            if starting:
                acknowledge_startup()
                starting = False
            state = spotify_job.dispatch(root, 'spotify_job_status', {})
            while state['state'] == 'running':
                try:
                    state = spotify_job.step(root, state['jobId'])
                except Exception:
                    state = spotify_job.dispatch(root, 'spotify_job_pause',
                                                 {'jobId': state['jobId'], 'reason': 'error'})
                if state['state'] == 'done' or state['reason'] in ('offline', 'error'):
                    terminal = state
        # A new start may have seen our lock just as the previous batch finished.
        # Recheck after release so no new job can be left without a worker.
        latest = spotify_job.dispatch(root, 'spotify_job_status', {})
        if latest['state'] == 'running':
            continue
        if terminal and (terminal['jobId'], terminal['state']) == (latest['jobId'], latest['state']):
            try:
                from desktop_import_notification import notify_import
                notify_import(terminal)
            except Exception:
                # The journal is committed even when the desktop has no notification service.
                pass
        return


def start_worker(root):
    options = ({'creationflags': subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP}
               if os.name == 'nt' else {'start_new_session': True})
    child = subprocess.Popen([sys.executable, '-X', 'utf8', '-B', str(Path(__file__).resolve()),
                              str(root), '--worker'], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.DEVNULL, **options)
    threading.Thread(target=child.wait, daemon=True).start()
    with child.stdout as pipe:
        if pipe.readline().strip() != b'ready':
            raise ValueError('Could not start background matching. Open the import and retry.')


def command(root, message):
    operation = message['operation']
    args = message.get('args') or {}
    if operation not in COMMANDS or not isinstance(args, dict):
        raise ValueError('Unknown Spotify import command.')
    result = spotify_job.dispatch(root, operation, args)
    if operation in ('spotify_job_start', 'spotify_job_resume') and result['state'] == 'running':
        if not worker_active(root):
            start_worker(root)
        result = spotify_job.dispatch(root, 'spotify_job_status', {})
    if 'state' in result:
        result['serviceActive'] = worker_active(root)
    return result


def respond(root, payload):
    try:
        reply = {'data': command(root, json.loads(payload))}
    except Exception as error:
        reply = {'error': str(error) if isinstance(error, ValueError) else 'Could not access the Spotify import.'}
    print(json.dumps(reply, ensure_ascii=False, separators=(',', ':')), flush=True)


if __name__ == '__main__':
    root = Path(sys.argv[1]).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if sys.argv[2:] == ['--worker']:
        run_worker(root)
    elif sys.argv[2:] == ['--stdio']:
        for request in sys.stdin:
            respond(root, request)
    else:
        respond(root, sys.stdin.read())
