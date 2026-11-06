// Kiwi (evanw/kiwi), the binary format inside Figma's fig-kiwi archives: a binary schema plus messages encoded with it.
// Mirrors kiwi-schema 0.5's JS ByteBuffer / compiled codecs, mapped onto serde_json values (enums as their names,
// int64 as numbers). byte[] fields are hex strings: a JSON array per byte would cost ~30x the blob size in RAM.
use anyhow::{Result, bail};
use serde_json::{Map, Value};
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Enum,
    Struct,
    Message,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Type {
    Bool,
    Byte,
    Int,
    Uint,
    Float,
    String,
    Int64,
    Uint64,
    Def(usize),
}
const NATIVE: [Type; 8] = [Type::Bool, Type::Byte, Type::Int, Type::Uint, Type::Float, Type::String, Type::Int64, Type::Uint64];

#[derive(Debug)]
pub struct Field {
    pub name: String,
    pub ty: Option<Type>, // None for enum members
    pub array: bool,
    pub value: u32,
}

#[derive(Debug)]
pub struct Def {
    pub name: String,
    pub kind: Kind,
    pub fields: Vec<Field>,
}

pub struct Schema {
    pub defs: Vec<Def>,
    by_name: HashMap<String, usize>,
}

// Malformed or hostile files could nest messages without bound (NodeChange → symbolOverrides → NodeChange …).
const MAX_DEPTH: usize = 256;

struct Reader<'a> {
    data: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn byte(&mut self) -> Result<u8> {
        let Some(&b) = self.data.get(self.i) else { bail!("Index out of bounds") };
        self.i += 1;
        Ok(b)
    }
    fn uint(&mut self) -> Result<u32> {
        let (mut v, mut shift) = (0u32, 0u32);
        loop {
            let b = self.byte()?;
            v |= ((b & 127) as u32).wrapping_shl(shift);
            shift += 7;
            if b & 128 == 0 || shift >= 35 {
                return Ok(v);
            }
        }
    }
    fn int(&mut self) -> Result<i32> {
        let v = self.uint()?;
        Ok(if v & 1 != 0 { !((v >> 1) as i32) } else { (v >> 1) as i32 })
    }
    fn uint64(&mut self) -> Result<u64> {
        let (mut v, mut shift) = (0u64, 0u32);
        loop {
            let b = self.byte()?;
            if b & 128 == 0 || shift >= 56 {
                return Ok(v | (b as u64).wrapping_shl(shift));
            }
            v |= ((b & 127) as u64) << shift;
            shift += 7;
        }
    }
    fn int64(&mut self) -> Result<i64> {
        let v = self.uint64()?;
        Ok(if v & 1 != 0 { !((v >> 1) as i64) } else { (v >> 1) as i64 })
    }
    fn float(&mut self) -> Result<f32> {
        let Some(&first) = self.data.get(self.i) else { bail!("Index out of bounds") };
        if first == 0 {
            self.i += 1;
            return Ok(0.0);
        }
        let Some(b) = self.data.get(self.i..self.i + 4) else { bail!("Index out of bounds") };
        let bits = u32::from_le_bytes([b[0], b[1], b[2], b[3]]);
        self.i += 4;
        Ok(f32::from_bits(bits.rotate_left(23)))
    }
    fn string(&mut self) -> Result<String> {
        let rest = &self.data[self.i..];
        let Some(n) = rest.iter().position(|&b| b == 0) else { bail!("Index out of bounds") };
        self.i += n + 1;
        Ok(String::from_utf8_lossy(&rest[..n]).into_owned())
    }
    fn bytes(&mut self) -> Result<&[u8]> {
        let n = self.uint()? as usize;
        let Some(b) = self.data.get(self.i..self.i + n) else { bail!("Read array out of bounds") };
        self.i += n;
        Ok(b)
    }
}

#[derive(Default)]
pub struct Writer(pub Vec<u8>);

