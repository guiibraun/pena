// Ports of figma.test.mjs and browser-import.test.mjs, plus an export → import round trip.
use crate::browser::{color, family, find_payload};
use crate::kiwi::{self, hex};
use crate::{export_figma, import_browser_snapshot, import_figma};
use indexmap::IndexMap;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::io::{Read, Write};

const SCHEMA: &str = r"
enum NodeType { DOCUMENT = 0; CANVAS = 1; FRAME = 2; TEXT = 3; RECTANGLE = 4; VECTOR = 5; SYMBOL = 6; INSTANCE = 7; }
enum PaintType { SOLID = 0; GRADIENT_LINEAR = 1; IMAGE = 2; }
enum StackMode { NONE = 0; HORIZONTAL = 1; VERTICAL = 2; }
enum StackAlign { MIN = 0; CENTER = 1; MAX = 2; SPACE_BETWEEN = 3; }
enum StackSize { FIXED = 0; RESIZE_TO_FIT_WITH_IMPLICIT_SIZE = 1; }
enum TextAutoResize { NONE = 0; WIDTH_AND_HEIGHT = 1; HEIGHT = 2; }
struct GUID { uint sessionID; uint localID; }
struct Color { float r; float g; float b; float a; }
struct Vector { float x; float y; }
struct Matrix { float m00; float m01; float m02; float m10; float m11; float m12; }
struct ColorStop { Color color; float position; }
message ParentIndex { GUID guid = 1; string position = 2; }
message Image { byte[] hash = 1; }
message Paint { PaintType type = 1; Color color = 2; float opacity = 3; bool visible = 4; ColorStop[] stops = 5; Matrix transform = 6; Image image = 7; }
message FontName { string family = 1; string style = 2; }
message TextData { string characters = 1; }
message VectorData { uint vectorNetworkBlob = 1; }
message GUIDPath { GUID[] guids = 1; }
message SymbolData { GUID symbolID = 1; NodeChange[] symbolOverrides = 2; }
message NodeChange {
  GUID guid = 1; ParentIndex parentIndex = 2; NodeType type = 3; string name = 4; bool visible = 5; Vector size = 6; Matrix transform = 7;
  Paint[] fillPaints = 8; Paint[] strokePaints = 9; float strokeWeight = 10; float cornerRadius = 11;
  StackMode stackMode = 12; float stackSpacing = 13; float stackVerticalPadding = 14; float stackHorizontalPadding = 15;
  float stackPaddingRight = 16; float stackPaddingBottom = 17; StackAlign stackCounterAlignItems = 18; StackSize stackPrimarySizing = 19;
  TextData textData = 20; FontName fontName = 21; float fontSize = 22; TextAutoResize textAutoResize = 23;
  VectorData vectorData = 24; SymbolData symbolData = 25; GUIDPath guidPath = 26; bool stackChildPrimaryGrow = 27;
}
message Blob { byte[] bytes = 1; }
message Message { NodeChange[] nodeChanges = 1; Blob[] blobs = 2; }
";

fn deflate(b: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
    e.write_all(b).unwrap();
    e.finish().unwrap()
}
fn zip(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut z = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    for (name, b) in files {
        z.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b).unwrap();
    }
    z.finish().unwrap().into_inner()
}
fn unzip(b: &[u8]) -> IndexMap<String, Vec<u8>> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(b)).unwrap();
    let mut out = IndexMap::new();
    for i in 0..z.len() {
        let mut e = z.by_index(i).unwrap();
        let mut v = Vec::new();
        e.read_to_end(&mut v).unwrap();
        out.insert(e.name().to_string(), v);
    }
    out
}

