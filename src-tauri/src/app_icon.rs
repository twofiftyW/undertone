use std::{fs, io::{self, Write}, path::Path, sync::Mutex};
use tauri::{image::Image, AppHandle, Manager};
use tempfile::NamedTempFile;

#[cfg(windows)]
mod windows_shell;

#[derive(Clone, Copy, Default)]
enum Icon {
    #[default]
    Green,
    Blue,
    Amoled,
    Gray,
}

impl Icon {
    fn parse(id: &str) -> Option<Self> {
        match id {
            "green" => Some(Self::Green),
            "blue" => Some(Self::Blue),
            "amoled" => Some(Self::Amoled),
            "gray" => Some(Self::Gray),
            _ => None,
        }
    }

    fn id(self) -> &'static str {
        match self { Self::Green => "green", Self::Blue => "blue", Self::Amoled => "amoled", Self::Gray => "gray" }
    }

    fn image(self) -> Image<'static> {
        match self {
            Self::Green => tauri::include_image!("icons/variants/green.png"),
            Self::Blue => tauri::include_image!("icons/variants/blue.png"),
            Self::Amoled => tauri::include_image!("icons/variants/amoled.png"),
            Self::Gray => tauri::include_image!("icons/variants/gray.png"),
        }
    }

    fn file(self) -> &'static [u8] {
        #[cfg(windows)]
        macro_rules! file { ($id:literal) => { include_bytes!(concat!("../icons/variants/", $id, ".ico")) }; }
        #[cfg(target_os = "linux")]
        macro_rules! file { ($id:literal) => { include_bytes!(concat!("../icons/variants/", $id, ".png")) }; }
        match self { Self::Green => file!("green"), Self::Blue => file!("blue"), Self::Amoled => file!("amoled"), Self::Gray => file!("gray") }
    }
}

#[derive(Default)]
struct Selection {
    icon: Icon,
    #[cfg(windows)]
    taskbar: Option<windows_shell::TaskbarIcon>,
}

#[derive(Default)]
pub struct AppIcons(Mutex<Selection>);

fn stage(path: &Path, bytes: &[u8]) -> io::Result<NamedTempFile> {
    let parent = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    fs::create_dir_all(parent)?;
    let mut file = NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    file.flush()?;
    Ok(file)
}

fn install_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if fs::read(path).is_ok_and(|old| old == bytes) { return Ok(()); }
    stage(path, bytes)?.persist(path)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn update_launcher(app: &AppHandle, icon_path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    // Only the copy installed by our install-linux.sh owns this desktop entry.
    let data = app.path().data_dir()?;
    let installed = data.join("undertone/Undertone");
    if app.config().identifier != "personal.undertone.player" || std::env::current_exe()? != installed { return Ok(()); }
    let entry = data.join("applications/personal.undertone.player.desktop");
    let source = match fs::read_to_string(&entry) {
        Ok(source) => source,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    // Keep other desktop groups, user overrides and localized keys intact.
    let mut in_entry = false;
    let mut owns_exec = false;
    let mut output = String::with_capacity(source.len());
    let expected = format!("Exec=\"{}\"", installed.display());
    let icon = icon_path.to_string_lossy().replace('\\', "\\\\");
    for line in source.lines() {
        if line.starts_with('[') { in_entry = line == "[Desktop Entry]"; }
        if in_entry && line == expected { owns_exec = true; }
        if in_entry && line.starts_with("Icon=") {
            output.push_str("Icon="); output.push_str(&icon);
        } else {
            output.push_str(line);
        }
        output.push('\n');
    }
    if owns_exec && output != source {
        let tmp = stage(&entry, output.as_bytes())?;
        tmp.as_file().set_permissions(fs::metadata(&entry)?.permissions())?;
        tmp.persist(&entry)?;
    }
    Ok(())
}

fn apply(app: &AppHandle, _state: &mut Selection, icon: Icon) -> Result<(), Box<dyn std::error::Error>> {
    let window = app.get_webview_window("main").ok_or("Main window is unavailable")?;
    let dir = app.path().app_data_dir()?.join("launcher-icons");
    #[cfg(windows)] let ext = "ico";
    #[cfg(target_os = "linux")] let ext = "png";
    let path = dir.join(format!("{}.{}", icon.id(), ext));
    install_file(&path, icon.file())?;
    window.set_icon(icon.image())?;
    #[cfg(windows)]
    windows_shell::apply(app, &window, &path, &mut _state.taskbar)?;
    #[cfg(target_os = "linux")]
    update_launcher(app, &path)?;
    Ok(())
}

pub fn restore(app: &AppHandle) {
    let result = (|| -> Result<(), Box<dyn std::error::Error>> {
        let path = app.path().app_data_dir()?.join("app-icon");
        let saved = match fs::read_to_string(path) {
            Ok(id) => Icon::parse(id.trim()).unwrap_or_default(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Icon::default(),
            Err(e) => return Err(e.into()),
        };
        let icons = app.state::<AppIcons>();
        let mut state = icons.0.lock().map_err(|_| "Icon preference unavailable")?;
        apply(app, &mut state, saved)?;
        state.icon = saved;
        Ok(())
    })();
    if let Err(e) = result { eprintln!("Could not restore the app icon: {e}"); }
}

#[tauri::command]
pub fn get_app_icon(icons: tauri::State<'_, AppIcons>) -> Result<&'static str, String> {
    icons.0.lock().map(|state| state.icon.id()).map_err(|_| "Icon preference unavailable".into())
}

#[tauri::command]
pub fn set_app_icon(app: AppHandle, icons: tauri::State<'_, AppIcons>, id: String) -> Result<(), String> {
    let icon = Icon::parse(&id).ok_or("Unknown app icon")?;
    let mut state = icons.0.lock().map_err(|_| "Icon preference unavailable")?;
    let path = app.path().app_data_dir().map_err(|e| e.to_string())?.join("app-icon");
    let pending = stage(&path, icon.id().as_bytes()).map_err(|e| e.to_string())?;
    let previous = state.icon;
    let result = apply(&app, &mut state, icon).and_then(|_| { pending.persist(path)?; Ok(()) });
    if let Err(e) = result {
        let _ = apply(&app, &mut state, previous);
        return Err(e.to_string());
    }
    state.icon = icon;
    Ok(())
}

#[cfg(windows)]
pub use windows_shell::clear_window_properties;
