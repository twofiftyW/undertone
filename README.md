# Undertone

A private music player for Linux, Windows, and Android. **Undertone 0.0.1-alpha** supports Linux x86_64, Windows 10/11 x64, and Android 8+ on arm64-v8a and x86_64.

Songs, artists, albums, and release tracks use Monochrome. When Monochrome has no song match, search and Spotify matching try YouTube. There is also a separate Music videos search and a “Search YouTube songs too” button. Linux playback uses mpv with its own **Undertone** mixer identity, so another mpv application’s saved mute/volume settings do not silence this app. The app follows your system’s default output. Only one Undertone instance runs in a desktop session.

## Open the app

- **Linux:** Extract the `linux-x86_64.tar.gz` archive, then run `./install-linux.sh` from its `linux` folder. Open Undertone from your app launcher. In a source checkout, `./run.sh` opens the packaged Linux build.
- **Windows:** Extract the entire `windows-x64.zip` archive and run `Undertone.exe` inside the Undertone folder. [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) is required. Python and the music engine are included.
- **Android:** Open `Undertone-0.0.1-alpha.apk` on your phone. This build uses the same signing key as the previous Undertone APK.

Use **Language → Русский** in the top bar to switch the interface. The setting is saved on each device.

Keep the entire `dist/linux/` directory together: the executable needs `music/`. System requirements are Python 3, mpv, yt-dlp, Deno, OpenSSL, iproute2, WebKitGTK 4.1, GTK 3, audio support, and the desktop’s session D-Bus. These are present on the development computer. Catalog Python dependencies are bundled.

## Download music for offline playback

- Open a song’s **…** menu and choose **Download for offline listening**.
- On an album, use **Download album**. Discography releases have a download button too.
- On a playlist or **Liked songs**, use **Download all** to queue every downloadable song. It skips saved copies, queued songs, and local files, and reports failures for retry.
- Open **Downloads** in the sidebar for saved songs. Its **Downloads** button shows queue status and failures. You can stop queued work after the current song, or retry failures.
- **Remove download** removes only the saved copy, leaving the song in your library and playlists.

Playback checks for a complete local copy before resolving an internet stream, including after an app restart. Completed files play directly from the device. Partially downloaded files are never listed as available offline. Transfers use validated byte ranges to continue when the provider closes a connection early; the final filename appears only after all expected bytes have arrived.

Downloads cover Monochrome songs and matched YouTube song fallbacks, including Spotify imports. Imported audio files are already local. YouTube sign-in or regional checks can prevent playback/downloads; these errors are shown and never bypassed. Music-video audio is not included in the offline downloader. Each recording is limited to 512 MB, and downloads reserve some free disk space. Artwork and discovery are still online features. PC-to-phone library copying is available below.

## Import Spotify playlists and Liked Songs

Choose **Import Spotify** in the sidebar or Your library.

1. Select a Spotify account-data **ZIP**, its **Playlist / YourLibrary JSON files**, or a playlist **CSV** with song titles and artists. The dialog can open Spotify’s account privacy page to help obtain an export.
2. Review the collections. Choose **New playlist** or **Liked Songs** for each; YourLibrary files are detected as liked songs automatically.
3. Choose **Import selected collections**. Existing playlists are preserved. Normal playlists are added as new collections, while liked songs merge into Undertone’s Liked Songs.
4. Recordings are matched against Monochrome using titles, artists, versions, and available duration/ISRC information, then YouTube if no clear match is found. Unclear matches stay as visible entries with **Choose recording**. Select a candidate to replace that entry throughout its playlists and Liked Songs.

Playlist positions and repeated entries are retained. Existing liked-song membership is preserved and deduplicated when matches resolve to the same recording. Spotify identifiers are kept as metadata. **Pause matching** stops after the current batch; **Match remaining songs** resumes work. You can close the dialog and listen while matching continues.

Export files are parsed on this device. Only song metadata needed for matching is looked up in the music catalog. ZIP files are read without extracting their contents; unrelated account-data JSON files are skipped. Supported limits are 32 MB per uploaded file, 100 MB of relevant expanded ZIP contents, and 20,000 song entries per import.

Public Spotify playlist links are a best-effort alternative. Spotify may expose only a preview or no track list at all. The dialog labels preview imports; use an export for a complete playlist. Liked Songs and private collections require an export file. This import flow does not require configuring a Spotify developer app, and it does not copy Spotify’s encrypted audio files.

## Listening and your library

Artist and album names open dedicated pages. Discography has album/single filters, date/name sorting, and list/grid views. Home features artists from your recent listening, with likes and follows filling available spots. It filters out recently played tracks and includes related artists when Monochrome supplies them. A new library starts with a search prompt. Artist mixes play additional tracks by the selected artist. Music videos remain separate YouTube results and play their audio through the same player. Releases with no usable artwork automatically show a four-tile cover made from their first four songs. Missing song artwork uses generated title/color tiles; playlist covers use the same approach.

Import or drag local audio into the app. Originals stay in place. Space plays/pauses, `/` opens search, and `M` mutes. The player’s **…** sound button shows the current mixer state and can restore Undertone’s output without changing other applications or the system master volume.

Linux metadata normally lives at `~/.local/share/personal.undertone.player/library.json`, imported copies in `audio/`, and completed downloads in `downloads/`. Existing imports, likes, playlists, and follows retain the version-1 format, with optional download/import metadata. Installation updates app files separately under `~/.local/share/undertone/`.

