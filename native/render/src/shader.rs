// public/shader.js: pen.dev-format GLSL shaders rewritten to SkSL (string transforms), compiled once per source,
// their uniform buffers, and the signed distance fields shaders can sample (`@sdf`).
use crate::core::{num0, str_number};
use regex::{Captures, Regex};
use serde_json::{Map, Value};
use skia_safe::runtime_effect::uniform::Type as UType;
use skia_safe::{AlphaType, ColorSpace, ColorType, Data, Image, ImageInfo, Matrix, Picture, RuntimeEffect, Shader};
use std::collections::HashMap;
use std::sync::LazyLock;

// ---------------------------------------------------------------- annotations
const FLAGS: [&str; 7] = ["color", "resolution", "time", "mouse", "sdf", "content", "backdrop"];
const QUAL: &str = r"(?:(?:lowp|mediump|highp)\s+)?";
static UNIFORM: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"\buniform\s+{QUAL}(\w+)\s+([^;]+);")).unwrap());
macro_rules! re {
    ($name:ident, $src:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| Regex::new($src).unwrap());
    };
}

#[derive(Clone, Debug, Default)]
pub struct Uniform {
    pub name: String,
    pub ty: String,
    pub flags: Vec<&'static str>,
    pub label: Option<String>,
    pub default: Option<Value>,
    pub min: Option<f64>,
    pub max: Option<f64>,
    pub mipmap: Option<bool>,
    /// what a sampler reads: 'pencil:object' | 'pencil:background' | 'sdf' | an image url
    pub role: Option<String>,
}
impl Uniform {
    pub fn has(&self, flag: &str) -> bool {
        self.flags.contains(&flag)
    }
}

fn directives(comment: &str, u: &mut Uniform) {
    re!(ENDS, r"^/\*\*|\*/$");
    re!(STAR, r"^\s*\*\s?");
    re!(ITEM, r"@(\w+)\s*([^@]*)");
    re!(PAREN, r"^\((.*)\)$");
    let body = ENDS.replace_all(comment, "");
    for line in body.split('\n') {
        let s = STAR.replace(line, "");
        let s = s.trim();
        if !s.starts_with('@') {
            continue; // plain description
        }
        for c in ITEM.captures_iter(s) {
            let key = &c[1];
            let raw = c[2].trim();
            let arg = PAREN.replace(raw, "$1").trim().to_string();
            let nums = || arg.split(',').map(|x| str_number(x)).collect::<Vec<f64>>();
            if let Some(f) = FLAGS.iter().find(|f| **f == key) {
                if !u.flags.contains(f) {
                    u.flags.push(f);
                }
            } else if key == "label" {
                u.label = Some(arg.clone());
            } else if key == "range" {
                let n = nums();
                u.min = n.first().copied();
                u.max = n.get(1).copied();
            } else if key == "min" {
                u.min = Some(str_number(&arg));
            } else if key == "max" {
                u.max = Some(str_number(&arg));
            } else if key == "mipmap" {
                u.mipmap = Some(arg != "false");
            } else if key == "default" {
                let l = nums();
                u.default = Some(if arg == "true" {
                    Value::Bool(true)
                } else if arg == "false" {
                    Value::Bool(false)
                } else if arg.starts_with('#') || l.iter().any(|x| x.is_nan()) {
                    Value::String(arg.clone())
                } else if l.len() == 1 {
                    num_value(l[0])
                } else {
                    Value::Array(l.iter().map(|x| num_value(*x)).collect())
                });
            }
        }
    }
}
fn num_value(x: f64) -> Value {
    serde_json::Number::from_f64(x).map(Value::Number).unwrap_or(Value::Null)
}

