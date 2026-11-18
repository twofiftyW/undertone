"""Public Monochrome Tracks catalog. IDs stay strings to preserve snowflake precision."""
from __future__ import annotations
import random
import re
from datetime import date
import requests

BASE = 'https://tracks.monochrome.st'
IDENTIFIER = re.compile(r'\d{17,20}\Z')


def identifier(value, kind):
    value = str(value or '').removeprefix(f'mono:{kind}:')
    if not IDENTIFIER.fullmatch(value):
        raise ValueError('This item uses the previous catalog. Search for it again in Monochrome.')
    return value


def request(path, **params):
    try:
        response = requests.get(BASE + path, params=params, timeout=(6, 22))
        if response.status_code in {401, 403}:
            raise ValueError('Monochrome is restricting this request. Please try again later.')
        if response.status_code == 429:
            raise ValueError('Monochrome is busy. Wait a moment and try again.')
        response.raise_for_status()
        return response.json()
    except requests.RequestException as error:
        raise ValueError('Couldn’t reach Monochrome. Check your connection and try again.') from error


def unique(items):
    result = {}
    for item in items:
        if item and item['id'] not in result:
            result[item['id']] = item
    return list(result.values())


def people(item, fallback=None):
    raw = item.get('artists') or []
    if not raw and item.get('artistIds'):
        names = item.get('artistNames') or []
        raw = [{'id': ident, 'name': names[i] if i < len(names) else 'Unknown artist'} for i, ident in enumerate(item['artistIds'])]
    if not raw:
        return fallback or []
    return [{'id': 'mono:artist:' + str(p.get('artistId') or p.get('id')), 'name': str(p.get('displayName') or p.get('name') or 'Unknown artist')} for p in raw if p.get('artistId') or p.get('id')]


def artist_card(item):
    ident = str(item.get('artistId') or item.get('id') or '')
    if not IDENTIFIER.fullmatch(ident):
        return None
    return {'id': 'mono:artist:' + ident, 'name': str(item.get('displayName') or item.get('name') or 'Artist'), 'artwork': item.get('avatar') or item.get('picture') or '', 'banner': item.get('banner') or ''}


def release(item, fallback=None):
    ident = str(item.get('releaseId') or item.get('id') or '')
    if not IDENTIFIER.fullmatch(ident):
        return None
    credits = people(item, fallback)
    kind = str(item.get('releaseType') or 'ALBUM').upper()
    return {'id': 'mono:album:' + ident, 'title': str(item.get('title') or 'Untitled'), 'artists': credits, 'artist': ', '.join(a['name'] for a in credits), 'artwork': item.get('artwork') or '', 'coverTracks': [{'title': str(t.get('title') or ''), 'artwork': t.get('artwork') or ''} for t in item.get('tracks', [])[:4]], 'releaseDate': item.get('releaseDate') or '', 'year': str(item.get('releaseDate') or '')[:4], 'type': {'SINGLE': 'Single', 'EP': 'EP', 'ALBUM': 'Album'}.get(kind, 'Album'), 'explicit': bool(item.get('explicit'))}


def track(item, fallback=None, album=None):
    ident = str(item.get('trackId') or item.get('id') or '')
    if not IDENTIFIER.fullmatch(ident) or item.get('playable') is False or not item.get('title'):
        return None
    credits = people(item, fallback)
    duration = float(item.get('duration') or 0)
    album_id = str(item.get('releaseId') or '')
    album_data = album or ({'id': 'mono:album:' + album_id, 'title': item.get('albumTitle') or item.get('releaseTitle') or ''} if album_id else {})
    return {'id': 'monochrome:' + ident, 'remoteId': ident, 'source': 'monochrome', 'kind': 'song', 'title': str(item['title']), 'artist': ', '.join(a['name'] for a in credits) or 'Unknown artist', 'artists': credits, 'artwork': item.get('artwork') or (album or {}).get('artwork') or '', 'duration': round(duration / 1000 if duration > 1000 else duration), 'album': {'id': album_data.get('id') or '', 'title': album_data.get('title') or ''}, 'explicit': bool(item.get('explicit')), 'isrc': str(item.get('isrc') or ''), 'year': str(item.get('releaseDate') or '')[:4], 'genre': ''}


def search(query):
    raw = request('/search', q=query)
    albums = unique(release(r) for r in raw.get('releases', []))
    by_id = {a['id']: a for a in albums}
    songs = []
    for item in raw.get('tracks', []):
        album_id = 'mono:album:' + str(item.get('releaseId') or '')
        songs.append(track(item, album=by_id.get(album_id)))
    return {'tracks': unique(songs), 'artists': unique(artist_card(a) for a in raw.get('artists', [])), 'albums': albums, 'needsVideoFallback': False}


def artist(ident, extended=True):
    raw = request('/artists/' + identifier(ident, 'artist'))
    profile = artist_card(raw)
    if not profile:
        raise ValueError('This artist is unavailable on Monochrome.')
    credits = [{'id': profile['id'], 'name': profile['name']}]
    raw_releases = [*raw.get('releases', []), *raw.get('albums', []), *raw.get('singles', []), *raw.get('compilations', [])]
    # Artist profiles contain only short shelves. Release search also includes
    # older albums such as Echoes of Childhood, absent from those shelves.
    if extended:
        other_releases = request('/search/releases', q=profile['name'], limit=100)
        raw_releases.extend(r for r in other_releases.get('releases', []) if profile['id'].removeprefix('mono:artist:') in [str(a) for a in r.get('artistIds', [])])
    releases = unique(release(r, credits) for r in raw_releases)
    songs = [track(t, credits) for t in raw.get('topTracks', [])]
    for r in raw_releases:
        album = release(r, credits)
        if album:
            songs.extend(track(t, credits, album) for t in r.get('tracks', []))
    related = unique(artist_card(a) for a in [*raw.get('relatedArtists', []), *raw.get('similarArtists', [])])
    return {**profile, 'description': str(raw.get('biography') or raw.get('bio') or ''), 'monthlyListeners': '', 'subscribers': '', 'tracks': unique(songs), 'videos': [], 'albums': [r for r in releases if r['type'] == 'Album'], 'singles': [r for r in releases if r['type'] != 'Album'], 'related': related}


