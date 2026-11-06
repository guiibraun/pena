//! Native replacement of the server's canvas renderer (headless.mjs running public/scene.js on CanvasKit):
//! lays out a .pen document and draws frames to PNG/JPEG/WebP with Skia, as the editor does.
mod core;
mod fonts;
mod scene;
mod shader;

use anyhow::{bail, Result};
use base64::Engine;
use scene::Scene;
use serde_json::{json, Value};
use skia_safe::{AlphaType, Color, ColorSpace, ColorType, Data, EncodedImageFormat, FilterMode, Image, ImageInfo, MipmapMode, Paint, Rect, SamplingOptions, Surface};
use std::collections::HashMap;

pub use core::{resolve as resolve_value, theme_defaults};
pub use shader::{parse_uniforms, to_sksl};

/// Relative URLs the editor uses (`/asset/<rel>` next to the .pen file); absolute and data: URLs pass through.
pub fn asset_url(u: &str) -> String {
    if u.starts_with("http:") || u.starts_with("https:") || u.starts_with("data:") || u.starts_with("blob:") {
        u.to_string()
    } else {
        format!("/asset/{}", u.strip_prefix("./").unwrap_or(u))
    }
}

/// CPU raster surface like CanvasKit's MakeSurface (RGBA, unpremultiplied, sRGB).
pub(crate) fn raster_surface(w: i32, h: i32) -> Option<Surface> {
    let info = |a| ImageInfo::new((w, h), ColorType::RGBA8888, a, ColorSpace::new_srgb());
    skia_safe::surfaces::raster(&info(AlphaType::Unpremul), None, None).or_else(|| skia_safe::surfaces::raster(&info(AlphaType::Premul), None, None))
}

struct ShaderEntry {
    src: Option<String>,
    error: Option<String>,
}

/// Everything kept across renders: fonts, shaped paragraphs, decoded images and icons, shader sources and programs.
pub(crate) struct Caches {
    fonts: fonts::Fonts,
    font_version: u64,
    paras: HashMap<String, scene::Para>,
    measures: HashMap<String, [f64; 2]>,
    paths: HashMap<String, Option<skia_safe::Path>>,
    images: HashMap<String, Option<Image>>,
    icon_svg: HashMap<String, String>,
    shaders: HashMap<String, ShaderEntry>,
    programs: HashMap<String, std::result::Result<shader::Program, String>>,
    scratch: scene::Scratch,
    /// opacity of the editor's shared image paint (see the icon drawing in scene.rs)
    img_alpha: f32,
}

pub(crate) struct Ctx<'a> {
    pub c: &'a mut Caches,
    pub fetch: &'a dyn Fn(&str) -> Option<Vec<u8>>,
}

const IMAGES_MAX: usize = 400;
// Images are capped like pen.dev's base texture.
const MAX_IMG: f64 = 2048.0;
const ICON_DIRS: [(&str, &str); 6] = [
    ("lucide", "lucide-static/icons"),
    ("feather", "feather-icons/dist/icons"),
    ("phosphor", "@phosphor-icons/core/assets/regular"),
    ("Material Symbols Outlined", "@material-symbols/svg-400/outlined"),
    ("Material Symbols Rounded", "@material-symbols/svg-400/rounded"),
    ("Material Symbols Sharp", "@material-symbols/svg-400/sharp"),
];

fn data_url(u: &str) -> Option<Vec<u8>> {
    let (meta, body) = u.strip_prefix("data:")?.split_once(',')?;
    if meta.ends_with(";base64") {
        base64::engine::general_purpose::STANDARD.decode(body.trim()).ok()
    } else {
        let b = body.as_bytes();
        let mut out = vec![];
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' && i + 3 <= b.len() {
                if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or(""), 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
            out.push(b[i]);
            i += 1;
        }
        Some(out)
    }
}

