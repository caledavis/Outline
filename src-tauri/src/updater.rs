//! Auto-update from GitHub Releases (tauri-plugin-updater, signed bundles),
//! offered Sparkle-style in a window of its own, as in Magnolia.
//!
//! - A few seconds after launch, check quietly. If there's a newer version
//!   (and it wasn't skipped), open the update window on the prompt: release
//!   notes, then Skip This Version / Remind Me Later / Install Update.
//!   Nothing downloads until the user agrees.
//! - Install Update downloads in the window (progress, Cancel), then shows
//!   "Ready to Install" with Install and Relaunch. Closing the window at
//!   that point keeps the download; it installs when Outline quits.
//! - Check for Updates… (the Outline menu on a Mac, the ribbon's Help tab)
//!   opens the window at once and shows the check in it: checking, then the
//!   prompt, "You're up to date" or the error. Choosing it while a check is
//!   already running attaches the window to that check.
//! - Skip This Version silences the automatic check until a newer version
//!   is published. Closing the window mid-check or mid-download cancels.
//! - The ribbon's Help tab shows a dot while a newer version is published.
//!
//! The portable Windows .exe can't install an update (the installers would
//! install Outline rather than replace the .exe), so there Install Update
//! opens the download page instead (see `installs_itself`).
//!
//! The window pulls the current view (`update_window_state`) when it loads
//! and follows `update-window:state` after that.
//!
//! Development builds can't check (there's no signed release to compare
//! against). `OUTLINE_FAKE_UPDATE=1` walks the window through a pretend
//! update instead, starting at launch (`=uptodate` and `=error` show those
//! outcomes).
//!
//! `OUTLINE_UPDATE_ENDPOINT=<url of a latest.json>` makes a release build
//! check that manifest instead of GitHub's, so an update can be rehearsed
//! against a local server (RELEASING.md). Plain `http` is allowed only for
//! such an override; signatures are still checked against the built-in key.

use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_updater::{Update, UpdaterExt};

/// The main window, and the update window.
const MAIN: &str = "main";
const UPDATE: &str = "update";

/// Where a build that can't install updates sends people to download one.
const DOWNLOAD_PAGE: &str = "https://github.com/caledavis/Outline/releases/latest";

#[derive(Clone, Copy, PartialEq)]
enum Source {
    Menu,
    Startup,
}

struct Downloaded {
    update: Update,
    bytes: Vec<u8>,
}

static BADGE: Mutex<Option<Value>> = Mutex::new(None);
/// The update the prompt offers, until Install Update downloads it.
static AVAILABLE: Mutex<Option<Update>> = Mutex::new(None);
/// A downloaded update; installs on Install and Relaunch, or on quit.
static DOWNLOADED: Mutex<Option<Downloaded>> = Mutex::new(None);
/// The running download, so Cancel can stop it.
static DOWNLOAD_TASK: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static STARTUP_SCHEDULED: AtomicBool = AtomicBool::new(false);
static CHECKING: AtomicBool = AtomicBool::new(false);
/// What the update window shows (`Value::Null` while it's closed).
static VIEW: Mutex<Value> = Mutex::new(Value::Null);
/// The window is showing the running check, not just waiting for a result.
static FOLLOWING: AtomicBool = AtomicBool::new(false);
/// Bumped when the user cancels; a check that started under an older
/// generation finishes quietly.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Clears `CHECKING` and `FOLLOWING` however a check ends.
struct CheckGuard;

impl Drop for CheckGuard {
    fn drop(&mut self) {
        CHECKING.store(false, Ordering::SeqCst);
        FOLLOWING.store(false, Ordering::SeqCst);
    }
}

/// Points the updater at `OUTLINE_UPDATE_ENDPOINT` when it is set (see the
/// module docs). Applied to the bundled config before the app is built,
/// because the plugin reads its endpoints and transport rules from there.
pub fn with_endpoint_override<R: tauri::Runtime>(mut context: tauri::Context<R>) -> tauri::Context<R> {
    let Ok(endpoint) = std::env::var("OUTLINE_UPDATE_ENDPOINT") else {
        return context;
    };
    let endpoint = endpoint.trim().to_string();
    if endpoint.is_empty() {
        return context;
    }
    eprintln!("[auto-update] checking {endpoint} (OUTLINE_UPDATE_ENDPOINT)");
    let plugins = &mut context.config_mut().plugins.0;
    let updater = plugins.entry("updater".into()).or_insert_with(|| json!({}));
    if let Some(cfg) = updater.as_object_mut() {
        let insecure = endpoint.starts_with("http://");
        cfg.insert("endpoints".into(), json!([endpoint]));
        cfg.insert("dangerousInsecureTransportProtocol".into(), json!(insecure));
    }
    context
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

fn fake_mode() -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var("OUTLINE_FAKE_UPDATE").ok()
    } else {
        None
    }
}