/// The shader's uniforms with their annotations, in source order.
pub fn parse_uniforms(src: &str) -> Vec<Uniform> {
    static ANY: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"(?s)/\*.*?\*/|//[^\n]*|{}", UNIFORM.as_str())).unwrap());
    let mut out = vec![];
    let mut doc: Option<String> = None;
    let mut doc_end = 0;
    for m in ANY.captures_iter(src) {
        let all = m.get(0).unwrap();
        let t = all.as_str();
        if t.starts_with("/*") {
            doc = t.starts_with("/**").then(|| t.to_string());
            doc_end = all.end();
            continue;
        }
        if t.starts_with("//") {
            continue;
        }
        let mut notes = Uniform::default();
        if let Some(d) = &doc {
            if src[doc_end..all.start()].trim().is_empty() {
                directives(d, &mut notes);
            }
        }
        doc = None;
        for d in m[2].split(',') {
            let name: String = d.trim_start().chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
            if name.is_empty() {
                continue;
            }
            let mut u = Uniform { name, ty: m[1].into(), ..notes.clone() };
            if u.ty == "sampler2D" {
                u.role = if u.has("content") {
                    Some("pencil:object".into())
                } else if u.has("backdrop") {
                    Some("pencil:background".into())
                } else if u.has("sdf") {
                    Some("sdf".into())
                } else if let Some(Value::String(s)) = &u.default {
                    Some(s.clone())
                } else {
                    None
                };
            }
            out.push(u);
        }
    }
    out
}

// ---------------------------------------------------------------- GLSL -> SkSL
fn size_name(i: usize) -> String {
    format!("pena_size{i}")
}
fn blank(s: &str) -> String {
    s.chars().map(|c| if c == '\n' { '\n' } else { ' ' }).collect()
}
fn strip_newlines_kept(s: &str) -> String {
    s.chars().filter(|c| *c == '\n').collect()
}

pub struct SkSL {
    pub sksl: String,
    pub samplers: Vec<String>,
    pub first_line: usize,
}

