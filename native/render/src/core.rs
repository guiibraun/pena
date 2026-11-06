// JS value semantics the renderer relies on (Number(), truthiness, String()), plus the small pieces of
// public/pen-core.js (resolveValue, themeDefaults) and public/render.js (polygon, arc) the scene needs.
use serde_json::{Map, Value};

pub type Theme = Map<String, Value>;

/// JS `Number(v)` (undefined is `Value::Null` here, so it gives 0 instead of NaN).
pub fn number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => *b as i32 as f64,
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::String(s) => str_number(s),
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 => number(&Value::String(js_string(&a[0]))),
        _ => f64::NAN,
    }
}
pub fn str_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    match t {
        "Infinity" | "+Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        _ if t.starts_with("0x") || t.starts_with("0X") => i64::from_str_radix(&t[2..], 16).map(|n| n as f64).unwrap_or(f64::NAN),
        // Rust accepts "inf"/"nan" spellings JS doesn't
        _ if t.chars().any(|c| c.is_ascii_alphabetic() && c != 'e' && c != 'E') => f64::NAN,
        _ => t.parse().unwrap_or(f64::NAN),
    }
}
/// JS `Number(v) || 0`
pub fn num0(v: &Value) -> f64 {
    let n = number(v);
    if n.is_nan() { 0.0 } else { n }
}
pub fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub fn is_false(v: &Value) -> bool {
    matches!(v, Value::Bool(false))
}
/// JS number -> string (integers without a decimal point)
pub fn fmt_num(n: f64) -> String {
    if n.is_nan() {
        "NaN".into()
    } else if n.is_infinite() {
        if n > 0.0 { "Infinity".into() } else { "-Infinity".into() }
    } else if n == n.trunc() && n.abs() < 1e21 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}
/// JS `String(v)`
pub fn js_string(v: &Value) -> String {
    match v {
        Value::Null => "undefined".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => fmt_num(n.as_f64().unwrap_or(f64::NAN)),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
/// `[].concat(v ?? [])`
pub fn list(v: &Value) -> Vec<&Value> {
    match v {
        Value::Null => vec![],
        Value::Array(a) => a.iter().collect(),
        x => vec![x],
    }
}
/// JS Math.round
pub fn round(x: f64) -> f64 {
    (x + 0.5).floor()
}
pub fn get<'a>(v: &'a Value, k: &str) -> &'a Value {
    v.get(k).unwrap_or(&Value::Null)
}

// ---------------------------------------------------------------- pen-core.js
pub fn theme_defaults(doc: &Value) -> Theme {
    let mut all = Map::new();
    for src in [doc.get("_lib").and_then(|l| l.get("themes")), doc.get("themes")] {
        if let Some(Value::Object(m)) = src {
            for (k, v) in m {
                all.insert(k.clone(), v.clone());
            }
        }
    }
    all.into_iter().map(|(axis, values)| (axis, values.get(0).cloned().unwrap_or(Value::Null))).collect()
}

/// `$name` -> the variable's value for the theme (variables can point at variables); undefined -> Null.
pub fn resolve(doc: &Value, v: &Value, theme: &Theme) -> Value {
    resolve_depth(doc, v, theme, 0)
}
fn resolve_depth(doc: &Value, v: &Value, theme: &Theme, depth: u32) -> Value {
    let Value::String(s) = v else { return v.clone() };
    if !s.starts_with('$') || depth > 10 {
        return v.clone();
    }
    let name = &s[1..];
    let def = doc.get("variables").and_then(|m| m.get(name)).or_else(|| doc.get("_lib").and_then(|l| l.get("variables")).and_then(|m| m.get(name)));
    let Some(def) = def else { return Value::Null };
    let mut val = get(def, "value");
    if let Value::Array(entries) = val {
        let fits = |e: &Value| match e.get("theme") {
            Some(Value::Object(t)) => t.iter().all(|(k, x)| theme.get(k) == Some(x)),
            _ => true,
        };
        let keys = |e: &Value| match e.get("theme") { Some(Value::Object(t)) => t.len(), _ => 0 };
        let mut best: Option<&Value> = None;
        for e in entries.iter().filter(|e| fits(e)) {
            // stable sort by key count, descending: the first with the most keys
            if best.is_none_or(|b| keys(e) > keys(b)) {
                best = Some(e);
            }
        }
        val = match best.or(entries.first()) { Some(e) => get(e, "value"), None => &Value::Null };
    }
    let val = val.clone();
    resolve_depth(doc, &val, theme, depth + 1)
}

