// public/scene.js: the scene graph of a .pen document, pen.dev's 5-pass layout solver (fit/fill per axis, then
// positions), SkParagraph text and the Skia drawing of every node (fills, strokes, shadows, blurs, images, icons,
// shaders). Only what exports use is here: no picture caching, level of detail, tiles or hit testing.
use crate::core::{self as js, get, is_false, js_string, list, num0, number, resolve, round, truthy, Theme};
use crate::fonts::{font_style, weight_of};
use crate::shader::{self, Auto};
use crate::Ctx;
use serde_json::{Map, Value};
use skia_safe::canvas::{SaveLayerRec, SrcRectConstraint};
use skia_safe::font_arguments::{variation_position::Coordinate, VariationPosition};
#[allow(deprecated)]
use skia_safe::gradient_shader::{self, GradientShaderColors};
use skia_safe::textlayout::{Paragraph, ParagraphBuilder, ParagraphStyle, StrutStyle, TextAlign, TextDecoration, TextStyle as SkTextStyle};
use skia_safe::{
    image_filters, paint, BlendMode, BlurStyle, Canvas, ClipOp, Color4f, FilterMode, FontArguments, MaskFilter, Matrix, MipmapMode, Paint, Path, PathFillType, Picture, PictureRecorder,
    RRect, Rect, SamplingOptions, Shader, TileMode, Vector,
};
use std::cell::Cell;
use std::collections::HashMap;
use std::rc::Rc;

const H: usize = 0;
const V: usize = 1;
const FIXED: u8 = 0;
const FIT: u8 = 2;
const FILL: u8 = 3;

// ---------------------------------------------------------------- matrices (row-major 3x3, like CanvasKit's)
pub type M = [f64; 9];
pub const IDENTITY: M = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
pub fn mul(a: &M, b: &M) -> M {
    let mut out = [0.0; 9];
    for r in 0..3 {
        for c in 0..3 {
            out[r * 3 + c] = (0..3).map(|k| a[r * 3 + k] * b[k * 3 + c]).sum();
        }
    }
    out
}
pub fn invert(m: &M) -> Option<M> {
    let det = m[0] * m[4] * m[8] + m[1] * m[5] * m[6] + m[2] * m[3] * m[7] - m[2] * m[4] * m[6] - m[1] * m[3] * m[8] - m[0] * m[5] * m[7];
    if det == 0.0 || det.is_nan() {
        return None;
    }
    Some([
        (m[4] * m[8] - m[5] * m[7]) / det,
        (m[2] * m[7] - m[1] * m[8]) / det,
        (m[1] * m[5] - m[2] * m[4]) / det,
        (m[5] * m[6] - m[3] * m[8]) / det,
        (m[0] * m[8] - m[2] * m[6]) / det,
        (m[2] * m[3] - m[0] * m[5]) / det,
        (m[3] * m[7] - m[4] * m[6]) / det,
        (m[1] * m[6] - m[0] * m[7]) / det,
        (m[0] * m[4] - m[1] * m[3]) / det,
    ])
}
const fn translated(x: f64, y: f64) -> M {
    [1.0, 0.0, x, 0.0, 1.0, y, 0.0, 0.0, 1.0]
}
fn rotated(rad: f64, px: f64, py: f64) -> M {
    let (s, c) = rad.sin_cos();
    [c, -s, s * py + (1.0 - c) * px, s, c, -s * px + (1.0 - c) * py, 0.0, 0.0, 1.0]
}
fn scaled(sx: f64, sy: f64, px: f64, py: f64) -> M {
    [sx, 0.0, px - sx * px, 0.0, sy, py - sy * py, 0.0, 0.0, 1.0]
}
pub fn sk(m: &M) -> Matrix {
    let f = |i: usize| m[i] as f32;
    Matrix::new_all(f(0), f(1), f(2), f(3), f(4), f(5), f(6), f(7), f(8))
}
fn ltrb(r: [f64; 4]) -> Rect {
    Rect::new(r[0] as f32, r[1] as f32, r[2] as f32, r[3] as f32)
}
fn xywh(x: f64, y: f64, w: f64, h: f64) -> Rect {
    ltrb([x, y, x + w, y + h])
}
/// Math.max/min with NaN propagation, as in JS
fn jmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}
fn jmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}
fn max_all(v: &[f64]) -> f64 {
    v.iter().copied().fold(f64::NEG_INFINITY, jmax)
}
fn min_all(v: &[f64]) -> f64 {
    v.iter().copied().fold(f64::INFINITY, jmin)
}

// ---------------------------------------------------------------- values
fn parse_size(v: &Value, dflt: (u8, f64)) -> (u8, f64) {
    if let Value::Number(n) = v {
        return (FIXED, n.as_f64().unwrap_or(0.0));
    }
    let s = if v.is_null() { String::new() } else { js_string(v) };
    // /^(\w+)(?:\((-?[\d.]+)\))?$/
    let (word, arg) = match s.find('(') {
        Some(i) if s.ends_with(')') => (&s[..i], Some(&s[i + 1..s.len() - 1])),
        _ => (s.as_str(), None),
    };
    let is_word = !word.is_empty() && word.chars().all(|c| c.is_alphanumeric() || c == '_');
    let arg_ok = arg.is_none_or(|a| {
        let a = a.strip_prefix('-').unwrap_or(a);
        !a.is_empty() && a.chars().all(|c| c.is_ascii_digit() || c == '.')
    });
    if !is_word || !arg_ok {
        return dflt;
    }
    let n = arg.map(js::str_number).unwrap_or(0.0);
    match word {
        "fill_container" => (FILL, n),
        "fit_content" => (FIT, n),
        _ => dflt,
    }
}
fn padding(p: &Value) -> [f64; 4] {
    match p {
        Value::Null => [0.0; 4],
        Value::Number(n) => [n.as_f64().unwrap_or(0.0); 4],
        _ => {
            let a: Vec<f64> = list(p).into_iter().map(number).collect();
            // [v,h] -> t,r,b,l
            let at = |i: usize| if a.is_empty() { 0.0 } else { let x = a[i % a.len()]; if x.is_nan() { 0.0 } else { x } };
            [at(0), at(1), at(2), at(3)]
        }
    }
}

/// `color()` of scene.js: hex, rgb()/rgba(), 'transparent', 'white'; any other string is opaque black.
pub fn color(s: &Value, alpha: f64) -> Option<[f32; 4]> {
    static HEX: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"(?i)^#([0-9a-f]{3,8})$").unwrap());
    static RGB: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| regex::Regex::new(r"rgba?\(([^)]+)\)").unwrap());
    let Value::String(s) = s else { return None };
    let (mut r, mut g, mut b, mut a) = (0.0f64, 0.0, 0.0, 1.0);
    if let Some(m) = HEX.captures(s.trim()) {
        let mut x = m[1].to_string();
        if x.len() <= 4 {
            x = x.chars().flat_map(|c| [c, c]).collect();
        }
        let hex = |i: usize| if i < x.len() { i64::from_str_radix(&x[i..(i + 2).min(x.len())], 16).map(|v| v as f64).unwrap_or(f64::NAN) } else { f64::NAN };
        (r, g, b) = (hex(0), hex(2), hex(4));
        if x.len() == 8 {
            a = hex(6) / 255.0;
        }
    } else if let Some(m) = RGB.captures(s) {
        let parts: Vec<f64> = m[1]
            .split(|c: char| c.is_whitespace() || c == ',' || c == '/')
            .filter(|p| !p.is_empty())
            .enumerate()
            .map(|(i, v)| if let Some(p) = v.strip_suffix('%') { parse_float(p) / 100.0 * if i < 3 { 255.0 } else { 1.0 } } else { js::str_number(v) })
            .collect();
        let at = |i: usize| parts.get(i).copied().unwrap_or(f64::NAN);
        (r, g, b) = (at(0), at(1), at(2));
        a = parts.get(3).copied().unwrap_or(1.0);
    } else if s == "transparent" {
        a = 0.0;
    } else if s == "white" {
        (r, g, b) = (255.0, 255.0, 255.0);
    }
    Some([(r / 255.0) as f32, (g / 255.0) as f32, (b / 255.0) as f32, (a * alpha) as f32])
}
/// JS parseFloat: the longest numeric prefix
fn parse_float(s: &str) -> f64 {
    let t = s.trim_start();
    (0..=t.len()).rev().filter(|e| t.is_char_boundary(*e)).find_map(|e| t[..e].parse::<f64>().ok().filter(|_| !t[..e].contains(|c: char| c.is_ascii_alphabetic() && c != 'e' && c != 'E'))).unwrap_or(f64::NAN)
}
fn c4(c: [f32; 4]) -> Color4f {
    Color4f::new(c[0], c[1], c[2], c[3])
}
const BLACK: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
const TRANSPARENT: [f32; 4] = [0.0; 4];

fn solid_fill(fill: &Value, v: &dyn Fn(&Value) -> Value) -> Value {
    for x in list(fill).into_iter().rev() {
        if x.is_string() {
            return v(x);
        }
        let t = get(x, "type");
        if t == "color" && !is_false(&v(get(x, "enabled"))) {
            return v(get(x, "color"));
        }
        if t == "gradient" {
            return v(get(get(x, "colors").get(0).unwrap_or(&Value::Null), "color"));
        }
    }
    Value::Null
}

fn effect_padding(e: &Value, v: &dyn Fn(&Value) -> Value) -> f64 {
    let r = { let x = get(e, "radius"); if x.is_null() { get(e, "blur") } else { x } };
    let radius = num0(&v(r));
    let off = get(e, "offset");
    let offset = num0(&v(get(off, "x"))).abs().max(num0(&v(get(off, "y"))).abs());
    3.0 * radius + num0(&v(get(e, "spread"))).abs() + offset
}

