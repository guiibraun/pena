// pen.dev's browser extension ("copy to Pen"), browser-import.mjs: it puts a DOM snapshot of the selected element on the
// clipboard under `web application/vnd.pen.dev.browser-import+json` = { version: 1, snapshot: { url, root, ... },
// images: [{ url, contentType, base64 }], fonts }. Each snapshot node has `tag`, `rect` (page coordinates), computed
// `style` (camelCase strings), `children`, and optionally `text`/`textRect`, `imageSrc`, `svgSource`.
// The desktop webview (WebKit) can't read Chrome's custom clipboard types, so the server reads the macOS pasteboard.
use crate::export::base64_loose;
use crate::import::js_space;
use crate::js::{self, ftruthy, num, truthy};
use anyhow::{Result, anyhow, bail};
use indexmap::IndexMap;
use regex::Regex;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::OnceLock;

pub const BROWSER_MIME: &str = "vnd.pen.dev.browser-import+json";

// Every Chrome custom-data type on the pasteboard, base64: `setData` writes a pickle (org.chromium.web-custom-data),
// the async clipboard API a JSON map (custom type → pasteboard type) plus one pasteboard type per entry.
const JXA: &str = r"ObjC.import('AppKit');
const pb = $.NSPasteboard.generalPasteboard, out = {};
for (const t of ObjC.deepUnwrap(pb.types) ?? []) if (/custom/i.test(t)) { const d = pb.dataForType(t); if (!d.isNil()) out[t] = ObjC.unwrap(d.base64EncodedStringWithOptions(0)); }
JSON.stringify(out)";

// ponytail: macOS only (osascript); Windows/Linux need their own pasteboard reader
pub fn read_browser_clipboard() -> Option<String> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let out = std::process::Command::new("osascript").args(["-l", "JavaScript", "-e", JXA]).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let Value::Object(map) = serde_json::from_slice(&out.stdout).ok()? else { return None };
    let types: IndexMap<String, Vec<u8>> = map.into_iter().map(|(k, v)| (k, base64_loose(v.as_str().unwrap_or("")))).collect();
    find_payload(&types)
}

pub(crate) fn find_payload(types: &IndexMap<String, Vec<u8>>) -> Option<String> {
    if let Some(pickle) = types.get("org.chromium.web-custom-data") {
        // a malformed pickle throws in JS, which the clipboard reader turns into null
        for (k, v) in read_pickle(pickle)? {
            if k.contains(BROWSER_MIME) {
                return Some(v);
            }
        }
    }
    for (t, data) in types {
        if !t.to_lowercase().contains("map") {
            continue;
        }
        let Ok(Value::Object(map)) = serde_json::from_slice::<Value>(data) else { continue };
        let Some(target) = map.iter().find(|(k, _)| k.contains(BROWSER_MIME)).map(|(_, v)| js::string(v)).filter(|t| !t.is_empty()) else { continue };
        if let Some(hit) = types.keys().find(|k| *k != t && (**k == target || k.ends_with(&target))) {
            return Some(String::from_utf8_lossy(&types[hit]).into_owned());
        }
    }
    None
}

// Chromium pickle: uint32 payload size, uint32 count, then (type, data) string16 pairs (uint32 length + UTF-16LE, 4-byte aligned)
pub(crate) fn read_pickle(b: &[u8]) -> Option<Vec<(String, String)>> {
    let mut o = 4;
    let u32_at = |o: &mut usize| -> Option<usize> {
        let v = u32::from_le_bytes(b.get(*o..*o + 4)?.try_into().ok()?) as usize;
        *o += 4;
        Some(v)
    };
    let str16 = |o: &mut usize| -> Option<String> {
        let n = u32_at(o)?;
        let end = (*o + n * 2).min(b.len());
        let units: Vec<u16> = b.get(*o..end).unwrap_or(&[]).chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        *o += (n * 2 + 3) & !3;
        Some(String::from_utf16_lossy(&units))
    };
    let mut out = vec![];
    for _ in 0..u32_at(&mut o)? {
        let k = str16(&mut o)?;
        let v = str16(&mut o)?;
        out.push((k, v));
    }
    Some(out)
}

// ---------------------------------------------------------------- snapshot → .pen nodes
fn round(v: f64) -> f64 {
    js::round(v * 100.0) / 100.0
}
fn re(cell: &'static OnceLock<Regex>, src: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(src).unwrap())
}
fn s<'a>(st: &'a Value, k: &str) -> Option<&'a str> {
    st[k].as_str()
}

