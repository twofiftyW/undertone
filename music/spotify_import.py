"""Read Spotify account exports and playlist CSVs locally; never extract ZIP files."""
from __future__ import annotations
import csv
import io
import json
import math
from pathlib import Path
import re
import zipfile

MAX_FILE = 32 * 1024 * 1024
MAX_EXPANDED = 100 * 1024 * 1024
MAX_TRACKS = 20000


def key(value):
    return re.sub(r'[^a-z0-9]', '', str(value).casefold())


def recording(raw):
    if not isinstance(raw, dict):
        return None
    meta = raw.get('track') if isinstance(raw.get('track'), dict) else raw.get('localTrack') if isinstance(raw.get('localTrack'), dict) else raw
    return recording_fields({key(k): v for k, v in meta.items()})


def recording_fields(fields):
    title = fields.get('trackname') or fields.get('title') or fields.get('name') or (fields.get('track') if isinstance(fields.get('track'), str) else '')
    credits = fields.get('artists') or fields.get('artistnames') or fields.get('artistname') or fields.get('artist') or fields.get('subtitle') or ''
    if isinstance(credits, list):
        credits = ', '.join(str(a.get('name') or a.get('displayName') or '') if isinstance(a, dict) else str(a) for a in credits)
    if isinstance(credits, dict):
        credits = credits.get('name') or ''
    album = fields.get('albumname') or fields.get('album') or ''
    if isinstance(album, dict):
        album = album.get('name') or album.get('title') or ''
    if not isinstance(title, str) or not title.strip() or not str(credits).strip():
        return None
    uri = str(fields.get('trackuri') or fields.get('spotifyuri') or fields.get('uri') or fields.get('trackurl') or '')
    match = re.search(r'(?:spotify:track:|open\.spotify\.com/track/)([A-Za-z0-9]{22})(?:\b|$)', uri)
    uri = 'spotify:track:' + match.group(1) if match else ''
    milliseconds = fields.get('durationms') or fields.get('trackdurationms')
    try:
        duration = float(milliseconds) / 1000 if milliseconds is not None else float(fields.get('duration') or 0)
        if milliseconds is None and duration > 10000:
            duration /= 1000
    except (TypeError, ValueError):
        duration = 0
    if not math.isfinite(duration):
        duration = 0
    external = fields.get('externalids') if isinstance(fields.get('externalids'), dict) else {}
    isrc = str(fields.get('isrc') or external.get('isrc') or '')
    return {'title': title.strip()[:500], 'artist': str(credits).strip()[:500], 'album': str(album).strip()[:500], 'uri': uri, 'duration': max(0, round(duration)), 'isrc': isrc[:30]}


def collection(name, rows, kind='playlist', *, remaining=MAX_TRACKS, **extras):
    if isinstance(rows, dict):
        rows = rows.get('items') or rows.get('tracks') or []
    parse_row = recording
    if isinstance(rows, csv.DictReader):
        rows.fieldnames = [key(name) for name in rows.fieldnames or []]
        parse_row = recording_fields
    elif not isinstance(rows, list):
        return None
    tracks = []
    ignored = 0
    for row in rows:
        song = parse_row(row)
        if song is None:
            ignored += 1
            continue
        if len(tracks) >= remaining:
            raise ValueError('Import up to 20,000 songs at a time. Split this export into smaller files.')
        tracks.append(song)
    if not tracks:
        return None
    return {'name': str(name or 'Spotify playlist')[:160], 'kind': kind, 'tracks': tracks, 'ignored': ignored, **extras}


def parse_file(stream, filename, remaining):
    label = Path(filename).stem
    inferred_kind = 'liked' if any(word in key(label) for word in ['liked', 'yourlibrary', 'savedsongs', 'savedtracks']) else 'playlist'
    encoding = 'utf-16' if stream.read(2) in (b'\xff\xfe', b'\xfe\xff') else 'utf-8-sig'
    stream.seek(0)
    with io.TextIOWrapper(stream, encoding=encoding, newline='') as text:
        if Path(filename).suffix.lower() == '.csv':
            try:
                dialect = csv.Sniffer().sniff(text.read(8192), delimiters=',;\t')
            except csv.Error:
                dialect = csv.excel
            text.seek(0)
            entry = collection(label, csv.DictReader(text, dialect=dialect), inferred_kind, remaining=remaining)
            return [entry] if entry else []
        raw = json.load(text)
    result = []
    if isinstance(raw, dict) and isinstance(raw.get('playlists'), list):
        for playlist in raw['playlists']:
            if isinstance(playlist, dict):
                entry = collection(playlist.get('name'), playlist.get('items') or playlist.get('tracks') or [], remaining=remaining)
                if entry:
                    result.append(entry)
                    remaining -= len(entry['tracks'])
    elif isinstance(raw, dict):
        kind = 'liked' if inferred_kind == 'liked' or (not raw.get('name') and ('albums' in raw or 'artists' in raw)) else 'playlist'
        entry = collection('Liked Songs' if kind == 'liked' else raw.get('name') or label, raw.get('tracks') or raw.get('items') or [], kind, remaining=remaining)
        if entry:
            result.append(entry)
    elif isinstance(raw, list):
        entry = collection('Liked Songs' if inferred_kind == 'liked' else label, raw, inferred_kind, remaining=remaining)
        if entry:
            result.append(entry)
    return result