def album(ident):
    raw = request('/releases/' + identifier(ident, 'album'))
    result = release(raw)
    if not result:
        raise ValueError('This release is unavailable on Monochrome.')
    result['tracks'] = unique(track(t, result['artists'], result) for t in raw.get('tracks', []))
    result['duration'] = sum(t['duration'] for t in result['tracks'])
    result['description'] = ''
    return result


def find_recording(seed):
    if seed.get('source') == 'monochrome':
        return seed
    query = str(seed.get('artist') or '') + ' ' + str(seed.get('title') or '')
    candidates = search(query)['tracks']
    title = re.sub(r'\W+', '', str(seed.get('title') or '').casefold())
    exact = [t for t in candidates if re.sub(r'\W+', '', t['title'].casefold()) == title and seed.get('artist', '').casefold() in t['artist'].casefold()]
    if not exact:
        raise ValueError('This saved recording could not be matched on Monochrome. Try finding it in Search.')
    return exact[0]


def recommendations(seed):
    seed = find_recording(seed)
    credits = [a for a in seed.get('artists', []) if a.get('id', '').startswith('mono:artist:')]
    if not credits:
        raise ValueError('Open this song from Search to find its artist mix.')
    profile = artist(credits[0]['id'])
    songs = [t for t in profile['tracks'] if t['id'] != seed['id']]
    # The public Tracks API has no similarity endpoint. Offer artist deep cuts
    # honestly instead of presenting title-search results as related artists.
    random.Random(seed['id'] + date.today().isoformat()).shuffle(songs)
    return {'seed': seed['remoteId'], 'tracks': songs[:40], 'mode': 'artist', 'artist': profile['name']}


def home_artist(seed):
    ident, name = seed['id'], seed['name']
    if not ident:
        results = search(name)
        matched = next((a for a in results['artists'] if a['name'].casefold() == name.casefold()), None)
        if not matched:
            return {'name': name, 'tracks': [t for t in results['tracks'] if any(a['name'].casefold() == name.casefold() for a in t['artists'])], 'related': []}
        ident = matched['id']
    return artist(ident, extended=False)


def match_recording(seed):
    """Only auto-match a clear recording; keep ambiguous candidates for review."""
    title = str(seed.get('title') or '')[:500]
    artist_name = str(seed.get('artist') or '')[:500]
    if not title or not artist_name:
        return {'track': None, 'candidates': [], 'reason': 'Song title and artist are required.'}
    return choose_recording(seed, search(artist_name + ' ' + title)['tracks'])


def choose_recording(seed, candidates):
    import difflib
    import unicodedata
    def normalized(value):
        value = unicodedata.normalize('NFKD', str(value or '')).casefold()
        value = re.sub(r'\s*[\[(](?:feat\.?|ft\.?|featuring)\s+.*?[\])]', '', value)
        return ''.join(c for c in value if c.isalnum())
    title = str(seed.get('title') or '')[:500]
    artist_name = str(seed.get('artist') or '')[:500]
    if not title or not artist_name:
        return {'track': None, 'candidates': [], 'reason': 'Song title and artist are required.'}
    ranked = []
    variants = {'slowed', 'reverb', 'sped', 'remix', 'cover', 'live', 'instrumental', 'karaoke', 'acoustic'}
    wanted_variants = variants & set(re.findall(r'\w+', title.casefold()))
    for candidate in candidates:
        source_artist = normalized(artist_name)
        named_artists = [normalized(name) for name in re.split(r';|\s+&\s+', artist_name)]
        candidate_artists = {normalized(a['name']) for a in candidate['artists'] if normalized(a['name'])}
        artist_matches = normalized(candidate['artist']) == source_artist or all(name in candidate_artists for name in named_artists if name)
        same_title = normalized(title) == normalized(candidate['title'])
        score = 70 * difflib.SequenceMatcher(None, normalized(title), normalized(candidate['title'])).ratio() + (20 if artist_matches else 0)
        candidate_variants = variants & set(re.findall(r'\w+', candidate['title'].casefold()))
        if candidate_variants != wanted_variants:
            score -= 25
        try:
            duration = float(seed.get('duration') or 0)
        except (TypeError, ValueError):
            duration = 0
        duration_matches = not duration or abs(candidate['duration'] - duration) <= 5
        if not duration_matches:
            score -= 20
        if normalized(seed.get('album')) and normalized(seed['album']) == normalized(candidate['album']['title']):
            score += 4
        isrc_matches = bool(seed.get('isrc')) and str(seed['isrc']).upper() == str(candidate.get('isrc') or '').upper()
        clear = isrc_matches or (same_title and artist_matches and duration_matches and candidate_variants == wanted_variants)
        if isrc_matches:
            score += 100
        ranked.append((score, clear, candidate))
    ranked.sort(key=lambda item: item[0], reverse=True)
    return {'track': ranked[0][2] if ranked and ranked[0][1] else None, 'candidates': [item[2] for item in ranked[:6]], 'reason': '' if ranked and ranked[0][1] else 'No clear recording match. Choose a recording manually.'}
