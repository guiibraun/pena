// Export: .pen → .fig (figma.mjs `exportFigma`), written with Figma's own schema (pen.dev only imports).
// Input: the editor's laid-out tree (every node with numeric x/y/w/h relative to its parent and its props resolved),
// so flex sizes and positions are already known. Each node becomes a Figma NodeChange; auto layout is kept (stack*
// fields). Derived data Figma caches (fillGeometry, glyphs) is left out for Figma to compute. Icons arrive rendered
// (`png`) and become image-filled rectangles.
use crate::import::{BLEND, M, invert, m};
use crate::js::{self, ftruthy, num, truthy};
use crate::kiwi::{Schema, hex};
use anyhow::{Result, bail};
use base64::Engine;
use indexmap::IndexMap;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::collections::HashMap;
use std::f64::consts::PI;
use std::io::{Read, Write};
use std::sync::OnceLock;

pub const FIG_VERSION: u32 = 106;
// Figma's kiwi schema (deflated, as .fig files embed it), taken from a .fig saved by Figma (file format 106).
const FIG_SCHEMA_B64: &str = include_str!("fig-schema.b64");

fn fig_schema() -> &'static (Vec<u8>, Schema) {
    static S: OnceLock<(Vec<u8>, Schema)> = OnceLock::new();
    S.get_or_init(|| {
        let deflated = base64::engine::general_purpose::STANDARD.decode(FIG_SCHEMA_B64.trim()).expect("schema base64");
        let mut raw = Vec::new();
        flate2::read::DeflateDecoder::new(&deflated[..]).read_to_end(&mut raw).expect("schema inflate");
        let schema = Schema::decode(&raw).expect("schema decode");
        (deflated, schema)
    })
}

fn blend_out(v: &Value) -> &'static str {
    v.as_str().and_then(|s| BLEND.iter().find(|(_, p)| *p == s)).map_or("NORMAL", |(f, _)| f)
}
fn rgba(s: &Value) -> Option<Value> {
    let s = s.as_str()?;
    let h = s.strip_prefix('#')?;
    if !matches!(h.len(), 3 | 6 | 8) || !h.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let h: String = if h.len() == 3 { h.chars().flat_map(|c| [c, c]).collect() } else { h.into() };
    let v = |i: usize| num(u8::from_str_radix(&h[i..i + 2], 16).unwrap() as f64 / 255.0);
    Some(json!({ "r": v(0), "g": v(2), "b": v(4), "a": if h.len() == 8 { v(6) } else { 1.into() } }))
}
fn mul(p: &M, q: &M) -> M {
    m(p.a * q.a + p.c * q.b, p.b * q.a + p.d * q.b, p.a * q.c + p.c * q.d, p.b * q.c + p.d * q.d, p.a * q.tx + p.c * q.ty + p.tx, p.b * q.tx + p.d * q.ty + p.ty)
}
fn fig_t(x: &M) -> Value {
    json!({ "m00": num(x.a), "m01": num(x.c), "m02": num(x.tx), "m10": num(x.b), "m11": num(x.d), "m12": num(x.ty) })
}
fn turn(r: f64) -> M {
    m(r.cos(), r.sin(), -r.sin(), r.cos(), 0.0, 0.0)
}
fn list(v: &Value) -> Vec<&Value> {
    match v {
        Value::Null => vec![],
        Value::Array(a) => a.iter().collect(),
        v => vec![v],
    }
}
/// Number(v) || 0
fn n0(v: &Value) -> f64 {
    let x = js::number(v);
    if ftruthy(x) { x } else { 0.0 }
}
// fractional index: equal-length base-94 strings sort like their numbers (ascending = bottom → top)
fn position(mut i: usize, n: usize) -> String {
    let k = (((n + 1) as f64).ln() / 94f64.ln()).ceil().max(1.0) as usize;
    let mut s = Vec::new();
    for _ in 0..k {
        s.push((33 + (i % 94)) as u8);
        i /= 94;
    }
    s.reverse();
    String::from_utf8(s).unwrap()
}
fn font_style(weight: &Value, italic: bool) -> String {
    let w = js::number(weight);
    let w = if ftruthy(w) {
        w
    } else {
        let s: String = if weight.is_null() { String::new() } else { js::string(weight) }.to_lowercase().chars().filter(|c| !c.is_whitespace() && *c != '_' && *c != '-').collect();
        match s.as_str() {
            "thin" => 100.0,
            "extralight" => 200.0,
            "light" => 300.0,
            "normal" | "regular" => 400.0,
            "medium" => 500.0,
            "semibold" => 600.0,
            "bold" => 700.0,
            "extrabold" => 800.0,
            "black" => 900.0,
            _ => 400.0,
        }
    };
    let name = match js::min(900.0, js::max(100.0, js::round(w / 100.0) * 100.0)) as i64 {
        100 => "Thin",
        200 => "Extra Light",
        300 => "Light",
        500 => "Medium",
        600 => "Semi Bold",
        700 => "Bold",
        800 => "Extra Bold",
        900 => "Black",
        _ => "Regular",
    };
    if italic {
        if name == "Regular" { "Italic".into() } else { format!("{name} Italic") }
    } else {
        name.into()
    }
}
fn padding4(p: &Value) -> Vec<Value> {
    let v: Vec<Value> = match p {
        Value::Array(a) if a.len() == 2 => vec![a[0].clone(), a[1].clone(), a[0].clone(), a[1].clone()],
        Value::Array(a) => a.clone(),
        Value::Null => vec![0.into(); 4],
        p => vec![p.clone(); 4],
    };
    v.iter().map(|x| num(n0(x))).collect()
}
fn is_fill(v: &Value) -> bool {
    v.as_str().is_some_and(|s| s.starts_with("fill_container"))
}

