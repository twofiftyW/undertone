"""Build Undertone Alpha with the existing release signing identity."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from bootstrap import ROOT, TOOLS
from android_setup import android_environment, download

# SHA-256 of the public signer certificate used by the first Alpha release.
ALPHA_CERTIFICATE = "46ae5a1d16f8aef1a67ae2e758e6864dcaf967bfb85a282f4211c09aa4c38f74"

if __name__ == "__main__":
    version = "8.13"
    gradle = TOOLS / f"gradle-{version}"
    if not gradle.exists():
        url = f"https://downloads.gradle.org/distributions/gradle-{version}-bin.zip"
        checksum = urllib.request.urlopen(url + ".sha256", timeout=60).read().decode().split()[0]
        downloads = TOOLS / "downloads"
        downloads.mkdir(parents=True, exist_ok=True)
        archive = downloads / f"gradle-{version}.zip"
        download(url, archive, checksum)
        with zipfile.ZipFile(archive) as files:
            files.extractall(TOOLS)
        (gradle / "bin/gradle").chmod(0o755)
    if "--prepare-only" in sys.argv:
        print("Gradle is ready.")
        raise SystemExit(0)
    env = android_environment()
    keystore = Path(os.environ.get("UNDERTONE_ALPHA_KEYSTORE") or ROOT / ".private/undertone-alpha.p12")
    if not keystore.is_file() or not env.get("UNDERTONE_SIGNING_PASSWORD"):
        raise SystemExit("Set UNDERTONE_ALPHA_KEYSTORE to the existing Alpha keystore and UNDERTONE_SIGNING_PASSWORD to its password.")
    alias = "undertone-alpha"
    certificate = subprocess.check_output([str(TOOLS / "jdk-21/bin/keytool"), "-exportcert",
        "-keystore", str(keystore), "-alias", alias, "-storepass:env", "UNDERTONE_SIGNING_PASSWORD"], env=env)
    if hashlib.sha256(certificate).hexdigest() != ALPHA_CERTIFICATE:
        raise SystemExit("The supplied signing certificate does not match the published Undertone Alpha app.")
    subprocess.run([str(gradle / "bin/gradle"), "--no-daemon", "-p", str(ROOT / "android"), "assembleRelease", "lintRelease"], env=env, check=True)
    build_tools = TOOLS / "android-sdk/build-tools/35.0.0"
    unsigned = ROOT / "android/app/build/outputs/apk/release/app-release-unsigned.apk"
    release = json.loads((ROOT / "package.json").read_text())["version"]
    output = ROOT / "dist/android" / f"Undertone-{release}-android.apk"
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as stage:
        aligned = Path(stage) / "aligned.apk"
        signed = Path(stage) / "signed.apk"
        subprocess.run([str(build_tools / "zipalign"), "-P", "16", "-f", "4", str(unsigned), str(aligned)], env=env, check=True)
        subprocess.run([str(build_tools / "apksigner"), "sign", "--ks", str(keystore), "--ks-key-alias", alias,
            "--ks-pass", "env:UNDERTONE_SIGNING_PASSWORD", "--key-pass", "env:UNDERTONE_SIGNING_PASSWORD",
            "--v4-signing-enabled", "false", "--out", str(signed), str(aligned)], env=env, check=True)
        subprocess.run([str(build_tools / "apksigner"), "verify", "--verbose", str(signed)], env=env, check=True)
        subprocess.run([str(build_tools / "zipalign"), "-c", "-P", "16", "4", str(signed)], env=env, check=True)
        signed.replace(output)
    print(f"Built signed APK: {output}")