fn id(n: u32) -> Value {
    json!({ "sessionID": 1, "localID": n })
}
fn at(parent: u32, pos: &str) -> Value {
    json!({ "guid": id(parent), "position": pos })
}
fn t(x: f64, y: f64) -> Value {
    json!({ "m00": 1, "m01": 0, "m02": x, "m10": 0, "m11": 1, "m12": y })
}
fn solid(r: f64, g: f64, b: f64) -> Value {
    json!({ "type": "SOLID", "color": { "r": r, "g": g, "b": b, "a": 1 }, "opacity": 1, "visible": true })
}
fn text(n: u32, parent: u32, pos: &str, characters: &str) -> Value {
    json!({ "guid": id(n), "parentIndex": at(parent, pos), "type": "TEXT", "name": "Label", "visible": true, "size": { "x": 40, "y": 20 }, "transform": t(0.0, 0.0),
        "fillPaints": [solid(0.0, 0.0, 0.0)], "textData": { "characters": characters }, "fontName": { "family": "Inter", "style": "Semi Bold" }, "fontSize": 16, "textAutoResize": "WIDTH_AND_HEIGHT" })
}

// the clipboard variant: a bare fig-kiwi archive, here with the subset of Figma's schema the converter reads
fn fixture() -> Vec<u8> {
    let schema = kiwi::parse_text(SCHEMA);
    // triangle: 3 vertices, 3 straight segments, one region (winding bit 1 = nonzero)
    let mut net = vec![0u8; 12 + 3 * 12 + 3 * 28 + 8 + 4 + 12];
    let put = |b: &mut Vec<u8>, o: usize, v: [u8; 4]| b[o..o + 4].copy_from_slice(&v);
    for (i, v) in [3u32, 3, 1].iter().enumerate() {
        put(&mut net, i * 4, v.to_le_bytes());
    }
    for (i, (x, y)) in [(0f32, 0f32), (10.0, 0.0), (5.0, 8.0)].iter().enumerate() {
        put(&mut net, 12 + i * 12 + 4, x.to_le_bytes());
        put(&mut net, 12 + i * 12 + 8, y.to_le_bytes());
    }
    for (i, (s, e)) in [(0u32, 1u32), (1, 2), (2, 0)].iter().enumerate() {
        put(&mut net, 48 + i * 28 + 4, s.to_le_bytes());
        put(&mut net, 48 + i * 28 + 16, e.to_le_bytes());
    }
    for (i, v) in [1u32, 1, 3, 0, 1, 2].iter().enumerate() {
        put(&mut net, 132 + i * 4, v.to_le_bytes());
    }
    let root = json!({ "sessionID": 0, "localID": 0 });
    let node_changes = json!([
        { "guid": root, "type": "DOCUMENT", "visible": true },
        { "guid": id(1), "parentIndex": { "guid": root, "position": "!" }, "type": "CANVAS", "name": "Page 1", "visible": true },
        { "guid": id(9), "parentIndex": { "guid": root, "position": "\"" }, "type": "CANVAS", "name": "Internal", "visible": false },
        // component (a button) and, in the card, an instance of it with its label overridden
        { "guid": id(20), "parentIndex": at(1, "#"), "type": "SYMBOL", "name": "Button", "visible": true, "size": { "x": 80, "y": 32 }, "transform": t(500.0, 0.0),
          "fillPaints": [solid(0.0, 0.0, 1.0)], "cornerRadius": 6, "stackMode": "HORIZONTAL", "stackHorizontalPadding": 12, "stackPaddingRight": 12, "stackVerticalPadding": 8, "stackPaddingBottom": 8 },
        text(21, 20, "!", "Button"),
        { "guid": id(2), "parentIndex": at(1, "!"), "type": "FRAME", "name": "Card", "visible": true, "size": { "x": 200, "y": 120 }, "transform": t(100.0, 50.0), "fillPaints": [solid(1.0, 1.0, 1.0)],
          "strokePaints": [solid(0.9, 0.9, 0.9)], "strokeWeight": 1, "cornerRadius": 12, "stackMode": "VERTICAL", "stackSpacing": 8, "stackVerticalPadding": 16, "stackHorizontalPadding": 16,
          "stackPaddingRight": 16, "stackPaddingBottom": 16, "stackCounterAlignItems": "CENTER", "stackPrimarySizing": "FIXED" },
        text(3, 2, "#", "Hello"),
        { "guid": id(4), "parentIndex": at(2, "\""), "type": "RECTANGLE", "name": "Bar", "visible": true, "size": { "x": 168, "y": 8 }, "transform": t(0.0, 0.0), "stackChildPrimaryGrow": true,
          "fillPaints": [{ "type": "GRADIENT_LINEAR", "visible": true, "opacity": 1, "transform": t(0.0, 0.0),
            "stops": [{ "color": { "r": 1, "g": 0, "b": 0, "a": 1 }, "position": 0 }, { "color": { "r": 0, "g": 0, "b": 1, "a": 1 }, "position": 1 }] }] },
        { "guid": id(5), "parentIndex": at(2, "!"), "type": "INSTANCE", "name": "Button", "visible": true, "size": { "x": 80, "y": 32 }, "transform": t(0.0, 0.0),
          "symbolData": { "symbolID": id(20), "symbolOverrides": [{ "guidPath": { "guids": [id(21)] }, "textData": { "characters": "Comprar" } }] } },
        { "guid": id(6), "parentIndex": at(1, "\""), "type": "VECTOR", "name": "Triangle", "visible": true, "size": { "x": 10, "y": 8 }, "transform": t(0.0, 300.0),
          "fillPaints": [solid(0.0, 1.0, 0.0)], "vectorData": { "vectorNetworkBlob": 0 } },
        { "guid": id(7), "parentIndex": at(1, "$"), "type": "RECTANGLE", "name": "Photo", "visible": true, "size": { "x": 50, "y": 50 }, "transform": t(0.0, 400.0),
          "fillPaints": [{ "type": "IMAGE", "visible": true, "opacity": 1, "image": { "hash": "abcd" } }] },
        // mirrored in Figma (m00 = -1): the box spans 60..100, so .pen x = 60 with flipX (flipped around its center)
        { "guid": id(8), "parentIndex": at(1, "%"), "type": "RECTANGLE", "name": "Mirrored", "visible": true, "size": { "x": 40, "y": 10 },
          "transform": { "m00": -1, "m01": 0, "m02": 100, "m10": 0, "m11": 1, "m12": 500 }, "fillPaints": [solid(1.0, 0.0, 0.0)] },
    ]);
    let message = schema.encode_message(&json!({ "nodeChanges": node_changes, "blobs": [{ "bytes": hex(&net) }] })).unwrap();
    let mut fig = b"fig-kiwi".to_vec();
    fig.extend_from_slice(&48u32.to_le_bytes());
    for c in [deflate(&schema.encode()), deflate(&message)] {
        fig.extend_from_slice(&(c.len() as u32).to_le_bytes());
        fig.extend_from_slice(&c);
    }
    fig
}

