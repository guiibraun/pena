// The font store of public/skia.js: Skia shapes text itself, so it needs the font files — the document's own fonts
// first, then `/fonts/faces?family=` (Google Fonts, proxied by the server). Each font file is registered once under
// its own alias ("family#n"), so one family with several weight files never shares a name.
// Fetches are synchronous here: a font is ready as soon as `ensure` returns.
use crate::core::{encode_uri_component, fmt_num, get, js_string, number};
use serde_json::Value;
use skia_safe::textlayout::{FontCollection, TypefaceFontProvider};
use skia_safe::{FontMgr, FontStyle};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Debug, PartialEq)]
pub struct Face {
    pub family: String,
    pub weight: [f64; 2],
    pub style: String,
    pub url: String,
}

pub fn parse_weight(w: &Value) -> [f64; 2] {
    if w.is_null() {
        return [400.0, 400.0];
    }
    let s = js_string(w);
    let parts: Vec<f64> = s.split_whitespace().map(|x| crate::core::str_number(x)).collect();
    let first = parts.first().copied().unwrap_or(0.0);
    [first, parts.get(1).copied().unwrap_or(first)]
}

const WEIGHTS: [(&str, f64); 10] = [("thin", 100.0), ("extralight", 200.0), ("light", 300.0), ("normal", 400.0), ("regular", 400.0), ("medium", 500.0), ("semibold", 600.0), ("bold", 700.0), ("extrabold", 800.0), ("black", 900.0)];
pub fn weight_of(w: &Value) -> f64 {
    if let Value::Number(n) = w {
        return n.as_f64().unwrap_or(400.0);
    }
    let key: String = if w.is_null() { String::new() } else { js_string(w).to_lowercase().chars().filter(|c| !c.is_whitespace() && *c != '_' && *c != '-').collect() };
    if let Some((_, v)) = WEIGHTS.iter().find(|(k, _)| *k == key) {
        return *v;
    }
    let n = if w.is_null() { f64::NAN } else { number(w) };
    if n.is_nan() || n == 0.0 { 400.0 } else { n }
}

pub struct Fonts {
    provider: TypefaceFontProvider,
    pub collection: FontCollection,
    mgr: FontMgr,
    loaded: HashSet<String>,
    families: HashMap<String, Vec<Face>>,
    doc_faces: Vec<Face>,
    aliases: HashMap<String, String>,
    url_alias: HashMap<String, Option<String>>,
    /// bumps whenever a font is registered: cached paragraphs are rebuilt
    pub version: u64,
}

fn key(family: &str, weight: f64, italic: bool) -> String {
    format!("{family}|{}|{italic}", fmt_num(weight))
}

