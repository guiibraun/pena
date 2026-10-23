// Pena desktop app: a WebKit window (the system's, no bundled Chromium) with a tab per document, each tab on its own
// compiled Pena server (`pena-server`, see sidecar.mjs), plus the native menus and file dialogs, like pen.dev's.
// Agents still run on your Claude/ChatGPT subscriptions, through the `claude`/`codex` CLIs you installed.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Rect, RunEvent, Url, Webview, WebviewBuilder, WebviewUrl, Window, WindowBuilder, WindowEvent, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::UpdaterExt;

// One pena-server per tab (its own file, port and agents), keyed by the tab's webview label: (url, process).
static SERVERS: Mutex<Option<HashMap<String, (String, Child)>>> = Mutex::new(None);
static NEXT_TAB: AtomicUsize = AtomicUsize::new(0);
// The tabs, in bar order: (webview label, name), and the active one's label.
struct Tabs {
    list: Vec<(String, String)>,
    active: String,
}
static TABS: Mutex<Tabs> = Mutex::new(Tabs { list: Vec::new(), active: String::new() });
// The tab bar strip on top of the window (tabbar.html); the documents fill the rest.
const BAR_H: f64 = 40.0;
const DASHBOARD: &str = "Dashboard";
static MENU_LOCALE: Mutex<&'static str> = Mutex::new("en");
// macOS delivers the files of a launching double-click before setup has made the first window; None after setup.
static LAUNCH_FILES: Mutex<Option<Vec<PathBuf>>> = Mutex::new(Some(Vec::new()));

fn base(w: &Webview) -> String {
    SERVERS.lock().unwrap().as_ref().and_then(|m| m.get(w.label())).map(|(u, _)| u.clone()).unwrap_or_default()
}

// Tiny HTTP/1.0 client for a window's server (HTTP/1.0: no chunked replies to decode).
fn api(w: &Webview, method: &str, path: &str, body: &str) -> String {
    let base = base(w);
    let host = base.trim_start_matches("http://");
    let Ok(mut s) = TcpStream::connect(host) else { return String::new() };
    let _ = write!(s, "{method} {path} HTTP/1.0\r\nHost: {host}\r\nContent-Length: {}\r\n\r\n{body}", body.len());
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default()
}

fn main_window(app: &AppHandle) -> Option<Window> {
    app.get_window("main")
}
// The document the menus and dialogs act on: the active tab.
fn win(app: &AppHandle) -> Option<Webview> {
    let active = TABS.lock().unwrap().active.clone();
    app.get_webview(&active)
}
fn docs(app: &AppHandle) -> Vec<Webview> {
    let labels: Vec<String> = TABS.lock().unwrap().list.iter().map(|(l, _)| l.clone()).collect();
    labels.iter().filter_map(|l| app.get_webview(l)).collect()
}
fn go(w: &Webview, page: &str) {
    if let Ok(u) = Url::parse(&format!("{}{page}", base(w))) {
        let _ = w.navigate(u);
    }
}
fn js(app: &AppHandle, code: &str) {
    if let Some(w) = win(app) {
        let _ = w.eval(code);
    }
}
// The .pen file open in a window, as its server reports it.
fn current(w: &Webview) -> Option<String> {
    let r: serde_json::Value = serde_json::from_str(&api(w, "GET", "/api/current", "")).unwrap_or_default();
    r["file"].as_str().map(String::from)
}
fn on_dashboard(w: &Webview) -> bool {
    w.url().is_ok_and(|u| u.path() == "/dashboard")
}

// Finder / Explorer: show a file in its folder, or open a link in the browser.
fn reveal(path: &Path) {
    #[cfg(windows)]
    let _ = Command::new("explorer").arg(format!("/select,{}", path.display())).status();
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg("-R").arg(path).status();
    #[cfg(target_os = "linux")]
    let _ = Command::new("xdg-open").arg(path.parent().unwrap_or(path)).status();
}
fn open_url(url: &str) {
    #[cfg(windows)]
    let _ = Command::new("explorer").arg(url).status();
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(url).status();
    #[cfg(target_os = "linux")]
    let _ = Command::new("xdg-open").arg(url).status();
}
fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let dest = to.join(e.file_name());
        if e.file_type()?.is_dir() { copy_dir(&e.path(), &dest)? } else { std::fs::copy(e.path(), dest).map(drop)? }
    }
    Ok(())
}

// Switch a tab's server to `file` (created if missing) and show it in the editor.
fn switch_to(w: &Webview, file: &Path) -> bool {
    let ok = api(w, "POST", "/api/open", &serde_json::json!({ "path": file }).to_string()).contains("path");
    if ok {
        go(w, "/");
    }
    ok
}

