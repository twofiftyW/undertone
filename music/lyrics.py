"""LRCLIB lookup and persistent per-device lyrics for individual recordings."""
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
import unicodedata

import requests


ENDPOINT = 'https://lrclib.net/api/get'
SEARCH_ENDPOINT = 'https://lrclib.net/api/search'
USER_AGENT = 'Undertone-Lyrics/1.0 (https://github.com/twofiftyW/undertone)'
MAX_RESPONSE = 2 * 1024 * 1024
MAX_BRIDGE_BYTES = 256 * 1024
BUSY = 'LRCLIB is busy. Try again later.'
UNAVAILABLE = 'Couldn’t reach LRCLIB. Check your connection and try again.'
SYNC_RECHECK = 7 * 24 * 3600
RETRY_RECHECK = 3600
STAMP = r'\d{1,3}:[0-5]\d(?:[.:]\d{1,3})?'
LINE_STAMPS = re.compile(r'^(?:[ \t]*\[' + STAMP + r'\])+')
WORD_STAMP = re.compile('<' + STAMP + '>')
LRC_METADATA = re.compile(r'\[(?:ar|al|by|ti|offset|length|re|ve):[^\]]*\]', re.IGNORECASE)


def has_timing(source):
    if not isinstance(source, str):
        return False
    for line in source.lstrip('\ufeff').splitlines():
        timestamps = LINE_STAMPS.match(line)
        if timestamps:
            words = WORD_STAMP.sub('', line[timestamps.end():]).strip()
            if words and not LRC_METADATA.fullmatch(words):
                return True
    return False


def atomic_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, mode='w', encoding='utf-8', delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(value, stream, ensure_ascii=False)
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
    if result['syncedLyrics'] and not has_timing(result['syncedLyrics']):
        result['syncedLyrics'] = None
    # Android sends the normalized record back in one WebView bridge message.
    if len(json.dumps(result, ensure_ascii=False).encode('utf-8')) > MAX_BRIDGE_BYTES:
        raise ValueError('LRCLIB returned too much data for this recording.')
    return result if any(result.values()) else None


def read_cached(path):
    try:
        with path.open('rb') as stream:
            stored = json.loads(stream.read(MAX_RESPONSE + 1))
        return normalized(stored), float(stored.get('nextSyncCheck', 0))
    except (ValueError, TypeError, OSError):
        return None, 0


def lookup(args):
    key = args.get('key')
    if not isinstance(key, str) or not key:
        key = json.dumps([args.get(field) for field in ('artist', 'title', 'album', 'duration')])
    name = hashlib.sha256(key.encode('utf-8', errors='surrogatepass')).hexdigest()
    downloads = os.environ.get('UNDERTONE_DOWNLOAD_DIR')
    directory = Path(downloads).parent / 'lyrics' if downloads else None
    path = directory / (name + '.json') if directory else None
    # A concurrent plain lookup can never overwrite an upgraded timed copy.
    synced_path = directory / (name + '.synced.json') if directory else None
    cached, recheck = (None, 0)
    if path:
        cached, _ = read_cached(synced_path)
        if cached:
            return cached
        cached, recheck = read_cached(path)
    if cached:
        if cached['instrumental'] or cached['syncedLyrics'] or args.get('cacheOnly') is True or time.time() < recheck:
            return cached
        if args.get('refreshSync') is not True:
            # Display stored words immediately, even if the provider is unreachable.
            return {**cached, 'refreshSync': True}
    if args.get('cacheOnly') is True:
        return None

    try:
        result, checked = fetch(args, directory, cached)
    except ValueError:
        if not cached:
            raise
        result, checked = cached, False
    if result:
        if path:
            try:
                if result['syncedLyrics']:
                    atomic_write(synced_path, result)
                else:
                    atomic_write(path, {**result, 'nextSyncCheck': time.time() + (SYNC_RECHECK if checked else RETRY_RECHECK)})
                return result
            except OSError:
                saved, _ = read_cached(synced_path if result['syncedLyrics'] else path)
                if saved == result:
                    return result
        result['storageFailed'] = True
    return result


def folded(value):
    text = unicodedata.normalize('NFKC', value).casefold() if isinstance(value, str) else ''
    return re.sub(r'[\W_]+', ' ', text).strip()


