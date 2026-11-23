"""Download a selected recording with verified ranges and an atomic final rename."""
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import re
import shutil
import time
import uuid
import requests
import monochrome

MAX_AUDIO = 512 * 1024 * 1024
RESERVE = 40 * 1024 * 1024
RANGE_SIZE = 4 * 1024 * 1024
DOWNLOAD_BATCH = 3
YOUTUBE_FORMATS = ('m4a', 'mp3', 'ogg', 'opus', 'webm')


def audio_name(name):
    return bool(re.fullmatch(r'(?:\d{17,20}\.flac|youtube-[A-Za-z0-9_-]{11}\.(?:m4a|webm|opus|mp3|ogg))', name))


def valid_header(data, suffix):
    if suffix == '.flac':
        return data.startswith(b'fLaC')
    if suffix == '.m4a':
        return data[4:8] == b'ftyp'
    if suffix == '.webm':
        return data.startswith(b'\x1aE\xdf\xa3')
    if suffix in {'.ogg', '.opus'}:
        return data.startswith(b'OggS')
    return data.startswith(b'ID3') or data[:1] == b'\xff'


def completed_audio(path):
    if not audio_name(path.name):
        return None
    try:
        if not path.is_file():
            return None
        with path.open('rb') as stream:
            size = os.fstat(stream.fileno()).st_size
            if size > 8 and valid_header(stream.read(16), path.suffix):
                return {'nativePath': str(path), 'bytes': size}
    except OSError:
        # A download can be removed while its metadata is being read.
        pass
    return None


def find_download(root, ident, source):
    if source == 'monochrome' and monochrome.IDENTIFIER.fullmatch(ident):
        return completed_audio(root / (ident + '.flac'))
    if source == 'youtube' and re.fullmatch(r'[A-Za-z0-9_-]{11}', ident):
        for extension in YOUTUBE_FORMATS:
            if entry := completed_audio(root / f'youtube-{ident}.{extension}'):
                return entry
    return None


def download(ident, source='monochrome'):
    if source == 'monochrome':
        ident = monochrome.identifier(ident, 'track')
        filename = ident + '.flac'
        url = monochrome.BASE + '/track/' + ident
    elif source == 'youtube' and re.fullmatch(r'[A-Za-z0-9_-]{11}', ident):
        filename = None
        url = None
    else:
        raise ValueError('Choose a supported song to download.')
    directory = os.environ.get('UNDERTONE_DOWNLOAD_DIR')
    if not directory:
        raise ValueError('Downloads are available in the installed app.')
    root = Path(directory).resolve()
    root.mkdir(parents=True, exist_ok=True)
    if entry := find_download(root, ident, source):
        return entry
    if source == 'youtube':
        import backend
        recording = backend.resolve(ident)
        extension = recording.get('format')
        if extension not in YOUTUBE_FORMATS:
            raise ValueError('This YouTube recording has no supported offline audio format.')
        url = recording['url']
        filename = 'youtube-' + ident + '.' + extension
    destination = root / filename
    partial = root / (ident + f'.{uuid.uuid4().hex}.part')
    written = 0
    total = None
    validator = None
    failures = 0
    deadline = time.monotonic() + 540
    try:
        with partial.open('xb') as output, requests.Session() as session:
            while total is None or written < total:
                if time.monotonic() > deadline:
                    raise ValueError('The download took too long. Try again.')
                end = min(written + RANGE_SIZE - 1, total - 1 if total else MAX_AUDIO - 1)
                headers = {'Range': f'bytes={written}-{end}', 'Accept-Encoding': 'identity'}
                if validator:
                    headers['If-Range'] = validator
                start = written
                try:
                    with session.get(url, headers=headers, stream=True, timeout=(6, 30)) as response:
                        if response.status_code in {401, 403, 429}:
                            raise ValueError('This recording is not currently available to download. Please retry later.')
                        response.raise_for_status()
                        expected = int(response.headers.get('Content-Length') or 0)
                        if response.status_code == 206:
                            match = re.fullmatch(r'bytes (\d+)-(\d+)/(\d+)', response.headers.get('Content-Range', ''))
                            if not match or int(match[1]) != start or int(match[2]) > end:
                                raise ValueError('The provider returned an invalid download range. Please retry.')
                            size = int(match[3])
                            expected = int(match[2]) - start + 1
                        elif response.status_code == 200 and start == 0 and expected:
                            size = expected
                        else:
                            raise ValueError('This server did not support continuing the download safely.')
                        if total is not None and total != size:
                            raise ValueError('The recording changed during download. Please retry.')
                        total = size
                        if total > MAX_AUDIO:
                            raise ValueError('This recording is larger than the 512 MB download limit.')
                        if shutil.disk_usage(root).free < total - written + RESERVE:
                            raise ValueError('There isn’t enough free space for this download.')
                        marker = response.headers.get('ETag') or response.headers.get('Last-Modified')
                        if marker and not marker.startswith('W/'):
                            if validator and validator != marker:
                                raise ValueError('The recording changed during download. Please retry.')
                            validator = marker
                        for chunk in response.iter_content(128 * 1024):
                            if not chunk:
                                continue
                            if written == 0 and not valid_header(chunk, destination.suffix):
                                raise ValueError('The provider did not return a supported audio file.')
                            if written + len(chunk) > total or written + len(chunk) > MAX_AUDIO:
                                raise ValueError('The provider returned an incorrect audio size.')
                            if time.monotonic() > deadline:
                                raise ValueError("The download took too long. Try again.")
                            output.write(chunk)
                            written += len(chunk)
                        if written - start != expected:
                            raise requests.exceptions.ChunkedEncodingError('Incomplete audio range')
                except requests.RequestException:
                    failures += 1
                    if failures > 5:
                        raise ValueError('Couldn’t finish downloading this song. Check your connection and retry.')
                    # Resume at the first byte not already written; never append a
                    # response unless its Content-Range confirms that offset.
                    continue
            output.flush()
            os.fsync(output.fileno())
        if written <= 4 or written != total:
            raise ValueError('The download was interrupted. Please retry.')
        partial.replace(destination)
        return {'nativePath': str(destination), 'bytes': written}
    finally:
        partial.unlink(missing_ok=True)


def download_batch(seeds):
    def fetch(seed):
        try:
            return {'file': download(seed['id'], seed['source'])}
        except (ValueError, OSError) as error:
            return {'reason': str(error)}

    with ThreadPoolExecutor(max_workers=DOWNLOAD_BATCH) as pool:
        return list(pool.map(fetch, seeds))