// Open `file` (created if missing): show the tab that already has it, else reuse `from` when it shows the
// dashboard (or has no file yet: at launch, Finder's file arrives before the first page has loaded), else a new
// tab with its own server. Never two tabs (two servers) on the same file.
fn open_pen(app: &AppHandle, from: Option<Webview>, file: &Path) {
    let wanted = Some(file.to_string_lossy().into_owned());
    if let Some(w) = docs(app).into_iter().find(|w| current(w) == wanted) {
        if on_dashboard(&w) {
            go(&w, "/");
        }
        return select(app, w.label());
    }
    let idle = |w: &Webview| on_dashboard(w) || current(w).is_none();
    match from.filter(|w| w.label() != "tabbar").or_else(|| win(app)).filter(idle).or_else(|| docs(app).into_iter().find(|w| current(w).is_none())) {
        Some(w) => {
            switch_to(&w, file);
            select(app, w.label());
        }
        None => {
            if let Err(e) = new_tab(app, Some(file)) {
                app.dialog().message(e).title("Pena").blocking_show();
            }
        }
    }
}

fn pen_dialog(app: &AppHandle) -> tauri_plugin_dialog::FileDialogBuilder<Wry> {
    let d = app.dialog().file().add_filter(if *MENU_LOCALE.lock().unwrap() == "pt-BR" { "Arquivo de design (.pen)" } else { "Design file (.pen)" }, &["pen"]);
    match win(app) {
        Some(w) => d.set_parent(&w.window()),
        None => d,
    }
}
fn pick_new(app: &AppHandle) -> Option<PathBuf> {
    let docs = app.path().document_dir().unwrap_or_default();
    let filename = if *MENU_LOCALE.lock().unwrap() == "pt-BR" { "Sem título.pen" } else { "Untitled.pen" };
    pen_dialog(app).set_directory(docs).set_file_name(filename).blocking_save_file()?.into_path().ok()
}
fn pick_open(app: &AppHandle) -> Option<PathBuf> {
    pen_dialog(app).blocking_pick_file()?.into_path().ok()
}

// Open/New from the page's own buttons (dashboard, editor's file menu): the native dialog, then open it.
// Commands are async so they run off the main thread: a blocking dialog there would freeze the app.
// Returns nothing: open_pen already shows the file (in this window or another one).
#[tauri::command]
async fn pick_pen(app: AppHandle, webview: Webview, kind: String) -> Option<PathBuf> {
    let file = if kind == "save" { pick_new(&app) } else { pick_open(&app) }?;
    open_pen(&app, Some(webview), &file);
    None
}

// Dashboard: a recent/draft clicked.
#[tauri::command]
async fn open_path(app: AppHandle, webview: Webview, path: PathBuf) {
    open_pen(&app, Some(webview), &path);
}

// Tabs, like pen.dev's: one window, the tab bar (tabbar.html) in its own webview on top, a webview per document
// below it, only the active one shown. pen.dev's ⌘1…⌘9 (⌘9: the last tab) come from the pages, the other tab
// shortcuts from the Window menu.
const TAB_KEYS: &str = "addEventListener('keydown', (e) => {
  const n = (navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey) && !e.shiftKey && !e.altKey && /^Digit[1-9]$/.test(e.code) ? +e.code[5] : 0;
  if (!n) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  window.__TAURI__?.core.invoke('tab', { action: 'go', index: n - 1 });
}, true);";

// The tab bar's actions (and ⌘1…⌘9). Sync, so on the main thread: anything slow goes to a thread.
#[tauri::command]
fn tab(app: AppHandle, action: String, id: Option<String>, index: Option<usize>) {
    let id = id.unwrap_or_default();
    match action.as_str() {
        "select" => select(&app, &id),
        "close" => close_tab(&app, &id),
        "move" => move_tab(&app, &id, index.unwrap_or(0)),
        "go" => {
            let n = TABS.lock().unwrap().list.len();
            let i = if index == Some(8) { n.saturating_sub(1) } else { index.unwrap_or(0) };
            let label = TABS.lock().unwrap().list.get(i).map(|(l, _)| l.clone());
            if let Some(l) = label {
                select(&app, &l);
            }
        }
        "new" => {
            std::thread::spawn(move || if let Err(e) = new_tab(&app, None) { app.dialog().message(e).title("Pena").blocking_show(); });
        }
        "menu" => tab_menu(&app, &id),
        _ => {}
    }
}

fn select(app: &AppHandle, label: &str) {
    {
        let mut t = TABS.lock().unwrap();
        if !t.list.iter().any(|(l, _)| l == label) {
            return;
        }
        t.active = label.into();
    }
    let all = docs(app);
    // the new one first, then hide the rest: no empty frame in between
    for d in all.iter().filter(|d| d.label() == label) {
        let _ = d.show();
        let _ = d.set_focus();
        let d = d.clone();
        std::thread::spawn(move || { api(&d, "POST", "/api/focus", ""); }); // external agents talk to the active tab
    }
    for d in all.iter().filter(|d| d.label() != label) {
        let _ = d.hide();
    }
    retitle(app);
    push(app);
}

