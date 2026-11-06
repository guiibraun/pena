// Figma import (figma.mjs `importFigma`), ported from pen.dev (Pen.app 1.2.17): copy/paste from Figma and .fig files.
// A fig-kiwi archive: an 8-byte prelude and a version, then chunks [schema, message], each deflate or zstd.
// The kiwi message's `nodeChanges` form the tree (guid + parentIndex); instances are expanded from their components
// with overrides and variables applied, and each page's layers become plain .pen nodes (no components, like pen.dev).
// A .fig is usually a zip: canvas.fig plus images/<sha1 hash>. Pasted layers come without images.
use crate::js::{self, ftruthy, num, obj, truthy};
use crate::kiwi::{Schema, unhex};
use anyhow::{Result, bail};
use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::f64::consts::PI;
use std::io::Read;
use std::rc::Rc;

// ------------------------------------------------------------------ small helpers (same names as figma.mjs)
pub(crate) fn key(g: &Value) -> String {
    format!("{}:{}", js::string(&g["sessionID"]), js::string(&g["localID"]))
}
fn valid(g: &Value) -> bool {
    !g.is_null() && g["sessionID"].as_f64() != Some(4294967295.0) && g["localID"].as_f64() != Some(4294967295.0)
}
fn same(a: &Value, b: &Value) -> bool {
    !a.is_null() && !b.is_null() && a["sessionID"] == b["sessionID"] && a["localID"] == b["localID"]
}
fn ref_key(r: &Value) -> Option<String> {
    match r["assetRef"]["key"].as_str() {
        Some(k) if !k.is_empty() => Some(k.into()),
        _ if valid(&r["guid"]) => Some(key(&r["guid"])),
        _ => None,
    }
}
fn deg(r: f64) -> f64 {
    r * 180.0 / PI
}
fn div(a: f64, b: f64) -> f64 {
    if b == 0.0 { 0.0 } else { a / b }
}
pub(crate) fn round(v: f64) -> f64 {
    js::round(v * 1000.0) / 1000.0
}
fn angle(rad: f64) -> f64 {
    round(((-deg(rad)) % 360.0 + 360.0) % 360.0) // .pen: degrees CCW, 0 = up
}
fn one(list: Vec<Value>) -> Option<Value> {
    match list.len() {
        0 => None,
        1 => list.into_iter().next(),
        _ => Some(Value::Array(list)),
    }
}
fn f(v: &Value) -> Option<f64> {
    v.as_f64()
}
fn hex_byte(v: f64) -> String {
    let x = js::round(js::min(1.0, js::max(0.0, v)) * 255.0);
    if x.is_nan() { "NaN".into() } else { format!("{:02x}", x as i64) }
}
fn hex(c: &Value, k: f64) -> Option<String> {
    if c.is_null() {
        return None;
    }
    let a = f(&c["a"]).unwrap_or(1.0) * k;
    let n = |k: &str| f(&c[k]).unwrap_or(f64::NAN);
    let s: String = [n("r"), n("g"), n("b"), a].iter().map(|&v| hex_byte(v)).collect();
    Some(format!("#{}", if s.ends_with("ff") { &s[..6] } else { &s }))
}
fn lerp_color(a: &Value, b: &Value, t: f64) -> Value {
    let l = |k: &str| {
        let (x, y) = (f(&a[k]).unwrap_or(f64::NAN), f(&b[k]).unwrap_or(f64::NAN));
        num(x + (y - x) * t)
    };
    obj([("r", l("r")), ("g", l("g")), ("b", l("b")), ("a", l("a"))])
}
fn set(o: &mut Value, k: &str, v: Value) {
    if let Some(m) = o.as_object_mut() {
        m.insert(k.into(), v);
    }
}
fn unset(o: &mut Value, k: &str) {
    if let Some(m) = o.as_object_mut() {
        m.shift_remove(k);
    }
}
fn arr(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], |a| a.as_slice())
}

// 2D affine matrix [a b c d tx ty]; rotate/scale/translate post-multiply (pen.dev's matrix class).
#[derive(Clone, Copy)]
pub(crate) struct M {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub tx: f64,
    pub ty: f64,
}
pub(crate) fn m(a: f64, b: f64, c: f64, d: f64, tx: f64, ty: f64) -> M {
    M { a, b, c, d, tx, ty }
}
fn fig_matrix(t: &Value) -> M {
    let g = |k: &str| f(&t[k]).unwrap_or(f64::NAN);
    m(g("m00"), g("m10"), g("m01"), g("m11"), g("m02"), g("m12"))
}
fn det(m: &M) -> f64 {
    m.a * m.d - m.b * m.c
}
pub(crate) fn invert(x: &M) -> M {
    let k = det(x);
    m(x.d / k, -x.b / k, -x.c / k, x.a / k, (x.c * x.ty - x.d * x.tx) / k, -(x.a * x.ty - x.b * x.tx) / k)
}
fn apply(m: &M, x: f64, y: f64) -> (f64, f64) {
    (m.a * x + m.c * y + m.tx, m.b * x + m.d * y + m.ty)
}
fn rotate(x: &M, r: f64) -> M {
    let (c, s) = (r.cos(), r.sin());
    m(x.a * c - x.b * s, x.a * s + x.b * c, x.c * c - x.d * s, x.c * s + x.d * c, x.tx * c - x.ty * s, x.tx * s + x.ty * c)
}
fn scale(x: &M, sx: f64, sy: f64) -> M {
    m(x.a * sx, x.b * sy, x.c * sx, x.d * sy, x.tx * sx, x.ty * sy)
}
fn matrix_array(x: &M) -> Option<Value> {
    let v: Vec<f64> = [x.a, x.b, x.c, x.d, x.tx, x.ty].iter().map(|v| js::round(v * 1e6) / 1e6).collect();
    if v == [1.0, 0.0, 0.0, 1.0, 0.0, 0.0] { None } else { Some(Value::Array(v.into_iter().map(num).collect())) }
}

pub(crate) const BLEND: [(&str, &str); 17] = [
    ("DARKEN", "darken"), ("MULTIPLY", "multiply"), ("LINEAR_BURN", "linearBurn"), ("COLOR_BURN", "colorBurn"), ("LIGHTEN", "light"),
    ("SCREEN", "screen"), ("LINEAR_DODGE", "linearDodge"), ("COLOR_DODGE", "colorDodge"), ("OVERLAY", "overlay"), ("SOFT_LIGHT", "softLight"),
    ("HARD_LIGHT", "hardLight"), ("DIFFERENCE", "difference"), ("EXCLUSION", "exclusion"), ("HUE", "hue"), ("SATURATION", "saturation"),
    ("COLOR", "color"), ("LUMINOSITY", "luminosity"),
];
fn blend(v: &Value) -> Option<&'static str> {
    let s = v.as_str()?;
    BLEND.iter().find(|(k, _)| *k == s).map(|(_, v)| *v)
}

// ------------------------------------------------------------------ archive
pub(crate) fn decode_archive(buf: &[u8]) -> Result<Value> {
    let prelude = buf.get(..8).unwrap_or(buf);
    if prelude != b"fig-kiwi" && prelude != b"fig-jam." {
        bail!("Não é um arquivo do Figma");
    }
    let mut chunks = Vec::new();
    let mut o = 12usize;
    while o + 4 < buf.len() {
        let n = u32::from_le_bytes(buf[o..o + 4].try_into().unwrap()) as usize;
        chunks.push(&buf[o + 4..(o + 4).saturating_add(n).min(buf.len())]);
        o = o.saturating_add(4 + n);
    }
    let (Some(schema), Some(message)) = (chunks.first(), chunks.get(1)) else { bail!("Arquivo do Figma incompleto") };
    let schema = Schema::decode(&unpack(schema)?)?;
    schema.decode_message(&unpack(message)?)
}

// Each chunk is raw deflate or zstd (newer files).
fn unpack(b: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    if b.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        ruzstd::decoding::StreamingDecoder::new(b).map_err(|e| anyhow::anyhow!("{e}"))?.read_to_end(&mut out)?;
    } else {
        flate2::read::DeflateDecoder::new(b).read_to_end(&mut out)?;
    }
    Ok(out)
}

fn image_ext(b: &[u8]) -> &'static str {
    const SIG: [(&[u8], &str); 4] = [(&[0x89, 0x50, 0x4e, 0x47], "png"), (&[0xff, 0xd8, 0xff], "jpg"), (&[0x47, 0x49, 0x46], "gif"), (&[0x52, 0x49, 0x46, 0x46], "webp")];
    SIG.iter().find(|(s, _)| b.starts_with(s)).map_or("png", |(_, e)| e)
}