// ---------------------------------------------------------------- render.js geometry
pub fn polygon(count: f64) -> String {
    let n = if count.is_finite() && count > 0.0 { count.trunc() as usize } else { 0 };
    let pts: Vec<String> = (0..n)
        .map(|i| {
            let a = -std::f64::consts::PI / 2.0 + (i as f64 * 2.0 * std::f64::consts::PI) / count;
            format!("{} {}", js_float(50.0 + 50.0 * a.cos()), js_float(50.0 + 50.0 * a.sin()))
        })
        .collect();
    format!("M{}Z", pts.join("L"))
}
pub fn arc(inner: f64, start: f64, mut sweep: f64) -> String {
    let pt = |r: f64, deg: f64| [50.0 + r * (-deg * std::f64::consts::PI / 180.0).cos(), 50.0 + r * (-deg * std::f64::consts::PI / 180.0).sin()];
    let full = sweep.abs() >= 360.0;
    if full {
        sweep = 359.99;
    }
    let end = start + sweep;
    let large = if sweep.abs() > 180.0 { 1 } else { 0 };
    let dir = if sweep > 0.0 { 0 } else { 1 };
    let ri = 50.0 * inner;
    let [x1, y1] = pt(50.0, start);
    let [x2, y2] = pt(50.0, end);
    let f = js_float;
    let mut d = format!("M{} {}A50 50 0 {large} {dir} {} {}", f(x1), f(y1), f(x2), f(y2));
    if ri > 0.0 {
        let [x3, y3] = pt(ri, end);
        let [x4, y4] = pt(ri, start);
        d += &format!("L{} {}A{} {} 0 {large} {} {} {}Z", f(x3), f(y3), f(ri), f(ri), 1 - dir, f(x4), f(y4));
    } else {
        d += if full { "Z" } else { "L50 50Z" };
    }
    d
}
/// shortest round-trip float text, like JS (Rust's `{}` for f64 is also shortest round-trip)
fn js_float(x: f64) -> String {
    if x == x.trunc() && x.abs() < 1e21 { fmt_num(x) } else { format!("{x}") }
}

/// encodeURIComponent
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out += &format!("%{b:02X}");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_themed_variables() {
        let doc = json!({ "themes": { "Mode": ["Light", "Dark"] }, "variables": {
            "bg": { "value": [{ "value": "#fff" }, { "value": "#000", "theme": { "Mode": "Dark" } }] },
            "alias": { "value": "$bg" } } });
        let light = theme_defaults(&doc);
        assert_eq!(light.get("Mode"), Some(&json!("Light")));
        assert_eq!(resolve(&doc, &json!("$alias"), &light), json!("#fff"));
        let dark: Theme = [("Mode".to_string(), json!("Dark"))].into_iter().collect();
        assert_eq!(resolve(&doc, &json!("$bg"), &dark), json!("#000"));
        assert_eq!(resolve(&doc, &json!("$nope"), &light), Value::Null);
        assert_eq!(resolve(&doc, &json!(12), &light), json!(12));
    }
    #[test]
    fn js_numbers() {
        assert_eq!(num0(&json!("12.5")), 12.5);
        assert_eq!(num0(&json!("abc")), 0.0);
        assert_eq!(fmt_num(400.0), "400");
        assert_eq!(polygon(3.0), "M50 0L93.30127018922194 75L6.698729810778076 75.00000000000001Z");
    }
}