// SVG path data → absolute commands [M x y] [L x y] [C x1 y1 x2 y2 x y] [Z] (H/V/S/Q/T/A converted)
#[derive(Clone, Debug)]
pub(crate) enum Cmd {
    M(f64, f64),
    L(f64, f64),
    C(f64, f64, f64, f64, f64, f64),
    Z,
}
fn svg_commands(d: &str) -> Vec<Cmd> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(?i)[MLHVCSQTAZ]|[-+]?(?:[0-9]*\.[0-9]+|[0-9]+\.?)(?:e[-+]?[0-9]+)?").unwrap());
    let tokens: Vec<&str> = re.find_iter(d).map(|m| m.as_str()).collect();
    let mut out = Vec::new();
    let (mut i, mut cmd) = (0usize, String::new());
    let (mut x, mut y, mut sx, mut sy) = (0.0, 0.0, 0.0, 0.0);
    let (mut cx, mut cy, mut qx, mut qy): (Option<f64>, f64, Option<f64>, f64) = (None, 0.0, None, 0.0);
    let num = |i: &mut usize| {
        let v = tokens.get(*i).map_or(f64::NAN, |t| js::to_number(t));
        *i += 1;
        v
    };
    while i < tokens.len() {
        // a number with an exponent has a letter too: JS's /[a-z]/i test takes it as a command, so does this
        if tokens[i].bytes().any(|b| b.is_ascii_alphabetic()) {
            cmd = tokens[i].into();
            i += 1;
        }
        let rel = cmd == cmd.to_lowercase();
        let c = cmd.to_uppercase();
        let (ox, oy) = if rel { (x, y) } else { (0.0, 0.0) };
        match c.as_str() {
            "Z" => {
                out.push(Cmd::Z);
                x = sx;
                y = sy;
                cx = None;
                qx = None;
            }
            "M" => {
                x = ox + num(&mut i);
                y = oy + num(&mut i);
                out.push(Cmd::M(x, y));
                sx = x;
                sy = y;
                cmd = if rel { "l".into() } else { "L".into() };
                cx = None;
                qx = None;
            }
            "L" | "H" | "V" => {
                if c != "V" {
                    x = ox + num(&mut i);
                }
                if c != "H" {
                    y = oy + num(&mut i);
                }
                out.push(Cmd::L(x, y));
                cx = None;
                qx = None;
            }
            "C" | "S" => {
                let (x1, y1) = if c == "C" {
                    (ox + num(&mut i), oy + num(&mut i))
                } else {
                    match cx {
                        None => (x, y),
                        Some(cx) => (2.0 * x - cx, 2.0 * y - cy),
                    }
                };
                let (x2, y2) = (ox + num(&mut i), oy + num(&mut i));
                let (ex, ey) = (ox + num(&mut i), oy + num(&mut i));
                out.push(Cmd::C(x1, y1, x2, y2, ex, ey));
                cx = Some(x2);
                cy = y2;
                x = ex;
                y = ey;
                qx = None;
            }
            "Q" | "T" => {
                let (x1, y1) = if c == "Q" {
                    (ox + num(&mut i), oy + num(&mut i))
                } else {
                    match qx {
                        None => (x, y),
                        Some(qx) => (2.0 * x - qx, 2.0 * y - qy),
                    }
                };
                let (ex, ey) = (ox + num(&mut i), oy + num(&mut i));
                out.push(Cmd::C(x + (2.0 / 3.0) * (x1 - x), y + (2.0 / 3.0) * (y1 - y), ex + (2.0 / 3.0) * (x1 - ex), ey + (2.0 / 3.0) * (y1 - ey), ex, ey));
                qx = Some(x1);
                qy = y1;
                x = ex;
                y = ey;
                cx = None;
            }
            "A" => {
                let (rx, ry) = (num(&mut i).abs(), num(&mut i).abs());
                let phi = num(&mut i) * PI / 180.0;
                let (large, sweep) = (num(&mut i), num(&mut i));
                let (ex, ey) = (ox + num(&mut i), oy + num(&mut i));
                out.extend(arc_to_cubics(x, y, rx, ry, phi, large, sweep, ex, ey));
                x = ex;
                y = ey;
                cx = None;
                qx = None;
            }
            _ => i += 1, // unknown token
        }
    }
    out
}
// SVG arc → cubic béziers (endpoint → center parameterization, SVG spec F.6.5), ≤ 90° per curve
#[allow(clippy::too_many_arguments)]
fn arc_to_cubics(x1: f64, y1: f64, mut rx: f64, mut ry: f64, phi: f64, large: f64, sweep: f64, x2: f64, y2: f64) -> Vec<Cmd> {
    if !ftruthy(rx) || !ftruthy(ry) || (x1 == x2 && y1 == y2) {
        return vec![Cmd::L(x2, y2)];
    }
    let (cos, sin) = (phi.cos(), phi.sin());
    let (dx, dy) = ((x1 - x2) / 2.0, (y1 - y2) / 2.0);
    let (xp, yp) = (cos * dx + sin * dy, -sin * dx + cos * dy);
    let l = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
    if l > 1.0 {
        rx *= l.sqrt();
        ry *= l.sqrt();
    }
    let k = (if large == sweep { -1.0 } else { 1.0 })
        * js::max(0.0, (rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp) / (rx * rx * yp * yp + ry * ry * xp * xp)).sqrt();
    let (cxp, cyp) = ((k * rx * yp) / ry, (-k * ry * xp) / rx);
    let (cx, cy) = (cos * cxp - sin * cyp + (x1 + x2) / 2.0, sin * cxp + cos * cyp + (y1 + y2) / 2.0);
    let ang = |ux: f64, uy: f64, vx: f64, vy: f64| (ux * vy - uy * vx).atan2(ux * vx + uy * vy);
    let mut t1 = ang(1.0, 0.0, (xp - cxp) / rx, (yp - cyp) / ry);
    let mut dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
    if !ftruthy(sweep) && dt > 0.0 {
        dt -= 2.0 * PI;
    }
    if ftruthy(sweep) && dt < 0.0 {
        dt += 2.0 * PI;
    }
    let n = (dt.abs() / (PI / 2.0)).ceil();
    let step = dt / n;
    let a = (4.0 / 3.0) * (step / 4.0).tan();
    let pt = |t: f64| (cx + rx * t.cos() * cos - ry * t.sin() * sin, cy + rx * t.cos() * sin + ry * t.sin() * cos);
    let dpt = |t: f64| (-rx * t.sin() * cos - ry * t.cos() * sin, -rx * t.sin() * sin + ry * t.cos() * cos);
    let mut out = Vec::new();
    let mut j = 0.0;
    while j < n {
        let ((px, py), (qx, qy), (dx1, dy1), (dx2, dy2)) = (pt(t1), pt(t1 + step), dpt(t1), dpt(t1 + step));
        out.push(Cmd::C(px + a * dx1, py + a * dy1, qx - a * dx2, qy - a * dy2, qx, qy));
        j += 1.0;
        t1 += step;
    }
    out
}
// Commands (already in the node's box) → vector network blob: closed subpaths become loops of one filled region.
fn network_blob(cmds: &[Cmd], evenodd: bool) -> Vec<u8> {
    struct S {
        start: usize,
        end: usize,
        sd: (f64, f64),
        ed: (f64, f64),
    }
    let (mut vertices, mut segments, mut loops): (Vec<(f64, f64)>, Vec<S>, Vec<Vec<usize>>) = (vec![], vec![], vec![]);
    let (mut start, mut last): (Option<usize>, Option<usize>) = (None, None);
    let mut lp: Vec<usize> = vec![];
    for c in cmds {
        match *c {
            Cmd::M(x, y) => {
                lp.clear(); // close(false)
                vertices.push((x, y));
                start = Some(vertices.len() - 1);
                last = start;
            }
            Cmd::Z => {
                let Some(s) = start else { continue };
                let l = last.unwrap();
                let ((sx, sy), (lx, ly)) = (vertices[s], vertices[l]);
                if l != s && (lx - sx).abs() < 1e-6 && (ly - sy).abs() < 1e-6 && segments.last().is_some_and(|g| g.end == l) {
                    segments.last_mut().unwrap().end = s;
                    vertices.pop();
                } else if l != s {
                    segments.push(S { start: l, end: s, sd: (0.0, 0.0), ed: (0.0, 0.0) });
                    lp.push(segments.len() - 1);
                }
                if !lp.is_empty() {
                    loops.push(std::mem::take(&mut lp));
                }
                lp.clear();
                last = start;
            }
            Cmd::L(..) | Cmd::C(..) => {
                if last.is_none() {
                    vertices.push((0.0, 0.0));
                    start = Some(vertices.len() - 1);
                    last = start;
                }
                let (ex, ey) = match *c {
                    Cmd::L(x, y) => (x, y),
                    Cmd::C(_, _, _, _, x, y) => (x, y),
                    _ => unreachable!(),
                };
                let (px, py) = vertices[last.unwrap()];
                vertices.push((ex, ey));
                let v = vertices.len() - 1;
                let (sd, ed) = match *c {
                    Cmd::C(x1, y1, x2, y2, ..) => ((x1 - px, y1 - py), (x2 - ex, y2 - ey)),
                    _ => ((0.0, 0.0), (0.0, 0.0)),
                };
                segments.push(S { start: last.unwrap(), end: v, sd, ed });
                lp.push(segments.len() - 1);
                last = Some(v);
            }
        }
    }
    let mut b = Vec::with_capacity(12 + vertices.len() * 12 + segments.len() * 28);
    let u = |b: &mut Vec<u8>, v: usize| b.extend_from_slice(&(v as u32).to_le_bytes());
    let f = |b: &mut Vec<u8>, v: f64| b.extend_from_slice(&(v as f32).to_le_bytes());
    u(&mut b, vertices.len());
    u(&mut b, segments.len());
    u(&mut b, if loops.is_empty() { 0 } else { 1 });
    for &(x, y) in &vertices {
        u(&mut b, 0);
        f(&mut b, x);
        f(&mut b, y);
    }
    for s in &segments {
        u(&mut b, 0);
        u(&mut b, s.start);
        f(&mut b, s.sd.0);
        f(&mut b, s.sd.1);
        u(&mut b, s.end);
        f(&mut b, s.ed.0);
        f(&mut b, s.ed.1);
    }
    if !loops.is_empty() {
        u(&mut b, if evenodd { 0 } else { 1 });
        u(&mut b, loops.len());
        for l in &loops {
            u(&mut b, l.len());
            for &i in l {
                u(&mut b, i);
            }
        }
    }
    b
}