/// bytes: a .fig file (zip or bare) or the clipboard buffer. save_image(name, bytes) stores an image and returns its url.
/// Returns { pages: [{ name, nodes }], faces } with the .pen nodes of every page (top-level x/y in page coordinates).
pub fn import_figma(bytes: &[u8], save_image: &mut dyn FnMut(&str, &[u8]) -> String) -> Result<Value> {
    let mut zip = None;
    let canvas_buf;
    let canvas: &[u8] = if bytes.starts_with(b"PK") {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
        let mut c = Vec::new();
        z.by_name("canvas.fig").map_err(|_| anyhow::anyhow!("canvas.fig não encontrado no .fig"))?.read_to_end(&mut c)?;
        canvas_buf = c;
        zip = Some(z);
        &canvas_buf
    } else {
        bytes
    };
    // images are read from the zip on demand, once per hash
    let mut saved: HashMap<String, Option<String>> = HashMap::new();
    let mut image = |hash: &str| -> Option<String> {
        if !saved.contains_key(hash) {
            let b = zip.as_mut().and_then(|z| {
                let mut e = z.by_name(&format!("images/{hash}")).ok()?;
                let mut b = Vec::new();
                e.read_to_end(&mut b).ok()?;
                Some(b)
            });
            saved.insert(hash.into(), b.map(|b| save_image(&format!("{hash}.{}", image_ext(&b)), &b)));
        }
        saved[hash].clone()
    };

    let mut msg = decode_archive(canvas)?;
    let changes = match msg.get_mut("nodeChanges").map(Value::take) {
        Some(Value::Array(a)) => a,
        _ => vec![],
    };
    let blobs: Vec<Vec<u8>> = arr(&msg["blobs"]).iter().map(|b| b["bytes"].as_str().map(unhex).unwrap_or_default()).collect();
    drop(msg);

    let mut c = Converter { arena: vec![], nodes: HashMap::new(), blobs, variables: HashMap::new(), default_modes: HashMap::new(), styles: HashMap::new(), faces: IndexSet::new() };
    for p in &changes {
        if p["type"] != "VARIABLE_SET" || !truthy(&p["variableSetModes"][0]["id"]) {
            continue;
        }
        let mode = key(&p["variableSetModes"][0]["id"]);
        let gk = (!p["guid"].is_null()).then(|| key(&p["guid"]));
        let ks = [ref_key(&p["variableSetID"]).or(gk.clone()), gk, p["variableSetID"]["assetRef"]["key"].as_str().map(Into::into), p["key"].as_str().map(Into::into)];
        for k in ks.into_iter().flatten().filter(|k| !k.is_empty()) {
            c.default_modes.insert(k, mode.clone());
        }
    }
    for p in &changes {
        let k = p["key"].as_str().filter(|k| !k.is_empty()).map(String::from).or_else(|| (!p["guid"].is_null()).then(|| key(&p["guid"])));
        if let Some(k) = k
            && p["type"] == "VARIABLE"
            && truthy(&p["variableDataValues"]["entries"])
            && !c.variables.contains_key(&k)
        {
            c.variables.insert(k, Var { set_id: ref_key(&p["variableSetID"]), entries: arr(&p["variableDataValues"]["entries"]).to_vec() });
        }
    }
    // a later change with the same guid replaces the earlier one (Map.set keeps the first position)
    let mut by_key: IndexMap<String, Value> = IndexMap::new();
    for p in changes {
        if !p["guid"].is_null() {
            by_key.insert(key(&p["guid"]), p);
        }
    }
    for (k, props) in by_key {
        c.nodes.insert(k, c.arena.len());
        c.arena.push(Node { props, children: None, parent: None });
    }
    for i in 0..c.arena.len() {
        let pi = &c.arena[i].props["parentIndex"];
        if !truthy(pi) {
            continue;
        }
        if let Some(&parent) = c.nodes.get(&key(&pi["guid"])) {
            c.arena[parent].children.get_or_insert_with(Vec::new).push(i);
            c.arena[i].parent = Some(parent);
        }
    }
    // topmost first (descending position); the converter walks them backwards so .pen children paint bottom → top
    for i in 0..c.arena.len() {
        if let Some(mut kids) = c.arena[i].children.take() {
            kids.sort_by(|&a, &b| c.arena[b].props["parentIndex"]["position"].as_str().cmp(&c.arena[a].props["parentIndex"]["position"].as_str()));
            c.arena[i].children = Some(kids);
        }
    }
    let root = c.nodes.get("0:0").copied();
    let Some(root_kids) = root.and_then(|r| c.arena[r].children.clone()) else { return Ok(json!({ "pages": [] })) };
    for (i, n) in c.arena.iter().enumerate() {
        if let Some(k) = n.props["key"].as_str().filter(|k| !k.is_empty()) {
            c.styles.insert(k.into(), i);
        }
        if !n.props["guid"].is_null() {
            c.styles.insert(key(&n.props["guid"]), i);
        }
    }
    let mut pages = Vec::new();
    for &p in root_kids.iter().rev() {
        if !truthy(&c.arena[p].props["visible"]) {
            continue;
        }
        let name = c.arena[p].props.get("name").filter(|v| !v.is_null()).cloned().unwrap_or("Página".into());
        let kids = c.arena[p].children.clone().unwrap_or_default();
        let nodes: Vec<Value> = kids.iter().rev().filter_map(|&k| c.convert(k, 0, &mut image)).collect();
        pages.push(json!({ "name": name, "nodes": nodes }));
    }
    // faces the text uses ({ family, weight, italic }): the caller can ship fonts Google doesn't serve as Figma has them
    let faces: Vec<Value> = c
        .faces
        .iter()
        .map(|k| {
            let parts: Vec<&str> = k.split('|').collect();
            json!({ "family": parts[0], "weight": num(js::to_number(parts.get(1).unwrap_or(&""))), "italic": parts.get(2) == Some(&"1") })
        })
        .collect();
    let mut out = json!({ "pages": pages, "faces": faces });
    js::normalize(&mut out);
    Ok(out)
}

// ------------------------------------------------------------------ paints, effects, strokes
type Img<'a> = dyn FnMut(&str) -> Option<String> + 'a;

fn paints(list: &Value, size: &Value, image: &mut Img) -> Option<Vec<Value>> {
    let mut out = Vec::new();
    for p in arr(list) {
        let enabled = p["visible"] == true;
        let bm = blend(&p["blendMode"]);
        let mut extra = Map::new();
        if !enabled {
            extra.insert("enabled".into(), false.into());
        }
        if let Some(b) = bm {
            extra.insert("blendMode".into(), b.into());
        }
        match p["type"].as_str().unwrap_or("") {
            "SOLID" => {
                if let Some(color) = hex(&p["color"], f(&p["opacity"]).unwrap_or(1.0)) {
                    if enabled && bm.is_none() {
                        out.push(color.into());
                    } else {
                        let mut o = Map::new();
                        o.insert("type".into(), "color".into());
                        o.insert("color".into(), color.into());
                        o.extend(extra);
                        out.push(Value::Object(o));
                    }
                }
            }
            "IMAGE" => {
                let hash = p["image"]["hash"].as_str().filter(|h| !h.is_empty());
                let mut fo = Map::new();
                fo.insert("type".into(), "image".into());
                if let Some(url) = hash.and_then(|h| image(h)) {
                    fo.insert("url".into(), url.into());
                }
                let fit = p["imageScaleMode"] == "FIT";
                fo.insert("mode".into(), if fit { "contain" } else { "cover" }.into());
                fo.extend(extra);
                if let Some(o) = f(&p["opacity"])
                    && ftruthy(o)
                    && o != 1.0
                {
                    fo.insert("opacity".into(), num(o));
                }
                let mut mode = if fit { "contain" } else { "cover" };
                if p["imageScaleMode"] == "STRETCH" {
                    mode = "stretch";
                    fo.insert("mode".into(), "stretch".into());
                    if truthy(&p["transform"]) && !size.is_null() {
                        let mm = fig_matrix(&p["transform"]);
                        if det(&mm) != 0.0
                            && let Some(t) = matrix_array(&invert(&mm))
                        {
                            fo.insert("transform".into(), t);
                        }
                    }
                }
                // rotated cover/contain images: bake the fit and the rotation into a stretch transform
                let r = f(&p["rotation"]).unwrap_or(0.0);
                let (w, h) = (f(&p["originalImageWidth"]).unwrap_or(0.0), f(&p["originalImageHeight"]).unwrap_or(0.0));
                if r != 0.0 && !size.is_null() && ftruthy(w) && ftruthy(h) && mode != "stretch" {
                    let (sx, sy) = (f(&size["x"]).unwrap_or(f64::NAN), f(&size["y"]).unwrap_or(f64::NAN));
                    let (u, v) = if js::round(r / 90.0) % 2.0 != 0.0 { (h, w) } else { (w, h) };
                    let (p1, p2) = (div(sx, u), div(sy, v));
                    let k = if mode == "cover" { js::max(p1, p2) } else { js::min(p1, p2) };
                    let mut mm = scale(&rotate(&m(w, 0.0, 0.0, h, -w / 2.0, -h / 2.0), (-r * PI) / 180.0), k, k);
                    mm.tx += sx / 2.0;
                    mm.ty += sy / 2.0;
                    let mm = scale(&mm, div(1.0, sx), div(1.0, sy));
                    fo.insert("mode".into(), "stretch".into());
                    if let Some(t) = matrix_array(&mm) {
                        fo.insert("transform".into(), t);
                    }
                }
                // Figma's image adjustments (Pena's `adjust`, -1..1 each; pen.dev has none). Its "saturation" is `vibrance`.
                let mut adjust = Map::new();
                for k in ["exposure", "contrast", "vibrance", "temperature", "tint", "highlights", "shadows"] {
                    let v = round(f(&p["paintFilter"][k]).unwrap_or(0.0));
                    if ftruthy(v) {
                        adjust.insert(if k == "vibrance" { "saturation" } else { k }.into(), num(v));
                    }
                }
                if !adjust.is_empty() {
                    fo.insert("adjust".into(), Value::Object(adjust));
                }
                out.push(Value::Object(fo));
            }
            t @ ("GRADIENT_LINEAR" | "GRADIENT_RADIAL" | "GRADIENT_ANGULAR") => {
                if !truthy(&p["transform"]) || !truthy(&p["stops"]) {
                    continue;
                }
                let black = json!({ "r": 0, "g": 0, "b": 0, "a": 1 });
                let mut stops: Vec<(f64, Value)> = arr(&p["stops"])
                    .iter()
                    .map(|s| (f(&s["position"]).unwrap_or(f64::NAN), if s["color"].is_null() { black.clone() } else { s["color"].clone() }))
                    .collect();
                let mm = invert(&fig_matrix(&p["transform"]));
                let c = apply(&mm, if t == "GRADIENT_LINEAR" { 0.0 } else { 0.5 }, 0.5);
                let x1 = apply(&mm, 1.0, 0.5);
                let mut g = Map::new();
                g.insert("type".into(), "gradient".into());
                g.insert("gradientType".into(), t[9..].to_lowercase().into());
                g.extend(extra);
                if let Some(o) = f(&p["opacity"])
                    && o != 1.0
                {
                    g.insert("opacity".into(), num(o));
                }
                let (center, size);
                if t == "GRADIENT_LINEAR" {
                    let y1 = apply(&mm, 0.0, 1.0);
                    let (mut gx, mut gy) = (y1.0 - c.0, y1.1 - c.1);
                    let len = gx.hypot(gy);
                    if len != 0.0 {
                        gx /= len;
                        gy /= len;
                    }
                    let mut l = -gy * (x1.0 - c.0) + gx * (x1.1 - c.1);
                    let mut a = gx.atan2(-gy) + PI / 2.0;
                    if l < 0.0 {
                        l = -l;
                        a += PI;
                    }
                    g.insert("rotation".into(), num(angle(a)));
                    center = ((c.0 + x1.0) / 2.0, (c.1 + x1.1) / 2.0);
                    size = obj([("height", num(l))]);
                } else if t == "GRADIENT_RADIAL" {
                    let y1 = apply(&mm, 0.5, 1.0);
                    let v = [x1.0 - c.0, y1.0 - c.0, x1.1 - c.1, y1.1 - c.1];
                    let (a, b, cc) = (v[0] * v[0] + v[1] * v[1], v[0] * v[2] + v[1] * v[3], v[2] * v[2] + v[3] * v[3]);
                    let s = a + cc;
                    let root = (s * s - 4.0 * (a * cc - b * b)).sqrt();
                    let (big, small) = ((s + root) / 2.0, (s - root) / 2.0);
                    g.insert("rotation".into(), num(angle((big - a).atan2(b) + PI / 2.0)));
                    center = c;
                    size = obj([("width", num(small.sqrt() * 2.0)), ("height", num(big.sqrt() * 2.0))]);
                } else {
                    let y1 = apply(&mm, 0.5, 1.0);
                    let dir = if (y1.0 - c.0) * (x1.1 - c.1) - (y1.1 - c.1) * (x1.0 - c.0) > 0.0 { -1.0 } else { 1.0 };
                    g.insert("rotation".into(), num(angle((x1.1 - c.1).atan2(x1.0 - c.0) + PI / 2.0)));
                    center = c;
                    size = obj([("width", num(dir * (y1.0 - c.0).hypot(y1.1 - c.1) * 2.0)), ("height", num((x1.0 - c.0).hypot(x1.1 - c.1) * 2.0))]);
                    if stops.len() >= 2 {
                        // close the loop: the color where the last stop wraps around to the first
                        stops.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
                        let (first, last) = (stops[0].clone(), stops[stops.len() - 1].clone());
                        if first.0 != 0.0 || last.0 != 1.0 {
                            let color = lerp_color(&first.1, &last.1, div(first.0, first.0 + (1.0 - last.0)));
                            if first.0 != 0.0 {
                                stops.insert(0, (0.0, color.clone()));
                            }
                            if last.0 != 1.0 {
                                stops.push((1.0, color));
                            }
                        }
                    }
                }
                g.insert("size".into(), size);
                g.insert("colors".into(), stops.iter().map(|(pos, c)| json!({ "color": hex(c, 1.0), "position": num(*pos) })).collect());
                if center.0 != 0.5 || center.1 != 0.5 {
                    let mut cm = Map::new();
                    if center.0 != 0.5 {
                        cm.insert("x".into(), num(center.0));
                    }
                    if center.1 != 0.5 {
                        cm.insert("y".into(), num(center.1));
                    }
                    g.insert("center".into(), Value::Object(cm));
                }
                out.push(Value::Object(g));
            }
            // GRADIENT_DIAMOND, EMOJI, VIDEO, PATTERN, NOISE: not supported (pen.dev skips them too)
            _ => {}
        }
    }
    (!out.is_empty()).then_some(out)
}

