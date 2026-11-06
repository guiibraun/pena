// Pixel and layout comparison against the reference renderer (headless.mjs: CanvasKit running public/scene.js).
// Generate the reference first, from the repo root:  bun native/render/tests/reference.mjs
// It renders the example frames and records every fetch, which this test replays to the Rust renderer.
// Writes the Rust renders and diff heatmaps to target/out-<os>/<pen>/.
use pena_render::Renderer;
use serde_json::Value;
use skia_safe::{AlphaType, ColorSpace, ColorType, Data, EncodedImageFormat, Image, ImageInfo};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn pixels(bytes: &[u8]) -> (i32, i32, Vec<u8>) {
    let img = Image::from_encoded(Data::new_copy(bytes)).expect("decodable image");
    let (w, h) = (img.width(), img.height());
    let info = ImageInfo::new((w, h), ColorType::RGBA8888, AlphaType::Unpremul, ColorSpace::new_srgb());
    let mut px = vec![0u8; (w * h * 4) as usize];
    assert!(img.read_pixels(&info, &mut px, (w * 4) as usize, (0, 0), skia_safe::image::CachingHint::Allow));
    (w, h, px)
}
// premultiplied channels: transparent pixels compare equal whatever their color
fn premul(px: &[u8], i: usize) -> [f64; 4] {
    let a = px[i + 3] as f64 / 255.0;
    [px[i] as f64 * a, px[i + 1] as f64 * a, px[i + 2] as f64 * a, px[i + 3] as f64]
}
fn heatmap(w: i32, h: i32, a: &[u8], b: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; a.len()];
    for i in (0..a.len()).step_by(4) {
        let (p, q) = (premul(a, i), premul(b, i));
        let d = (0..4).map(|k| (p[k] - q[k]).abs()).fold(0.0, f64::max).min(255.0) as u8;
        let g = (a[i] as u32 + a[i + 1] as u32 + a[i + 2] as u32) / 12; // faint reference underneath
        out[i..i + 4].copy_from_slice(&[d.max(g as u8), g as u8, g as u8, 255]);
    }
    let info = ImageInfo::new((w, h), ColorType::RGBA8888, AlphaType::Unpremul, None);
    let img = skia_safe::images::raster_from_data(&info, Data::new_copy(&out), (w * 4) as usize).unwrap();
    img.encode(None, EncodedImageFormat::PNG, None).unwrap().as_bytes().to_vec()
}

