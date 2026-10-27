mod opml;

use std::fs;
use std::path::PathBuf;

use opml::Document;

/// Commands are Rust functions the interface can call with `invoke("name", …)`.
#[tauri::command]
fn open_outline(path: PathBuf) -> Result<Document, String> {
    let xml = fs::read_to_string(&path)
        .map_err(|e| format!("Could not read {}: {e}", path.display()))?;
    opml::parse(&xml)
}

#[tauri::command]
fn save_outline(path: PathBuf, doc: Document) -> Result<(), String> {
    let xml = opml::write(&doc)?;
    // Write a temporary file and then rename it over the original, so a crash
    // or full disk mid-save can never leave a half-written outline behind.
    let temp = path.with_extension("opml.tmp");
    fs::write(&temp, xml).map_err(|e| format!("Could not save {}: {e}", path.display()))?;
    fs::rename(&temp, &path).map_err(|e| format!("Could not save {}: {e}", path.display()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![open_outline, save_outline])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