struct Ctx<'a> {
    base: Option<url::Url>,
    has_base: bool,
    bytes: HashMap<String, Value>,
    saved: HashMap<String, Option<String>>,
    save_image: &'a mut dyn FnMut(&str, &[u8]) -> String,
}

impl Ctx<'_> {
    // new URL(u, snapshot.url).href, or u itself when that throws
    fn abs(&self, u: &str) -> String {
        let r = if self.has_base { self.base.as_ref().and_then(|b| b.join(u).ok()) } else { url::Url::parse(u).ok() };
        r.map_or_else(|| u.into(), |u| u.to_string())
    }
    fn image(&mut self, src: &Value) -> Result<Option<String>> {
        if !truthy(src) {
            return Ok(None);
        }
        let src = self.abs(&js::string(src));
        if let Some(u) = self.saved.get(&src) {
            return Ok(u.clone());
        }
        static DATA: OnceLock<Regex> = OnceLock::new();
        let (mut data, mut ext) = (None, String::new());
        if let Some(m) = re(&DATA, r"(?s)^data:image/([A-Za-z0-9_+]+)(;base64)?,(.*)$").captures(&src) {
            ext = m[1].into();
            data = Some(if m.get(2).is_some() { base64_loose(&m[3]) } else { decode_uri_component(&m[3])?.into_bytes() });
        } else if let Some(i) = self.bytes.get(&src) {
            let ct = js::string(&i["contentType"]);
            ext = ct.split('/').nth(1).ok_or_else(|| anyhow!("image without a content type: {src}"))?.into();
            data = Some(base64_loose(i["base64"].as_str().unwrap_or("")));
        }
        let url = match data {
            Some(d) => {
                let name = format!("web-{}.{}", self.saved.len() + 1, ext.replacen("svg+xml", "svg", 1).replacen("jpeg", "jpg", 1));
                Some((self.save_image)(&name, &d))
            }
            None if src.starts_with("http:") || src.starts_with("https:") => Some(src.clone()),
            None => None,
        };
        self.saved.insert(src, url.clone());
        Ok(url)
    }
    fn svg(&mut self, source: &str) -> String {
        let s = if source.contains("xmlns=") { source.into() } else { source.replacen("<svg", "<svg xmlns=\"http://www.w3.org/2000/svg\"", 1) };
        (self.save_image)(&format!("web-svg-{}.svg", self.saved.len() + 1), s.as_bytes())
    }

    fn walk(&mut self, d: &Value, parent: &Value, scale: f64, is_root: bool) -> Result<Vec<Value>> {
        if d["enabled"] == false {
            return Ok(vec![]);
        }
        let scale = match d["styleScale"].as_f64() {
            Some(x) if x > 0.0 => x,
            _ => scale,
        };
        let empty = json!({});
        let st = if d["style"].is_null() { &empty } else { &d["style"] };
        let r = &d["rect"];
        if !r.is_object() {
            bail!("snapshot node without rect");
        }
        let rn = |k: &str| js::number(&r[k]);
        let has_kids = !arr(&d["children"]).is_empty();
        if s(st, "display") == Some("none") || s(st, "visibility") == Some("hidden") || (rn("w") <= 0.0 && rn("h") <= 0.0 && !has_kids) {
            return Ok(vec![]);
        }
        let px = |v: &Value| px(v, scale);
        let pos = |rect: &Value, out: &mut Map<String, Value>| {
            out.insert("x".into(), num(round(js::number(&rect["x"]) - js::number(&parent["x"]))));
            out.insert("y".into(), num(round(js::number(&rect["y"]) - js::number(&parent["y"]))));
        };
        let mut out = vec![];
        let radius = corner_radius(st, r, &px);
        let opacity = if truthy(&st["opacity"]) && st["opacity"] != "1" { Some(num(round(js::number(&st["opacity"])))) } else { None };
        let tag = js::string(&d["tag"]).to_lowercase();

        if truthy(&d["svgSource"]) || truthy(&d["imageSrc"]) {
            let is_svg = truthy(&d["svgSource"]);
            let url = if is_svg { Some(self.svg(&js::string(&d["svgSource"]))) } else { self.image(&d["imageSrc"])? };
            if let Some(url) = url {
                let mut n = Map::new();
                n.insert("type".into(), "rectangle".into());
                n.insert("name".into(), tag.into());
                pos(r, &mut n);
                n.insert("width".into(), num(round(rn("w"))));
                n.insert("height".into(), num(round(rn("h"))));
                let mode = if is_svg {
                    "contain"
                } else {
                    match s(st, "objectFit") {
                        Some("contain") => "contain",
                        Some("fill") => "stretch",
                        _ => "cover",
                    }
                };
                n.insert("fill".into(), json!({ "type": "image", "url": url, "mode": mode }));
                if let Some(r) = radius {
                    n.insert("cornerRadius".into(), r);
                }
                if let Some(o) = opacity {
                    n.insert("opacity".into(), o);
                }
                out.push(Value::Object(n));
            }
            return Ok(out);
        }

        let mut fills = vec![];
        if let Some(bg) = color(s(st, "backgroundColor")) {
            fills.push(Value::String(bg));
        }
        static BG: OnceLock<Regex> = OnceLock::new();
        let bg_url = re(&BG, r#"url\(["']?([^"')]+)["']?\)"#).captures(s(st, "backgroundImage").unwrap_or("")).map(|m| m[1].to_string());
        if let Some(u) = bg_url
            && let Some(url) = self.image(&u.into())?
        {
            let mode = if s(st, "backgroundSize") == Some("contain") { "contain" } else { "cover" };
            fills.push(json!({ "type": "image", "url": url, "mode": mode }));
        }
        let name = [&d["componentName"], &d["htmlId"]].into_iter().find(|v| !v.is_null()).cloned().unwrap_or(tag.into());
        let mut frame = Map::new();
        frame.insert("type".into(), "frame".into());
        frame.insert("name".into(), name);
        pos(r, &mut frame);
        frame.insert("width".into(), num(round(rn("w"))));
        frame.insert("height".into(), num(round(rn("h"))));
        frame.insert("layout".into(), "none".into());
        let has_fill = !fills.is_empty();
        if has_fill {
            frame.insert("fill".into(), if fills.len() == 1 { fills.pop().unwrap() } else { fills.into() });
        }
        if let Some(r) = radius {
            frame.insert("cornerRadius".into(), r);
        }
        if let Some(o) = opacity {
            frame.insert("opacity".into(), o);
        }
        let sides_k = ["Top", "Right", "Bottom", "Left"];
        let sides: Vec<f64> = sides_k
            .iter()
            .map(|k| if s(st, &format!("border{k}Style")).unwrap_or("none") != "none" { px(&st[format!("border{k}Width").as_str()]) } else { 0.0 })
            .collect();
        let border_color = sides_k.iter().enumerate().find_map(|(i, k)| if ftruthy(sides[i]) { color(s(st, &format!("border{k}Color"))) } else { None });
        if let Some(bc) = border_color
            && sides.iter().any(|&v| ftruthy(v))
        {
            frame.insert("stroke".into(), bc.into());
            frame.insert("strokeAlignment".into(), "inner".into());
            let w = if sides.iter().all(|&v| v == sides[0]) {
                num(sides[0])
            } else {
                let mut o = Map::new();
                for (k, v) in ["top", "right", "bottom", "left"].iter().zip(&sides) {
                    if ftruthy(*v) {
                        o.insert((*k).into(), num(*v));
                    }
                }
                Value::Object(o)
            };
            frame.insert("strokeWidth".into(), w);
        }
        if let Some(sh) = box_shadow(s(st, "boxShadow"), &px) {
            frame.insert("effect".into(), sh);
        }
        if ["overflow", "overflowX", "overflowY"].iter().any(|k| matches!(s(st, k), Some("hidden" | "clip"))) {
            frame.insert("clip".into(), true.into());
        }

        // a box with nothing to draw is just a wrapper: its children go straight into the nearest drawn ancestor
        let visible = is_root || has_fill || frame.contains_key("stroke") || frame.contains_key("effect") || frame.contains_key("clip");
        let here = if visible { r } else { parent };
        let mut kids = vec![];
        if d["text"].as_str().is_some_and(|t| !t.trim_matches(js_space).is_empty()) {
            let rect = if d["textRect"].is_null() { r } else { &d["textRect"] };
            kids.push(text_node(d, st, &px, rect, here));
        }
        for c in arr(&d["children"]) {
            kids.extend(self.walk(c, here, scale, false)?);
        }
        if visible {
            if !kids.is_empty() {
                frame.insert("children".into(), kids.into());
            }
            out.push(Value::Object(frame));
        } else {
            out.extend(kids);
        }
        Ok(out)
    }
}

