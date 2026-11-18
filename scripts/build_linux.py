"""Build the native Linux app and package its local music engine."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from bootstrap import ROOT, TOOLS, environment


if __name__ == "__main__":
    vendor = ROOT / "music/vendor"
    if not (vendor / "requests").is_dir():
        uv = shutil.which("uv") or str(Path.home() / ".local/bin/uv")
        installer = [uv, "pip", "install", "--python", sys.executable] if Path(uv).is_file() else [sys.executable, "-m", "pip", "install"]
        subprocess.run([*installer, "--target", str(vendor), "-r", str(ROOT / "music/requirements.txt")], check=True)
    env = environment() if (TOOLS / "cargo/bin/cargo").exists() else os.environ.copy()
    env.setdefault("CARGO_BUILD_JOBS", "4")
    node = shutil.which("node") or str(Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node")
    env["PATH"] = str(Path(node).parent) + os.pathsep + env["PATH"]
    subprocess.run([node, "node_modules/@tauri-apps/cli/tauri.js", "build", "--no-bundle"], cwd=ROOT, env=env, check=True)
    package = ROOT / "dist/linux"
    package.mkdir(parents=True, exist_ok=True)
    temporary = package / ".Undertone.next"
    shutil.copy2(ROOT / "src-tauri/target/release/undertone", temporary)
    temporary.chmod(0o755)
    temporary.replace(package / "Undertone")
    engine = package / "music"
    if engine.exists():
        shutil.rmtree(engine)
    engine.mkdir()
    for name in ("backend.py", "monochrome.py", "offline.py", "spotify_import.py", "spotify_job.py",
                 "desktop_spotify.py", "desktop_import_notification.py", "device_sync.py", "requirements.txt"):
        shutil.copy2(ROOT / "music" / name, engine / name)
    shutil.copytree(vendor, engine / "vendor", ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "ytmusicapi", "ytmusicapi-*.dist-info"))
    shutil.copy2(ROOT / "src-tauri/icons/128x128@2x.png", package / "icon.png")
    shutil.copy2(ROOT / "install-linux.sh", package / "install-linux.sh")
    version = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["version"]
    archive = ROOT / "dist" / f"Undertone-{version}-linux-x86_64"
    shutil.make_archive(str(archive), "gztar", package.parent, package.name)
    print(f"Linux package ready: {archive}.tar.gz")
