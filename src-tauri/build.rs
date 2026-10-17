fn main() {
    // Custom commands must be listed so the remote capability (the app's own http://127.0.0.1 pages) can grant them.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&["pick_pen", "pick_fig", "save_export"]))).unwrap();
}