fn arr(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], |a| a.as_slice())
}
fn px(v: &Value, scale: f64) -> f64 {
    match v.as_str() {
        Some(s) if !s.is_empty() && s.ends_with("px") => js::parse_float(s) * scale,
        _ => 0.0,
    }
}

// decodeURIComponent; malformed escapes throw (URIError) like JS
fn decode_uri_component(s: &str) -> Result<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()).ok_or_else(|| anyhow!("URI malformed"))?;
            out.push(h);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| anyhow!("URI malformed"))
}

/// payload: the clipboard JSON. save_image(name, bytes) stores an image and returns its url.
pub fn import_browser_snapshot(payload: &str, save_image: &mut dyn FnMut(&str, &[u8]) -> String) -> Result<Value> {
    let p: Value = serde_json::from_str(payload)?;
    let snapshot = &p["snapshot"];
    if !truthy(&snapshot["root"]) {
        bail!("Clipboard has no browser snapshot");
    }
    let has_base = !snapshot["url"].is_null();
    let base = url::Url::parse(&js::string(&snapshot["url"])).ok();
    let mut cx = Ctx { base, has_base, bytes: HashMap::new(), saved: HashMap::new(), save_image };
    for i in arr(&p["images"]) {
        let k = cx.abs(&js::string(&i["url"]));
        cx.bytes.insert(k, i.clone());
    }
    let root = &snapshot["root"];
    let mut nodes = cx.walk(root, &root["rect"], 1.0, true)?;
    if nodes.is_empty() {
        bail!("The snapshot produced no layers");
    }
    let mut node = nodes.swap_remove(0);
    if node["type"] == "frame" {
        let o = node.as_object_mut().unwrap();
        o.insert("clip".into(), true.into());
        if !truthy(&o.get("fill").cloned().unwrap_or_default())
            && let Some(c) = color(snapshot["pageBackground"].as_str())
        {
            o.insert("fill".into(), c.into());
        }
        if matches!(o.get("name").and_then(Value::as_str), Some("html" | "body")) {
            let u = url::Url::parse(&js::string(&snapshot["url"]))?;
            o.insert("name".into(), u.host_str().unwrap_or("").into());
        }
    }
    let mut out = json!({ "pages": [{ "name": snapshot["url"], "nodes": [node] }], "fonts": [] });
    js::normalize(&mut out);
    Ok(out)
}