// The last tab isn't closed: it goes back to the Dashboard (pen.dev shows Home).
fn close_tab(app: &AppHandle, label: &str) {
    let Some(d) = app.get_webview(label) else { return };
    let next = {
        let mut t = TABS.lock().unwrap();
        let Some(i) = t.list.iter().position(|(l, _)| l == label) else { return };
        if t.list.len() == 1 {
            None
        } else {
            t.list.remove(i);
            Some((t.active == label).then(|| t.list[i.min(t.list.len() - 1)].0.clone()))
        }
    };
    let Some(next) = next else {
        if !on_dashboard(&d) {
            go(&d, "/dashboard");
        }
        return;
    };
    let _ = d.close();
    let l = label.to_string();
    std::thread::spawn(move || stop_server(&l));
    match next {
        Some(n) => select(app, &n),
        None => push(app),
    }
}

fn move_tab(app: &AppHandle, label: &str, to: usize) {
    {
        let mut t = TABS.lock().unwrap();
        let Some(i) = t.list.iter().position(|(l, _)| l == label) else { return };
        let tab = t.list.remove(i);
        let to = to.min(t.list.len());
        t.list.insert(to, tab);
    }
    push(app);
}

// Next/previous tab (wraps around), or move the active one left/right (stops at the ends).
fn step(app: &AppHandle, delta: isize, moving: bool) {
    let (label, to) = {
        let t = TABS.lock().unwrap();
        let n = t.list.len() as isize;
        let Some(i) = t.list.iter().position(|(l, _)| *l == t.active) else { return };
        let to = if moving { (i as isize + delta).clamp(0, n - 1) } else { (i as isize + delta).rem_euclid(n) };
        (t.active.clone(), to as usize)
    };
    if moving {
        move_tab(app, &label, to);
    } else {
        let next = TABS.lock().unwrap().list[to].0.clone();
        select(app, &next);
    }
}

fn tab_menu(app: &AppHandle, label: &str) {
    let pt = *MENU_LOCALE.lock().unwrap() == "pt-BR";
    let text = |en: &'static str, pt_br: &'static str| if pt { pt_br } else { en };
    let reveal = if cfg!(windows) { text("Show in Explorer", "Mostrar no Explorador") } else { text("Show in Finder", "Mostrar no Finder") };
    let others = TABS.lock().unwrap().list.len() > 1;
    let has_file = app.get_webview(label).is_some_and(|d| !on_dashboard(&d));
    let item = |id: String, label: &str, enabled: bool| MenuItemBuilder::with_id(id, label).enabled(enabled).build(app);
    let (Some(w), Ok(finder), Ok(close), Ok(close_others), Ok(sep)) = (
        main_window(app),
        item(format!("tab-finder:{label}"), reveal, has_file),
        item(format!("tab-close:{label}"), text("Close Tab", "Fechar aba"), true),
        item(format!("tab-close-others:{label}"), text("Close Other Tabs", "Fechar outras abas"), others),
        PredefinedMenuItem::separator(app),
    ) else { return };
    if let Ok(menu) = Menu::with_items(app, &[&finder, &sep, &close, &close_others]) {
        let _ = w.popup_menu(&menu);
    }
}

// The tab bar draws what it's sent (window.render in tabbar.html).
fn push(app: &AppHandle) {
    let Some(bar) = app.get_webview("tabbar") else { return };
    let lights = cfg!(target_os = "macos") && !main_window(app).and_then(|w| w.is_fullscreen().ok()).unwrap_or(false);
    let pt = *MENU_LOCALE.lock().unwrap() == "pt-BR";
    let state = {
        let t = TABS.lock().unwrap();
        serde_json::json!({
            "tabs": t.list.iter().map(|(id, name)| serde_json::json!({ "id": id, "name": name })).collect::<Vec<_>>(),
            "active": t.active,
            "lights": lights,
            "pt": pt,
        })
    };
    let _ = bar.eval(format!("window.render?.({state})"));
}

// The window's title (Window menu, Mission Control) follows the active tab.
fn retitle(app: &AppHandle) {
    let name = {
        let t = TABS.lock().unwrap();
        t.list.iter().find(|(l, _)| *l == t.active).map(|(_, n)| n.clone())
    };
    if let (Some(w), Some(n)) = (main_window(app), name) {
        let _ = w.set_title(&if n == DASHBOARD { "Pena".into() } else { format!("{n} — Pena") });
    }
}

// The bar on top, the documents under it.
fn layout(app: &AppHandle) {
    let Some(w) = main_window(app) else { return };
    let (Ok(size), Ok(scale)) = (w.inner_size(), w.scale_factor()) else { return };
    let size = size.to_logical::<f64>(scale);
    let rect = |y: f64, h: f64| Rect { position: LogicalPosition::new(0.0, y).into(), size: LogicalSize::new(size.width, h.max(0.0)).into() };
    if let Some(bar) = app.get_webview("tabbar") {
        let _ = bar.set_bounds(rect(0.0, BAR_H));
    }
    for d in docs(app) {
        let _ = d.set_bounds(rect(BAR_H, size.height - BAR_H));
    }
}