fn pick(v: &Value, keys: &[&str]) -> Value {
    Value::Object(keys.iter().filter(|k| !v[**k].is_null()).map(|k| (k.to_string(), v[*k].clone())).collect())
}

#[test]
fn figma_import() {
    let fig = fixture();
    // bare archive (what the clipboard carries): pages, structure, layout, text, gradient, vector, instance
    let res = import_figma(&fig, &mut |_, _| unreachable!("no images on the clipboard")).unwrap();
    let pages = res["pages"].as_array().unwrap();
    assert_eq!(pages.iter().map(|p| p["name"].clone()).collect::<Vec<_>>(), [json!("Page 1")]); // hidden internal page skipped
    let nodes = pages[0]["nodes"].as_array().unwrap(); // bottom → top (ascending position)
    let [card, triangle, button, photo, mirrored] = &nodes[..] else { panic!("{nodes:?}") };
    assert_eq!(pick(mirrored, &["x", "y", "flipX", "rotation"]), json!({ "x": 60, "y": 500, "flipX": true }));
    assert_eq!(card["type"], "frame");
    assert_eq!(
        pick(card, &["x", "y", "width", "layout", "gap", "padding", "alignItems", "cornerRadius"]),
        json!({ "x": 100, "y": 50, "width": 200, "layout": "vertical", "gap": 8, "padding": 16, "alignItems": "center", "cornerRadius": 12 })
    );
    assert_eq!(card["height"], 120);
    assert_eq!(card["fill"], "#ffffff");
    assert_eq!(card["stroke"], "#e5e5e5");
    let kids = card["children"].as_array().unwrap();
    assert_eq!(kids.iter().map(|c| c["name"].clone()).collect::<Vec<_>>(), [json!("Button"), json!("Bar"), json!("Label")]);
    let [instance, bar, label] = &kids[..] else { panic!() };
    assert!(label.get("x").is_none()); // inside flex: no x/y
    assert_eq!(pick(label, &["content", "fontWeight", "fontFamily", "textGrowth"]), json!({ "content": "Hello", "fontWeight": "600", "fontFamily": "Inter" }));
    assert_eq!(bar["height"], "fill_container");
    assert_eq!(pick(&bar["fill"], &["type", "gradientType", "rotation", "size"]), json!({ "type": "gradient", "gradientType": "linear", "rotation": 270, "size": { "height": 1 } }));
    assert_eq!(bar["fill"]["colors"], json!([{ "color": "#ff0000", "position": 0 }, { "color": "#0000ff", "position": 1 }]));
    assert_eq!(instance["type"], "frame"); // instances become plain frames, like pen.dev
    assert_eq!(instance["children"][0]["content"], "Comprar");
    assert_eq!(button["name"], "Button");
    assert_eq!(triangle["geometry"], "M0 0L10 0L5 8L0 0Z");
    assert_eq!(triangle["viewBox"], json!([0, 0, 10, 8]));
    assert_eq!(photo["fill"], json!({ "type": "image", "mode": "cover" })); // no image bytes on the clipboard
    assert_eq!(res["faces"], json!([{ "family": "Inter", "weight": 600, "italic": false }]));

    // .fig zip: canvas.fig + images/<hash>
    let png = [0x89u8, 0x50, 0x4e, 0x47, 1, 2, 3];
    let z = zip(&[("canvas.fig", &fig), ("images/abcd", &png)]);
    let mut saved = vec![];
    let res = import_figma(&z, &mut |name, bytes| {
        saved.push((name.to_string(), bytes.len()));
        format!("./images/{name}")
    })
    .unwrap();
    assert_eq!(saved, [("abcd.png".to_string(), 7)]);
    let photo = res["pages"][0]["nodes"].as_array().unwrap().iter().find(|n| n["name"] == "Photo").unwrap().clone();
    assert_eq!(photo["fill"]["url"], "./images/abcd.png");

    assert!(import_figma(b"not a figma file", &mut |_, _| String::new()).is_err());
}

