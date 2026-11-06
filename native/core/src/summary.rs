//! get_app_state's summary (glue.js appState/flows/flowSummary), in Rust: in QuickJS it took up to 2 s per call and
//! left ~160 MB behind on a big document. Keep the text identical to glue.js flows(), which get_node still uses.
use crate::expand::{self, Index, js_str, truthy};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};

fn is_connection(n: &Value) -> bool {
    n.get("type").and_then(Value::as_str) == Some("connection")
}

struct End<'a> {
    id: &'a str,
    screen: Option<&'a Value>,
    label: String,
}

/// Prototype links in a readable form ("Login" › "Entrar" (id) → "Home" (id): context), dangling ones skipped,
/// and the screens they touch.
pub(crate) fn flows<'a>(doc: &'a Value, index: &Index<'a>) -> Vec<(String, Option<&'a Value>, Option<&'a Value>)> {
    // an instance path names a node of its screen expanded: each screen is expanded once, not once per path
    let mut expanded: HashMap<String, HashMap<String, Value>> = HashMap::new();
    let mut end = |p: Option<&'a Value>| -> Option<End<'a>> {
        let p = p?.as_str()?;
        let screen = index.root_of(p);
        let name = match index.node(p) {
            Some(n) => n.get("name").cloned(),
            None => {
                let s = screen?;
                let ids = expanded.entry(js_str(s.get("id"))).or_insert_with(|| {
                    let (mut ids, mut stack) = (HashMap::new(), vec![expand::expand_node(s, index, "", 0)]);
                    while let Some(mut n) = stack.pop() {
                        if let Some(Value::Array(c)) = n.get_mut("children") {
                            stack.extend(std::mem::take(c));
                        }
                        ids.insert(js_str(n.get("id")), n);
                    }
                    ids
                });
                ids.get(p)?.get("name").cloned()
            }
        };
        let name = name.filter(|n| !n.is_null()).map_or_else(|| p.to_string(), |n| js_str(Some(&n)));
        let label = match screen {
            Some(s) if s.get("id").and_then(Value::as_str) != Some(p) => {
                let sname = s.get("name").filter(|n| !n.is_null()).or(s.get("id"));
                format!("\"{}\" › \"{name}\"", js_str(sname))
            }
            _ => format!("\"{name}\""),
        };
        Some(End { id: p, screen: screen.and_then(|s| s.get("id")), label })
    };
    let mut out = vec![];
    for c in expand_kids(doc).iter().filter(|c| is_connection(c)) {
        let (Some(from), Some(to)) = (end(c.pointer("/source/path")), end(c.pointer("/target/path"))) else { continue };
        let context = c.get("context").filter(|v| truthy(Some(v))).map(|v| format!(": {}", js_str(Some(v)))).unwrap_or_default();
        out.push((format!("{} ({}) → {} ({}){context}", from.label, from.id, to.label, to.id), from.screen, to.screen));
    }
    out
}

