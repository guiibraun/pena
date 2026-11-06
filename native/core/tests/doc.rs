// doc.test.mjs (+ the agent shader api of shader.test.mjs)
use pena_core::{Store, execute, expand, load, read_skill, root, system_prompt, tools};
use serde_json::{Value, json};
use std::path::Path;

fn run(file: &Path, input: &str) -> anyhow::Result<String> {
    Ok(execute(file, &json!({ "input": input }), &Value::Null)?.text)
}
fn texts(r: &Value) -> Vec<String> {
    r["content"].as_array().unwrap().iter().filter_map(|c| c["text"].as_str().map(str::to_string)).collect()
}
fn link(id: &str, file: &Path) -> String {
    let enc = |s: &str| url::form_urlencoded::byte_serialize(s.as_bytes()).collect::<String>().replace('+', "%20");
    format!("pena://node/{}?file={}", enc(id), enc(&file.to_string_lossy()))
}
fn expanded(file: &Path) -> Vec<Value> {
    let s = Store::new(|_| {}, || {}, |_| {});
    s.open(file).unwrap();
    let (doc, lib, _) = s.snapshot();
    let index = expand::Index::new(&doc, &lib);
    expand::layers(&doc).map(|n| expand::expand_node(n, &index, "", 0)).collect()
}