impl Fonts {
    pub fn new() -> Self {
        let provider = TypefaceFontProvider::new();
        let mut f = Fonts {
            collection: FontCollection::new(),
            provider,
            // font files are parsed by the platform's font manager (FreeType on Linux, like CanvasKit; CoreText on macOS)
            mgr: FontMgr::custom_empty().unwrap_or_else(FontMgr::new),
            loaded: HashSet::new(),
            families: HashMap::new(),
            doc_faces: vec![],
            aliases: HashMap::new(),
            url_alias: HashMap::new(),
            version: 0,
        };
        f.rebuild();
        f
    }
    fn rebuild(&mut self) {
        let mut c = FontCollection::new();
        c.set_default_font_manager(Some(FontMgr::from(self.provider.clone())), None);
        c.enable_font_fallback();
        self.collection = c;
        self.version += 1;
    }
    /// doc.fonts: [{ name, url, weight, style }]; urls already resolved with assetUrl
    pub fn set_doc_fonts(&mut self, list: &Value, asset_url: impl Fn(&str) -> String) {
        let faces: Vec<Face> = crate::core::list(list)
            .into_iter()
            .filter(|f| crate::core::truthy(get(f, "url")))
            .map(|f| {
                let w = get(f, "weight");
                let w = if let Value::Array(a) = w { Value::String(a.iter().map(js_string).collect::<Vec<_>>().join(" ")) } else { w.clone() };
                Face {
                    family: js_string(get(f, "name")),
                    weight: parse_weight(&w),
                    style: f.get("style").filter(|s| !s.is_null()).map(js_string).unwrap_or_else(|| "normal".into()),
                    url: asset_url(&js_string(get(f, "url"))),
                }
            })
            .collect();
        // the document now brings its own files for these families (e.g. an import): forget what was resolved before
        if faces != self.doc_faces {
            let own: HashSet<String> = faces.iter().map(|f| f.family.clone()).collect();
            let fam = |k: &String| k.split('|').next().unwrap_or("").to_string();
            self.loaded.retain(|k| !own.contains(&fam(k)));
            self.aliases.retain(|k, _| !own.contains(&fam(k)));
            self.doc_faces = faces;
        }
    }
    pub fn faces(&mut self, family: &str, fetch: &dyn Fn(&str) -> Option<Vec<u8>>) -> Vec<Face> {
        let own: Vec<Face> = self.doc_faces.iter().filter(|f| f.family == family).cloned().collect();
        if !own.is_empty() {
            return own;
        }
        if let Some(f) = self.families.get(family) {
            return f.clone();
        }
        let list = fetch(&format!("/fonts/faces?family={}", encode_uri_component(family)))
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .map(|f| Face {
                family: family.into(),
                weight: parse_weight(get(f, "weight")),
                style: js_string(get(f, "style")),
                url: js_string(get(f, "url")),
            })
            .collect::<Vec<_>>();
        self.families.insert(family.into(), list.clone());
        list
    }
    pub fn closest(faces: &[Face], weight: f64, italic: bool) -> Option<Face> {
        let style = if italic { "italic" } else { "normal" };
        let styled: Vec<&Face> = faces.iter().filter(|f| f.style == style).collect();
        let pool: Vec<&Face> = if styled.is_empty() { faces.iter().collect() } else { styled };
        let dist = |f: &Face| if weight < f.weight[0] { f.weight[0] - weight } else if weight > f.weight[1] { weight - f.weight[1] } else { 0.0 };
        let mut best: Option<&Face> = None;
        for f in pool {
            // a stable sort's first element: the earliest of the smallest (NaN distances never win, as in JS sort)
            if best.is_none_or(|b| dist(f) < dist(b)) {
                best = Some(f);
            }
        }
        best.cloned()
    }
    /// the registered alias for a request, or None if not loaded
    pub fn alias(&self, family: &str, weight: f64, italic: bool) -> Option<String> {
        self.aliases.get(&key(family, weight, italic)).cloned()
    }
    /// Load the closest face of a family (once per request, also when it fails).
    pub fn ensure(&mut self, family: &str, weight: f64, italic: bool, fetch: &dyn Fn(&str) -> Option<Vec<u8>>) {
        if family.is_empty() {
            return;
        }
        let k = key(family, weight, italic);
        if !self.loaded.insert(k.clone()) {
            return;
        }
        let faces = self.faces(family, fetch);
        let Some(face) = Self::closest(&faces, weight, italic) else { return };
        if !self.url_alias.contains_key(&face.url) {
            let alias = format!("{family}#{}", self.url_alias.len());
            let tf = fetch(&face.url).and_then(|bytes| self.mgr.new_from_data(skia_safe::Data::new_copy(&bytes), None));
            let alias = tf.map(|tf| {
                self.provider.register_typeface(tf, Some(alias.as_str()));
                self.rebuild();
                alias
            });
            self.url_alias.insert(face.url.clone(), alias);
        }
        if let Some(Some(a)) = self.url_alias.get(&face.url) {
            self.aliases.insert(k, a.clone());
        }
    }
}

// FontStyle for a weight/italic pair (text and spans)
pub fn font_style(weight: f64, italic: bool) -> FontStyle {
    use skia_safe::font_style::{Slant, Weight, Width};
    FontStyle::new(Weight::from(weight as i32), Width::NORMAL, if italic { Slant::Italic } else { Slant::Upright })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn weights_and_faces() {
        assert_eq!(weight_of(&json!("SemiBold")), 600.0);
        assert_eq!(weight_of(&json!("650")), 650.0);
        assert_eq!(weight_of(&Value::Null), 400.0);
        assert_eq!(parse_weight(&json!("100 900")), [100.0, 900.0]);
        let f = |w: [f64; 2], s: &str, u: &str| Face { family: "X".into(), weight: w, style: s.into(), url: u.into() };
        let faces = vec![f([400.0, 400.0], "normal", "a"), f([700.0, 700.0], "normal", "b"), f([400.0, 400.0], "italic", "c")];
        assert_eq!(Fonts::closest(&faces, 600.0, false).unwrap().url, "b");
        assert_eq!(Fonts::closest(&faces, 550.0, false).unwrap().url, "a");
        assert_eq!(Fonts::closest(&faces, 700.0, true).unwrap().url, "c");
    }
}
