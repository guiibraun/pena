// generate-image.test.mjs (guards, no Codex call), the tool list of mcp-http.test.mjs, and the execute tool's app paths.
use futures::FutureExt;
use pena_core::{Store, save, tools};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

fn first_text(r: &Value) -> String {
    r["content"][0]["text"].as_str().unwrap().to_string()
}

#[tokio::test(flavor = "multi_thread")]
async fn generate_image_guards() {
    let env = tools::Env::new("/tmp/pena-guard/a.pen");
    let err = |args: Value| {
        let env = env.clone();
        async move {
            let mut a = json!({ "prompt": "x" });
            a.as_object_mut().unwrap().extend(args.as_object().unwrap().clone());
            let r = tools::call(&env, "generate_image", a).await;
            assert_eq!(r["isError"], true);
            first_text(&r)
        }
    };
    assert!(err(json!({ "path": "../out.png" })).await.contains("outside the .pen folder"));
    assert!(err(json!({ "path": "a.jpg" })).await.contains("must end in .png"));
    assert!(err(json!({ "path": "a.png", "references": ["nope.png"] })).await.contains("Reference not found"));
    let up = |args: Value| {
        let env = env.clone();
        async move { first_text(&tools::call(&env, "upscale_image", args).await) }
    };
    assert!(up(json!({ "path": "nope.png", "output": "out.png" })).await.contains("Reference not found"));
    assert!(up(json!({ "path": "a.png", "output": "../out.png" })).await.contains("outside the .pen folder"));
}

#[tokio::test(flavor = "multi_thread")]
async fn schemas_and_plain_tools() {
    let names: Vec<String> = tools::schemas().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, ["execute", "generate_image", "upscale_image", "get_app_state", "get_node", "read_skill", "read_chat", "spawn_agents"]);
    for t in tools::schemas() {
        assert!(t["description"].is_string() && t["inputSchema"]["type"] == "object", "{t}");
    }
    let env = tools::Env::new("/tmp/pena-none/a.pen");
    let r = tools::call(&env, "nope", Value::Null).await;
    assert_eq!((r["isError"].clone(), first_text(&r)), (json!(true), "Unknown tool nope".to_string()));
    assert_eq!(first_text(&tools::call(&env, "read_chat", json!({})).await), "read_chat is only available inside the Pena app.");
    assert_eq!(first_text(&tools::call(&env, "spawn_agents", json!({ "config": [] })).await), "spawn_agents is only available inside the Pena app.");
    assert!(first_text(&tools::call(&env, "read_skill", json!({ "path": "guide/mobile-app.md" })).await).len() > 100);
}

#[tokio::test(flavor = "multi_thread")]
async fn execute_in_the_app() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a.pen");
    save(&file, &json!({ "version": "2.21", "children": [{ "id": "A", "type": "frame", "name": "A", "width": 10, "height": 10 }] })).unwrap();
    let store = Store::new(|_| {}, || {}, |_| {});
    store.open(&file).unwrap();
    let touched = Arc::new(Mutex::new(vec![]));
    let jobs = Arc::new(Mutex::new(vec![]));
    let mut env = tools::Env::new(&file);
    env.store = Some(store.clone());
    env.state = Some(Arc::new(|| json!({ "selection": ["A"], "rects": { "A": { "w": 50, "h": 60 } } })));
    let t2 = touched.clone();
    env.touched = Some(Arc::new(move |agent, nodes| t2.lock().unwrap().push((agent, nodes))));
    let j2 = jobs.clone();
    env.render = Some(Arc::new(move |job: Value| {
        j2.lock().unwrap().push(job.clone());
        let ids = job["ids"].as_array().unwrap().clone();
        async move {
            Ok(ids.iter().map(|id| match job["format"].as_str() {
                Some("png") => json!({ "id": id, "data": "data:image/png;base64,iVBO", "warnings": ["shader x: no main"] }),
                _ => json!({ "id": id, "data": "<svg/>" }),
            }).collect())
        }
        .boxed()
    }));
    let r = tools::call(&env, "execute", json!({ "input": "Update('A', { name: 'B' }); TakeScreenshot('A'); Export('A', 'svg', 'out'); return FindEmptySpace({ width: 1, height: 1 })", "_agent": "Ana" })).await;
    assert!(r.get("isError").is_none(), "{r}");
    assert_eq!(serde_json::from_str::<Value>(&first_text(&r)).unwrap()["x"], 150, "rendered size from the editor's rects");
    assert_eq!(r["content"][1], json!({ "type": "image", "data": "iVBO", "mimeType": "image/png" }));
    assert_eq!(r["content"][2]["text"], "shader x: no main");
    assert!(r["content"][3]["text"].as_str().unwrap().starts_with("Exported svg: "));
    assert_eq!(std::fs::read_to_string(dir.path().join("out/A.svg")).unwrap(), "<svg/>");
    assert_eq!(store.doc()["children"][0]["name"], "B", "edited in memory");
    let t = touched.lock().unwrap();
    assert_eq!(t[0].0.as_deref(), Some("Ana"));
    assert_eq!(t[0].1, vec![json!({ "kind": "update", "id": "A" }), json!({ "kind": "read", "id": "A" })]);
    assert_eq!(jobs.lock().unwrap()[1], json!({ "ids": ["A"], "format": "svg", "outputPath": "out", "options": {} }));
    drop(t);

    let state: Value = serde_json::from_str(&first_text(&tools::call(&env, "get_app_state", json!({})).await)).unwrap();
    assert_eq!(state["selection"], json!(["A"]));
    assert_eq!(state["topLevel"][0]["name"], "B", "the document in memory, not the file");
    assert_eq!(state["topLevel"][0]["rendered"], json!({ "width": 50, "height": 60 }));

    // without the editor: the snippet still runs, the agent is told why there is no image
    let plain = tools::Env::new(&file);
    let r = tools::call(&plain, "execute", json!({ "input": "TakeScreenshot('A')" })).await;
    assert_eq!(r["content"][1]["text"], "TakeScreenshot needs the Pena editor open in a browser.");
    let r = tools::call(&plain, "execute", json!({ "input": "boom(" })).await;
    assert_eq!(r["isError"], true);
    assert!(first_text(&r).contains("Nothing was saved"));
}