fn language_preference_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("language");
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

#[tauri::command]
fn get_language_preference(app: AppHandle) -> String {
    language_preference_path(&app).ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .map(|value| value.trim().to_string())
        .filter(|value| matches!(value.as_str(), "auto" | "en" | "pt-BR"))
        .unwrap_or_else(|| "auto".into())
}

#[tauri::command]
fn set_locale(app: AppHandle, webview: Webview, locale: String, preference: String) -> Result<(), String> {
    let preference = if matches!(preference.as_str(), "auto" | "en" | "pt-BR") { preference } else { "auto".into() };
    std::fs::write(language_preference_path(&app)?, &preference).map_err(|e| e.to_string())?;
    let locale = if locale == "pt-BR" { "pt-BR" } else { "en" };
    *MENU_LOCALE.lock().unwrap() = locale;
    let recents = win(&app).map(|w| {
        let r: serde_json::Value = serde_json::from_str(&api(&w, "GET", "/api/recent", "")).unwrap_or_default();
        r["recents"].as_array().into_iter().flatten()
            .filter_map(|x| x["path"].as_str().map(String::from)).take(10).collect::<Vec<_>>()
    }).unwrap_or_default();
    app.set_menu(build_menu(&app, &recents).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let script = format!(
        "window.penaApplyLanguage?.({}, {})",
        serde_json::to_string(locale).map_err(|e| e.to_string())?,
        serde_json::to_string(&preference).map_err(|e| e.to_string())?,
    );
    for other in app.webviews().values().filter(|other| other.label() != webview.label()) {
        let _ = other.eval(&script);
    }
    push(&app);
    Ok(())
}

// Dashboard's "Importar do Figma": a dialog that only offers .fig files; the server reads the file from its path.
#[tauri::command]
async fn pick_fig(app: AppHandle, webview: Webview) -> Option<PathBuf> {
    app.dialog().file().add_filter("Figma", &["fig"]).set_parent(&webview.window()).blocking_pick_file()?.into_path().ok()
}

// File > Export selection: the page renders, we ask where to save.
#[tauri::command]
async fn save_export(app: AppHandle, webview: Webview, data: String, name: String, ext: String) -> Result<(), String> {
    let dir = current(&webview).map(|f| Path::new(&f).parent().unwrap_or(Path::new("/")).to_path_buf()).unwrap_or_default();
    let Some(path) = app.dialog().file().set_directory(dir).set_file_name(format!("{name}.{ext}")).blocking_save_file() else { return Ok(()) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    let bytes = match data.strip_prefix("data:").and_then(|d| d.split_once(',')) {
        Some((_, b64)) => B64.decode(b64).map_err(|e| e.to_string())?,
        None => data.into_bytes(),
    };
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    reveal(&path);
    Ok(())
}

fn save_as(app: &AppHandle) {
    let Some(w) = win(app) else { return };
    let Some(cur) = current(&w) else { return };
    let Some(to) = pen_dialog(app).set_file_name(Path::new(&cur).file_name().unwrap_or_default().to_string_lossy()).blocking_save_file().and_then(|p| p.into_path().ok()) else { return };
    if std::fs::copy(&cur, &to).is_err() {
        return;
    }
    // keep relative image fills working
    let (from_dir, to_dir) = (Path::new(&cur).parent().unwrap(), to.parent().unwrap());
    if from_dir.join("images").exists() && from_dir != to_dir {
        let _ = copy_dir(&from_dir.join("images"), &to_dir.join("images"));
    }
    switch_to(&w, &to); // the copy replaces the original in this tab
}

fn import_image(app: &AppHandle) {
    let pt = *MENU_LOCALE.lock().unwrap() == "pt-BR";
    let filter = if pt { "Imagens, SVG e Figma" } else { "Images, SVG, and Figma" };
    let files = app.dialog().file().add_filter(filter, &["png", "jpg", "jpeg", "webp", "gif", "svg", "fig"]).blocking_pick_files().unwrap_or_default();
    for f in files.into_iter().filter_map(|f| f.into_path().ok()) {
        if f.extension().is_some_and(|e| e.eq_ignore_ascii_case("fig")) {
            js(app, &format!("window.pena.importFigma({})", serde_json::to_string(&f.to_string_lossy()).unwrap()));
            continue;
        }
        let Ok(bytes) = std::fs::read(&f) else { continue };
        let name = serde_json::to_string(&f.file_name().unwrap_or_default().to_string_lossy()).unwrap();
        js(app, &format!("window.pena.importImage(Uint8Array.from(atob('{}'), (c) => c.charCodeAt(0)), {name})", B64.encode(bytes)));
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "dashboard" => if let Some(w) = win(app) { go(&w, "/dashboard") },
        "new-tab" => tab(app.clone(), "new".into(), None, None),
        "close-tab" => if let Some(w) = win(app) { close_tab(app, w.label()) },
        "prev-tab" => step(app, -1, false),
        "next-tab" => step(app, 1, false),
        "tab-left" => step(app, -1, true),
        "tab-right" => step(app, 1, true),
        _ if id.starts_with("tab-close:") => close_tab(app, &id["tab-close:".len()..]),
        _ if id.starts_with("tab-close-others:") => {
            let keep = &id["tab-close-others:".len()..];
            let others: Vec<String> = TABS.lock().unwrap().list.iter().map(|(l, _)| l.clone()).filter(|l| l != keep).collect();
            select(app, keep);
            others.iter().for_each(|l| close_tab(app, l));
        }
        "settings" => js(app, "window.penaSettings?.()"),
        "fit" => js(app, "window.pena.fit()"),
        "reload" => js(app, "location.reload()"),
        "devtools" => if let Some(w) = win(app) { w.open_devtools() },
        "finder" => if let Some(f) = win(app).and_then(|w| current(&w)) { reveal(Path::new(&f)) },
        _ => {
            // Dialogs block: off the main thread.
            let (app, id) = (app.clone(), id.to_string());
            std::thread::spawn(move || match id.as_str() {
                "new" => { if let Some(f) = pick_new(&app) { open_pen(&app, None, &f); } }
                "open" => { if let Some(f) = pick_open(&app) { open_pen(&app, None, &f); } }
                "save-as" => save_as(&app),
                "import-image" => import_image(&app),
                _ if id.starts_with("tab-finder:") => {
                    if let Some(f) = app.get_webview(&id["tab-finder:".len()..]).and_then(|w| current(&w)) {
                        reveal(Path::new(&f));
                    }
                }
                _ if id.starts_with("recent:") => open_pen(&app, None, Path::new(&id["recent:".len()..])),
                _ if id.starts_with("export:") => {
                    let f = serde_json::to_string(&id["export:".len()..]).unwrap();
                    let prefix = if *MENU_LOCALE.lock().unwrap() == "pt-BR" { "Exportar" } else { "Export" };
                    let prefix = serde_json::to_string(prefix).unwrap();
                    js(&app, &format!("window.pena.exportSelection({f}).then((r) => window.__TAURI__.core.invoke('save_export', {{ ...r, ext: {f} === 'html-css' ? 'html' : {f} }})).catch((e) => alert({prefix} + ': ' + (e.message ?? e)))"));
                }
                _ => {}
            });
        }
    }
}

fn build_menu(app: &AppHandle, recents: &[String]) -> tauri::Result<Menu<Wry>> {
    let pt = *MENU_LOCALE.lock().unwrap() == "pt-BR";
    let text = |en: &'static str, pt_br: &'static str| if pt { pt_br } else { en };
    let item = |id: &str, label: &str, key: Option<&str>| {
        let b = MenuItemBuilder::with_id(id, label);
        match key { Some(k) => b.accelerator(k), None => b }.build(app)
    };
    let mut recent = SubmenuBuilder::new(app, text("Open Recent", "Abrir recente"));
    if recents.is_empty() {
        recent = recent.item(&MenuItemBuilder::new(text("No Recent Files", "Nenhum arquivo recente")).enabled(false).build(app)?);
    }
    for f in recents {
        recent = recent.item(&item(&format!("recent:{f}"), f, None)?);
    }
    let mut export = SubmenuBuilder::new(app, text("Export Selection", "Exportar seleção"));
    for (label, f) in [("PNG", "png"), ("JPEG", "jpeg"), ("WebP", "webp"), ("SVG", "svg"), ("PDF", "pdf"), ("HTML + CSS", "html-css"), ("Figma (.fig)", "fig")] {
        export = export.item(&item(&format!("export:{f}"), label, None)?);
    }
    let (prev, next) = if cfg!(target_os = "macos") { ("Cmd+Shift+[", "Cmd+Shift+]") } else { ("Ctrl+PageUp", "Ctrl+PageDown") };
    Menu::with_items(app, &[
        &SubmenuBuilder::new(app, "Pena")
            .about_with_text(text("About Pena", "Sobre o Pena"), None).separator()
            .item(&item("settings", text("Settings…", "Configurações…"), Some("CmdOrCtrl+,"))?).separator()
            .services_with_text(text("Services", "Serviços")).separator()
            .hide_with_text(text("Hide Pena", "Ocultar Pena")).hide_others_with_text(text("Hide Others", "Ocultar outros")).show_all_with_text(text("Show All", "Mostrar tudo")).separator()
            .quit_with_text(text("Quit Pena", "Encerrar Pena")).build()?,
        &SubmenuBuilder::new(app, text("File", "Arquivo"))
            .item(&item("dashboard", "Dashboard", Some("CmdOrCtrl+Shift+D"))?)
            .item(&item("new-tab", text("New Tab", "Nova aba"), Some("CmdOrCtrl+T"))?).separator()
            .item(&item("new", text("New File…", "Novo arquivo…"), Some("CmdOrCtrl+N"))?)
            .item(&item("open", text("Open…", "Abrir…"), Some("CmdOrCtrl+O"))?)
            .item(&recent.build()?).separator()
            .item(&item("save-as", text("Save As…", "Salvar como…"), Some("CmdOrCtrl+Shift+S"))?)
            .item(&item("finder", text(if cfg!(windows) { "Show in Explorer" } else { "Show in Finder" }, if cfg!(windows) { "Mostrar no Explorador" } else { "Mostrar no Finder" }), None)?).separator()
            .item(&item("import-image", text("Import Image/SVG/Figma…", "Importar imagem/SVG/Figma…"), Some("CmdOrCtrl+Shift+K"))?)
            .item(&export.build()?).separator()
            .item(&item("close-tab", text("Close Tab", "Fechar aba"), Some("CmdOrCtrl+W"))?).build()?,
        // Undo/redo belong to the canvas (Cmd+Z handled by the editor); these cover text fields.
        &SubmenuBuilder::new(app, text("Edit", "Editar")).undo_with_text(text("Undo", "Desfazer")).redo_with_text(text("Redo", "Refazer")).separator()
            .cut_with_text(text("Cut", "Recortar")).copy_with_text(text("Copy", "Copiar")).paste_with_text(text("Paste", "Colar")).select_all_with_text(text("Select All", "Selecionar tudo")).build()?,
        &SubmenuBuilder::new(app, text("View", "Ver"))
            .item(&item("fit", text("Fit All", "Ajustar tudo"), Some("Shift+1"))?).separator()
            .item(&item("reload", text("Reload", "Recarregar"), Some("CmdOrCtrl+R"))?)
            .item(&item("devtools", text("Developer Tools", "Ferramentas de desenvolvedor"), Some("Alt+CmdOrCtrl+I"))?).separator()
            .fullscreen_with_text(text("Full Screen", "Tela cheia")).build()?,
        &SubmenuBuilder::new(app, text("Window", "Janela")).minimize_with_text(text("Minimize", "Minimizar")).maximize_with_text(text("Zoom", "Zoom")).separator()
            .item(&item("prev-tab", text("Show Previous Tab", "Mostrar aba anterior"), Some(prev))?)
            .item(&item("next-tab", text("Show Next Tab", "Mostrar próxima aba"), Some(next))?)
            .item(&item("tab-left", text("Move Tab Left", "Mover aba para a esquerda"), Some("Ctrl+Shift+PageUp"))?)
            .item(&item("tab-right", text("Move Tab Right", "Mover aba para a direita"), Some("Ctrl+Shift+PageDown"))?).build()?,
    ])
}

// After each page load: the tab's name, the window's title and "Open recent" follow its server's current file.
fn refresh_chrome(w: &Webview, on_dashboard: bool) {
    let app = w.app_handle();
    let r: serde_json::Value = serde_json::from_str(&api(w, "GET", "/api/recent", "")).unwrap_or_default();
    let cur = r["current"].as_str().map(String::from);
    let recents: Vec<String> = r["recents"].as_array().into_iter().flatten().filter_map(|x| x["path"].as_str().map(String::from)).take(10).collect();
    let name = match (&cur, on_dashboard) {
        (Some(f), false) => Path::new(f).file_stem().unwrap_or_default().to_string_lossy().into_owned(),
        _ => DASHBOARD.into(),
    };
    if let Some(tab) = TABS.lock().unwrap().list.iter_mut().find(|(l, _)| l == w.label()) {
        tab.1 = name;
    }
    retitle(app);
    push(app);
    if let Ok(m) = build_menu(app, &recents) {
        let _ = app.set_menu(m);
    }
}

// The server: compiled next to this binary (Contents/MacOS/pena-server, pena-server.exe on Windows); it prints its URL first.
fn start_server(app: &AppHandle, file: Option<&Path>) -> Result<(String, Child), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let root = app.path().resource_dir().map_err(|e| e.to_string())?;
    let mut cmd = Command::new(exe.with_file_name(format!("pena-server{}", std::env::consts::EXE_SUFFIX)));
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut cmd, 0x0800_0000); // CREATE_NO_WINDOW: no console popping up
    let mut child = cmd
        .args(file)
        .env("PENA_ROOT", root)
        .stdin(Stdio::piped()) // closes when we exit, even on a crash: the server then quits too
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("pena-server: {e}"))?;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let mut err = BufReader::new(child.stderr.take().unwrap());
    let first = lines.next().and_then(Result::ok).unwrap_or_default();
    let Some(url) = Some(first.clone()).filter(|l| l.starts_with("http")) else {
        // crashed before printing its URL: show why (stderr reaches EOF once the process is gone).
        // A native crash prints nothing, so the exit code is the only clue (0xC000001D: CPU lacks an instruction).
        let _ = child.kill();
        let status = child.wait().map(|s| s.code().map_or(s.to_string(), |c| format!("código {c} (0x{:X})", c as u32))).unwrap_or_default();
        let mut why = String::new();
        let _ = std::io::Read::read_to_string(&mut err, &mut why);
        let why = format!("{first}\n{why}");
        return Err(format!("o servidor do Pena não iniciou: {status}\n\n{}", why.trim().chars().take(1500).collect::<String>()));
    };
    std::thread::spawn(move || lines.map_while(Result::ok).for_each(|l| eprintln!("{l}"))); // keep the pipes drained
    std::thread::spawn(move || err.lines().map_while(Result::ok).for_each(|l| eprintln!("{l}")));
    Ok((url, child))
}

