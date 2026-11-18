"""Download an isolated Android build toolchain for this private project."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from bootstrap import ROOT, TOOLS, environment


def download(url, path, checksum=None, algorithm="sha256"):
    if path.exists() and checksum and hashlib.file_digest(path.open("rb"), algorithm).hexdigest() == checksum:
        return
    offset = path.stat().st_size if path.exists() else 0
    print(f"Downloading {path.name}…", flush=True)
    request = urllib.request.Request(url, headers={"Range": f"bytes={offset}-"} if offset else {})
    with urllib.request.urlopen(request, timeout=90) as response, path.open("ab" if response.status == 206 and offset else "wb") as output:
        shutil.copyfileobj(response, output)
    if checksum and hashlib.file_digest(path.open("rb"), algorithm).hexdigest() != checksum:
        path.unlink()
        raise RuntimeError(f"Checksum mismatch: {path.name}")


def android_environment():
    env = environment()
    env["JAVA_HOME"] = str(TOOLS / "jdk-21")
    env["ANDROID_HOME"] = str(TOOLS / "android-sdk")
    env["ANDROID_SDK_ROOT"] = env["ANDROID_HOME"]
    env["ANDROID_USER_HOME"] = str(TOOLS / "android-user")
    env["GRADLE_USER_HOME"] = str(TOOLS / "gradle")
    ndks = list((TOOLS / "android-sdk" / "ndk").glob("*"))
    if ndks:
        env["NDK_HOME"] = str(sorted(ndks)[-1])
        env["ANDROID_NDK_HOME"] = env["NDK_HOME"]
    env["PATH"] = str(TOOLS / "jdk-21" / "bin") + os.pathsep + env["PATH"]
    return env


if __name__ == "__main__":
    downloads = TOOLS / "downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    java_dir = TOOLS / "jdk-21"
    if not java_dir.exists():
        request = urllib.request.Request("https://api.github.com/repos/adoptium/temurin21-binaries/releases/latest", headers={"User-Agent": "Undertone-build"})
        release = json.load(urllib.request.urlopen(request, timeout=60))
        package = next(a for a in release["assets"] if a["name"].startswith("OpenJDK21U-jdk_x64_linux_hotspot_") and a["name"].endswith(".tar.gz"))
        checksum = urllib.request.urlopen(package["browser_download_url"] + ".sha256.txt", timeout=60).read().decode().split()[0]
        archive = downloads / "jdk-21.tar.gz"
        download(package["browser_download_url"], archive, checksum)
        with tarfile.open(archive) as tar:
            top = tar.getmembers()[0].name.split("/")[0]
            tar.extractall(TOOLS, filter="data")
        (TOOLS / top).rename(java_dir)

    repository = ET.fromstring(urllib.request.urlopen("https://dl.google.com/android/repository/repository2-3.xml", timeout=60).read())
    packages = {element.attrib["path"]: element for element in repository if element.tag.endswith("remotePackage")}
    sdk = TOOLS / "android-sdk"
    manager = sdk / "cmdline-tools/latest/bin/sdkmanager"
    if not manager.exists():
        package = packages["cmdline-tools;latest"]
        archive_info = next(a for a in package.findall("archives/archive") if a.findtext("host-os") == "linux")
        url = archive_info.findtext("complete/url")
        archive = downloads / "android-commandline-tools.zip"
        download("https://dl.google.com/android/repository/" + url, archive, archive_info.findtext("complete/checksum"), "sha1")
        temporary = TOOLS / "android-unpack"
        with zipfile.ZipFile(archive) as files:
            files.extractall(temporary)
        (sdk / "cmdline-tools").mkdir(parents=True, exist_ok=True)
        shutil.move(temporary / "cmdline-tools", sdk / "cmdline-tools/latest")
        for executable in (sdk / "cmdline-tools/latest/bin").iterdir():
            executable.chmod(0o755)

    env = android_environment()
    print("Preparing the Android SDK…", flush=True)
    # The newest shell launcher delegates to an updater that can fail mid-update.
    # The official Java entry point is shipped in the same verified tool archive.
    classpath = os.pathsep.join(str(p) for p in (sdk / "cmdline-tools/latest/lib").rglob("*.jar"))
    command = [str(TOOLS / "jdk-21/bin/java"), "-cp", classpath, "com.android.sdklib.tool.sdkmanager.SdkManagerCli", "--sdk_root=" + str(sdk)]
    with (TOOLS / "android-setup.log").open("w") as log:
        subprocess.run(command + ["--licenses"], input="y\n" * 100, text=True, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
        subprocess.run(command + ["platforms;android-35", "build-tools;35.0.0"], env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
    print("Android build tools ready.", flush=True)
