// The bits of JS semantics the ported converters lean on (Math.round, truthiness, Number(), String(), parseFloat).
use serde_json::{Map, Value};

/// A number as JSON the way JS writes it: integral values without ".0", NaN/Infinity as null.
pub fn num(v: f64) -> Value {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9e15 {
        Value::from(v as i64)
    } else {
        Value::from(v) // NaN → null, like JSON.stringify
    }
}

/// Math.round: halves go up (Rust's round goes away from zero).
pub fn round(v: f64) -> f64 {
    (v + 0.5).floor()
}

/// Math.min / Math.max propagate NaN (f64::min ignores it).
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
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
pub fn ftruthy(x: f64) -> bool {
    x != 0.0 && !x.is_nan()
}

/// Number(string)
pub fn to_number(s: &str) -> f64 {
    let t = s.trim();
    if t.is_empty() {
        return 0.0;
    }
    if let Some(h) = t.strip_prefix("0x").or_else(|| t.strip_prefix("0X")) {
        return u64::from_str_radix(h, 16).map_or(f64::NAN, |v| v as f64);
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if t.bytes().any(|b| b.is_ascii_alphabetic() && b != b'e' && b != b'E') {
        return f64::NAN; // Rust would accept "inf"/"nan"
    }
    t.parse().unwrap_or(f64::NAN)
}

/// Number(value): undefined (missing) and objects → NaN.
pub fn number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::Bool(b) => *b as u8 as f64,
        Value::String(s) => to_number(s),
        Value::Array(a) if a.is_empty() => 0.0,
        Value::Array(a) if a.len() == 1 => number(&a[0]),
        _ => f64::NAN,
    }
}

/// parseFloat: the longest numeric prefix after leading whitespace.
pub fn parse_float(s: &str) -> f64 {
    let t = s.trim_start();
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    if t[i..].starts_with("Infinity") {
        return if b.first() == Some(&b'-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    let digits = |i: &mut usize| {
        let s = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > s
    };
    let mut any = digits(&mut i);
    if i < b.len() && b[i] == b'.' {
        let mut j = i + 1;
        if digits(&mut j) || any {
            any = true;
            i = j;
        }
    }
    if !any {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        let mut j = i + 1;
        if j < b.len() && (b[j] == b'+' || b[j] == b'-') {
            j += 1;
        }
        if digits(&mut j) {
            i = j;
        }
    }
    t[..i].parse().unwrap_or(f64::NAN)
}

/// `${n}`: Number#toString (NaN, Infinity, -0 → "0", exponent forms)
pub fn fmt(v: f64) -> String {
    ryu_js::Buffer::new().format(v).to_string()
}

/// String(value)
pub fn string(v: &Value) -> String {
    match v {
        Value::Null => "undefined".into(),
        Value::String(s) => s.clone(),
        Value::Number(n) => fmt(n.as_f64().unwrap_or(f64::NAN)),
        Value::Bool(b) => b.to_string(),
        Value::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { string(x) }).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// Rewrites integral floats as integers throughout, so the JSON prints like JS's.
pub fn normalize(v: &mut Value) {
    match v {
        Value::Number(n) if n.is_f64() => *v = num(n.as_f64().unwrap()),
        Value::Array(a) => a.iter_mut().for_each(normalize),
        Value::Object(o) => o.values_mut().for_each(normalize),
        _ => {}
    }
}

/// Object literal helper: `obj([("a", v), ...])`.
pub fn obj<const N: usize>(entries: [(&str, Value); N]) -> Value {
    let mut m = Map::new();
    for (k, v) in entries {
        m.insert(k.into(), v);
    }
    Value::Object(m)
}
