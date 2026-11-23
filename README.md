# Undertone

A personal music player for Linux, Windows, Android, and iOS. **Undertone 0.1.0-beta** supports Linux x86_64, Windows 10/11 x64, Android 8+ on arm64-v8a and x86_64, and iOS 16+.

Songs, artists, albums, and release tracks use Monochrome. When Monochrome has no song match, search and Spotify matching try YouTube. There is also a separate Music videos search and a “Search YouTube songs too” button. Linux playback uses mpv with its own **Undertone** mixer identity, so another mpv application’s saved mute/volume settings do not silence this app. The app follows your system’s default output. Only one Undertone instance runs in a desktop session.

## Open the app

- **Linux:** Extract the `linux-x86_64.tar.gz` archive, then run `./install-linux.sh` from its `linux` folder. Open Undertone Alpha from your app launcher. In a source checkout, `./run.sh` opens the packaged Linux build.
- **Windows:** Extract the entire `windows-x64.zip` archive and run `Undertone.exe` inside the Undertone folder. [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/) is required. Python and the music engine are included.
- **Android:** Install Undertone 0.1.0-beta over an earlier release to keep your library. Both use the original application ID (`personal.undertone.player`) and signing certificate. The app installs alongside the published 0.0.4-alpha (`personal.undertone.player.alpha`), with a separate library.
- **iOS:** The iPhone IPA requires Apple signing and a provisioning profile before it can be installed on a device. The simulator bundle runs on a Mac with Xcode and the matching simulator architecture. The same library UI, catalog engine, and offline downloads run inside the app. iOS can suspend imports and downloads after its background time allowance. Reopen Undertone and resume a paused job in the progress dialog.

Large collections keep their full scroll range on all three platforms. The app renders the visible tracks and nearby rows as you scroll.

On Android, the system Back gesture or button closes the keyboard, dialog, queue, or expanded player first, then returns to the previous page or tab. On the home screen it keeps Undertone Alpha open.

Open **Settings → Language → Русский** to switch the interface. The setting is saved on each device.

Open **Settings → Appearance** to choose **Forest green**, **Midnight blue**, **AMOLED black**, or **Graphite gray**. The theme changes immediately and is saved on this device. Forest green is the default. AMOLED black uses pure black for the main background, sidebar, and player.

The app icon follows the theme by default. Clear **Sync with theme** under **App icon** to choose a different icon, such as a green icon with Midnight blue. Turning sync back on applies the current theme’s icon immediately. Your manual choice is available again the next time you turn sync off. On Android the icon appears in the app launcher. On Windows it appears on the window and the `Undertone Alpha.lnk` shortcut beside the portable executable. On Linux it appears on the window and in the launcher after installation with `install-linux.sh`.

Keep the entire `dist/linux/` directory together: the executable needs `music/`. System requirements are Python 3, mpv, yt-dlp, Deno, OpenSSL, iproute2, WebKitGTK 4.1, GTK 3, audio support, and the desktop’s session D-Bus. These are present on the development computer. Catalog Python dependencies are bundled.

## Settings

Use the gear in the top bar. **Appearance**, **Language**, **Playback**, **Devices**, **Updates**, and **About** each have their own section.

## Updates

Open **Settings → Updates** to check the public GitHub release feed. Linux, Windows, and Android download and install their build after you approve it. Choose **Later** to keep an **Update available** button in the top bar. **Do not show again** hides future prompts and can be turned off under Updates. On Android, allow Undertone to install apps when prompted and confirm in the Android installer if the system asks. iOS opens the release page so you can sign a newer build.


## Download music for offline playback

- Open a song’s **…** menu and choose **Download for offline listening**.
- On an album, use **Download album**. Discography releases have a download button too.
- On a playlist or **Liked songs**, use **Download all** to queue every downloadable song. It skips saved copies, queued songs, and local files, and reports failures for retry.
- Open **Downloads** in the sidebar for saved songs. Its **Downloads** button shows queue status and failures. You can stop queued work after the current song, or retry failures.
- **Remove download** removes only the saved copy, leaving the song in your library and playlists.

Playback checks for a complete local copy before resolving an internet stream, including after an app restart. Completed files play directly from the device. Partially downloaded files are never listed as available offline. Transfers use validated byte ranges to continue when the provider closes a connection early; the final filename appears only after all expected bytes have arrived.

