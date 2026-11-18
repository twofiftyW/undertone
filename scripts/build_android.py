"""Build and privately sign an Android APK; nothing is uploaded or published."""
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from bootstrap import ROOT, TOOLS
from android_setup import android_environment, download

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
    subprocess.run([str(gradle / "bin/gradle"), "--no-daemon", "-p", str(ROOT / "android"), "assembleRelease", "lintRelease"], env=env, check=True)
    private = ROOT / ".private"
    private.mkdir(mode=0o700, exist_ok=True)
    password_file = private / "android-signing-password"
    if not password_file.exists():
        password_file.write_text(secrets.token_urlsafe(32))
        password_file.chmod(0o600)
    env["UNDERTONE_SIGNING_PASSWORD"] = password_file.read_text()
    keystore = private / "android-signing.p12"
    if not keystore.exists():
        subprocess.run([str(TOOLS / "jdk-21/bin/keytool"), "-genkeypair", "-alias", "undertone", "-keystore", str(keystore), "-storetype", "PKCS12", "-storepass:env", "UNDERTONE_SIGNING_PASSWORD", "-keypass:env", "UNDERTONE_SIGNING_PASSWORD", "-dname", "CN=Undertone Personal", "-keyalg", "RSA", "-keysize", "2048", "-validity", "10000"], env=env, check=True)
        keystore.chmod(0o600)
    build_tools = TOOLS / "android-sdk/build-tools/35.0.0"
    unsigned = ROOT / "android/app/build/outputs/apk/release/app-release-unsigned.apk"
    aligned = TOOLS / "android-aligned.apk"
    output = ROOT / "dist/android/Undertone-0.0.2-alpha.apk"
    output.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run([str(build_tools / "zipalign"), "-P", "16", "-f", "4", str(unsigned), str(aligned)], env=env, check=True)
    subprocess.run([str(build_tools / "apksigner"), "sign", "--ks", str(keystore), "--ks-key-alias", "undertone", "--ks-pass", "env:UNDERTONE_SIGNING_PASSWORD", "--out", str(output), str(aligned)], env=env, check=True)
    subprocess.run([str(build_tools / "apksigner"), "verify", "--verbose", str(output)], env=env, check=True)
    subprocess.run([str(build_tools / "zipalign"), "-c", "-P", "16", "4", str(output)], env=env, check=True)
    print(f"Built signed APK: {output}")
