// Pena desktop app: a WebKit window (the system's, no bundled Chromium) on top of the compiled Pena server
// (`pena-server`, see sidecar.mjs), plus the native menus and file dialogs, like pen.dev's File/Edit/View menus.
// Agents still run on your Claude/ChatGPT subscriptions, through the `claude`/`codex` CLIs you installed.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::menu::{Menu, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tauri_plugin_dialog::DialogExt;

static BASE: OnceLock<String> = OnceLock::new(); // http://127.0.0.1:<port> of the server
static SERVER: Mutex<Option<Child>> = Mutex::new(None);
static CURRENT: Mutex<Option<String>> = Mutex::new(None); // the open .pen file, as the server reports it

fn base() -> &'static str {
    BASE.get().map(String::as_str).unwrap_or("")
}

// Tiny HTTP/1.0 client for the local server (HTTP/1.0: no chunked replies to decode).
fn api(method: &str, path: &str, body: &str) -> String {
    let host = base().trim_start_matches("http://");
    let Ok(mut s) = TcpStream::connect(host) else { return String::new() };
    let _ = write!(s, "{method} {path} HTTP/1.0\r\nHost: {host}\r\nContent-Length: {}\r\n\r\n{body}", body.len());
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default()
}

fn win(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}
fn go(app: &AppHandle, page: &str) {
    if let (Some(w), Ok(u)) = (win(app), Url::parse(&format!("{}{page}", base()))) {
        let _ = w.navigate(u);
    }
}
fn js(app: &AppHandle, code: &str) {
    if let Some(w) = win(app) {
        let _ = w.eval(code);
    }
}
fn current() -> Option<String> {
    CURRENT.lock().unwrap().clone()
}

// Finder / Explorer: show a file in its folder, or open a link in the browser.
fn reveal(path: &Path) {
    #[cfg(windows)]
    let _ = Command::new("explorer").arg(format!("/select,{}", path.display())).status();
    #[cfg(not(windows))]
    let _ = Command::new("open").arg("-R").arg(path).status();
}
fn open_url(url: &str) {
    #[cfg(windows)]
    let _ = Command::new("explorer").arg(url).status();
    #[cfg(not(windows))]
    let _ = Command::new("open").arg(url).status();
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

// Switch the server to `file` (created if missing) and show it in the editor.
fn open_pen(app: &AppHandle, file: &Path) -> bool {
    let ok = api("POST", "/api/open", &serde_json::json!({ "path": file }).to_string()).contains("path");
    if ok {
        go(app, "/");
    }
    ok
}

fn pen_dialog(app: &AppHandle) -> tauri_plugin_dialog::FileDialogBuilder<Wry> {
    let d = app.dialog().file().add_filter("Pen design", &["pen"]);
    match win(app) {
        Some(w) => d.set_parent(&w),
        None => d,
    }
}
fn pick_new(app: &AppHandle) -> Option<PathBuf> {
    let docs = app.path().document_dir().unwrap_or_default();
    pen_dialog(app).set_directory(docs).set_file_name("Sem título.pen").blocking_save_file()?.into_path().ok()
}
fn pick_open(app: &AppHandle) -> Option<PathBuf> {
    pen_dialog(app).blocking_pick_file()?.into_path().ok()
}

// Open/New from the page's own buttons (dashboard, editor's file menu): the native dialog, then open it.
// Commands are async so they run off the main thread: a blocking dialog there would freeze the app.
#[tauri::command]
async fn pick_pen(app: AppHandle, kind: String) -> Option<PathBuf> {
    let file = if kind == "save" { pick_new(&app) } else { pick_open(&app) }?;
    open_pen(&app, &file).then_some(file)
}

// Dashboard's "Importar do Figma": a dialog that only offers .fig files; the server reads the file from its path.
#[tauri::command]
async fn pick_fig(app: AppHandle) -> Option<PathBuf> {
    let d = app.dialog().file().add_filter("Figma", &["fig"]);
    let d = match win(&app) { Some(w) => d.set_parent(&w), None => d };
    d.blocking_pick_file()?.into_path().ok()
}

// File > Export selection: the page renders, we ask where to save.
#[tauri::command]
async fn save_export(app: AppHandle, data: String, name: String, ext: String) -> Result<(), String> {
    let dir = current().map(|f| Path::new(&f).parent().unwrap_or(Path::new("/")).to_path_buf()).unwrap_or_default();
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
    let Some(cur) = current() else { return };
    let Some(to) = pen_dialog(app).set_file_name(Path::new(&cur).file_name().unwrap_or_default().to_string_lossy()).blocking_save_file().and_then(|p| p.into_path().ok()) else { return };
    if std::fs::copy(&cur, &to).is_err() {
        return;
    }
    // keep relative image fills working
    let (from_dir, to_dir) = (Path::new(&cur).parent().unwrap(), to.parent().unwrap());
    if from_dir.join("images").exists() && from_dir != to_dir {
        let _ = copy_dir(&from_dir.join("images"), &to_dir.join("images"));
    }
    open_pen(app, &to);
}

fn import_image(app: &AppHandle) {
    let files = app.dialog().file().add_filter("Imagens, SVG e Figma", &["png", "jpg", "jpeg", "webp", "gif", "svg", "fig"]).blocking_pick_files().unwrap_or_default();
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
        "dashboard" => go(app, "/dashboard"),
        "settings" => js(app, "window.penaSettings?.()"),
        "fit" => js(app, "window.pena.fit()"),
        "reload" => js(app, "location.reload()"),
        "devtools" => if let Some(w) = win(app) { w.open_devtools() },
        "finder" => if let Some(f) = current() { reveal(Path::new(&f)) },
        _ => {
            // Dialogs block: off the main thread.
            let (app, id) = (app.clone(), id.to_string());
            std::thread::spawn(move || match id.as_str() {
                "new" => { if let Some(f) = pick_new(&app) { open_pen(&app, &f); } }
                "open" => { if let Some(f) = pick_open(&app) { open_pen(&app, &f); } }
                "save-as" => save_as(&app),
                "import-image" => import_image(&app),
                _ if id.starts_with("recent:") => { open_pen(&app, Path::new(&id["recent:".len()..])); }
                _ if id.starts_with("export:") => {
                    let f = serde_json::to_string(&id["export:".len()..]).unwrap();
                    js(&app, &format!("window.pena.exportSelection({f}).then((r) => window.__TAURI__.core.invoke('save_export', {{ ...r, ext: {f} === 'html-css' ? 'html' : {f} }})).catch((e) => alert('Exportar: ' + (e.message ?? e)))"));
                }
                _ => {}
            });
        }
    }
}