fn effects(list: &Value) -> Option<Value> {
    let mut out = Vec::new();
    for e in arr(list) {
        let radius = f(&e["radius"]).unwrap_or(0.0) * 0.875;
        let off = e["visible"] != true;
        let ty = e["type"].as_str().unwrap_or("");
        let mut o = Map::new();
        match ty {
            "FOREGROUND_BLUR" | "BACKGROUND_BLUR" => {
                o.insert("type".into(), if ty == "FOREGROUND_BLUR" { "blur" } else { "background_blur" }.into());
                o.insert("radius".into(), num(radius));
                if off {
                    o.insert("enabled".into(), false.into());
                }
            }
            "DROP_SHADOW" | "INNER_SHADOW" => {
                o.insert("type".into(), "shadow".into());
                o.insert("shadowType".into(), if ty == "DROP_SHADOW" { "outer" } else { "inner" }.into());
                if off {
                    o.insert("enabled".into(), false.into());
                }
                let black = json!({ "r": 0, "g": 0, "b": 0, "a": 0 });
                o.insert("color".into(), hex(if e["color"].is_null() { &black } else { &e["color"] }, 1.0).into());
                let (ox, oy) = (&e["offset"]["x"], &e["offset"]["y"]);
                if truthy(ox) || truthy(oy) {
                    o.insert("offset".into(), obj([("x", num(f(ox).unwrap_or(0.0))), ("y", num(f(oy).unwrap_or(0.0)))]));
                }
                if ftruthy(radius) {
                    o.insert("blur".into(), num(radius));
                }
                if let Some(b) = blend(&e["blendMode"]) {
                    o.insert("blendMode".into(), b.into());
                }
            }
            _ => continue,
        }
        out.push(Value::Object(o));
    }
    one(out)
}

fn stroke(out: &mut Map<String, Value>, p: &Value, image: &mut Img) {
    let Some(fills) = paints(&p["strokePaints"], &p["size"], image) else { return };
    out.insert("stroke".into(), one(fills).unwrap());
    let w: Option<[f64; 4]> = if truthy(&p["borderStrokeWeightsIndependent"]) {
        let g = |k: &str| f(&p[k]).unwrap_or(0.0);
        Some([g("borderTopWeight"), g("borderRightWeight"), g("borderBottomWeight"), g("borderLeftWeight")])
    } else if truthy(&p["strokeWeight"]) {
        Some([f(&p["strokeWeight"]).unwrap_or(f64::NAN); 4])
    } else {
        None
    };
    if let Some(w) = w {
        if w.iter().all(|&v| v == w[0]) {
            if ftruthy(w[0]) {
                out.insert("strokeWidth".into(), num(w[0]));
            }
        } else {
            let mut o = Map::new();
            for (k, v) in ["top", "right", "bottom", "left"].iter().zip(w) {
                if ftruthy(v) {
                    o.insert((*k).into(), num(v));
                }
            }
            out.insert("strokeWidth".into(), Value::Object(o));
        }
    }
    let align = match p["strokeAlign"].as_str() {
        Some("INSIDE") => Some("inner"),
        Some("OUTSIDE") => Some("outer"),
        _ => None,
    };
    let join = match p["strokeJoin"].as_str() {
        Some("BEVEL") => Some("bevel"),
        Some("ROUND") => Some("round"),
        _ => None,
    };
    let cap = match p["strokeCap"].as_str() {
        Some("ROUND") => Some("round"),
        Some("SQUARE") => Some("square"),
        _ => None,
    };
    for (k, v) in [("strokeAlignment", align), ("strokeLinejoin", join), ("strokeLinecap", cap)] {
        if let Some(v) = v {
            out.insert(k.into(), v.into());
        }
    }
}

fn radius(p: &Value) -> Option<Value> {
    let g = |k: &str| f(&p[k]).unwrap_or(0.0);
    let r = [g("rectangleTopLeftCornerRadius"), g("rectangleTopRightCornerRadius"), g("rectangleBottomRightCornerRadius"), g("rectangleBottomLeftCornerRadius")];
    let v = if r.iter().any(|&x| ftruthy(x)) {
        r
    } else if !p["cornerRadius"].is_null() {
        [f(&p["cornerRadius"]).unwrap_or(f64::NAN); 4]
    } else {
        return None;
    };
    if v.iter().all(|&x| x == 0.0) {
        return None;
    }
    Some(if v.iter().all(|&x| x == v[0]) { num(v[0]) } else { v.iter().map(|&x| num(x)).collect() })
}

// Auto layout sizing of a node along an axis ('H'/'V'): fill, fit or fixed.
fn axis(mode: &Value) -> Option<char> {
    match mode.as_str() {
        Some("VERTICAL") => Some('V'),
        Some("HORIZONTAL") => Some('H'),
        _ => None,
    }
}
fn size_value(kind: &str, value: f64, dflt: &str) -> Option<Value> {
    if kind == "fixed" {
        Some(num(round(value)))
    } else if kind == dflt {
        None
    } else if kind == "fill" {
        Some("fill_container".into())
    } else {
        Some("fit_content".into())
    }
}

fn letter_case(s: &str, c: &Value) -> String {
    match c.as_str() {
        Some("UPPER") => s.to_uppercase(),
        Some("LOWER") => s.to_lowercase(),
        Some("TITLE") => {
            let mut out = String::with_capacity(s.len());
            let mut start = true;
            for ch in s.chars() {
                if start && !js_space(ch) {
                    out.extend(ch.to_uppercase());
                } else {
                    out.push(ch);
                }
                start = js_space(ch);
            }
            out
        }
        _ => s.into(),
    }
}
pub(crate) fn js_space(c: char) -> bool {
    c.is_whitespace() || c == '\u{feff}'
}