// ---------------------------------------------------------------- text
#[derive(Clone, Debug)]
pub enum Content {
    Text(String),
    Spans(Vec<Value>),
}
#[derive(Clone, Debug)]
pub struct TextStyle {
    pub family: String,
    pub size: f64,
    pub weight: f64,
    pub italic: bool,
    pub lh: f64,
    pub ls: f64,
    pub align: String,
    pub under: bool,
    pub strike: bool,
    pub color: Value,
    pub content: Content,
    pub ps: f64,
}
pub enum Para {
    One(Paragraph),
    Stack(Vec<Paragraph>, f64),
}
impl Para {
    pub fn layout(&mut self, w: f64) {
        match self {
            Para::One(p) => p.layout(w as f32),
            Para::Stack(ps, _) => ps.iter_mut().for_each(|p| p.layout(w as f32)),
        }
    }
    pub fn height(&self) -> f64 {
        match self {
            Para::One(p) => p.height() as f64,
            Para::Stack(ps, gap) => ps.iter().map(|p| p.height() as f64).sum::<f64>() + gap * (ps.len() as f64 - 1.0),
        }
    }
    pub fn max_intrinsic_width(&self) -> f64 {
        match self {
            Para::One(p) => p.max_intrinsic_width() as f64,
            Para::Stack(ps, _) => max_all(&ps.iter().map(|p| p.max_intrinsic_width() as f64).collect::<Vec<_>>()),
        }
    }
    fn draw(&self, canvas: &Canvas, x: f64, mut y: f64) {
        match self {
            Para::One(p) => p.paint(canvas, (x as f32, y as f32)),
            Para::Stack(ps, gap) => {
                for p in ps {
                    p.paint(canvas, (x as f32, y as f32));
                    y += p.height() as f64 + gap;
                }
            }
        }
    }
}

// split text (string or spans) at line breaks
fn paragraphs(content: &Content) -> Vec<Content> {
    match content {
        Content::Text(s) => s.split('\n').map(|p| Content::Text(p.into())).collect(),
        Content::Spans(spans) => {
            let mut out: Vec<Vec<Value>> = vec![vec![]];
            for sp in spans {
                let text = { let c = get(sp, "content"); if c.is_null() { String::new() } else { js_string(c) } };
                for (i, piece) in text.split('\n').enumerate() {
                    if i > 0 {
                        out.push(vec![]);
                    }
                    if !piece.is_empty() {
                        let mut o = sp.clone();
                        if let Value::Object(m) = &mut o {
                            m.insert("content".into(), Value::String(piece.into()));
                        }
                        out.last_mut().unwrap().push(o);
                    }
                }
            }
            out.into_iter().map(Content::Spans).collect()
        }
    }
}

fn decoration(under: bool, strike: bool) -> TextDecoration {
    let mut d = TextDecoration::NO_DECORATION;
    if under {
        d |= TextDecoration::UNDERLINE;
    }
    if strike {
        d |= TextDecoration::LINE_THROUGH;
    }
    d
}
fn wght(weight: f64) -> [Coordinate; 1] {
    [Coordinate { axis: Coordinate::wght, value: weight as f32 }]
}
fn base_text_style(families: &[String], size: f64, weight: f64, italic: bool, ls: f64, lh: Option<f64>, color: [f32; 4], under: bool, strike: bool) -> SkTextStyle {
    let mut ts = SkTextStyle::new();
    ts.set_color(c4(color).to_color());
    ts.set_font_families(families);
    ts.set_font_size(size as f32);
    ts.set_font_style(font_style(weight, italic));
    let coords = wght(weight);
    let args = FontArguments::new().set_variation_design_position(VariationPosition { coordinates: &coords });
    ts.set_font_arguments(&args);
    ts.set_letter_spacing(ls as f32);
    if let Some(lh) = lh {
        ts.set_height(lh as f32);
        ts.set_height_override(true);
        ts.set_half_leading(true);
    }
    ts.set_decoration_type(decoration(under, strike));
    ts
}

/// Paragraph for a text style (pen.dev's mapping). Fonts load synchronously, before the families are picked.
pub fn build_paragraph(t: &TextStyle, cx: &mut Ctx) -> Para {
    if t.ps != 0.0 && !t.ps.is_nan() && paragraphs(&t.content).len() > 1 {
        let parts = paragraphs(&t.content).into_iter().map(|c| match build_paragraph(&TextStyle { ps: 0.0, content: c, ..t.clone() }, cx) {
            Para::One(p) => p,
            Para::Stack(..) => unreachable!(),
        });
        return Para::Stack(parts.collect(), t.ps);
    }
    let fetch = cx.fetch;
    let fonts = &mut cx.c.fonts;
    fonts.ensure(&t.family, t.weight, t.italic, fetch);
    fonts.ensure("Inter", t.weight, false, fetch);
    let families: Vec<String> = [Some(fonts.alias(&t.family, t.weight, t.italic).unwrap_or_else(|| t.family.clone())), fonts.alias("Inter", t.weight, false), fonts.alias("Noto Color Emoji", 400.0, false)]
        .into_iter()
        .flatten()
        .filter(|f| !f.is_empty())
        .collect();
    let lh = (t.lh != 0.0 && !t.lh.is_nan()).then(|| round(t.lh * t.size) / t.size);
    let base_color = color(&t.color, 1.0).unwrap_or(BLACK);
    let ts = base_text_style(&families, t.size, t.weight, t.italic, t.ls, lh, base_color, t.under, t.strike);
    // spans with their own size/line height: each line is as tall as its tallest run (Figma), so no forced strut
    let mixed = matches!(&t.content, Content::Spans(s) if s.iter().any(|sp| !get(sp, "fontSize").is_null() || !get(sp, "lineHeight").is_null()));
    let mut style = ParagraphStyle::new();
    style.set_text_style(&ts);
    style.set_text_align(match t.align.as_str() {
        "center" => TextAlign::Center,
        "right" => TextAlign::Right,
        "justify" => TextAlign::Justify,
        _ => TextAlign::Left,
    });
    style.set_apply_rounding_hack(false);
    style.set_replace_tab_characters(true);
    if let (Some(lh), false) = (lh, mixed) {
        let mut strut = StrutStyle::new();
        strut.set_strut_enabled(true);
        strut.set_force_strut_height(true);
        strut.set_font_families(&families[..1.min(families.len())]);
        strut.set_font_size(t.size as f32);
        strut.set_height(lh as f32);
        strut.set_height_override(true);
        strut.set_half_leading(true);
        strut.set_leading(0.0);
        style.set_strut_style(strut);
    }
    let spans: Vec<(SkTextStyle, String)> = match &t.content {
        Content::Text(_) => vec![],
        Content::Spans(spans) => spans
            .iter()
            .map(|sp| {
                // styled spans: each overrides the text's own style (and color: `fill`, Pena's)
                let family = { let f = get(sp, "fontFamily"); if f.is_null() { t.family.clone() } else { js_string(f) } };
                let weight = { let w = get(sp, "fontWeight"); if w.is_null() { t.weight } else { weight_of(w) } };
                let italic = { let s = get(sp, "fontStyle"); if truthy(s) { s == "italic" } else { t.italic } };
                if family != t.family || weight != t.weight || italic != t.italic {
                    cx.c.fonts.ensure(&family, weight, italic, fetch);
                }
                let under = { let u = get(sp, "underline"); if u.is_null() { t.under } else { truthy(u) } };
                let strike = { let u = get(sp, "strikethrough"); if u.is_null() { t.strike } else { truthy(u) } };
                let size = { let s = num0(get(sp, "fontSize")); if s == 0.0 { t.size } else { s } };
                let sp_lh = { let l = get(sp, "lineHeight"); if l.is_null() { t.lh } else { number(l) } };
                let mut fams = vec![cx.c.fonts.alias(&family, weight, italic).unwrap_or(family)];
                fams.extend(families.iter().skip(1).cloned());
                let span_lh = if sp_lh != 0.0 && !sp_lh.is_nan() { Some(round(sp_lh * size) / size) } else { lh };
                let col = color(&solid_fill(get(sp, "fill"), &|v| v.clone()), 1.0).unwrap_or(base_color);
                let ls = { let l = get(sp, "letterSpacing"); if l.is_null() { t.ls } else { num0(l) } };
                let st = base_text_style(&fams, size, weight, italic, ls, span_lh, col, under, strike);
                (st, { let c = get(sp, "content"); if c.is_null() { String::new() } else { js_string(c) } })
            })
            .collect(),
    };
    let mut b = ParagraphBuilder::new(&style, cx.c.fonts.collection.clone());
    match &t.content {
        Content::Text(s) => {
            b.add_text(s);
        }
        Content::Spans(_) => {
            for (st, text) in &spans {
                b.push_style(st);
                b.add_text(text);
                b.pop();
            }
        }
    }
    let mut p = b.build();
    p.layout(1e9);
    if !p.unresolved_codepoints().is_empty() {
        cx.c.fonts.ensure("Noto Color Emoji", 400.0, false, fetch);
    }
    Para::One(p)
}

// ---------------------------------------------------------------- nodes
pub struct Node<'a> {
    pub src: &'a Value,
    pub parent: Option<usize>,
    pub children: Vec<usize>,
    pub id: String,
    pub ty: String,
    pub theme: Rc<Theme>,
    pub enabled: bool,
    abs: bool,
    dir: Option<usize>,
    sizing: [u8; 2],
    pub w: f64,
    pub h: f64,
    pub x: f64,
    pub y: f64,
    rot: f64,
    flip_x: bool,
    flip_y: bool,
    gap: f64,
    pad: [f64; 4],
    justify: u8,
    align: u8,
    clip: bool,
    opacity: f64,
    draw_pad: f64,
    pub text: Option<(TextStyle, String)>,
    // frozen after layout
    d: Cell<[f64; 2]>,
    ext: Cell<Option<[f64; 4]>>,
}

const NOTES: [&str; 3] = ["note", "prompt", "context"];

pub struct Scene<'a> {
    pub doc: &'a Value,
    pub nodes: Vec<Node<'a>>,
    pub roots: Vec<usize>,
    pub by_id: HashMap<String, usize>,
    pub time: f64,
    /// { node, hit } while capturing a backdrop: everything drawn before `node`, nothing after
    stop: Cell<Option<(usize, bool)>>,
}