// The window: the tab bar on top, tabs added by new_tab. macOS: no title bar, the traffic lights go in the bar's island.
fn create_window(app: &AppHandle) -> Result<(), String> {
    let config = serde_json::from_value(serde_json::json!({
        "label": "main", "title": "Pena", "width": 1500, "height": 950,
        "titleBarStyle": "Overlay", "hiddenTitle": true, "trafficLightPosition": { "x": 18, "y": 15 },
    })).map_err(|e| e.to_string())?;
    let w = WindowBuilder::from_config(app, &config).and_then(|b| b.background_color(tauri::window::Color(0x18, 0x18, 0x1b, 0xff)).build()).map_err(|e| e.to_string())?;
    let bar = WebviewBuilder::new("tabbar", WebviewUrl::App("tabbar.html".into()))
        .background_color(tauri::window::Color(0x18, 0x18, 0x1b, 0xff))
        .initialization_script(TAB_KEYS)
        .on_page_load(|w, p| if p.event() == PageLoadEvent::Finished { push(w.app_handle()) });
    let _bar = w.add_child(bar, LogicalPosition::new(0.0, 0.0), LogicalSize::new(1500.0, BAR_H)).map_err(|e| e.to_string())?;
    // Linux: child webviews are stacked in a GtkBox that splits the height evenly (set_bounds does nothing there):
    // the bar keeps its height, the shown document takes the rest (hidden ones take no space).
    #[cfg(target_os = "linux")]
    let _ = _bar.with_webview(|pw| {
        use gtk::prelude::*;
        let v = pw.inner();
        v.set_size_request(-1, BAR_H as i32);
        if let Some(b) = v.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) {
            b.set_child_packing(&v, false, false, 0, gtk::PackType::Start);
        }
    });
    Ok(())
}