const WEIGHTS: [(&str, Option<&str>); 16] = [
    ("Hairline", Some("100")), ("Thin", Some("100")), ("ExtraLight", Some("200")), ("Heavy", Some("800")), ("Extra Light", Some("200")), ("Light", Some("300")),
    ("Regular", None), ("SemiBold", Some("600")), ("Semi Bold", Some("600")), ("ExtraBold", Some("800")), ("Extra Bold", Some("800")),
    ("ExtraBlack", Some("950")), ("Extra Black", Some("950")), ("Black", Some("900")), ("Bold", Some("700")), ("Medium", Some("500")),
];

// .pen text style of a TEXT layer's (style-resolved) props; `fill` is the text color.
fn text_style(p: &Value, image: &mut Img) -> Map<String, Value> {
    let mut out = Map::new();
    let fs = f(&p["fontSize"]).unwrap_or(1.0);
    if let Some(fill) = paints(&p["fillPaints"], &p["size"], image).and_then(one) {
        out.insert("fill".into(), fill);
    }
    if !p["fontName"]["family"].is_null() {
        out.insert("fontFamily".into(), p["fontName"]["family"].clone());
        let style = p["fontName"]["style"].as_str().unwrap_or("");
        if let Some((_, Some(w))) = WEIGHTS.iter().find(|(w, _)| style.contains(w)) {
            out.insert("fontWeight".into(), (*w).into());
        }
        if style.contains("Italic") {
            out.insert("fontStyle".into(), "italic".into());
        }
    }
    if !p["fontSize"].is_null() {
        out.insert("fontSize".into(), p["fontSize"].clone());
    }
    let lh = &p["lineHeight"];
    let lv = f(&lh["value"]).unwrap_or(f64::NAN);
    if lh["units"] == "RAW" {
        out.insert("lineHeight".into(), num(round(lv)));
    } else if lh["units"] == "PIXELS" {
        out.insert("lineHeight".into(), num(round(lv / fs)));
    }
    let ls = &p["letterSpacing"];
    let ls = if ls["units"] == "PERCENT" { (f(&ls["value"]).unwrap_or(0.0) / 100.0) * fs } else { f(&ls["value"]).unwrap_or(0.0) };
    if ftruthy(ls) {
        out.insert("letterSpacing".into(), num(round(ls)));
    }
    if p["textDecoration"] == "UNDERLINE" {
        out.insert("underline".into(), true.into());
    }
    if p["textDecoration"] == "STRIKETHROUGH" {
        out.insert("strikethrough".into(), true.into());
    }
    out
}

// Vector network blob: vertices, segments (cubic handles) and regions (loops of segment indices with a winding rule).
#[derive(Clone, Copy)]
struct End {
    vertex: u32,
    dx: f32,
    dy: f32,
}
#[derive(Clone, Copy)]
struct Seg {
    start: End,
    end: End,
}
struct Network {
    vertices: Vec<(f32, f32)>,
    segments: Vec<Seg>,
    regions: Vec<(bool, Vec<Vec<u32>>)>, // (odd winding, loops)
}
fn parse_network(b: &[u8]) -> Option<Network> {
    let u = |o: usize| b.get(o..o + 4).map(|x| u32::from_le_bytes(x.try_into().unwrap()));
    let fl = |o: usize| f32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    if b.len() < 12 {
        return None;
    }
    let (nv, ns, nr) = (u(0)?, u(4)?, u(8)?);
    let mut o = 12;
    let (mut vertices, mut segments, mut regions) = (vec![], vec![], vec![]);
    for _ in 0..nv {
        if o + 12 > b.len() {
            return None;
        }
        vertices.push((fl(o + 4), fl(o + 8)));
        o += 12;
    }
    for _ in 0..ns {
        if o + 28 > b.len() {
            return None;
        }
        let (s, e) = (u(o + 4)?, u(o + 16)?);
        if s >= nv || e >= nv {
            return None;
        }
        segments.push(Seg { start: End { vertex: s, dx: fl(o + 8), dy: fl(o + 12) }, end: End { vertex: e, dx: fl(o + 20), dy: fl(o + 24) } });
        o += 28;
    }
    for _ in 0..nr {
        if o + 8 > b.len() {
            return None;
        }
        let odd = u(o)? & 1 == 0;
        let nl = u(o + 4)?;
        let mut loops = vec![];
        o += 8;
        for _ in 0..nl {
            if o + 4 > b.len() {
                return None;
            }
            let n = u(o)? as usize;
            o += 4;
            if o + n * 4 > b.len() {
                return None;
            }
            let mut segs = vec![];
            for _ in 0..n {
                let s = u(o)?;
                if s >= ns {
                    return None;
                }
                segs.push(s);
                o += 4;
            }
            loops.push(segs);
        }
        regions.push((odd, loops));
    }
    Some(Network { vertices, segments, regions })
}

// Chain segments head to tail (flip the ones stored backwards), then draw them as SVG path data.
fn chain(mut s: Vec<Seg>) -> Vec<Seg> {
    if s.len() < 2 {
        return s;
    }
    let flip = |x: &mut Seg| std::mem::swap(&mut x.start, &mut x.end);
    if s[0].end.vertex != s[1].start.vertex && s[0].end.vertex != s[1].end.vertex {
        flip(&mut s[0]);
    }
    for i in 1..s.len() {
        if s[i - 1].end.vertex != s[i].start.vertex {
            flip(&mut s[i]);
        }
    }
    s
}
fn draw(vertices: &[(f32, f32)], segs: &[Seg]) -> String {
    let mut d = String::new();
    let (mut first, mut last): (Option<u32>, Option<u32>) = (None, None);
    let pt = |x: f64, y: f64| format!("{} {}", js::fmt(round(x)), js::fmt(round(y)));
    for s in segs {
        let a = vertices[s.start.vertex as usize];
        let b = vertices[s.end.vertex as usize];
        let (ax, ay, bx, by) = (a.0 as f64, a.1 as f64, b.0 as f64, b.1 as f64);
        if last != Some(s.start.vertex) {
            d += &format!("M{}", pt(ax, ay));
            first = Some(s.start.vertex);
        }
        if s.start.dx == 0.0 && s.start.dy == 0.0 && s.end.dx == 0.0 && s.end.dy == 0.0 {
            d += &format!("L{}", pt(bx, by));
        } else {
            d += &format!(
                "C{} {} {}",
                pt(ax + s.start.dx as f64, ay + s.start.dy as f64),
                pt(bx + s.end.dx as f64, by + s.end.dy as f64),
                pt(bx, by)
            );
        }
        last = Some(s.end.vertex);
        if first.is_some() && last == first {
            d += "Z";
            first = None;
            last = None;
        }
    }
    d
}
// Figma's own computed outline (`fillGeometry`, booleans already applied): commands in the layer's box.
fn commands_path(b: &[u8]) -> Option<String> {
    let mut d = String::new();
    let mut o = 0;
    while o < b.len() {
        let c = b[o] as usize;
        o += 1;
        let n = *[0usize, 2, 2, 4, 6].get(c)?;
        if o + n * 4 > b.len() {
            return None;
        }
        d.push(b"ZMLQC"[c] as char);
        let nums: Vec<String> = (0..n).map(|i| js::fmt(round(f32::from_le_bytes(b[o + i * 4..o + i * 4 + 4].try_into().unwrap()) as f64))).collect();
        d += &nums.join(" ");
        o += n * 4;
    }
    Some(d)
}

// Variable fields that bind a float to one or more node properties.
const CORNERS: [&str; 4] = ["rectangleTopLeftCornerRadius", "rectangleTopRightCornerRadius", "rectangleBottomLeftCornerRadius", "rectangleBottomRightCornerRadius"];
fn float_fields(field: &str) -> Option<Vec<&'static str>> {
    Some(match field {
        "OPACITY" => vec!["opacity"],
        "CORNER_RADIUS" => vec!["cornerRadius", CORNERS[0], CORNERS[1], CORNERS[2], CORNERS[3]],
        "RECTANGLE_TOP_LEFT_CORNER_RADIUS" => vec![CORNERS[0]],
        "RECTANGLE_TOP_RIGHT_CORNER_RADIUS" => vec![CORNERS[1]],
        "RECTANGLE_BOTTOM_LEFT_CORNER_RADIUS" => vec![CORNERS[2]],
        "RECTANGLE_BOTTOM_RIGHT_CORNER_RADIUS" => vec![CORNERS[3]],
        "STROKE_WEIGHT" => vec!["strokeWeight"],
        "STACK_SPACING" => vec!["stackSpacing"],
        "STACK_PADDING_LEFT" => vec!["stackHorizontalPadding"],
        "STACK_PADDING_TOP" => vec!["stackVerticalPadding"],
        "STACK_PADDING_RIGHT" => vec!["stackPaddingRight"],
        "STACK_PADDING_BOTTOM" => vec!["stackPaddingBottom"],
        "BORDER_TOP_WEIGHT" => vec!["borderTopWeight"],
        "BORDER_BOTTOM_WEIGHT" => vec!["borderBottomWeight"],
        "BORDER_LEFT_WEIGHT" => vec!["borderLeftWeight"],
        "BORDER_RIGHT_WEIGHT" => vec!["borderRightWeight"],
        "STACK_COUNTER_SPACING" => vec!["stackCounterSpacing"],
        "FONT_SIZE" => vec!["fontSize"],
        _ => return None,
    })
}
fn keep_color_vars(now: &mut Value, before: &Value) {
    let Some(now) = now.as_array_mut() else { return };
    for (i, p) in now.iter_mut().enumerate() {
        if !truthy(&p["colorVar"]) && truthy(&before[i]["colorVar"]) {
            set(p, "colorVar", before[i]["colorVar"].clone());
        }
    }
}
type Overrides = Vec<Rc<Value>>;
fn split_overrides(list: &[Rc<Value>], guid: &Value) -> (Overrides, Overrides) {
    let (mut own, mut deeper) = (vec![], vec![]);
    for o in list {
        let g = arr(&o["guidPath"]["guids"]);
        if g.is_empty() || !same(&g[0], guid) {
            continue;
        }
        if g.len() > 1 {
            let mut d = (**o).clone();
            set(&mut d, "guidPath", json!({ "guids": g[1..].to_vec() }));
            deeper.push(Rc::new(d));
        } else {
            own.push(o.clone());
        }
    }
    (own, deeper)
}