#[test]
fn figma_export_round_trip() {
    let png = [0x89u8, 0x50, 0x4e, 0x47, 1, 2, 3];
    // a laid-out tree (as the editor sends it) → .fig → import again
    let laid = json!([{ "type": "frame", "name": "Card", "x": 10, "y": 20, "w": 200, "h": 120, "width": 200, "layout": "vertical", "gap": 8, "padding": [16, 12], "alignItems": "center", "clip": true,
      "fill": "#ffffff80", "stroke": "#e5e5e5", "strokeWidth": 2, "strokeAlignment": "inner", "cornerRadius": [8, 8, 0, 0],
      "effect": { "type": "shadow", "shadowType": "outer", "offset": { "x": 0, "y": 4 }, "blur": 14, "color": "#00000040" },
      "children": [
        { "type": "text", "name": "Title", "x": 12, "y": 16, "w": 176, "h": 24, "width": "fill_container", "textGrowth": "fixed-width", "content": "Olá", "fontFamily": "Inter", "fontWeight": "600", "fontSize": 20, "lineHeight": 1.2, "fill": "#111111" },
        { "type": "rectangle", "name": "Bar", "x": 12, "y": 48, "w": 176, "h": 8, "width": "fill_container", "height": 8,
          "fill": { "type": "gradient", "gradientType": "linear", "rotation": 270, "size": { "height": 1 }, "colors": [{ "color": "#ff0000", "position": 0 }, { "color": "#0000ff", "position": 1 }] } },
        { "type": "path", "name": "Arrow", "x": 12, "y": 64, "w": 20, "h": 10, "geometry": "M0 0 L10 10 L20 0 Z", "fill": "#00ff00" },
        { "type": "ellipse", "name": "Dot", "x": 40, "y": 64, "w": 10, "h": 10, "fill": { "type": "image", "url": "./images/p.png", "mode": "contain" } },
        { "type": "note", "name": "pen-only" },
      ] }]);
    let read = |u: &str| (u == "./images/p.png").then(|| png.to_vec());
    let fig2 = export_figma(&laid, "Teste", &read, Some(b"thumb")).unwrap();
    let files = unzip(&fig2);
    let sha = hex(&Sha1::digest(png));
    assert_eq!(files.keys().cloned().collect::<Vec<_>>(), [format!("images/{sha}"), "canvas.fig".into(), "meta.json".into(), "thumbnail.png".into()]);
    let meta: Value = serde_json::from_slice(&files["meta.json"]).unwrap();
    assert_eq!(meta["file_name"], "Teste");
    assert_eq!(meta["client_meta"]["render_coordinates"], json!({ "x": 10, "y": 20, "width": 200, "height": 120 }));
    assert!(meta["exported_at"].as_str().unwrap().ends_with('Z'));

    let back = import_figma(&fig2, &mut |name, _| format!("./images/{name}")).unwrap();
    let pages = back["pages"].as_array().unwrap();
    assert_eq!(pages.iter().map(|p| p["name"].clone()).collect::<Vec<_>>(), [json!("Page 1")]);
    let c2 = &pages[0]["nodes"][0];
    assert_eq!(
        pick(c2, &["x", "y", "width", "layout", "gap", "padding", "alignItems", "clip", "fill", "stroke", "strokeWidth", "strokeAlignment", "cornerRadius"]),
        json!({ "x": 10, "y": 20, "width": 200, "layout": "vertical", "gap": 8, "padding": [16, 12], "alignItems": "center", "clip": true, "fill": "#ffffff80", "stroke": "#e5e5e5",
            "strokeWidth": 2, "strokeAlignment": "inner", "cornerRadius": [8, 8, 0, 0] })
    );
    assert_eq!(c2["effect"], json!({ "type": "shadow", "shadowType": "outer", "color": "#00000040", "offset": { "x": 0, "y": 4 }, "blur": 14 }));
    let kids = c2["children"].as_array().unwrap();
    let [title, bar2, arrow, dot] = &kids[..] else { panic!("{kids:?}") };
    assert_eq!(
        pick(title, &["content", "fontWeight", "fontSize", "lineHeight", "width", "textGrowth"]),
        json!({ "content": "Olá", "fontWeight": "600", "fontSize": 20, "lineHeight": 1.2, "width": "fill_container", "textGrowth": "fixed-width" })
    );
    assert_eq!(pick(&bar2["fill"], &["rotation", "size"]), json!({ "rotation": 270, "size": { "height": 1 } }));
    assert_eq!(bar2["width"], "fill_container");
    assert_eq!(arrow["geometry"], "M0 0L10 10L20 0L0 0Z");
    assert_eq!(dot["fill"], json!({ "type": "image", "url": format!("./images/{sha}.png"), "mode": "contain" }));
}

