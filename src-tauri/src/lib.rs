mod opml;
mod zotero;

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

/// Searches the user's Zotero library (see zotero.rs).
#[tauri::command]
async fn zotero_search(query: String) -> Result<Vec<zotero::Item>, String> {
    // The request waits on the network, so keep it off the main thread.
    tauri::async_runtime::spawn_blocking(move || zotero::search(&query))
        .await
        .map_err(|e| e.to_string())?
}

/// The notes attached to a Zotero item, as HTML (see zotero.rs).
#[tauri::command]
async fn zotero_notes(uri: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || zotero::notes(&uri))
        .await
        .map_err(|e| e.to_string())?
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

/// The standard macOS menu without "Close Window": its ⌘W would close the
/// whole window, and in Outline ⌘W closes the current tab (see main.ts).
#[cfg(target_os = "macos")]
fn app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItemKind};
    let menu = Menu::default(app)?;
    for item in menu.items()? {
        let MenuItemKind::Submenu(submenu) = item else { continue };
        for entry in submenu.items()? {
            if let MenuItemKind::Predefined(predefined) = &entry {
                if predefined.text()? == "Close Window" {
                    submenu.remove(&entry)?;
                }
            }
        }
        // Tidy up what's left: the File menu held only that item, and the
        // Window menu's last separator came before it.
        let entries = submenu.items()?;
        if entries.is_empty() && submenu.text()? == "File" {
            menu.remove(&submenu)?;
        } else if let Some(MenuItemKind::Predefined(last)) = entries.last() {
            if last.text()?.is_empty() {
                submenu.remove(last)?;
            }
        }
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    enable_spell_checking();

    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = builder.menu(app_menu);

    builder
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
        .invoke_handler(tauri::generate_handler![open_outline, save_outline, zotero_search, zotero_notes])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
