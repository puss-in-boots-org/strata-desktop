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

fn main() {
    tauri::Builder::default()
        .manage(Cache::default())
        .invoke_handler(tauri::generate_handler![
            inventory,
            dev_items,
            system_items,
            list_drives,
            why,
            reveal
        ])
        .run(tauri::generate_context!())
        .expect("error while running Strata");
}
