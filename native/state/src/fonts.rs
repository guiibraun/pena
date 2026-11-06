//! Google Fonts for the Skia canvas: Skia needs the font files themselves, and the browser only gets WOFF2 subsets
//! split by unicode-range. Asked without a browser user agent, Google returns whole TTFs (variable when possible),
//! which we cache in ~/.pena/fonts so fonts work offline after the first use.

use anyhow::{Result, anyhow, bail};
use base64::Engine;
use base64::engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use regex::Regex;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use std::path::PathBuf;
use std::sync::LazyLock;

const UA: &str = "pena"; // anything that isn't a browser gets TTF

fn dir() -> PathBuf {
    crate::library::pena_dir().join("fonts")
}

async fn cached<F: Future<Output = Result<Vec<u8>>>>(key: &str, make: impl FnOnce() -> F) -> Result<Vec<u8>> {
    let file = dir().join(key);
    if file.exists() {
        return Ok(tokio::fs::read(&file).await?);
    }
    let buf = make().await?;
    std::fs::create_dir_all(dir())?;
    std::fs::write(&file, &buf)?;
    Ok(buf)
}

static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| reqwest::Client::builder().user_agent(UA).build().expect("http client"));

async fn get(url: &str) -> Result<Vec<u8>> {
    let r = HTTP.get(url).send().await?;
    if !r.status().is_success() {
        bail!("{} {url}", r.status().as_u16());
    }
    Ok(r.bytes().await?.to_vec())
}

// encodeURIComponent keeps A-Z a-z 0-9 - _ . ! ~ * ' ( )
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');
// Buffer.from(x, 'base64url') takes padded and unpadded input
const B64URL: GeneralPurpose = GeneralPurpose::new(&base64::alphabet::URL_SAFE, GeneralPurposeConfig::new().with_encode_padding(false).with_decode_padding_mode(DecodePaddingMode::Indifferent));

/// -> [{ weight: '100 900' | '400', style: 'normal' | 'italic', url: '/fonts/file/<key>' }]
pub async fn faces(family: &str) -> Result<Vec<Value>> {
    static FACE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"@font-face\s*\{([^}]*)\}").unwrap());
    static SRC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"url\((https:[^)]+)\)").unwrap());
    static WEIGHT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"font-weight:\s*([^;]+);").unwrap());
    static STYLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"font-style:\s*([^;]+);").unwrap());
    let key = format!("{}.css", hex::encode(Sha1::digest(family.as_bytes())));
    let css = cached(&key, || async {
        for q in [":ital,wght@0,100..900;1,100..900", ":wght@100..900", ":ital,wght@0,400;0,700;1,400;1,700", ""] {
            if let Ok(b) = get(&format!("https://fonts.googleapis.com/css2?family={}{q}", utf8_percent_encode(family, URI_COMPONENT))).await {
                return Ok(b);
            }
        }
        Ok(Vec::new()) // cached too, like the Bun server
    })
    .await?;
    let css = String::from_utf8_lossy(&css);
    Ok(FACE
        .captures_iter(&css)
        .filter_map(|c| {
            let b = c.get(1).unwrap().as_str();
            let src = SRC.captures(b)?.get(1).unwrap().as_str();
            let grab = |re: &Regex, d: &str| re.captures(b).map(|m| m[1].trim().to_string()).unwrap_or_else(|| d.into());
            Some(json!({ "weight": grab(&WEIGHT, "400"), "style": grab(&STYLE, "normal"), "url": format!("/fonts/file/{}", B64URL.encode(src)) }))
        })
        .collect())
}

/// path.extname of a URL string
fn extname(s: &str) -> &str {
    let base = &s[s.rfind('/').map_or(0, |i| i + 1)..];
    match base.rfind('.') {
        Some(i) if i > 0 => &base[i..],
        _ => "",
    }
}

/// The font file behind a `/fonts/file/<token>` url (only fonts.gstatic.com).
pub async fn file(token: &str) -> Result<Vec<u8>> {
    let src = B64URL.decode(token).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
    if !src.starts_with("https://fonts.gstatic.com/") {
        bail!("not a Google font");
    }
    let key = format!("{}{}", hex::encode(Sha1::digest(src.as_bytes())), extname(&src));
    cached(&key, || get(&src)).await
}

// Lato as design tools have it: Figma uses Lato 2.0 (nine weights, wider spacing); Google Fonts still serves Lato 1
// (five weights), so imported Figma text set in Lato would wrap differently and lose Medium/Semibold. Downloaded once
// (SIL OFL, latofonts.com) into the font cache.
const LATO2: &str = "https://www.latofonts.com/files/Lato2OFL.zip";
static LATO2_ZIP: tokio::sync::OnceCell<Vec<u8>> = tokio::sync::OnceCell::const_new();

/// -> (file name like 'Lato-Medium.ttf', bytes) for the closest weight
pub async fn lato2(weight: f64, italic: bool) -> Result<(String, Vec<u8>)> {
    let w = (((weight / 100.0) + 0.5).floor() * 100.0).clamp(100.0, 900.0) as u32; // Math.round
    let name = match w {
        100 => "Hairline",
        200 => "Thin",
        300 => "Light",
        400 => "Regular",
        500 => "Medium",
        600 => "Semibold",
        700 => "Bold",
        800 => "Heavy",
        _ => "Black",
    };
    let file = format!("Lato-{name}{}.ttf", if italic { "Italic" } else { "" }).replace("RegularItalic", "Italic");
    let bytes = cached(&format!("lato2-{file}"), || async {
        let zip = LATO2_ZIP.get_or_try_init(|| get(LATO2)).await?;
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(zip.as_slice()))?;
        let entry = (0..z.len()).find(|&i| z.by_index_raw(i).is_ok_and(|e| e.name().is_ok_and(|n| n.ends_with(&format!("/{file}")))));
        let i = entry.ok_or_else(|| anyhow!("{file} not in Lato 2.0"))?;
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut z.by_index(i)?, &mut out)?;
        Ok(out)
    })
    .await?;
    Ok((file, bytes))
}
