"""Shared desktop/Android catalog: Monochrome first, YouTube fallback and videos."""
from __future__ import annotations
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unicodedata
from urllib.parse import urlparse

engine_directory = Path(__file__).resolve().parent
sys.path[:0] = [str(engine_directory / "vendor"), str(engine_directory)]
import monochrome

VIDEO = re.compile(r"[A-Za-z0-9_-]{11}\Z")
CACHE = Path(os.environ.get("UNDERTONE_CACHE_DIR", Path.home() / ".cache/undertone/catalog"))
MATCH_BATCH = 8
MATCH_WORKERS = concurrent.futures.ThreadPoolExecutor(max_workers=4, initializer=monochrome.initialize_match_worker)


def cached(kind, args, fetch, ttl=3600, force=False):
    key = hashlib.sha256(json.dumps([kind, args], sort_keys=True).encode()).hexdigest()
    directory = CACHE
    limit = 200
    if kind == 'recording-match-v3':
        # A single supported Spotify export can contain 20,000 distinct recordings.
        # Keep their results apart from the small browse cache and prune one bucket at a time.
        directory = CACHE / 'recordings' / key[:2]
        limit = 100
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / (key + ".json")
    if not force:
        # Reuse unexpired match entries written by older versions in the root cache.
        candidates = (path,) if directory == CACHE else (path, CACHE / path.name)
        for candidate in candidates:
            try:
                if time.time() - candidate.stat().st_mtime < ttl:
                    return json.loads(candidate.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                pass
    result = fetch()
    if isinstance(result, dict) and result.get('error'):
        return result
    with tempfile.NamedTemporaryFile(mode='w', dir=directory, suffix='.tmp', delete=False, encoding='utf-8') as output:
        temporary = Path(output.name)
        output.write(json.dumps(result, ensure_ascii=False))
    try:
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
    files = list(directory.glob("*.json"))
    if len(files) > limit + 20:
        dated = []
        for item in files:
            try:
                dated.append((item.stat().st_mtime, item))
            except OSError:
                pass
        for _, old in sorted(dated)[:-limit]:
            old.unlink(missing_ok=True)
    return result


def thumbnail(item, large=False):
    pictures = item.get("thumbnails") or item.get("thumbnail") or []
    if isinstance(pictures, str):
        return pictures if pictures.startswith("https://") else ""
    pictures = [p for p in pictures if isinstance(p, dict) and str(p.get("url", "")).startswith("https://")]
    if not pictures:
        return ""
    target = 1440 if large else 544
    picture = min(pictures, key=lambda p: abs((p.get("width") or 0) - target))
    url = picture["url"]
    # YouTube Music often supplies only 120px art on song shelves. The same
    # Google image supports an explicit size; video thumbnails keep their URL.
    if "googleusercontent.com/" in url and (picture.get("width") or 0) < target:
        url = re.sub(r"=w\d+-h\d+", f"=w{target}-h{target}", url)
    return url


def seconds(value):
    if isinstance(value, (float, int)):
        return max(0, int(value))
    try:
        result = 0
        for part in str(value or "").split(":"):
            result = result * 60 + int(part)
        return result
    except ValueError:
        return 0


def words(value):
    return re.findall(r"\w+", unicodedata.normalize("NFKC", str(value)).casefold())


def people(item, fallback=None):
    artists = item.get("artists") or fallback or []
    return [{"id": str(p.get("id") or p.get("browseId") or ""), "name": str(p.get("name") or p.get("title") or "Unknown artist")} for p in artists if isinstance(p, dict)]


def track(item, fallback_artists=None, album=None, artwork=""):
    video_id = str(item.get("videoId") or "")
    if not VIDEO.fullmatch(video_id) or item.get("isAvailable") is False or not item.get("title"):
        return None
    artists = people(item, fallback_artists)
    raw_album = item.get("album")
    album_data = raw_album if isinstance(raw_album, dict) else album or {}
    return {
        "id": "youtube:" + video_id,
        "remoteId": video_id,
        "source": "youtube",
        "kind": "video" if item.get("videoType") == "MUSIC_VIDEO_TYPE_OMV" else "song",
        "title": str(item["title"]).strip(),
        "artist": ", ".join(p["name"] for p in artists) or "Unknown artist",
        "artists": artists,
        "artwork": thumbnail(item) or artwork,
        "duration": seconds(item.get("duration_seconds") or item.get("duration") or item.get("length")),
        "album": {"id": str(album_data.get("id") or album_data.get("browseId") or ""), "title": str(album_data.get("name") or album_data.get("title") or raw_album or "")},
        "explicit": bool(item.get("isExplicit")),
        "views": str(item.get("views") or ""),
        "year": str(item.get("year") or ""),
        "genre": "",
    }


def youtube_info(value, flat=False):
    """Use the installed desktop tool or the embedded Android Python package."""
    binary = shutil.which("yt-dlp") if os.name != 'nt' else None
    if binary:
        options = ["--flat-playlist"] if flat else ["--no-playlist", "--skip-download", "-f", "bestaudio[ext=m4a]/bestaudio"]
        process = subprocess.run([binary, "--ignore-config", "--no-cache-dir", "--no-warnings", "--socket-timeout", "10", "--retries", "0", "--extractor-retries", "0", "--dump-single-json", *options, value], capture_output=True, text=True, timeout=30 if flat else 45)
        if process.returncode:
            raise ValueError(process.stderr)
        return json.loads(process.stdout)
    try:
        import yt_dlp
        class Quiet:
            def debug(self, message): pass
            def warning(self, message): pass
            def error(self, message): pass
        options = {'quiet': True, 'no_warnings': True, 'logger': Quiet(), 'cachedir': False, 'extract_flat': flat, 'skip_download': True, 'socket_timeout': 10, 'retries': 0, 'extractor_retries': 0, 'format': 'bestaudio[ext=m4a]/bestaudio'}
        runtime = Path(__file__).with_name('python') / 'deno.exe'
        if os.name == 'nt' and runtime.is_file():
            options['js_runtimes'] = {'deno': {'path': str(runtime)}}
        with yt_dlp.YoutubeDL(options) as client:
            return client.extract_info(value, download=False)
    except Exception as error:
        raise ValueError(str(error)) from error


def youtube_search(query, canonical_artists, kind='video', *, report_errors=False):
    try:
        entries = youtube_info('ytsearch8:' + query, flat=True).get('entries', [])
    except (ValueError, subprocess.TimeoutExpired) as error:
        if report_errors:
            raise ValueError("The music service couldn’t complete that request. Check your connection and try again.") from error
        return []
    def details(item):
        ident = str(item.get("id") or "")
        if not VIDEO.fullmatch(ident):
            return item
        # Spotify matching already has YouTube's title and channel on complete
        # flat search results. Fetch oEmbed only when a credit needs filling in.
        if kind == 'song' and report_errors and item.get('title') and item.get('channel'):
            return item
        def fetch():
            import requests
            response = requests.get("https://www.youtube.com/oembed", params={"url": "https://www.youtube.com/watch?v=" + ident, "format": "json"}, timeout=(5, 10))
            response.raise_for_status()
            return response.json()
        try:
            info = cached("oembed", ident, fetch, 86400)
            return {**item, "title": info.get("title") or item.get("title"), "channel": info.get("author_name") or item.get("channel"), "thumbnail": info.get("thumbnail_url")}
        except Exception:
            return item
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        entries = list(pool.map(details, entries))
    results = []
    for item in entries:
        ident = str(item.get("id") or "")
        if not VIDEO.fullmatch(ident):
            continue
        name = str(item.get("channel") or item.get("uploader") or "YouTube").removesuffix(' - Topic')
        title = str(item.get("title") or "Untitled")
        canonical = next((a for a in canonical_artists if words(a["name"]) == words(name) or title.casefold().startswith(a["name"].casefold() + " - ")), None)
        credited = canonical["name"] if canonical else name
        artists = [{"name": credited, "id": canonical["id"] if canonical else str(item.get("channel_id") or "")}]
        if title.casefold().startswith(credited.casefold() + " - "):
            title = title[len(credited) + 3:]
        title = re.sub(r"\s*[\[(](?:official (?:audio|music video|video)|audio|music video)[\])]\s*$", "", title, flags=re.I).strip()
        record = track({"videoId": ident, "title": title, "artists": artists, "duration_seconds": item.get("duration"), "thumbnails": item.get("thumbnails") or item.get("thumbnail"), "videoType": "MUSIC_VIDEO_TYPE_OMV"})
        if record:
            record['kind'] = kind
            record['fallback'] = kind == 'song'
            record["artwork"] = record["artwork"] or f"https://i.ytimg.com/vi/{ident}/hqdefault.jpg"
            record["uploader"] = name
            results.append(record)
    return results


def resolve(ident):
    try:
        info = youtube_info('https://www.youtube.com/watch?v=' + ident)
    except (ValueError, subprocess.TimeoutExpired) as error:
        message = str(error).lower()
        if "sign in" in message or "bot" in message:
            raise ValueError("YouTube is asking for a sign-in check for this track. Try another recording.")
        if "country" in message or "region" in message:
            raise ValueError("This recording is unavailable in your region.")
        raise ValueError("YouTube could not open this recording. Try again or choose another result.")
    url = info.get("url") or ""
    host = urlparse(url).hostname or ""
    if not url.startswith("https://") or not (host == "googlevideo.com" or host.endswith(".googlevideo.com")):
        raise ValueError("The music service did not return a supported audio stream")
    return {"url": url, "duration": seconds(info.get("duration")), "title": str(info.get("title") or ""), "format": str(info.get("ext") or "")}


def dispatch(operation, args):
    if not isinstance(args, dict):
        raise ValueError("Invalid music request")
    query = str(args.get("query") or "").strip()[:300]
    ident = str(args.get("id") or args.get("seed") or "")
    force = bool(args.get("force"))
    if operation == 'lyrics':
        import lyrics
        return lyrics.lookup(args)
    if operation == 'audius_search':
        import audius
        return audius.search(query)
    if operation in ('link_discover_phones', 'link_invite_phone'):
        import device_sync
        if operation == 'link_discover_phones':
            return device_sync.discover_phones()
        return device_sync.invite_phone(args.get('address'), ident)
    if operation == "download":
        import offline
        return offline.download(ident, str(args.get('source') or 'monochrome'))
    if operation in ('spotify_parse', 'spotify_parse_pages'):
        import spotify_import
        from urllib.parse import unquote
        try:
            path = Path(str(args.get("path") or ""))
            result = spotify_import.parse(path, unquote(str(args.get("filename") or "")))
            return spotify_import.write_pages(result, path.parent) if operation == 'spotify_parse_pages' else result
        except (json.JSONDecodeError, UnicodeError, spotify_import.zipfile.BadZipFile, spotify_import.csv.Error) as error:
            raise ValueError("Couldn’t read this export. Choose a Spotify account-data JSON/ZIP or a playlist CSV file.") from error
    if operation == "spotify_url":
        import spotify_import
        return spotify_import.from_url(str(args.get("url") or ""))
    if operation == "match":
        seeds = args.get("tracks") or []
        if not isinstance(seeds, list) or len(seeds) > MATCH_BATCH:
            raise ValueError("Match up to eight recordings at a time")
        def find(seed):
            if not isinstance(seed, dict):
                return {"track": None, "candidates": [], "reason": "Invalid recording metadata"}
            try:
                return cached("recording-match-v3", seed, lambda: match_recording(seed), 43200, force)
            except ValueError as error:
                return {"track": None, "candidates": [], "reason": str(error), "error": True}
        unique = {json.dumps(seed, sort_keys=True): seed for seed in seeds}
        by_seed = dict(zip(unique, MATCH_WORKERS.map(find, unique.values())))
        matches = [by_seed[json.dumps(seed, sort_keys=True)] for seed in seeds]
        if args.get('includeCandidates') is False:
            # Choose the same first alternative available in the correction picker.
            automatic = []
            for result in matches:
                track = result.get('track') or next(iter(result.get('candidates') or []), None)
                automatic.append({'track': track, 'reason': '' if track else result.get('reason', ''),
                                  'error': bool(not track and result.get('error'))})
            matches = automatic
        return {"matches": matches}
    if operation == "search":
        if not query:
            return {"tracks": [], "artists": [], "albums": []}
        def lookup():
            try:
                result = monochrome.search(query)
            except ValueError as error:
                result = {'tracks': [], 'artists': [], 'albums': [], 'notice': str(error)}
            query_terms = words(query)
            relevant = any(all(term in ''.join(words(song['artist'] + ' ' + song['title'] + ' ' + song.get('album', {}).get('title', ''))) for term in query_terms) for song in result['tracks'])
            if not relevant:
                extra = youtube_search(query, result['artists'], 'song')
                result['tracks'] = monochrome.unique([*extra, *result['tracks']])
                result['fallbackUsed'] = True
                result['notice'] = 'No clear Monochrome song match. YouTube recordings added.' if extra else result.get('notice', '')
            return result
        return cached("song-search-v3", query, lookup, 1800, force)
    if operation == 'fallback':
        return cached('youtube-songs-v1', query, lambda: {'tracks': youtube_search(query, args.get('artists') or [], 'song')}, 1800, force)
    if operation == "videos":
        if not query:
            return {"tracks": []}
        def fetch_videos():
            return {"tracks": youtube_search(query, args.get("artists") or [])}
        return cached("youtube-videos-v3", query, fetch_videos, 1800, force)
    if operation == "artist":
        if not ident.startswith("mono:") and args.get("name"):
            matches = dispatch("search", {"query": args["name"]})["artists"]
            if not matches:
                raise ValueError("This artist could not be found on Monochrome")
            ident = matches[0]["id"]
        monochrome.identifier(ident, "artist")
        return cached("mono-artist-v2", ident, lambda: monochrome.artist(ident), 21600, force)
    if operation == "discography":
        profile = dispatch("artist", args)
        return {"artistId": profile["id"], "releases": monochrome.unique([*profile["albums"], *profile["singles"]])}
    if operation == "album":
        monochrome.identifier(ident, "album")
        return cached("mono-album-v1", ident, lambda: monochrome.album(ident), 21600, force)
    if operation == "recommendations":
        seed = args.get("track") or {}
        if not seed.get("id"):
            raise ValueError("Choose a recording to start an artist mix")
        return cached("mono-mix-v1", seed["id"], lambda: monochrome.recommendations(seed), 1800, force)
    if operation == "resolve":
        recording = args.get("track") or {}
        if args.get("source") == "youtube":
            if not VIDEO.fullmatch(ident):
                raise ValueError("Invalid video identifier")
            return cached("video-stream", ident, lambda: resolve(ident), 600, force)
        ident = monochrome.identifier(ident, "track")
        return {"url": monochrome.BASE + "/track/" + ident, "format": "flac", "duration": recording.get("duration") or 0}
    if operation == "home":
        return personalized_home(args, force)
    raise ValueError("Unknown music operation")


def personalized_home(args, force):
    raw = args.get('artists') or []
    if not isinstance(raw, list):
        raise ValueError('Invalid listening history')
    seeds = []
    for seed in raw[:4]:
        if not isinstance(seed, dict) or not isinstance(seed.get('name'), str):
            continue
        name = seed['name'].strip()[:160]
        ident = str(seed.get('id') or '')
        if name:
            seeds.append({'name': name, 'id': ident if re.fullmatch(r'mono:artist:\d{17,20}', ident) else ''})
    if not seeds:
        return {'sections': []}

    def lookup(seed):
        try:
            return cached('home-artist-v1', seed, lambda: monochrome.home_artist(seed), 3600, force)
        except ValueError as error:
            return error

    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        profiles = list(pool.map(lookup, seeds))
    if all(isinstance(profile, ValueError) for profile in profiles):
        raise profiles[0]
    recent = args.get('recent') or []
    seen = {track for track in recent[:20] if isinstance(track, str)} if isinstance(recent, list) else set()
    sections = []
    related = []
    for profile in profiles:
        if isinstance(profile, ValueError):
            continue
        songs = [track for track in profile['tracks'] if track['id'] not in seen][:12]
        if songs:
            seen.update(track['id'] for track in songs)
            sections.append({'artist': profile['name'], 'tracks': songs})
        related.extend(profile.get('related') or [])
    heard_artists = {seed['name'].casefold() for seed in seeds}
    related = [a for a in monochrome.unique(related) if a['name'].casefold() not in heard_artists][:6]
    if related:
        sections.append({'kind': 'related', 'artists': related})
    return {'sections': sections}


def match_recording(seed):
    try:
        result = monochrome.match_recording(seed)
    except ValueError as error:
        result = {'track': None, 'candidates': [], 'reason': str(error), 'error': True}
    if result['track'] or not seed.get('title') or not seed.get('artist'):
        return result
    try:
        candidates = youtube_search(str(seed['artist']) + ' ' + str(seed['title']), [{'id': '', 'name': str(seed['artist'])}], 'song', report_errors=True)
    except ValueError as error:
        return {**result, 'error': True, 'reason': str(error)}
    fallback = monochrome.choose_recording(seed, candidates)
    if result.get('error') and not fallback['track']:
        fallback.update(error=True, reason=result['reason'])
    return {**fallback, 'candidates': monochrome.unique([*fallback['candidates'], *result['candidates']])[:8], 'fallbackUsed': True}


if __name__ == "__main__":
    try:
        if len(sys.argv) == 3 and sys.argv[1] == '--sync-server':
            import device_sync
            device_sync.serve(sys.argv[2])
            sys.exit(0)
        request = json.loads(sys.stdin.read(65536))
        result = dispatch(str(request.get("operation") or ""), request.get("args") or {})
        print(json.dumps({"data": result}, ensure_ascii=False))
    except Exception as error:
        message = str(error) if isinstance(error, ValueError) else "The music service couldn’t complete that request. Check your connection and try again."
        print(json.dumps({"error": message}, ensure_ascii=False))
        sys.exit(1)
