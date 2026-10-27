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

/// Turns on the operating system's spell checker for the text being edited.
/// (Windows' webview does this already.)
#[cfg(target_os = "macos")]
fn enable_spell_checking() {
    use objc2_foundation::{NSString, NSUserDefaults};

    // macOS's webview reads this from the app's preferences. Set it on every
    // launch so checking is always on. Autocorrect isn't set here: it follows
    // "Correct spelling automatically" in System Settings → Keyboard → Text Input.
    let defaults = NSUserDefaults::standardUserDefaults();
    defaults.setBool_forKey(true, &NSString::from_str("WebContinuousSpellCheckingEnabled"));
}

#[cfg(target_os = "linux")]
fn enable_spell_checking_in(webview: &tauri::WebviewWindow) {
    use webkit2gtk::{WebContextExt, WebViewExt};

    // WebKitGTK checks spelling with the system's dictionaries (via Enchant),
    // in the languages of the user's locale, once it's switched on.
    let _ = webview.with_webview(|webview| {
        if let Some(context) = webview.inner().context() {
            context.set_spell_checking_enabled(true);
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    enable_spell_checking();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            #[cfg(target_os = "linux")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    enable_spell_checking_in(&window);
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_outline, save_outline])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