def parse(path, filename):
    path = Path(path)
    if path.stat().st_size > MAX_FILE:
        raise ValueError('Choose an export smaller than 32 MB, or import its playlist files separately.')
    collections = []
    if Path(filename).suffix.lower() == '.zip':
        remaining = MAX_TRACKS
        with zipfile.ZipFile(path) as archive:
            relevant = [item for item in archive.infolist() if not item.is_dir() and (Path(item.filename).suffix.lower() == '.csv' or (Path(item.filename).suffix.lower() == '.json' and any(word in key(Path(item.filename).stem) for word in ['playlist', 'yourlibrary', 'savedtracks', 'likedsongs'])))]
            if sum(item.file_size for item in relevant) > MAX_EXPANDED or len(relevant) > 300:
                raise ValueError('This export expands to too much data. Select its individual playlist files instead.')
            for item in relevant:
                if item.flag_bits & 1:
                    raise ValueError('Encrypted ZIP files are unsupported. Unzip the playlist files before importing.')
                if item.file_size > MAX_FILE:
                    raise ValueError('This export file is too large. Import its playlist files separately.')
                with archive.open(item) as stream:
                    entries = parse_file(stream, Path(item.filename).name, remaining)
                collections.extend(entries)
                remaining -= sum(len(c['tracks']) for c in entries)
    elif Path(filename).suffix.lower() in {'.json', '.csv'}:
        with path.open('rb') as stream:
            collections = parse_file(stream, filename, MAX_TRACKS)
    else:
        raise ValueError('Choose Spotify JSON files, a CSV playlist export, or a ZIP containing them.')
    if not collections:
        raise ValueError('No playlist or liked-song records were found. Choose Playlist, YourLibrary, or a song CSV export.')
    return {'collections': collections, 'total': sum(len(c['tracks']) for c in collections)}


def from_url(value):
    """Read only metadata published in a public Spotify embed, without a login."""
    from urllib.parse import urlparse
    import requests
    value = value.strip()
    match = re.fullmatch(r'spotify:playlist:([A-Za-z0-9]{22})', value)
    if not match:
        url = urlparse(value)
        if url.scheme != 'https' or url.hostname != 'open.spotify.com':
            raise ValueError('Paste a Spotify playlist link, or import a Spotify export file for Liked Songs.')
        match = re.fullmatch(r'/(?:embed/)?playlist/([A-Za-z0-9]{22})/?', url.path)
    if not match:
        raise ValueError('Liked Songs and private playlists require a JSON or CSV export file.')
    ident = match.group(1)
    try:
        with requests.get('https://open.spotify.com/embed/playlist/' + ident, timeout=(6, 20), stream=True, allow_redirects=False) as response:
            if response.status_code != 200:
                raise ValueError('Spotify did not publish this playlist here. Import its export file instead.')
            content = response.raw.read(4 * 1024 * 1024 + 1, decode_content=True)
            if len(content) > 4 * 1024 * 1024:
                raise ValueError('Use a playlist export file for this large playlist.')
        html = content.decode('utf-8', errors='replace')
        script = re.search(r'<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', html, re.S)
        if not script:
            raise ValueError('Spotify did not expose the track list. Import a JSON or CSV export instead.')
        raw = json.loads(script.group(1))
        pending = [raw]
        while pending:
            item = pending.pop()
            if isinstance(item, dict):
                if isinstance(item.get('trackList'), list) and item['trackList']:
                    result = collection(item.get('name') or item.get('title') or 'Spotify playlist', item['trackList'], sourceUrl='https://open.spotify.com/playlist/' + ident, partial=True)
                    if result:
                        return {'collections': [result], 'total': len(result['tracks'])}
                pending.extend(item.values())
            elif isinstance(item, list):
                pending.extend(item)
        raise ValueError('Spotify did not expose this playlist’s songs. Use an export file; Liked Songs and private playlists are not public.')
    except requests.RequestException as error:
        raise ValueError('Couldn’t read this Spotify link. You can import a JSON or CSV export without connecting to Spotify.') from error