pub fn to_sksl(src: &str) -> Result<SkSL, String> {
    re!(COMMENTS, r"(?s)/\*.*?\*/|//[^\n]*");
    re!(DIRECTIVE, r"(?m)^[ \t]*#[ \t]*(\w+)(.*)$");
    re!(DEFINE, r"^\s+(\w+)(\()?\s*(.*)$");
    re!(PRECISION, r"\bprecision\s+\w+\s+\w+\s*;");
    re!(VARYING, r"\b(varying|attribute)\b");
    re!(IN_DECL, r"(?m)(^|[;}])\s*in\s+\w+\s+\w+\s*;");
    re!(BOOLS, r"^(bool|bvec[234])$");
    re!(IDENT, r"(\.\s*)?\b[A-Za-z_]\w*\b");
    re!(MAIN, r"\bvoid\s+main\s*\(\s*(?:void)?\s*\)\s*\{");
    re!(RETURN, r"\breturn\s*;");
    static OUT: LazyLock<Regex> = LazyLock::new(|| Regex::new(&format!(r"(^|[;}}\s])out\s+{QUAL}vec4\s+(\w+)\s*;")).unwrap());

    // comments out, newlines kept so compile errors point at the right line
    let mut code = COMMENTS.replace_all(src, |c: &Captures| blank(&c[0])).into_owned();
    let mut v300 = false;
    let mut defines: Vec<(String, String)> = vec![];
    let mut err = None;
    code = DIRECTIVE
        .replace_all(&code, |c: &Captures| {
            let (dir, rest) = (&c[1], &c[2]);
            if dir == "version" {
                v300 = rest.trim().split(|ch: char| !ch.is_ascii_digit()).next().and_then(|n| n.parse::<i32>().ok()).is_some_and(|n| n >= 300);
                return String::new();
            }
            if dir == "extension" || dir == "pragma" {
                return String::new();
            }
            if dir != "define" {
                err.get_or_insert(format!("#{dir} is not supported (only #define NAME value)"));
                return String::new();
            }
            match DEFINE.captures(rest) {
                Some(m) if m.get(2).is_none() => defines.push((m[1].to_string(), m[3].trim().to_string())),
                _ => {
                    err.get_or_insert("Only object-like macros are supported: #define NAME value".into());
                }
            }
            String::new()
        })
        .into_owned();
    if let Some(e) = err {
        return Err(e);
    }
    let expand = |s: &str, list: &[(String, String)]| {
        list.iter().fold(s.to_string(), |acc, (name, value)| Regex::new(&format!(r"\b{}\b", regex::escape(name))).unwrap().replace_all(&acc, regex::NoExpand(value)).into_owned())
    };
    for i in 0..defines.len() {
        let v = expand(&defines[i].1, &defines[..i]);
        defines[i].1 = v;
    }
    code = PRECISION.replace_all(&expand(&code, &defines), "").into_owned();
    if VARYING.is_match(&code) || IN_DECL.is_match(&code) {
        return Err("The shader can only use gl_FragCoord and uniforms (no varyings).".into());
    }

    let mut decls = vec![];
    let mut samplers: Vec<String> = vec![];
    let mut bools: HashMap<String, String> = HashMap::new();
    code = UNIFORM
        .replace_all(&code, |c: &Captures| {
            let ty = &c[1];
            for d in c[2].split(',') {
                let t = d.trim_start();
                let name: String = t.chars().take_while(|ch| ch.is_alphanumeric() || *ch == '_').collect();
                let rest = d.trim()[name.len().min(d.trim().len())..].to_string();
                if ty == "sampler2D" {
                    decls.push(format!("uniform shader {name};"));
                    samplers.push(name);
                } else if BOOLS.is_match(ty) {
                    // SkSL has no bool uniforms: an int, read back as a bool wherever it is used
                    let n = &ty[ty.len() - 1..];
                    bools.insert(name.clone(), if ty == "bool" { format!("({name} != 0)") } else { format!("bool{n}({name})") });
                    decls.push(format!("uniform {} {name}{rest};", if ty == "bool" { "int".to_string() } else { format!("int{n}") }));
                } else {
                    decls.push(format!("uniform {ty} {name}{rest};"));
                }
            }
            strip_newlines_kept(&c[0]) // keep the line count, so errors point at the source's lines
        })
        .into_owned();
    let mut color: Option<String> = None;
    if let Some(c) = OUT.captures(&code) {
        let (all, pre) = (c.get(0).unwrap().range(), c[1].to_string());
        color = Some(c[2].to_string());
        code.replace_range(all, &pre);
    }
    if color.is_none() && Regex::new(r"\bgl_FragColor\b").unwrap().is_match(&code) {
        color = Some("pena_color".into());
    }
    let Some(color) = color else { return Err("No color output found: write gl_FragColor (or `out vec4` with #version 300 es).".into()) };
    let sampler: HashMap<&str, String> = samplers.iter().enumerate().map(|(i, s)| (s.as_str(), i.to_string())).collect();
    let mut rename: HashMap<&str, &str> = [("gl_FragColor", "pena_color"), ("gl_FragCoord", "pena_coord"), ("texture2D", "pena_tex"), ("texture2DLod", "pena_tex"), ("textureSize", "pena_texSize"), ("sampler2D", "int")].into_iter().collect();
    if v300 {
        rename.insert("texture", "pena_tex");
        rename.insert("textureLod", "pena_tex");
    }
    code = IDENT
        .replace_all(&code, |c: &Captures| {
            let id = &c[0];
            if c.get(1).is_some() {
                return id.to_string();
            }
            rename.get(id).map(|s| s.to_string()).or_else(|| sampler.get(id).cloned()).or_else(|| bools.get(id).cloned()).unwrap_or_else(|| id.to_string())
        })
        .into_owned();

    let Some(head) = MAIN.find(&code) else { return Err("main() is missing!".into()) };
    let bytes = code.as_bytes();
    let (mut depth, mut end) = (0i32, None);
    for (i, b) in bytes.iter().enumerate().skip(head.end() - 1) {
        if *b == b'{' {
            depth += 1;
        } else if *b == b'}' {
            depth -= 1;
            if depth == 0 {
                end = Some(i);
                break;
            }
        }
    }
    let Some(end) = end else { return Err("main() is not closed".into()) };
    let body = RETURN.replace_all(&code[head.end()..end], regex::NoExpand(&format!("return {color};"))).into_owned();
    code = format!("{}float4 main(float2 pena_p) {{ pena_coord = float4(pena_p, 0.0, 1.0);{body}\nreturn {color};\n}}{}", &code[..head.start()], &code[end + 1..]);

    let tex: String = samplers.iter().enumerate().map(|(i, s)| format!("  if (pena_t == {i}) return {s}.eval(pena_uv * {});\n", size_name(i))).collect();
    let tex_size: String = (0..samplers.len()).map(|i| format!("  if (pena_t == {i}) return int2({});\n", size_name(i))).collect();
    let mut helpers: Vec<String> = (0..samplers.len()).map(|i| format!("uniform float2 {};", size_name(i))).collect();
    helpers.extend([
        "float4 pena_coord;".to_string(),
        format!("float4 {color};"),
        format!("float4 pena_tex(int pena_t, float2 pena_uv) {{\n{tex}  return float4(0.0);\n}}"),
        "float4 pena_tex(int pena_t, float2 pena_uv, float pena_lod) { return pena_tex(pena_t, pena_uv); }".into(),
        format!("int2 pena_texSize(int pena_t) {{\n{tex_size}  return int2(1);\n}}"),
        "int2 pena_texSize(int pena_t, int pena_lod) { return pena_texSize(pena_t); }".into(),
    ]);
    let prelude = format!("{}{}\n{}\n", if v300 { "#version 300\n" } else { "" }, decls.join("\n"), helpers.join("\n"));
    let first_line = prelude.split('\n').count();
    Ok(SkSL { sksl: prelude + &code, samplers, first_line })
}

