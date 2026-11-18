"""Local checks for export parsing, safe matching, and atomic audio downloads."""
import io,json,os,tempfile,zipfile
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'music'))
import backend,monochrome,offline,spotify_import

with tempfile.TemporaryDirectory() as folder:
    root=Path(folder)
    records={'tracks':[{'artist':'DVRST','album':'Echoes of Childhood II','track':'Game Over','uri':'spotify:track:1234567890123456789012'}],'albums':[]}
    library=root/'YourLibrary.json';library.write_text(json.dumps(records))
    data=spotify_import.parse(library,library.name)
    assert data['collections'][0]['kind']=='liked'
    assert data['collections'][0]['tracks'][0]['title']=='Game Over'
    playlist={'playlists':[{'name':'My favorites','items':[{'track':{'trackName':'Game Over','artistName':'DVRST','albumName':'Echoes of Childhood II','trackUri':'spotify:track:1234567890123456789012'}},{'episode':{'name':'A podcast'}}]}]}
    path=root/'Playlist1.json';path.write_text(json.dumps(playlist))
    imported=spotify_import.parse(path,path.name)['collections'][0]
    assert len(imported['tracks'])==1 and imported['ignored']==1
    csv=root/'Liked Songs.csv';csv.write_text('\ufeffTrack URI,Track Name,Artist Name(s),Album Name,Duration (ms)\nspotify:track:1234567890123456789012,"Hello, world",DVRST,Album,132000\n',encoding='utf-8')
    parsed=spotify_import.parse(csv,csv.name)['collections'][0]
    assert parsed['kind']=='liked' and parsed['tracks'][0]['title']=='Hello, world' and parsed['tracks'][0]['duration']==132
    archive=root/'Spotify.zip'
    with zipfile.ZipFile(archive,'w') as out:
        out.write(library,'MyData/YourLibrary.json');out.write(path,'MyData/Playlist1.json')
        out.writestr('MyData/Identity.json','unrelated private data must not be parsed')
    assert len(spotify_import.parse(archive,archive.name)['collections'])==2

    # Read CSV rows directly from a compressed member. Keep duplicates, track
    # order and the ignored-row count, including across BOM/header variants.
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as out:
        rows = ['Track Name;Artist Name(s);Duration (ms)']
        rows += [f'Song {index};Artist;90000' for index in range(2200)]
        rows.extend(['Song 0;Artist;90000', ';Missing title;90000'])
        out.writestr('Liked Songs.csv', ('\r\n'.join(rows)).encode('utf-16'))
        out.write(path, 'Playlists.json')
    imported = spotify_import.parse(archive, archive.name)
    assert imported['total'] == 2202
    liked = imported['collections'][0]
    assert [t['title'] for t in liked['tracks']] == [f'Song {i}' for i in range(2200)] + ['Song 0']
    assert liked['ignored'] == 1 and liked['kind'] == 'liked'
    with patch.object(spotify_import, 'MAX_TRACKS', 2201):
        try:
            spotify_import.parse(archive, archive.name)
        except ValueError as error:
            assert '20,000 songs' in str(error)
        else:
            raise AssertionError('The song limit must apply to the entire archive')

    good={'id':'monochrome:159277913216937984','remoteId':'159277913216937984','source':'monochrome','title':'Close Eyes','artist':'DVRST','artists':[{'id':'mono:artist:152942198986379264','name':'DVRST'}],'duration':132,'album':{'title':'Close Eyes'},'isrc':'TEST12345678'}
    remix={**good,'id':'other','title':'Close Eyes (Slowed + Reverb)','duration':145}
    wrong_artist={**good,'id':'another','artist':'Someone else','artists':[{'name':'Someone else'}]}
    with patch.object(monochrome,'search',return_value={'tracks':[remix,wrong_artist,good]}):
        result=monochrome.match_recording({'title':'Close Eyes','artist':'DVRST','duration':132})
        assert result['track']['id']==good['id']
    with patch.object(monochrome,'search',return_value={'tracks':[wrong_artist,remix]}):
        assert monochrome.match_recording({'title':'Close Eyes','artist':'DVRST','duration':132})['track'] is None

    class Response:
        status_code=200
        headers={'Content-Length':'12'}
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def raise_for_status(self):pass
        def iter_content(self,*args):yield b'fLaC12345678'
    class Session:
        def __enter__(self):return self
        def __exit__(self,*args):pass
        def get(self,*args,**kwargs):return offline.requests.get(*args,**kwargs)
    session_patch=patch.object(offline.requests,'Session',return_value=Session());session_patch.start()
    target=root/'downloads'
    with patch.dict(os.environ,{'UNDERTONE_DOWNLOAD_DIR':str(target)}),patch.object(offline.requests,'get',return_value=Response()):
        result=offline.download(good['remoteId'])
        assert Path(result['nativePath']).read_bytes()==b'fLaC12345678'
        assert not list(target.glob('*.part'))
    with patch.dict(os.environ,{'UNDERTONE_DOWNLOAD_DIR':str(target)}),patch.object(offline.requests,'get',side_effect=AssertionError('Existing download contacted the internet')):
        assert offline.download(good['remoteId'])['bytes']==12
    class Interrupted(Response):
        headers={'Content-Length':'100'}
    with patch.dict(os.environ,{'UNDERTONE_DOWNLOAD_DIR':str(target)}),patch.object(offline.requests,'get',return_value=Interrupted()):
        try:offline.download('159277913216937985');raise AssertionError('Interrupted file was accepted')
        except ValueError:pass
        assert not (target/'159277913216937985.flac').exists()
        assert not list(target.glob('*.part'))
    session_patch.stop()
print('Spotify JSON/CSV/ZIP, Liked Songs, conservative recording matches, existing-file reuse, and interrupted-download checks passed.')

# A server may return smaller ranges than requested. Confirm byte-perfect assembly.
class RangedResponse:
    status_code=206
    def __init__(self,start,end,body):
        self.headers={'Content-Range':f'bytes {start}-{end}/12','Content-Length':str(len(body))}
        self.body=body
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def raise_for_status(self):pass
    def iter_content(self,*args):yield self.body
class RangedSession:
    offsets=[]
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def get(self,url,headers,**kwargs):
        start=int(headers['Range'].split('=')[1].split('-')[0]);self.offsets.append(start)
        end=min(start+7,11)
        return RangedResponse(start,end,b'fLaC12345678'[start:end+1])
with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{'UNDERTONE_DOWNLOAD_DIR':directory}),patch.object(offline.requests,'Session',return_value=RangedSession()):
    result=offline.download('159277913216937984')
    assert Path(result['nativePath']).read_bytes()==b'fLaC12345678'
    assert RangedSession.offsets==[0,8]
print('HTTP range continuation assembles the complete file without gaps or duplicate bytes.')
