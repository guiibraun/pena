//! PENA's document core, natively: file IO and the sandboxed `execute` for .pen documents (doc.mjs), the server's copy
//! of the open document (store.mjs) and the agent tools (tools.mjs). The document model itself stays in
//! public/pen-core.js, run in QuickJS, so the editor and the agents share one implementation.
mod doc;
pub mod expand;
mod js;
mod store;
pub mod summary;
pub mod tools;

pub use doc::{Exec, empty, execute, load, read_skill, save, system_prompt};
pub use store::Store;

use std::path::{Component, Path, PathBuf};

/// Where public/, skills/ and node_modules/ live: PENA_ROOT, else the first folder holding public/pen-core.js going up
/// from the executable's folder, then from the working directory.
pub fn root() -> PathBuf {
    if let Some(r) = std::env::var_os("PENA_ROOT") {
        return PathBuf::from(r);
    }
    let starts = [std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)), std::env::current_dir().ok()];
    for start in starts.into_iter().flatten() {
        if let Some(d) = start.ancestors().find(|d| d.join("public/pen-core.js").is_file()) {
            return d.to_path_buf();
        }
    }
    std::env::current_dir().unwrap_or_default()
}

/// node's path.resolve(base, p): absolute, with `.` and `..` folded (lexically, like node).
pub(crate) fn resolve(base: &Path, p: &Path) -> PathBuf {
    let joined = if p.is_absolute() { p.to_path_buf() } else if base.is_absolute() { base.join(p) } else { std::env::current_dir().unwrap_or_default().join(base).join(p) };
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    out
}