// JS's lenient Buffer.from(s, 'base64'): skips junk, accepts the url-safe alphabet and missing padding.
pub(crate) fn base64_loose(s: &str) -> Vec<u8> {
    let clean: String = s.chars().filter_map(|c| match c {
        '-' => Some('+'),
        '_' => Some('/'),
        c if c.is_ascii_alphanumeric() || c == '+' || c == '/' => Some(c),
        _ => None,
    }).collect();
    let clean = if clean.len() % 4 == 1 { &clean[..clean.len() - 1] } else { &clean[..] };
    let engine = base64::engine::GeneralPurpose::new(&base64::alphabet::STANDARD, base64::engine::GeneralPurposeConfig::new().with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent).with_decode_allow_trailing_bits(true));
    engine.decode(clean).unwrap_or_default()
}

struct Ctx<'a> {
    files: IndexMap<String, (Vec<u8>, bool)>, // bytes, stored (no compression)
    blobs: Vec<Value>,
    node_changes: Vec<Value>,
    images: HashMap<String, Option<String>>,
    local_id: u64,
    read_image: &'a dyn Fn(&str) -> Option<Vec<u8>>,
}

fn identity() -> Value {
    json!({ "m00": 1, "m01": 0, "m02": 0, "m10": 0, "m11": 1, "m12": 0 })
}
fn base() -> serde_json::Map<String, Value> {
    let Value::Object(m) = json!({ "phase": "CREATED", "visible": true, "opacity": 1, "strokeWeight": 0, "strokeAlign": "CENTER", "strokeJoin": "MITER" }) else { unreachable!() };
    m
}