/// Whether this copy can install an update itself: everything but the
/// portable Windows .exe (and a bare Linux binary).
///
/// The bundler marks the app with the installer it went into, but the
/// portable .exe is a copy of the same binary, so it carries one of the
/// Windows marks too. On Windows, then, an installed copy is told apart by
/// where it is: the NSIS installer puts `uninstall.exe` beside it, and the
/// MSI one installs it under Program Files.
fn installs_itself() -> bool {
    use tauri::utils::{config::BundleType, platform::bundle_type};
    if cfg!(target_os = "macos") || fake_mode().is_some() {
        return true;
    }
    if !cfg!(target_os = "windows") {
        return bundle_type().is_some();
    }
    let Some(dir) = std::env::current_exe().ok().and_then(|exe| exe.parent().map(PathBuf::from)) else {
        return false;
    };
    match bundle_type() {
        Some(BundleType::Nsis) => dir.join("uninstall.exe").is_file(),
        Some(BundleType::Msi) => ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
            .iter()
            .filter_map(|var| std::env::var_os(var))
            .any(|root| dir.starts_with(root)),
        _ => false,
    }
}

async fn pause(ms: u64) {
    tauri::async_runtime::spawn_blocking(move || std::thread::sleep(Duration::from_millis(ms)))
        .await
        .ok();
}

// ── Skip This Version ──

fn state_file(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("update-state.json"))
}

fn skipped_version(app: &AppHandle) -> Option<String> {
    let text = std::fs::read_to_string(state_file(app)?).ok()?;
    let state: Value = serde_json::from_str(&text).ok()?;
    state.get("skippedVersion")?.as_str().map(str::to_string)
}

fn set_skipped_version(app: &AppHandle, version: &str) {
    let Some(path) = state_file(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(path, json!({ "skippedVersion": version }).to_string());
}

// ── The ribbon's badge ──

fn badge_state(app: &AppHandle) -> Value {
    BADGE
        .lock()
        .unwrap()
        .clone()
        .unwrap_or_else(|| json!({ "available": false, "latestVersion": null, "currentVersion": current_version(app) }))
}

fn set_badge(app: &AppHandle, latest: Option<&str>) {
    let available = latest.is_some_and(|v| skipped_version(app).as_deref() != Some(v));
    let state = json!({ "available": available, "latestVersion": latest, "currentVersion": current_version(app) });
    *BADGE.lock().unwrap() = Some(state.clone());
    let _ = app.emit_to(MAIN, "update:badge", state);
}

// ── The update window ──

/// The window's title: Software Update on macOS, as in other Mac apps.
fn window_title() -> &'static str {
    if cfg!(target_os = "macos") { "Software Update" } else { "Outline Update" }
}

/// Keep in step with STATUS_WIDTH in update.ts.
const STATUS_WIDTH: f64 = 440.0;

/// Open (or raise) the window: a small status panel while checking or
/// downloading, a larger resizable one for the prompt. It has a native
/// title bar, unlike the main window.
fn open_window(app: &AppHandle, prompt: bool) {
    // The status panel's height is a first guess; it fits itself to its
    // content (`update_window_fit`).
    let (width, height) = if prompt { (620.0, 420.0) } else { (STATUS_WIDTH, 150.0) };
    let min = LogicalSize::new(500.0, 340.0);
    if let Some(w) = app.get_webview_window(UPDATE) {
        if w.is_resizable().unwrap_or(prompt) != prompt {
            let _ = w.set_resizable(prompt);
            let _ = w.set_min_size(prompt.then_some(min));
            let _ = w.set_size(LogicalSize::new(width, height));
            let _ = w.center();
        }
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let builder = WebviewWindowBuilder::new(app, UPDATE, WebviewUrl::App("update.html".into()))
        .title(window_title())
        .inner_size(width, height)
        .resizable(prompt)
        .minimizable(false)
        .maximizable(false)
        .visible(false)
        .center()
        .on_page_load(|w, p| {
            if matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        });
    let builder = if prompt { builder.min_inner_size(min.width, min.height) } else { builder };
    match builder.build() {
        Ok(w) => {
            let handle = app.clone();
            w.on_window_event(move |e| {
                if let WindowEvent::Destroyed = e {
                    on_window_destroyed(&handle);
                }
            });
        }
        Err(e) => eprintln!("[auto-update] could not open the update window: {e}"),
    }
}

fn close_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(UPDATE) {
        let _ = w.close();
    }
}