fn text_node(d: &Value, st: &Value, px: &dyn Fn(&Value) -> f64, rect: &Value, parent: &Value) -> Value {
    let fs = px(&st["fontSize"]);
    let font_size = if ftruthy(fs) { fs } else { 16.0 };
    let lh = px(&st["lineHeight"]);
    let text = d["text"].as_str().unwrap_or("");
    let mut content = if s(st, "whiteSpace").unwrap_or("").starts_with("pre") {
        text.to_string()
    } else {
        // .replace(/\s+/g, ' ').trim()
        let mut c = String::with_capacity(text.len());
        let mut space = false;
        for ch in text.chars() {
            if js_space(ch) {
                space = true;
            } else {
                if space && !c.is_empty() {
                    c.push(' ');
                }
                space = false;
                c.push(ch);
            }
        }
        c
    };
    match s(st, "textTransform") {
        Some("uppercase") => content = content.to_uppercase(),
        Some("lowercase") => content = content.to_lowercase(),
        _ => {}
    }
    let n = |v: &Value, k: &str| js::number(&v[k]);
    let mut t = Map::new();
    t.insert("type".into(), "text".into());
    t.insert("content".into(), content.into());
    t.insert("x".into(), num(round(n(rect, "x") - n(parent, "x"))));
    t.insert("y".into(), num(round(n(rect, "y") - n(parent, "y"))));
    t.insert("textGrowth".into(), "fixed-width".into());
    t.insert("width".into(), num(round(n(rect, "w") + 1.0))); // +1: the browser's rounding must not wrap the last word
    t.insert("fontFamily".into(), family(s(st, "fontFamily")).into());
    t.insert("fontSize".into(), num(round(font_size)));
    if let Some(c) = color(s(st, "color")) {
        t.insert("fill".into(), c.into());
    }
    let fw = &st["fontWeight"];
    if truthy(fw) && fw != "400" && fw != "normal" {
        t.insert("fontWeight".into(), if fw == "bold" { "700".into() } else { js::string(fw) }.into());
    }
    if s(st, "fontStyle") == Some("italic") {
        t.insert("fontStyle".into(), "italic".into());
    }
    if ftruthy(lh) {
        t.insert("lineHeight".into(), num(round(lh / font_size)));
    }
    let ls = px(&st["letterSpacing"]);
    if ftruthy(ls) {
        t.insert("letterSpacing".into(), num(round(ls)));
    }
    let align = match s(st, "textAlign") {
        Some("center") => Some("center"),
        Some("right" | "end") => Some("right"),
        Some("justify") => Some("justify"),
        _ => None,
    };
    if let Some(a) = align {
        t.insert("textAlign".into(), a.into());
    }
    let deco = [&st["textDecorationLine"], &st["textDecoration"]].into_iter().find(|v| !v.is_null()).map(js::string).unwrap_or_default();
    if deco.contains("underline") {
        t.insert("underline".into(), true.into());
    }
    if deco.contains("line-through") {
        t.insert("strikethrough".into(), true.into());
    }
    Value::Object(t)
}

