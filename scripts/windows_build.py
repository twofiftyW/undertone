"""Cross-build and package Undertone for Windows x64."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from bootstrap import ROOT, TOOLS, environment

PYTHON_VERSION = "3.14.9"
PYTHON_SHA256 = "3c01d7cfc666f746a6f064f60fb2156ab0ec464d3d738ab796371a46a9bb24a2"


def prepare_runtime(directory):
    runtime = directory / "python"
    if not (runtime / "python.exe").is_file():
        name = f"python-{PYTHON_VERSION}-embed-amd64.zip"
        data = urllib.request.urlopen(f"https://www.python.org/ftp/python/{PYTHON_VERSION}/{name}", timeout=90).read()
        if hashlib.sha256(data).hexdigest() != PYTHON_SHA256:
            raise SystemExit("Windows Python runtime checksum did not match")
        path = directory / name
        path.write_bytes(data)
        with zipfile.ZipFile(path) as archive:
            archive.extractall(runtime)
    vendor = directory / "vendor"
    uv = shutil.which("uv") or str(Path.home() / ".local/bin/uv")
    subprocess.run([uv, "pip", "install", "--target", str(vendor), "--python-platform", "x86_64-pc-windows-msvc",
                    "--python-version", "3.14", "--only-binary", ":all:", "--no-compile", "-r",
                    str(ROOT / "music/requirements-windows.txt")], check=True)
    return runtime, vendor


def package(runtime, vendor):
    version = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["version"]
    release = ROOT / "src-tauri/target/x86_64-pc-windows-msvc/release/undertone.exe"
    output = ROOT / "dist" / f"Undertone-{version}-windows-x64.zip"
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=TOOLS / "windows") as temporary:
        folder = Path(temporary) / "Undertone"
        music = folder / "music"
        music.mkdir(parents=True)
        shutil.copy2(release, folder / "Undertone.exe")
        for name in ("backend.py", "monochrome.py", "offline.py", "spotify_import.py", "spotify_job.py",
                     "desktop_spotify.py", "desktop_import_notification.py", "device_sync.py", "updates.py"):
            shutil.copy2(ROOT / "music" / name, music / name)
        shutil.copytree(runtime, music / "python")
        shutil.copytree(vendor, music / "vendor", ignore=shutil.ignore_patterns("__pycache__", "bin"))
        shutil.copy2(vendor / "bin/deno.exe", music / "python/deno.exe")
        (folder / "Start here.txt").write_text("Extract the entire Undertone folder. Open Undertone.exe.\n"
            "Undertone Alpha requires 64-bit Windows 10 or newer and the Microsoft Edge WebView2 Runtime.\n"
            "Get WebView2 at https://developer.microsoft.com/microsoft-edge/webview2/ if Windows asks.\n",
            encoding="utf-8")
        shutil.make_archive(str(output.with_suffix('')), 'zip', temporary, 'Undertone')
    print(f"Packaged Windows build: {output}", flush=True)


if __name__ == "__main__":
    directory = TOOLS / "windows"
    directory.mkdir(parents=True, exist_ok=True)
    runtime, vendor = prepare_runtime(directory)
    if "--prepare-runtime" in sys.argv:
        raise SystemExit(0)
    executable = directory / "cargo-xwin"
    if not executable.exists():
        package = json.load(urllib.request.urlopen("https://pypi.org/pypi/cargo-xwin/0.23.1/json", timeout=60))
        wheel = next(f for f in package["urls"] if "manylinux" in f["filename"] and "x86_64" in f["filename"])
        data = urllib.request.urlopen(wheel["url"], timeout=90).read()
        if hashlib.sha256(data).hexdigest() != wheel["digests"]["sha256"]:
            raise SystemExit("Windows build-helper checksum did not match")
        archive = directory / "cargo-xwin.whl"
        archive.write_bytes(data)
        with zipfile.ZipFile(archive) as files:
            name = next(n for n in files.namelist() if n.endswith("/cargo-xwin"))
            executable.write_bytes(files.read(name))
        executable.chmod(0o755)
    env = environment()
    env["PATH"] = str(directory) + os.pathsep + env["PATH"]
    # cargo-xwin rejects spaces in linker flags, so its SDK needs a space-free path.
    sdk_cache = Path(tempfile.gettempdir()) / f"undertone-xwin-{os.getuid()}"
    if not sdk_cache.exists() and (directory / "sdk").exists():
        shutil.move(directory / "sdk", sdk_cache)
    env["XWIN_CACHE_DIR"] = str(sdk_cache)
    env["XWIN_ACCEPT_LICENSE"] = "1"
    env["CARGO_BUILD_JOBS"] = "4"
    subprocess.run([str(TOOLS / "cargo/bin/rustup"), "target", "add", "x86_64-pc-windows-msvc"], env=env, check=True)
    node = shutil.which("node") or str(Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node")
    env["PATH"] = str(Path(node).parent) + os.pathsep + env["PATH"]
    try:
        subprocess.run([node, "node_modules/@tauri-apps/cli/tauri.js", "build", "--runner", "cargo-xwin", "--target", "x86_64-pc-windows-msvc", "--no-bundle"], cwd=ROOT, env=env, check=True)
        package(runtime, vendor)
    finally:
        if sdk_cache.exists() and not (directory / "sdk").exists():
            shutil.move(sdk_cache, directory / "sdk")