FEATURE = re.compile(r'\s*[\[(](?:feat(?:uring)?\.?|ft\.?)\s+([^\])]+)[\])]\s*$', re.IGNORECASE)
CREDIT_SEPARATOR = re.compile(r'\s*(?:[,;&]|\bfeat(?:uring)?\.?\s+|\bft\.?\s+)\s*', re.IGNORECASE)


def credits(title, artist):
    feature = FEATURE.search(title)
    extra = feature.group(1) if feature else ''
    title = title[:feature.start()] if feature else title
    names = list(filter(None, map(folded, CREDIT_SEPARATOR.split(artist + ',' + extra))))
    return folded(title), names


def select_record(rows, params, plain, exact):
    if not isinstance(rows, list):
        raise ValueError('LRCLIB returned an unreadable response.')
    title, artists = credits(params['track_name'], params['artist_name'])
    duration = params.get('duration') or exact.get('duration')
    album = folded(params.get('album_name') or exact.get('albumName'))
    words = folded(plain.get('plainLyrics')) if plain else ''
    best = None
    best_rank = None
    for row in rows:
        if not isinstance(row, dict) or not isinstance(row.get('trackName'), str) or not isinstance(row.get('artistName'), str):
            continue
        if row.get('instrumental') is not False:
            continue
        candidate, names = credits(row['trackName'], row['artistName'])
        if candidate != title or not artists or not names or artists[0] != names[0]:
            continue
        candidate_words = folded(row.get('plainLyrics'))
        same_words = bool(words) and candidate_words == words
        if words and candidate_words and not same_words:
            original, alternative = set(words.split()), set(candidate_words.split())
            if len(original & alternative) < len(original | alternative) * .6:
                continue
        same_album = bool(album) and album == folded(row.get('albumName'))
        credited, candidate_credits = set(artists), set(names)
        same_artists = credited == candidate_credits
        # Do not substitute a cover, remix or a similarly named album result.
        if not same_artists and not (same_words and (credited <= candidate_credits or candidate_credits <= credited)):
            continue
        if album and not same_album and not same_words:
            continue
        seconds = row.get('duration')
        if isinstance(duration, (float, int)) and duration > 0:
            if not isinstance(seconds, (float, int)) or not duration - 2 <= seconds <= duration + 2:
                continue
            difference = abs(duration - seconds)
        elif same_album and same_artists:
            difference = 0
        else:
            continue
        try:
            record = normalized(row)
        except ValueError:
            continue
        if not record or (plain and not record['syncedLyrics']):
            continue
        rank = (bool(record['syncedLyrics']), same_words, same_album, same_artists, -difference)
        if best_rank is None or rank > best_rank:
            best_rank, best = rank, record
    return best


def fetch(args, directory, cached=None):
    params = {}
    for field, parameter in (('title', 'track_name'), ('artist', 'artist_name'), ('album', 'album_name')):
        value = args.get(field)
        if isinstance(value, str) and value.strip():
            params[parameter] = value.strip()[:300]
    if 'track_name' not in params or 'artist_name' not in params:
        return cached, False
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
    exact = {} if cached else request(ENDPOINT, params, retry_file, deadline)
    plain = cached or (normalized(exact) if exact is not None else None)
    if plain and (plain['instrumental'] or plain['syncedLyrics']):
        return plain, True
    # Look past a plain-only exact match, allowing a featured artist to be
    # credited in either the artist list or the title of another submission.
    search_title = FEATURE.sub('', params['track_name']).strip()
    search_artist = CREDIT_SEPARATOR.split(params['artist_name'], maxsplit=1)[0].strip()
    try:
        rows = request(SEARCH_ENDPOINT, {'track_name': search_title, 'artist_name': search_artist}, retry_file, deadline)
        match = select_record([] if rows is None else rows, params, plain, exact or {})
        return match or plain, True
    except ValueError:
        if not plain:
            raise
        return plain, False


def request(endpoint, params, retry_file, deadline):
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise ValueError(UNAVAILABLE)
    try:
        with requests.get(endpoint, params=params, headers={'User-Agent': USER_AGENT},
                          timeout=(min(4, remaining), min(10, remaining)), stream=True, allow_redirects=False) as response:
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
        return json.loads(content)
    except (UnicodeError, ValueError) as error:
        raise ValueError('LRCLIB returned an unreadable response.') from error