/// SVG -> raster image with resvg, as headless.mjs does (resvg-js: natural size, or scaled to a width).
fn svg_image(svg: &[u8], width: Option<u32>) -> Option<Image> {
    let tree = resvg::usvg::Tree::from_data(svg, &resvg::usvg::Options::default()).ok()?;
    let size = tree.size().to_int_size();
    let (w, h, k) = match width {
        Some(w) => (w, ((w as f32 * size.height() as f32 / size.width() as f32).ceil() as u32).max(1), w as f32 / size.width() as f32),
        None => (size.width(), size.height(), 1.0),
    };
    let mut pixmap = resvg::tiny_skia::Pixmap::new(w, h)?;
    resvg::render(&tree, resvg::tiny_skia::Transform::from_scale(k, k), &mut pixmap.as_mut());
    let info = ImageInfo::new((w as i32, h as i32), ColorType::RGBA8888, AlphaType::Premul, ColorSpace::new_srgb());
    skia_safe::images::raster_from_data(&info, Data::new_copy(pixmap.data()), (w * 4) as usize)
}
fn svg_size(svg: &[u8]) -> Option<(u32, u32)> {
    let tree = resvg::usvg::Tree::from_data(svg, &resvg::usvg::Options::default()).ok()?;
    let s = tree.size().to_int_size();
    Some((s.width(), s.height()))
}
fn decode(bytes: &[u8]) -> Option<Image> {
    // Skia's prebuilt binaries have no WebP codec: libwebp decodes those
    if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        let img = webp::Decoder::new(bytes).decode()?;
        let (w, h) = (img.width() as i32, img.height() as i32);
        let rgba: Vec<u8> = if img.is_alpha() { img.to_vec() } else { img.chunks(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect() };
        let info = ImageInfo::new((w, h), ColorType::RGBA8888, AlphaType::Unpremul, None);
        return skia_safe::images::raster_from_data(&info, Data::new_copy(&rgba), (w * 4) as usize);
    }
    Image::from_encoded(Data::new_copy(bytes))
}
/// redraw into a CanvasKit-like surface at the (capped) size: color-managed to sRGB, linear filtering
fn rasterize(img: &Image, w: i32, h: i32) -> Option<Image> {
    let mut s = raster_surface(w, h)?;
    let src = Rect::from_wh(img.width() as f32, img.height() as f32);
    s.canvas().draw_image_rect_with_sampling_options(img, Some((&src, skia_safe::canvas::SrcRectConstraint::Strict)), Rect::from_wh(w as f32, h as f32), SamplingOptions::new(FilterMode::Linear, MipmapMode::None), &Paint::default());
    Some(s.image_snapshot())
}
fn capped(w: f64, h: f64) -> (i32, i32) {
    let k = (MAX_IMG / w.max(h)).min(1.0);
    ((core::round(w * k) as i32).max(1), (core::round(h * k) as i32).max(1))
}

impl Ctx<'_> {
    fn get(&self, url: &str) -> Option<Vec<u8>> {
        if url.starts_with("data:") { data_url(url) } else { (self.fetch)(url) }
    }
    /// image fill / shader texture by url (None if it can't be loaded)
    pub fn image(&mut self, url: &str) -> Option<Image> {
        if let Some(e) = self.c.images.get(url) {
            return e.clone();
        }
        let img = self.get(url).and_then(|bytes| {
            let head = String::from_utf8_lossy(&bytes[..bytes.len().min(512)]).to_lowercase();
            let is_svg = url.to_lowercase().split(['?', '#']).next().unwrap_or("").ends_with(".svg") || head.contains("<svg") || url.contains("image/svg");
            if is_svg {
                let (w, h) = svg_size(&bytes)?;
                svg_image(&bytes, Some(capped(w as f64, h as f64).0 as u32))
            } else {
                let img = decode(&bytes)?;
                let (w, h) = capped(img.width() as f64, img.height() as f64);
                rasterize(&img, w, h)
            }
        });
        if self.c.images.len() >= IMAGES_MAX {
            self.c.images.clear(); // ponytail: drops every image at once instead of LRU; a byte budget if photos pile up
        }
        self.c.images.insert(url.to_string(), img.clone());
        img
    }
    /// icon as an image, rasterized at the next power of two of its device size (32..512)
    pub fn icon(&mut self, library: &str, name: &str, fill: &str, px: f64) -> Option<Image> {
        let p2 = 2f64.powf(px.log2().ceil());
        let size = if p2.is_nan() { 32.0 } else { p2.max(32.0).min(512.0) } as u32;
        let key = format!("{library}|{name}|{fill}|{size}");
        if let Some(e) = self.c.images.get(&key) {
            return e.clone();
        }
        let dir = ICON_DIRS.iter().find(|(k, _)| *k == library).map(|(_, d)| *d).unwrap_or(ICON_DIRS[0].1);
        let url = format!("/icons/{dir}/{name}.svg");
        if !self.c.icon_svg.contains_key(&url) {
            let text = self.get(&url).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            self.c.icon_svg.insert(url.clone(), text);
        }
        let svg = &self.c.icon_svg[&url];
        let img = (!svg.is_empty()).then(|| icon_markup(svg, fill, size)).and_then(|svg| svg_image(svg.as_bytes(), Some(size)));
        self.c.images.insert(key, img.clone());
        img
    }
    pub fn shader_source(&mut self, url: &str) -> Option<String> {
        if !self.c.shaders.contains_key(url) {
            let e = match self.get(url) {
                Some(b) => ShaderEntry { src: Some(String::from_utf8_lossy(&b).into_owned()), error: None },
                // ponytail: the fetch callback has no status code; the JS shows the server's (404 for a missing file)
                None => ShaderEntry { src: None, error: Some("Shader not found (404)".into()) },
            };
            self.c.shaders.insert(url.to_string(), e);
        }
        self.c.shaders[url].src.clone()
    }
    /// The document changed on disk (an agent may have rewritten a .glsl): fetch the loaded sources again.
    fn refresh_shaders(&mut self) {
        let urls: Vec<String> = self.c.shaders.keys().cloned().collect();
        for url in urls {
            if let Some(src) = self.get(&url).map(|b| String::from_utf8_lossy(&b).into_owned()) {
                let e = self.c.shaders.get_mut(&url).unwrap();
                if e.src.as_ref() != Some(&src) {
                    e.src = Some(src);
                    e.error = None;
                }
            }
        }
    }
    pub fn program(&mut self, src: &str) -> Option<shader::Program> {
        if !self.c.programs.contains_key(src) {
            if self.c.programs.len() > 200 {
                self.c.programs.clear();
            }
            self.c.programs.insert(src.to_string(), shader::program(src));
        }
        self.c.programs[src].as_ref().ok().cloned()
    }
    pub fn shader_error(&mut self, url: &str) -> Option<String> {
        let e = self.c.shaders.get(url)?;
        if let Some(err) = &e.error {
            return Some(err.clone());
        }
        let src = e.src.clone()?;
        self.program(&src);
        self.c.programs[&src].as_ref().err().cloned()
    }
}