/// Open (or raise) the window on `view`.
fn show(app: &AppHandle, view: Value) {
    let prompt = view["state"] == "available";
    *VIEW.lock().unwrap() = view.clone();
    open_window(app, prompt);
    let _ = app.emit_to(UPDATE, "update-window:state", view);
}

/// Change what an open window shows without raising it (progress ticks).
fn refresh(app: &AppHandle, view: Value) {
    *VIEW.lock().unwrap() = view.clone();
    let _ = app.emit_to(UPDATE, "update-window:state", view);
}

fn view_state() -> Option<String> {
    VIEW.lock().unwrap()["state"].as_str().map(str::to_string)
}

fn following() -> bool {
    FOLLOWING.load(Ordering::SeqCst)
}

/// Show a step of the check, if the window is following it.
fn report(app: &AppHandle, view: Value) {
    if following() {
        show(app, view);
    }
}

fn checking_view() -> Value {
    json!({ "state": "checking" })
}

fn downloading_view(version: &str, received: u64, total: Option<u64>) -> Value {
    json!({ "state": "downloading", "version": version, "received": received, "total": total })
}

fn ready_view(version: &str) -> Value {
    json!({ "state": "ready", "version": version })
}

fn error_view(title: &str, message: &str) -> Value {
    json!({ "state": "error", "title": title, "message": message })
}

fn up_to_date_view(version: &str) -> Value {
    json!({ "state": "up-to-date", "version": version })
}

/// The prompt. `date` is the release day as YYYY-MM-DD.
fn available_view(version: &str, current: &str, date: Option<String>, notes: &str) -> Value {
    json!({
        "state": "available",
        "version": version,
        "currentVersion": current,
        "releaseDate": date,
        "releaseNotes": notes,
        "installsItself": installs_itself(),
    })
}

/// The window closed, by its close button or after a choice. Mid-check or
/// mid-download that means Cancel; on the prompt, Remind Me Later; on
/// "Ready to Install", install on quit.
fn on_window_destroyed(_app: &AppHandle) {
    let mut view = VIEW.lock().unwrap();
    match view["state"].as_str() {
        Some("checking") => {
            GENERATION.fetch_add(1, Ordering::SeqCst);
        }
        Some("downloading") => {
            if let Some(task) = DOWNLOAD_TASK.lock().unwrap().take() {
                task.abort();
            }
        }
        _ => {}
    }
    FOLLOWING.store(false, Ordering::SeqCst);
    *view = Value::Null;
}

/// The main window closed: the update window goes too, so Outline quits
/// (installing a downloaded update on the way out).
pub fn on_main_destroyed(app: &AppHandle) {
    close_window(app);
}

// ── Checking ──

/// Development: with `OUTLINE_FAKE_UPDATE` set, run a pretend
/// Check for Updates… at launch.
fn preview_at_launch(app: &AppHandle) {
    if fake_mode().is_some() {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            pause(1500).await;
            check_manually(&app);
        });
    }
}

/// Called once the main window is up.
pub fn start(app: &AppHandle) {
    if fake_mode().is_some() {
        return preview_at_launch(app);
    }
    if STARTUP_SCHEDULED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        pause(5000).await;
        run_check(&app, Source::Startup).await;
    });
}

/// Check for Updates…
pub fn check_manually(app: &AppHandle) {
    if cfg!(debug_assertions) && fake_mode().is_none() {
        show(
            app,
            error_view(
                "Update checks are off in development",
                "Build a release (npm run tauri build) to try the update flow, or set OUTLINE_FAKE_UPDATE=1 to preview this window.",
            ),
        );
        return;
    }
    // Mid-download or ready to install: that's already the answer.
    if matches!(view_state().as_deref(), Some("downloading" | "ready" | "installing")) {
        open_window(app, false);
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { run_check(&app, Source::Menu).await });
}

