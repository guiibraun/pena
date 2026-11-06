// Port of handoff.test.mjs: what each provider's session missed, and read_chat.
use pena_state::handoff::{HandoffArgs, plan_handoff, read_chat, seen_until};
use regex::Regex;
use serde_json::{Value, json};

fn run(agent: &str, provider: &str, model: &str, items: Vec<Value>, reason: &str) -> Vec<Value> {
    let mut v = vec![json!({ "kind": "start", "agent": agent, "provider": provider, "model": model }), json!({ "kind": "model", "agent": agent, "model": model })];
    for m in items {
        let mut o = json!({ "agent": agent });
        o.as_object_mut().unwrap().extend(m.as_object().unwrap().clone());
        v.push(o);
    }
    let mut end = json!({ "kind": "end", "agent": agent, "reason": reason });
    if reason == "failed" {
        end["message"] = json!("rate limited");
    }
    v.push(end);
    v
}
fn is(re: &str, s: &str) -> bool {
    Regex::new(re).unwrap().is_match(s)
}
fn count(re: &str, s: &str) -> usize {
    Regex::new(re).unwrap().find_iter(s).count()
}
fn plan(messages: &[Value], until: usize, provider: &str, fresh: bool) -> Option<Value> {
    plan_handoff(&HandoffArgs { until: Some(until), fresh, ..HandoffArgs::new(messages, provider) })
}