// ------------------------------------------------------------------ nodes
struct Node {
    props: Value,
    children: Option<Vec<usize>>,
    parent: Option<usize>,
}
struct Var {
    set_id: Option<String>,
    entries: Vec<Value>,
}
// Nodes live in an arena (parents and children by index). The originals come first; convert() pushes its working
// copies (and instance expansions) after them and truncates on return, as nothing outlives the call.
struct Converter {
    arena: Vec<Node>,
    nodes: HashMap<String, usize>,
    blobs: Vec<Vec<u8>>,
    variables: HashMap<String, Var>,
    default_modes: HashMap<String, String>,
    styles: HashMap<String, usize>,
    faces: IndexSet<String>,
}

// Aliases and prop refs can point at each other; JS would overflow its stack, we give up instead.
const MAX_HOPS: usize = 64;
// Components nested in themselves (or cyclic parent links) would recurse forever.
const MAX_DEPTH: usize = 512;

impl Converter {
    fn face(&mut self, st: &Map<String, Value>) {
        if let Some(fam) = st.get("fontFamily").filter(|v| truthy(v)) {
            let w = st.get("fontWeight").map_or(f64::NAN, js::number);
            let w = if ftruthy(w) { w } else { 400.0 };
            let italic = st.get("fontStyle").is_some_and(|v| v == "italic");
            self.faces.insert(format!("{}|{}|{}", js::string(fam), js::fmt(w), italic as u8));
        }
    }

    fn style(&self, r: &Value) -> Option<&Value> {
        ref_key(r).and_then(|k| self.styles.get(&k)).map(|&i| &self.arena[i].props)
    }
    // applyStyles as a list of assignments, so it can run against props that live in the arena
    fn style_patch(&self, p: &Value, node: Option<usize>) -> Vec<(&'static str, Value)> {
        let mut out = vec![];
        if let Some(s) = self.style(&p["styleIdForFill"])
            && s.get("fillPaints").is_some()
        {
            out.push(("fillPaints", self.resolve_paints(&s["fillPaints"], node)));
        }
        if let Some(s) = self.style(&p["styleIdForStrokeFill"])
            && s.get("fillPaints").is_some()
        {
            out.push(("strokePaints", self.resolve_paints(&s["fillPaints"], node)));
        }
        if let Some(s) = self.style(&p["styleIdForEffect"])
            && let Some(e) = s.get("effects")
        {
            out.push(("effects", e.clone()));
        }
        if let Some(t) = self.style(&p["styleIdForText"]) {
            for k in ["fontName", "textCase", "fontSize", "textDecoration", "letterSpacing", "lineHeight", "paragraphSpacing"] {
                if let Some(v) = t.get(k) {
                    out.push((k, v.clone()));
                }
            }
        }
        out
    }
    fn apply_styles_to(&mut self, n: usize) {
        for (k, v) in self.style_patch(&self.arena[n].props, Some(n)) {
            set(&mut self.arena[n].props, k, v);
        }
    }

    // Overrides travel down the instance tree by guid path; each node takes the ones addressed to it.
    fn apply_overrides(&mut self, n: usize, overrides: &[Rc<Value>], derived: &[Rc<Value>]) {
        let props = &self.arena[n].props;
        let id = if truthy(&props["overrideKey"]) { props["overrideKey"].clone() } else { props["guid"].clone() };
        let (own, deeper) = split_overrides(overrides, &id);
        let (own_derived, deeper_derived) = split_overrides(derived, &id);
        let mut name = None;
        if self.arena[n].props["type"] == "INSTANCE"
            && let Some(swap) = own.iter().find(|o| valid(&o["overriddenSymbolID"]))
        {
            name = Some(self.arena[n].props["name"].clone());
            let id = swap["overriddenSymbolID"].clone();
            self.replace_instance_props(n, &id);
        }
        for o in &own {
            let mut o = (**o).clone();
            for (k, v) in self.style_patch(&o, Some(n)) {
                set(&mut o, k, v);
            }
            let p = &self.arena[n].props;
            let (assigned, fill_paints, stroke_paints) = (p["componentPropAssignments"].clone(), p["fillPaints"].clone(), p["strokePaints"].clone());
            let (style_fill, style_stroke, modes) = (p["styleIdForFill"].clone(), p["styleIdForStrokeFill"].clone(), p["variableModeBySetMap"].clone());
            let p = &mut self.arena[n].props;
            if let (Some(pm), Some(om)) = (p.as_object_mut(), o.as_object()) {
                for (k, v) in om {
                    pm.insert(k.clone(), v.clone());
                }
            }
            if truthy(&modes) && !truthy(&p["variableModeBySetMap"]) {
                set(p, "variableModeBySetMap", modes);
            }
            if truthy(&o["componentPropAssignments"])
                && truthy(&assigned)
                && let Some(list) = p.get_mut("componentPropAssignments").and_then(Value::as_array_mut)
            {
                for w in arr(&assigned) {
                    if !list.iter().any(|k| same(&k["defID"], &w["defID"])) {
                        list.push(w.clone());
                    }
                }
            }
            unset(p, "guidPath");
            if let Some(fp) = p.get_mut("fillPaints") {
                keep_color_vars(fp, &fill_paints);
            }
            if let Some(sp) = p.get_mut("strokePaints") {
                keep_color_vars(sp, &stroke_paints);
            }
            if truthy(&o["fillPaints"])
                && let Some(s) = self.style(&style_fill)
                && truthy(&s["fillPaints"])
            {
                let v = self.resolve_paints(&s["fillPaints"], Some(n));
                set(&mut self.arena[n].props, "fillPaints", v);
            }
            if truthy(&o["strokePaints"])
                && let Some(s) = self.style(&style_stroke)
                && truthy(&s["fillPaints"])
            {
                let v = self.resolve_paints(&s["fillPaints"], Some(n));
                set(&mut self.arena[n].props, "strokePaints", v);
            }
            for k in ["fillPaints", "strokePaints"] {
                if truthy(&self.arena[n].props[k]) {
                    let v = self.resolve_paints(&self.arena[n].props[k], Some(n));
                    set(&mut self.arena[n].props, k, v);
                }
            }
            if valid(&o["overriddenSymbolID"]) {
                let p = &mut self.arena[n].props;
                if p["symbolData"].is_null() {
                    set(p, "symbolData", json!({}));
                }
                set(&mut p["symbolData"], "symbolID", o["overriddenSymbolID"].clone());
            }
            let entries = if truthy(&o["variableConsumptionMap"]["entries"]) { &o["variableConsumptionMap"]["entries"] } else { &o["parameterConsumptionMap"]["entries"] };
            self.resolve_node_variables(n, &entries.clone());
        }
        if let Some(name) = name
            && truthy(&name)
        {
            set(&mut self.arena[n].props, "name", name);
        }
        for o in &own_derived {
            // derived data (Figma's computed size/position/…) wins over styles, so bake the styles in first: dropping the
            // style ids without that (pen.dev) leaves the stale inline values, e.g. a component's placeholder font.
            self.apply_styles_to(n);
            let p = &mut self.arena[n].props;
            for (k, v) in o.as_object().into_iter().flatten() {
                if k != "guidPath" && !v.is_null() {
                    set(p, k, v.clone());
                }
            }
            for k in ["styleIdForFill", "styleIdForStrokeFill", "styleIdForEffect", "styleIdForText"] {
                unset(p, k);
            }
        }
        if self.arena[n].props["type"] == "INSTANCE" {
            let p = &mut self.arena[n].props;
            if p["symbolData"].is_null() {
                set(p, "symbolData", json!({}));
            }
            if p["symbolData"]["symbolOverrides"].is_null() {
                set(&mut p["symbolData"], "symbolOverrides", json!([]));
            }
            if let Some(a) = p["symbolData"]["symbolOverrides"].as_array_mut() {
                a.extend(deeper.iter().map(|o| (**o).clone()));
            }
            if p["derivedSymbolData"].is_null() {
                set(p, "derivedSymbolData", json!([]));
            }
            if let Some(a) = p["derivedSymbolData"].as_array_mut() {
                a.extend(deeper_derived.iter().map(|o| (**o).clone()));
            }
        } else {
            let all: Overrides = overrides.iter().chain(&deeper).cloned().collect();
            let all_derived: Overrides = derived.iter().chain(&deeper_derived).cloned().collect();
            for c in self.arena[n].children.clone().unwrap_or_default() {
                self.apply_overrides(c, &all, &all_derived);
            }
        }
    }

