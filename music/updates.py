"""Select and verify Undertone releases from the project's GitHub repository."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import urlparse
import zipfile

RELEASES = "https://api.github.com/repos/twofiftyW/undertone/releases"
SUFFIXES = {"linux": "linux-x86_64.tar.gz", "windows": "windows-x64.zip", "android": "android.apk"}
ASSET_HOSTS = {"release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"}
MAX_DOWNLOAD = 256 * 1024 * 1024
MAX_EXPANSION = 768 * 1024 * 1024


def version_key(version):
    match = re.fullmatch(r"v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-(alpha|beta|rc)(?:\.?([0-9]{1,6}))?)?", version)
    if match:
        major, minor, patch, channel, sequence = match.groups()
        return int(major), int(minor), int(patch), ("alpha", "beta", "rc", None).index(channel), int(sequence or 0)
    return ()


def select_release(releases, current, platform):
    installed = version_key(current)
    if not installed:
        return None
    offers = []
    for release in releases:
        version = release["tag_name"].removeprefix("v")
        key = version_key(version)
        if release["draft"] or key <= installed:
            continue
        name = f"Undertone-{version}-{SUFFIXES[platform]}"
        for asset in release["assets"]:
            digest = asset.get("digest") or ""
            if (asset["name"] == name and asset["state"] == "uploaded"
                    and 0 < asset["size"] <= MAX_DOWNLOAD and re.fullmatch(r"sha256:[a-f0-9]{64}", digest)):
                offers.append((key, {"version": version, "id": int(asset["id"]),
                                     "size": asset["size"], "sha256": digest[7:]}))
                break
    return max(offers, key=lambda offer: offer[0])[1] if offers else None


def save_token(path, token):
    if token and not re.fullmatch(r"(?:github_pat_|ghp_)[A-Za-z0-9_]{10,255}", token):
        raise ValueError("Enter a valid GitHub access token.")
    if not token:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="ascii", dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(token)
            file.flush()
            file.close()
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)


def github(session, path, token, accept, *, stream=False):
    headers = {"Accept": accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Undertone-Updater"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return session.get(RELEASES + path, headers=headers, timeout=(10, 30), allow_redirects=False, stream=stream)


def latest_release(session, token, current, platform):
    with github(session, "?per_page=100", token, "application/vnd.github+json") as response:
        if response.status_code in (401, 404):
            raise ValueError("Check the GitHub access token in Update settings." if token
                             else "Connect GitHub in Update settings to check for releases.")
        response.raise_for_status()
        return select_release(response.json(), current, platform)


def write_verified(response, offer, destination):
    response.raise_for_status()
    digest = hashlib.sha256()
    size = 0
    with destination.open("wb") as file:
        for block in response.iter_content(256 * 1024):
            size += len(block)
            if size > offer["size"]:
                break
            file.write(block)
            digest.update(block)
    if size != offer["size"] or digest.hexdigest() != offer["sha256"]:
        raise ValueError("The update download failed its integrity check. Try again.")


def download_release(session, token, offer, destination):
    with github(session, f"/assets/{offer['id']}", token, "application/octet-stream", stream=True) as response:
        if response.status_code == 200:
            write_verified(response, offer, destination)
            return
        if response.status_code != 302:
            response.raise_for_status()
            raise ValueError("GitHub did not provide the update file.")
        url = response.headers.get("Location", "")
        address = urlparse(url)
        if address.scheme != "https" or address.netloc not in ASSET_HOSTS:
            raise ValueError("GitHub did not provide the update file.")
    # Use a fresh request to the signed URL. The GitHub token stays on api.github.com.
    with session.get(url, timeout=(20, 45), allow_redirects=False, stream=True) as response:
        if response.status_code != 200:
            response.raise_for_status()
            raise ValueError("GitHub did not provide the update file.")
        write_verified(response, offer, destination)


def unpack_desktop(archive, destination, platform):
    windows = platform == "windows"
    root = "Undertone" if windows else "linux"
    executable = "Undertone.exe" if windows else "Undertone"
    extras = {"Start here.txt"} if windows else {"icon.png", "install-linux.sh"}
    expanded = 0

    def extract(name, size, directory, open_member):
        nonlocal expanded
        parts = PurePosixPath(name).parts
        if (not parts or parts[0] != root or "\\" in name or ":" in name
                or any(part in (".", "..") or part.endswith((" ", ".")) for part in parts)):
            raise ValueError("The update contains an invalid file path.")
        if len(parts) == 1 and directory:
            return
        if len(parts) < 2 or parts[1] not in {"music", executable, *extras} or (len(parts) > 2 and parts[1] != "music"):
            raise ValueError("The update package has an unexpected layout.")
        expanded += size
        if expanded > MAX_EXPANSION:
            raise ValueError("The update package is too large.")
        path = destination.joinpath(*parts[1:])
        if directory:
            path.mkdir(parents=True, exist_ok=True)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            with open_member() as source, path.open("xb") as output:
                shutil.copyfileobj(source, output)
            if not windows and path.name == executable:
                path.chmod(0o755)

    if windows:
        with zipfile.ZipFile(archive) as files:
            for member in files.infolist():
                extract(member.filename, member.file_size, member.is_dir(), lambda: files.open(member))
    else:
        with tarfile.open(archive, "r|gz") as files:
            for member in files:
                if not (member.isdir() or member.isfile()):
                    raise ValueError("The update contains an unsupported file type.")
                extract(member.name, member.size, member.isdir(), lambda: files.extractfile(member))
    engine = destination / "music"
    if not (destination / executable).is_file() or not (engine / "backend.py").is_file():
        raise ValueError("The update package is incomplete.")
    if windows and not (engine / "python/python.exe").is_file():
        raise ValueError("The update package is incomplete.")
    if not windows and not (destination / "icon.png").is_file():
        raise ValueError("The update package is incomplete.")


def request(operation, current, platform, token_path, value="", destination=""):
    path = Path(token_path)
    token = path.read_text(encoding="ascii").strip() if path.is_file() else ""
    if operation == "token":
        save_token(path, value.strip())
        token = value.strip()
    if operation in ("token", "status"):
        return {"version": current, "configured": bool(token)}

    # Import the already bundled HTTPS client only for network requests.
    vendor = Path(__file__).resolve().parent / "vendor"
    if vendor.is_dir() and str(vendor) not in sys.path:
        sys.path.insert(0, str(vendor))
    import requests

    try:
        with requests.Session() as session:
            # Credentials come from the app's private settings, independent of .netrc.
            session.auth = lambda request: request
            offer = latest_release(session, token, current, platform)
            if operation == "check":
                return {"update": offer and {"version": offer["version"]}}
            if operation != "install" or not offer or offer["version"] != value:
                raise ValueError("The available release changed. Check for updates again.")
            target = Path(destination)
            if platform == "android":
                download_release(session, token, offer, target)
            else:
                archive = target / "release.archive"
                download_release(session, token, offer, archive)
                unpack_desktop(archive, target / "new", platform)
                archive.unlink()
                shutil.copy2(__file__, target / "apply.py")
                if platform == "windows":
                    # Run from outside the installed runtime so Windows can replace it.
                    shutil.copytree(target / "new/music/python", target / "runner",
                                    ignore=shutil.ignore_patterns("deno.exe"))
            return {"ready": True}
    except requests.RequestException as error:
        raise ValueError("Could not reach GitHub. Check your connection and try again.") from error


def rpc(operation, current, platform, token_path, value="", destination=""):
    try:
        return json.dumps({"data": request(operation, current, platform, token_path, value, destination)})
    except ValueError as error:
        return json.dumps({"error": str(error)})
    except (OSError, tarfile.TarError, zipfile.BadZipFile):
        return json.dumps({"error": "Could not prepare the update. Check available space and try again."})


def wait_for_exit(pid):
    if sys.platform == "win32":
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = (ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.WaitForSingleObject.argtypes = (ctypes.c_void_p, ctypes.c_ulong)
        kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
        handle = kernel.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            if ctypes.get_last_error() == 87:  # The process already exited.
                return
            raise OSError("Could not open Undertone's process")
        try:
            if kernel.WaitForSingleObject(handle, 30_000) == 0:
                return
        finally:
            kernel.CloseHandle(handle)
    else:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
    raise OSError("Undertone did not exit")


def apply_desktop(stage, exe):
    """Replace only packaged files. Keep the running version recoverable until the final swap."""
    backup = stage / "previous"
    backup.mkdir()
    new = stage / "new"
    replacements = ["music", "Start here.txt"] if exe.suffix.lower() == ".exe" else ["music", "icon.png"]
    saved = []
    installed = []
    try:
        for name in replacements:
            if not (new / name).exists():
                continue
            destination = exe.parent / name
            if destination.exists():
                destination.replace(backup / name)
                saved.append(name)
            (new / name).replace(destination)
            installed.append(name)
        # Replacing the executable last is an atomic rename on the install volume.
        (new / exe.name).replace(exe)
    except OSError:
        try:
            for name in reversed(installed):
                (exe.parent / name).replace(new / name)
            for name in reversed(saved):
                (backup / name).replace(exe.parent / name)
        except OSError:
            return 2
        return 1
    return 0


def apply_after_exit(stage, exe, pid, status):
    try:
        wait_for_exit(pid)
        result = apply_desktop(stage, exe)
    except OSError:
        result = 1
    if result:
        try:
            status.write_text("restore" if result == 2 else "failed", encoding="ascii")
        except OSError:
            pass
    if sys.platform != "win32":
        if result != 2:
            shutil.rmtree(stage, ignore_errors=True)
        subprocess.Popen([exe], start_new_session=True, cwd=exe.parent)
    return result


if __name__ == "__main__":
    if len(sys.argv) == 6 and sys.argv[1] == "apply":
        sys.exit(apply_after_exit(Path(sys.argv[2]), Path(sys.argv[3]), int(sys.argv[4]), Path(sys.argv[5])))
    print(rpc(**json.load(sys.stdin)))
