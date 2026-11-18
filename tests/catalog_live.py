"""Optional live provider check. Saves sanitized evidence and streams under ignored .tools/."""
from pathlib import Path
import json, os, sys
ROOT = Path(__file__).resolve().parents[1]
PROOF = ROOT / '.tools/v03-proof'
PROOF.mkdir(parents=True, exist_ok=True)
os.environ['UNDERTONE_CACHE_DIR'] = str(PROOF / 'cache')
sys.path.insert(0, str(ROOT / 'music'))
from backend import dispatch

queries = ['DVRST Close Eyes', 'Daft Punk Instant Crush', 'The Weeknd Blinding Lights', 'Kordhell Murder In My Mind']
streams = []
report = {'search': [], 'albums': []}
for query in queries:
    result = dispatch('search', {'query': query})
    assert result['tracks'], query
    assert all(t['source'] == 'monochrome' and t['kind'] == 'song' for t in result['tracks'])
    top = result['tracks'][0]
    report['search'].append({'query': query, 'top': top['title'], 'artist': top['artist']})
    if len(streams) < 2:
        streams.append(dispatch('resolve', {'id': top['remoteId'], 'source': top['source'], 'track': top})['url'])
    print(query, '->', top['artist'], '/', top['title'], flush=True)

artist = dispatch('artist', {'id': 'mono:artist:152942198986379264'})
releases = dispatch('discography', {'id': artist['id']})['releases']
for title, count in [('Echoes of Childhood', 9), ('Echoes of Childhood II', 10)]:
    album = next(a for a in releases if a['title'] == title)
    full = dispatch('album', {'id': album['id']})
    assert len(full['tracks']) == count, (title, len(full['tracks']))
    assert all(t['album']['id'] == full['id'] for t in full['tracks'])
    recording = full['tracks'][0]
    streams.append(dispatch('resolve', {'id': recording['remoteId'], 'source': recording['source'], 'track': recording})['url'])
    report['albums'].append({'title': title, 'tracks': count, 'sample': recording['title']})
    print(title, count, 'tracks; playback sample:', recording['title'], flush=True)

seed = artist['tracks'][0]
mix = dispatch('recommendations', {'seed': seed['remoteId'], 'track': seed})
assert mix['tracks'] and all(t['source'] == 'monochrome' for t in mix['tracks'])
assert seed['id'] not in {t['id'] for t in mix['tracks']}
report['artistMix'] = len(mix['tracks'])
print('Artist mix:', len(mix['tracks']), 'Monochrome recordings', flush=True)

videos = dispatch('videos', {'query': 'DVRST Close Eyes official music video'})
assert videos['tracks'] and all(t['source'] == 'youtube' and t['kind'] == 'video' for t in videos['tracks'])
video = videos['tracks'][0]
failures = []
for video in videos['tracks'][:3]:
    try:
        streams.append(dispatch('resolve', {'id': video['remoteId'], 'source': video['source'], 'track': video})['url'])
        report['video'] = {'title': video['title'], 'source': video['source'], 'playback': 'resolved'}
        break
    except ValueError as error:
        failures.append(str(error))
else:
    report['video'] = {'source': 'youtube', 'playback': 'provider blocked', 'errors': failures}
    print('YouTube playback blocked by provider checks; music playback remains independent.', flush=True)
print('YouTube videos kept separate:', len(videos['tracks']), 'results', flush=True)
(PROOF / 'catalog.json').write_text(json.dumps(report, indent=2))
(PROOF / 'streams.json').write_text(json.dumps(streams))
print('Catalog checks passed.', len(streams), 'playback samples prepared for native tests.', flush=True)