Downloads cover Monochrome songs and matched YouTube song fallbacks, including Spotify imports. Imported audio files are already local. YouTube sign-in or regional checks can prevent playback/downloads; these errors are shown and never bypassed. Music-video audio is not included in the offline downloader. Each recording is limited to 512 MB, and downloads reserve some free disk space. Artwork and discovery are still online features. PC-to-phone library copying is available below.

## Import music

Choose **Import** in Your library. **From a file** opens the device's audio picker. **From Spotify** accepts a public playlist link or a Spotify export.

To append tracks to an existing playlist, open that playlist and choose **Import** in its toolbar. Audio files are added in selection order. Spotify collections are added in export order, including repeated entries.

### Spotify playlists and Liked Songs

1. Select a Spotify account-data **ZIP**, its **Playlist / YourLibrary JSON files**, or a playlist **CSV** with song titles and artists. The dialog can open Spotify’s account privacy page to help obtain an export.
2. Review the collections. Choose **New playlist** or **Liked Songs** for each; YourLibrary files are detected as liked songs automatically.
3. Choose **Import selected collections**. Existing playlists are preserved. Normal playlists are added as new collections, while liked songs merge into Undertone’s Liked Songs.
4. Recordings are matched against Monochrome using titles, artists, versions, and available duration/ISRC information, then YouTube if no clear match is found. Unclear matches stay as visible entries with **Choose recording**. Select a candidate to replace that entry throughout its playlists and Liked Songs.

Playlist positions and repeated entries are retained. Existing liked-song membership is preserved and deduplicated when matches resolve to the same recording. Spotify identifiers are kept as metadata. You can close the dialog and listen while matching continues. **Pause matching** stops after the current batch.

Export files are parsed on this device. Only song metadata needed for matching is looked up in the music catalog. ZIP files are read without extracting their contents; unrelated account-data JSON files are skipped. Supported limits are 32 MB per uploaded file, 100 MB of relevant expanded ZIP contents, and 20,000 song entries per import.

On Android, confirming a Spotify import starts background matching. You can leave the app or turn off the screen. Tap the import notification or choose **Import → From Spotify** to see progress and resume after an interruption.

On Windows and Linux, Spotify matching continues after you minimize or close the window. Reopen Undertone to apply the saved results. The progress button below the search bar opens the import controls, where you can pause or resume. Desktop notifications report completion or a connection interruption when your system allows them.

Imports try for a close match first. When that search yields alternatives, Undertone automatically picks the first one in the ranked list. To fix a match, open the song’s menu and select **Change recording**. Import and download jobs continue in the background on desktop and Android. Download jobs fetch several songs at a time and show progress in Downloads.

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

The player starts buffering the next stream with about twenty seconds left. **Next** reuses an ongoing load. It also prepares the next available local file during offline playback. Manually queued songs play in the order they were added. Queue edits, shuffle, and repeat can change which song is next. A slow stream can still delay the transition.

## Build Linux

Install Node.js, Rust, Tauri’s Linux development prerequisites, Python 3, mpv, yt-dlp, Deno, and uv or pip. Then:

```sh
npm install
npm test
python3 tests/music_test.py
python3 tests/features_test.py
python3 tests/v05_test.py
python3 tests/discovery_test.py
python3 scripts/build_linux.py
./install-linux.sh
```

The helper installs `music/requirements.txt` dependencies if needed, builds a release executable, and packages the engine. It uses the project-local Rust toolchain when present; `python3 scripts/bootstrap.py` prepares it. `npm run dev` starts native development after dependencies are ready.

Optional checks include `cargo test --manifest-path src-tauri/Cargo.toml --lib`, `python3 tests/catalog_live.py`, and `python3 tests/single_instance.py`. Live evidence and private backups remain in ignored `.tools/` and are excluded from packages. The development-only preview server is not needed by the installed app.

## Android and PC connection

Transfer the APK from the release to your phone by USB or your usual file-sharing method, open it in the phone’s file manager, and allow installation from that app if Android asks. The app includes the music engine for Monochrome search, artist pages, playback, Spotify export import, and offline downloads. Background audio uses Android’s media service and lock-screen controls.

To copy your PC library:

