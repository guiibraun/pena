// temporary parity harness: import a .fig and print the JSON
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let bytes = std::fs::read(&a[1]).unwrap();
    let v = pena_figma::import_figma(&bytes, &mut |n, _| format!("./images/{n}")).unwrap();
    println!("{}", serde_json::to_string(&v).unwrap());
}
