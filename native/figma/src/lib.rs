#![recursion_limit = "512"]
//! .fig import/export (figma.mjs, figma-schema.mjs) and pen.dev browser-extension paste (browser-import.mjs).
mod browser;
mod export;
mod import;
mod js;
mod kiwi;
#[cfg(test)]
mod tests;

pub use browser::{BROWSER_MIME, import_browser_snapshot, read_browser_clipboard};
pub use export::{FIG_VERSION, export_figma};
pub use import::import_figma;