The app adds no advertising or analytics. Online search, artwork, matching, and streams contact the chosen providers. Their availability can change, and not every recording is guaranteed. No browser cookies or signed-in YouTube account are loaded.

## Playlists and queue

Library and sidebar playlists automatically put **pinned playlists first**, followed by the playlists you most recently played. Playing a playlist, including a song selected inside it, moves it up among the unpinned playlists. Use the pin button on a Library playlist card or **Pin playlist / Unpin** inside its page. Pin choices and playback history are saved, including Android playback while the interface is in the background. Copying the PC library preserves existing phone pin choices and recent playback.

Open the queue using its player button. On a small phone screen, expand Now playing first to reach that button. Drag entries to reorder them, or use the **up/down arrows** on either platform. Moving entries keeps the playing occurrence and its playback position, even with repeated songs. Use **×** to remove another queued entry without deleting it from its playlist.

Use **+** or **Add to queue** to put a song first under **Up next**. On Android, swipe a song row right to do the same. Album pages can add an entire release, in album order, at the front of the queue. Adding or reordering turns shuffle off so the selected order is followed.

The player prepares the following recording before the current one ends. Linux keeps its mpv audio process/output and advances its internal playlist; Android prepares a second native player and hands audio over through the media framework. Preloading follows queue edits, shuffle, repeat, and local-first source selection. Slow or unavailable streams can still delay a transition.

## Build Linux

Install Node.js, Rust, Tauri’s Linux development prerequisites, Python 3, mpv, yt-dlp, Deno, and uv or pip. Then:

```sh
npm install
npm test
python3 tests/music_test.py
python3 tests/features_test.py
python3 tests/v05_test.py
python3 scripts/build_linux.py
./install-linux.sh
```

The helper installs `music/requirements.txt` dependencies if needed, builds a release executable, and packages the engine. It uses the project-local Rust toolchain when present; `python3 scripts/bootstrap.py` prepares it. `npm run dev` starts native development after dependencies are ready.

Optional checks include `cargo test --manifest-path src-tauri/Cargo.toml --lib`, `python3 tests/catalog_live.py`, and `python3 tests/single_instance.py`. Live evidence and private backups remain in ignored `.tools/` and are excluded from packages. The development-only preview server is not needed by the installed app.

## Android and PC connection

Install the signed **dist/android/Undertone-0.0.1-alpha.apk** on your phone. Transfer it by USB or your usual file-sharing method, open it in the phone’s file manager, and allow installation from that app if Android asks. It is a standalone app with the music engine included: Monochrome search, artist pages, playback, Spotify export import, and offline downloads work without your PC. Background audio uses Android’s media service and lock-screen controls. Updates use the existing private signing key.

To copy your PC library:

1. Put phone and PC on the **same Wi-Fi**. Keep both apps open while copying.
2. On Linux or Windows, open **Library → Connect phone → Enable phone connection**. The sidebar’s **Connect devices** opens the same dialog.
3. On Android, open **Library → Connect PC**. Enter the PC address and full pairing code, then tap **Pair with PC**.
4. Tap **Copy from PC**. Leave **Copy saved audio for offline listening** checked to copy completed downloads and imported files, or uncheck it to copy playlists/metadata only.
5. After completion, copied audio plays from phone storage even with Wi-Fi off. To refresh later, enable the PC connection and tap **Copy from PC** again. The phone remembers its paired PC.

Copying adds PC Liked Songs and updates copies of the PC playlists while keeping phone-only collections. Repeated entries and track order remain intact. Songs only liked or put in a playlist on the PC are metadata until downloaded; complete downloads and imported audio are the files copied. Matching completed audio files are skipped on repeat copies. Transfers are size- and SHA-256-checked before an atomic rename. An interrupted copy preserves previous files and the phone library; retry to continue with already completed files skipped. This is a manual one-way PC-to-phone copy, not cloud or two-way live sync.

The PC connection is opt-in, stops when the app closes, and must be enabled again after reopening. It uses pinned TLS on local TCP **47832**, a one-use ten-minute pairing PIN, saved device tokens, and LAN-only requests. **Forget paired phones** revokes PC access; **Forget PC** on Android removes its saved link. No other folders are shared.

This computer has UFW enabled. If the phone cannot connect, click **Allow phone through firewall** in the PC connection dialog and approve Linux’s system password prompt. That button allows only TCP 47832 from the PC’s private local subnet. You can also configure this rule in your firewall settings. The rule does not start the connection by itself. On Windows, allow the packaged Python runtime on private networks if Windows Firewall asks.

Build Android with `python3 scripts/android_setup.py` once, then `python3 scripts/build_android.py`. Gradle builds and lints the release, aligns it, signs it locally, and verifies the signature. The app embeds the same Python music modules using Chaquopy; no Python install is needed on the phone. Android’s YouTube extraction has no bundled external JavaScript executable, so availability may differ from the Linux yt-dlp/Deno setup.

## Build Windows

On a Linux development machine, use `python3 scripts/bootstrap.py` to prepare the project-local Rust toolchain and install Node.js, `clang-cl`, `lld-link`, and `uv`. Run `npm install`, then `python3 scripts/windows_build.py`. It cross-builds the x64 executable and packages the Windows Python runtime, catalog tools, and WebView2 app in `dist/Undertone-0.0.1-alpha-windows-x64.zip`.

See the release notes for build verification. Android signing material is kept under ignored `.private/`. User libraries and downloaded music are stored separately from the app.
