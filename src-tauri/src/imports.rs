use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File},
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{ipc::InvokeBody, Manager, State};
use tempfile::TempDir;

struct Upload {
    file: Mutex<Option<File>>,
    directory: TempDir,
}

#[derive(Default)]
pub struct ImportFiles(Mutex<HashMap<String, Arc<Upload>>>);

impl ImportFiles {
    fn get(&self, token: &str) -> Result<Arc<Upload>, String> {
        self.0.lock().map_err(|e| e.to_string())?.get(token).cloned()
            .ok_or_else(|| "This import is no longer open.".to_owned())
    }
}

#[tauri::command]
pub fn begin_spotify_file(app: tauri::AppHandle, state: State<'_, ImportFiles>) -> Result<String, String> {
    let root = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("spotify-imports");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    // A process terminated during the file picker or parse can leave scratch files.
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        if entry.file_name().to_string_lossy().starts_with("export-") && entry.file_type().is_ok_and(|t| t.is_dir()) {
            let age = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok());
            if age.is_some_and(|elapsed| elapsed > Duration::from_secs(86400)) {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    let directory = tempfile::Builder::new().prefix("export-").tempdir_in(&root).map_err(|e| e.to_string())?;
    let token = directory.path().file_name().unwrap().to_string_lossy().into_owned();
    let file = File::create(directory.path().join("export")).map_err(|e| e.to_string())?;
    state.0.lock().map_err(|e| e.to_string())?.insert(token.clone(), Arc::new(Upload { directory, file: Mutex::new(Some(file)) }));
    Ok(token)
}

#[tauri::command]
pub fn append_spotify_file(state: State<'_, ImportFiles>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let token = request.headers().get("x-import-job").and_then(|v| v.to_str().ok()).ok_or("Missing import session.")?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() <= 256 * 1024 => bytes,
        _ => return Err("Invalid import chunk.".into()),
    };
    let job = state.get(token)?;
    let mut writer = job.file.lock().map_err(|e| e.to_string())?;
    let file = writer.as_mut().ok_or("The export is already being read.")?;
    if file.metadata().map_err(|e| e.to_string())?.len() + bytes.len() as u64 > 32 * 1024 * 1024 {
        return Err("Choose files smaller than 32 MB, or select individual playlist exports.".into());
    }
    file.write_all(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn finish_spotify_file(app: tauri::AppHandle, state: State<'_, ImportFiles>, token: String, filename: String) -> Result<Value, String> {
    let job = state.get(&token)?;
    job.file.lock().map_err(|e| e.to_string())?.take().ok_or("The export is already being read.")?;
    let path = job.directory.path().join("export");
    let result = crate::music::engine(&app, "spotify_parse_pages", json!({ "path": path, "filename": filename }), Duration::from_secs(240)).await;
    let _ = fs::remove_file(path);
    result
}

#[tauri::command]
pub fn spotify_file_page(state: State<'_, ImportFiles>, token: String, page: u32) -> Result<String, String> {
    let job = state.get(&token)?;
    fs::read_to_string(job.directory.path().join(format!("{page}.json"))).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn end_spotify_file(state: State<'_, ImportFiles>, token: String) -> Result<(), String> {
    state.0.lock().map_err(|e| e.to_string())?.remove(&token);
    Ok(())
}
