// Glue between the kiwi-schema crate (evanw/kiwi, the format inside Figma's fig-kiwi archives) and serde_json, shaped
// like kiwi-schema's JS decodeMessage/encodeMessage output: enums as their names, fields in schema order.
// byte[] fields are hex strings (a JSON array per byte would cost ~30x the blob size in RAM).
use anyhow::{Result, anyhow, bail};
use kiwi_schema::{Field, Schema, Value as K};
use serde_json::{Map, Value};
use std::collections::HashMap;

pub fn decode_schema(bytes: &[u8]) -> Result<Schema> {
    Schema::decode(bytes).map_err(|_| anyhow!("Invalid kiwi schema"))
}

fn root(schema: &Schema) -> Result<i32> {
    schema.def_name_to_index.get("Message").map(|&i| i as i32).ok_or_else(|| anyhow!("Schema has no Message type"))
}

pub fn decode_message(schema: &Schema, bytes: &[u8]) -> Result<Value> {
    let v = K::decode(schema, root(schema)?, bytes).map_err(|_| anyhow!("Attempted to parse invalid message"))?;
    Ok(to_json(schema, v))
}

fn to_json(schema: &Schema, v: K) -> Value {
    match v {
        K::Bool(b) => b.into(),
        K::Byte(b) => b.into(),
        K::Int(i) => i.into(),
        K::UInt(u) => u.into(),
        K::Float(f) => crate::js::num(f as f64),
        K::String(s) => s.into(),
        K::Int64(i) => i.into(),
        K::UInt64(u) => u.into(),
        K::Enum(_, name) => name.into(),
        K::Array(a) => a.into_iter().map(|x| to_json(schema, x)).collect(),
        K::Object(name, fields) => {
            // the crate decodes into a HashMap: put the present fields back in schema order, as the JS decoder reads them
            let def = &schema.defs[schema.def_name_to_index[name]];
            let mut present: Vec<(usize, K)> = fields.into_iter().map(|(k, v)| (def.field_name_to_index[k], v)).collect();
            present.sort_unstable_by_key(|(i, _)| *i);
            let mut out = Map::with_capacity(present.len());
            for (i, x) in present {
                let f = &def.fields[i];
                let x = match x {
                    K::Array(bytes) if f.is_array && f.type_id == kiwi_schema::TYPE_BYTE => {
                        Value::String(hex::encode(bytes.iter().map(K::as_byte).collect::<Vec<u8>>()))
                    }
                    x => to_json(schema, x),
                };
                out.insert(f.name.clone(), x);
            }
            Value::Object(out)
        }
    }
}

pub fn encode_message(schema: &Schema, v: &Value) -> Result<Vec<u8>> {
    let root = root(schema)?;
    Ok(from_json(schema, root, v)?.encode(schema))
}

// JS ToNumber, then ToUint32 / ToInt32, as the JS encoder's `>>> 0` / `| 0` do
fn number(v: &Value) -> f64 {
    crate::js::number(v)
}
fn to_u32(x: f64) -> u32 {
    if x.is_finite() { x.trunc().rem_euclid(4294967296.0) as u32 } else { 0 }
}

// serde_json → kiwi Value by the schema. The crate's encoder unwraps (panics) on a missing struct field or an unknown
// enum name, so those are checked here and returned as the JS encoder's errors.
fn from_json<'a>(schema: &'a Schema, type_id: i32, v: &Value) -> Result<K<'a>> {
    use kiwi_schema::*;
    Ok(match type_id {
        TYPE_BOOL => K::Bool(to_u32(number(v)) as u8 != 0),
        TYPE_BYTE => K::Byte(to_u32(number(v)) as u8),
        TYPE_INT => {
            let n = number(v);
            if !n.is_nan() && !(-2147483648.0..=2147483647.0).contains(&n) {
                bail!("Outside int range: {n}");
            }
            K::Int(to_u32(n) as i32)
        }
        TYPE_UINT => {
            let n = number(v);
            if !n.is_nan() && !(0.0..=4294967295.0).contains(&n) {
                bail!("Outside uint range: {n}");
            }
            K::UInt(to_u32(n))
        }
        TYPE_FLOAT => K::Float(number(v) as f32),
        TYPE_STRING => {
            let s = v.as_str().unwrap_or("");
            if s.contains('\0') {
                bail!("Cannot encode a string containing the null character");
            }
            K::String(s.into())
        }
        TYPE_INT64 => K::Int64(v.as_i64().or_else(|| v.as_str()?.parse().ok()).ok_or_else(|| anyhow!("Expected int64 but got {v}"))?),
        TYPE_UINT64 => K::UInt64(v.as_u64().or_else(|| v.as_str()?.parse().ok()).ok_or_else(|| anyhow!("Expected uint64 but got {v}"))?),
        _ => {
            let def = &schema.defs[type_id as usize];
            match def.kind {
                DefKind::Enum => {
                    let name = v.as_str().unwrap_or("");
                    let f = def.field(name).ok_or_else(|| anyhow!("Invalid value {v} for enum {:?}", def.name))?;
                    K::Enum(&def.name, &f.name)
                }
                DefKind::Struct | DefKind::Message => {
                    let mut fields = HashMap::new();
                    for f in &def.fields {
                        match v.get(&f.name).filter(|x| !x.is_null()) {
                            Some(x) => {
                                fields.insert(f.name.as_str(), field(schema, f, x)?);
                            }
                            None if def.kind == DefKind::Struct => bail!("Missing required field {:?}", f.name),
                            None => {}
                        }
                    }
                    K::Object(&def.name, fields)
                }
            }
        }
    })
}

fn field<'a>(schema: &'a Schema, f: &Field, v: &Value) -> Result<K<'a>> {
    if !f.is_array {
        return from_json(schema, f.type_id, v);
    }
    if f.type_id == kiwi_schema::TYPE_BYTE {
        let bytes = match v {
            Value::String(s) => hex::decode(s).map_err(|e| anyhow!("Bad bytes for {:?}: {e}", f.name))?,
            Value::Array(a) => a.iter().map(|b| to_u32(number(b)) as u8).collect(),
            _ => bail!("Expected bytes for field {:?}", f.name),
        };
        return Ok(K::Array(bytes.into_iter().map(K::Byte).collect()));
    }
    let Value::Array(a) = v else { bail!("Expected an array for field {:?}", f.name) };
    Ok(K::Array(a.iter().map(|x| from_json(schema, f.type_id, x)).collect::<Result<_>>()?))
}