1. Put phone and PC on the **same Wi-Fi**. Keep both apps open while copying.
2. On your phone, open **Settings → Devices**. Keep this section open while discovering a PC or receiving an invitation.
3. On Linux or Windows, open **Settings → Devices → Enable phone connection**. You can send an invitation to the phone from that screen.
4. On your phone, select the PC and tap **Confirm on this phone**. On the PC, check the phone name and address, then click **Confirm on this PC**. If discovery is unavailable, enter the address displayed on the PC.
5. Tap **Copy from PC**. Leave **Copy saved audio for offline listening** checked to copy completed downloads and imported files, or uncheck it to copy playlists and metadata only.
6. The phone remembers its paired PC and can play copied audio offline. To refresh later, enable the PC connection and tap **Copy from PC** again. To switch computers, select another PC in Settings and confirm on both devices.

Copying adds PC Liked Songs and updates copies of the PC playlists while keeping phone-only collections. Repeated entries and track order remain intact. Songs only liked or put in a playlist on the PC are metadata until downloaded; complete downloads and imported audio are the files copied. Matching completed audio files are skipped on repeat copies. Transfers are size- and SHA-256-checked before an atomic rename. An interrupted copy preserves previous files and the phone library; retry to continue with already completed files skipped. This is a manual one-way PC-to-phone copy, not cloud or two-way live sync.

While the PC connection is enabled, Undertone answers local discovery requests on UDP **47832** with the computer name. Android answers searches and receives invitations on UDP **47833** while its connection dialog is visible. The PC receives search replies on UDP **47834**. Accepting an invitation selects a PC in the pairing form. A pairing request expires after 90 seconds. The first connection pins the selected PC’s TLS certificate. The phone receives its access credential only after both devices confirm. Library transfers use pinned TLS on TCP **47832**. Closing Undertone on the PC stops sharing until you enable it again. **Forget paired phones** revokes PC access. **Forget PC** on Android removes its saved link.

If UFW is enabled on Linux and either device cannot find the other, click **Allow phone through firewall** in the PC connection dialog and approve the system prompts. This allows TCP/UDP 47832 and UDP 47834 from the PC’s private local subnet. On Windows, allow the packaged Python runtime on private networks if Windows Firewall asks. On Wi-Fi networks that block broadcast discovery, use the PC address shown in the dialog.

To build the Android release, run `python3 scripts/android_setup.py` once. Set `UNDERTONE_KEYSTORE` to the original Undertone keystore and supply its password via `UNDERTONE_SIGNING_PASSWORD`. The default alias is `undertone`. Override it with `UNDERTONE_KEY_ALIAS` if needed. A separately protected private key can use `UNDERTONE_KEY_PASSWORD`. Then run `python3 scripts/build_android.py`. The helper checks the certificate fingerprint before signing and again on the finished APK. The app embeds the same Python music modules using Chaquopy. Android’s YouTube extraction has no bundled external JavaScript executable, so availability may differ from the Linux yt-dlp/Deno setup.

## Build Windows

On a Linux development machine, use `python3 scripts/bootstrap.py` to prepare the project-local Rust toolchain and install Node.js, `clang-cl`, `lld-link`, and `uv`. Run `npm install`, then `python3 scripts/windows_build.py`. It cross-builds the x64 executable and packages the Windows Python runtime, catalog tools, and WebView2 app in `dist/Undertone-0.1.0-beta-windows-x64.zip`.

The expected Android signing certificate SHA-256 is `ea5712d23e62568ceb43333a670275ed50777187fc7c52ce89ad4b8a516b2dfb`. The build helper also reads the original keystore from `.private/android-signing.p12` and the password from `.private/android-signing-password`. Git ignores the `.private` directory. Restrict access to it to the Windows account or Unix user that signs the release. User libraries and downloaded music are stored separately from the app.


### iOS build

On a Mac with Xcode and Python 3.14, run `python3 scripts/build_ios.py`. It creates a simulator bundle and an iPhone IPA for Apple signing, using the bundled CPython engine. The GitHub workflow builds both packages and launches the app in an iOS simulator.

The iOS WebView uses a loopback server on the device and keeps the library in the app’s private storage. For phone pairing, iOS may require local network permission. Use the PC’s displayed address if automatic discovery is unavailable.
