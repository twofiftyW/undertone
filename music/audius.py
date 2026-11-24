"""Search public Audius recordings that can be streamed without an account."""
import re

import requests


SEARCH_URL = 'https://api.audius.co/v1/tracks/search'
UNAVAILABLE = 'Couldn’t search Audius. Check your connection and try again.'
TRACK_ID = re.compile(r'[A-Za-z0-9]{1,100}\Z')


def track(item):
    if not isinstance(item, dict):
        return None
    ident = item.get('id')
    if not isinstance(ident, str) or not TRACK_ID.fullmatch(ident):
        return None
    if (item.get('is_streamable') is not True or item.get('is_available') is False
            or item.get('is_delete') or item.get('is_unlisted') or item.get('is_stream_gated')
            or item.get('stream_conditions') or item.get('allowed_api_keys')):
        return None
    access = item.get('access')
    if isinstance(access, dict) and access.get('stream') is False:
        return None
    user = item.get('user')
    if not isinstance(user, dict):
        return None
    artist = user.get('name') or user.get('handle')
    title = item.get('title')
    if not isinstance(title, str) or not title.strip() or not isinstance(artist, str) or not artist.strip():
        return None

    artwork = item.get('artwork') or {}
    cover = (artwork.get('480x480') or artwork.get('150x150')) if isinstance(artwork, dict) else None
    duration = item.get('duration')
    link = item.get('permalink')
    # Audius sends relative artist/track paths; never accept another site's URL.
    permalink = 'https://audius.co' + link if isinstance(link, str) and re.fullmatch(r'/[^/?#\\\s]+/[^/?#\\\s]+', link) else ''
    album = item.get('album_backlink')
    album_title = album.get('playlist_name') if isinstance(album, dict) else ''
    return {
        'id': 'audius:' + ident, 'remoteId': ident, 'source': 'audius', 'kind': 'song',
        'title': title.strip(), 'artist': artist.strip(), 'artists': [{'id': '', 'name': artist.strip()}],
        'artwork': cover if isinstance(cover, str) and cover.startswith('https://') else '',
        'album': {'id': '', 'title': album_title if isinstance(album_title, str) else ''},
        'duration': duration if type(duration) is int and duration > 0 else 0,
        'explicit': item.get('parental_warning_type') == 'Explicit',
        'isrc': item.get('isrc') or '', 'genre': item.get('genre') or '', 'permalink': permalink,
    }


def search(query):
    if not query:
        return {'tracks': []}
    try:
        response = requests.get(SEARCH_URL, params={'query': query, 'limit': 36, 'app_name': 'UndertonePersonal'},
                                timeout=(4, 8))
        if response.status_code == 429:
            raise ValueError('Audius is busy. Try again later.')
        response.raise_for_status()
        payload = response.json()
    except requests.RequestException as error:
        raise ValueError(UNAVAILABLE) from error
    if not isinstance(payload, dict) or not isinstance(payload.get('data'), list):
        raise ValueError(UNAVAILABLE)
    # Return recording IDs only. Signed stream URLs in search results are temporary.
    results = {}
    for row in payload['data']:
        song = track(row)
        if song:
            results.setdefault(song['id'], song)
    return {'tracks': list(results.values())}