    // Instance swap: take the other component's props, keep the instance's own placement and bindings.
    fn replace_instance_props(&mut self, n: usize, symbol_id: &Value) {
        let Some(&sym) = self.nodes.get(&key(symbol_id)) else { return };
        let old = std::mem::take(&mut self.arena[n].props);
        let mut p = self.arena[sym].props.clone();
        set(&mut p, "type", "INSTANCE".into());
        for k in ["guid", "parentIndex", "overrideKey", "size", "transform", "visible", "parameterConsumptionMap", "componentPropAssignments", "symbolData", "derivedSymbolData", "variableModeBySetMap"] {
            let v = &old[k];
            if !v.is_null() {
                set(&mut p, k, v.clone());
            } else if matches!(k, "guid" | "parentIndex" | "overrideKey") {
                unset(&mut p, k);
            }
        }
        self.arena[n].props = p;
    }

    fn find_mode_for_set(&self, n: Option<usize>, set_id: &str) -> Option<String> {
        let mut x = n;
        let mut hops = 0;
        while let Some(i) = x {
            for s in arr(&self.arena[i].props["variableModeBySetMap"]["entries"]) {
                if ref_key(&s["variableSetID"]).as_deref() == Some(set_id) && truthy(&s["variableModeID"]) {
                    return Some(key(&s["variableModeID"]));
                }
            }
            x = self.arena[i].parent;
            hops += 1;
            if hops > MAX_DEPTH {
                break;
            }
        }
        self.default_modes.get(set_id).cloned()
    }
    fn resolve_variable(&self, n: Option<usize>, data: &Value, hops: usize) -> Option<Value> {
        if !truthy(&data["value"]) || hops > MAX_HOPS {
            return None;
        }
        if data["dataType"] != "ALIAS" {
            return Some(data["value"].clone());
        }
        let v = self.variables.get(&ref_key(&data["value"]["alias"])?)?;
        if v.entries.len() > 1
            && let Some(set_id) = &v.set_id
            && let Some(mode) = self.find_mode_for_set(n, set_id)
            && let Some(hit) = v.entries.iter().find(|e| truthy(&e["modeID"]) && key(&e["modeID"]) == mode)
        {
            return self.resolve_variable(n, &hit["variableData"], hops + 1);
        }
        self.resolve_variable(n, &v.entries.first()?["variableData"], hops + 1)
    }
    fn resolve_color(&self, n: Option<usize>, data: &Value) -> Option<Value> {
        if data["resolvedDataType"] != "COLOR" {
            return None;
        }
        self.resolve_variable(n, data, 0)?.get("colorValue").filter(|v| !v.is_null()).cloned()
    }
    fn resolve_paints(&self, list: &Value, n: Option<usize>) -> Value {
        let Some(list) = list.as_array() else { return list.clone() };
        list.iter()
            .map(|p| {
                if truthy(&p["stops"]) {
                    let stops: Vec<Value> = arr(&p["stops"])
                        .iter()
                        .enumerate()
                        .map(|(i, s)| {
                            let var = if s["colorVar"].is_null() { &p["stopsVar"][i]["colorVar"] } else { &s["colorVar"] };
                            match self.resolve_color(n, var) {
                                Some(c) => {
                                    let mut s = s.clone();
                                    set(&mut s, "color", c);
                                    s
                                }
                                None => s.clone(),
                            }
                        })
                        .collect();
                    let mut p = p.clone();
                    set(&mut p, "stops", Value::Array(stops));
                    return p;
                }
                match self.resolve_color(n, &p["colorVar"]) {
                    Some(c) => {
                        let mut p = p.clone();
                        set(&mut p, "color", c);
                        set(&mut p, "opacity", 1.into());
                        p
                    }
                    None => p.clone(),
                }
            })
            .collect()
    }
    // Component properties: a reference resolves to the nearest ancestor's assignment.
    fn resolve_prop_ref(&self, n: Option<usize>, data: &Value, hops: usize) -> Value {
        let def = &data["value"]["propRefValue"]["defId"];
        if !truthy(def) || hops > MAX_HOPS {
            return data.clone();
        }
        let mut x = n;
        let mut steps = 0;
        while let Some(i) = x {
            for a in arr(&self.arena[i].props["componentPropAssignments"]) {
                if same(def, &a["defID"]) {
                    return self.resolve_prop_ref(Some(i), &a["varValue"], hops + 1);
                }
            }
            x = self.arena[i].parent;
            steps += 1;
            if steps > MAX_DEPTH {
                break;
            }
        }
        data.clone()
    }
    fn resolve_node_variables(&mut self, n: usize, entries: &Value) {
        for e in arr(entries) {
            let Some(field) = e["variableField"].as_str().filter(|f| !f.is_empty()) else { continue };
            let data = self.resolve_prop_ref(Some(n), &e["variableData"], 0);
            let v = self.resolve_variable(Some(n), &data, 0).unwrap_or(Value::Null);
            let p = &mut self.arena[n].props;
            match field {
                "TEXT_DATA" => {
                    if truthy(&v["textDataValue"]) {
                        set(p, "textData", v["textDataValue"].clone());
                    } else if !v["textValue"].is_null() {
                        set(p, "textData", json!({ "characters": v["textValue"] }));
                    }
                }
                "VISIBLE" => {
                    if !v["boolValue"].is_null() {
                        set(p, "visible", v["boolValue"].clone());
                    }
                }
                "OVERRIDDEN_SYMBOL_ID" => {
                    if valid(&v["symbolIdValue"]["guid"]) {
                        set(p, "overriddenSymbolID", v["symbolIdValue"]["guid"].clone());
                    }
                }
                _ => {
                    let fv = &v["floatValue"];
                    if fv.is_null() {
                        continue;
                    }
                    if let Some(keys) = float_fields(field) {
                        for k in keys {
                            set(p, k, fv.clone());
                        }
                    } else if field == "WIDTH" {
                        let y = if p["size"]["y"].is_null() { 0.into() } else { p["size"]["y"].clone() };
                        set(p, "size", json!({ "x": fv, "y": y }));
                    } else if field == "HEIGHT" {
                        let x = if p["size"]["x"].is_null() { 0.into() } else { p["size"]["x"].clone() };
                        set(p, "size", json!({ "x": x, "y": fv }));
                    }
                }
            }
        }
    }

    fn clone_tree(&mut self, i: usize) -> usize {
        let c = self.arena.len();
        self.arena.push(Node { props: self.arena[i].props.clone(), children: None, parent: None });
        if let Some(kids) = self.arena[i].children.clone() {
            let copies: Vec<usize> = kids
                .into_iter()
                .map(|k| {
                    let x = self.clone_tree(k);
                    self.arena[x].parent = Some(c);
                    x
                })
                .collect();
            self.arena[c].children = Some(copies);
        }
        c
    }

