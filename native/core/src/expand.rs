//! pen-core's expandNode/instantiate/applyOverrides (public/pen-core.js), in Rust: every `ref` (component instance)
//! replaced by its component's tree, ids inside an instance becoming `instanceId/childId`. The renderer needs the
//! layers expanded; doing it here (one top-level layer at a time, straight from the store's document) replaced a
//! round trip of the whole expanded document as JSON through QuickJS, which cost seconds and GBs on big files.
//! Keep it identical to pen-core.js: the browser editor draws with that one.
use serde_json::{Map, Value, json};
use std::collections::HashMap;

enum Parent<'a> {
    Doc,
    Lib,
    Node(&'a Value),
}

/// pen-core indexNodes(doc): every node by id (the document's, then its libraries'), with its parent.
pub struct Index<'a> {
    nodes: HashMap<String, (&'a Value, Parent<'a>)>,
}

impl<'a> Index<'a> {
    /// `lib`: the libraries ({ nodes, variables, themes }, pen-core's `_lib`) or null.
    pub fn new(doc: &'a Value, lib: &'a Value) -> Index<'a> {
        let mut nodes = HashMap::new();
        fn walk<'a>(n: &'a Value, parent: Parent<'a>, nodes: &mut HashMap<String, (&'a Value, Parent<'a>)>) {
            nodes.insert(js_str(n.get("id")), (n, parent));
            for c in kids(n) {
                walk(c, Parent::Node(n), nodes);
            }
        }
        for c in kids(doc) {
            walk(c, Parent::Doc, &mut nodes);
        }
        for c in lib.get("nodes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
            walk(c, Parent::Lib, &mut nodes);
        }
        Index { nodes }
    }
    fn node(&self, id: &str) -> Option<&'a Value> {
        self.nodes.get(id).map(|(n, _)| *n)
    }
    /// The top-level layer of the document holding `path` (a node id, or an instance path: its first segment).
    pub fn root_of(&self, path: &str) -> Option<&'a Value> {
        let mut hit = self.nodes.get(path.split('/').next().unwrap_or(path))?;
        loop {
            match hit.1 {
                Parent::Doc => return Some(hit.0),
                Parent::Lib => return None,
                Parent::Node(p) => hit = self.nodes.get(&js_str(p.get("id")))?,
            }
        }
    }
}

fn kids(n: &Value) -> &[Value] {
    n.get("children").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

// `${v}` for the values ids and refs can hold (an absent one is "undefined", as in JS)
fn js_str(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.fract() == 0.0 && f.abs() < 1e21 => format!("{}", f as i64),
            _ => n.to_string(),
        },
        Some(Value::Object(_)) => "[object Object]".into(),
        Some(v) => v.to_string(),
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        _ => true,
    }
}

fn is_ref(n: &Value) -> bool {
    n.get("type").and_then(Value::as_str) == Some("ref")
}

type Desc<'a> = HashMap<String, &'a Value>;

/// pen-core expandNode: a copy of `node` with every `ref` replaced by the full component tree.
pub fn expand_node(node: &Value, index: &Index, prefix: &str, depth: u32) -> Value {
    if is_ref(node) {
        return instantiate(node, format!("{prefix}{}", js_str(node.get("id"))), &Desc::new(), index, depth);
    }
    let mut out = Map::new();
    for (k, v) in node.as_object().into_iter().flatten() {
        match (k.as_str(), v) {
            ("children", Value::Array(c)) => out.insert(k.clone(), Value::Array(c.iter().map(|c| expand_node(c, index, prefix, depth)).collect())),
            _ => out.insert(k.clone(), v.clone()),
        };
    }
    out.insert("id".into(), Value::String(format!("{prefix}{}", js_str(node.get("id")))));
    Value::Object(out)
}