// ---------------------------------------------------------------- programs
#[derive(Clone, Copy, Debug)]
pub struct Slot {
    pub slot: usize,
    pub columns: usize,
    pub rows: usize,
    pub integer: bool,
}
#[derive(Clone)]
pub struct Program {
    pub effect: RuntimeEffect,
    pub uniforms: Vec<Uniform>,
    pub floats: usize,
    pub samplers: Vec<Option<Uniform>>,
    pub sizes: Vec<Option<Slot>>,
    pub slots: HashMap<String, Slot>,
}

fn slot_of(ty: UType, offset: usize) -> Slot {
    let (columns, rows, integer) = match ty {
        UType::Float => (1, 1, false),
        UType::Float2 => (2, 1, false),
        UType::Float3 => (3, 1, false),
        UType::Float4 => (4, 1, false),
        UType::Float2x2 => (2, 2, false),
        UType::Float3x3 => (3, 3, false),
        UType::Float4x4 => (4, 4, false),
        UType::Int => (1, 1, true),
        UType::Int2 => (2, 1, true),
        UType::Int3 => (3, 1, true),
        UType::Int4 => (4, 1, true),
    };
    Slot { slot: offset / 4, columns, rows, integer }
}

/// Compiles a source; the error text is what the shader panel and the render warnings show.
pub fn program(src: &str) -> Result<Program, String> {
    re!(ERR_LINE, r"^(error: )?\d+: ");
    re!(ERR_NUM, r"^(?:error: )?(\d+): ");
    let SkSL { sksl, samplers, first_line } = to_sksl(src)?;
    let effect = RuntimeEffect::make_for_shader(&sksl, None).map_err(|error| {
        // "13: unknown identifier 'x'\n<code>\n^^^" -> "line 3: unknown identifier 'x'" (source lines)
        let lines: Vec<String> = error
            .split('\n')
            .filter(|l| ERR_LINE.is_match(l))
            .map(|l| ERR_NUM.replace(l, |c: &Captures| format!("line {}: ", (c[1].parse::<i64>().unwrap_or(0) - first_line as i64 + 1).max(1))).into_owned())
            .collect();
        if lines.is_empty() { "The shader does not compile".to_string() } else { lines.join("\n") }
    })?;
    let slots: HashMap<String, Slot> = effect.uniforms().iter().map(|u| (u.name().to_string(), slot_of(u.ty(), u.offset()))).collect();
    let uniforms = parse_uniforms(src);
    Ok(Program {
        floats: effect.uniform_size() / 4,
        samplers: samplers.iter().map(|name| uniforms.iter().find(|u| &u.name == name).cloned()).collect(),
        sizes: (0..samplers.len()).map(|i| slots.get(&size_name(i)).copied()).collect(),
        uniforms,
        slots,
        effect,
    })
}

