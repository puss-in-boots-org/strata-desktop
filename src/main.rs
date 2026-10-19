// No console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::path::PathBuf;
use std::sync::Mutex;
use strata_core::attribute::Why;
use strata_core::dev::{self, DevItem};
use strata_core::drives::{self, Drive};
use strata_core::system::{self, SystemItem};
use strata_core::{build_inventory, discover_apps, Inventory};
use tauri::{AppHandle, Emitter, State};

/// The last inventory, so switching views and `why` are instant.
#[derive(Default)]
struct Cache {
    inventory: Mutex<Option<Inventory>>,
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> T + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn inventory(
    app: AppHandle,
    state: State<'_, Cache>,
    rescan: bool,
) -> Result<Inventory, String> {
    if !rescan {
        let cached = state.inventory.lock().unwrap().clone();
        if let Some(inv) = cached {
            return Ok(inv);
        }
    }
    let inv = blocking(move || {
        let progress = |s: &str| {
            let _ = app.emit("scan-progress", s.to_string());
        };
        progress("Finding installed apps");
        build_inventory(discover_apps(), &progress)
    })
    .await?;
    *state.inventory.lock().unwrap() = Some(inv.clone());
    Ok(inv)
}

#[derive(Serialize)]
struct DevOut {
    projects: Vec<DevItem>,
    global: Vec<DevItem>,
}

#[tauri::command]
async fn dev_items() -> Result<DevOut, String> {
    blocking(|| DevOut {
        projects: dev::find_project_clutter(&dev::default_project_roots()),
        global: dev::find_global_clutter(),
    })
    .await
}

#[tauri::command]
async fn system_items() -> Result<Vec<SystemItem>, String> {
    blocking(system::system_items).await
}

#[tauri::command]
fn list_drives() -> Vec<Drive> {
    drives::drives()
}

/// Which app a dropped file or folder belongs to.
#[tauri::command]
fn why(state: State<'_, Cache>, path: String) -> Result<Option<Why>, String> {
    let guard = state.inventory.lock().unwrap();
    let inv = guard.as_ref().ok_or("still scanning")?;
    Ok(inv.why(&PathBuf::from(path)))
}

/// The front end says it drew its first frame (logged, for diagnosing
/// launches that close early).
#[tauri::command]
fn ui_ready() {
    log("ui ready");
}

/// Show a file or folder in Explorer. Strata never changes anything itself.
#[tauri::command]
fn reveal(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("{path} no longer exists"));
    }
    let mut cmd = std::process::Command::new("explorer.exe");
    if p.is_dir() {
        cmd.arg(&p);
    } else {
        cmd.arg(format!("/select,{}", p.display()));
    }
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// `%LOCALAPPDATA%\org.pussinboots.strata\strata.log`: why Strata closed,
/// when it did. A release build has no console, so this is the only trace.
fn log_path() -> Option<PathBuf> {
    let dir = PathBuf::from(std::env::var_os("LOCALAPPDATA")?).join("org.pussinboots.strata");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join("strata.log"))
}

fn log(line: &str) {
    use std::io::Write;
    let Some(p) = log_path() else { return };
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(p) {
        let _ = writeln!(f, "[{secs}] {line}");
    }
}

/// Tell the user instead of vanishing.
fn fatal(msg: &str) {
    log(&format!("FATAL: {msg}"));
    let text = format!(
        "Strata couldn't start.\n\n{msg}\n\nDetails are in %LOCALAPPDATA%\\org.pussinboots.strata\\strata.log"
    );
    let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
    let (t, c) = (wide(&text), wide("Strata"));
    // SAFETY: both strings are NUL-terminated and outlive the call.
    unsafe {
        windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW(
            std::ptr::null_mut(),
            t.as_ptr(),
            c.as_ptr(),
            windows_sys::Win32::UI::WindowsAndMessaging::MB_ICONERROR,
        );
    }
}

fn main() {
    std::panic::set_hook(Box::new(|info| {
        let at = info
            .location()
            .map(|l| format!(" at {}:{}", l.file(), l.line()))
            .unwrap_or_default();
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".into());
        fatal(&format!("{what}{at}"));
    }));
    log(&format!("start {}", env!("CARGO_PKG_VERSION")));

    let result = tauri::Builder::default()
        .manage(Cache::default())
        .invoke_handler(tauri::generate_handler![
            inventory,
            dev_items,
            system_items,
            list_drives,
            why,
            reveal,
            ui_ready
        ])
        .setup(|_| {
            log("window created");
            Ok(())
        })
        .run(tauri::generate_context!());
    match result {
        Ok(()) => log("closed"),
        Err(e) => fatal(&e.to_string()),
    }
}