fn build_menu(app: &AppHandle, recents: &[String]) -> tauri::Result<Menu<Wry>> {
    let item = |id: &str, label: &str, key: Option<&str>| {
        let b = MenuItemBuilder::with_id(id, label);
        match key { Some(k) => b.accelerator(k), None => b }.build(app)
    };
    let mut recent = SubmenuBuilder::new(app, "Abrir recente");
    if recents.is_empty() {
        recent = recent.item(&MenuItemBuilder::new("Nenhum arquivo recente").enabled(false).build(app)?);
    }
    for f in recents {
        recent = recent.item(&item(&format!("recent:{f}"), f, None)?);
    }
    let mut export = SubmenuBuilder::new(app, "Exportar seleção");
    for (label, f) in [("PNG", "png"), ("JPEG", "jpeg"), ("WebP", "webp"), ("PDF", "pdf"), ("HTML + CSS", "html-css"), ("Figma (.fig)", "fig")] {
        export = export.item(&item(&format!("export:{f}"), label, None)?);
    }
    Menu::with_items(app, &[
        &SubmenuBuilder::new(app, "Pena")
            .about_with_text("Sobre o Pena", None).separator()
            .item(&item("settings", "Configurações…", Some("CmdOrCtrl+,"))?).separator()
            .services_with_text("Serviços").separator()
            .hide_with_text("Ocultar Pena").hide_others_with_text("Ocultar outros").show_all_with_text("Mostrar tudo").separator()
            .quit_with_text("Encerrar Pena").build()?,
        &SubmenuBuilder::new(app, "Arquivo")
            .item(&item("dashboard", "Dashboard", Some("CmdOrCtrl+Shift+D"))?).separator()
            .item(&item("new", "Novo arquivo…", Some("CmdOrCtrl+N"))?)
            .item(&item("open", "Abrir…", Some("CmdOrCtrl+O"))?)
            .item(&recent.build()?).separator()
            .item(&item("save-as", "Salvar como…", Some("CmdOrCtrl+Shift+S"))?)
            .item(&item("finder", if cfg!(windows) { "Mostrar no Explorador" } else { "Mostrar no Finder" }, None)?).separator()
            .item(&item("import-image", "Importar imagem/SVG/Figma…", Some("CmdOrCtrl+Shift+K"))?)
            .item(&export.build()?).separator()
            .close_window_with_text("Fechar janela").build()?,
        // Undo/redo belong to the canvas (Cmd+Z handled by the editor); these cover text fields.
        &SubmenuBuilder::new(app, "Editar").undo_with_text("Desfazer").redo_with_text("Refazer").separator()
            .cut_with_text("Recortar").copy_with_text("Copiar").paste_with_text("Colar").select_all_with_text("Selecionar tudo").build()?,
        &SubmenuBuilder::new(app, "Ver")
            .item(&item("fit", "Ajustar tudo", Some("Shift+1"))?).separator()
            .item(&item("reload", "Recarregar", Some("CmdOrCtrl+R"))?)
            .item(&item("devtools", "Ferramentas de desenvolvedor", Some("Alt+CmdOrCtrl+I"))?).separator()
            .fullscreen_with_text("Tela cheia").build()?,
        &SubmenuBuilder::new(app, "Janela").minimize_with_text("Minimizar").maximize_with_text("Zoom").separator().close_window_with_text("Fechar janela").build()?,
    ])
}

