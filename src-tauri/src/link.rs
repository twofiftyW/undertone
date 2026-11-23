use serde_json::{json, Value};
use std::{io::{BufRead, BufReader, Write}, process::{Child, Stdio}, sync::Mutex};
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

async fn phone_request(app: tauri::AppHandle, operation: &str, args: Value) -> Result<Value, String> {
    if link_status(app.clone(), app.state::<Link>())?["running"] != true {
        return Err("Enable the phone connection first".into());
    }
    crate::music::engine(&app, operation, args, std::time::Duration::from_secs(12)).await
}

#[tauri::command]
pub async fn link_discover_phones(app: tauri::AppHandle) -> Result<Value, String> {
    phone_request(app, "link_discover_phones", json!({})).await
}

#[tauri::command]
pub async fn link_invite_phone(app: tauri::AppHandle, address: String, id: String) -> Result<Value, String> {
    phone_request(app, "link_invite_phone", json!({ "address": address, "id": id })).await
}

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
    let firewall_help = "Allow local TCP and UDP port 47832 and UDP port 47834 in your firewall settings.";
    let ufw = ["/usr/bin/ufw", "/usr/sbin/ufw"].into_iter().find(|p| std::path::Path::new(p).is_file()).ok_or(firewall_help)?;
    for network in networks {
        let (address, prefix) = network.split_once('/').ok_or("Invalid local network")?;
        let address = address.parse::<std::net::Ipv4Addr>().map_err(|_| "Invalid local network")?;
        let prefix = prefix.parse::<u8>().map_err(|_| "Invalid local network")?;
        if !address.is_private() || !(8..=32).contains(&prefix) { return Err("Choose a private local network".into()); }
        // Port 47832 serves TLS and answers discovery. Port 47834 receives phones' unicast replies to broadcasts.
        for (port, protocol) in [("47832", &[][..]), ("47834", &["proto", "udp"][..])] {
            let child = tokio::process::Command::new("/usr/bin/pkexec").args([ufw, "allow"]).args(protocol)
                .args(["from", &network, "to", "any", "port", port, "comment", "Undertone phone connection"])
                .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true).spawn()
                .map_err(|_| firewall_help.to_owned())?;
            let status = tokio::time::timeout(std::time::Duration::from_secs(120), child.wait_with_output()).await
                .map_err(|_| "The system permission prompt timed out")?.map_err(|e| e.to_string())?.status;
            if !status.success() { return Err(format!("Linux did not allow the firewall change. {firewall_help}")); }
        }
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
pub fn link_confirm_pair(app: tauri::AppHandle, id: String, approved: bool) -> Result<(), String> {
    if id.len() != 32 || !id.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid pairing request.".into());
    }
    let details = link_status(app.clone(), app.state::<Link>())?;
    if !details["pairingRequests"].as_array().is_some_and(|requests| requests.iter().any(|request| request["id"] == id)) {
        return Err("The pairing request expired. Try connecting again.".into());
    }
    let directory = app.path().app_data_dir().map_err(|error| error.to_string())?.join("link");
    let mut decision = tempfile::NamedTempFile::new_in(&directory).map_err(|error| error.to_string())?;
    decision.write_all(if approved { b"confirm" } else { b"decline" }).map_err(|error| error.to_string())?;
    decision.persist_noclobber(directory.join(format!("pair-decision-{id}"))).map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn link_status(app: tauri::AppHandle, link: State<'_, Link>) -> Result<Value, String> {
    let mut state = link.0.lock().map_err(|_| "The PC link is unavailable")?;
    if let Some((child, details)) = state.as_mut() {
        if child.try_wait().map_err(|e| e.to_string())?.is_none() {
            let mut result = details.clone();
            if let Ok(path) = app.path().app_data_dir() {
                if let Ok(bytes) = std::fs::read(path.join("link/pairing-requests.json")) {
                    if let Ok(mut requests) = serde_json::from_slice::<Vec<Value>>(&bytes) {
                        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
                            .map_or(0, |duration| duration.as_millis());
                        requests.retain(|request| {
                            let id = request["id"].as_str().unwrap_or_default();
                            id.len() == 32 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
                                && u128::from(request["expires"].as_u64().unwrap_or_default()) > now
                                && !path.join(format!("link/pair-decision-{id}")).exists()
                        });
                        result["pairingRequests"] = json!(requests);
                    }
                }
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
