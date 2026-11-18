use serde_json::{json, Value};
use std::{io, process::Stdio, sync::atomic::{AtomicBool, Ordering}, time::Duration};
use tauri::{
    async_runtime::Mutex,
    window::{ProgressBarState, ProgressBarStatus},
    AppHandle, Manager,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    time::{sleep, timeout},
};

// Keep IPC cheap across progress polls. The controller exits on EOF. Its
// detached matching worker owns the durable queue independently of this app.
struct Controller {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}

impl Controller {
    fn launch(app: &AppHandle) -> Result<Self, String> {
        let backend = crate::music::backend_path(app)?;
        let script = backend.with_file_name("desktop_spotify.py");
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let cache = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("music");
        let mut child = Command::from(crate::music::python_command(&backend))
            .args(["-X", "utf8", "-B"])
            .arg(script).arg(&root).arg("--stdio")
            .env("UNDERTONE_CACHE_DIR", cache)
            .env("UNDERTONE_DOWNLOAD_DIR", root.join("downloads"))
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .kill_on_drop(true).spawn()
            .map_err(|_| "The Spotify import service could not start.".to_owned())?;
        let input = child.stdin.take().ok_or("Could not open the import service input.")?;
        let output = BufReader::new(child.stdout.take().ok_or("Could not open the import service output.")?);
        Ok(Self { child, input, output })
    }

    async fn exchange(&mut self, operation: &str, args: Value) -> io::Result<Value> {
        let mut message = serde_json::to_vec(&json!({ "operation": operation, "args": args }))?;
        message.push(b'\n');
        self.input.write_all(&message).await?;
        let mut reply = String::new();
        self.output.read_line(&mut reply).await?;
        Ok(serde_json::from_str(&reply)?)
    }
}

#[derive(Default)]
struct Connection {
    controller: Option<Controller>,
    active: bool,
    watching: bool,
}

impl Connection {
    async fn request(&mut self, app: &AppHandle, operation: &str, args: Value) -> Result<Value, String> {
        if let Some(controller) = self.controller.as_mut() {
            if controller.child.try_wait().map_err(|e| e.to_string())?.is_some() {
                self.controller = None;
            }
        }
        let controller = match &mut self.controller {
            Some(controller) => controller,
            slot => slot.insert(Controller::launch(app)?),
        };
        let mut reply = match timeout(Duration::from_secs(60), controller.exchange(operation, args)).await {
            Ok(Ok(reply)) => reply,
            _ => {
                self.controller = None;
                return Err("The Spotify import service stopped responding. Open the import again to reconnect.".into());
            }
        };
        if let Some(message) = reply["error"].as_str() { return Err(message.to_owned()); }
        let result = reply.get_mut("data").ok_or("The import service returned an invalid response.")?.take();
        if result["state"].is_string() {
            self.active = result["serviceActive"] == true;
            update_progress(app, &result);
        }
        Ok(result)
    }
}

#[derive(Default)]
pub struct DesktopJobs {
    connection: Mutex<Connection>,
    open_requested: AtomicBool,
}

impl DesktopJobs {
    pub fn from_launch() -> Self {
        Self {
            open_requested: AtomicBool::new(std::env::args_os().skip(1).any(|arg| arg == "--show-spotify-import")),
            ..Self::default()
        }
    }

    pub fn request_open(&self) { self.open_requested.store(true, Ordering::Release); }
}

#[tauri::command]
pub fn consume_spotify_import_intent(jobs: tauri::State<'_, DesktopJobs>) -> bool {
    jobs.open_requested.swap(false, Ordering::AcqRel)
}

fn update_progress(app: &AppHandle, state: &Value) {
    let Some(window) = app.get_webview_window("main") else { return };
    let status = match state["state"].as_str() {
        Some("running") if state["serviceActive"] == true => ProgressBarStatus::Normal,
        Some("running" | "paused") => ProgressBarStatus::Paused,
        _ => ProgressBarStatus::None,
    };
    let total = state["total"].as_u64().unwrap_or(0);
    let percent = state["checked"].as_u64().unwrap_or(0).saturating_mul(100).checked_div(total);
    let _ = window.set_progress_bar(ProgressBarState { status: Some(status), progress: percent });
}

async fn monitor_minimized(app: AppHandle) {
    loop {
        sleep(Duration::from_secs(2)).await;
        let jobs = app.state::<DesktopJobs>();
        let mut connection = jobs.connection.lock().await;
        if !connection.active {
            connection.watching = false;
            return;
        }
        let Some(window) = app.get_webview_window("main") else {
            connection.watching = false;
            return;
        };
        // While the window is visible the UI's journal polls also update the
        // taskbar. Minimized WebViews can suspend JavaScript timers entirely.
        if window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(true) {
            if connection.request(&app, "spotify_job_status", json!({})).await.is_err() {
                connection.watching = false;
                return;
            }
        }
    }
}

#[tauri::command]
pub async fn spotify_job(app: AppHandle, operation: String, args: Value) -> Result<Value, String> {
    if !matches!(operation.as_str(), "spotify_job_start" | "spotify_job_resume" | "spotify_job_pause"
        | "spotify_job_status" | "spotify_job_results" | "spotify_job_ack")
    {
        return Err("Unknown Spotify import request.".into());
    }
    let jobs = app.state::<DesktopJobs>();
    let mut connection = jobs.connection.lock().await;
    let result = connection.request(&app, &operation, args).await?;
    if connection.active && !connection.watching {
        connection.watching = true;
        tauri::async_runtime::spawn(monitor_minimized(app.clone()));
    }
    Ok(result)
}