// After each page load: title and "Open recent" follow the server's current file.
fn refresh_chrome(app: &AppHandle, on_dashboard: bool) {
    let r: serde_json::Value = serde_json::from_str(&api("GET", "/api/recent", "")).unwrap_or_default();
    let cur = r["current"].as_str().map(String::from);
    let recents: Vec<String> = r["recents"].as_array().into_iter().flatten().filter_map(|x| x["path"].as_str().map(String::from)).take(10).collect();
    let title = match (&cur, on_dashboard) {
        (Some(f), false) => format!("{} — Pena", Path::new(f).file_name().unwrap_or_default().to_string_lossy()),
        _ => "Pena".into(),
    };
    *CURRENT.lock().unwrap() = cur;
    if let Some(w) = win(app) {
        let _ = w.set_title(&title);
    }
    if let Ok(m) = build_menu(app, &recents) {
        let _ = app.set_menu(m);
    }
}

// The server: compiled next to this binary (Contents/MacOS/pena-server, pena-server.exe on Windows); it prints its URL first.
fn start_server(app: &AppHandle, file: Option<&String>) -> Result<String, String> {
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
        .spawn()
        .map_err(|e| format!("pena-server: {e}"))?;
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    let url = lines.next().and_then(Result::ok).filter(|l| l.starts_with("http")).ok_or("o servidor do Pena não iniciou")?;
    std::thread::spawn(move || lines.map_while(Result::ok).for_each(|l| eprintln!("{l}"))); // keep the pipe drained
    *SERVER.lock().unwrap() = Some(child);
    Ok(url)
}

fn main() {
    let file = std::env::args().skip(1).find(|a| a.ends_with(".pen"));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![pick_pen, pick_fig, save_export])
        .on_menu_event(|app, e| on_menu(app, e.id().as_ref()))
        .setup(move |app| {
            let h = app.handle().clone();
            let url = start_server(&h, file.as_ref()).inspect_err(|e| {
                app.dialog().message(e).title("Pena").blocking_show();
            })?;
            BASE.set(url.clone()).unwrap();
            let start = std::env::var("PENA_START").unwrap_or_else(|_| if file.is_some() { "/".into() } else { "/dashboard".into() });
            app.set_menu(build_menu(&h, &[])?)?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(format!("{url}{start}").parse()?))
                .title("Pena")
                .inner_size(1500.0, 950.0)
                .background_color(tauri::window::Color(0x18, 0x18, 0x1b, 0xff))
                // Agents render screenshots/exports in this window even when it's in the background.
                .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
                // Links (target=_blank) go to the browser.
                .on_new_window(|u, _| {
                    open_url(u.as_str());
                    NewWindowResponse::Deny
                })
                .on_page_load(|w, p| {
                    if p.event() == PageLoadEvent::Finished {
                        let (app, dash) = (w.app_handle().clone(), p.url().path() == "/dashboard");
                        std::thread::spawn(move || refresh_chrome(&app, dash));
                    }
                })
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Pena");
    app.run(|_app, e| match e {
        // macOS: double-clicking a .pen file (associated in tauri.conf.json) or dropping it on the dock icon.
        // Windows passes the file as an argument instead (main's `file`).
        #[cfg(target_os = "macos")]
        RunEvent::Opened { urls } => {
            let app = _app.clone();
            std::thread::spawn(move || urls.iter().filter_map(|u| u.to_file_path().ok()).for_each(|f| { open_pen(&app, &f); }));
        }
        RunEvent::Exit => {
            // Closing stdin lets the server exit on its own (it removes ~/.pena/server.json); kill if it hangs.
            if let Some(mut c) = SERVER.lock().unwrap().take() {
                drop(c.stdin.take());
                for _ in 0..20 {
                    if c.try_wait().ok().flatten().is_some() {
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                let _ = c.kill();
            }
        }
        _ => {}
    });
}