#[test]
fn handoff() {
    let mut chat = vec![json!({ "kind": "user", "text": "Faça uma landing de café" })]; // 0
    chat.extend(run(
        "Phantom",
        "claude",
        "opus",
        vec![json!({ "kind": "text", "text": "Fiz a landing." }), json!({ "kind": "tool", "name": "execute", "label": "Add hero", "status": "done", "input": { "input": "Insert(...)" }, "output": "hero=abc" })],
        "finished",
    )); // 1-5
    chat.push(json!({ "kind": "user", "text": "Agora mais escuro" })); // 6
    chat.extend(run(
        "Drift",
        "codex",
        "gpt-5.5",
        vec![
            json!({ "kind": "todos", "items": [{ "text": "Escurecer", "status": "in_progress" }] }),
            json!({ "kind": "thinking", "text": "segredo" }),
            json!({ "kind": "tool", "name": "execute", "label": "Darken theme", "status": "done", "input": { "input": "SetVariables(...)" }, "output": "x".repeat(2000) }),
            json!({ "kind": "todos", "items": [{ "text": "Escurecer", "status": "completed" }] }),
            json!({ "kind": "text", "id": "r1", "text": "Escureci tudo." }),
            json!({ "kind": "text", "id": "r1", "text": "Escureci tudo." }), // saved again when the message completes
        ],
        "finished",
    )); // 7-15
    chat.push(json!({ "kind": "user", "text": "Volta pro Claude" })); // 16: the turn being sent
    let until = 16;

    // Claude saw up to its last run; Codex up to now.
    assert_eq!(seen_until(&chat[..until], "claude"), 6);
    assert_eq!(seen_until(&chat[..until], "codex"), 16);

    // Back to Claude: only what Codex did, as it was written.
    let back = plan_handoff(&HandoffArgs { until: Some(until), model: Some("opus"), ..HandoffArgs::new(&chat, "claude") }).unwrap();
    let text = back["text"].as_str().unwrap();
    assert_eq!(back["range"], json!([6, 15]));
    assert_eq!(count("Escureci tudo", text), 1);
    assert_eq!(back["from"].as_array().unwrap().iter().map(|r| r["provider"].clone()).collect::<Vec<_>>(), [json!("codex")]);
    assert!(is(r"Other agents \(Codex gpt-5\.5\)", text));
    assert!(is(r"\[#6 user\]\nAgora mais escuro", text));
    assert!(is(r"\[#13 Drift · Codex gpt-5\.5 · reply\]\nEscureci tudo\.", text));
    assert!(is(r#"tool execute "Darken theme" · done\]\nx{600}… \[shortened\]"#, text));
    assert!(!is("Fiz a landing|segredo|SetVariables", text)); // Claude's own turn, reasoning, scripts
    assert_eq!(count(r"· plan\]", text), 1); // the superseded plan is dropped
    assert!(is(r"- \[x\] Escurecer", text));
    assert_eq!(back["omitted"], 0);

    // Codex is caught up; the same provider retrying after its own failure gets nothing either.
    assert_eq!(plan(&chat, until, "codex", false), None);
    let mut failed = vec![chat[0].clone()];
    failed.extend(run("Phantom", "claude", "opus", vec![], "failed"));
    failed.push(json!({ "kind": "user", "text": "De novo" }));
    assert_eq!(plan(&failed, 5, "claude", false), None);
    // ...but another provider does get the failed turn.
    assert!(is(r"run failed\]\nrate limited", plan(&failed, 5, "codex", false).unwrap()["text"].as_str().unwrap()));

    // A handoff item goes before its run's start: it isn't credited to the agent's previous run.
    let mut renamed = chat[..7].to_vec();
    renamed.push(json!({ "kind": "handoff", "agent": "Phantom", "to": { "provider": "codex" }, "range": [0, 5] }));
    renamed.extend(run("Phantom", "codex", "gpt-5.5", vec![json!({ "kind": "text", "text": "Escureci." })], "finished"));
    renamed.push(json!({ "kind": "user", "text": "Volta" }));
    let r = plan(&renamed, renamed.len() - 1, "claude", false).unwrap();
    assert_eq!(r["from"].as_array().unwrap().iter().map(|r| r["provider"].clone()).collect::<Vec<_>>(), [json!("codex")]);

    // A new session gets the whole conversation, even its own provider's turns.
    let fresh = plan_handoff(&HandoffArgs { until: Some(until), fresh: true, replaced: true, ..HandoffArgs::new(&chat, "claude") }).unwrap();
    assert_eq!(fresh["range"], json!([0, 15]));
    assert!(is("no longer exists", fresh["text"].as_str().unwrap()));
    assert!(is("Fiz a landing", fresh["text"].as_str().unwrap()));

    // Under a small budget: whole items only, the latest request and reply first, and it fits.
    let small = plan_handoff(&HandoffArgs { until: Some(until), fresh: true, budget: Some(1300), ..HandoffArgs::new(&chat, "claude") }).unwrap();
    let st = small["text"].as_str().unwrap();
    assert!(st.encode_utf16().count() <= 1300, "{}", st.len());
    assert!(small["omitted"].as_u64().unwrap() > 0 && small["included"].as_u64().unwrap() > 0);
    assert!(is(r"\[#6 user\]", st));
    assert!(is(r"Escureci tudo\.", st));
    assert!(is(r"read_chat\(\{ from: 0, to: 15 \}\)", st));

    // read_chat: whole items with their scripts and results, paged.
    let read = read_chat(&chat, Some(9), Some(13));
    assert!(is("^Chat items #9–#13", &read));
    assert!(is(r"Input:\nSetVariables\(\.\.\.\)\nResult:\nx{2000}", &read));
    assert!(!is("segredo", &read));
    let mut long = chat.clone();
    long.extend((0..40).map(|_| json!({ "kind": "user", "text": "y".repeat(2000) })));
    assert!(is(r"Continue with read_chat\(\{ from: \d+, to: 56 \}\)", &read_chat(&long, None, None)));
    assert_eq!(read_chat(&[], None, None), "The chat is empty.");
}

// Same inputs through handoff.mjs (tests/fixtures/handoff-parity.json, made with node): byte-identical output.
#[test]
fn matches_the_js_output() {
    let f: Value = serde_json::from_str(include_str!("fixtures/handoff-parity.json")).unwrap();
    let chat = f["chat"].as_array().unwrap();
    let back = plan_handoff(&HandoffArgs { until: Some(chat.len() - 1), model: Some("opus"), label: Some("L"), ..HandoffArgs::new(chat, "claude") });
    assert_eq!(back.as_ref().map(|b| &b["text"]), Some(&f["back"]["text"]));
    assert_eq!(back.as_ref(), Some(&f["back"]));
    let fresh = plan_handoff(&HandoffArgs { fresh: true, budget: Some(900), ..HandoffArgs::new(chat, "opencode") });
    assert_eq!(fresh.as_ref().map(|b| &b["text"]), Some(&f["fresh"]["text"]));
    assert_eq!(fresh.as_ref(), Some(&f["fresh"]));
    assert_eq!(read_chat(chat, Some(0), None), f["read"].as_str().unwrap());
}
