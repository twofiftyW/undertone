use std::{fs, path::PathBuf};
use tauri::{ipc::InvokeBody, Manager};
mod music;
#[cfg(target_os = "linux")]
mod playback;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod downloads;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod link;

fn audio_file(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.len() > 100 || !id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'.') || id.starts_with('.') || id.contains("..") {
        return Err("Invalid audio identifier".into());
    }
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?.join("audio");
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    Ok(directory.join(id))
}

#[tauri::command]
fn save_audio(app: tauri::AppHandle, request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let id = request.headers().get("x-audio-id").and_then(|v| v.to_str().ok()).ok_or("Missing audio identifier")?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        _ => return Err("Expected audio bytes".into()),
    };
    if bytes.is_empty() || bytes.len() > 256 * 1024 * 1024 {
        return Err("Choose an audio file smaller than 256 MB".into());
    }
    let path = audio_file(&app, id)?;
    fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn delete_audio(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let path = audio_file(&app, &id)?;
    if path.exists() { fs::remove_file(path).map_err(|e| e.to_string())?; }
    Ok(())
}

#[tauri::command]
fn platform() -> &'static str { std::env::consts::OS }

#[tauri::command]
fn load_library(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("library.json");
    match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some).map_err(|e| format!("Could not read your library: {e}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn save_library(app: tauri::AppHandle, library: serde_json::Value) -> Result<(), String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(&library).map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 * 1024 { return Err("Library metadata is too large".into()); }
    let temporary = directory.join("library.json.tmp");
    fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    fs::rename(&temporary, directory.join("library.json")).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }));
    #[cfg(target_os = "linux")]
    let builder = builder
        .manage(playback::Playback::default())
        .manage(link::Link::default())
        .setup(|app| {
            app.state::<playback::Playback>().0.lock().map_err(|_| "The audio player is unavailable")?.start()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![save_audio, delete_audio, platform, load_library, save_library, music::music, playback::playback, downloads::offline_file, downloads::list_downloads, downloads::download_track, downloads::remove_download, downloads::parse_spotify, downloads::spotify_help, link::link_start, link::link_status, link::link_stop, link::link_firewall, link::link_revoke]);
    #[cfg(target_os = "windows")]
    let builder = builder.manage(link::Link::default())
        .invoke_handler(tauri::generate_handler![save_audio, delete_audio, platform, load_library, save_library, music::music, downloads::offline_file, downloads::list_downloads, downloads::download_track, downloads::remove_download, downloads::parse_spotify, downloads::spotify_help, link::link_start, link::link_status, link::link_stop, link::link_revoke]);
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    let builder = builder
        .invoke_handler(tauri::generate_handler![save_audio, delete_audio, platform, load_library, save_library, music::music])
        ;
    builder
        .build(tauri::generate_context!())
        .expect("Could not start Undertone")
        .run(|app, event| {
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            if matches!(event, tauri::RunEvent::Exit) {
                app.state::<link::Link>().stop();
                #[cfg(target_os = "linux")]
                if let Ok(mut player) = app.state::<playback::Playback>().0.lock() {
                    player.shutdown();
                }
            }
        });
}