impl Writer {
    fn uint(&mut self, mut v: u32) {
        loop {
            let b = (v & 127) as u8;
            v >>= 7;
            self.0.push(if v != 0 { b | 128 } else { b });
            if v == 0 {
                break;
            }
        }
    }
    fn int(&mut self, v: i32) {
        self.uint(((v << 1) ^ (v >> 31)) as u32);
    }
    fn uint64(&mut self, mut v: u64) {
        let mut i = 0;
        while v > 127 && i < 8 {
            self.0.push((v & 127) as u8 | 128);
            v >>= 7;
            i += 1;
        }
        self.0.push(v as u8);
    }
    fn float(&mut self, v: f32) {
        let bits = v.to_bits().rotate_right(23);
        if bits & 255 == 0 {
            self.0.push(0);
        } else {
            self.0.extend_from_slice(&bits.to_le_bytes());
        }
    }
    fn string(&mut self, s: &str) -> Result<()> {
        if s.contains('\0') {
            bail!("Cannot encode a string containing the null character");
        }
        self.0.extend_from_slice(s.as_bytes());
        self.0.push(0);
        Ok(())
    }
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
pub fn unhex(s: &str) -> Vec<u8> {
    (0..s.len() / 2).filter_map(|i| u8::from_str_radix(s.get(i * 2..i * 2 + 2)?, 16).ok()).collect()
}

// JS ToNumber for the values the encoder may get (numbers, booleans, numeric strings).
fn number(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        Value::Bool(b) => *b as u8 as f64,
        Value::String(s) => crate::js::to_number(s),
        _ => f64::NAN,
    }
}
// JS ToUint32 / ToInt32 (what `>>> 0` and `| 0` do)
fn to_u32(x: f64) -> u32 {
    if !x.is_finite() { 0 } else { x.trunc().rem_euclid(4294967296.0) as u32 }
}

impl Schema {
    pub fn new(defs: Vec<Def>) -> Schema {
        let by_name = defs.iter().enumerate().map(|(i, d)| (d.name.clone(), i)).collect();
        Schema { defs, by_name }
    }

    pub fn decode(bytes: &[u8]) -> Result<Schema> {
        let mut r = Reader { data: bytes, i: 0 };
        let n = r.uint()?;
        let mut raw = Vec::new();
        for _ in 0..n {
            let name = r.string()?;
            let kind = match r.byte()? {
                0 => Kind::Enum,
                1 => Kind::Struct,
                2 => Kind::Message,
                k => bail!("Invalid kind {k}"),
            };
            let nf = r.uint()?;
            let mut fields = Vec::new();
            for _ in 0..nf {
                let fname = r.string()?;
                let ty = r.int()?;
                let array = r.byte()? & 1 != 0;
                let value = r.uint()?;
                fields.push((fname, ty, array, value));
            }
            raw.push((name, kind, fields));
        }
        let count = raw.len();
        let defs = raw
            .into_iter()
            .map(|(name, kind, fields)| {
                let fields = fields
                    .into_iter()
                    .map(|(name, ty, array, value)| {
                        let ty = if kind == Kind::Enum {
                            None
                        } else if ty < 0 {
                            Some(*NATIVE.get(!ty as usize).ok_or_else(|| anyhow::anyhow!("Invalid type {ty}"))?)
                        } else if (ty as usize) < count {
                            Some(Type::Def(ty as usize))
                        } else {
                            bail!("Invalid type {ty}")
                        };
                        Ok(Field { name, ty, array, value })
                    })
                    .collect::<Result<_>>()?;
                Ok(Def { name, kind, fields })
            })
            .collect::<Result<_>>()?;
        Ok(Schema::new(defs))
    }

    #[cfg(test)]
    pub fn encode(&self) -> Vec<u8> {
        let mut w = Writer::default();
        w.uint(self.defs.len() as u32);
        for d in &self.defs {
            let _ = w.string(&d.name);
            w.0.push(match d.kind {
                Kind::Enum => 0,
                Kind::Struct => 1,
                Kind::Message => 2,
            });
            w.uint(d.fields.len() as u32);
            for f in &d.fields {
                let _ = w.string(&f.name);
                w.int(match f.ty {
                    None => 0,
                    Some(Type::Def(i)) => i as i32,
                    Some(t) => !(NATIVE.iter().position(|&n| n == t).unwrap() as i32),
                });
                w.0.push(f.array as u8);
                w.uint(f.value);
            }
        }
        w.0
    }

    fn root(&self) -> Result<usize> {
        self.by_name.get("Message").copied().ok_or_else(|| anyhow::anyhow!("Schema has no Message type"))
    }