impl Ctx<'_> {
    fn image(&mut self, url: &Value) -> Option<String> {
        let url = url.as_str().filter(|u| !u.is_empty())?;
        if !self.images.contains_key(url) {
            let bytes = if url.starts_with("data:") { Some(base64_loose(&url[url.find(',').map_or(0, |i| i + 1)..])) } else { (self.read_image)(url) };
            let hash = bytes.map(|b| {
                let h = hex(&Sha1::digest(&b));
                self.files.insert(format!("images/{h}"), (b, true));
                h
            });
            self.images.insert(url.into(), hash);
        }
        self.images[url].clone()
    }

    fn paint(&mut self, f: &Value) -> Option<Value> {
        let f = if f.is_string() { json!({ "type": "color", "color": f }) } else { f.clone() };
        if !f.is_object() {
            return None;
        }
        let (visible, blend_mode) = (f["enabled"] != false, blend_out(&f["blendMode"]));
        let opacity = if f["opacity"].is_null() { 1.into() } else { f["opacity"].clone() };
        match f["type"].as_str() {
            Some("color") => {
                let mut c = rgba(&f["color"])?;
                let a = c["a"].clone();
                c["a"] = 1.into();
                Some(json!({ "type": "SOLID", "color": c, "opacity": a, "visible": visible, "blendMode": blend_mode }))
            }
            Some("gradient") => {
                let kind = f["gradientType"].as_str().map_or_else(|| if f["gradientType"].is_null() { "linear".into() } else { js::string(&f["gradientType"]) }, String::from);
                let (cx, cy) = (js::number(&f["center"]["x"]), js::number(&f["center"]["y"]));
                let cx = if f["center"]["x"].is_null() { 0.5 } else { cx };
                let cy = if f["center"]["y"].is_null() { 0.5 } else { cy };
                let rot = -(n0(&f["rotation"]) * PI) / 180.0;
                let or1 = |v: &Value| {
                    let x = if v.is_null() { 1.0 } else { js::number(v) };
                    if ftruthy(x) { x } else { 1.0 }
                };
                let mm = if kind == "linear" {
                    let l = or1(&f["size"]["height"]);
                    let th = rot - PI / 2.0;
                    let dir = (th.cos(), th.sin());
                    let perp = (th.sin() * l, -th.cos() * l);
                    let s = (cx - (l / 2.0) * dir.0, cy - (l / 2.0) * dir.1);
                    m(l * dir.0, l * dir.1, perp.0, perp.1, s.0 - perp.0 / 2.0, s.1 - perp.1 / 2.0)
                } else {
                    let psi = rot - PI / 2.0;
                    let (h, w) = (or1(&f["size"]["height"]) / 2.0, or1(&f["size"]["width"]) / 2.0);
                    let (u, v) = ((h * psi.cos(), h * psi.sin()), (-w * psi.sin(), w * psi.cos()));
                    m(2.0 * u.0, 2.0 * u.1, 2.0 * v.0, 2.0 * v.1, cx - u.0 - v.0, cy - u.1 - v.1)
                };
                let stops: Vec<Value> = list(&f["colors"])
                    .iter()
                    .map(|s| json!({ "color": rgba(&s["color"]).unwrap_or(json!({ "r": 0, "g": 0, "b": 0, "a": 1 })), "position": num(n0(&s["position"])) }))
                    .collect();
                Some(json!({ "type": format!("GRADIENT_{}", kind.to_uppercase()), "transform": fig_t(&invert(&mm)), "stops": stops, "opacity": opacity, "visible": visible, "blendMode": blend_mode }))
            }
            Some("image") => {
                let hash = self.image(&f["url"])?;
                let mode = match f["mode"].as_str() {
                    Some("contain") => "FIT",
                    Some("stretch") => "STRETCH",
                    _ => "FILL",
                };
                let t = match &f["transform"] {
                    Value::Array(a) if mode == "STRETCH" => {
                        let g = |i: usize| a.get(i).map_or(f64::NAN, js::number);
                        fig_t(&invert(&m(g(0), g(1), g(2), g(3), g(4), g(5))))
                    }
                    _ => identity(),
                };
                Some(json!({ "type": "IMAGE", "image": { "hash": hash, "name": "image" }, "imageScaleMode": mode, "transform": t, "opacity": opacity, "scale": 0.5, "visible": visible, "blendMode": blend_mode }))
            }
            _ => None,
        }
    }
    fn paints(&mut self, v: &Value) -> Vec<Value> {
        list(v).into_iter().filter_map(|f| self.paint(f)).collect()
    }

    fn node(&mut self, n: &Value, parent_guid: &Value, index: usize, count: usize, parent: Option<&Value>) -> Result<()> {
        let w = js::max(0.0, n0(&n["w"]));
        let h = js::max(0.0, n0(&n["h"]));
        let id = json!({ "sessionID": 1, "localID": self.local_id });
        self.local_id += 1;
        let mut mm = mul(&m(1.0, 0.0, 0.0, 1.0, n0(&n["x"]), n0(&n["y"])), &turn((-n0(&n["rotation"]) * PI) / 180.0));
        let (fx, fy) = (truthy(&n["flipX"]), truthy(&n["flipY"]));
        if fx || fy {
            mm = mul(&mm, &m(if fx { -1.0 } else { 1.0 }, 0.0, 0.0, if fy { -1.0 } else { 1.0 }, if fx { w } else { 0.0 }, if fy { h } else { 0.0 }));
        }
        let mut out = base();
        out.insert("guid".into(), id.clone());
        out.insert("parentIndex".into(), json!({ "guid": parent_guid, "position": position(index, count) }));
        out.insert("name".into(), if n["name"].is_null() { n["type"].clone() } else { n["name"].clone() });
        out.insert("size".into(), json!({ "x": num(w), "y": num(h) }));
        if n["enabled"] == false {
            out.insert("visible".into(), false.into());
        }
        if !n["opacity"].is_null() {
            out.insert("opacity".into(), num(js::number(&n["opacity"])));
        }
        let fills = self.paints(&n["fill"]);
        let strokes = self.paints(&n["stroke"]);
        let fx_out: Vec<Value> = list(&n["effect"])
            .into_iter()
            .filter_map(|e| {
                let visible = e["enabled"] != false;
                match e["type"].as_str() {
                    Some(t @ ("blur" | "background_blur")) => Some(json!({ "type": if t == "blur" { "FOREGROUND_BLUR" } else { "BACKGROUND_BLUR" }, "radius": num(n0(&e["radius"]) / 0.875), "visible": visible })),
                    Some("shadow") => Some(json!({ "type": if e["shadowType"] == "inner" { "INNER_SHADOW" } else { "DROP_SHADOW" },
                        "color": rgba(&e["color"]).unwrap_or(json!({ "r": 0, "g": 0, "b": 0, "a": 0.25 })),
                        "offset": { "x": num(n0(&e["offset"]["x"])), "y": num(n0(&e["offset"]["y"])) }, "radius": num(n0(&e["blur"]) / 0.875),
                        "spread": num(n0(&e["spread"])), "visible": visible, "blendMode": blend_out(&e["blendMode"]), "showShadowBehindNode": false })),
                    _ => None,
                }
            })
            .collect();
        if !fx_out.is_empty() {
            out.insert("effects".into(), fx_out.into());
        }
        if !strokes.is_empty() {
            out.insert("strokePaints".into(), strokes.clone().into());
            let align = match n["strokeAlignment"].as_str() {
                Some("inner") => "INSIDE",
                Some("outer") => "OUTSIDE",
                _ => "CENTER",
            };
            out.insert("strokeAlign".into(), align.into());
            let sw = if n["strokeWidth"].is_null() { json!(1) } else { n["strokeWidth"].clone() };
            if sw.is_object() || sw.is_array() {
                let s = |k: &str| if sw[k].is_null() { 0.0 } else { js::number(&sw[k]) };
                let mx = [s("top"), s("right"), s("bottom"), s("left")].into_iter().fold(f64::NEG_INFINITY, js::max);
                out.insert("borderStrokeWeightsIndependent".into(), true.into());
                out.insert("strokeWeight".into(), num(mx));
                for (k, f) in [("borderTopWeight", "top"), ("borderRightWeight", "right"), ("borderBottomWeight", "bottom"), ("borderLeftWeight", "left")] {
                    out.insert(k.into(), if sw[f].is_null() { 0.into() } else { sw[f].clone() });
                }
            } else {
                out.insert("strokeWeight".into(), num(n0(&sw)));
            }
            if truthy(&n["strokeLinejoin"]) {
                out.insert("strokeJoin".into(), js::string(&n["strokeLinejoin"]).to_uppercase().into());
            }
            if truthy(&n["strokeLinecap"]) {
                let cap = if n["strokeLinecap"] == "butt" { "NONE".into() } else { js::string(&n["strokeLinecap"]).to_uppercase() };
                out.insert("strokeCap".into(), cap.into());
            }
        }
        let r = &n["cornerRadius"];
        let corners = |out: &mut serde_json::Map<String, Value>| {
            if r.is_null() {
                return;
            }
            let v: Vec<f64> = match r {
                Value::Array(a) => (0..4).map(|i| a.get(i).map_or(0.0, n0)).collect(),
                r => vec![n0(r); 4],
            };
            let (tl, tr, br, bl) = (v[0], v[1], v[2], v[3]);
            out.insert("cornerRadius".into(), num(tl));
            out.insert("rectangleTopLeftCornerRadius".into(), num(tl));
            out.insert("rectangleTopRightCornerRadius".into(), num(tr));
            out.insert("rectangleBottomRightCornerRadius".into(), num(br));
            out.insert("rectangleBottomLeftCornerRadius".into(), num(bl));
            out.insert("rectangleCornerRadiiIndependent".into(), (r.is_array() && !(tl == tr && tr == br && br == bl)).into());
        };
        // auto layout: the parent's flow and this node's sizing in it
        let pdir = match parent {
            Some(p) if p["type"] == "frame" => p["layout"].as_str().unwrap_or("horizontal"),
            _ => "none",
        };
        if pdir != "none" {
            if n["layoutPosition"] == "absolute" {
                out.insert("stackPositioning".into(), "ABSOLUTE".into());
            }
            let (main, cross) = if pdir == "horizontal" { (&n["width"], &n["height"]) } else { (&n["height"], &n["width"]) };
            if is_fill(main) {
                out.insert("stackChildPrimaryGrow".into(), 1.into());
            }
            if is_fill(cross) {
                out.insert("stackChildAlignSelf".into(), "STRETCH".into());
            }
        }
        let mut kids: Option<&Value> = None;
        let set_fills = |out: &mut serde_json::Map<String, Value>| {
            if !fills.is_empty() {
                out.insert("fillPaints".into(), fills.clone().into());
            }
        };
        match n["type"].as_str().unwrap_or("") {
            "frame" => {
                out.insert("type".into(), "FRAME".into());
                out.insert("frameMaskDisabled".into(), (!truthy(&n["clip"])).into());
                set_fills(&mut out);
                corners(&mut out);
                let layout = n["layout"].as_str().map_or_else(|| if n["layout"].is_null() { "horizontal".into() } else { js::string(&n["layout"]) }, String::from);
                if layout != "none" {
                    let fit = |v: &Value| v.is_null() || js::string(v).starts_with("fit_content");
                    let (main, cross) = if layout == "horizontal" { (&n["width"], &n["height"]) } else { (&n["height"], &n["width"]) };
                    let pad = padding4(&n["padding"]);
                    let p = |i: usize| pad.get(i).cloned().unwrap_or(Value::Null);
                    let sizing = |v: &Value| if fit(v) { "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE" } else { "FIXED" };
                    let justify = match n["justifyContent"].as_str() {
                        Some("center") => "CENTER",
                        Some("end") => "MAX",
                        Some("space_between") => "SPACE_BETWEEN",
                        Some("space_around") => "SPACE_AROUND",
                        _ => "MIN",
                    };
                    let align = match n["alignItems"].as_str() {
                        Some("center") => "CENTER",
                        Some("end") => "MAX",
                        _ => "MIN",
                    };
                    for (k, v) in [
                        ("stackMode", layout.to_uppercase().into()),
                        ("stackSpacing", num(n0(&n["gap"]))),
                        ("stackVerticalPadding", p(0)),
                        ("stackPaddingRight", p(1)),
                        ("stackPaddingBottom", p(2)),
                        ("stackHorizontalPadding", p(3)),
                        ("stackPrimarySizing", sizing(main).into()),
                        ("stackCounterSizing", sizing(cross).into()),
                        ("stackPrimaryAlignItems", justify.into()),
                        ("stackCounterAlignItems", align.into()),
                    ] {
                        out.insert(k.into(), v);
                    }
                    if truthy(&n["layoutIncludeStroke"]) {
                        out.insert("bordersTakeSpace".into(), true.into());
                    }
                }
                kids = Some(&n["children"]);
            }
            "group" => {
                out.insert("type".into(), "FRAME".into());
                out.insert("resizeToFit".into(), true.into());
                out.insert("frameMaskDisabled".into(), true.into());
                kids = Some(&n["children"]);
            }
            "rectangle" => {
                out.insert("type".into(), "ROUNDED_RECTANGLE".into());
                set_fills(&mut out);
                corners(&mut out);
            }
            "ellipse" => {
                out.insert("type".into(), "ELLIPSE".into());
                set_fills(&mut out);
                let start = -(n0(&n["startAngle"]) * PI) / 180.0;
                let sweep = if n["sweepAngle"].is_null() { -360.0 } else { js::number(&n["sweepAngle"]) };
                if truthy(&n["innerRadius"]) || truthy(&n["startAngle"]) || sweep.abs() != 360.0 {
                    out.insert("arcData".into(), json!({ "startingAngle": num(start), "endingAngle": num(start - (sweep * PI) / 180.0), "innerRadius": num(n0(&n["innerRadius"])) }));
                }
            }
            "polygon" => {
                out.insert("type".into(), "REGULAR_POLYGON".into());
                let c = n0(&n["polygonCount"]);
                out.insert("count".into(), num(if c != 0.0 { c } else { 3.0 }));
                set_fills(&mut out);
                if truthy(r) {
                    out.insert("cornerRadius".into(), num(n0(if r.is_array() { &r[0] } else { r })));
                }
            }
            "line" => {
                // Figma lines are horizontal: rotate onto the box diagonal
                out.insert("type".into(), "LINE".into());
                out.insert("size".into(), json!({ "x": num(w.hypot(h)), "y": 0 }));
                mm = mul(&mm, &turn(h.atan2(w)));
                if strokes.is_empty() && !fills.is_empty() {
                    out.insert("strokePaints".into(), fills.clone().into());
                    out.insert("strokeWeight".into(), 1.into());
                }
            }
            "path" => {
                out.insert("type".into(), "VECTOR".into());
                set_fills(&mut out);
                let d = if n["geometry"].is_null() { String::new() } else { js::string(&n["geometry"]) };
                let cmds = svg_commands(&d);
                let pts: Vec<(f64, f64)> = cmds
                    .iter()
                    .flat_map(|c| match *c {
                        Cmd::M(x, y) | Cmd::L(x, y) => vec![(x, y)],
                        Cmd::C(a, b, c, d, e, f) => vec![(a, b), (c, d), (e, f)],
                        Cmd::Z => vec![],
                    })
                    .collect();
                let vb: [f64; 4] = if let Value::Array(a) = &n["viewBox"] {
                    std::array::from_fn(|i| a.get(i).map_or(f64::NAN, js::number))
                } else if !pts.is_empty() {
                    let (x0, y0) = (pts.iter().map(|p| p.0).fold(f64::INFINITY, js::min), pts.iter().map(|p| p.1).fold(f64::INFINITY, js::min));
                    let (x1, y1) = (pts.iter().map(|p| p.0).fold(f64::NEG_INFINITY, js::max), pts.iter().map(|p| p.1).fold(f64::NEG_INFINITY, js::max));
                    let or1 = |v: f64| if ftruthy(v) { v } else { 1.0 };
                    [x0, y0, or1(x1 - x0), or1(y1 - y0)]
                } else {
                    [0.0, 0.0, 1.0, 1.0]
                };
                let or1 = |v: f64| if ftruthy(v) { v } else { 1.0 };
                let (kx, ky) = (w / or1(vb[2]), h / or1(vb[3]));
                let (tx, ty) = (|v: f64| (v - vb[0]) * kx, |v: f64| (v - vb[1]) * ky);
                let cmds: Vec<Cmd> = cmds
                    .into_iter()
                    .map(|c| match c {
                        Cmd::M(x, y) => Cmd::M(tx(x), ty(y)),
                        Cmd::L(x, y) => Cmd::L(tx(x), ty(y)),
                        Cmd::C(a, b, c, d, e, f) => Cmd::C(tx(a), ty(b), tx(c), ty(d), tx(e), ty(f)),
                        Cmd::Z => Cmd::Z,
                    })
                    .collect();
                self.blobs.push(json!({ "bytes": hex(&network_blob(&cmds, n["fillRule"] == "evenodd")) }));
                out.insert("vectorData".into(), json!({ "vectorNetworkBlob": self.blobs.len() - 1, "normalizedSize": { "x": num(w), "y": num(h) } }));
            }
            "text" => {
                out.insert("type".into(), "TEXT".into());
                set_fills(&mut out);
                let fs = n0(&n["fontSize"]);
                let fs = if fs != 0.0 { fs } else { 14.0 };
                let family = if truthy(&n["fontFamily"]) { n["fontFamily"].clone() } else { "Inter".into() };
                let content = if n["content"].is_null() { String::new() } else { js::string(&n["content"]) };
                let lh = if truthy(&n["lineHeight"]) { json!({ "value": num(js::number(&n["lineHeight"])), "units": "RAW" }) } else { json!({ "value": 100, "units": "PERCENT" }) };
                let entries = [
                    ("textData", json!({ "characters": content })),
                    ("fontSize", num(fs)),
                    ("fontName", json!({ "family": family, "style": font_style(&n["fontWeight"], n["fontStyle"] == "italic"), "postscript": "" })),
                    ("textAutoResize", match n["textGrowth"].as_str() { Some("fixed-width") => "HEIGHT", Some("fixed-width-height") => "NONE", _ => "WIDTH_AND_HEIGHT" }.into()),
                    ("textAlignHorizontal", match n["textAlign"].as_str() { Some("center") => "CENTER", Some("right") => "RIGHT", Some("justify") => "JUSTIFIED", _ => "LEFT" }.into()),
                    ("textAlignVertical", match n["textAlignVertical"].as_str() { Some("middle") => "CENTER", Some("bottom") => "BOTTOM", _ => "TOP" }.into()),
                    ("lineHeight", lh),
                    ("letterSpacing", json!({ "value": num(n0(&n["letterSpacing"])), "units": "PIXELS" })),
                    ("textDecoration", if truthy(&n["underline"]) { "UNDERLINE" } else if truthy(&n["strikethrough"]) { "STRIKETHROUGH" } else { "NONE" }.into()),
                ];
                for (k, v) in entries {
                    out.insert(k.into(), v);
                }
            }
            "icon" => {
                // rendered by the editor
                let hash = self.image(&n["png"]);
                out.insert("type".into(), "ROUNDED_RECTANGLE".into());
                let fp = match hash {
                    Some(hash) => json!([{ "type": "IMAGE", "image": { "hash": hash, "name": "icon" }, "imageScaleMode": "FIT", "transform": identity(), "opacity": 1, "scale": 0.5, "visible": true, "blendMode": "NORMAL" }]),
                    None => json!([]),
                };
                out.insert("fillPaints".into(), fp);
            }
            _ => {
                // notes, prompts, browser previews: pen-only
                self.local_id -= 1;
                return Ok(());
            }
        }
        out.insert("transform".into(), fig_t(&mm));
        self.node_changes.push(Value::Object(out));
        let shown: Vec<&Value> = kids.map(|k| list(k)).unwrap_or_default().into_iter().filter(|c| truthy(c)).collect();
        for (i, c) in shown.iter().enumerate() {
            self.node(c, &id, i, shown.len(), Some(n))?;
        }
        Ok(())
    }
}