fn parse_hex_prefix(s: &str) -> f64 {
    // JS parseInt(s, 16): leading hex digits, NaN if none
    let digits: String = s.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    if digits.is_empty() { f64::NAN } else { i64::from_str_radix(&digits, 16).map(|n| n as f64).unwrap_or(f64::NAN) }
}
fn hex_color(s: &str, n: usize) -> Vec<f64> {
    let mut x = s.replacen('#', "", 1);
    if x.chars().count() <= 4 {
        x = x.chars().flat_map(|c| [c, c]).collect();
    }
    let chars: Vec<char> = x.chars().collect();
    [0, 2, 4, 6]
        .iter()
        .map(|&i| if chars.len() > i { parse_hex_prefix(&chars[i..(i + 2).min(chars.len())].iter().collect::<String>()) / 255.0 } else { 1.0 })
        .take(n)
        .map(|c| if c.is_finite() { c } else { 0.0 })
        .collect()
}

pub struct Auto {
    pub resolution: [f64; 2],
    pub time: f64,
    pub mouse: [f64; 2],
}
/// The uniform buffer: user values (already resolved from variables) over the defaults, plus the automatic ones.
pub fn uniform_data(p: &Program, values: &Map<String, Value>, auto: &Auto, sizes: &[[f64; 2]]) -> Data {
    let mut words = vec![0u32; p.floats.max(1)];
    let put = |words: &mut Vec<u32>, slot: Option<&Slot>, v: &Value| {
        let Some(slot) = slot else { return };
        let one = |x: &Value| if let Value::Bool(b) = x { *b as i32 as f64 } else { num0(x) };
        let list: Vec<f64> = match v {
            Value::Null => vec![0.0],
            Value::Array(a) => a.iter().map(one).collect(),
            x => vec![one(x)],
        };
        // ponytail: uniform arrays get their first element only (as in the editor)
        for k in 0..slot.columns * slot.rows {
            let x = list.get(k).copied().unwrap_or(0.0);
            if let Some(w) = words.get_mut(slot.slot + k) {
                *w = if slot.integer { (crate::core::round(x) as i32) as u32 } else { (x as f32).to_bits() };
            }
        }
    };
    let arr = |a: &[f64]| Value::Array(a.iter().map(|x| num_value(*x)).collect());
    for u in &p.uniforms {
        let slot = p.slots.get(&u.name);
        if slot.is_none() || u.ty == "sampler2D" {
            continue;
        }
        if u.has("resolution") {
            put(&mut words, slot, &arr(&auto.resolution));
        } else if u.has("time") {
            put(&mut words, slot, &num_value(auto.time));
        } else if u.has("mouse") {
            put(&mut words, slot, &arr(&auto.mouse));
        } else {
            let v = values.get(&u.name).filter(|v| !v.is_null()).or(u.default.as_ref()).cloned().unwrap_or(Value::Null);
            if u.has("color") {
                let s = if let Value::String(s) = &v { s.clone() } else { "#ffffff".into() };
                put(&mut words, slot, &arr(&hex_color(&s, if u.ty.ends_with('4') { 4 } else { 3 })));
            } else {
                put(&mut words, slot, &v);
            }
        }
    }
    for (i, s) in sizes.iter().enumerate() {
        put(&mut words, p.sizes.get(i).and_then(|s| s.as_ref()), &arr(s));
    }
    let bytes: Vec<u8> = words.iter().flat_map(|w| w.to_ne_bytes()).collect();
    Data::new_copy(&bytes)
}

// ---------------------------------------------------------------- signed distance fields
// Rectangles (rounded) and ellipses: exact, computed per pixel. In local px, y down; output y up like GLSL.
static RRECT_SDF: &str = r"
    uniform float4 size; uniform float4 radii; // tl tr br bl
    half4 main(float2 p) {
      float2 b = size.xy * 0.5, q0 = p - b;
      float r = q0.x < 0.0 ? (q0.y < 0.0 ? radii.x : radii.w) : (q0.y < 0.0 ? radii.y : radii.z);
      float2 q = abs(q0) - b + r;
      float d; float2 u;
      if (q.x > 0.0 && q.y > 0.0) { float l = length(q); d = r - l; u = q / l; }
      else { d = r - max(q.x, q.y); u = q.x > q.y ? float2(1.0, 0.0) : float2(0.0, 1.0); }
      float2 n = -sign(q0) * u;
      return half4(d, n.x, -n.y, 1.0);
    }";