fn instantiate<'a>(r: &'a Value, full_id: String, outer: &Desc<'a>, index: &Index<'a>, depth: u32) -> Value {
    let ref_id = r.get("ref");
    let comp = index.node(&js_str(ref_id));
    let Some(comp) = comp.filter(|_| depth <= 20) else {
        let mut m = json!({ "type": "frame", "id": full_id, "name": format!("Missing component {}", js_str(ref_id)), "width": 40, "height": 40, "fill": "#FF000033" });
        if let Some(id) = ref_id {
            m["_ref"] = id.clone();
        }
        return m;
    };
    // the outer instance wins over inner overrides
    let mut desc: Desc = r.get("descendants").and_then(Value::as_object).map(|d| d.iter().map(|(k, v)| (k.clone(), v)).collect()).unwrap_or_default();
    desc.extend(outer.iter().map(|(k, v)| (k.clone(), *v)));
    let base = if is_ref(comp) {
        instantiate(comp, full_id.clone(), &desc, index, depth + 1)
    } else {
        let mut b = Map::new();
        for (k, v) in comp.as_object().into_iter().flatten() {
            match (k.as_str(), v) {
                ("children", Value::Array(c)) => b.insert(k.clone(), Value::Array(c.iter().map(|c| apply_overrides(c, &full_id, &desc, index, depth + 1)).collect())),
                ("children", _) => None, // `comp.children?.map(...)`: undefined, removed below
                _ => b.insert(k.clone(), v.clone()),
            };
        }
        Value::Object(b)
    };
    let Value::Object(mut out) = base else { unreachable!("instantiate returns objects") };
    for (k, v) in r.as_object().into_iter().flatten() {
        if !matches!(k.as_str(), "ref" | "descendants" | "type" | "id" | "children") {
            out.insert(k.clone(), v.clone());
        }
    }
    out.insert("id".into(), Value::String(full_id));
    match ref_id {
        Some(id) => out.insert("_ref".into(), id.clone()),
        None => out.shift_remove("_ref"),
    };
    // Slots: children on the instance replace the component's children. They are real nodes owned by the instance,
    // so they keep their own ids (editable directly).
    match r.get("children") {
        Some(Value::Array(c)) => {
            out.insert("children".into(), Value::Array(c.iter().map(|c| expand_node(c, index, "", depth + 1)).collect()));
        }
        Some(v) if !truthy(Some(v)) => {
            out.shift_remove("children");
        }
        _ => {}
    }
    if !truthy(r.get("reusable")) {
        out.shift_remove("reusable");
    }
    if !truthy(out.get("children")) {
        out.shift_remove("children");
    }
    Value::Object(out)
}

fn apply_overrides<'a>(child: &'a Value, inst_id: &str, desc: &Desc<'a>, index: &Index<'a>, depth: u32) -> Value {
    let cid = js_str(child.get("id"));
    let o = desc.get(&cid).copied().filter(|v| !v.is_null()).or_else(|| truthy(child.get("name")).then(|| desc.get(&js_str(child.get("name"))).copied()).flatten());
    let o = o.and_then(Value::as_object);
    if let Some(o) = o.filter(|o| truthy(o.get("type"))) {
        // full replacement
        let mut n = o.clone();
        n.insert("id".into(), child.get("id").cloned().unwrap_or(Value::Null));
        if child.get("id").is_none() {
            n.shift_remove("id");
        }
        return expand_node(&Value::Object(n), index, &format!("{inst_id}/"), depth);
    }
    let merged;
    let n: &Value = match o {
        Some(o) => {
            let mut m = child.as_object().cloned().unwrap_or_default();
            m.extend(o.iter().map(|(k, v)| (k.clone(), v.clone())));
            merged = Value::Object(m);
            &merged
        }
        None => child,
    };
    if is_ref(n) {
        let pre = format!("{cid}/");
        let nested: Desc = desc.iter().filter_map(|(k, v)| k.strip_prefix(&pre).map(|rest| (rest.to_string(), *v))).collect();
        return instantiate(n, format!("{inst_id}/{cid}"), &nested, index, depth);
    }
    let mut out = Map::new();
    for (k, v) in n.as_object().into_iter().flatten() {
        match (k.as_str(), v) {
            ("children", Value::Array(c)) => out.insert(k.clone(), Value::Array(c.iter().map(|c| apply_overrides(c, inst_id, desc, index, depth)).collect())),
            _ => out.insert(k.clone(), v.clone()),
        };
    }
    out.insert("id".into(), Value::String(format!("{inst_id}/{cid}")));
    Value::Object(out)
}

/// What the renderer draws: the document's top-level layers (connections are never drawn), each expanded on demand.
pub fn layers(doc: &Value) -> impl Iterator<Item = &Value> {
    kids(doc).iter().filter(|n| n.get("type").and_then(Value::as_str) != Some("connection"))
}