impl<'a> Scene<'a> {
    pub fn new(doc: &'a Value, roots: &'a [Value]) -> Self {
        let mut s = Scene { doc, nodes: vec![], roots: vec![], by_id: HashMap::new(), time: 0.0, stop: Cell::new(None) };
        let theme = Rc::new(js::theme_defaults(doc));
        for r in roots {
            let i = s.add(r, None, theme.clone());
            s.roots.push(i);
        }
        s
    }
    fn add(&mut self, src: &'a Value, parent: Option<usize>, theme: Rc<Theme>) -> usize {
        let doc = self.doc;
        let theme = match src.get("theme") {
            Some(Value::Object(t)) => {
                let mut m = (*theme).clone();
                m.extend(t.iter().map(|(k, v)| (k.clone(), v.clone())));
                Rc::new(m)
            }
            _ => theme,
        };
        let p = |k: &str| resolve(doc, get(src, k), &theme);
        let ty = js_string(get(src, "type"));
        let is_frame = ty == "frame";
        let layout = if is_frame { let l = get(src, "layout"); if l.is_null() { "horizontal".to_string() } else { js_string(l) } } else { "none".into() };
        let dir = match layout.as_str() { "vertical" => Some(V), "horizontal" => Some(H), _ => None };
        let dflt = if is_frame { (FIT, 0.0) } else { (FIXED, 0.0) };
        let (sw, sh) = (parse_size(&p("width"), dflt), parse_size(&p("height"), dflt));
        let (mut w, mut h) = (sw.1, sh.1);
        if ty == "icon" && get(src, "width").is_null() {
            w = 24.0;
            h = 24.0;
        }
        let pad = match get(src, "padding") {
            Value::Array(a) => padding(&Value::Array(a.iter().map(|x| resolve(doc, x, &theme)).collect())),
            _ => padding(&p("padding")),
        };
        let opacity = if get(src, "opacity").is_null() { 1.0 } else { let o = p("opacity"); if o.is_null() { f64::NAN } else { number(&o) } };
        let i = self.nodes.len();
        self.nodes.push(Node {
            src,
            parent,
            children: vec![],
            id: js_string(get(src, "id")),
            enabled: !is_false(&p("enabled")),
            abs: get(src, "layoutPosition") == "absolute",
            dir,
            sizing: [sw.0, sh.0],
            w,
            h,
            x: num0(&p("x")),
            y: num0(&p("y")),
            rot: num0(&p("rotation")),
            flip_x: truthy(&p("flipX")),
            flip_y: truthy(&p("flipY")),
            gap: num0(&p("gap")),
            pad,
            justify: match get(src, "justifyContent").as_str() { Some("center") => 1, Some("space_between") => 2, Some("space_around") => 3, Some("end") => 4, _ => 0 },
            align: match get(src, "alignItems").as_str() { Some("center") => 1, Some("end") => 2, _ => 0 },
            clip: truthy(&p("clip")),
            opacity,
            draw_pad: 0.0,
            text: None,
            theme: theme.clone(),
            ty,
            d: Cell::new([0.0; 2]),
            ext: Cell::new(None),
        });
        let kids: Vec<usize> = list(get(src, "children")).into_iter().map(|c| self.add(c, Some(i), theme.clone())).collect();
        let v = |x: &Value| resolve(doc, x, &theme);
        let own_pad = list(get(src, "effect")).into_iter().filter(|e| truthy(e) && !is_false(&v(get(e, "enabled")))).map(|e| effect_padding(e, &v)).fold(0.0, jmax);
        let draw_pad = kids.iter().map(|c| self.nodes[*c].draw_pad).fold(64.0, jmax) + own_pad;
        let n = &mut self.nodes[i];
        n.children = kids;
        n.draw_pad = draw_pad;
        if n.ty == "text" || NOTES.contains(&n.ty.as_str()) {
            let t = text_style(doc, src, &theme);
            let key = format!("{t:?}");
            n.text = Some((t, key));
        }
        self.by_id.insert(self.nodes[i].id.clone(), i);
        i
    }
    pub fn n(&self, i: usize) -> &Node<'a> {
        &self.nodes[i]
    }
    fn p(&self, i: usize, k: &str) -> Value {
        let n = &self.nodes[i];
        resolve(self.doc, get(n.src, k), &n.theme)
    }
    fn v(&self, i: usize, x: &Value) -> Value {
        resolve(self.doc, x, &self.nodes[i].theme)
    }
    fn affects(&self, i: usize) -> bool {
        self.nodes[i].enabled && !self.nodes[i].abs
    }

    // ---- text
    fn para<'p>(&self, i: usize, cx: &'p mut Ctx) -> &'p mut Para {
        let (t, key) = self.nodes[i].text.as_ref().unwrap();
        if !cx.c.paras.contains_key(key) {
            let p = build_paragraph(t, cx);
            if cx.c.paras.len() > 600 {
                cx.c.paras.clear(); // ponytail: drops every shaped paragraph at once instead of LRU
            }
            cx.c.paras.insert(key.clone(), p);
        }
        cx.c.paras.get_mut(key).unwrap()
    }
    /// [w, h] of the text box for a wrap width (Infinity = auto growth)
    fn measure(&self, i: usize, width: f64, cx: &mut Ctx) -> [f64; 2] {
        let key = format!("{}|{}", self.nodes[i].text.as_ref().unwrap().1, js::fmt_num(width));
        if let Some(m) = cx.c.measures.get(&key) {
            return *m;
        }
        let p = self.para(i, cx);
        let m = if width.is_infinite() {
            p.layout(1e9);
            [p.max_intrinsic_width().ceil(), p.height().ceil()]
        } else {
            p.layout(width.ceil());
            [width, p.height().ceil()]
        };
        if cx.c.measures.len() > 5000 {
            cx.c.measures.clear();
        }
        cx.c.measures.insert(key, m);
        m
    }
    fn dims_live(&self, i: usize, cx: &mut Ctx) -> [f64; 2] {
        let n = &self.nodes[i];
        if n.ty == "text" {
            let g = get(n.src, "textGrowth");
            if g.is_null() || g == "auto" {
                return self.measure(i, f64::INFINITY, cx);
            }
            if g == "fixed-width" {
                return [n.w, self.measure(i, n.w, cx)[1]];
            }
        }
        if NOTES.contains(&n.ty.as_str()) {
            let m = self.measure(i, jmax(1.0, n.w - 32.0), cx);
            return [n.w, jmax(n.h, m[1] + 28.0)];
        }
        [n.w, n.h]
    }
    /// dims after layout
    pub fn dims(&self, i: usize) -> [f64; 2] {
        self.nodes[i].d.get()
    }
    fn outer_of(&self, i: usize, [w, h]: [f64; 2]) -> [f64; 4] {
        let rot = self.nodes[i].rot;
        if rot == 0.0 {
            return [w, h, 0.0, 0.0];
        }
        let a = (-rot * std::f64::consts::PI) / 180.0;
        let (c, s) = (a.cos(), a.sin());
        let xs = [0.0, w * c, -h * s, w * c - h * s];
        let ys = [0.0, w * s, h * c, w * s + h * c];
        let (x0, y0) = (min_all(&xs), min_all(&ys));
        [max_all(&xs) - x0, max_all(&ys) - y0, x0, y0]
    }
    fn outer_live(&self, i: usize, cx: &mut Ctx) -> [f64; 4] {
        let d = self.dims_live(i, cx);
        self.outer_of(i, d)
    }
    fn outer(&self, i: usize) -> [f64; 4] {
        self.outer_of(i, self.dims(i))
    }
    /// local-space box of this node and everything drawn by its subtree
    pub fn extent(&self, i: usize) -> [f64; 4] {
        if let Some(e) = self.nodes[i].ext.get() {
            return e;
        }
        let [w, h] = self.dims(i);
        let mut e = [0.0, 0.0, w, h];
        if !self.nodes[i].clip {
            for &c in &self.nodes[i].children {
                let cn = &self.nodes[c];
                if !cn.enabled {
                    continue;
                }
                let ce = self.extent(c);
                if cn.rot != 0.0 {
                    let o = self.outer(c);
                    e = [jmin(e[0], cn.x + o[2]), jmin(e[1], cn.y + o[3]), jmax(e[2], cn.x + o[2] + o[0]), jmax(e[3], cn.y + o[3] + o[1])];
                    continue;
                }
                e = [jmin(e[0], cn.x + ce[0]), jmin(e[1], cn.y + ce[1]), jmax(e[2], cn.x + ce[2]), jmax(e[3], cn.y + ce[3])];
            }
        }
        self.nodes[i].ext.set(Some(e));
        e
    }
    fn commit_size(&mut self, i: usize, ax: usize, v: f64) {
        if ax == H { self.nodes[i].w = v } else { self.nodes[i].h = v }
    }
    fn commit_position(&mut self, i: usize, px: f64, py: f64, cx: &mut Ctx) {
        let o = self.outer_live(i, cx);
        self.nodes[i].x = px - o[2];
        self.nodes[i].y = py - o[3];
    }
    /// local 3x3 matrix: translate, rotate around the top-left, flips around the center
    pub fn matrix(&self, i: usize) -> M {
        let n = &self.nodes[i];
        if n.rot == 0.0 && !n.flip_x && !n.flip_y {
            return translated(n.x, n.y);
        }
        let [w, h] = self.dims(i);
        let mut m = translated(n.x, n.y);
        if n.rot != 0.0 {
            m = mul(&m, &rotated((-n.rot * std::f64::consts::PI) / 180.0, 0.0, 0.0));
        }
        if n.flip_x || n.flip_y {
            m = mul(&m, &scaled(if n.flip_x { -1.0 } else { 1.0 }, if n.flip_y { -1.0 } else { 1.0 }, w / 2.0, h / 2.0));
        }
        m
    }
    pub fn world_matrix(&self, i: usize) -> M {
        let m = self.matrix(i);
        match self.nodes[i].parent {
            Some(p) => mul(&self.world_matrix(p), &m),
            None => m,
        }
    }
    /// world-space axis-aligned bounds [x, y, w, h]
    pub fn bounds(&self, i: usize) -> [f64; 4] {
        let [w, h] = self.dims(i);
        let m = self.world_matrix(i);
        let pts = [[0.0, 0.0], [w, 0.0], [0.0, h], [w, h]].map(|[x, y]| [m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5]]);
        let xs = pts.map(|p| p[0]);
        let ys = pts.map(|p| p[1]);
        [min_all(&xs), min_all(&ys), max_all(&xs) - min_all(&xs), max_all(&ys) - min_all(&ys)]
    }
    fn root_of(&self, mut i: usize) -> usize {
        while let Some(p) = self.nodes[i].parent {
            i = p;
        }
        i
    }
    fn is_inside(&self, node: usize, ancestor: usize) -> bool {
        let mut p = Some(node);
        while let Some(i) = p {
            if i == ancestor {
                return true;
            }
            p = self.nodes[i].parent;
        }
        false
    }

    /// every font the document needs (to load before the first layout)
    pub fn fonts_needed(&self) -> Vec<(String, f64, bool)> {
        let mut out: Vec<(String, f64, bool)> = vec![];
        for n in &self.nodes {
            if let Some((t, _)) = &n.text {
                let k = (t.family.clone(), t.weight, t.italic);
                if !out.contains(&k) {
                    out.push(k);
                }
            }
        }
        out
    }

    // ---- layout (pen.dev's solver, 5 passes)
    fn fit(&mut self, i: usize, ax: usize, cx: &mut Ctx) {
        for c in self.nodes[i].children.clone() {
            self.fit(c, ax, cx);
        }
        if self.nodes[i].ty == "group" {
            // a group hugs its children
            let mut max = 0.0;
            for c in self.nodes[i].children.clone() {
                if self.nodes[c].enabled {
                    let o = self.outer_live(c, cx);
                    let cn = &self.nodes[c];
                    max = jmax(max, (if ax == H { cn.x + o[2] } else { cn.y + o[3] }) + o[ax]);
                }
            }
            self.commit_size(i, ax, max);
            return;
        }
        let n = &self.nodes[i];
        if n.dir.is_none() || n.sizing[ax] != FIT {
            return;
        }
        let (mut sum, mut cnt) = (0.0, 0);
        for c in n.children.clone() {
            if !self.affects(c) || self.nodes[c].sizing[ax] == FILL {
                continue;
            }
            cnt += 1;
            let s = self.outer_live(c, cx)[ax];
            sum = if self.nodes[i].dir == Some(ax) { sum + s } else { jmax(sum, s) };
        }
        if cnt == 0 {
            return;
        }
        let n = &self.nodes[i];
        if n.dir == Some(ax) {
            sum += n.gap * (cnt - 1) as f64;
        }
        let pad = if ax == H { n.pad[1] + n.pad[3] } else { n.pad[0] + n.pad[2] };
        self.commit_size(i, ax, sum + pad);
    }
    fn fill(&mut self, i: usize, ax: usize, cx: &mut Ctx) {
        if self.nodes[i].dir.is_some() {
            let [w, h] = self.dims_live(i, cx);
            let n = &self.nodes[i];
            let mut inner = [w - n.pad[3] - n.pad[1], h - n.pad[0] - n.pad[2]];
            let size;
            if n.dir == Some(ax) {
                let (mut k, mut n_fill) = (0, 0);
                for c in self.nodes[i].children.clone() {
                    if self.affects(c) {
                        k += 1;
                        if self.nodes[c].sizing[ax] == FILL {
                            n_fill += 1;
                        } else {
                            inner[ax] -= self.outer_live(c, cx)[ax];
                        }
                    }
                }
                inner[ax] -= (k as f64 - 1.0).max(0.0) * self.nodes[i].gap;
                size = if n_fill > 0 { inner[ax] / n_fill as f64 } else { 0.0 };
            } else {
                size = inner[ax];
            }
            let size = jmax(1.0, size);
            for c in self.nodes[i].children.clone() {
                if self.affects(c) && self.nodes[c].sizing[ax] == FILL {
                    self.commit_size(c, ax, size);
                }
            }
        }
        // fill_container outside a layout keeps its fallback size (pen.dev: hasFixedSize)
        for c in self.nodes[i].children.clone() {
            self.fill(c, ax, cx);
        }
    }
    fn place(&mut self, i: usize, cx: &mut Ctx) {
        let kids = self.nodes[i].children.clone();
        if let (Some(m), false) = (self.nodes[i].dir, kids.is_empty()) {
            let x = if m == V { H } else { V };
            let [w, h] = self.dims_live(i, cx);
            let n = &self.nodes[i];
            let (pad, gap0, justify, align) = (n.pad, n.gap, n.justify, n.align);
            let inner = [w - pad[3] - pad[1], h - pad[0] - pad[2]];
            let mut cur = [pad[3], pad[0]];
            let mut free = inner;
            let mut k = 0;
            for &c in &kids {
                if self.affects(c) {
                    k += 1;
                    let o = self.outer_live(c, cx);
                    free[0] -= o[0];
                    free[1] -= o[1];
                }
            }
            let mut gap = gap0;
            if k > 0 {
                let kf = k as f64;
                match justify {
                    4 => cur[m] += free[m] - gap0 * (kf - 1.0),
                    1 => cur[m] += (free[m] - gap0 * (kf - 1.0)) / 2.0,
                    2 => gap = if k > 1 { free[m] / (kf - 1.0) } else { 0.0 },
                    3 => {
                        gap = free[m] / kf;
                        cur[m] += gap / 2.0;
                    }
                    _ => {}
                }
            }
            for &c in &kids {
                if !self.affects(c) {
                    continue;
                }
                let mut p = cur;
                let o = self.outer_live(c, cx);
                if align == 2 {
                    p[x] += inner[x] - o[x];
                } else if align == 1 {
                    p[x] += (inner[x] - o[x]) / 2.0;
                }
                self.commit_position(c, p[0], p[1], cx);
                cur[m] += o[m] + gap;
            }
        }
        for c in kids {
            self.place(c, cx);
        }
    }
    pub fn layout_root(&mut self, r: usize, cx: &mut Ctx) {
        self.fit(r, H, cx);
        self.fill(r, H, cx);
        self.fit(r, V, cx);
        self.fill(r, V, cx);
        self.place(r, cx);
    }
    /// After layout: the sizes drawing uses (text measured once), extents recomputed on demand.
    pub fn freeze(&self, cx: &mut Ctx) {
        for i in 0..self.nodes.len() {
            let d = self.dims_live(i, cx);
            self.nodes[i].d.set(d);
            self.nodes[i].ext.set(None);
        }
    }
}