// A tab and its own server, after the active one. It opens on the dashboard when there is no file.
fn new_tab(app: &AppHandle, file: Option<&Path>) -> Result<Webview, String> {
    let w = main_window(app).ok_or("Pena: no window")?;
    let (url, child) = start_server(app, file)?;
    let label = format!("w{}", NEXT_TAB.fetch_add(1, Ordering::Relaxed));
    SERVERS.lock().unwrap().get_or_insert_with(HashMap::new).insert(label.clone(), (url.clone(), child));
    let start = std::env::var("PENA_START").unwrap_or_else(|_| if file.is_some() { "/".into() } else { "/dashboard".into() });
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(format!("{url}{start}").parse().map_err(|e| format!("{e}"))?))
        .background_color(tauri::window::Color(0x18, 0x18, 0x1b, 0xff))
        // Lets the page receive dropped files (HTML5 drag and drop); Tauri's own handler swallows them on Windows.
        .disable_drag_drop_handler()
        // Agents render screenshots/exports in their tab even when it's hidden or the app is in the background.
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        // Links (target=_blank) go to the browser.
        .on_new_window(|u, _| {
            open_url(u.as_str());
            NewWindowResponse::Deny
        })
        .on_page_load(|w, p| {
            if p.event() == PageLoadEvent::Finished {
                let dash = p.url().path() == "/dashboard";
                std::thread::spawn(move || refresh_chrome(&w, dash));
            }
        })
        .initialization_script(TAB_KEYS);
    let size = w.inner_size().map_err(|e| e.to_string())?.to_logical::<f64>(w.scale_factor().map_err(|e| e.to_string())?);
    let tab = w.add_child(builder, LogicalPosition::new(0.0, BAR_H), LogicalSize::new(size.width, (size.height - BAR_H).max(0.0))).map_err(|e| {
        stop_server(&label);
        e.to_string()
    })?;
    {
        let mut t = TABS.lock().unwrap();
        let at = t.list.iter().position(|(l, _)| *l == t.active).map_or(t.list.len(), |i| i + 1);
        let name = file.map_or(DASHBOARD.into(), |f| f.file_stem().unwrap_or_default().to_string_lossy().into_owned());
        t.list.insert(at, (label.clone(), name));
    }
    select(app, &label);
    Ok(tab)
}