// export a document's roots, import the result and compare what survives the trip node by node
#[test]
fn figma_round_trip_document() {
    let roots = json!([
        { "type": "frame", "name": "Hero", "x": 0, "y": 0, "w": 400, "h": 300, "width": 400, "height": 300, "layout": "none", "fill": "#0d1117", "cornerRadius": 16, "children": [
            { "type": "rectangle", "name": "Box", "x": 20, "y": 30, "w": 100, "h": 50, "width": 100, "height": 50, "fill": "#ff8800", "opacity": 0.5, "rotation": 30 },
            { "type": "ellipse", "name": "Ring", "x": 200, "y": 40, "w": 80, "h": 80, "width": 80, "height": 80, "fill": "#00ff00", "innerRadius": 0.5, "sweepAngle": 270 },
            { "type": "text", "name": "Copy", "x": 20, "y": 120, "w": 300, "h": 40, "content": "Pena", "fontFamily": "Inter", "fontWeight": "700", "fontStyle": "italic", "fontSize": 32, "fill": "#ffffff", "textAlign": "center" },
            { "type": "line", "name": "Rule", "x": 20, "y": 200, "w": 300, "h": 0, "stroke": "#ffffff", "strokeWidth": 2 },
            { "type": "group", "name": "Group", "x": 300, "y": 200, "w": 50, "h": 50, "children": [
                { "type": "polygon", "name": "Tri", "x": 0, "y": 0, "w": 50, "h": 50, "width": 50, "height": 50, "polygonCount": 3, "fill": "#123456" } ] },
        ] },
        { "type": "frame", "name": "Row", "x": 500, "y": 0, "w": 300, "h": 60, "layout": "horizontal", "gap": 10, "padding": 10, "justifyContent": "space_between", "children": [
            { "type": "rectangle", "name": "A", "x": 10, "y": 10, "w": 40, "h": 40, "width": 40, "height": "fill_container", "fill": "#ff0000" },
            { "type": "rectangle", "name": "B", "x": 250, "y": 10, "w": 40, "h": 40, "width": 40, "height": 40, "fill": "#0000ff", "layoutPosition": "absolute" } ] },
    ]);
    let fig = export_figma(&roots, "Doc", &|_| None, None).unwrap();
    let back = import_figma(&fig, &mut |n, _| n.into()).unwrap();
    let nodes = back["pages"][0]["nodes"].as_array().unwrap();
    assert_eq!(nodes.len(), 2);
    let hero = &nodes[0];
    assert_eq!(pick(hero, &["type", "name", "x", "y", "width", "height", "fill", "cornerRadius", "layout"]),
        json!({ "type": "frame", "name": "Hero", "x": 0, "y": 0, "width": 400, "height": 300, "fill": "#0d1117", "cornerRadius": 16, "layout": "none" }));
    let k = hero["children"].as_array().unwrap();
    assert_eq!(k.iter().map(|c| c["name"].clone()).collect::<Vec<_>>(), [json!("Box"), json!("Ring"), json!("Copy"), json!("Rule"), json!("Group")]);
    assert_eq!(pick(&k[0], &["type", "x", "y", "width", "height", "fill", "opacity", "rotation"]),
        json!({ "type": "rectangle", "x": 20, "y": 30, "width": 100, "height": 50, "fill": "#ff8800", "opacity": 0.5, "rotation": 30 }));
    assert_eq!(pick(&k[1], &["type", "innerRadius", "sweepAngle"]), json!({ "type": "ellipse", "innerRadius": 0.5, "sweepAngle": 270 }));
    assert_eq!(pick(&k[2], &["type", "content", "fontWeight", "fontStyle", "fontSize", "fill", "textAlign"]),
        json!({ "type": "text", "content": "Pena", "fontWeight": "700", "fontStyle": "italic", "fontSize": 32, "fill": "#ffffff", "textAlign": "center" }));
    assert_eq!(pick(&k[3], &["type", "x", "y", "width", "stroke", "strokeWidth"]), json!({ "type": "line", "x": 20, "y": 200, "width": 300, "stroke": "#ffffff", "strokeWidth": 2 }));
    assert_eq!(k[4]["type"], "group");
    assert_eq!(pick(&k[4]["children"][0], &["type", "polygonCount", "fill"]), json!({ "type": "polygon", "polygonCount": 3, "fill": "#123456" }));
    let row = &nodes[1];
    assert_eq!(pick(row, &["layout", "gap", "padding", "justifyContent"]), json!({ "gap": 10, "padding": 10, "justifyContent": "space_between" }));
    let r = row["children"].as_array().unwrap();
    assert_eq!(pick(&r[0], &["x", "height"]), json!({ "height": "fill_container" }));
    assert_eq!(pick(&r[1], &["x", "y", "layoutPosition"]), json!({ "x": 250, "y": 10, "layoutPosition": "absolute" }));
}

