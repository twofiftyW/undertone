use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

static INSTALL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

#[tauri::command]
pub async fn app_update(app: AppHandle, operation: String, value: Option<String>) -> Result<Value, String> {
    if !["status", "check", "install"].contains(&operation.as_str()) {
        return Err("Unknown update request.".into());
    }
    let storage = app.path().app_local_data_dir().map_err(|_| "Update settings are unavailable.")?;
    if operation == "status" { let _ = fs::remove_file(storage.join("github-update-token")); }
    let status = storage.join("update-result");
    let script = crate::music::backend_path(&app)?.with_file_name("updates.py");
    let options = json!({
        "operation": operation,
        "current": app.package_info().version.to_string(),
        "platform": std::env::consts::OS,
        "value": value.unwrap_or_default(),
    });
    if operation != "install" {
        let mut data = crate::music::python_request(&app, &script, options, Duration::from_secs(50)).await?;
        if operation == "status" {
            if let Ok(result) = fs::read_to_string(&status) {
                data["result"] = json!(result.trim());
                let _ = fs::remove_file(status);
            }
        }
        return Ok(data);
    }

    let _install = INSTALL.try_lock().map_err(|_| "An update is already being installed.")?;
    let exe = packaged_executable()?;
    fs::create_dir_all(&storage).map_err(|_| "Update settings are unavailable.")?;
    let stage = tempfile::Builder::new().prefix(".undertone-update-")
        .tempdir_in(exe.parent().ok_or("Undertone's install folder is unavailable.")?)
        .map_err(|_| "Undertone’s install folder needs to be writable to update.")?;
    let mut options = options;
    options["destination"] = json!(stage.path());
    crate::music::python_request(&app, &script, options, Duration::from_secs(600)).await?;
    launch_installer(stage.path(), &exe, &status).map_err(|_| "Could not start the Undertone installer.")?;
    let _stage = stage.keep();
    app.exit(0);
    Ok(json!({ "ready": true }))
}

fn packaged_executable() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|_| "Undertone's install folder is unavailable.")?;
    let name = if cfg!(target_os = "windows") { "Undertone.exe" } else { "Undertone" };
    if std::env::consts::ARCH != "x86_64" || !exe.file_name().and_then(|name| name.to_str()).is_some_and(|file| file.eq_ignore_ascii_case(name))
        || !exe.with_file_name("music/backend.py").is_file()
    {
        return Err("Install an official Undertone release to use automatic updates.".into());
    }
    Ok(exe)
}

fn launch_installer(stage: &Path, exe: &Path, status: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("python3");
        command.args(["-I", "-B"]).arg(stage.join("apply.py")).arg("apply")
            .arg(stage).arg(exe).arg(std::process::id().to_string()).arg(status);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        use std::os::windows::process::CommandExt;
        let powershell = std::env::var_os("SystemRoot")
            .map(PathBuf::from).ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))?
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = Command::new(powershell);
        command.creation_flags(0x08000000) // CREATE_NO_WINDOW
            .env("UNDERTONE_UPDATE_STAGE", stage)
            .env("UNDERTONE_UPDATE_EXE", exe)
            .env("UNDERTONE_UPDATE_PARENT", std::process::id().to_string())
            .env("UNDERTONE_UPDATE_RESULT", status)
            .args(["-NoProfile", "-NonInteractive", "-Command", r#"
                $stage = $env:UNDERTONE_UPDATE_STAGE
                $exe = $env:UNDERTONE_UPDATE_EXE
                $result = $env:UNDERTONE_UPDATE_RESULT
                try {
                    $ErrorActionPreference = 'Stop'
                    & (Join-Path $stage 'runner/python.exe') '-I' '-B' (Join-Path $stage 'apply.py') 'apply' $stage $exe $env:UNDERTONE_UPDATE_PARENT $result
                    $recovery = $LASTEXITCODE -eq 2
                    if ($LASTEXITCODE -ne 0 -and -not (Test-Path -LiteralPath $result)) {
                        Set-Content -LiteralPath $result -Value 'failed' -Encoding ascii
                    }
                } catch {
                    Set-Content -LiteralPath $result -Value 'failed' -Encoding ascii
                } finally {
                    if (-not $recovery) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
                    Start-Process -FilePath $exe -WorkingDirectory (Split-Path -LiteralPath $exe)
                }
            "#]);
        command
    };
    command.current_dir(exe.parent().unwrap_or_else(|| Path::new(".")))
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null())
        .spawn()?;
    Ok(())
}