fn icon_markup(svg: &str, fill: &str, size: u32) -> String {
    let mut svg = svg.replace("currentColor", fill);
    if !regex::Regex::new(r"<svg[^>]*\sfill=").unwrap().is_match(&svg) {
        svg = svg.replacen("<svg", &format!("<svg fill=\"{fill}\""), 1);
    }
    // on the root tag only; Phosphor's files have just a viewBox, and an SVG with no size can't be rasterized
    let attrs = regex::Regex::new(r#"\s(width|height)="[^"]*""#).unwrap();
    regex::Regex::new(r"<svg[^>]*>")
        .unwrap()
        .replace(&svg, |c: &regex::Captures| attrs.replace_all(&c[0], "").replacen("<svg", &format!("<svg width=\"{size}\" height=\"{size}\""), 1))
        .into_owned()
}

/// Renders .pen frames like the editor's exports. Keeps fonts, images, icons and compiled shaders across calls.
pub struct Renderer {
    c: Caches,
}
// Skia objects are reference counted with atomics and not tied to a thread; the renderer is only used through
// &mut, so moving it to another thread is sound.
unsafe impl Send for Renderer {}

impl Default for Renderer {
    fn default() -> Self {
        Self::new()
    }
}

impl Renderer {
    pub fn new() -> Self {
        Renderer {
            c: Caches {
                fonts: fonts::Fonts::new(),
                font_version: 0,
                paras: HashMap::new(),
                measures: HashMap::new(),
                paths: HashMap::new(),
                images: HashMap::new(),
                icon_svg: HashMap::new(),
                shaders: HashMap::new(),
                programs: HashMap::new(),
                scratch: Default::default(),
                img_alpha: 1.0,
            },
        }
    }

    /// Fonts loaded, then laid out. Layout runs again on fresh nodes if a font arrived while measuring (a span's
    /// font, emoji): the result is what the editor shows once every font has loaded.
    fn scene<'s>(cx: &mut Ctx, doc: &'s Value, roots: &'s [Value]) -> Scene<'s> {
        cx.c.fonts.set_doc_fonts(doc.get("fonts").unwrap_or(&Value::Null), asset_url);
        let mut s = Scene::new(doc, roots);
        for (f, w, i) in s.fonts_needed() {
            cx.c.fonts.ensure(&f, w, i, cx.fetch);
        }
        for _ in 0..4 {
            if cx.c.fonts.version != cx.c.font_version {
                cx.c.font_version = cx.c.fonts.version;
                cx.c.paras.clear();
                cx.c.measures.clear();
            }
            let before = cx.c.fonts.version;
            for r in s.roots.clone() {
                s.layout_root(r, cx);
            }
            if cx.c.fonts.version == before {
                break;
            }
            s = Scene::new(doc, roots);
        }
        s.freeze(cx);
        s
    }

    /// doc: the document JSON incl. a "_lib" field (libraries: {nodes, variables, themes}); roots: pen-core
    /// expandDoc(doc) without connections. fetch: the same relative URLs the browser editor fetches ("/asset/<rel>",
    /// "/icons/<path>.svg", "/fonts/faces?family=X", "/fonts/file/<x>", or absolute https://...), returns the body.
    /// Returns one {id, data: "data:image/png;base64,...", warnings: [..]} per id.
    #[allow(clippy::too_many_arguments)]
    pub fn render(&mut self, doc: &Value, roots: &Value, ids: &[String], format: &str, scale: f32, quality: u32, fetch: &dyn Fn(&str) -> Option<Vec<u8>>) -> Result<Vec<Value>> {
        let roots = roots.as_array().map(|r| r.as_slice()).unwrap_or(&[]);
        let mut cx = Ctx { c: &mut self.c, fetch };
        cx.refresh_shaders();
        let scene = Self::scene(&mut cx, doc, roots);
        let mime = format!("image/{}", if format == "jpg" { "jpeg" } else { format });
        let mut out = vec![];
        for id in ids {
            let Some(&i) = scene.by_id.get(id) else { bail!("Node not found on canvas: {id}") };
            let bytes = draw(&scene, &mut cx, i, scale as f64, format, quality)?;
            let warnings = scene.shader_problems(i, &mut cx);
            out.push(json!({ "id": id, "data": format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)), "warnings": warnings }));
        }
        Ok(out)
    }

    /// Laid-out size of every top-level root, {id: {w, h}} rounded — what the editor posts to /rects.
    pub fn root_sizes(&mut self, doc: &Value, roots: &Value, fetch: &dyn Fn(&str) -> Option<Vec<u8>>) -> Value {
        let roots = roots.as_array().map(|r| r.as_slice()).unwrap_or(&[]);
        let mut cx = Ctx { c: &mut self.c, fetch };
        let scene = Self::scene(&mut cx, doc, roots);
        let mut out = serde_json::Map::new();
        for &r in &scene.roots {
            let b = scene.bounds(r);
            out.insert(scene.n(r).id.clone(), json!({ "w": core::round(b[2]), "h": core::round(b[3]) }));
        }
        Value::Object(out)
    }

    /// World bounds [x, y, w, h] of every node by id (the comparison test checks layout with it).
    #[doc(hidden)]
    pub fn node_bounds(&mut self, doc: &Value, roots: &Value, fetch: &dyn Fn(&str) -> Option<Vec<u8>>) -> Value {
        let roots = roots.as_array().map(|r| r.as_slice()).unwrap_or(&[]);
        let mut cx = Ctx { c: &mut self.c, fetch };
        let scene = Self::scene(&mut cx, doc, roots);
        Value::Object(scene.by_id.iter().map(|(id, &i)| (id.clone(), json!(scene.bounds(i)))).collect())
    }
}