fn text_style(doc: &Value, s: &Value, theme: &Theme) -> TextStyle {
    let p = |k: &str| resolve(doc, get(s, k), theme);
    let family = p("fontFamily");
    let size = num0(&p("fontSize"));
    let content = match get(s, "content") {
        Value::Array(a) => Content::Spans(a.clone()),
        _ => Content::Text({ let c = p("content"); if c.is_null() { String::new() } else { js_string(&c) } }),
    };
    TextStyle {
        family: if truthy(&family) { js_string(&family) } else { "Inter".into() },
        size: if size == 0.0 { 14.0 } else { size },
        weight: weight_of(&p("fontWeight")),
        italic: p("fontStyle") == "italic",
        lh: num0(&p("lineHeight")),
        ls: num0(&p("letterSpacing")),
        align: { let a = get(s, "textAlign"); if a.is_null() { "left".into() } else { js_string(a) } },
        under: truthy(&p("underline")),
        strike: truthy(&p("strikethrough")),
        color: { let c = solid_fill(get(s, "fill"), &|v| resolve(doc, v, theme)); if c.is_null() { Value::String("#000000".into()) } else { c } },
        content,
        ps: num0(&p("paragraphSpacing")),
    }
}

// ---------------------------------------------------------------- geometry
#[derive(Clone)]
pub enum Geo {
    /// a plain rect (CanvasKit's 4-number rect)
    Rect([f64; 4]),
    /// rect + radii [tl, tr, br, bl] (CanvasKit's 12-number rrect, radii as x=y pairs)
    RRect([f64; 4], [f64; 8]),
    Oval([f64; 4]),
    Path(Path),
    Line,
}
fn rrect(x: f64, y: f64, w: f64, h: f64, r: Option<[f64; 4]>) -> Geo {
    match r {
        Some(r) if r.iter().any(|v| *v != 0.0) => Geo::RRect([x, y, x + w, y + h], [r[0], r[0], r[1], r[1], r[2], r[2], r[3], r[3]]),
        _ => Geo::Rect([x, y, x + w, y + h]),
    }
}
fn inset(g: &Geo, d: f64) -> Geo {
    let r = |b: &[f64; 4]| [b[0] + d, b[1] + d, b[2] - d, b[3] - d];
    match g {
        Geo::Rect(b) => Geo::Rect(r(b)),
        Geo::RRect(b, rad) => Geo::RRect(r(b), rad.map(|v| jmax(0.0, v - d))),
        x => x.clone(),
    }
}
fn sk_rrect(b: &[f64; 4], rad: &[f32; 8]) -> RRect {
    let radii = [(rad[0], rad[1]).into(), (rad[2], rad[3]).into(), (rad[4], rad[5]).into(), (rad[6], rad[7]).into()];
    RRect::new_rect_radii(ltrb(*b), &radii)
}

/// CanvasKit copies rrects into fixed scratch buffers (12 floats). A plain 4-number rect passed where an rrect is
/// expected (drawRRect/clipRRect/drawDRRect) only overwrites the rect, so it keeps the radii of the previous rrect that
/// went through the same buffer. scene.js does that for inner/outer strokes and shadows of rects without corner
/// radius; the reference (and the editor) draw with those leftover radii, so the same state is kept here.
#[derive(Default)]
pub struct Scratch {
    pub pb: [f32; 8],
    pub sc: [f32; 8],
}
fn through(buf: &mut [f32; 8], g: &Geo) -> Option<RRect> {
    match g {
        Geo::Rect(b) => Some(sk_rrect(b, buf)),
        Geo::RRect(b, rad) => {
            *buf = rad.map(|v| v as f32);
            Some(sk_rrect(b, buf))
        }
        _ => None,
    }
}
fn draw_rrect(canvas: &Canvas, cx: &mut Ctx, g: &Geo, paint: &Paint) {
    if let Some(rr) = through(&mut cx.c.scratch.pb, g) {
        canvas.draw_rrect(rr, paint);
    }
}

fn radii(sc: &Scene, i: usize, w: f64, h: f64) -> Option<[f64; 4]> {
    let n = sc.n(i);
    if get(n.src, "cornerRadius").is_null() {
        return None;
    }
    let a: Vec<f64> = list(&sc.p(i, "cornerRadius")).into_iter().map(|v| num0(&sc.v(i, v))).collect();
    let at = |k: usize| a.get(k).copied();
    let (tl, tr, br, bl) = if a.len() == 2 {
        (a[0], a[1], a[0], a[1])
    } else {
        let tl = at(0).unwrap_or(f64::NAN);
        let tr = at(1).unwrap_or(tl);
        let br = at(2).unwrap_or(tl);
        let bl = at(3).unwrap_or(tr);
        (tl, tr, br, bl)
    };
    let max = jmin(w, h) / 2.0;
    Some([tl, tr, br, bl].map(|v| jmin(v, max)))
}

fn svg_path(cx: &mut Ctx, d: &str) -> Option<Path> {
    if let Some(p) = cx.c.paths.get(d) {
        return p.clone();
    }
    let p = Path::from_svg(d);
    if cx.c.paths.len() > 1000 {
        cx.c.paths.clear();
    }
    cx.c.paths.insert(d.to_string(), p.clone());
    p
}

