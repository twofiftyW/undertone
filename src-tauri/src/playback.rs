//! Linux audio is handled by mpv, independent of WebKit's media element.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::{net::UnixStream, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::Manager;

#[derive(Default, Clone)]
pub struct Playback(pub Arc<Mutex<Player>>);

#[derive(Default)]
pub struct Player {
    child: Option<Child>,
    connection: Option<BufReader<UnixStream>>,
    directory: Option<tempfile::TempDir>,
    request_id: u64,
    token: u64,
    error: Option<String>,
    key: String,
    serial: u64,
    next: Option<(u64, String)>,
}

impl Player {
    pub fn start(&mut self) -> Result<(), String> {
        if self.child.as_mut().is_some_and(|child| child.try_wait().ok().flatten().is_none()) {
            return Ok(());
        }
        self.shutdown();
        let directory = tempfile::Builder::new().prefix("undertone-audio-").tempdir().map_err(|e| e.to_string())?;
        let socket = directory.path().join("mpv.sock");
        let mut command = Command::new("mpv");
        command.args(["--no-config", "--no-video", "--audio-client-name=Undertone", "--audio-device=auto", "--audio-display=no", "--idle=yes", "--keep-open=yes", "--gapless-audio=weak", "--prefetch-playlist=yes", "--no-terminal", "--really-quiet", "--network-timeout=20", "--cache=yes", "--cache-secs=8"])
            .arg(format!("--input-ipc-server={}", socket.display()))
            .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        #[cfg(test)]
        if std::env::var_os("UNDERTONE_TEST_SYSTEM_AUDIO").is_none() {
            command.arg("--ao=null");
        }
        // Stop audio even when the parent app crashes or is terminated.
        unsafe {
            command.pre_exec(|| {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        self.child = Some(command.spawn().map_err(|_| "Linux playback needs mpv installed".to_owned())?);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match UnixStream::connect(&socket) {
                Ok(stream) => {
                    stream.set_read_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
                    stream.set_write_timeout(Some(Duration::from_secs(3))).map_err(|e| e.to_string())?;
                    self.connection = Some(BufReader::new(stream));
                    self.directory = Some(directory);
                    return Ok(());
                }
                Err(_) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
                Err(_) => { self.shutdown(); return Err("The Linux audio player could not start".into()); }
            }
        }
    }

    fn send(&mut self, command: Value) -> Result<Value, String> {
        self.request_id += 1;
        let request_id = self.request_id;
        let connection = self.connection.as_mut().ok_or("The audio player is not running")?;
        writeln!(connection.get_mut(), "{}", json!({"command": command, "request_id": request_id})).map_err(|e| e.to_string())?;
        let deadline = Instant::now() + Duration::from_secs(4);
        while Instant::now() < deadline {
            let mut line = String::new();
            connection.read_line(&mut line).map_err(|_| "The audio player stopped responding".to_owned())?;
            if line.is_empty() { return Err("The audio player closed unexpectedly".into()); }
            let reply: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
            if reply["event"] == "start-file" && self.next.as_ref().is_some_and(|(id, _)| reply["playlist_entry_id"].as_u64() == Some(*id)) {
                self.key = self.next.take().unwrap().1;
                self.serial += 1;
            }
            if reply["event"] == "end-file" && reply["reason"] == "error" {
                self.error = Some(format!("Couldn’t play this recording: {}", reply["file_error"].as_str().or_else(|| reply["error"].as_str()).unwrap_or("audio could not be loaded")));
            }
            if reply["request_id"].as_u64() == Some(request_id) {
                if reply["error"] != "success" { return Err(reply["error"].as_str().unwrap_or("Audio request failed").to_owned()); }
                return Ok(reply["data"].clone());
            }
        }
        Err("The audio player took too long to respond".into())
    }

    fn property(&mut self, name: &str) -> Value {
        self.send(json!(["get_property", name])).unwrap_or(Value::Null)
    }

    pub fn state(&mut self) -> Value {
        if self.child.is_none() {
            return json!({"token": self.token, "position": 0, "duration": 0, "paused": true, "ready": false, "ended": false, "error": self.error});
        }
        let playlist = self.property("playlist");
        let playing_id = playlist.as_array().and_then(|items| items.iter().find(|item| item["playing"] == true)).and_then(|item| item["id"].as_u64());
        if self.next.as_ref().is_some_and(|(id, _)| Some(*id) == playing_id) {
            self.key = self.next.take().unwrap().1;
            self.serial += 1;
        }
        let position = self.property("time-pos");
        let duration = self.property("duration");
        let paused = self.property("pause").as_bool().unwrap_or(true);
        let ended = self.property("eof-reached").as_bool().unwrap_or(false);
        let buffering = self.property("paused-for-cache").as_bool().unwrap_or(false);
        let output_volume = self.property("ao-volume");
        let output_muted = self.property("ao-mute");
        if let Some(child) = self.child.as_mut() {
            if child.try_wait().ok().flatten().is_some() {
                self.error = Some("The Linux audio player exited. Press Play to retry.".into());
            }
        }
        json!({"token": self.token, "key": self.key, "serial": self.serial, "position": position.as_f64().unwrap_or(0.0), "duration": duration.as_f64().unwrap_or(0.0), "paused": paused, "ready": position.is_number(), "buffering": buffering, "ended": ended, "error": self.error, "outputVolume": output_volume, "outputMuted": output_muted})
    }

    pub fn handle(&mut self, operation: &str, args: &Value) -> Result<Value, String> {
        if operation == "load" {
            self.start()?;
            self.token = args["token"].as_u64().unwrap_or(0);
            self.key = args["key"].as_str().unwrap_or("").to_owned();
            self.serial = 0;
            self.next = None;
            self.error = None;
            let url = args["url"].as_str().ok_or("Missing audio source")?;
            self.send(json!(["set_property", "volume", args["volume"].as_f64().unwrap_or(0.8).clamp(0.0, 1.0) * 100.0]))?;
            self.send(json!(["set_property", "mute", args["muted"].as_bool().unwrap_or(false)]))?;
            self.send(json!(["loadfile", url, "replace"]))?;
            self.send(json!(["set_property", "pause", false]))?;
        } else if operation == "state" {
            return Ok(self.state());
        } else if operation == "stop" {
            self.token = args["token"].as_u64().unwrap_or(self.token);
            self.error = None;
            self.next = None;
            if self.child.is_some() { self.send(json!(["stop"]))?; }
        } else if self.child.is_some() {
            match operation {
                "prepare" => {
                    // A late resolver must not replace the next item after a handoff.
                    let state = self.state();
                    if args["token"] != state["token"] || args["fromKey"] != state["key"] || args["serial"] != state["serial"] { return Ok(state); }
                    self.send(json!(["playlist-clear"]))?;
                    self.next = None;
                    if let Some(url) = args["url"].as_str() {
                        self.send(json!(["loadfile", url, "append"]))?;
                        let playlist = self.property("playlist");
                        let id = playlist.as_array().and_then(|list| list.last()).and_then(|item| item["id"].as_u64()).ok_or("The next song could not be prepared")?;
                        self.next = Some((id, args["key"].as_str().unwrap_or("").to_owned()));
                    }
                }
                "next" => {
                    if self.next.as_ref().is_some_and(|(_, key)| args["key"].as_str() == Some(key.as_str())) {
                        self.send(json!(["playlist-next", "force"]))?;
                        self.send(json!(["set_property", "pause", false]))?;
                    }
                }
                "pause" => { self.send(json!(["set_property", "pause", args["paused"].as_bool().unwrap_or(true)]))?; }
                "seek" => {
                    let seconds = args["seconds"].as_f64().filter(|n| n.is_finite() && *n >= 0.0).ok_or("Invalid seek position")?;
                    self.send(json!(["seek", seconds, "absolute+exact"]))?;
                }
                "volume" => {
                    let volume = args["volume"].as_f64().filter(|n| n.is_finite()).ok_or("Invalid volume")?.clamp(0.0, 1.0);
                    self.send(json!(["set_property", "volume", volume * 100.0]))?;
                    self.send(json!(["set_property", "mute", args["muted"].as_bool().unwrap_or(false)]))?;
                }
                "restore_output" => {
                    let driver = self.property("current-ao");
                    if !matches!(driver.as_str(), Some("pipewire" | "pulse")) {
                        return Err("Choose an output in your system sound settings".into());
                    }
                    self.send(json!(["set_property", "ao-volume", 100]))?;
                    self.send(json!(["set_property", "ao-mute", false]))?;
                }
                _ => return Err("Unknown playback operation".into()),
            }
        } else if !["pause", "volume", "seek"].contains(&operation) {
            return Err("Unknown playback operation".into());
        }
        Ok(self.state())
    }

    pub fn shutdown(&mut self) {
        self.connection = None;
        if let Some(mut child) = self.child.take() { let _ = child.kill(); let _ = child.wait(); }
        self.directory = None;
    }
}

impl Drop for Player {
    fn drop(&mut self) { self.shutdown(); }
}

fn validate_source(value: &str, audio_directory: &Path) -> Result<(), String> {
    if let Ok(url) = tauri::Url::parse(value) {
        let host = url.host_str().unwrap_or("");
        if url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
            && (host == "tracks.monochrome.st" || host.ends_with(".googlevideo.com") || host.ends_with(".audius.co")) {
            return Ok(());
        }
    }
    let local = PathBuf::from(value).canonicalize().map_err(|_| "Unsupported audio source")?;
    let directory = audio_directory.canonicalize().map_err(|_| "Your imported audio folder is unavailable")?;
    if local.starts_with(directory) && local.is_file() { Ok(()) } else { Err("Unsupported audio source".into()) }
}

#[tauri::command]
pub async fn playback(app: tauri::AppHandle, player: tauri::State<'_, Playback>, operation: String, args: Value) -> Result<Value, String> {
    if operation == "load" || operation == "prepare" && args["url"].is_string() {
        let source = args["url"].as_str().ok_or("Missing audio source")?;
        let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
        validate_source(source, &directory.join("audio")).or_else(|_| validate_source(source, &directory.join("downloads")))?;
    }
    let player = player.0.clone();
    tauri::async_runtime::spawn_blocking(move || player.lock().map_err(|_| "The audio player is unavailable".to_owned())?.handle(&operation, &args))
        .await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn wait_ready(player: &mut Player) -> Value {
        let deadline = Instant::now() + Duration::from_secs(25);
        loop {
            let state = player.state();
            assert!(state["error"].is_null(), "{state}");
            if state["ready"] == true { return state; }
            assert!(Instant::now() < deadline, "Audio never became ready: {state}");
            std::thread::sleep(Duration::from_millis(80));
        }
    }

    fn wait_position(player: &mut Player, minimum: f64) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let state = player.state();
            assert!(state["error"].is_null(), "{state}");
            if state["position"].as_f64().unwrap() >= minimum { return; }
            assert!(Instant::now() < deadline, "Seek did not finish: {state}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    #[test]
    fn native_controls_and_source_boundaries() {
        let directory = tempfile::tempdir().unwrap();
        let file = directory.path().join("silence.wav");
        let data_size = 8000u32 * 2 * 8;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF"); wav.extend_from_slice(&(36 + data_size).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt "); wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes()); wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes()); wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data"); wav.extend_from_slice(&data_size.to_le_bytes());
        wav.resize(wav.len() + data_size as usize, 0);
        fs::write(&file, wav).unwrap();
        assert!(validate_source(file.to_str().unwrap(), directory.path()).is_ok());
        assert!(validate_source("/etc/passwd", directory.path()).is_err());
        assert!(validate_source("https://example.org/audio.mp3", directory.path()).is_err());
        assert!(validate_source("https://tracks.monochrome.st/track/159277913216937984", directory.path()).is_ok());
        let mut player = Player::default();
        player.handle("load", &json!({"url": file, "token": 1, "volume": 0.0})).unwrap();
        let state = wait_ready(&mut player);
        assert_eq!(state["token"], 1);
        assert!((state["duration"].as_f64().unwrap() - 8.0).abs() < 0.05);
        std::thread::sleep(Duration::from_millis(250));
        assert!(player.state()["position"].as_f64().unwrap() > 0.1);
        player.handle("pause", &json!({"paused": true})).unwrap();
        let paused = player.state()["position"].as_f64().unwrap();
        std::thread::sleep(Duration::from_millis(180));
        assert!((player.state()["position"].as_f64().unwrap() - paused).abs() < 0.05);
        player.handle("seek", &json!({"seconds": 5.0})).unwrap();
        // mpv's audible clock includes a small audio-output buffer delay.
        wait_position(&mut player, 4.7);
        player.handle("volume", &json!({"volume": 0.3, "muted": true})).unwrap();
        assert_eq!(player.property("mute"), true);
        assert_eq!(player.property("volume"), 30.0);
        player.handle("pause", &json!({"paused": false})).unwrap();
        std::thread::sleep(Duration::from_millis(200));
        assert!(player.state()["position"].as_f64().unwrap() > 5.0);
        player.handle("stop", &json!({"token": 2})).unwrap();
        player.handle("load", &json!({"url": file, "token": 3})).unwrap();
        let switched = wait_ready(&mut player);
        assert_eq!(switched["token"], 3);
        assert!(switched["position"].as_f64().unwrap() < 1.0);
        player.handle("load", &json!({"url": directory.path().join("missing.wav"), "token": 4})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while player.state()["error"].is_null() {
            assert!(Instant::now() < deadline, "Failed audio did not produce an error");
            std::thread::sleep(Duration::from_millis(60));
        }
        player.shutdown();
        assert!(player.child.is_none());
    }

    #[test]
    fn prepared_queue_handoffs_and_edits_keep_the_player_alive() {
        let directory = tempfile::tempdir().unwrap();
        let a = directory.path().join("a.wav");
        let b = directory.path().join("b.wav");
        let c = directory.path().join("c.wav");
        let size = 8000u32 * 2 * 3;
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF"); wav.extend_from_slice(&(36 + size).to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt "); wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes()); wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes()); wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data"); wav.extend_from_slice(&size.to_le_bytes());
        wav.resize(wav.len() + size as usize, 0);
        for file in [&a, &b, &c] { fs::write(file, &wav).unwrap(); }
        let mut player = Player::default();
        player.handle("load", &json!({"url": a, "key": "a", "token": 10, "volume": 0})).unwrap();
        wait_ready(&mut player);
        let pid = player.child.as_ref().unwrap().id();
        player.handle("prepare", &json!({"token": 10, "fromKey": "a", "serial": 0, "url": b, "key": "b"})).unwrap();
        player.handle("prepare", &json!({"token": 10, "fromKey": "a", "serial": 0, "url": c, "key": "c"})).unwrap();
        assert_eq!(player.property("playlist-count"), 2);
        player.handle("seek", &json!({"seconds": 2.6})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while player.state()["serial"] != 1 {
            assert!(Instant::now() < deadline, "Prepared song did not start: {}", player.state());
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(player.state()["key"], "c");
        player.handle("prepare", &json!({"token": 10, "fromKey": "a", "serial": 0, "url": b, "key": "stale"})).unwrap();
        assert!(player.next.is_none(), "A stale preloader replaced the new song's queue");
        player.handle("prepare", &json!({"token": 10, "fromKey": "c", "serial": 1, "url": b, "key": "b"})).unwrap();
        player.handle("next", &json!({"key": "b"})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while player.state()["key"] != "b" {
            assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(20));
        }
        wait_ready(&mut player);
        player.handle("prepare", &json!({"token": 10, "fromKey": "b", "serial": 2, "url": b, "key": "b"})).unwrap();
        player.handle("seek", &json!({"seconds": 2.6})).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while player.state()["serial"] != 3 {
            assert!(Instant::now() < deadline, "Repeat of the same queue entry did not hand off");
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(player.child.as_ref().unwrap().id(), pid);
        assert!(player.state()["error"].is_null());
    }

    #[test]
    fn live_catalog_streams_when_requested() {
        let Ok(streams) = std::env::var("UNDERTONE_TEST_STREAMS") else { return; };
        let urls: Vec<String> = serde_json::from_str(&streams).unwrap();
        let mut player = Player::default();
        for (index, url) in urls.into_iter().enumerate() {
            player.handle("load", &json!({"url": url, "token": index + 1, "volume": 0.0})).unwrap();
            let initial = wait_ready(&mut player);
            assert!(initial["duration"].as_f64().unwrap() > 10.0);
            wait_position(&mut player, initial["position"].as_f64().unwrap() + 0.1);
            let state = player.state();
            assert!(state["error"].is_null(), "{state}");
            assert!(state["position"].as_f64().unwrap() > initial["position"].as_f64().unwrap(), "Audio position did not advance: {state}");
            player.handle("seek", &json!({"seconds": 10.0})).unwrap();
            wait_position(&mut player, 9.7);
            println!("Native stream {} loaded, advanced, and sought successfully", index + 1);
        }
    }
}