static OVAL_SDF: &str = r"
    uniform float4 size;
    half4 main(float2 p) {
      float2 ab = max(size.xy * 0.5, float2(0.001)), pc = p - ab;
      float k0 = length(pc / ab), k1 = length(pc / (ab * ab));
      float d = k1 > 0.0 ? -k0 * (k0 - 1.0) / k1 : min(ab.x, ab.y);
      float2 n = length(pc) > 0.0 ? -normalize(pc / (ab * ab)) : float2(0.0, -1.0);
      return half4(d, n.x, -n.y, 1.0);
    }";
pub fn shape_sdf(oval: bool, w: f64, h: f64, radii: [f64; 4], local: &Matrix) -> Option<Shader> {
    static EFFECTS: LazyLock<(String, String)> = LazyLock::new(|| (RRECT_SDF.into(), OVAL_SDF.into()));
    let src = if oval { &EFFECTS.1 } else { &EFFECTS.0 };
    let effect = RuntimeEffect::make_for_shader(src, None).ok()?;
    let mut f: Vec<f32> = vec![w as f32, h as f32, 0.0, 0.0];
    if !oval {
        f.extend(radii.iter().map(|r| *r as f32));
    }
    let bytes: Vec<u8> = f.iter().flat_map(|x| x.to_ne_bytes()).collect();
    effect.make_shader(Data::new_copy(&bytes), &[], local)
}

