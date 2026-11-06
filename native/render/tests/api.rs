// The public API on a tiny document, no fonts or server needed.
use base64::Engine;
use pena_render::Renderer;
use serde_json::json;

fn bytes(v: &serde_json::Value) -> Vec<u8> {
    let data = v["data"].as_str().unwrap();
    base64::engine::general_purpose::STANDARD.decode(data.split(',').nth(1).unwrap()).unwrap()
}

#[test]
fn renders_formats_and_sizes() {
    let doc = json!({ "children": [] });
    let roots = json!([
        { "id": "a", "type": "frame", "x": 10, "y": 20, "layout": "vertical", "padding": 5, "gap": 3, "children": [
            { "id": "b", "type": "rectangle", "width": 40, "height": 10, "fill": "#FF0000" },
            { "id": "c", "type": "rectangle", "width": 20, "height": 30, "fill": "#00FF0080" }
        ] }
    ]);
    let none = |_: &str| None;
    let mut r = Renderer::new();
    assert_eq!(r.root_sizes(&doc, &roots, &none), json!({ "a": { "w": 50.0, "h": 53.0 } }));

    let png = r.render(&doc, &roots, &["a".into(), "c".into()], "png", 2.0, 92, &none).unwrap();
    assert_eq!(png.len(), 2);
    assert!(png[0]["data"].as_str().unwrap().starts_with("data:image/png;base64,"));
    let img = skia_safe::Image::from_encoded(skia_safe::Data::new_copy(&bytes(&png[0]))).unwrap();
    assert_eq!((img.width(), img.height()), (100, 106));
    let c = skia_safe::Image::from_encoded(skia_safe::Data::new_copy(&bytes(&png[1]))).unwrap();
    assert_eq!((c.width(), c.height()), (40, 60));

    let jpg = r.render(&doc, &roots, &["a".into()], "jpg", 1.0, 80, &none).unwrap();
    assert!(jpg[0]["data"].as_str().unwrap().starts_with("data:image/jpeg;base64,"));
    assert_eq!(&bytes(&jpg[0])[..3], &[0xFF, 0xD8, 0xFF]);
    let webp = r.render(&doc, &roots, &["a".into()], "webp", 1.0, 80, &none).unwrap();
    let w = bytes(&webp[0]);
    assert!(&w[..4] == b"RIFF" && &w[8..12] == b"WEBP");

    let err = r.render(&doc, &roots, &["nope".into()], "png", 1.0, 92, &none).unwrap_err();
    assert_eq!(err.to_string(), "Node not found on canvas: nope");
}
