"""Build the native iOS app with Xcode's SDK and the pinned CPython XCFramework."""
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tarfile
import urllib.request

from bootstrap import ROOT, TOOLS

PYTHON_URL = "https://github.com/beeware/Python-Apple-support/releases/download/3.14-b13/Python-3.14-iOS-support.b13.tar.gz"
PYTHON_SHA256 = "ce1c68affa1cbd9c5611a0f4a013e412f14a760cf22c6bb58cfb4d893073bd45"
BUNDLE_ID = "personal.undertone.player"


def run(*args, **options):
    subprocess.run(args, check=True, **options)


def support():
    directory = TOOLS / "ios-python"
    directory.mkdir(parents=True, exist_ok=True)
    archive = directory / "support.tar.gz"
    if not archive.exists():
        with urllib.request.urlopen(PYTHON_URL, timeout=120) as response, archive.open("wb") as stream:
            shutil.copyfileobj(response, stream)
    with archive.open("rb") as stream:
        if hashlib.file_digest(stream, "sha256").hexdigest() != PYTHON_SHA256:
            archive.unlink()
            raise SystemExit("The iOS Python archive checksum did not match.")
    xcframework = directory / "Python.xcframework"
    if not (xcframework / "Info.plist").is_file():
        with tarfile.open(archive) as package:
            package.extractall(directory, filter="data")
    return xcframework


def build(sdk, xcframework, version):
    simulator = sdk == "iphonesimulator"
    arch = platform.machine() if simulator else "arm64"
    target = f"{arch}-apple-ios16.0" + ("-simulator" if simulator else "")
    slice_path = xcframework / ("ios-arm64_x86_64-simulator" if simulator else "ios-arm64")
    app = ROOT / "dist" / "ios" / sdk / ("Undertone.app" if simulator else "Payload/Undertone.app")
    app.mkdir(parents=True, exist_ok=True)
    frameworks = app / "Frameworks"
    shutil.copytree(slice_path / "Python.framework", frameworks / "Python.framework", dirs_exist_ok=True)
    shutil.copytree(ROOT / "web", app / "web", dirs_exist_ok=True)
    engine = app / "engine"
    engine.mkdir(exist_ok=True)
    for source in (ROOT / "music").glob("*.py"):
        shutil.copy2(source, engine)
    shutil.copy2(ROOT / "ios/runtime.py", engine)

    run(sys.executable, "-m", "pip", "install", "--only-binary=:all:", "--target", str(engine),
        "--no-compile", "-r", str(ROOT / "music/requirements.txt"), "yt-dlp==2026.10.26")
    run("xcrun", "--sdk", sdk, "clang", "-target", target, "-fobjc-arc", "-O2",
        "-I", str(slice_path / "include/python3.14"), "-F", str(slice_path),
        "-framework", "Python", "-framework", "UIKit", "-framework", "WebKit", "-framework", "AVFoundation",
        "-Wl,-rpath,@executable_path/Frameworks", str(ROOT / "ios/main.m"), "-o", str(app / "Undertone"))
    for scale in ("2x", "3x"):
        shutil.copy2(ROOT / "src-tauri/icons/ios" / f"AppIcon-60x60@{scale}.png", app / f"UndertoneIcon@{scale}.png")
    info = {
        "CFBundleDevelopmentRegion": "en", "CFBundleDisplayName": "Undertone",
        "CFBundleIcons": {"CFBundlePrimaryIcon": {"CFBundleIconFiles": ["UndertoneIcon"]}},
        "UndertoneVersion": version,
        "CFBundleExecutable": "Undertone", "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleName": "Undertone", "CFBundlePackageType": "APPL",
        "CFBundleVersion": "20", "CFBundleShortVersionString": version.split("-")[0],
        "CFBundleSupportedPlatforms": ["iPhoneSimulator" if simulator else "iPhoneOS"],
        "MinimumOSVersion": "16.0", "UIDeviceFamily": [1, 2], "UILaunchScreen": {},
        "UIBackgroundModes": ["audio"],
        "NSLocalNetworkUsageDescription": "Connect to Undertone on your computer to copy your library.",
        "NSAppTransportSecurity": {"NSAllowsLocalNetworking": True},
        "UISupportedInterfaceOrientations": ["UIInterfaceOrientationPortrait", "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight"],
    }
    (app / "Info.plist").write_bytes(plistlib.dumps(info))
    environment = {
        **os.environ, "PROJECT_DIR": str(xcframework.parent), "CODESIGNING_FOLDER_PATH": str(app),
        "EFFECTIVE_PLATFORM_NAME": "-" + sdk, "ARCHS": arch, "PLATFORM_FAMILY_NAME": "iOS",
        "PRODUCT_BUNDLE_IDENTIFIER": BUNDLE_ID, "EXPANDED_CODE_SIGN_IDENTITY": "-",
        "EXPANDED_CODE_SIGN_IDENTITY_NAME": "Ad hoc",
    }
    run("bash", "-ec", 'source "$PROJECT_DIR/Python.xcframework/build/utils.sh"\n'
        'install_stdlib Python.xcframework\nprocess_dylibs Python.xcframework python/lib/python3.14/lib-dynload',
        env=environment)
    run("codesign", "--force", "--sign", "-", str(frameworks / "Python.framework"))
    run("codesign", "--force", "--sign", "-", str(app))
    run("codesign", "--verify", "--deep", "--strict", str(app))

    output = ROOT / "dist" / ("Undertone-" + version + (f"-ios-simulator-{arch}.zip" if simulator else "-ios-unsigned.ipa"))
    output.unlink(missing_ok=True)
    payload = app if simulator else app.parent
    run("ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(payload), str(output))
    print(output)


if __name__ == "__main__":
    if sys.platform != "darwin":
        raise SystemExit("The iOS build requires a Mac with Xcode.")
    version = json.loads((ROOT / "src-tauri/tauri.conf.json").read_text())["version"]
    framework = support()
    for sdk in ("iphoneos", "iphonesimulator"):
        build(sdk, framework, version)