// Anything else (paths, text, a whole rendered node): from the picture's coverage, with a Euclidean distance transform
// (Felzenszwalb & Huttenlocher) on a small CPU raster. Returns the image and its scale, texels covering `box`.
const SDF_TEXELS: f64 = 384.0;
pub fn picture_sdf(pic: &Picture, bx: [f64; 4]) -> Option<(Image, f64)> {
    let (w, h) = (bx[2] - bx[0], bx[3] - bx[1]);
    let k = (SDF_TEXELS / w.max(h).max(1.0)).min(2.0);
    let (tw, th) = (((w * k).ceil() as i32).max(2), ((h * k).ceil() as i32).max(2));
    let mut surface = crate::raster_surface(tw, th)?;
    let c = surface.canvas();
    c.clear(skia_safe::Color::TRANSPARENT);
    c.scale((k as f32, k as f32));
    c.translate((-bx[0] as f32, -bx[1] as f32));
    c.draw_picture(pic, None, None);
    let img = surface.image_snapshot();
    let info = ImageInfo::new((tw, th), ColorType::RGBA8888, AlphaType::Unpremul, ColorSpace::new_srgb());
    let mut px = vec![0u8; (tw * th * 4) as usize];
    if !img.read_pixels(&info, &mut px, (tw * 4) as usize, (0, 0), skia_safe::image::CachingHint::Allow) {
        return None;
    }
    let (tw, th) = (tw as usize, th as usize);
    let n = tw * th;
    let inside: Vec<u8> = (0..n).map(|i| (px[i * 4 + 3] >= 128) as u8).collect();
    let to_out = edt(&inside, tw, th, 0);
    let to_in = edt(&inside, tw, th, 1);
    let d: Vec<f64> = (0..n).map(|i| (if inside[i] == 1 { to_out[i].sqrt() - 0.5 } else { 0.5 - to_in[i].sqrt() }) / k).collect();
    let mut out = vec![0f32; n * 4];
    for y in 0..th {
        for x in 0..tw {
            let i = y * tw + x;
            let gx = d[y * tw + (x + 1).min(tw - 1)] - d[y * tw + x.saturating_sub(1)];
            let gy = d[(y + 1).min(th - 1) * tw + x] - d[y.saturating_sub(1) * tw + x];
            let l = gx.hypot(gy);
            let l = if l == 0.0 { 1.0 } else { l };
            out[i * 4..i * 4 + 4].copy_from_slice(&[d[i] as f32, (gx / l) as f32, (-gy / l) as f32, 1.0]);
        }
    }
    let bytes: Vec<u8> = out.iter().flat_map(|x| x.to_ne_bytes()).collect();
    let info = ImageInfo::new((tw as i32, th as i32), ColorType::RGBAF32, AlphaType::Unpremul, ColorSpace::new_srgb());
    let image = skia_safe::images::raster_from_data(&info, Data::new_copy(&bytes), tw * 16)?;
    Some((image, k))
}
// squared distance from each pixel to the nearest pixel whose `inside` equals `target`
fn edt(inside: &[u8], w: usize, h: usize, target: u8) -> Vec<f64> {
    const INF: f64 = 1e20;
    let mut g: Vec<f64> = inside.iter().map(|v| if *v == target { 0.0 } else { INF }).collect();
    let n = w.max(h);
    let (mut f, mut out, mut v, mut z) = (vec![0f64; n], vec![0f64; n], vec![0usize; n], vec![0f64; n + 1]);
    let mut pass = |len: usize, g: &mut Vec<f64>, idx: &dyn Fn(usize) -> usize| {
        for q in 0..len {
            f[q] = g[idx(q)];
        }
        let mut k = 0usize;
        v[0] = 0;
        z[0] = -INF;
        z[1] = INF;
        for q in 1..len {
            let mut s;
            loop {
                let vk = v[k];
                s = (f[q] + (q * q) as f64 - (f[vk] + (vk * vk) as f64)) / (2.0 * q as f64 - 2.0 * vk as f64);
                if s <= z[k] && k > 0 {
                    k -= 1;
                } else {
                    break;
                }
            }
            // k never drops below 0 in the JS either: z[0] is -INF
            k += 1;
            v[k] = q;
            z[k] = s;
            z[k + 1] = INF;
        }
        k = 0;
        for q in 0..len {
            while z[k + 1] < q as f64 {
                k += 1;
            }
            let d = q as f64 - v[k] as f64;
            out[q] = d * d + f[v[k]];
        }
        for q in 0..len {
            g[idx(q)] = out[q];
        }
    };
    for x in 0..w {
        pass(h, &mut g, &|y| y * w + x);
    }
    for y in 0..h {
        pass(w, &mut g, &|x| y * w + x);
    }
    g
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_glsl() {
        let src = "precision mediump float;\n/** @color @default #ff0000 */\nuniform vec3 tint;\n/** @content */ uniform sampler2D img;\nuniform bool on;\n#define K 2.0\nvoid main() {\n  vec4 c = texture2D(img, gl_FragCoord.xy / 10.0);\n  if (on) { gl_FragColor = c * K; return; }\n  gl_FragColor = vec4(tint, 1.0);\n}\n";
        let s = to_sksl(src).unwrap();
        assert_eq!(s.samplers, vec!["img"]);
        assert!(s.sksl.contains("uniform shader img;"));
        assert!(s.sksl.contains("uniform int on;"));
        assert!(s.sksl.contains("pena_tex(0, pena_coord.xy / 10.0)"));
        assert!(s.sksl.contains("if ((on != 0)) { pena_color = c * 2.0; return pena_color; }"));
        let p = program(src).unwrap();
        assert_eq!(p.samplers[0].as_ref().unwrap().role.as_deref(), Some("pencil:object"));
        assert_eq!(p.uniforms[0].default, Some(Value::String("#ff0000".into())));
        assert!(program("void main() { gl_FragColor = vec4(x); }").err().unwrap().starts_with("line 1: "));
        assert_eq!(to_sksl("#include <x>\nvoid main(){}").err().unwrap(), "#include is not supported (only #define NAME value)");
    }
    #[test]
    fn distance_transform() {
        // a 5x1 row with the middle pixel inside: squared distances to it
        let d = edt(&[0, 0, 1, 0, 0], 5, 1, 1);
        assert_eq!(d, vec![4.0, 1.0, 0.0, 1.0, 4.0]);
    }
}
