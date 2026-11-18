use serde_json::Value;
use std::{path::PathBuf, process::Stdio, time::Duration};
use tauri::Manager;
use tokio::{io::AsyncWriteExt, process::Command};

pub fn backend_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let local = executable.parent().unwrap_or(std::path::Path::new(".")).join("music/backend.py");
    let resource = app.path().resource_dir().map_err(|e| e.to_string())?.join("music/backend.py");
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../music/backend.py");
    [local, resource, development].into_iter().find(|p| p.is_file())
        .ok_or("The music engine is missing. Reinstall Undertone.".into())
}

pub fn python_command(backend: &std::path::Path) -> std::process::Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let runtime = backend.parent().unwrap_or(std::path::Path::new(".")).join("python/python.exe");
        let mut command = std::process::Command::new(runtime);
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        command
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = backend;
        std::process::Command::new("python3")
    }
}

pub async fn engine(app: &tauri::AppHandle, operation: &str, args: Value, timeout: Duration) -> Result<Value, String> {
    let backend = backend_path(app)?;
    let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("music");
    let downloads = app.path().app_data_dir().map_err(|e| e.to_string())?.join("downloads");
    let mut child = Command::from(python_command(&backend))
        .args(["-X", "utf8", "-B"])
        .arg(backend)
        .env("UNDERTONE_CACHE_DIR", cache)
        .env("UNDERTONE_DOWNLOAD_DIR", downloads)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn().map_err(|_| "The music engine could not start. Check that Python is available.".to_string())?;
    let input = serde_json::to_vec(&serde_json::json!({ "operation": operation, "args": args })).map_err(|e| e.to_string())?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(&input).await.map_err(|e| e.to_string())?;
    }
    let output = tokio::time::timeout(timeout, child.wait_with_output()).await
        .map_err(|_| "The music service took too long. Please retry.".to_string())?
        .map_err(|e| e.to_string())?;
    let reply: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "The music engine could not start. Check its Python dependencies.".to_string())?;
    if let Some(error) = reply.get("error").and_then(Value::as_str) {
        return Err(error.to_owned());
    }
    reply.get("data").cloned().ok_or("The music engine returned an invalid response".into())
}

#[tauri::command]
pub async fn music(app: tauri::AppHandle, operation: String, args: Value) -> Result<Value, String> {
    if !["search", "fallback", "videos", "artist", "album", "discography", "recommendations", "resolve", "home", "match", "spotify_url"].contains(&operation.as_str()) {
        return Err("Unknown music request".into());
    }
    engine(&app, &operation, args, Duration::from_secs(180)).await
}