    pub fn decode_message(&self, bytes: &[u8]) -> Result<Value> {
        let mut r = Reader { data: bytes, i: 0 };
        self.decode_def(self.root()?, &mut r, 0)
    }

    fn decode_def(&self, di: usize, r: &mut Reader, depth: usize) -> Result<Value> {
        if depth > MAX_DEPTH {
            bail!("Message nested too deeply");
        }
        let d = &self.defs[di];
        let mut out = Map::new();
        match d.kind {
            Kind::Enum => bail!("Enum used as a message"),
            Kind::Struct => {
                for f in &d.fields {
                    let v = self.decode_field(f, r, depth)?;
                    out.insert(f.name.clone(), v);
                }
            }
            Kind::Message => loop {
                let id = r.uint()?;
                if id == 0 {
                    break;
                }
                let Some(f) = d.fields.iter().find(|f| f.value == id) else { bail!("Attempted to parse invalid message") };
                let v = self.decode_field(f, r, depth)?;
                // an unknown enum value decodes to undefined in JS: leave the key out
                if !v.is_null() {
                    out.insert(f.name.clone(), v);
                } else {
                    out.shift_remove(&f.name);
                }
            },
        }
        Ok(Value::Object(out))
    }

    fn decode_field(&self, f: &Field, r: &mut Reader, depth: usize) -> Result<Value> {
        let ty = f.ty.ok_or_else(|| anyhow::anyhow!("Invalid field"))?;
        if f.array {
            if ty == Type::Byte {
                return Ok(Value::String(hex(r.bytes()?)));
            }
            let n = r.uint()? as usize;
            let mut items = Vec::with_capacity(n.min(1 << 16));
            for _ in 0..n {
                items.push(self.decode_one(ty, r, depth)?);
            }
            return Ok(Value::Array(items));
        }
        self.decode_one(ty, r, depth)
    }

    fn decode_one(&self, ty: Type, r: &mut Reader, depth: usize) -> Result<Value> {
        Ok(match ty {
            Type::Bool => Value::Bool(r.byte()? != 0),
            Type::Byte => r.byte()?.into(),
            Type::Int => r.int()?.into(),
            Type::Uint => r.uint()?.into(),
            Type::Float => crate::js::num(r.float()? as f64),
            Type::String => Value::String(r.string()?),
            Type::Int64 => r.int64()?.into(),
            Type::Uint64 => r.uint64()?.into(),
            Type::Def(i) => {
                let d = &self.defs[i];
                if d.kind == Kind::Enum {
                    let v = r.uint()?;
                    d.fields.iter().find(|f| f.value == v).map_or(Value::Null, |f| Value::String(f.name.clone()))
                } else {
                    self.decode_def(i, r, depth + 1)?
                }
            }
        })
    }

    pub fn encode_message(&self, v: &Value) -> Result<Vec<u8>> {
        let mut w = Writer::default();
        self.encode_def(self.root()?, v, &mut w)?;
        Ok(w.0)
    }

    fn encode_def(&self, di: usize, v: &Value, w: &mut Writer) -> Result<()> {
        let d = &self.defs[di];
        for f in &d.fields {
            let x = v.get(&f.name).filter(|x| !x.is_null());
            let Some(x) = x else {
                if d.kind == Kind::Struct {
                    bail!("Missing required field {:?}", f.name);
                }
                continue;
            };
            if d.kind == Kind::Message {
                w.uint(f.value);
            }
            let ty = f.ty.ok_or_else(|| anyhow::anyhow!("Invalid field"))?;
            if f.array {
                if ty == Type::Byte {
                    let b = match x {
                        Value::String(s) => unhex(s),
                        Value::Array(a) => a.iter().map(|b| to_u32(number(b)) as u8).collect(),
                        _ => bail!("Expected bytes for field {:?}", f.name),
                    };
                    w.uint(b.len() as u32);
                    w.0.extend_from_slice(&b);
                } else {
                    let Value::Array(a) = x else { bail!("Expected an array for field {:?}", f.name) };
                    w.uint(a.len() as u32);
                    for item in a {
                        self.encode_one(ty, item, w)?;
                    }
                }
            } else {
                self.encode_one(ty, x, w)?;
            }
        }
        if d.kind == Kind::Message {
            w.uint(0);
        }
        Ok(())
    }

