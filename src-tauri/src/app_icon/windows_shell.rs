use std::{fs, path::Path};
use tauri::{AppHandle, WebviewWindow};
use windows::{
    core::{HSTRING, Interface},
    Win32::{
        Foundation::{HWND, LPARAM, PROPERTYKEY, WPARAM},
        Storage::EnhancedStorage::{PKEY_AppUserModel_ID, PKEY_AppUserModel_RelaunchCommand, PKEY_AppUserModel_RelaunchDisplayNameResource, PKEY_AppUserModel_RelaunchIconResource},
        System::Com::{CoCreateInstance, IPersistFile, StructuredStorage::PROPVARIANT, CLSCTX_INPROC_SERVER, STGM_READ},
        UI::{
            Shell::{IShellLinkW, PropertiesSystem::{IPropertyStore, PSCoerceToCanonicalValue, SHGetPropertyStoreForWindow}, ShellLink, SHChangeNotify, SHCNE_UPDATEITEM, SHCNF_PATHW},
            WindowsAndMessaging::{DestroyIcon, LoadImageW, SendMessageW, HICON, ICON_BIG, IMAGE_ICON, LR_LOADFROMFILE, WM_SETICON},
        },
    },
};

// WM_SETICON borrows this handle until the icon is replaced or the window closes.
pub(super) struct TaskbarIcon(isize);
impl Drop for TaskbarIcon {
    fn drop(&mut self) { unsafe { let _ = DestroyIcon(HICON(self.0 as _)); } }
}

fn property(store: &IPropertyStore, key: &PROPERTYKEY, text: &str) -> windows::core::Result<()> {
    let mut value = PROPVARIANT::from(text);
    unsafe {
        PSCoerceToCanonicalValue(key, &mut value)?;
        store.SetValue(key, &value)
    }
}

fn relaunch(hwnd: HWND, id: &str, title: &str, exe: &Path, icon: &Path) -> windows::core::Result<()> {
    let store: IPropertyStore = unsafe { SHGetPropertyStoreForWindow(hwnd)? };
    property(&store, &PKEY_AppUserModel_RelaunchCommand, &format!("\"{}\"", exe.display()))?;
    property(&store, &PKEY_AppUserModel_RelaunchDisplayNameResource, title)?;
    property(&store, &PKEY_AppUserModel_RelaunchIconResource, &format!("{},0", icon.display()))?;
    property(&store, &PKEY_AppUserModel_ID, id)
}

pub fn clear_window_properties(window: &tauri::Window) {
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            if let Ok(store) = SHGetPropertyStoreForWindow::<IPropertyStore>(hwnd) {
                for key in [PKEY_AppUserModel_ID, PKEY_AppUserModel_RelaunchIconResource, PKEY_AppUserModel_RelaunchDisplayNameResource, PKEY_AppUserModel_RelaunchCommand] {
                    let _ = store.SetValue(&key, &PROPVARIANT::default());
                }
            }
        }
    }
}

fn shortcut(exe: &Path, icon: &Path, id: &str) -> Result<(), Box<dyn std::error::Error>> {
    let dir = exe.parent().ok_or("Missing application directory")?;
    let path = dir.join("Undertone Alpha.lnk");
    let description = format!("Launch Undertone Alpha ({id})");
    let wide_path = HSTRING::from(path.as_path());
    unsafe {
        if path.try_exists()? {
            // Loading an existing link read-only also makes its property store read-only.
            // Inspect ownership on a separate object; the replacement is always built fresh.
            let existing: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            let persisted: IPersistFile = existing.cast()?;
            persisted.Load(&wide_path, STGM_READ)?;
            let mut buffer = [0; 1024];
            existing.GetDescription(&mut buffer)?;
            let length = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
            if String::from_utf16_lossy(&buffer[..length]) != description { return Ok(()); }
        }
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        let file: IPersistFile = link.cast()?;
        link.SetPath(&HSTRING::from(exe))?;
        link.SetWorkingDirectory(&HSTRING::from(dir))?;
        link.SetIconLocation(&HSTRING::from(icon), 0)?;
        link.SetDescription(&HSTRING::from(description))?;
        let store: IPropertyStore = link.cast()?;
        property(&store, &PKEY_AppUserModel_ID, id)?;
        store.Commit()?;
        let temporary = tempfile::tempdir_in(dir)?;
        let staged = temporary.path().join("Undertone Alpha.lnk");
        file.Save(&HSTRING::from(staged.as_path()), true)?;
        drop(file);
        drop(store);
        drop(link);
        fs::rename(staged, &path)?;
        SHChangeNotify(SHCNE_UPDATEITEM, SHCNF_PATHW, Some(wide_path.as_ptr().cast()), None);
    }
    Ok(())
}

pub(super) fn apply(
    app: &AppHandle, window: &WebviewWindow, icon: &Path, current: &mut Option<TaskbarIcon>,
) -> Result<(), Box<dyn std::error::Error>> {
    let hwnd = window.hwnd()?;
    let exe = std::env::current_exe()?;
    let id = &app.config().identifier;
    let title = window.title()?;
    // Tauri sets ICON_SMALL; ICON_BIG is used by Alt+Tab and the unpinned taskbar button.
    let image = unsafe { LoadImageW(None, &HSTRING::from(icon), IMAGE_ICON, 64, 64, LR_LOADFROMFILE)? };
    let next = TaskbarIcon(image.0 as isize);
    unsafe { SendMessageW(hwnd, WM_SETICON, Some(WPARAM(ICON_BIG as _)), Some(LPARAM(next.0))); }
    *current = Some(next);
    relaunch(hwnd, id, &title, &exe, icon)?;
    // A portable folder may be read-only. The live window and relaunch properties still work.
    if let Err(e) = shortcut(&exe, icon, id) { eprintln!("Could not update Undertone Alpha.lnk: {e}"); }
    Ok(())
}