// Date#toISOString for the meta.json timestamp.
fn iso_now() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let (secs, ms) = (d.as_secs() as i64, d.subsec_millis());
    let (days, rem) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // civil-from-days (Howard Hinnant)
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + (month <= 2) as i64;
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{ms:03}Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// roots: laid-out .pen nodes ({ ...props, x, y, w, h, children }), name: file name, read_image(url) → bytes,
/// thumbnail: PNG bytes. Returns the .fig (zip) bytes.
pub fn export_figma(roots: &Value, name: &str, read_image: &dyn Fn(&str) -> Option<Vec<u8>>, thumbnail: Option<&[u8]>) -> Result<Vec<u8>> {
    let Value::Array(roots) = roots else { bail!("roots must be an array") };
    let (schema_bytes, schema) = fig_schema();
    let mut cx = Ctx { files: IndexMap::new(), blobs: vec![], node_changes: vec![], images: HashMap::new(), local_id: 1, read_image };
    let mut doc = base();
    for (k, v) in [("guid", json!({ "sessionID": 0, "localID": 0 })), ("type", "DOCUMENT".into()), ("name", "Document".into()), ("transform", identity()), ("strokeJoin", "BEVEL".into())] {
        doc.insert(k.into(), v);
    }
    cx.node_changes.push(Value::Object(doc));
    let page = json!({ "sessionID": 0, "localID": 1 });
    let mut p = base();
    for (k, v) in [
        ("guid", page.clone()),
        ("parentIndex", json!({ "guid": { "sessionID": 0, "localID": 0 }, "position": "!" })),
        ("type", "CANVAS".into()),
        ("name", "Page 1".into()),
        ("transform", identity()),
        ("backgroundOpacity", 1.into()),
        ("backgroundColor", json!({ "r": 0.96, "g": 0.96, "b": 0.96, "a": 1 })),
        ("backgroundEnabled", true.into()),
        ("strokeJoin", "BEVEL".into()),
    ] {
        p.insert(k.into(), v);
    }
    cx.node_changes.push(Value::Object(p));
    let mut internal = base();
    for (k, v) in [
        ("guid", json!({ "sessionID": 0, "localID": 2 })),
        ("parentIndex", json!({ "guid": { "sessionID": 0, "localID": 0 }, "position": "~" })),
        ("type", "CANVAS".into()),
        ("name", "Internal Only Canvas".into()),
        ("visible", false.into()),
        ("internalOnly", true.into()),
        ("transform", identity()),
        ("strokeJoin", "BEVEL".into()),
    ] {
        internal.insert(k.into(), v);
    }
    cx.node_changes.push(Value::Object(internal));

    for (i, r) in roots.iter().enumerate() {
        cx.node(r, &page, i, roots.len(), None)?;
    }

    let message = schema.encode_message(&json!({ "type": "NODE_CHANGES", "sessionID": 0, "ackID": 0, "nodeChanges": cx.node_changes, "blobs": cx.blobs }))?;
    let mut deflated = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::new(6));
    deflated.write_all(&message)?;
    let deflated = deflated.finish()?;
    let mut canvas = b"fig-kiwi".to_vec();
    canvas.extend_from_slice(&FIG_VERSION.to_le_bytes());
    for c in [schema_bytes.as_slice(), &deflated] {
        canvas.extend_from_slice(&(c.len() as u32).to_le_bytes());
        canvas.extend_from_slice(c);
    }
    let mut files = std::mem::take(&mut cx.files);
    files.insert("canvas.fig".into(), (canvas, false));
    let x = |r: &Value, k: &str| n0(&r[k]);
    let render = if roots.is_empty() {
        json!({ "x": 0, "y": 0, "width": 1, "height": 1 })
    } else {
        let fold = |f: &dyn Fn(&Value) -> f64, init: f64, op: fn(f64, f64) -> f64| roots.iter().map(f).fold(init, op);
        let (x0, y0) = (fold(&|r| x(r, "x"), f64::INFINITY, js::min), fold(&|r| x(r, "y"), f64::INFINITY, js::min));
        let x1 = fold(&|r| x(r, "x") + x(r, "w"), f64::NEG_INFINITY, js::max);
        let y1 = fold(&|r| x(r, "y") + x(r, "h"), f64::NEG_INFINITY, js::max);
        json!({ "x": num(x0), "y": num(y0), "width": num(x1 - x0), "height": num(y1 - y0) })
    };
    let meta = json!({ "client_meta": { "background_color": { "r": 0.96, "g": 0.96, "b": 0.96, "a": 1 }, "thumbnail_size": { "width": 400, "height": 300 }, "render_coordinates": render },
        "file_name": name, "developer_related_links": [], "exported_at": iso_now() });
    files.insert("meta.json".into(), (serde_json::to_vec(&meta)?, false));
    if let Some(t) = thumbnail {
        files.insert("thumbnail.png".into(), (t.to_vec(), true));
    }

    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (path, (bytes, stored)) in files {
        let opts = zip::write::SimpleFileOptions::default();
        let opts = if stored { opts.compression_method(zip::CompressionMethod::Stored) } else { opts.compression_method(zip::CompressionMethod::Deflated).compression_level(Some(6)) };
        zip.start_file(path, opts)?;
        zip.write_all(&bytes)?;
    }
    Ok(zip.finish()?.into_inner())
}
