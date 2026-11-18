"""Build Undertone Alpha with the original Undertone signing identity."""
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

# Signer of the published v0.0.1-alpha APK (personal.undertone.player).
ORIGINAL_CERTIFICATE = "ea5712d23e62568ceb43333a670275ed50777187fc7c52ce89ad4b8a516b2dfb"

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
    keystore = Path(os.environ.get("UNDERTONE_KEYSTORE") or ROOT / ".private/android-signing.p12")
    password_file = ROOT / ".private/android-signing-password"
    if not env.get("UNDERTONE_SIGNING_PASSWORD") and password_file.is_file():
        env["UNDERTONE_SIGNING_PASSWORD"] = password_file.read_text(encoding="utf-8-sig").rstrip("\r\n")
    if not keystore.is_file() or not env.get("UNDERTONE_SIGNING_PASSWORD"):
        raise SystemExit("Provide .private/android-signing.p12 and .private/android-signing-password, or set UNDERTONE_KEYSTORE and UNDERTONE_SIGNING_PASSWORD.")
    alias = env.get("UNDERTONE_KEY_ALIAS") or "undertone"
    certificate = subprocess.check_output([str(TOOLS / "jdk-21/bin/keytool"), "-exportcert",
        "-keystore", str(keystore), "-alias", alias, "-storepass:env", "UNDERTONE_SIGNING_PASSWORD"], env=env)
    if hashlib.sha256(certificate).hexdigest() != ORIGINAL_CERTIFICATE:
        raise SystemExit(f"The selected key must have certificate SHA-256 {ORIGINAL_CERTIFICATE}.")
    subprocess.run([str(gradle / "bin/gradle"), "--no-daemon", "-p", str(ROOT / "android"), "assembleRelease", "lintRelease"], env=env, check=True)
    build_tools = TOOLS / "android-sdk/build-tools/35.0.0"
    unsigned = ROOT / "android/app/build/outputs/apk/release/app-release-unsigned.apk"
    metadata = json.loads((unsigned.parent / "output-metadata.json").read_text())
    release = next(item["versionName"] for item in metadata["elements"] if item["outputFile"] == unsigned.name)
    output = ROOT / "dist/android" / f"Undertone-{release}-android.apk"
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as stage:
        aligned = Path(stage) / "aligned.apk"
        signed = Path(stage) / "signed.apk"
        subprocess.run([str(build_tools / "zipalign"), "-P", "16", "-f", "4", str(unsigned), str(aligned)], env=env, check=True)
        key_password = "UNDERTONE_KEY_PASSWORD" if env.get("UNDERTONE_KEY_PASSWORD") else "UNDERTONE_SIGNING_PASSWORD"
        subprocess.run([str(build_tools / "apksigner"), "sign", "--ks", str(keystore), "--ks-key-alias", alias,
            "--ks-pass", "env:UNDERTONE_SIGNING_PASSWORD", "--key-pass", f"env:{key_password}",
            "--v4-signing-enabled", "false", "--out", str(signed), str(aligned)], env=env, check=True)
        verification = subprocess.check_output([str(build_tools / "apksigner"), "verify", "--verbose", "--print-certs", str(signed)], env=env, text=True)
        signers = [line.split(": ", 1)[1].strip().lower() for line in verification.splitlines()
                   if line.startswith("Signer #") and " certificate SHA-256 digest: " in line]
        if signers != [ORIGINAL_CERTIFICATE]:
            raise SystemExit("The signed APK did not verify with exactly the original Undertone certificate.")
        subprocess.run([str(build_tools / "zipalign"), "-c", "-P", "16", "4", str(signed)], env=env, check=True)
        signed.replace(output)
    print(f"Built signed APK: {output}")
