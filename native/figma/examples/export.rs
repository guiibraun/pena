// temporary parity harness: export roots.json to a .fig (every image url reads as the same fake png)
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let roots: serde_json::Value = serde_json::from_slice(&std::fs::read(&a[1]).unwrap()).unwrap();
    let png = vec![0x89u8, 0x50, 0x4e, 0x47, 9, 9];
    let fig = pena_figma::export_figma(&roots, "Parity", &|u| u.starts_with("./").then(|| png.clone()), Some(b"thumb")).unwrap();
    std::fs::write(&a[2], fig).unwrap();
}