#[test]
fn matches_reference() {
    let base = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target");
    let refdir = base.join("ref");
    if !refdir.join("jobs.json").exists() {
        eprintln!("no reference renders: run `bun native/render/tests/reference.mjs` from the repo root first");
        return;
    }
    let read = |p: &Path| std::fs::read(p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    let json = |p: PathBuf| -> Value { serde_json::from_slice(&read(&p)).unwrap() };
    let index: HashMap<String, Option<String>> = serde_json::from_value(json(refdir.join("fetch/index.json"))).unwrap();
    let fetch_dir = refdir.join("fetch");
    let fetch = |u: &str| -> Option<Vec<u8>> { index.get(u)?.as_ref().map(|f| std::fs::read(fetch_dir.join(f)).unwrap()) };

    let mut renderer = Renderer::new();
    let mut failures = vec![];
    let mut docs: HashMap<String, (Value, Value)> = HashMap::new();
    for pen in ["welcome", "demo", "shaders", "features"] {
        let (doc, roots) = (json(refdir.join(pen).join("doc.json")), json(refdir.join(pen).join("roots.json")));
        // layout: every node's world bounds, exactly
        let want = json(refdir.join(pen).join("bounds.json"));
        let got = renderer.node_bounds(&doc, &roots, &fetch);
        let (mut worst, mut off) = (0.0f64, 0);
        for (id, w) in want.as_object().unwrap() {
            let g = &got[id];
            let d = (0..4).map(|k| (w[k].as_f64().unwrap_or(f64::NAN) - g[k].as_f64().unwrap_or(f64::NAN)).abs()).fold(0.0, f64::max);
            if !(d <= 1e-3) {
                off += 1;
                if off <= 5 {
                    eprintln!("  {pen} {id}: reference {w} rust {g}");
                }
            }
            if d.is_finite() {
                worst = worst.max(d);
            }
        }
        eprintln!("layout {pen}: {} nodes, {off} off, worst {worst:.4} px", want.as_object().unwrap().len());
        if off > 0 {
            failures.push(format!("layout {pen}: {off} nodes off"));
        }
        // root sizes = the reference's rounded root bounds
        let sizes = renderer.root_sizes(&doc, &roots, &fetch);
        for r in roots.as_array().unwrap() {
            let id = r["id"].as_str().unwrap();
            let b = &want[id];
            let (w, h) = ((b[2].as_f64().unwrap() + 0.5).floor(), (b[3].as_f64().unwrap() + 0.5).floor());
            if sizes[id]["w"].as_f64() != Some(w) || sizes[id]["h"].as_f64() != Some(h) {
                failures.push(format!("root size {pen}/{id}: {} vs {w}x{h}", sizes[id]));
            }
        }
        docs.insert(pen.into(), (doc, roots));
    }

    let jobs = json(refdir.join("jobs.json"));
    // The reference renders every job twice and keeps the second round; drawing state that outlives a render (the
    // editor's shared image paint, CanvasKit's rrect scratch buffers) then carries over from the first round. Same here.
    for j in jobs.as_array().unwrap() {
        let (doc, roots) = &docs[j["pen"].as_str().unwrap()];
        renderer.render(doc, roots, &[j["id"].as_str().unwrap().to_string()], "png", j["scale"].as_f64().unwrap() as f32, 92, &fetch).unwrap();
    }
    for j in jobs.as_array().unwrap() {
        let (pen, id, scale) = (j["pen"].as_str().unwrap(), j["id"].as_str().unwrap(), j["scale"].as_f64().unwrap());
        let (doc, roots) = &docs[pen];
        let out = renderer.render(doc, roots, &[id.to_string()], "png", scale as f32, 92, &fetch).unwrap().remove(0);
        let b64 = out["data"].as_str().unwrap().split(',').nth(1).unwrap();
        let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, b64).unwrap();
        let dir = base.join(format!("out-{}", std::env::consts::OS)).join(pen);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{id}@{scale}.png")), &bytes).unwrap();
        if out["warnings"] != j["warnings"] {
            failures.push(format!("{pen}/{id}: warnings {} vs {}", out["warnings"], j["warnings"]));
        }
        let (rw, rh, rp) = pixels(&read(&refdir.join(j["file"].as_str().unwrap())));
        let (w, h, p) = pixels(&bytes);
        if (rw, rh) != (w, h) {
            failures.push(format!("{pen}/{id}@{scale}: size {w}x{h} vs reference {rw}x{rh}"));
            continue;
        }
        let (mut sum, mut bad) = (0.0, 0usize);
        for i in (0..p.len()).step_by(4) {
            let (a, b) = (premul(&rp, i), premul(&p, i));
            let d: f64 = (0..4).map(|k| (a[k] - b[k]).abs()).sum::<f64>() / 4.0;
            sum += d;
            if (0..4).any(|k| (a[k] - b[k]).abs() > 32.0) {
                bad += 1;
            }
        }
        let n = (w * h) as f64;
        let (mean, bad_pct) = (sum / n, 100.0 * bad as f64 / n);
        std::fs::write(dir.join(format!("{id}@{scale}.diff.png")), heatmap(w, h, &rp, &p)).unwrap();
        eprintln!("{pen:8} {id:6} @{scale:<4} {w:5}x{h:<5} mean diff {mean:6.3}/255  pixels off by >32: {bad_pct:6.3}%");
        // ponytail: one threshold for all frames; glyph rasterizers differ by platform (CoreText on macOS)
        if mean > 3.0 {
            failures.push(format!("{pen}/{id}@{scale}: mean diff {mean:.3}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