/// headless.mjs draw(): the node's world bounds at `scale`, transparent (PNG/WebP) or white (JPEG) background
fn draw(scene: &Scene, cx: &mut Ctx, i: usize, scale: f64, format: &str, quality: u32) -> Result<Vec<u8>> {
    let b = scene.bounds(i);
    let (w, h) = (((b[2] * scale).ceil() as i32).max(1), ((b[3] * scale).ceil() as i32).max(1));
    let Some(mut surface) = raster_surface(w, h) else { bail!("Cannot allocate a {w}×{h} image") };
    let c = surface.canvas();
    c.clear(if format == "png" || format == "webp" { Color::TRANSPARENT } else { Color::WHITE });
    c.scale((scale as f32, scale as f32));
    c.translate((-b[0] as f32, -b[1] as f32));
    let pm = scene.n(i).parent.map(|p| scene.world_matrix(p)).unwrap_or(scene::IDENTITY);
    c.concat(&scene::sk(&pm));
    // animated shaders export their first frame (scene.time is 0)
    scene.draw_node(c, cx, i, [b[0] - 1e5, b[1] - 1e5, b[0] + 1e5, b[1] + 1e5], scale, &pm);
    let img = surface.image_snapshot();
    let data = match format {
        "jpg" | "jpeg" => img.encode(None, EncodedImageFormat::JPEG, quality),
        "webp" => {
            let info = ImageInfo::new((w, h), ColorType::RGBA8888, AlphaType::Unpremul, ColorSpace::new_srgb());
            let mut px = vec![0u8; (w * h * 4) as usize];
            if !img.read_pixels(&info, &mut px, (w * 4) as usize, (0, 0), skia_safe::image::CachingHint::Allow) {
                bail!("Cannot read the rendered pixels");
            }
            return Ok(webp::Encoder::from_rgba(&px, w as u32, h as u32).encode(quality as f32).to_vec());
        }
        _ => img.encode(None, EncodedImageFormat::PNG, None),
    };
    match data {
        Some(d) => Ok(d.as_bytes().to_vec()),
        None => bail!("Cannot encode the image as {format}"),
    }
}