fn expand_kids(n: &Value) -> &[Value] {
    n.get("children").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

// JSON.stringify writes 1440, not 1440.0: the rects are computed as floats
fn js_numbers(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if let Some(f) = n.as_f64().filter(|f| n.is_f64() && f.fract() == 0.0 && f.abs() < 1e15) {
                *v = json!(f as i64);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(js_numbers),
        Value::Object(m) => m.values_mut().for_each(js_numbers),
        _ => {}
    }
}

/// get_app_state's text: the top-level layers (with their laid-out size from `state.rects`), the themes, how many
/// variables, and the prototype links plus the screens still unlinked. `state`: the editor's { selection, rects }.
pub fn app_state(doc: &Value, lib: &Value, file: &str, state: &Value) -> String {
    let rects = &state["rects"];
    let frames: Vec<Value> = expand_kids(doc)
        .iter()
        .filter(|n| !is_connection(n))
        .map(|n| {
            let mut f = Map::new();
            for k in ["id", "type", "name", "x", "y", "width", "height"] {
                if let Some(v) = n.get(k) {
                    f.insert(k.into(), v.clone());
                }
            }
            for k in ["reusable", "placeholder"] {
                if truthy(n.get(k)) {
                    f.insert(k.into(), true.into());
                }
            }
            let r = &rects[js_str(n.get("id"))];
            if truthy(Some(r)) {
                let mut size = Map::new();
                for (k, w) in [("width", "w"), ("height", "h")] {
                    if let Some(v) = r.get(w) {
                        size.insert(k.into(), v.clone());
                    }
                }
                f.insert("rendered".into(), size.into());
            }
            Value::Object(f)
        })
        .collect();
    let mut summary = Map::new();
    summary.insert("file".into(), file.into());
    summary.insert("selection".into(), state.get("selection").filter(|s| !s.is_null()).cloned().unwrap_or(json!([])));
    summary.insert("themes".into(), doc.get("themes").filter(|t| !t.is_null()).cloned().unwrap_or(json!({})));
    let vars = match doc.get("variables") {
        Some(Value::Object(m)) => m.len(),
        Some(Value::Array(a)) => a.len(),
        _ => 0,
    };
    summary.insert("variables".into(), vars.into());
    let index = Index::new(doc, lib);
    let list = flows(doc, &index);
    // flowSummary: once there are links, the screens no link reaches or leaves
    let linked: HashSet<String> = list.iter().flat_map(|(_, a, b)| [*a, *b]).flatten().map(Value::to_string).collect();
    let unlinked: Vec<Value> = frames
        .iter()
        .filter(|f| f["type"] == "frame" && f.get("reusable").is_none() && !f.get("id").is_some_and(|id| linked.contains(&id.to_string())))
        .map(|f| format!("\"{}\" ({})", js_str(f.get("name").filter(|n| !n.is_null()).or(f.get("id"))), js_str(f.get("id"))).into())
        .collect();
    summary.insert("topLevel".into(), frames.into());
    if !list.is_empty() {
        summary.insert("connections".into(), list.into_iter().map(|(t, _, _)| Value::String(t)).collect());
        if !unlinked.is_empty() {
            summary.insert("unlinked".into(), unlinked.into());
        }
    }
    let mut v = Value::Object(summary);
    js_numbers(&mut v);
    // JSON.stringify(summary, null, 1)
    let mut out = vec![];
    let mut ser = serde_json::Serializer::with_formatter(&mut out, serde_json::ser::PrettyFormatter::with_indent(b" "));
    serde::Serialize::serialize(&v, &mut ser).expect("JSON");
    String::from_utf8(out).expect("UTF-8")
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    #[test]
    fn links_and_unlinked_screens() {
        let doc = json!({ "children": [
            { "id": "S1", "type": "frame", "name": "Login", "children": [{ "id": "b", "type": "frame", "name": "Entrar" }] },
            { "id": "S2", "type": "frame", "name": "Home", "x": 10 },
            { "id": "S3", "type": "frame", "name": "Perfil" },
            { "id": "C", "type": "frame", "name": "Card", "reusable": true, "children": [{ "id": "t", "type": "text", "name": "Título" }] },
            { "id": "S4", "type": "frame", "children": [{ "id": "i", "type": "ref", "ref": "C" }] },
            { "id": "k1", "type": "connection", "source": { "path": "b" }, "target": { "path": "S2" }, "context": "toque" },
            { "id": "k2", "type": "connection", "source": { "path": "i/t" }, "target": { "path": "S1" } },
            { "id": "k3", "type": "connection", "source": { "path": "gone" }, "target": { "path": "S1" } },
        ] });
        let state = json!({ "rects": { "S2": { "w": 1440.0, "h": 900.5 } } });
        let s: Value = serde_json::from_str(&super::app_state(&doc, &Value::Null, "a.pen", &state)).unwrap();
        assert_eq!(s["connections"], json!(["\"Login\" › \"Entrar\" (b) → \"Home\" (S2): toque", "\"S4\" › \"Título\" (i/t) → \"Login\" (S1)"]));
        assert_eq!(s["unlinked"], json!(["\"Perfil\" (S3)"]));
        assert_eq!(s["topLevel"][1], json!({ "id": "S2", "type": "frame", "name": "Home", "x": 10, "rendered": { "width": 1440, "height": 900.5 } }));
        assert!(super::app_state(&doc, &Value::Null, "a.pen", &state).contains("\"width\": 1440,"), "integers as JSON.stringify writes them");
    }
}
