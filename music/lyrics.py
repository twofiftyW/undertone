"""LRCLIB lookup and persistent per-device lyrics for individual recordings."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import time

import requests


ENDPOINT = 'https://lrclib.net/api/get'
USER_AGENT = 'Undertone-Lyrics/1.0 (https://github.com/twofiftyW/undertone)'
MAX_RESPONSE = 2 * 1024 * 1024
MAX_BRIDGE_BYTES = 256 * 1024
BUSY = 'LRCLIB is busy. Try again later.'
UNAVAILABLE = 'Couldn’t reach LRCLIB. Check your connection and try again.'


def atomic_write(path, value, *, recording=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, mode='w', encoding='utf-8', delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False)
        if recording:
            # On Windows rename leaves an existing recording intact, including
            # when another caller already has it open for offline playback.
            try:
                temporary.rename(path)
                return
            except FileExistsError:
                if read_cached(path):
                    return
        temporary.replace(path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def normalized(record):
    if not isinstance(record, dict) or not isinstance(record.get('instrumental'), bool):
        raise ValueError('LRCLIB returned an unreadable response.')
    result = {'instrumental': record['instrumental']}
    for field in ('syncedLyrics', 'plainLyrics'):
        value = record.get(field)
        text = value.strip() if isinstance(value, str) else ''
        result[field] = text or None
    # Android sends the normalized record back in one WebView bridge message.
    if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > MAX_BRIDGE_BYTES:
        raise ValueError('LRCLIB returned too much data for this recording.')
    return result if any(result.values()) else None


def read_cached(path):
    try:
        with path.open('rb') as stream:
            return normalized(json.loads(stream.read(MAX_RESPONSE + 1)))
    except (ValueError, OSError):
        return None


def lookup(args):
    key = args.get('key')
    if not isinstance(key, str) or not key:
        key = json.dumps([args.get(field) for field in ('artist', 'title', 'album', 'duration')])
    name = hashlib.sha256(key.encode('utf-8', errors='surrogatepass')).hexdigest()
    downloads = os.environ.get('UNDERTONE_DOWNLOAD_DIR')
    directory = Path(downloads).parent / 'lyrics' if downloads else None
    path = directory / (name + '.json') if directory else None
    cached = read_cached(path) if path else None
    if cached:
        return cached
    if args.get('cacheOnly') is True:
        return None

    result = fetch(args, directory)
    if result:
        if path:
            try:
                atomic_write(path, result, recording=True)
                return result
            except OSError:
                # On Windows another reader can hold the winning writer's file open.
                cached = read_cached(path)
                if cached:
                    return cached
        result['storageFailed'] = True
    return result


def fetch(args, directory):
    params = {}
    for field, parameter in (('title', 'track_name'), ('artist', 'artist_name'), ('album', 'album_name')):
        value = args.get(field)
        if isinstance(value, str) and value.strip():
            params[parameter] = value.strip()[:300]
    if 'track_name' not in params or 'artist_name' not in params:
        return None
    duration = args.get('duration')
    if isinstance(duration, (float, int)) and 1 <= duration <= 3600:
        params['duration'] = round(duration)

    # Desktop starts a new engine process for each request, so keep the
    # provider's Retry-After deadline across requests and app restarts.
    retry_file = directory / 'retry-after' if directory else None
    retry_at = 0
    if retry_file:
        try:
            retry_at = float(retry_file.read_text('ascii'))
        except (OSError, ValueError):
            pass
    if time.time() < retry_at:
        raise ValueError(BUSY)

    deadline = time.monotonic() + 20
    try:
        with requests.get(ENDPOINT, params=params, headers={'User-Agent': USER_AGENT},
                          timeout=(4, 10), stream=True, allow_redirects=False) as response:
            if response.status_code == 404:
                return None
            if response.status_code in (429, 503):
                delay = response.headers.get('Retry-After', '')
                seconds = int(delay) if delay.isascii() and delay.isdecimal() and len(delay) <= 8 else 60
                if retry_file:
                    try:
                        atomic_write(retry_file, time.time() + seconds)
                    except OSError:
                        pass
                raise ValueError(BUSY)
            if response.status_code != 200:
                raise ValueError(UNAVAILABLE)
            content = bytearray()
            for chunk in response.iter_content(32768):
                if time.monotonic() > deadline:
                    raise ValueError(UNAVAILABLE)
                content.extend(chunk)
                if len(content) > MAX_RESPONSE:
                    raise ValueError('LRCLIB returned too much data for this recording.')
    except requests.RequestException as error:
        raise ValueError(UNAVAILABLE) from error

    try:
        record = json.loads(content)
    except (UnicodeError, ValueError) as error:
        raise ValueError('LRCLIB returned an unreadable response.') from error
    return normalized(record)
