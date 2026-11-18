use serde_json::{json, Value};
use std::{io::{BufRead, BufReader}, process::{Child, Stdio}, sync::Mutex};
use tauri::{Manager, State};

#[derive(Default)]
pub struct Link(pub Mutex<Option<(Child, Value)>>);

impl Link {
    pub fn stop(&self) {
        if let Ok(mut child) = self.0.lock() {
            if let Some((mut process, _)) = child.take() { let _ = process.kill(); let _ = process.wait(); }
        }
    }
}

#[tauri::command]
pub fn link_stop(link: State<'_, Link>) { link.stop(); }

#[tauri::command]
#[cfg(target_os = "linux")]
pub async fn link_firewall(app: tauri::AppHandle) -> Result<bool, String> {
    let networks: Vec<String> = {
        let state = app.state::<Link>();
        let data = state.0.lock().map_err(|_| "The PC link is unavailable")?;
        let details = &data.as_ref().ok_or("Enable the phone connection first")?.1;
        details["networks"].as_array().ok_or("No local network was found")?.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect()
    };
    if networks.is_empty() { return Err("Connect this computer to Wi-Fi first".into()); }
    for network in networks {
        let (address, prefix) = network.split_once('/').ok_or("Invalid local network")?;
        let address = address.parse::<std::net::Ipv4Addr>().map_err(|_| "Invalid local network")?;
        let prefix = prefix.parse::<u8>().map_err(|_| "Invalid local network")?;
        if !address.is_private() || !(8..=32).contains(&prefix) { return Err("Choose a private local network".into()); }
        let ufw = ["/usr/bin/ufw", "/usr/sbin/ufw"].into_iter().find(|p| std::path::Path::new(p).is_file()).ok_or("Open your firewall settings to allow local TCP port 47832")?;
        let child = tokio::process::Command::new("/usr/bin/pkexec").args([ufw, "allow", "from", &network, "to", "any", "port", "47832", "proto", "tcp", "comment", "Undertone phone connection"])
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).spawn()
            .map_err(|_| "Open your firewall settings and allow TCP port 47832 from your local Wi-Fi network".to_owned())?;
        let status = tokio::time::timeout(std::time::Duration::from_secs(120), child.wait_with_output()).await
            .map_err(|_| "The system permission prompt timed out")?.map_err(|e| e.to_string())?.status;
        if !status.success() { return Err("Linux did not allow the firewall change. Approve its system password prompt, or allow local TCP port 47832 in your firewall settings.".into()); }
    }
    Ok(true)
}

#[tauri::command]
pub fn link_revoke(app: tauri::AppHandle, link: State<'_, Link>) -> Result<(), String> {
    link.stop();
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("link/devices.json");
    if let Ok(bytes) = std::fs::read(&path) {
        let mut value: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        value["tokens"] = json!([]);
        std::fs::write(path, serde_json::to_vec(&value).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn link_status(app: tauri::AppHandle, link: State<'_, Link>) -> Result<Value, String> {
    let mut state = link.0.lock().map_err(|_| "The PC link is unavailable")?;
    if let Some((child, details)) = state.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            let mut result = details.clone();
            if let Ok(path) = app.path().app_data_dir() {
                if let Ok(bytes) = std::fs::read(path.join("link/devices.json")) {
                    if let Ok(devices) = serde_json::from_slice::<Value>(&bytes) { result["pairedDevices"] = json!(devices["tokens"].as_array().map_or(0, Vec::len)); }
                }
            }
            return Ok(result);
        }
    }
    *state = None;
    Ok(json!({"running": false}))
}

#[tauri::command]
pub async fn link_start(app: tauri::AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Link>();
        state.stop();
        let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let backend = crate::music::backend_path(&app)?;
        let mut child = crate::music::python_command(&backend).args(["-X", "utf8", "-B"]).arg(backend)
            .arg("--sync-server").arg(root).env("PYTHONDONTWRITEBYTECODE", "1")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn().map_err(|_| "The PC link could not start".to_owned())?;
        let mut line = String::new();
        let read = BufReader::new(child.stdout.take().ok_or("The PC link could not start")?).read_line(&mut line);
        let reply = read.ok().and_then(|_| serde_json::from_str::<Value>(&line).ok());
        let Some(details) = reply.as_ref().and_then(|v| v.get("data")) else {
            let _ = child.kill(); let _ = child.wait();
            return Err(reply.and_then(|v| v["error"].as_str().map(str::to_owned)).unwrap_or("The PC link could not start. Check that port 47832 is free.".into()));
        };
        let details = details.clone();
        *state.0.lock().map_err(|_| "The PC link is unavailable")? = Some((child, details.clone()));
        Ok(details)
    }).await.map_err(|e| e.to_string())?
}
