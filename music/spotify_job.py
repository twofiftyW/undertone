"""Durable Spotify matching queue, separate from the user's editable library."""
from contextlib import closing, contextmanager
import json
import sqlite3
import threading
import uuid

# Serialize steps in each worker without holding a transaction during a catalog lookup.
_workers = {'spotify': threading.Lock(), 'download': threading.Lock()}


@contextmanager
def database(root, *, write=False, kind='spotify'):
    with closing(sqlite3.connect(root / f'{kind}-job.sqlite3', timeout=15)) as db:
        db.row_factory = sqlite3.Row
        if not db.execute('PRAGMA user_version').fetchone()[0]:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS job (
                    id TEXT PRIMARY KEY, state TEXT, reason TEXT, language TEXT, playlist_id TEXT,
                    total INTEGER DEFAULT 0, checked INTEGER DEFAULT 0, acked INTEGER DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS item (
                    position INTEGER PRIMARY KEY, source_id TEXT UNIQUE, seed TEXT, failed INTEGER DEFAULT 0,
                    result_seq INTEGER UNIQUE, result TEXT
                );
                CREATE INDEX IF NOT EXISTS available ON item(failed, position) WHERE result_seq IS NULL;
                PRAGMA user_version = 1;
            ''')
        with db:
            db.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
            yield db


def status(db):
    job = db.execute('SELECT * FROM job').fetchone()
    if job is None:
        return dict(jobId='', state='idle', checked=0, total=0, pending=0, reason='', language='en', playlistId='')
    return dict(jobId=job['id'], state=job['state'], checked=job['checked'], total=job['total'],
                pending=job['checked'] - job['acked'], reason=job['reason'], language=job['language'],
                playlistId=job['playlist_id'])


def selected(root, playlist_id, retry_misses):
    path = root / 'library.json'
    if not path.is_file():
        return []
    with path.open('r', encoding='utf-8') as stream:
        library = json.load(stream)
    tracks = library['tracks']
    ids = tracks
    if playlist_id:
        playlist = next((p for p in library['playlists'] if p['id'] == playlist_id), None)
        if playlist is None:
            raise ValueError('The destination playlist no longer exists.')
        ids = dict.fromkeys(playlist['trackIds'])
    fresh, reviewed = [], []
    for ident in ids:
        track = tracks.get(ident)
        if not track or track.get('source') != 'unmatched' or not isinstance(track.get('importRecord'), dict):
            continue
        seed = (ident, track['importRecord'])
        if not track.get('spotifyMatchChecked'):
            fresh.append(seed)
        elif retry_misses:
            reviewed.append(seed)
    return fresh or reviewed


def download_entries(rows):
    import re
    if not isinstance(rows, list) or len(rows) > 20000:
        raise ValueError('Queue up to 20,000 downloads at a time.')
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError('Choose a supported song to download.')
        source, ident = row.get('source'), str(row.get('id') or '')
        if (source == 'monochrome' and re.fullmatch(r'\d{17,20}', ident)
                or source == 'youtube' and re.fullmatch(r'[A-Za-z0-9_-]{11}', ident)):
            yield f'{source}:{ident}', {'source': source, 'id': ident}
        else:
            raise ValueError('Choose a supported song to download.')


def start(root, args, kind='spotify'):
    playlist_id = args.get('playlistId') or ''
    language = 'ru' if args.get('language') == 'ru' else 'en'
    # Read the last atomically committed snapshot. Only the app edits the library.
    # UI serializes its saves and initiates a job only after its import is durable.
    seeds = (selected(root, playlist_id, args.get('retryMisses', False)) if kind == 'spotify'
             else list(download_entries(args.get('tracks', []))))
    with database(root, write=True, kind=kind) as db:
        current = status(db)
        if not seeds and current['state'] in ('idle', 'done'):
            return current
        if current['state'] == 'idle' or (current['state'] == 'done' and not current['pending']):
            db.execute('DELETE FROM item')
            db.execute('DELETE FROM job')
            db.execute('INSERT INTO job(id,state,reason,language,playlist_id) VALUES(?,?,?,?,?)',
                       (uuid.uuid4().hex, 'running', '', language, playlist_id))
        if kind == 'download' and seeds:
            db.executemany('DELETE FROM item WHERE source_id=? AND result_seq IS NOT NULL AND result IS NULL',
                           ((ident,) for ident, _ in seeds))
        before = db.total_changes
        db.executemany('INSERT OR IGNORE INTO item(source_id,seed) VALUES(?,?)',
                       ((ident, json.dumps(seed, ensure_ascii=False)) for ident, seed in seeds))
        added = db.total_changes - before
        if current['state'] == 'paused':
            db.execute('UPDATE item SET failed=0 WHERE result_seq IS NULL AND failed=1')
        if added or current['state'] == 'paused':
            # A job extended from another playlist now covers multiple targets.
            db.execute("""UPDATE job SET total=total+?, state='running', reason='', language=?,
                          playlist_id=CASE WHEN playlist_id=? THEN playlist_id ELSE '' END""",
                       (added, language, playlist_id))
        return status(db)


def step(root, job_id, kind='spotify'):
    if kind == 'download':
        from offline import DOWNLOAD_BATCH, download_batch
        limit = DOWNLOAD_BATCH
    else:
        from backend import dispatch
        limit = 4
    with _workers[kind]:
        with database(root, kind=kind) as db:
            current = status(db)
            if current['jobId'] != job_id or current['state'] != 'running':
                return current
            batch = db.execute('''SELECT position,seed FROM item WHERE failed=0 AND result_seq IS NULL
                                  ORDER BY position LIMIT ?''', (limit,)).fetchall()
        failure_reason = 'offline'
        if batch:
            try:
                seeds = [json.loads(row['seed']) for row in batch]
                matches = (download_batch(seeds) if kind == 'download' else dispatch('match', {
                    'tracks': seeds, 'includeCandidates': False
                })['matches'])
                if len(matches) != len(batch) or not all(isinstance(match, dict) for match in matches):
                    raise ValueError('Incomplete catalog response.')
            except Exception:
                # Unexpected engine errors also leave all source records available to retry.
                matches = [{'error': True}] * len(batch)
                failure_reason = 'error'
        else:
            matches = []

        with database(root, write=True, kind=kind) as db:
            current = status(db)
            if current['jobId'] != job_id:
                return current
            checked = current['checked']
            for row, match in zip(batch, matches):
                if match.get('error'):
                    db.execute('UPDATE item SET failed=1 WHERE position=?', (row['position'],))
                    continue
                checked += 1
                result = match if kind == 'download' else {'track': match.get('track'), 'reason': match.get('reason', '')}
                db.execute('UPDATE item SET result_seq=?,result=?,seed=NULL WHERE position=?',
                           (checked, json.dumps(result, ensure_ascii=False), row['position']))
            state, reason = current['state'], current['reason']
            if checked == current['total']:
                state, reason = 'done', ''
            elif state == 'running':
                available = db.execute('SELECT 1 FROM item WHERE failed=0 AND result_seq IS NULL LIMIT 1').fetchone()
                if not available or (batch and checked == current['checked']):
                    state, reason = 'paused', failure_reason
            db.execute('UPDATE job SET checked=?,state=?,reason=?', (checked, state, reason))
            return status(db)


def dispatch(root, operation, args):
    kind = 'download' if operation.startswith('download_job_') else 'spotify'
    operation = operation.replace('download_job_', 'spotify_job_', 1)
    if operation == 'spotify_job_start':
        return start(root, args, kind)
    if operation == 'spotify_job_step':
        return step(root, args.get('jobId'), kind)
    mutate = operation in ('spotify_job_pause', 'spotify_job_resume', 'spotify_job_ack')
    with database(root, write=mutate, kind=kind) as db:
        current = status(db)
        if operation == 'spotify_job_status':
            return current
        if current['jobId'] != args.get('jobId') or not current['jobId']:
            if operation == 'spotify_job_results':
                return {'jobId': current['jobId'], 'items': []}
            return current
        if operation == 'spotify_job_results':
            limit = min(32, max(1, int(args.get('limit', 32))))
            after = max(int(args.get('after', 0)), current['checked'] - current['pending'])
            rows = db.execute('''SELECT source_id,result_seq,result FROM item
                                 WHERE result_seq>? AND result IS NOT NULL ORDER BY result_seq LIMIT ?''',
                              (after, limit))
            return {'jobId': current['jobId'], 'items': [
                {'seq': row['result_seq'], 'id': row['source_id'], **json.loads(row['result'])} for row in rows
            ]}
        if operation == 'spotify_job_ack':
            through = int(args['through'])
            if not 0 <= through <= current['checked']:
                raise ValueError('Invalid Spotify job acknowledgement.')
            db.execute('UPDATE item SET result=NULL WHERE result_seq>? AND result_seq<=?',
                       (current['checked'] - current['pending'], through))
            db.execute('UPDATE job SET acked=MAX(acked,?)', (through,))
        elif operation == 'spotify_job_pause':
            if current['state'] == 'running':
                db.execute("UPDATE job SET state='paused', reason=?", (args.get('reason') or 'user',))
        elif operation == 'spotify_job_resume':
            if current['state'] == 'paused':
                db.execute('UPDATE item SET failed=0 WHERE result_seq IS NULL AND failed=1')
                db.execute("UPDATE job SET state='running',reason=''")
        else:
            raise ValueError('Unknown Spotify job operation.')
        return status(db)
