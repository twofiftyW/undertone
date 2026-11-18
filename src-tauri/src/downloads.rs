use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, io::Read, path::PathBuf, time::Duration};
use tauri::{ipc::InvokeBody, Manager};

fn paths(app: &tauri::AppHandle, id: &str, source: &str) -> Result<Vec<PathBuf>, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("downloads");
    match source {
        "monochrome" if (17..=20).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit()) => Ok(vec![directory.join(format!("{id}.flac"))]),
        "youtube" if id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') => Ok(["m4a", "webm", "opus", "mp3", "ogg"].iter().map(|ext| directory.join(format!("youtube-{id}.{ext}"))).collect()),
        _ => Err("Choose a supported song to download".into())
    }
}

#[tauri::command]
pub fn offline_file(app: tauri::AppHandle, id: String, source: Option<String>) -> Result<Option<Value>, String> {
    for path in paths(&app, &id, source.as_deref().unwrap_or("monochrome"))? {
        if !path.is_file() { continue; }
        let bytes = fs::metadata(&path).map_err(|e| e.to_string())?.len();
        let mut header = [0u8; 8];
        if bytes <= 8 || fs::File::open(&path).and_then(|mut file| file.read_exact(&mut header)).is_err() { continue; }
        let valid = match path.extension().and_then(|e| e.to_str()) {
            Some("flac") => &header[..4] == b"fLaC",
            Some("m4a") => &header[4..] == b"ftyp",
            Some("webm") => header[..4] == [0x1a, 0x45, 0xdf, 0xa3],
            Some("opus" | "ogg") => &header[..4] == b"OggS",
            Some("mp3") => &header[..3] == b"ID3" || header[0] == 0xff,
            _ => false,
        };
        if valid { return Ok(Some(json!({"nativePath": path.to_string_lossy(), "bytes": bytes}))); }
    }
    Ok(None)
}

#[tauri::command]
pub fn list_downloads(app: tauri::AppHandle) -> Result<BTreeMap<String, Value>, String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("downloads");
    let mut files = BTreeMap::new();
    if !directory.is_dir() { return Ok(files); }
    for item in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let Ok(item) = item else { continue; };
        let name = item.file_name().to_string_lossy().into_owned();
        let (id, source) = if let Some(rest) = name.strip_prefix("youtube-") {
            let Some((id, _)) = rest.rsplit_once('.') else { continue; };
            (id, "youtube")
        } else {
            let Some(id) = name.strip_suffix(".flac") else { continue; };
            (id, "monochrome")
        };
        if let Ok(Some(file)) = offline_file(app.clone(), id.to_owned(), Some(source.into())) {
            files.insert(format!("{source}:{id}"), file);
        }
    }
    Ok(files)
}

#[tauri::command]
pub async fn download_track(app: tauri::AppHandle, id: String, source: Option<String>) -> Result<Value, String> {
    let source = source.unwrap_or("monochrome".into());
    paths(&app, &id, &source)?;
    crate::music::engine(&app, "download", json!({"id": id, "source": source}), Duration::from_secs(600)).await
}

#[tauri::command]
pub fn remove_download(app: tauri::AppHandle, id: String, source: Option<String>) -> Result<(), String> {
    for path in paths(&app, &id, source.as_deref().unwrap_or("monochrome"))? {
        if path.is_file() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    }
    Ok(())
}

#[tauri::command]
pub async fn parse_spotify(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
    let filename = request.headers().get("x-import-name").and_then(|v| v.to_str().ok()).ok_or("Choose a Spotify export file")?.to_owned();
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) if !bytes.is_empty() && bytes.len() <= 32 * 1024 * 1024 => bytes.to_vec(),
        _ => return Err("Choose a JSON, CSV, or ZIP export smaller than 32 MB".into()),
    };
    let temporary = tempfile::tempdir().map_err(|e| e.to_string())?;
    let path = temporary.path().join("spotify-export");
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    crate::music::engine(&app, "spotify_parse", json!({"path": path.to_string_lossy(), "filename": filename}), Duration::from_secs(60)).await
}

#[tauri::command]
pub fn spotify_help() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    let mut opener = {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("rundll32.exe");
        cmd.arg("url.dll,FileProtocolHandler").creation_flags(0x08000000);
        cmd
    };
    #[cfg(target_os = "linux")]
    let mut opener = std::process::Command::new("xdg-open");
    opener.arg("https://www.spotify.com/account/privacy/")
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .spawn().map_err(|_| "Open Spotify’s account privacy page to request your account-data export".to_owned())?;
    Ok(())
}
