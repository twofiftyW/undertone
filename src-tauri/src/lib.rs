use std::{fs, io::Write, path::PathBuf, sync::Mutex};
use tauri::{ipc::InvokeBody, Manager};
mod music;
#[cfg(any(target_os = "windows", target_os = "linux"))]
mod app_icon;
#[cfg(target_os = "linux")]
mod playback;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod downloads;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod imports;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod spotify;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod link;
#[cfg(any(target_os = "linux", target_os = "windows"))]
mod updates;

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
async fn save_library(app: tauri::AppHandle, library: serde_json::Value) -> Result<(), String> {
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        static WRITER: Mutex<()> = Mutex::new(());
        let _writer = WRITER.lock().map_err(|_| "Library storage is unavailable.")?;
        fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        let bytes = serde_json::to_vec(&library).map_err(|e| e.to_string())?;
        if bytes.len() > 64 * 1024 * 1024 { return Err("Library metadata is too large".into()); }
        let temporary = directory.join("library.json.tmp");
        {
            let mut output = fs::File::create(&temporary).map_err(|e| e.to_string())?;
            output.write_all(&bytes).and_then(|_| output.sync_all()).map_err(|e| e.to_string())?;
        }
        fs::rename(&temporary, directory.join("library.json")).map_err(|e| e.to_string())?;
        // Acknowledging background matches advances the journal. Ensure the
        // replacement itself will survive a power loss before we acknowledge.
        #[cfg(unix)]
        fs::File::open(directory).and_then(|dir| dir.sync_all()).map_err(|e| e.to_string())?;
        Ok(())
    }).await.map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    let builder = builder.manage(app_icon::AppIcons::default())
        .manage(imports::ImportFiles::default())
        .manage(spotify::DesktopJobs::from_launch());
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _| {
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        let open_import = _args.iter().skip(1).any(|arg| arg == "--show-spotify-import");
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        if open_import { app.state::<spotify::DesktopJobs>().request_open(); }
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            #[cfg(any(target_os = "windows", target_os = "linux"))]
            if open_import { let _ = window.eval("if (window.undertoneOpenSpotifyImport) window.undertoneOpenSpotifyImport()"); }
        }
    }));
    #[cfg(target_os = "linux")]
    let builder = builder
        .manage(playback::Playback::default())
        .manage(link::Link::default())
        .setup(|app| {
            app_icon::restore(app.handle());
            app.state::<playback::Playback>().0.lock().map_err(|_| "The audio player is unavailable")?.start()?;
            Ok(())
        })
.invoke_handler(tauri::generate_handler![updates::app_update, app_icon::get_app_icon, app_icon::set_app_icon, save_audio, delete_audio, platform, load_library, save_library, music::music, spotify::spotify_job, spotify::consume_spotify_import_intent, imports::begin_spotify_file, imports::append_spotify_file, imports::finish_spotify_file, imports::spotify_file_page, imports::end_spotify_file, playback::playback, downloads::offline_file, downloads::list_downloads, downloads::download_track, downloads::remove_download, downloads::parse_spotify, downloads::spotify_help, link::link_start, link::link_status, link::link_stop, link::link_firewall, link::link_revoke, link::link_discover_phones, link::link_invite_phone]);
    #[cfg(target_os = "windows")]
    let builder = builder.manage(link::Link::default())
        .setup(|app| { app_icon::restore(app.handle()); Ok(()) })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) { app_icon::clear_window_properties(window); }
        })
        .invoke_handler(tauri::generate_handler![updates::app_update, app_icon::get_app_icon, app_icon::set_app_icon, save_audio, delete_audio, platform, load_library, save_library, music::music, spotify::spotify_job, spotify::consume_spotify_import_intent, imports::begin_spotify_file, imports::append_spotify_file, imports::finish_spotify_file, imports::spotify_file_page, imports::end_spotify_file, downloads::offline_file, downloads::list_downloads, downloads::download_track, downloads::remove_download, downloads::parse_spotify, downloads::spotify_help, link::link_start, link::link_status, link::link_stop, link::link_revoke, link::link_discover_phones, link::link_invite_phone]);
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
