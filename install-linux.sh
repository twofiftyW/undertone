#!/usr/bin/env sh
set -eu
project_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
package_dir="$project_dir/dist/linux"
if [ -f "$project_dir/Undertone" ]; then
    package_dir="$project_dir"
fi
app_dir="${XDG_DATA_HOME:-$HOME/.local/share}/undertone"
desktop_dir="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$app_dir" "$desktop_dir"
if [ ! -f "$package_dir/music/backend.py" ] || [ ! -f "$package_dir/music/monochrome.py" ]; then
    printf '%s\n' 'Build the Linux app first: python3 scripts/build_linux.py'
    exit 1
fi
for dependency in python3 mpv yt-dlp deno openssl ip; do
    if ! command -v "$dependency" >/dev/null 2>&1; then
        printf '%s\n' "Install $dependency before using the Linux music engine."
        exit 1
    fi
done
mkdir -p "$app_dir/music"
cp -R "$package_dir/music/." "$app_dir/music/"
# Replace the executable without disturbing an already running app.
temporary_binary=$(mktemp "$app_dir/Undertone.XXXXXX")
trap 'rm -f "$temporary_binary"' EXIT HUP INT TERM
install -m755 "$package_dir/Undertone" "$temporary_binary"
mv -f "$temporary_binary" "$app_dir/Undertone"
install -m644 "$package_dir/icon.png" "$app_dir/icon.png"
launcher_icon="$app_dir/icon.png"
icon_profile="${XDG_DATA_HOME:-$HOME/.local/share}/personal.undertone.player"
if [ -r "$icon_profile/app-icon" ]; then
    choice=$(cat "$icon_profile/app-icon")
    case "$choice" in
        green|blue|amoled|gray)
            if [ -f "$icon_profile/launcher-icons/$choice.png" ]; then
                launcher_icon="$icon_profile/launcher-icons/$choice.png"
            fi
            ;;
    esac
fi
cat > "$desktop_dir/personal.undertone.player.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Undertone Alpha
Comment=Your own little corner of music
Exec="$app_dir/Undertone"
Icon=$launcher_icon
Terminal=false
Categories=AudioVideo;Audio;Player;
StartupWMClass=Undertone
EOF
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$desktop_dir" >/dev/null 2>&1 || true
fi
printf '%s\n' 'Installed Undertone Alpha 0.0.6-alpha. Restart Undertone Alpha, or open it from your application launcher.'