// Closing stdin lets the server exit on its own (it removes its ~/.pena/servers entry); kill if it hangs.
fn stop_server(label: &str) {
    let Some((_, mut c)) = SERVERS.lock().unwrap().as_mut().and_then(|m| m.remove(label)) else { return };
    drop(c.stdin.take());
    for _ in 0..20 {
        if c.try_wait().ok().flatten().is_some() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let _ = c.kill();
}
fn stop_all() {
    let labels: Vec<String> = SERVERS.lock().unwrap().as_ref().map(|m| m.keys().cloned().collect()).unwrap_or_default();
    labels.iter().for_each(|l| stop_server(l));
}

// New release on GitHub (latest.json, made by release.yml): ask, download (progress in the title), install, restart.
// Windows runs the installer and exits right away: stop the server first so pena-server.exe can be replaced.
fn check_update(app: AppHandle) {
    // Dev builds aren't a bundle: "installing" would replace target/debug with the release.
    if cfg!(debug_assertions) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater_builder().on_before_exit(stop_all).build() else { return };
        let Ok(Some(u)) = updater.check().await else { return };
        let pt = *MENU_LOCALE.lock().unwrap() == "pt-BR";
        let (message, title, install, later) = if pt {
            (format!("A versão {} do Pena está disponível (você tem a {}).", u.version, u.current_version), "Atualização disponível", "Instalar e reiniciar", "Depois")
        } else {
            (format!("Pena version {} is available (you have {}).", u.version, u.current_version), "Update available", "Install and restart", "Later")
        };
        let yes = app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(install.into(), later.into()))
            .blocking_show();
        if !yes {
            return;
        }
        let (w, mut got) = (main_window(&app), 0u64);
        let progress = |n: usize, total: Option<u64>| {
            got += n as u64;
            if let (Some(w), Some(t)) = (&w, total.filter(|&t| t > 0)) {
                let message = if *MENU_LOCALE.lock().unwrap() == "pt-BR" { "Pena — baixando atualização" } else { "Pena — downloading update" };
                let _ = w.set_title(&format!("{message} {}%", got * 100 / t));
            }
        };
        match u.download_and_install(progress, || {}).await {
            Ok(()) => app.restart(),
            Err(e) => {
                let message = if *MENU_LOCALE.lock().unwrap() == "pt-BR" { format!("Não deu para atualizar: {e}") } else { format!("Could not update: {e}") };
                app.dialog().message(message).title("Pena").blocking_show();
            }
        }
    });
}