#[test]
fn editing() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("t.pen");

    // basic editing
    let out = run(&file, "
      const s = Insert(document, { type: 'frame', name: 'Tela', width: 390, height: 844, layout: 'vertical', children: [{ type: 'text', name: 'T', content: 'Oi' }] });
      Update(Get(s).children[0].id, { content: 'Olá', id: 'hack' });
      Copy(s, document, { x: 500 });
      return Get(document, { depth: 0 }).children;").unwrap();
    assert_eq!(out, "...");
    let doc = load(&file).unwrap();
    assert_eq!(doc["children"][0]["children"][0]["content"], "Olá");
    assert_ne!(doc["children"][1]["children"][0]["id"], doc["children"][0]["children"][0]["id"], "copy gets fresh ids");
    assert!(std::fs::read_to_string(&file).unwrap().starts_with("{\n  \"version\": \"2.21\""), "pretty-printed");

    // failure saves nothing and can be patched with edits/editId
    let id0 = doc["children"][0]["id"].as_str().unwrap();
    let msg = run(&file, &format!("Delete('{id0}'); boom()")).unwrap_err().to_string();
    assert!(msg.contains("boom") && msg.contains("Nothing was saved"), "{msg}");
    assert_eq!(load(&file).unwrap()["children"].as_array().unwrap().len(), 2, "failed snippet saves nothing");
    let edit_id = msg.split("editId \"").nth(1).unwrap().split('"').next().unwrap();
    execute(&file, &json!({ "editId": edit_id, "edits": [{ "find": "boom()", "replace": "Print(\"fixed\")" }] }), &Value::Null).unwrap();
    assert_eq!(load(&file).unwrap()["children"].as_array().unwrap().len(), 1, "patched snippet ran");
    let again = execute(&file, &json!({ "editId": edit_id, "edits": [{ "find": "x", "replace": "y" }] }), &Value::Null).unwrap_err();
    assert!(again.to_string().starts_with("Unknown editId"), "{again}");

    // components: ref + descendants overrides + slash paths
    let printed = run(&file, "
      const card = Insert(document, { type: 'frame', name: 'Card', reusable: true, layout: 'vertical', children: [
        { type: 'text', name: 'Title', content: 'Default' }, { type: 'text', name: 'Body', content: 'b' }] });
      const titleId = Get(card).children[0].id;
      const a = Insert(document, { type: 'ref', ref: card, name: 'A', descendants: { [titleId]: { content: 'Custom' } } });
      const b = Insert(document, { type: 'ref', ref: card, name: 'B' });
      Update(b + '/' + titleId, { content: 'Via path' });
      Print(Get(a + '/' + titleId).content, Get(b + '/' + titleId).content);
      Copy(a, document, { name: 'A2', descendants: { Body: { content: 'renamed by name' } } });").unwrap();
    assert_eq!(printed, "Custom Via path");
    let ex = expanded(&file);
    let a = ex.iter().find(|n| n["name"] == "A").unwrap();
    let b = ex.iter().find(|n| n["name"] == "B").unwrap();
    assert_eq!(a["children"][0]["content"], "Custom");
    assert_eq!(b["children"][0]["content"], "Via path");
    let child = a["children"][0]["id"].as_str().unwrap();
    assert!(child.split('/').count() == 2, "instance children use slash paths");
    let e = run(&file, &format!("Delete('{child}')")).unwrap_err().to_string();
    assert!(e.contains("enabled: false"), "{e}");

    // variables + themes
    run(&file, "SetVariables({ bg: { type: 'color', value: [{ value: '#fff' }, { value: '#000', theme: { Mode: 'Dark' } }] } })").unwrap();
    assert_eq!(load(&file).unwrap()["themes"], json!({ "Mode": ["Dark"] }));

    // visitor + FindEmptySpace
    assert!(run(&file, "return Get((n) => n.type === 'text' ? n.content : undefined)").unwrap().contains("Olá"));
    let space: Value = serde_json::from_str(&run(&file, "return FindEmptySpace({ width: 100, height: 100 })").unwrap()).unwrap();
    assert!(space["x"].as_f64().unwrap() > 0.0);

    // node:vm parity: a snippet that never ends is cut off; async snippets are refused
    assert!(run(&file, "while (true) {}").unwrap_err().to_string().starts_with("Script execution timed out after 5000ms"));
    assert!(run(&file, "return (async () => { throw new Error('boom'); })()").unwrap_err().to_string().contains("synchronous"));
    assert_eq!(run(&file, "return 'x'").unwrap(), "x");
    assert_eq!(run(&file, "Print({ a: 1 }, 'b')").unwrap(), "{\"a\":1} b");
    assert_eq!(run(&file, "1 + 1").unwrap(), "ok");
    // each snippet starts from a clean global scope, like node:vm's new context
    run(&file, "leak = 1; JSON = null").unwrap();
    assert_eq!(run(&file, "return typeof leak + ' ' + typeof JSON.stringify").unwrap(), "undefined function");
}

#[tokio::test(flavor = "multi_thread")]
async fn get_node_and_flows() {
    let dir = tempfile::tempdir().unwrap();
    // get_node: a pena:// link (⌘L in the editor) reads its own file, instances expanded, variables and components listed
    let linked = dir.path().join("linked.pen");
    let ids: Vec<String> = serde_json::from_str(&run(&linked, "
        SetVariables({ brand: { type: 'color', value: '#FF0000' } });
        const c = Insert(document, { type: 'frame', name: 'Btn', reusable: true, fill: '$brand', children: [{ type: 'text', name: 'L', content: 'Ok' }] });
        const l = Get(c).children[0].id;
        return [c, l, Insert(document, { type: 'ref', ref: c, descendants: { [l]: { content: 'Comprar' } } })];").unwrap()).unwrap();
    let (comp, label, inst) = (&ids[0], &ids[1], &ids[2]);
    let env = tools::Env::new(dir.path().join("other.pen"));
    let node = |l: String| { let env = env.clone(); async move { tools::call(&env, "get_node", json!({ "link": l })).await } };
    let r = node(link(comp, &linked)).await;
    let t = texts(&r);
    assert!(t[0].contains("\"fill\": \"$brand\""), "{}", t[0]);
    assert!(t[1].contains("\"brand\": {") && t[1].contains("\"#FF0000\""), "{}", t[1]);
    assert!(texts(&node(link(&format!("{inst}/{label}"), &linked)).await)[0].contains("\"content\": \"Comprar\""));
    let want = format!("\"Btn\" {}: 1× {inst} (overrides: {label})", link(comp, &linked));
    assert!(texts(&node(link(inst, &linked)).await).iter().any(|t| t.contains(&want)), "lists component instances");
    let bad = node("https://figma.com/x".into()).await;
    assert_eq!(bad["isError"], true);
    assert!(texts(&bad)[0].contains("Expected a link"));
    assert!(texts(&node(link("nope", &linked)).await)[0].contains("Node not found"));

    // connections: prototype links between screens, followed by get_node and listed by get_app_state
    let flow = dir.path().join("flow.pen");
    let ids: Vec<String> = serde_json::from_str(&run(&flow, "
        const h = Insert(document, { type: 'frame', name: 'Home', x: 0, width: 300, height: 300, children: [{ type: 'frame', name: 'Abrir', width: 80, height: 30 }] });
        const b = Get(h).children[0].id;
        const m = Insert(document, { type: 'frame', name: 'Home — modal', x: 400, width: 300, height: 300 });
        const s = Insert(document, { type: 'frame', name: 'Passo 2', x: 800, width: 300, height: 300 });
        const o = Insert(document, { type: 'frame', name: 'Solta', x: 1200, width: 300, height: 300 });
        Insert(document, { type: 'connection', source: { path: b, anchor: 'right' }, target: { path: m, anchor: 'left' }, context: 'ao clicar' });
        Insert(document, { type: 'connection', source: { path: m, anchor: 'right' }, target: { path: s, anchor: 'left' } });
        return [h, b, m, s, o];").unwrap()).unwrap();
    let (home, btn, modal, step2, other) = (&ids[0], &ids[1], &ids[2], &ids[3], &ids[4]);
    let env = tools::Env::new(&flow);
    let out = texts(&tools::call(&env, "get_node", json!({ "link": link(home, &flow) })).await).join("\n");
    assert!(out.contains(&format!("\"Abrir\" ({btn}) → \"Home — modal\" ({modal}): ao clicar")), "{out}");
    assert!(out.contains(&format!("→ \"Passo 2\" ({step2})")), "follows the flow past the first screen");
    assert!(!texts(&tools::call(&env, "get_node", json!({ "link": link(other, &flow) })).await).iter().any(|t| t.contains("Prototype flow")), "unlinked screen has no flow");
    let state: Value = serde_json::from_str(&texts(&tools::call(&env, "get_app_state", json!({})).await)[0]).unwrap();
    assert_eq!(state["topLevel"].as_array().unwrap().len(), 4, "connections are not top-level frames");
    assert_eq!(state["connections"].as_array().unwrap().len(), 2);
    let space: Value = serde_json::from_str(&run(&flow, "return FindEmptySpace({ width: 10, height: 10 })").unwrap()).unwrap();
    assert_eq!(space["x"], 1600, "connections take no space");
    run(&flow, &format!("Delete('{modal}')")).unwrap();
    assert!(!load(&flow).unwrap()["children"].as_array().unwrap().iter().any(|c| c["type"] == "connection"), "deleting a screen removes its links");
}

#[test]
fn skills() {
    assert!(system_prompt().contains("<path>schema.md</path>"));
    assert!(read_skill(None).unwrap().contains("guide/mobile-app.md"));
    assert!(read_skill(Some("../../package.json")).unwrap_err().to_string().contains("not found"));
    assert!(root().join("public/pen-core.js").is_file());
}

#[test]
fn shader_api() {
    // agents: library shaders and their own, next to the .pen
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.pen");
    let listed: Value = serde_json::from_str(&run(&file, "return ListShaders()").unwrap()).unwrap();
    assert!(listed.as_array().unwrap().iter().any(|s| s["name"] == "glass"
        && s["kind"] == "fill"
        && s["uniforms"].as_array().unwrap().iter().any(|u| u["name"] == "u_refraction" && u["label"].is_string())));
    assert_eq!(run(&file, "return UseShader(\"pixelate\")").unwrap(), "./shaders/pixelate.glsl");
    assert_eq!(
        std::fs::read_to_string(dir.path().join("shaders/pixelate.glsl")).unwrap(),
        std::fs::read_to_string(root().join("public/shaders/pixelate.glsl")).unwrap()
    );
    assert_eq!(run(&file, "return WriteShader(\"mine\", \"void main() { gl_FragColor = vec4(1.0); }\")").unwrap(), "./shaders/mine.glsl");
    let e = run(&file, "WriteShader(\"bad\", \"void f() {}\")").unwrap_err().to_string();
    assert!(e.contains("No color output") || e.contains("main"), "{e}");
    assert!(run(&file, "UseShader(\"../x\")").unwrap_err().to_string().contains("Unknown shader"));
}

// expand.rs follows pen-core's expandNode (compared node by node on real files); these are the cases they exercise.
#[test]
fn expansion() {
    let doc = json!({ "children": [
        { "id": "inner", "type": "frame", "reusable": true, "children": [{ "id": "t", "type": "text", "name": "Label", "content": "inner" }] },
        { "id": "card", "type": "frame", "reusable": true, "children": [
            { "id": "title", "type": "text", "name": "Title", "content": "Default" },
            { "id": "nest", "type": "ref", "ref": "inner" },
            { "id": "icon", "type": "frame", "name": "Icon" }] },
        { "id": "screen", "type": "frame", "children": [
            { "id": "a", "type": "ref", "ref": "card", "descendants": {
                "title": { "content": "By id" },
                "nest/t": { "content": "Nested, outer wins" },
                "Icon": { "type": "text", "content": "Replaced" } } },
            { "id": "b", "type": "ref", "ref": "card", "reusable": false, "children": [{ "id": "own", "type": "text", "content": "slot" }] },
            { "id": "m", "type": "ref", "ref": "gone" }] },
        { "id": "link", "type": "connection", "source": { "path": "a" }, "target": { "path": "b" } }] });
    let lib = Value::Null;
    let index = expand::Index::new(&doc, &lib);
    let layers: Vec<Value> = expand::layers(&doc).map(|n| expand::expand_node(n, &index, "", 0)).collect();
    assert_eq!(layers.len(), 3, "connections are not layers");
    let screen = &layers[2]["children"];
    let a = &screen[0];
    assert_eq!((a["id"].as_str(), a["_ref"].as_str(), a.get("reusable")), (Some("a"), Some("card"), None), "an instance is not reusable itself");
    assert_eq!(a["children"][0], json!({ "id": "a/title", "type": "text", "name": "Title", "content": "By id" }));
    assert_eq!(a["children"][1]["id"], "a/nest");
    assert_eq!(a["children"][1]["children"][0], json!({ "id": "a/nest/t", "type": "text", "name": "Label", "content": "Nested, outer wins" }));
    assert_eq!(a["children"][2], json!({ "id": "a/icon", "type": "text", "content": "Replaced" }), "an override with a type replaces the node (matched by name)");
    assert_eq!(screen[1]["children"], json!([{ "id": "own", "type": "text", "content": "slot" }]), "slot children replace the component's, keeping their ids");
    assert_eq!(screen[2]["name"], "Missing component gone");
    assert_eq!(index.root_of("a/nest/t").and_then(|n| n["id"].as_str()), Some("screen"));
    assert_eq!(index.root_of("t").and_then(|n| n["id"].as_str()), Some("inner"));
    assert!(index.root_of("nope").is_none());
}

// numbers come back exactly as the file has them (serde_json's default parsing can be off in the last bit, so a save
// would rewrite numbers nobody touched)
#[test]
fn numbers_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("n.pen");
    std::fs::write(&file, r#"{ "version": "2.21", "children": [{ "id": "a", "type": "frame", "opacity": 0.42000000000000004, "x": 950.4000000000001 }] }"#).unwrap();
    let s = Store::new(|_| {}, || {}, |_| {});
    s.open(&file).unwrap();
    s.execute(&json!({ "input": "Update('a', { name: 'touched' })" }), &Value::Null).unwrap();
    s.flush();
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.contains("0.42000000000000004") && text.contains("950.4000000000001"), "{text}");
}
