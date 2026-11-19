import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "music"))
import updates


class ReleaseUpdates(unittest.TestCase):
    def test_release_selection_honors_platform_and_version(self):
        def release(tag, platform, draft=False, digest="sha256:" + "a" * 64):
            version = tag.removeprefix("v")
            return {
                "tag_name": tag, "draft": draft,
                "assets": [{"id": 1, "size": 128, "digest": digest, "state": "uploaded",
                            "name": f"Undertone-{version}-{updates.SUFFIXES[platform]}"}],
            }

        releases = [release("v0.0.9", "android"), release("v0.0.20", "linux", True),
                    release("v0.0.10", "linux"), release("v0.0.30", "linux", digest=None),
                    release("v0.0.8-alpha", "linux"), release("v0.0.8", "linux")]
        self.assertEqual(updates.select_release(releases, "0.0.7-alpha", "linux")["version"], "0.0.10")
        self.assertEqual(updates.select_release(releases, "0.0.8", "android")["version"], "0.0.9")
        self.assertIsNone(updates.select_release(releases, "0.0.10", "linux"))
        self.assertIsNone(updates.select_release(releases, "0.0.7", "windows"))
        self.assertLess(updates.version_key("0.0.8-rc.2"), updates.version_key("0.0.8"))

    def test_corrupted_download_is_rejected(self):
        class Download:
            def raise_for_status(self):
                pass

            def iter_content(self, _):
                yield b"bad"

        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "asset"
            with self.assertRaisesRegex(ValueError, "integrity check"):
                updates.write_verified(Download(), {"size": 3, "sha256": hashlib.sha256(b"apk").hexdigest()}, file)

    def test_desktop_replacement_and_recovery_preserve_other_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            exe = root / "Undertone.exe"
            exe.write_bytes(b"old")
            (root / "tracks").write_bytes(b"user files")
            (root / "music").mkdir()
            (root / "music/backend.py").write_bytes(b"old engine")
            stage = root / "stage"
            archive = root / "release.zip"
            with zipfile.ZipFile(archive, "w") as files:
                files.writestr("Undertone/Undertone.exe", b"new")
                files.writestr("Undertone/music/backend.py", b"new engine")
                files.writestr("Undertone/music/python/python.exe", b"runtime")

            updates.unpack_desktop(archive, stage / "new", "windows")
            real_replace = Path.replace

            def fail_final_swap(path, target):
                if target == exe:
                    raise PermissionError("locked")
                return real_replace(path, target)

            with patch.object(Path, "replace", fail_final_swap):
                self.assertEqual(updates.apply_desktop(stage, exe), 1)
            self.assertEqual(exe.read_bytes(), b"old")
            self.assertEqual((root / "music/backend.py").read_bytes(), b"old engine")

            (stage / "previous").rmdir()
            self.assertEqual(updates.apply_desktop(stage, exe), 0)
            self.assertEqual(exe.read_bytes(), b"new")
            self.assertEqual((root / "music/backend.py").read_bytes(), b"new engine")
            self.assertEqual((root / "tracks").read_bytes(), b"user files")

    def test_archive_paths_cannot_escape_the_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "release.zip"
            with zipfile.ZipFile(archive, "w") as files:
                files.writestr("Undertone/music/../../../outside", "unexpected")
            with self.assertRaises(ValueError):
                updates.unpack_desktop(archive, root / "stage", "windows")
            self.assertFalse((root.parent / "outside").exists())


if __name__ == "__main__":
    unittest.main()