// Pena loads fonts from Google Fonts by name, so the page's bundler names go back to the real family. The snapshot's
// own font files are skipped: they're WOFF2 (Skia needs TTF) and often just one unicode subset (e.g. only cyrillic).
pub(crate) fn family(css: Option<&str>) -> String {
    let first = css.unwrap_or("").split(',').next().unwrap_or("").trim_matches(js_space);
    let first = first.strip_prefix(['"', '\'']).unwrap_or(first);
    let mut f = first.strip_suffix(['"', '\'']).unwrap_or(first).to_string();
    static NEXT: OnceLock<Regex> = OnceLock::new();
    static VAR: OnceLock<Regex> = OnceLock::new();
    static GENERIC: OnceLock<Regex> = OnceLock::new();
    // next/font: "__Playfair_Display_a1b2c3"
    if let Some(m) = re(&NEXT, r"^__(.+?)(?:_Fallback)?_[0-9a-f]{6,}$").captures(&f) {
        f = m[1].replace('_', " ");
    }
    f = re(&VAR, r"\s+Variable$").replace(&f, "").into_owned(); // Fontsource: "Geist Variable"
    if f.is_empty() || re(&GENERIC, r"(?i)^(system-ui|ui-sans-serif|-apple-system|BlinkMacSystemFont|sans-serif)$").is_match(&f) { "Inter".into() } else { f }
}

fn corner_radius(st: &Value, r: &Value, px: &dyn Fn(&Value) -> f64) -> Option<Value> {
    let (w, h) = (js::number(&r["w"]), js::number(&r["h"]));
    let v: Vec<f64> = ["TopLeft", "TopRight", "BottomRight", "BottomLeft"]
        .iter()
        .map(|k| {
            let raw = &st[format!("border{k}Radius").as_str()];
            let raw = if raw.is_null() { String::new() } else { js::string(raw) };
            let x = if raw.ends_with('%') { (js::parse_float(&raw) / 100.0) * js::min(w, h) } else { px(&Value::String(raw.split(' ').next().unwrap_or("").into())) };
            round(js::min(x, js::min(w, h) / 2.0))
        })
        .collect();
    if v.iter().all(|&x| !ftruthy(x)) {
        return None;
    }
    Some(if v.iter().all(|&x| x == v[0]) { num(v[0]) } else { v.iter().map(|&x| num(x)).collect() })
}