fn main() {
    let args: Vec<PathBuf> = std::env::args().skip(1).filter(|a| a.ends_with(".pen")).map(PathBuf::from).collect();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![pick_pen, pick_fig, save_export, open_path, get_language_preference, set_locale, tab])
        .on_menu_event(|app, e| on_menu(app, e.id().as_ref()))
        .setup(move |app| {
            let h = app.handle().clone();
            app.set_menu(build_menu(&h, &[])?)?;
            let mut files: Vec<PathBuf> = args.into_iter().chain(LAUNCH_FILES.lock().unwrap().take().unwrap_or_default()).collect();
            let first = (!files.is_empty()).then(|| files.remove(0));
            create_window(&h).and_then(|_| new_tab(&h, first.as_deref()).map(drop)).inspect_err(|e| {
                app.dialog().message(e).title("Pena").blocking_show();
            })?;
            let rest = h.clone();
            std::thread::spawn(move || files.iter().for_each(|f| open_pen(&rest, None, f)));
            check_update(h);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pena");
    app.run(|_app, e| match e {
        // macOS: double-clicking a .pen file (associated in tauri.conf.json) or dropping it on the dock icon.
        // Windows passes the file as an argument instead (main's `file`).
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let files: Vec<PathBuf> = urls.iter().filter_map(|u| u.to_file_path().ok()).collect();
            if let Some(pending) = LAUNCH_FILES.lock().unwrap().as_mut() {
                return pending.extend(files); // launched by this double-click: setup opens them
            }
            let app = _app.clone();
            std::thread::spawn(move || files.iter().for_each(|f| open_pen(&app, None, f)));
        }
        // External agents (mcp.mjs) talk to the active tab's server.
        RunEvent::WindowEvent { event: WindowEvent::Focused(true), .. } => {
            if let Some(w) = win(_app) {
                std::thread::spawn(move || { api(&w, "POST", "/api/focus", ""); });
            }
        }
        // also entering/leaving full screen, where the traffic lights go away
        RunEvent::WindowEvent { event: WindowEvent::Resized(_), .. } => {
            layout(_app);
            push(_app);
        }
        RunEvent::WindowEvent { event: WindowEvent::Destroyed, .. } => { std::thread::spawn(stop_all); }
        RunEvent::Exit => stop_all(),
        _ => {}
    });
}