fn shape_path(sc: &Scene, i: usize, w: f64, h: f64, cx: &mut Ctx) -> Option<Geo> {
    let n = sc.n(i);
    let p = |k: &str| sc.p(i, k);
    let or = |v: Value, d: f64| if v.is_null() { d } else { number(&v) };
    if n.ty == "ellipse" {
        let vector = or(p("innerRadius"), 0.0) > 0.0 || or(p("sweepAngle"), 360.0).abs() < 360.0;
        if !vector {
            return Some(Geo::Oval([0.0, 0.0, w, h]));
        }
    }
    let (d, mut vb): (String, Option<[f64; 4]>) = match n.ty.as_str() {
        "path" => (
            { let g = get(n.src, "geometry"); if g.is_null() { String::new() } else { js_string(g) } },
            get(n.src, "viewBox").as_array().map(|a| [0, 1, 2, 3].map(|k| a.get(k).map(number).unwrap_or(f64::NAN))),
        ),
        "polygon" => (js::polygon(or(p("polygonCount"), 3.0)), Some([0.0, 0.0, 100.0, 100.0])),
        "ellipse" => (js::arc(or(p("innerRadius"), 0.0), or(p("startAngle"), 0.0), or(p("sweepAngle"), 360.0)), Some([0.0, 0.0, 100.0, 100.0])),
        "line" => return Some(Geo::Line),
        _ => (String::new(), None),
    };
    let base = svg_path(cx, &d)?;
    if vb.is_none() {
        let b = base.bounds();
        let (b0, b1, b2, b3) = (b.left as f64, b.top as f64, b.right as f64, b.bottom as f64);
        let nz = |x: f64| if x == 0.0 || x.is_nan() { 1.0 } else { x };
        vb = Some([b0, b1, nz(b2 - b0), nz(b3 - b1)]);
    }
    let vb = vb.unwrap();
    let nz = |x: f64| if x == 0.0 || x.is_nan() { 1.0 } else { x };
    let m = mul(&scaled(w / nz(vb[2]), h / nz(vb[3]), 0.0, 0.0), &translated(-vb[0], -vb[1]));
    let mut path = base.with_transform(&sk(&m));
    if get(n.src, "fillRule") == "evenodd" {
        path.set_fill_type(PathFillType::EvenOdd);
    }
    Some(Geo::Path(path))
}

fn fill_paint() -> Paint {
    let mut p = Paint::default();
    p.set_anti_alias(true);
    p
}
fn draw_geo(canvas: &Canvas, cx: &mut Ctx, g: &Geo, paint: &Paint) {
    match g {
        Geo::Rect(b) => {
            canvas.draw_rect(ltrb(*b), paint);
        }
        Geo::RRect(..) => draw_rrect(canvas, cx, g, paint),
        Geo::Oval(b) => {
            canvas.draw_oval(ltrb(*b), paint);
        }
        Geo::Path(p) => {
            canvas.draw_path(p, paint);
        }
        Geo::Line => {}
    }
}
fn clip_geo(canvas: &Canvas, cx: &mut Ctx, g: &Geo) {
    match g {
        Geo::Rect(b) => {
            canvas.clip_rect(ltrb(*b), ClipOp::Intersect, true);
        }
        Geo::RRect(..) => {
            let rr = through(&mut cx.c.scratch.pb, g).unwrap();
            canvas.clip_rrect(rr, ClipOp::Intersect, true);
        }
        Geo::Oval(b) => {
            canvas.clip_path(&Path::oval(ltrb(*b), None), ClipOp::Intersect, true);
        }
        Geo::Path(p) => {
            canvas.clip_path(p, ClipOp::Intersect, true);
        }
        Geo::Line => {}
    }
}

const BLENDS: [(&str, BlendMode); 18] = [
    ("darken", BlendMode::Darken),
    ("multiply", BlendMode::Multiply),
    ("linearBurn", BlendMode::Multiply),
    ("colorBurn", BlendMode::ColorBurn),
    ("light", BlendMode::Lighten),
    ("screen", BlendMode::Screen),
    ("linearDodge", BlendMode::Plus),
    ("colorDodge", BlendMode::ColorDodge),
    ("overlay", BlendMode::Overlay),
    ("softLight", BlendMode::SoftLight),
    ("hardLight", BlendMode::HardLight),
    ("difference", BlendMode::Difference),
    ("exclusion", BlendMode::Exclusion),
    ("hue", BlendMode::Hue),
    ("saturation", BlendMode::Saturation),
    ("color", BlendMode::Color),
    ("luminosity", BlendMode::Luminosity),
    ("normal", BlendMode::SrcOver),
];
fn blend_of(f: &Value) -> BlendMode {
    let m = get(f, "blendMode");
    BLENDS.iter().find(|(k, _)| m == *k && *k != "normal").map(|(_, b)| *b).unwrap_or(BlendMode::SrcOver)
}
// Image adjustments (Pena's `adjust`, from Figma's image filters, -1..1) as one color matrix. Calibrated against
// Figma's own renders; highlights/shadows (tonal curves) are not a matrix and are left out.
fn adjust_matrix(a: &Value) -> [f32; 20] {
    let g = |k: &str| { let v = get(a, k); if v.is_null() { 0.0 } else { number(v) } };
    let (exposure, contrast, saturation, temperature, tint) = (g("exposure"), g("contrast"), g("saturation"), g("temperature"), g("tint"));
    let e = 2f64.powf(exposure * 1.5);
    let c = 1.0 + contrast * if contrast > 0.0 { 1.0 } else { 0.5 };
    let s = 1.0 + saturation;
    let (lr, lg, lb) = (0.2126 * (1.0 - s), 0.7152 * (1.0 - s), 0.0722 * (1.0 - s));
    let sat = [lr + s, lg, lb, lr, lg + s, lb, lr, lg, lb + s];
    let (k, off) = (e * c, 0.5 * (1.0 - c));
    let rows = [1.0 + temperature * 0.1, 1.0 - tint * 0.1, 1.0 - temperature * 0.1];
    let mut m = [0f32; 20];
    for r in 0..3 {
        for col in 0..3 {
            m[r * 5 + col] = (sat[r * 3 + col] * k * rows[r]) as f32;
        }
        m[r * 5 + 4] = off as f32;
    }
    m[18] = 1.0;
    m
}

fn shadows(sc: &Scene, i: usize, inner: bool) -> Vec<Shadow> {
    let v = |x: &Value| sc.v(i, x);
    list(get(sc.n(i).src, "effect"))
        .into_iter()
        .filter(|e| truthy(e) && !is_false(&v(get(e, "enabled"))) && get(e, "type") == "shadow" && (get(e, "shadowType") == "inner") == inner)
        .map(|e| Shadow {
            x: num0(&v(get(get(e, "offset"), "x"))),
            y: num0(&v(get(get(e, "offset"), "y"))),
            blur: num0(&v(get(e, "blur"))),
            spread: num0(&v(get(e, "spread"))),
            color: color(&{ let c = v(get(e, "color")); if c.is_null() { Value::String("#00000040".into()) } else { c } }, 1.0),
        })
        .collect()
}
struct Shadow {
    x: f64,
    y: f64,
    blur: f64,
    spread: f64,
    color: Option<[f32; 4]>,
}
fn blur_paint(s: &Shadow) -> Paint {
    let mut p = fill_paint();
    p.set_color4f(c4(s.color.unwrap_or(BLACK)), None);
    if s.blur > 0.0 {
        p.set_mask_filter(MaskFilter::blur(BlurStyle::Normal, (s.blur / 2.0) as f32, true));
    }
    p
}
fn has_fill(sc: &Scene, i: usize) -> bool {
    list(get(sc.n(i).src, "fill")).into_iter().any(|f| truthy(f) && (f.is_string() || !is_false(&sc.v(i, get(f, "enabled")))))
}
fn content_shadow(sc: &Scene, i: usize) -> bool {
    let n = sc.n(i);
    (n.ty == "group" || (n.ty == "frame" && !has_fill(sc, i) && !n.children.is_empty())) && shadows(sc, i, false).iter().any(|s| s.color.is_some())
}

const NOTE_BG: [(&str, &str); 3] = [("note", "#FFF4B3"), ("prompt", "#EDE7FF"), ("context", "#E8EEF5")];

/// Where a shader samples its `@sdf`/`pencil:object` from: a fill's shape, or (effects) the node rendered so far.
enum Sources<'e> {
    Geo(&'e Geo),
    Content { effects: &'e [&'e Value], upto: usize, w: f64, h: f64 },
}

fn clip_cull(cull: [f64; 4], m: &M, w: f64, h: f64) -> [f64; 4] {
    if m[1] != 0.0 || m[3] != 0.0 {
        return cull;
    }
    [jmax(cull[0], m[2]), jmax(cull[1], m[5]), jmin(cull[2], m[2] + m[0] * w), jmin(cull[3], m[5] + m[4] * h)]
}