async fn run_check(app: &AppHandle, source: Source) {
    if source == Source::Menu {
        // A check that's already running (say the startup one) carries on
        // and reports to the window from here; otherwise this one starts
        // at "Checking…".
        FOLLOWING.store(true, Ordering::SeqCst);
        let view = VIEW.lock().unwrap().clone();
        let running = CHECKING.load(Ordering::SeqCst);
        show(app, if running && !view.is_null() { view } else { checking_view() });
    }
    if CHECKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let _guard = CheckGuard;
    if let Some(mode) = fake_mode() {
        return fake_check(app, source, &mode).await;
    }
    if cfg!(debug_assertions) {
        return;
    }
    let generation = GENERATION.load(Ordering::SeqCst);
    let cancelled = || GENERATION.load(Ordering::SeqCst) != generation;
    let result = async {
        let updater = app.updater().map_err(|e| e.to_string())?;
        updater.check().await.map_err(|e| e.to_string())
    }
    .await;
    if cancelled() {
        return;
    }

    let update = match result {
        Ok(u) => u,
        Err(e) => {
            eprintln!("[auto-update] check failed: {e}");
            report(app, error_view("Could not check for updates", &e));
            return;
        }
    };
    let Some(update) = update else {
        set_badge(app, None);
        report(app, up_to_date_view(&current_version(app)));
        return;
    };
    set_badge(app, Some(&update.version));
    // Skip This Version silences the automatic check only.
    if source == Source::Startup && !following() && skipped_version(app).as_deref() == Some(update.version.as_str()) {
        return;
    }
    // Downloaded earlier and closed at "Ready to Install": offer the install.
    let downloaded = DOWNLOADED
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|d| d.update.version == update.version);
    if downloaded {
        return show(app, ready_view(&update.version));
    }
    let view = available_view(
        &update.version,
        &update.current_version,
        update
            .date
            .map(|d| format!("{:04}-{:02}-{:02}", d.year(), u8::from(d.month()), d.day())),
        update.body.as_deref().unwrap_or_default(),
    );
    *AVAILABLE.lock().unwrap() = Some(update);
    show(app, view);
}

// ── Downloading ──

/// Install Update: download in the window, then "Ready to Install".
fn start_download(app: &AppHandle) {
    let mut task = DOWNLOAD_TASK.lock().unwrap();
    if task.as_ref().is_some_and(|t| !t.inner().is_finished()) {
        return;
    }
    let app = app.clone();
    *task = Some(tauri::async_runtime::spawn(async move {
        if fake_mode().is_some() {
            fake_download(&app).await;
        } else {
            download(&app).await;
        }
        DOWNLOAD_TASK.lock().unwrap().take();
    }));
}

async fn download(app: &AppHandle) {
    let Some(update) = AVAILABLE.lock().unwrap().clone() else {
        return;
    };
    show(app, downloading_view(&update.version, 0, None));
    let mut received = 0u64;
    let mut last_tick = Instant::now();
    let progress = |chunk: usize, total: Option<u64>| {
        received += chunk as u64;
        if last_tick.elapsed() >= Duration::from_millis(100) {
            last_tick = Instant::now();
            refresh(app, downloading_view(&update.version, received, total));
        }
    };
    match update.download(progress, || {}).await {
        Ok(bytes) => {
            let version = update.version.clone();
            *DOWNLOADED.lock().unwrap() = Some(Downloaded { update, bytes });
            AVAILABLE.lock().unwrap().take();
            show(app, ready_view(&version));
        }
        Err(e) => {
            eprintln!("[auto-update] download failed: {e}");
            show(app, error_view("Could not download the update", &e.to_string()));
        }
    }
}

// ── Installing ──

/// A downloaded update that wasn't installed yet installs as Outline quits.
pub fn install_pending_on_quit() {
    if let Err(e) = install_pending() {
        eprintln!("[auto-update] install on quit failed: {e}");
    }
}

fn install_pending() -> Result<(), tauri_plugin_updater::Error> {
    match DOWNLOADED.lock().unwrap().take() {
        Some(d) => d.update.install(&d.bytes),
        None => Ok(()),
    }
}

fn skip(app: &AppHandle, version: &str) {
    set_skipped_version(app, version);
    let mut available = AVAILABLE.lock().unwrap();
    if available.as_ref().is_some_and(|u| u.version == version) {
        *available = None;
    }
    drop(available);
    let latest = badge_state(app)
        .get("latestVersion")
        .and_then(Value::as_str)
        .map(str::to_string);
    if latest.as_deref() == Some(version) {
        set_badge(app, Some(version));
    }
}

// ── Development stand-ins ──

/// `run_check` on a timer, ending at the prompt (or `=uptodate` / `=error`).
async fn fake_check(app: &AppHandle, _source: Source, mode: &str) {
    let generation = GENERATION.load(Ordering::SeqCst);
    let cancelled = || GENERATION.load(Ordering::SeqCst) != generation;
    let current = current_version(app);
    let version = "99.0.0";
    pause(1500).await;
    if cancelled() {
        return;
    }
    match mode {
        "uptodate" => return report(app, up_to_date_view(&current)),
        "error" => {
            let e = "error sending request for url (https://github.com/caledavis/Outline/releases/latest/download/latest.json)";
            return report(app, error_view("Could not check for updates", e));
        }
        _ => {}
    }
    set_badge(app, Some(version));
    let notes = "## What's new\n\n\
        - **Ribbon**: the toolbar is now a ribbon of labelled buttons, as in Magnolia.\n\
        - Outline checks for updates and offers them in a window of their own.\n\n\
        ## Fixes\n\n\
        - Long outlines scroll more smoothly.";
    show(app, available_view(version, &current, Some("2026-11-09".into()), notes));
}