    fn encode_one(&self, ty: Type, v: &Value, w: &mut Writer) -> Result<()> {
        match ty {
            Type::Bool | Type::Byte => w.0.push(to_u32(number(v)) as u8),
            Type::Int => {
                let n = number(v);
                if !(-2147483648.0..=2147483647.0).contains(&n) && !n.is_nan() {
                    bail!("Outside int range: {n}");
                }
                w.int(to_u32(n) as i32)
            }
            Type::Uint => {
                let n = number(v);
                if !(0.0..=4294967295.0).contains(&n) && !n.is_nan() {
                    bail!("Outside uint range: {n}");
                }
                w.uint(to_u32(n))
            }
            Type::Float => w.float(number(v) as f32),
            Type::String => w.string(v.as_str().unwrap_or(""))?,
            Type::Int64 => {
                let n = v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok()));
                let Some(n) = n else { bail!("Expected int64 but got {v}") };
                w.uint64(if n < 0 { !((n as u64) << 1) } else { (n as u64) << 1 })
            }
            Type::Uint64 => {
                let n = v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok()));
                let Some(n) = n else { bail!("Expected uint64 but got {v}") };
                w.uint64(n)
            }
            Type::Def(i) => {
                let d = &self.defs[i];
                if d.kind == Kind::Enum {
                    let name = v.as_str().unwrap_or_default();
                    let Some(f) = d.fields.iter().find(|f| f.name == name) else {
                        bail!("Invalid value {v} for enum {:?}", d.name)
                    };
                    w.uint(f.value);
                } else {
                    self.encode_def(i, v, w)?;
                }
            }
        }
        Ok(())
    }
}

// Kiwi's text schema (enum/struct/message blocks), for building test archives like figma.test.mjs does.
#[cfg(test)]
pub fn parse_text(src: &str) -> Schema {
    let tokens: Vec<String> = {
        let mut t = Vec::new();
        let mut cur = String::new();
        for c in src.chars() {
            if c.is_alphanumeric() || c == '_' || c == '[' || c == ']' {
                cur.push(c);
            } else {
                if !cur.is_empty() {
                    t.push(std::mem::take(&mut cur));
                }
                if "{};=".contains(c) {
                    t.push(c.to_string());
                }
            }
        }
        t
    };
    let mut raw = Vec::new();
    let mut i = 0;
    while i < tokens.len() {
        let kind = match tokens[i].as_str() {
            "enum" => Kind::Enum,
            "struct" => Kind::Struct,
            _ => Kind::Message,
        };
        let name = tokens[i + 1].clone();
        i += 3;
        let mut fields = Vec::new();
        while tokens[i] != "}" {
            if kind == Kind::Enum {
                fields.push((String::new(), tokens[i].clone(), tokens[i + 2].parse().unwrap()));
                i += 4;
            } else if kind == Kind::Struct {
                fields.push((tokens[i].clone(), tokens[i + 1].clone(), fields.len() as u32 + 1));
                i += 3;
            } else {
                fields.push((tokens[i].clone(), tokens[i + 1].clone(), tokens[i + 3].parse().unwrap()));
                i += 5;
            }
        }
        i += 1;
        raw.push((name, kind, fields));
    }
    let names: Vec<String> = raw.iter().map(|r| r.0.clone()).collect();
    let natives = ["bool", "byte", "int", "uint", "float", "string", "int64", "uint64"];
    let defs = raw
        .into_iter()
        .map(|(name, kind, fields)| Def {
            name,
            kind,
            fields: fields
                .into_iter()
                .map(|(ty, fname, value)| {
                    if kind == Kind::Enum {
                        return Field { name: fname, ty: None, array: false, value };
                    }
                    let array = ty.ends_with("[]");
                    let base = ty.trim_end_matches("[]");
                    let ty = natives
                        .iter()
                        .position(|n| *n == base)
                        .map(|i| NATIVE[i])
                        .unwrap_or_else(|| Type::Def(names.iter().position(|n| n == base).expect(base)));
                    Field { name: fname, ty: Some(ty), array, value }
                })
                .collect(),
        })
        .collect();
    Schema::new(defs)
}