    fn sizing(&self, n: usize, ax: char) -> &'static str {
        let cross = if ax == 'H' { 'V' } else { 'H' };
        let p = &self.arena[n].props;
        let parent = self.arena[n].parent.and_then(|i| axis(&self.arena[i].props["stackMode"]));
        let own = axis(&p["stackMode"]);
        if (parent == Some(cross) && p["stackChildAlignSelf"] == "STRETCH") || (parent == Some(ax) && truthy(&p["stackChildPrimaryGrow"])) {
            return "fill";
        }
        if own == Some(cross) && p["stackCounterSizing"] == "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" {
            return "fit";
        }
        if own == Some(ax) && p["stackPrimarySizing"] == "FIXED" {
            return "fixed";
        }
        if own == Some(ax) { "fit" } else { "fixed" }
    }

    fn convert(&mut self, src: usize, depth: usize, image: &mut Img) -> Option<Value> {
        if depth > MAX_DEPTH {
            return None;
        }
        let mark = self.arena.len();
        let s = &self.arena[src];
        let node = Node { props: s.props.clone(), children: s.children.clone(), parent: s.parent };
        self.arena.push(node);
        let out = self.convert_node(mark, depth, image);
        self.arena.truncate(mark);
        out
    }

    fn convert_node(&mut self, n: usize, depth: usize, image: &mut Img) -> Option<Value> {
        if self.arena[n].props["type"] == "INSTANCE" {
            let swapped = valid(&self.arena[n].props["overriddenSymbolID"]);
            let entries = self.arena[n].props["parameterConsumptionMap"]["entries"].clone();
            self.resolve_node_variables(n, &entries);
            for r in self.arena[n].props["componentPropRefs"].as_array().cloned().unwrap_or_default() {
                if truthy(&r["defID"]) && truthy(&r["componentPropNodeField"]) {
                    let e = json!([{ "variableField": r["componentPropNodeField"], "variableData": { "value": { "propRefValue": { "defId": r["defID"] } } } }]);
                    self.resolve_node_variables(n, &e);
                }
            }
            let p = &self.arena[n].props;
            let symbol_id = if valid(&p["overriddenSymbolID"]) { &p["overriddenSymbolID"] } else { &p["symbolData"]["symbolID"] };
            let sym = (!symbol_id.is_null()).then(|| self.nodes.get(&key(symbol_id)).copied()).flatten();
            if let Some(sym) = sym {
                let copy = self.clone_tree(sym);
                let kids = self.arena[copy].children.clone();
                for &c in kids.iter().flatten() {
                    self.arena[c].parent = Some(n);
                    let p = &self.arena[n].props;
                    let ov: Overrides = arr(&p["symbolData"]["symbolOverrides"]).iter().cloned().map(Rc::new).collect();
                    let dv: Overrides = arr(&p["derivedSymbolData"]).iter().cloned().map(Rc::new).collect();
                    self.apply_overrides(c, &ov, &dv);
                }
                self.arena[n].children = kids;
                if !swapped && valid(&self.arena[n].props["overriddenSymbolID"]) {
                    let p = &self.arena[n].props;
                    let keep = [("name", p["name"].clone()), ("fillPaints", p["fillPaints"].clone()), ("strokePaints", p["strokePaints"].clone())];
                    let id = p["overriddenSymbolID"].clone();
                    self.replace_instance_props(n, &id);
                    for (k, v) in keep {
                        if v.is_null() {
                            unset(&mut self.arena[n].props, k);
                        } else {
                            set(&mut self.arena[n].props, k, v);
                        }
                    }
                }
                set(&mut self.arena[n].props, "type", "FRAME".into());
            }
        }
        let entries = self.arena[n].props["parameterConsumptionMap"]["entries"].clone();
        self.resolve_node_variables(n, &entries);
        self.apply_styles_to(n);
        let p = self.arena[n].props.clone();
        let parent_axis = self.arena[n].parent.and_then(|i| axis(&self.arena[i].props["stackMode"]));

        let mut out = Map::new();
        out.insert("type".into(), "frame".into());
        if truthy(&p["name"]) {
            out.insert("name".into(), p["name"].clone());
        }
        let in_layout = parent_axis.is_some() && p["stackPositioning"] != "ABSOLUTE";
        if p["stackPositioning"] == "ABSOLUTE" && parent_axis.is_some() {
            out.insert("layoutPosition".into(), "absolute".into());
        }
        if truthy(&p["transform"]) {
            // position, rotation (degrees CCW, around the top-left corner) and flips from the 2x3 matrix
            // .pen draws a node as translate(x, y) · rotate · flip around its center. A mirrored Figma matrix (det < 0) is
            // rotate · flipX about the origin, so the box starts `width` back along the rotated x axis (pen.dev keeps m02 as x:
            // mirrored layers land a width away).
            let t = &p["transform"];
            let g = |k: &str| f(&t[k]).unwrap_or(f64::NAN);
            let (a, b, c, d, tx, ty) = (g("m00"), g("m10"), g("m01"), g("m11"), g("m02"), g("m12"));
            let mirrored = a * d - b * c < 0.0;
            let r = if mirrored { (-b).atan2(-a) } else { b.atan2(a) };
            let w = if mirrored { f(&p["size"]["x"]).unwrap_or(0.0) } else { 0.0 };
            if !in_layout {
                out.insert("x".into(), num(round(tx - w * r.cos())));
                out.insert("y".into(), num(round(ty - w * r.sin())));
            }
            if r.abs() > 1e-6 {
                out.insert("rotation".into(), num(round(-deg(r))));
            }
            if mirrored {
                out.insert("flipX".into(), true.into());
            }
        }
        if p["visible"] == false {
            out.insert("enabled".into(), false.into());
        }
        if let Some(o) = f(&p["opacity"])
            && o != 1.0
        {
            out.insert("opacity".into(), num(round(o)));
        }
        let fill = paints(&p["fillPaints"], &p["size"], image).and_then(one);
        let effect = effects(&p["effects"]);
        let size = |out: &mut Map<String, Value>, dflt: &str| {
            let w = size_value(self.sizing(n, 'H'), f(&p["size"]["x"]).unwrap_or(0.0), dflt);
            let h = size_value(self.sizing(n, 'V'), f(&p["size"]["y"]).unwrap_or(0.0), dflt);
            if let Some(w) = w {
                out.insert("width".into(), w);
            }
            if let Some(h) = h {
                out.insert("height".into(), h);
            }
        };
        let ty = p["type"].as_str().unwrap_or("");
        match ty {
            "SYMBOL" | "SECTION" | "FRAME" => {
                if truthy(&p["resizeToFit"]) {
                    out.insert("type".into(), "group".into()); // Figma groups are frames that hug their children
                } else {
                    if !truthy(&p["frameMaskDisabled"]) {
                        out.insert("clip".into(), true.into());
                    }
                    size(&mut out, "fit");
                    if let Some(fill) = &fill {
                        out.insert("fill".into(), fill.clone());
                    }
                    stroke(&mut out, &p, image);
                    if let Some(r) = radius(&p) {
                        out.insert("cornerRadius".into(), r);
                    }
                    let mode = axis(&p["stackMode"]);
                    if mode != Some('H') {
                        out.insert("layout".into(), if mode == Some('V') { "vertical" } else { "none" }.into());
                    }
                    if mode.is_some() {
                        if truthy(&p["stackSpacing"]) {
                            out.insert("gap".into(), p["stackSpacing"].clone());
                        }
                        let g = |k: &str| f(&p[k]).unwrap_or(0.0);
                        let pad = [g("stackVerticalPadding"), g("stackPaddingRight"), g("stackPaddingBottom"), g("stackHorizontalPadding")];
                        let pad = if pad[0] == pad[2] && pad[1] == pad[3] {
                            if pad[0] == pad[1] { num(pad[0]) } else { json!([num(pad[0]), num(pad[1])]) }
                        } else {
                            pad.iter().map(|&v| num(v)).collect()
                        };
                        if pad != json!(0) {
                            out.insert("padding".into(), pad);
                        }
                        let justify = match p["stackPrimaryAlignItems"].as_str() {
                            Some("CENTER") => Some("center"),
                            Some("MAX") => Some("end"),
                            Some("SPACE_BETWEEN" | "SPACE_EVENLY") => Some("space_between"),
                            _ => None,
                        };
                        let align = match p["stackCounterAlignItems"].as_str() {
                            Some("CENTER") => Some("center"),
                            Some("MAX") => Some("end"),
                            _ => None,
                        };
                        if let Some(j) = justify {
                            out.insert("justifyContent".into(), j.into());
                        }
                        if let Some(a) = align {
                            out.insert("alignItems".into(), a.into());
                        }
                        if truthy(&p["bordersTakeSpace"]) {
                            out.insert("layoutIncludeStroke".into(), true.into());
                        }
                    }
                }
            }
            "VECTOR" | "STAR" | "BOOLEAN_OPERATION" | "BRUSH" => {
                // Figma's computed outline when it has one: exact, booleans applied (pen.dev rebuilds vectors from the network
                // and drops stars, brushes and boolean results). Otherwise the vector network, drawn in its own box
                // (`normalizedSize`, often not the layer's size).
                let blob = |i: &Value| i.as_u64().and_then(|i| self.blobs.get(i as usize));
                let outline: Vec<String> =
                    arr(&p["fillGeometry"]).iter().filter_map(|g| blob(&g["commandsBlob"]).and_then(|b| commands_path(b))).filter(|s| !s.is_empty()).collect();
                let net = if outline.is_empty() { blob(&p["vectorData"]["vectorNetworkBlob"]).and_then(|b| parse_network(b)) } else { None };
                let mut skip = false;
                if outline.is_empty() && net.is_none() {
                    if ty == "BOOLEAN_OPERATION" {
                        out.insert("type".into(), "group".into()); // no result stored: show the operands
                        skip = true;
                    } else if ty != "VECTOR" {
                        return None;
                    }
                }
                if !skip {
                    out.insert("type".into(), "path".into());
                    size(&mut out, "fixed");
                    if let Some(fill) = &fill {
                        out.insert("fill".into(), fill.clone());
                    }
                    stroke(&mut out, &p, image);
                    let bx = |s: &Value| {
                        let d = |v: f64| if ftruthy(v) { v } else { 1.0 };
                        json!([0, 0, num(d(round(f(&s["x"]).unwrap_or(f64::NAN)))), num(d(round(f(&s["y"]).unwrap_or(f64::NAN))))])
                    };
                    if !outline.is_empty() {
                        out.insert("geometry".into(), outline.concat().into());
                        if p["fillGeometry"][0]["windingRule"] == "ODD" {
                            out.insert("fillRule".into(), "evenodd".into());
                        }
                        if !p["size"].is_null() {
                            out.insert("viewBox".into(), bx(&p["size"]));
                        }
                    } else if let Some(net) = net {
                        let mut odd = None;
                        let geometry = if !net.regions.is_empty() {
                            net.regions
                                .iter()
                                .map(|(o, loops)| {
                                    odd = Some(*o);
                                    loops
                                        .iter()
                                        .filter(|l| !l.is_empty())
                                        .map(|l| draw(&net.vertices, &chain(l.iter().map(|&i| net.segments[i as usize]).collect())))
                                        .collect::<String>()
                                })
                                .collect::<String>()
                        } else {
                            draw(&net.vertices, &chain(net.segments.clone()))
                        };
                        out.insert("geometry".into(), geometry.into());
                        if odd == Some(true) {
                            out.insert("fillRule".into(), "evenodd".into());
                        }
                        let space = if p["vectorData"]["normalizedSize"].is_null() { &p["size"] } else { &p["vectorData"]["normalizedSize"] };
                        if !space.is_null() {
                            out.insert("viewBox".into(), bx(space));
                        }
                    } else {
                        out.insert("geometry".into(), "".into());
                    }
                }
            }
            "TEXT" => {
                out.insert("type".into(), "text".into());
                if let Some(fill) = &fill {
                    out.insert("fill".into(), fill.clone());
                }
                let growth = match p["textAutoResize"].as_str().unwrap_or("NONE") {
                    "WIDTH_AND_HEIGHT" => "auto",
                    "HEIGHT" => "fixed-width",
                    _ => "fixed-width-height",
                };
                if growth != "auto" {
                    out.insert("textGrowth".into(), growth.into());
                    let w = size_value(self.sizing(n, 'H'), f(&p["size"]["x"]).unwrap_or(0.0), "fixed").unwrap_or(0.into());
                    out.insert("width".into(), w);
                    if growth == "fixed-width-height"
                        && let Some(h) = size_value(self.sizing(n, 'V'), f(&p["size"]["y"]).unwrap_or(0.0), "fixed")
                    {
                        out.insert("height".into(), h);
                    }
                }
                let align = match p["textAlignHorizontal"].as_str() {
                    Some("CENTER") => Some("center"),
                    Some("RIGHT") => Some("right"),
                    Some("JUSTIFIED") => Some("justify"),
                    _ => None,
                };
                let valign = match p["textAlignVertical"].as_str() {
                    Some("CENTER") => Some("middle"),
                    Some("BOTTOM") => Some("bottom"),
                    _ => None,
                };
                if let Some(a) = align {
                    out.insert("textAlign".into(), a.into());
                }
                if let Some(a) = valign {
                    out.insert("textAlignVertical".into(), a.into());
                }
                let base = text_style(&p, image);
                for (k, v) in &base {
                    out.insert(k.clone(), v.clone());
                }
                let chars = p["textData"]["characters"].as_str().unwrap_or("");
                let ids = arr(&p["textData"]["characterStyleIDs"]);
                let table = arr(&p["textData"]["styleOverrideTable"]);
                let id_at = |i: usize| ids.get(i).and_then(Value::as_f64).unwrap_or(0.0);
                let find = |id: f64| table.iter().find(|t| t["styleID"].as_f64() == Some(id));
                // Per-character styles (styleOverrideTable): spans with what differs from the layer's own style. A span's
                // `fill` is Pena's (pen.dev spans carry no color). Indices are UTF-16 units, like JS strings.
                if ids.iter().any(truthy) && !table.is_empty() {
                    let units: Vec<u16> = chars.encode_utf16().collect();
                    let mut styles: HashMap<u64, Map<String, Value>> = HashMap::from([(0f64.to_bits(), Map::new())]);
                    let mut spans: Vec<Map<String, Value>> = vec![];
                    let mut i = 0;
                    while i < units.len() {
                        let id = id_at(i);
                        let mut j = i + 1;
                        while j < units.len() && id_at(j) == id {
                            j += 1;
                        }
                        if !styles.contains_key(&id.to_bits()) {
                            let mut o = find(id).cloned().unwrap_or(json!({}));
                            for (k, v) in self.style_patch(&o, Some(n)) {
                                set(&mut o, k, v);
                            }
                            let mut merged = p.clone();
                            for (k, v) in o.as_object().into_iter().flatten() {
                                if !v.is_null() {
                                    set(&mut merged, k, v.clone());
                                }
                            }
                            let s = text_style(&merged, image);
                            let diff = s.into_iter().filter(|(k, v)| base.get(k).is_none_or(|b| serde_json::to_string(v).ok() != serde_json::to_string(b).ok())).collect();
                            styles.insert(id.to_bits(), diff);
                        }
                        let mut span = Map::new();
                        span.insert("content".into(), String::from_utf16_lossy(&units[i..j]).into());
                        span.extend(styles[&id.to_bits()].clone());
                        let case = find(id).map(|t| &t["textCase"]).filter(|c| ftruthy(id) && truthy(c));
                        let case = case.cloned().unwrap_or_else(|| p["textCase"].clone());
                        let text = letter_case(span["content"].as_str().unwrap_or(""), &case);
                        span.insert("content".into(), text.into());
                        spans.push(span);
                        i = j;
                    }
                    if spans.iter().any(|s| s.len() > 1) {
                        out.insert("content".into(), spans.into_iter().map(Value::Object).collect());
                    } else if !chars.is_empty() {
                        out.insert("content".into(), letter_case(chars, &p["textCase"]).into());
                    }
                } else if !chars.is_empty() {
                    out.insert("content".into(), letter_case(chars, &p["textCase"]).into());
                }
                if let Some(ps) = f(&p["paragraphSpacing"])
                    && ftruthy(ps)
                {
                    out.insert("paragraphSpacing".into(), num(round(ps))); // Pena's: pen.dev has no paragraph spacing
                }
                self.face(&base);
                if let Some(spans) = out.get("content").and_then(Value::as_array).cloned() {
                    for sp in spans {
                        let mut st = base.clone();
                        st.extend(sp.as_object().cloned().unwrap_or_default());
                        self.face(&st);
                    }
                }
            }
            "RECTANGLE" | "ROUNDED_RECTANGLE" | "LINE" | "ELLIPSE" | "REGULAR_POLYGON" => {
                let t = match ty {
                    "LINE" => "line",
                    "ELLIPSE" => "ellipse",
                    "REGULAR_POLYGON" => "polygon",
                    _ => "rectangle",
                };
                out.insert("type".into(), t.into());
                size(&mut out, "fixed");
                if let Some(fill) = &fill {
                    out.insert("fill".into(), fill.clone());
                }
                stroke(&mut out, &p, image);
                let r = radius(&p);
                if t == "rectangle"
                    && let Some(r) = &r
                {
                    out.insert("cornerRadius".into(), r.clone());
                }
                if t == "polygon" {
                    if !p["count"].is_null() {
                        out.insert("polygonCount".into(), p["count"].clone());
                    }
                    if let Some(r) = r.filter(truthy) {
                        out.insert("cornerRadius".into(), if r.is_array() { r[0].clone() } else { r });
                    }
                }
                if t == "ellipse" && truthy(&p["arcData"]) {
                    let a = &p["arcData"];
                    if truthy(&a["innerRadius"]) {
                        out.insert("innerRadius".into(), a["innerRadius"].clone());
                    }
                    let start = f(&a["startingAngle"]);
                    if let Some(s) = start
                        && ftruthy(s)
                    {
                        out.insert("startAngle".into(), num(round(-deg(s))));
                    }
                    if let Some(e) = f(&a["endingAngle"]) {
                        let sweep = round(deg(start.unwrap_or(0.0)) - deg(e));
                        if sweep.abs() != 360.0 {
                            out.insert("sweepAngle".into(), num(sweep));
                        }
                    }
                }
            }
            _ => return None, // STICKY, CONNECTOR, ...: not supported (pen.dev skips them too)
        }
        if out["type"] == "group" {
            out.shift_remove("fill");
        }
        if truthy(&p["mask"]) {
            out.shift_remove("fill");
            out.shift_remove("stroke");
        }
        // layer blend mode (MULTIPLY over a photo, …): .pen only blends paints, so it goes onto the layer's own fills/strokes
        if let Some(lb) = blend(&p["blendMode"]) {
            for k in ["fill", "stroke"] {
                let Some(v) = out.get(k).filter(|v| truthy(v)) else { continue };
                let list = if let Value::Array(a) = v { a.clone() } else { vec![v.clone()] };
                let list = list
                    .into_iter()
                    .map(|f| match f {
                        Value::String(c) => json!({ "type": "color", "color": c, "blendMode": lb }),
                        f if truthy(&f["blendMode"]) => f,
                        mut f => {
                            set(&mut f, "blendMode", lb.into());
                            f
                        }
                    })
                    .collect();
                out.insert(k.into(), one(list).unwrap());
            }
        }
        if let Some(e) = effect {
            out.insert("effect".into(), e);
        }
        let kids = self.arena[n].children.clone();
        if let Some(kids) = kids
            && (out["type"] == "frame" || out["type"] == "group")
        {
            let mut children: Vec<Value> = vec![];
            // A mask clips every sibling above it (pen.dev ignores masks, so masked images spill out): a clipping frame at the
            // mask's box takes those siblings. Rectangle/ellipse masks clip exactly; other shapes clip to their bounds.
            let mut clip: Option<(f64, f64)> = None; // the open clip frame is always the last child
            let own_axis = axis(&p["stackMode"]);
            for &src in kids.iter().rev() {
                let Some(c) = self.convert(src, depth + 1, image) else { continue };
                let sp = &self.arena[src].props;
                let bx = &sp["size"]; // Figma's size: the converted mask may hug (fit_content) and carry no number
                if truthy(&sp["mask"]) && sp["visible"] != false && own_axis.is_none() && !bx.is_null() && !truthy(&c["rotation"]) && !truthy(&c["flipX"]) {
                    let (w, h) = (round(f(&bx["x"]).unwrap_or(f64::NAN)), round(f(&bx["y"]).unwrap_or(f64::NAN)));
                    let (cx, cy) = (f(&c["x"]).unwrap_or(0.0), f(&c["y"]).unwrap_or(0.0));
                    let mut frame = json!({ "type": "frame", "name": if c["name"].is_null() { "Mask".into() } else { c["name"].clone() },
                        "x": num(cx), "y": num(cy), "width": num(w), "height": num(h), "clip": true, "layout": "none", "children": [] });
                    // a frame used as mask clips to its content: usually one shape covering it, which carries the radius
                    let cover = (c["type"] == "frame")
                        .then(|| arr(&c["children"]).iter().find(|k| !truthy(&k["x"]) && !truthy(&k["y"]) && k["width"].as_f64() == Some(w) && k["height"].as_f64() == Some(h)))
                        .flatten();
                    let half = num(round(js::min(w, h) / 2.0));
                    let r = if c["type"] == "ellipse" {
                        half
                    } else if !c["cornerRadius"].is_null() {
                        c["cornerRadius"].clone()
                    } else if cover.is_some_and(|k| k["type"] == "ellipse") {
                        half
                    } else {
                        cover.map_or(Value::Null, |k| k["cornerRadius"].clone())
                    };
                    if truthy(&r) {
                        set(&mut frame, "cornerRadius", r);
                    }
                    children.push(frame);
                    clip = Some((cx, cy));
                } else if let Some((x, y)) = clip {
                    let mut c = c;
                    let (kx, ky) = (f(&c["x"]).unwrap_or(0.0), f(&c["y"]).unwrap_or(0.0));
                    set(&mut c, "x", num(round(kx - x)));
                    set(&mut c, "y", num(round(ky - y)));
                    if let Some(a) = children.last_mut().and_then(|l| l.get_mut("children")).and_then(Value::as_array_mut) {
                        a.push(c);
                    }
                } else {
                    children.push(c);
                }
            }
            out.insert("children".into(), Value::Array(children));
        }
        Some(Value::Object(out))
    }
}