/// `download` on a timer.
async fn fake_download(app: &AppHandle) {
    let version = "99.0.0";
    let total = 9_800_000u64;
    show(app, downloading_view(version, 0, Some(total)));
    for step in 1..=50u64 {
        pause(60).await;
        refresh(app, downloading_view(version, total * step / 50, Some(total)));
    }
    show(app, ready_view(version));
}

// ── Commands ──

#[tauri::command]
pub fn get_update_badge(app: AppHandle) -> Value {
    badge_state(&app)
}

#[tauri::command]
pub fn check_for_updates(app: AppHandle) {
    check_manually(&app);
}

#[tauri::command]
pub fn update_window_state() -> Value {
    VIEW.lock().unwrap().clone()
}

/// The window's default button. On the prompt, Install Update downloads (or,
/// for a copy that can't install, opens the download page). Once
/// downloaded, Install and Relaunch asks the main window to deal with
/// unsaved changes first (`update:install-requested`); it answers with
/// `update_relaunch` or `update_install_cancelled`.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    match view_state().as_deref() {
        Some("available") if !installs_itself() => {
            use tauri_plugin_opener::OpenerExt;
            app.opener().open_url(DOWNLOAD_PAGE, None::<&str>).map_err(|e| e.to_string())?;
            close_window(&app);
        }
        Some("available") => start_download(&app),
        Some("ready") => {
            let version = VIEW.lock().unwrap()["version"].clone();
            show(&app, json!({ "state": "installing", "version": version }));
            if fake_mode().is_some() {
                pause(2000).await;
                close_window(&app);
            } else if app.get_webview_window(MAIN).is_some() {
                let _ = app.emit_to(MAIN, "update:install-requested", ());
            } else {
                update_relaunch(app).await;
            }
        }
        _ => {}
    }
    Ok(())
}

/// The main window agreed to Install and Relaunch: install, then relaunch.
/// A deb or rpm install waits here for the password prompt. A failure (a
/// wrong or cancelled password among them) shows in the update window, and
/// Outline carries on with the version that's installed.
#[tauri::command]
pub async fn update_relaunch(app: AppHandle) {
    match install_pending() {
        Ok(()) => app.restart(),
        Err(e) => {
            eprintln!("[auto-update] install failed: {e}");
            let message = format!(
                "Outline {} is still installed, and will offer the update again. The error was: {e}",
                current_version(&app)
            );
            show(&app, error_view("Could not install the update", &message));
        }
    }
}

/// The main window kept its unsaved changes: back to "Ready to Install".
#[tauri::command]
pub fn update_install_cancelled(app: AppHandle) {
    if view_state().as_deref() == Some("installing") {
        let version = VIEW.lock().unwrap()["version"].as_str().unwrap_or_default().to_string();
        show(&app, ready_view(&version));
    }
}

/// The status panel reports how many points its content overflows (or
/// underfills) the window by, so the window fits it. The page measures the
/// shortfall against its own viewport, so this needn't know how tall the
/// title bar is. On macOS `set_size` sets the whole frame (and
/// `inner_size` lags behind), so it's applied to the outer size there.
#[tauri::command]
pub fn update_window_fit(app: AppHandle, delta: f64) {
    let Some(w) = app.get_webview_window(UPDATE) else { return };
    if w.is_resizable().unwrap_or(true) || delta.abs() < 0.5 {
        return;
    }
    let size = if cfg!(target_os = "macos") { w.outer_size() } else { w.inner_size() };
    if let (Ok(size), Ok(scale)) = (size, w.scale_factor()) {
        let height = (size.height as f64 / scale + delta).clamp(100.0, 520.0);
        let _ = w.set_size(LogicalSize::new(STATUS_WIDTH, height));
    }
}

#[tauri::command]
pub fn update_skip(app: AppHandle, version: String) {
    skip(&app, &version);
    close_window(&app);
}

/// Remind Me Later, Cancel and OK: close the window (see
/// `on_window_destroyed` for what closing means at each step).
#[tauri::command]
pub fn update_dismiss(app: AppHandle) {
    close_window(&app);
}