impl<'a> Scene<'a> {
    fn effects(&self, i: usize) -> Vec<&'a Value> {
        list(get(self.nodes[i].src, "effect")).into_iter().filter(|e| truthy(e) && !is_false(&self.v(i, get(e, "enabled")))).collect()
    }

    pub fn draw_node(&self, canvas: &Canvas, cx: &mut Ctx, i: usize, cull: [f64; 4], zoom: f64, pm: &M) {
        if let Some((node, hit)) = self.stop.get() {
            if hit {
                return;
            }
            if node == i {
                self.stop.set(Some((node, true)));
                return;
            }
        }
        let n = &self.nodes[i];
        if !n.enabled || n.opacity <= 0.0 {
            return;
        }
        let [w, h] = self.dims(i);
        let lm = self.matrix(i);
        let m = if pm[1] == 0.0 && pm[3] == 0.0 && lm[1] == 0.0 && lm[3] == 0.0 {
            [pm[0] * lm[0], 0.0, pm[0] * lm[2] + pm[2], 0.0, pm[4] * lm[4], pm[4] * lm[5] + pm[5], 0.0, 0.0, 1.0]
        } else {
            mul(pm, &lm)
        };
        // cull with the world AABB of the whole subtree (+ room for shadows/strokes)
        let e = self.extent(i);
        let pad = n.draw_pad;
        let cxs = [m[0] * e[0], m[0] * e[2]];
        let cys = [m[4] * e[1], m[4] * e[3]];
        let (mut x0, mut x1, mut y0, mut y1) = (m[2] + min_all(&cxs), m[2] + max_all(&cxs), m[5] + min_all(&cys), m[5] + max_all(&cys));
        if m[1] != 0.0 || m[3] != 0.0 {
            let r = (e[2] - e[0]).hypot(e[3] - e[1]);
            (x0, x1, y0, y1) = (m[2] - r, m[2] + r, m[5] - r, m[5] + r);
        }
        if x1 + pad < cull[0] || y1 + pad < cull[1] || x0 - pad > cull[2] || y0 - pad > cull[3] {
            return;
        }
        if jmax(x1 - x0, y1 - y0) * zoom < 0.4 {
            return; // sub-pixel
        }
        let count = canvas.save();
        canvas.concat(&sk(&lm));
        let effects = self.effects(i);
        if n.opacity < 1.0 {
            let mut p = Paint::default();
            p.set_alpha_f(n.opacity as f32);
            canvas.save_layer(&SaveLayerRec::default().paint(&p));
        }
        self.draw_effected(canvas, cx, i, w, h, &effects, effects.len(), cull, zoom, &m);
        canvas.restore_to_count(count);
    }

    // The node with effects[0..upto): a shader effect post-processes everything the effects before it drew (pen.dev
    // chains them the same way); blurs and shadows are always part of that content.
    fn draw_effected(&self, canvas: &Canvas, cx: &mut Ctx, i: usize, w: f64, h: f64, effects: &[&'a Value], upto: usize, cull: [f64; 4], zoom: f64, m: &M) {
        // a backdrop captured for a node inside this one can't include this node's own effect (it would need itself)
        if self.stop.get().is_none_or(|(node, _)| !self.is_inside(node, i)) {
            for k in (0..upto).rev() {
                if get(effects[k], "type") == "shader" && self.draw_shader_effect(canvas, cx, i, w, h, effects, k, zoom, m) {
                    return;
                }
            }
        }
        let count = canvas.save();
        if let Some(blur) = effects.iter().find(|e| get(e, "type") == "blur") {
            let r = num0(&self.v(i, get(blur, "radius")));
            let mut p = Paint::default();
            p.set_image_filter(image_filters::blur(((r / 2.0) as f32, (r / 2.0) as f32), TileMode::Decal, None, None));
            canvas.save_layer(&SaveLayerRec::default().paint(&p));
        }
        // groups and fill-less frames: the shadow follows the drawn content (Figma), not a box. One shadow per layer.
        // ponytail: a single drop shadow; stack more layers if multi-shadow groups show up
        if content_shadow(self, i) {
            let s = &shadows(self, i, false)[0];
            let mut p = Paint::default();
            let col = s.color.map(c4).unwrap_or(Color4f::new(0.0, 0.0, 0.0, 0.0));
            p.set_image_filter(image_filters::drop_shadow(Vector::new(s.x as f32, s.y as f32), ((s.blur / 2.0) as f32, (s.blur / 2.0) as f32), col, None, None, None));
            canvas.save_layer(&SaveLayerRec::default().paint(&p));
        }
        self.content(canvas, cx, i, w, h, effects, cull, zoom, m);
        canvas.restore_to_count(count);
    }

    // ---- shaders
    // effects[k] is a shader: draw it over the node's visual bounds instead of the node. Its content (`pencil:object`) is
    // a recording of the node with the effects before it, sampled as a picture shader. False while it doesn't compile.
    fn draw_shader_effect(&self, canvas: &Canvas, cx: &mut Ctx, i: usize, w: f64, h: f64, effects: &[&'a Value], k: usize, zoom: f64, m: &M) -> bool {
        let v = |x: &Value| self.v(i, x);
        let pad = effects[..k].iter().filter(|e| get(e, "type") != "shader").map(|e| effect_padding(e, &v)).fold(0.0, jmax);
        let e = self.extent(i);
        let bx = [e[0] - pad, e[1] - pad, e[2] + pad, e[3] + pad];
        let Some(sh) = self.shader_for(cx, i, effects[k], bx, m, zoom, Sources::Content { effects, upto: k, w, h }) else { return false };
        let mut p = fill_paint();
        p.set_shader(sh);
        p.set_color4f(c4(BLACK), None);
        canvas.draw_rect(ltrb(bx), &p);
        true
    }
    fn record_content(&self, cx: &mut Ctx, i: usize, bx: [f64; 4], m: &M, zoom: f64, src: &Sources) -> Option<Picture> {
        let Sources::Content { effects, upto, w, h } = src else { return None };
        let mut rec = PictureRecorder::new();
        let c = rec.begin_recording(ltrb(bx), false);
        self.draw_effected(c, cx, i, *w, *h, effects, *upto, [-1e9, -1e9, 1e9, 1e9], zoom, m);
        rec.finish_recording_as_picture(None)
    }
    // The Skia shader for a shader fill or effect `spec` ({ url, uniforms }) shading `box` (node-local px). m: the
    // node's world matrix. None until it compiles.
    fn shader_for(&self, cx: &mut Ctx, i: usize, spec: &Value, bx: [f64; 4], m: &M, zoom: f64, src: Sources) -> Option<Shader> {
        let url = crate::asset_url(&js_string(get(spec, "url")));
        let text = cx.shader_source(&url)?;
        let prog = cx.program(&text)?;
        let (w, h) = (bx[2] - bx[0], bx[3] - bx[1]);
        if !(w > 0.0 && h > 0.0) {
            return None;
        }
        // shader space: px from the box's bottom-left, y up (gl_FragCoord); children are sampled in that space too
        let f: M = [1.0, 0.0, bx[0], 0.0, -1.0, bx[1] + h, 0.0, 0.0, 1.0];
        let finv = invert(&f).unwrap_or(IDENTITY);
        let mut content: Option<Option<Picture>> = None;
        let mut children: Vec<skia_safe::runtime_effect::ChildPtr> = vec![];
        let mut sizes: Vec<[f64; 2]> = vec![];
        let uniforms = get(spec, "uniforms");
        for u in prog.samplers.clone() {
            let v = match &u {
                Some(u) if u.has("sdf") => Value::String("sdf".into()),
                Some(u) => { let x = self.v(i, get(uniforms, &u.name)); if x.is_null() { u.role.clone().map(Value::String).unwrap_or(Value::Null) } else { x } }
                None => Value::Null,
            };
            let mut child: Option<Shader> = None;
            let mut size = [w, h];
            match v.as_str() {
                Some("pencil:object") => {
                    if content.is_none() {
                        content = Some(self.record_content(cx, i, bx, m, zoom, &src));
                    }
                    if let Some(Some(pic)) = &content {
                        child = Some(pic.to_shader((TileMode::Decal, TileMode::Decal), FilterMode::Linear, &sk(&finv), &ltrb(bx)));
                    }
                }
                Some("pencil:background") => {
                    let (pic, rect) = self.backdrop(cx, i, bx, m, zoom);
                    let lm = invert(&mul(m, &f)).unwrap_or(IDENTITY);
                    child = pic.map(|p| p.to_shader((TileMode::Mirror, TileMode::Mirror), FilterMode::Linear, &sk(&lm), &ltrb(rect)));
                }
                Some("sdf") => child = self.sdf(cx, i, bx, &f, &src, &mut content, m, zoom),
                Some(s) if !s.is_empty() => {
                    if let Some(img) = cx.image(&crate::asset_url(s)) {
                        size = [img.width() as f64, img.height() as f64];
                        let lm: M = [1.0, 0.0, 0.0, 0.0, -1.0, size[1], 0.0, 0.0, 1.0];
                        child = img.to_shader((TileMode::Repeat, TileMode::Repeat), SamplingOptions::new(FilterMode::Linear, MipmapMode::None), &sk(&lm));
                    }
                }
                _ => {}
            }
            children.push(child.unwrap_or_else(|| skia_safe::shaders::color(skia_safe::Color::TRANSPARENT)).into());
            sizes.push(size);
        }
        let mut values = Map::new();
        if let Value::Object(u) = uniforms {
            for (k, x) in u {
                values.insert(k.clone(), self.v(i, x));
            }
        }
        let data = shader::uniform_data(&prog, &values, &Auto { resolution: [w, h], time: self.time, mouse: [w / 2.0, h / 2.0] }, &sizes);
        prog.effect.make_shader(data, &children, &sk(&f))
    }
    // `pencil:background`: everything drawn before n (earlier top-level nodes, then its own root up to it), in world
    // coordinates, around the shaded area.
    fn backdrop(&self, cx: &mut Ctx, i: usize, bx: [f64; 4], m: &M, zoom: f64) -> (Option<Picture>, [f64; 4]) {
        let corners = [[bx[0], bx[1]], [bx[2], bx[1]], [bx[0], bx[3]], [bx[2], bx[3]]];
        let xs = corners.map(|[x, y]| m[0] * x + m[1] * y + m[2]);
        let ys = corners.map(|[x, y]| m[3] * x + m[4] * y + m[5]);
        let margin = jmax(16.0, 0.1 * jmax(max_all(&xs) - min_all(&xs), max_all(&ys) - min_all(&ys)));
        let rect = [min_all(&xs) - margin, min_all(&ys) - margin, max_all(&xs) + margin, max_all(&ys) + margin];
        let mut rec = PictureRecorder::new();
        let c = rec.begin_recording(ltrb(rect), false);
        let prev = self.stop.get();
        let root = self.root_of(i);
        self.stop.set(Some((i, false)));
        for &r in &self.roots {
            self.draw_node(c, cx, r, rect, zoom, &IDENTITY);
            if r == root || self.stop.get().is_some_and(|s| s.1) {
                break;
            }
        }
        self.stop.set(prev);
        (rec.finish_recording_as_picture(None), rect)
    }
    // `@sdf`: of the fill's shape (exact for rectangles and ellipses), or of the rendered content for effects
    #[allow(clippy::too_many_arguments)]
    fn sdf(&self, cx: &mut Ctx, i: usize, bx: [f64; 4], f: &M, src: &Sources, content: &mut Option<Option<Picture>>, m: &M, zoom: f64) -> Option<Shader> {
        let finv = invert(f).unwrap_or(IDENTITY);
        if let Sources::Geo(g) = src {
            if matches!(g, Geo::Rect(_) | Geo::RRect(..) | Geo::Oval(_)) && bx[0] == 0.0 && bx[1] == 0.0 {
                let r = if let Geo::RRect(_, r) = g { [r[0], r[2], r[4], r[6]] } else { [0.0; 4] };
                return shader::shape_sdf(matches!(g, Geo::Oval(_)), bx[2], bx[3], r, &sk(&finv));
            }
        }
        if content.is_none() {
            *content = Some(self.record_content(cx, i, bx, m, zoom, src));
        }
        let pic = match (content.as_ref().unwrap(), src) {
            (Some(p), _) => p.clone(),
            (None, Sources::Geo(g)) => {
                // a path/polygon fill: its silhouette
                let mut rec = PictureRecorder::new();
                let c = rec.begin_recording(ltrb(bx), false);
                let mut p = fill_paint();
                p.set_color4f(c4(BLACK), None);
                draw_geo(c, cx, g, &p);
                rec.finish_recording_as_picture(None)?
            }
            _ => return None,
        };
        let (image, k) = shader::picture_sdf(&pic, bx)?;
        let hgt = bx[3] - bx[1];
        let lm = invert(&[k, 0.0, 0.0, 0.0, -k, hgt * k, 0.0, 0.0, 1.0]).unwrap_or(IDENTITY);
        image.to_shader((TileMode::Clamp, TileMode::Clamp), SamplingOptions::new(FilterMode::Linear, MipmapMode::None), &sk(&lm))
    }

    // ---- node content
    #[allow(clippy::too_many_arguments)]
    fn content(&self, canvas: &Canvas, cx: &mut Ctx, i: usize, w: f64, h: f64, effects: &[&'a Value], cull: [f64; 4], zoom: f64, m: &M) {
        let n = &self.nodes[i];
        match n.ty.as_str() {
            "group" => {
                for &c in &n.children {
                    self.draw_node(canvas, cx, c, cull, zoom, m);
                }
                return;
            }
            "text" => {
                let g = get(n.src, "textGrowth");
                let auto = g.is_null() || g == "auto";
                let ts = &n.text.as_ref().unwrap().0;
                if ts.size * zoom < 2.5 {
                    // unreadably small: one bar per line instead of shaping text (Figma-style greeking)
                    let lh = (if ts.lh != 0.0 { ts.lh } else { 1.2 }) * ts.size;
                    let lines = jmax(1.0, round(h / lh)) as i64;
                    let mut p = fill_paint();
                    p.set_color4f(c4(color(&ts.color, 0.45).unwrap_or(BLACK)), None);
                    let bw = jmin(w, self.measure(i, f64::INFINITY, cx)[0]);
                    for k in 0..lines {
                        let lw = if k == lines - 1 && lines > 1 { bw * 0.6 } else { bw };
                        canvas.draw_rect(xywh(0.0, k as f64 * lh + lh * 0.25, lw, lh * 0.5), &p);
                    }
                    return;
                }
                let width = if auto { self.measure(i, f64::INFINITY, cx)[0] } else { w.ceil() };
                let ls = ts.ls;
                let valign = get(n.src, "textAlignVertical");
                let sh = shadows(self, i, false);
                let para = self.para(i, cx);
                para.layout(width);
                let mut dy = 0.0;
                if !auto && truthy(valign) && valign != "top" {
                    let free = h - para.height();
                    dy = if valign == "middle" { free / 2.0 } else { free };
                }
                for s in &sh {
                    canvas.save();
                    canvas.translate((s.x as f32, s.y as f32));
                    let p = blur_paint(s);
                    canvas.save_layer(&SaveLayerRec::default().paint(&p));
                    para.draw(canvas, -(ls / 2.0), dy);
                    canvas.restore();
                    canvas.restore();
                }
                para.draw(canvas, -(ls / 2.0), dy);
                return;
            }
            "icon" => {
                let fill = solid_fill(get(n.src, "fill"), &|x| self.v(i, x));
                let fill = if fill.is_null() { "#000000".to_string() } else { js_string(&fill) };
                let lib = { let l = self.p(i, "library"); if l.is_null() { "lucide".to_string() } else { js_string(&l) } };
                let name = { let l = self.p(i, "icon"); if l.is_null() { String::new() } else { js_string(&l) } };
                if let Some(img) = cx.icon(&lib, &name, &fill, jmax(w, h) * zoom) {
                    let mut p = Paint::default();
                    p.set_anti_alias(true);
                    // the editor reuses one image paint: an icon keeps the opacity of the last image fill drawn
                    p.set_alpha_f(cx.c.img_alpha);
                    let src = Rect::from_wh(img.width() as f32, img.height() as f32);
                    canvas.draw_image_rect_with_sampling_options(&img, Some((&src, SrcRectConstraint::Strict)), xywh(0.0, 0.0, w, h), SamplingOptions::new(FilterMode::Linear, MipmapMode::None), &p);
                }
                return;
            }
            t if NOTES.contains(&t) => {
                let bg = NOTE_BG.iter().find(|(k, _)| *k == t).unwrap().1;
                let g = rrect(0.0, 0.0, w, h, Some([10.0; 4]));
                let mut p = fill_paint();
                p.set_color4f(c4(color(&Value::String(bg.into()), 1.0).unwrap()), None);
                draw_rrect(canvas, cx, &g, &p);
                let para = self.para(i, cx);
                para.layout(jmax(1.0, w - 32.0));
                para.draw(canvas, 16.0, 14.0);
                return;
            }
            _ => {}
        }
        // frames, rectangles, ellipses, paths, polygons, lines, browser/script placeholders
        let geo = if ["ellipse", "path", "polygon", "line"].contains(&n.ty.as_str()) { shape_path(self, i, w, h, cx) } else { Some(rrect(0.0, 0.0, w, h, radii(self, i, w, h))) };
        let Some(geo) = geo else { return };
        self.draw_outer_shadows(canvas, cx, i, &geo);
        if let Some(bg) = effects.iter().find(|e| get(e, "type") == "background_blur") {
            let r = num0(&self.v(i, get(bg, "radius")));
            canvas.save();
            clip_geo(canvas, cx, &geo);
            let f = image_filters::blur(((r / 2.0) as f32, (r / 2.0) as f32), TileMode::Clamp, None, None);
            let mut rec = SaveLayerRec::default();
            if let Some(f) = &f {
                rec = rec.backdrop(f);
            }
            canvas.save_layer(&rec);
            canvas.restore();
            canvas.restore();
        }
        if n.ty == "browser" {
            let mut p = fill_paint();
            p.set_color4f(Color4f::new(1.0, 1.0, 1.0, 1.0), None);
            draw_geo(canvas, cx, &geo, &p);
        }
        if !matches!(geo, Geo::Line) {
            self.draw_fills(canvas, cx, i, &geo, w, h, m, zoom);
        }
        self.draw_inner_shadows(canvas, cx, i, &geo, w, h);
        if !n.children.is_empty() {
            if n.clip {
                canvas.save();
                clip_geo(canvas, cx, &geo);
            }
            let cc = if n.clip { clip_cull(cull, m, w, h) } else { cull };
            for &c in &n.children {
                self.draw_node(canvas, cx, c, cc, zoom, m);
            }
            if n.clip {
                canvas.restore();
            }
        }
        if !self.stop.get().is_some_and(|s| s.1) {
            self.draw_stroke(canvas, cx, i, &geo, w, h); // a backdrop capture ends before the node: nothing on top
        }
    }

    #[allow(deprecated)] // skia-safe's newer gradient API takes the same arguments in a different shape
    fn set_fill_paint(&self, paint: &mut Paint, f: &Value, i: usize, w: f64, h: f64) -> bool {
        let v = |x: &Value| self.v(i, x);
        paint.set_shader(None);
        if f.is_string() {
            let Some(c) = color(&v(f), 1.0) else { return false };
            paint.set_color4f(c4(c), None);
            return true;
        }
        if !truthy(f) || is_false(&v(get(f, "enabled"))) {
            return false;
        }
        let a = if get(f, "opacity").is_null() { 1.0 } else { number(&v(get(f, "opacity"))) };
        let ty = get(f, "type");
        if ty == "color" {
            let Some(c) = color(&v(get(f, "color")), a) else { return false };
            paint.set_color4f(c4(c), None);
            return true;
        }
        if ty == "gradient" || ty == "mesh_gradient" {
            let mesh = ty == "mesh_gradient";
            let stops: Vec<(Value, Value)> = if mesh {
                let all = list(get(f, "colors"));
                let n = all.len();
                all.iter().enumerate().map(|(k, c)| ((*c).clone(), Value::from(k as f64 / jmax(1.0, n as f64 - 1.0)))).collect()
            } else {
                list(get(f, "colors")).into_iter().map(|s| (get(s, "color").clone(), get(s, "position").clone())).collect()
            };
            if stops.is_empty() {
                return false;
            }
            let cols: Vec<Color4f> = stops.iter().map(|(c, _)| c4(color(&v(c), a).unwrap_or(TRANSPARENT))).collect();
            let pos: Vec<f32> = stops.iter().map(|(_, p)| num0(&v(p)) as f32).collect();
            let center = get(f, "center");
            let (fx, fy) = (get(center, "x").as_f64().unwrap_or(0.5), get(center, "y").as_f64().unwrap_or(0.5));
            let (cxp, cyp) = (fx * w, fy * h);
            let rot = if mesh { 225.0 } else { num0(&v(get(f, "rotation"))) };
            let colors = GradientShaderColors::ColorsInSpace(&cols, None);
            let gt = get(f, "gradientType");
            let sh = if gt == "radial" {
                let rx = jmax(fx, 1.0 - fx) * w * std::f64::consts::SQRT_2;
                let ry = jmax(fy, 1.0 - fy) * h * std::f64::consts::SQRT_2;
                let nz = |x: f64| if x == 0.0 || x.is_nan() { 1.0 } else { x };
                let lm = mul(&translated(cxp, cyp), &scaled(nz(rx), nz(ry), 0.0, 0.0));
                gradient_shader::radial((0.0, 0.0), 1.0, colors, &pos[..], TileMode::Clamp, None, &sk(&lm))
            } else if gt == "angular" {
                let lm = rotated(((-rot - 90.0) * std::f64::consts::PI) / 180.0, cxp, cyp);
                gradient_shader::sweep((cxp as f32, cyp as f32), colors, &pos[..], TileMode::Clamp, None, None, &sk(&lm))
            } else {
                let ang = (((360.0 - rot) % 360.0) * std::f64::consts::PI) / 180.0;
                let (dx, dy) = (ang.sin(), -ang.cos());
                let len = (w * dx).abs() + (h * dy).abs();
                let p0 = ((w / 2.0 - (dx * len) / 2.0) as f32, (h / 2.0 - (dy * len) / 2.0) as f32);
                let p1 = ((w / 2.0 + (dx * len) / 2.0) as f32, (h / 2.0 + (dy * len) / 2.0) as f32);
                gradient_shader::linear((p0, p1), colors, &pos[..], TileMode::Clamp, None, None)
            };
            paint.set_color4f(c4(BLACK), None);
            paint.set_shader(sh);
            return true;
        }
        false
    }

    #[allow(clippy::too_many_arguments)]
    fn draw_fills(&self, canvas: &Canvas, cx: &mut Ctx, i: usize, geo: &Geo, w: f64, h: f64, m: &M, zoom: f64) {
        let n = &self.nodes[i];
        let v = |x: &Value| self.v(i, x);
        for f in list(get(n.src, "fill")) {
            let mut paint = fill_paint();
            paint.set_blend_mode(blend_of(f));
            let ty = get(f, "type");
            if f.is_object() && ty == "shader" {
                if is_false(&v(get(f, "enabled"))) || !truthy(get(f, "url")) {
                    continue;
                }
                // loading, or it does not compile (the warnings say why)
                let Some(sh) = self.shader_for(cx, i, f, [0.0, 0.0, w, h], m, zoom, Sources::Geo(geo)) else { continue };
                paint.set_shader(sh);
                paint.set_color4f(c4(BLACK), None);
                paint.set_alpha_f((if get(f, "opacity").is_null() { 1.0 } else { number(&v(get(f, "opacity"))) }) as f32);
                draw_geo(canvas, cx, geo, &paint);
                continue;
            }
            if f.is_object() && ty == "image" {
                if is_false(&v(get(f, "enabled"))) || !truthy(get(f, "url")) {
                    continue;
                }
                let Some(img) = cx.image(&crate::asset_url(&js_string(get(f, "url")))) else {
                    paint.set_shader(None);
                    paint.set_color4f(Color4f::new(0.5, 0.5, 0.5, 0.15), None);
                    draw_geo(canvas, cx, geo, &paint);
                    continue;
                };
                let (iw, ih) = (img.width() as f64, img.height() as f64);
                let mode = { let m = get(f, "mode"); if m.is_null() { "fill".to_string() } else { js_string(m) } };
                let (mut dw, mut dh) = (w, h);
                if mode != "stretch" {
                    let s = if mode == "fit" || mode == "contain" { jmin(w / iw, h / ih) } else { jmax(w / iw, h / ih) };
                    dw = iw * s;
                    dh = ih * s;
                }
                canvas.save();
                clip_geo(canvas, cx, geo);
                let alpha = if get(f, "opacity").is_null() { 1.0 } else { number(get(f, "opacity")) };
                cx.c.img_alpha = alpha as f32;
                let mut ip = Paint::default();
                ip.set_anti_alias(true);
                ip.set_alpha_f(alpha as f32);
                ip.set_blend_mode(blend_of(f));
                if truthy(get(f, "adjust")) {
                    ip.set_color_filter(skia_safe::color_filters::matrix_row_major(&adjust_matrix(get(f, "adjust")), None));
                }
                // stretch + transform [a b c d tx ty]: maps the image's unit square into the layer's (crops; Figma imports)
                let t = get(f, "transform").as_array().filter(|t| mode == "stretch" && t.len() == 6).map(|t| t.iter().map(number).collect::<Vec<f64>>());
                if let Some(t) = &t {
                    canvas.concat(&sk(&mul(&scaled(w, h, 0.0, 0.0), &[t[0], t[2], t[4], t[1], t[3], t[5], 0.0, 0.0, 1.0])));
                }
                let dst = if t.is_some() { xywh(0.0, 0.0, 1.0, 1.0) } else { xywh((w - dw) / 2.0, (h - dh) / 2.0, dw, dh) };
                let src = Rect::from_wh(iw as f32, ih as f32);
                canvas.draw_image_rect_with_sampling_options(&img, Some((&src, SrcRectConstraint::Strict)), dst, SamplingOptions::new(FilterMode::Linear, MipmapMode::None), &ip);
                canvas.restore();
                continue;
            }
            if self.set_fill_paint(&mut paint, f, i, w, h) {
                draw_geo(canvas, cx, geo, &paint);
            }
        }
    }

    fn draw_stroke(&self, canvas: &Canvas, cx: &mut Ctx, i: usize, geo: &Geo, w: f64, h: f64) {
        let n = &self.nodes[i];
        let v = |x: &Value| self.v(i, x);
        let Some(col) = color(&solid_fill(get(n.src, "stroke"), &v), 1.0) else { return };
        let mut paint = fill_paint();
        paint.set_style(paint::Style::Stroke);
        paint.set_color4f(c4(col), None);
        let sw = get(n.src, "strokeWidth");
        if sw.is_object() || sw.is_array() {
            // per-side widths: inner bands, clipped to the shape
            let side = |k: &str| num0(&v(get(sw, k)));
            let (t, r, b, l) = (side("top"), side("right"), side("bottom"), side("left"));
            let mut fp = fill_paint();
            fp.set_color4f(c4(col), None);
            canvas.save();
            clip_geo(canvas, cx, geo);
            if t != 0.0 {
                canvas.draw_rect(xywh(0.0, 0.0, w, t), &fp);
            }
            if b != 0.0 {
                canvas.draw_rect(xywh(0.0, h - b, w, b), &fp);
            }
            if l != 0.0 {
                canvas.draw_rect(xywh(0.0, 0.0, l, h), &fp);
            }
            if r != 0.0 {
                canvas.draw_rect(xywh(w - r, 0.0, r, h), &fp);
            }
            canvas.restore();
            return;
        }
        let width = num0(&v(if sw.is_null() { &Value::Null } else { sw }));
        let width = if sw.is_null() { 1.0 } else { width };
        if width == 0.0 {
            return;
        }
        paint.set_stroke_width(width as f32);
        paint.set_stroke_cap(match get(n.src, "strokeLinecap").as_str() { Some("round") => paint::Cap::Round, Some("square") => paint::Cap::Square, _ => paint::Cap::Butt });
        paint.set_stroke_join(match get(n.src, "strokeLinejoin").as_str() { Some("round") => paint::Join::Round, Some("bevel") => paint::Join::Bevel, _ => paint::Join::Miter });
        let align = if matches!(geo, Geo::Line) || n.ty == "path" || n.ty == "line" { "center".to_string() } else { let a = get(n.src, "strokeAlignment"); if a.is_null() { "inner".into() } else { js_string(a) } };
        if matches!(geo, Geo::Line) {
            canvas.draw_line((0.0, 0.0), (w as f32, h as f32), &paint);
            return;
        }
        if matches!(geo, Geo::Rect(_) | Geo::RRect(..)) && align != "center" {
            let base = if let Geo::Rect(_) = geo { rrect(0.0, 0.0, w, h, None) } else { geo.clone() };
            draw_rrect(canvas, cx, &inset(&base, if align == "inner" { width / 2.0 } else { -width / 2.0 }), &paint);
            return;
        }
        if align == "center" {
            draw_geo(canvas, cx, geo, &paint);
            return;
        }
        // inner/outer on arbitrary shapes: double-width stroke clipped to inside/outside
        paint.set_stroke_width((width * 2.0) as f32);
        canvas.save();
        let p = match geo { Geo::Path(p) => p.clone(), Geo::Oval(b) => Path::oval(ltrb(*b), None), _ => Path::new() };
        canvas.clip_path(&p, if align == "inner" { ClipOp::Intersect } else { ClipOp::Difference }, true);
        canvas.draw_path(&p, &paint);
        canvas.restore();
    }

    fn draw_outer_shadows(&self, canvas: &Canvas, cx: &mut Ctx, i: usize, geo: &Geo) {
        if content_shadow(self, i) {
            return; // drawn as a layer filter in draw_effected
        }
        for s in shadows(self, i, false) {
            if s.color.is_none() {
                continue;
            }
            let p = blur_paint(&s);
            canvas.save();
            canvas.translate((s.x as f32, s.y as f32));
            match geo {
                Geo::Rect(b) => draw_rrect(canvas, cx, &inset(&rrect(b[0], b[1], b[2] - b[0], b[3] - b[1], None), -s.spread), &p),
                Geo::RRect(..) => draw_rrect(canvas, cx, &inset(geo, -s.spread), &p),
                _ => draw_geo(canvas, cx, geo, &p),
            }
            canvas.restore();
        }
    }
    fn draw_inner_shadows(&self, canvas: &Canvas, cx: &mut Ctx, i: usize, geo: &Geo, w: f64, h: f64) {
        let list = shadows(self, i, true);
        if list.is_empty() || !matches!(geo, Geo::Rect(_) | Geo::RRect(..)) {
            return;
        }
        let base = if let Geo::Rect(_) = geo { rrect(0.0, 0.0, w, h, None) } else { geo.clone() };
        for s in list {
            if s.color.is_none() {
                continue;
            }
            let p = blur_paint(&s);
            canvas.save();
            clip_geo(canvas, cx, geo);
            let hole = match inset(&base, s.spread) {
                Geo::Rect(b) => Geo::Rect([b[0] + s.x, b[1] + s.y, b[2] + s.x, b[3] + s.y]),
                Geo::RRect(b, r) => Geo::RRect([b[0] + s.x, b[1] + s.y, b[2] + s.x, b[3] + s.y], r),
                g => g,
            };
            let big = s.blur * 2.0 + s.x.abs() + s.y.abs() + 10.0;
            // the outer rrect is a full 12-number one with zero radii: it resets the first scratch buffer
            let outer = through(&mut cx.c.scratch.pb, &Geo::RRect([-big, -big, w + big, h + big], [0.0; 8])).unwrap();
            let inner = through(&mut cx.c.scratch.sc, &hole).unwrap();
            canvas.draw_drrect(outer, inner, &p);
            canvas.restore();
        }
    }

    /// `Shader <url> (<id>): <error>` for every shader in the subtree that failed to load or compile
    pub fn shader_problems(&self, root: usize, cx: &mut Ctx) -> Vec<String> {
        let mut out: Vec<String> = vec![];
        let mut stack = vec![root];
        let mut order = vec![];
        while let Some(i) = stack.pop() {
            order.push(i);
            stack.extend(self.nodes[i].children.iter().rev());
        }
        for i in order {
            let n = &self.nodes[i];
            for s in list(get(n.src, "fill")).into_iter().chain(list(get(n.src, "effect"))) {
                if get(s, "type") == "shader" && truthy(get(s, "url")) {
                    let url = js_string(get(s, "url"));
                    if let Some(err) = cx.shader_error(&crate::asset_url(&url)) {
                        let line = format!("Shader {url} ({}): {err}", n.id);
                        if !out.contains(&line) {
                            out.push(line);
                        }
                    }
                }
            }
        }
        out
    }
}