#[test]
fn browser_import() {
    // Chrome's `setData` pickle, as found on the macOS pasteboard
    let str16 = |s: &str| {
        let u: Vec<u16> = s.encode_utf16().collect();
        let mut b = vec![0u8; 4 + ((u.len() * 2 + 3) & !3)];
        b[..4].copy_from_slice(&(u.len() as u32).to_le_bytes());
        for (i, c) in u.iter().enumerate() {
            b[4 + i * 2..6 + i * 2].copy_from_slice(&c.to_le_bytes());
        }
        b
    };
    let body = [vec![2, 0, 0, 0], str16("text/x-other"), str16("nope"), str16("web application/vnd.pen.dev.browser-import+json"), str16(r#"{"version":1}"#)].concat();
    let pickle = [(body.len() as u32).to_le_bytes().to_vec(), body].concat();
    let types = |e: &[(&str, &[u8])]| e.iter().map(|(k, v)| (k.to_string(), v.to_vec())).collect::<IndexMap<_, _>>();
    assert_eq!(find_payload(&types(&[("org.chromium.web-custom-data", &pickle)])).as_deref(), Some(r#"{"version":1}"#));
    // the async clipboard API's map + per-type entry
    let map = br#"{"application/vnd.pen.dev.browser-import+json":"org.w3.web-custom-format.type-0"}"#;
    assert_eq!(find_payload(&types(&[("org.w3.web-custom-format.map", map), ("org.w3.web-custom-format.type-0", br#"{"x":1}"#)])).as_deref(), Some(r#"{"x":1}"#));
    assert_eq!(find_payload(&types(&[])), None);

    assert_eq!(color(Some("rgb(255, 0, 0)")).as_deref(), Some("#ff0000"));
    assert_eq!(color(Some("rgba(0, 0, 0, 0.5)")).as_deref(), Some("#00000080"));
    assert_eq!(color(Some("rgba(0, 0, 0, 0)")), None);
    assert_eq!(color(Some("oklch(1 0 0)")).as_deref(), Some("#ffffff"));
    assert_eq!(color(Some("oklch(0.628 0.2577 29.23)")).as_deref(), Some("#ff0000"));

    assert_eq!(family(Some(r#""Geist Variable", ui-sans-serif, system-ui, sans-serif"#)), "Geist");
    assert_eq!(family(Some("__Playfair_Display_a1b2c3, __Playfair_Display_Fallback_a1b2c3")), "Playfair Display");
    assert_eq!(family(Some("system-ui, sans-serif")), "Inter");
    assert_eq!(family(Some(r#""IBM Plex Sans", sans-serif"#)), "IBM Plex Sans");

    let style = |o: Value| {
        let mut s = json!({ "display": "block" });
        s.as_object_mut().unwrap().extend(o.as_object().unwrap().clone());
        s
    };
    let payload = json!({
        "version": 1,
        "snapshot": {
            "url": "https://example.com/", "viewport": { "w": 800, "h": 600 }, "dpr": 2, "pageBackground": "rgb(255, 255, 255)",
            "root": { "tag": "DIV", "rect": { "x": 100, "y": 50, "w": 300, "h": 200 }, "style": style(json!({ "backgroundColor": "rgb(240, 240, 240)", "borderTopLeftRadius": "8px", "borderTopRightRadius": "8px", "borderBottomRightRadius": "8px", "borderBottomLeftRadius": "8px" })), "children": [
                { "tag": "DIV", "rect": { "x": 110, "y": 60, "w": 280, "h": 40 }, "style": style(json!({})), "children": [ // wrapper: dropped, children hoisted
                    { "tag": "H1", "rect": { "x": 110, "y": 60, "w": 280, "h": 40 }, "text": "  Hello\n  world ", "textRect": { "x": 110, "y": 62, "w": 120.4, "h": 36 }, "isTextLeaf": true, "children": [],
                      "style": style(json!({ "color": "rgb(17, 17, 17)", "fontFamily": "\"Inter\", sans-serif", "fontSize": "24px", "fontWeight": "700", "lineHeight": "36px" })) },
                ] },
                { "tag": "IMG", "rect": { "x": 110, "y": 110, "w": 100, "h": 50 }, "imageSrc": "/a.png", "style": style(json!({ "objectFit": "contain" })), "children": [] },
                { "tag": "BUTTON", "rect": { "x": 220, "y": 110, "w": 80, "h": 30 }, "style": style(json!({ "borderTopStyle": "solid", "borderTopWidth": "1px", "borderTopColor": "rgb(0, 0, 0)", "borderRightStyle": "solid", "borderRightWidth": "1px", "borderBottomStyle": "solid", "borderBottomWidth": "1px", "borderLeftStyle": "solid", "borderLeftWidth": "1px", "boxShadow": "rgba(0, 0, 0, 0.25) 0px 2px 4px 0px" })), "children": [] },
                { "tag": "DIV", "rect": { "x": 0, "y": 0, "w": 10, "h": 10 }, "style": style(json!({ "display": "none", "backgroundColor": "red" })), "children": [] },
            ] },
        },
        "images": [{ "url": "https://example.com/a.png", "contentType": "image/png", "base64": "cG5n" }],
        "fonts": [],
    });
    let mut saved = vec![];
    let res = import_browser_snapshot(&payload.to_string(), &mut |name, data| {
        saved.push((name.to_string(), String::from_utf8_lossy(data).into_owned()));
        format!("./images/{name}")
    })
    .unwrap();
    let root = &res["pages"][0]["nodes"][0];
    let mut head = root.clone();
    head.as_object_mut().unwrap().shift_remove("children");
    assert_eq!(head, json!({ "type": "frame", "name": "div", "x": 0, "y": 0, "width": 300, "height": 200, "layout": "none", "fill": "#f0f0f0", "cornerRadius": 8, "clip": true }));
    let kids = root["children"].as_array().unwrap();
    let [h1, img, button] = &kids[..] else { panic!("{kids:?}") };
    assert_eq!(h1, &json!({ "type": "text", "content": "Hello world", "x": 10, "y": 12, "textGrowth": "fixed-width", "width": 121.4, "fontFamily": "Inter", "fontSize": 24, "fill": "#111111", "fontWeight": "700", "lineHeight": 1.5 }));
    assert_eq!(img, &json!({ "type": "rectangle", "name": "img", "x": 10, "y": 60, "width": 100, "height": 50, "fill": { "type": "image", "url": "./images/web-1.png", "mode": "contain" } }));
    assert_eq!(saved, [("web-1.png".to_string(), "png".to_string())]);
    assert_eq!(button["stroke"], "#000000");
    assert_eq!(button["strokeWidth"], 1);
    assert_eq!(button["effect"], json!({ "type": "shadow", "shadowType": "outer", "color": "#00000040", "offset": { "x": 0, "y": 2 }, "blur": 4 }));
    assert_eq!(res["pages"][0]["name"], "https://example.com/");
    assert!(import_browser_snapshot("{}", &mut |_, _| String::new()).is_err());
}
