"""Install project-local Rust without changing the computer's global setup."""
import hashlib
import os
from pathlib import Path
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".tools"


def environment():
    env = os.environ.copy()
    env["CARGO_HOME"] = str(TOOLS / "cargo")
    env["RUSTUP_HOME"] = str(TOOLS / "rustup")
    env["PATH"] = str(TOOLS / "cargo" / "bin") + os.pathsep + env["PATH"]
    return env


if __name__ == "__main__":
    TOOLS.mkdir(exist_ok=True)
    url = "https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init"
    installer = TOOLS / "rustup-init"
    print("Downloading the official Rust installer…", flush=True)
    data = urllib.request.urlopen(url, timeout=60).read()
    expected = urllib.request.urlopen(url + ".sha256", timeout=60).read().decode().split()[0]
    if hashlib.sha256(data).hexdigest() != expected:
        raise SystemExit("Rust installer checksum did not match")
    installer.write_bytes(data)
    installer.chmod(0o755)
    subprocess.run([str(installer), "-y", "--no-modify-path", "--profile", "minimal", "--default-toolchain", "stable"], env=environment(), check=True)