// Chrome's computed form: "rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, ..." (first shadow only)
fn box_shadow(v: Option<&str>, px: &dyn Fn(&Value) -> f64) -> Option<Value> {
    let v = v.filter(|v| !v.is_empty() && *v != "none")?;
    // split(/,(?![^(]*\))/)[0]: the first comma that isn't inside parentheses
    let b = v.as_bytes();
    let cut = (0..b.len())
        .find(|&i| {
            b[i] == b',' && {
                let rest = &b[i + 1..];
                let close = rest.iter().position(|&c| c == b')');
                let open = rest.iter().position(|&c| c == b'(');
                !matches!((close, open), (Some(c), o) if o.is_none_or(|o| c < o))
            }
        })
        .unwrap_or(b.len());
    let first = &v[..cut];
    static COLOR: OnceLock<Regex> = OnceLock::new();
    static LEN: OnceLock<Regex> = OnceLock::new();
    let c = re(&COLOR, r"^(\w+\([^)]*\)|#\w+)").captures(first.trim_matches(js_space)).and_then(|m| color(Some(&m[1])));
    let lens: Vec<f64> = re(&LEN, r"-?[\d.]+px").find_iter(first).map(|m| px(&Value::String(m.as_str().into()))).collect();
    let g = |i: usize| lens.get(i).copied().unwrap_or(0.0);
    let (x, y, blur, spread) = (g(0), g(1), g(2), g(3));
    let c = c?;
    let mut o = Map::new();
    o.insert("type".into(), "shadow".into());
    o.insert("shadowType".into(), if first.contains("inset") { "inner" } else { "outer" }.into());
    o.insert("color".into(), c.into());
    if ftruthy(x) || ftruthy(y) {
        o.insert("offset".into(), json!({ "x": num(x), "y": num(y) }));
    }
    if ftruthy(blur) {
        o.insert("blur".into(), num(blur));
    }
    if ftruthy(spread) {
        o.insert("spread".into(), num(spread));
    }
    Some(Value::Object(o))
}

// CSS color → #rrggbb[aa]: rgb()/rgba(), oklch(), oklab(), color(srgb ...), #hex. Fully transparent → None.
pub(crate) fn color(v: Option<&str>) -> Option<String> {
    let v = v.filter(|v| !v.is_empty() && *v != "transparent" && *v != "none")?;
    if let Some(h) = v.strip_prefix('#') {
        return Some(if v.len() == 4 { format!("#{}", h.chars().flat_map(|c| [c, c]).collect::<String>()) } else { v.into() });
    }
    static FN: OnceLock<Regex> = OnceLock::new();
    let m = re(&FN, r"^([\w-]+)\((.*)\)$").captures(v.trim_matches(js_space))?;
    let (name, args) = (&m[1], &m[2]);
    let parts: Vec<String> = args.replace([',', '/'], " ").split(js_space).filter(|p| !p.is_empty() && *p != "srgb").map(String::from).collect();
    let numf = |p: Option<&String>, scale: f64| match p {
        None => f64::NAN,
        Some(p) if p.ends_with('%') => (js::parse_float(p) / 100.0) * scale,
        Some(p) => js::parse_float(p),
    };
    let a = if parts.len() > 3 { numf(parts.get(3), 1.0) } else { 1.0 };
    let rgb: Vec<f64> = if name == "rgb" || name == "rgba" {
        parts.iter().take(3).map(|p| numf(Some(p), 255.0) / 255.0).collect()
    } else if name == "color" && args.contains("srgb") {
        parts.iter().take(3).map(|p| numf(Some(p), 1.0)).collect()
    } else if name == "oklch" {
        let (l, c) = (numf(parts.first(), 1.0), numf(parts.get(1), 0.4));
        let hh = parts.get(2).map_or(f64::NAN, |p| js::parse_float(p));
        let h = (if ftruthy(hh) { hh } else { 0.0 }) * std::f64::consts::PI / 180.0;
        oklab(l, c * h.cos(), c * h.sin()).to_vec()
    } else if name == "oklab" {
        oklab(numf(parts.first(), 1.0), numf(parts.get(1), 0.4), numf(parts.get(2), 0.4)).to_vec()
    } else {
        return None;
    };
    if !(a > 0.0) {
        return None;
    }
    let s: String = rgb
        .iter()
        .chain([a].iter())
        .map(|&x| {
            let v = js::round(js::min(1.0, js::max(0.0, x)) * 255.0);
            if v.is_nan() { "NaN".into() } else { format!("{:02x}", v as i64) }
        })
        .collect();
    Some(format!("#{}", if s.ends_with("ff") { &s[..6.min(s.len())] } else { &s }))
}

fn oklab(l: f64, a: f64, b: f64) -> [f64; 3] {
    let l_ = (l + 0.3963377774 * a + 0.2158037573 * b).powi(3);
    let m = (l - 0.1055613458 * a - 0.0638541728 * b).powi(3);
    let s = (l - 0.0894841775 * a - 1.291485548 * b).powi(3);
    let lin = [
        4.0767416621 * l_ - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l_ + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l_ - 0.7034186147 * m + 1.707614701 * s,
    ];
    lin.map(|x| if x <= 0.0031308 { 12.92 * x } else { 1.055 * x.powf(1.0 / 2.4) - 0.055 })
}
