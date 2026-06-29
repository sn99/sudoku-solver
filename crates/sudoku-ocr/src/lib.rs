//! Native Sudoku OCR using [rusty-tesseract](https://github.com/thomasgruebl/rusty-tesseract).
//!
//! Requires the `tesseract` binary and English traineddata on the host.
//! Not available in WebAssembly / GitHub Pages (browser uses tesseract.js with the same cell model).

use std::collections::HashMap;
use std::path::Path;

use image::imageops::FilterType;
use image::{DynamicImage, GrayImage};
use rusty_tesseract::{Args, Image};
use sudoku_core::{RecognizedCell, RecognizedGrid};
use thiserror::Error;

/// Minimum confidence (0–100) to accept a digit; below this the cell is treated as empty with low conf.
pub const DEFAULT_CONFIDENCE_THRESHOLD: f32 = 45.0;

#[derive(Debug, Error)]
pub enum OcrError {
    #[error("failed to load image: {0}")]
    Load(#[from] image::ImageError),
    #[error("tesseract error: {0}")]
    Tesseract(String),
    #[error("image too small for a 9×9 grid")]
    TooSmall,
}

/// Recognize a Sudoku puzzle from an image file path.
pub fn recognize_path(path: impl AsRef<Path>) -> Result<RecognizedGrid, OcrError> {
    let img = image::open(path)?;
    recognize_image(&img)
}

/// Recognize assuming the puzzle fills most of the frame (full-image grid).
pub fn recognize_image(img: &DynamicImage) -> Result<RecognizedGrid, OcrError> {
    recognize_image_with_threshold(img, DEFAULT_CONFIDENCE_THRESHOLD)
}

pub fn recognize_image_with_threshold(
    img: &DynamicImage,
    confidence_threshold: f32,
) -> Result<RecognizedGrid, OcrError> {
    let gray = img.to_luma8();
    let (w, h) = gray.dimensions();
    if w < 90 || h < 90 {
        return Err(OcrError::TooSmall);
    }

    // Use the largest centered square crop (phone photos often include margins).
    let side = w.min(h);
    let x0 = (w - side) / 2;
    let y0 = (h - side) / 2;
    let square = image::imageops::crop_imm(&gray, x0, y0, side, side).to_image();

    // Normalize size for stable OCR.
    let target = 900u32;
    let square = image::imageops::resize(&square, target, target, FilterType::CatmullRom);

    let mut grid = RecognizedGrid::empty();
    let cell = target / 9;
    // Inset to avoid grid lines.
    let inset = (cell as f32 * 0.12) as u32;
    let inset = inset.max(2);

    let args = Args {
        lang: "eng".into(),
        config_variables: HashMap::from([(
            "tessedit_char_whitelist".into(),
            "123456789".into(),
        )]),
        dpi: Some(300),
        // Treat the image as a single character.
        psm: Some(10),
        oem: Some(3),
    };

    for r in 0..9u32 {
        for c in 0..9u32 {
            let x = c * cell + inset;
            let y = r * cell + inset;
            let cw = cell.saturating_sub(inset * 2).max(1);
            let ch = cell.saturating_sub(inset * 2).max(1);
            let mut tile = image::imageops::crop_imm(&square, x, y, cw, ch).to_image();
            preprocess_tile(&mut tile);

            // Skip nearly empty tiles (no ink).
            if ink_ratio(&tile) < 0.02 {
                grid.cells[r as usize][c as usize] = RecognizedCell {
                    digit: 0,
                    confidence: Some(100.0),
                };
                continue;
            }

            let dyn_img = DynamicImage::ImageLuma8(tile);
            let tess_img = Image::from_dynamic_image(&dyn_img)
                .map_err(|e| OcrError::Tesseract(e.to_string()))?;

            let (digit, conf) = read_digit(&tess_img, &args)?;
            let accept = digit > 0 && conf >= confidence_threshold;
            grid.cells[r as usize][c as usize] = RecognizedCell {
                digit: if accept { digit } else { 0 },
                confidence: Some(if digit > 0 { conf } else { 0.0 }),
            };
        }
    }

    Ok(grid)
}

fn preprocess_tile(tile: &mut GrayImage) {
    // Simple contrast stretch + threshold toward binary.
    let mut min_v = 255u8;
    let mut max_v = 0u8;
    for p in tile.pixels() {
        min_v = min_v.min(p.0[0]);
        max_v = max_v.max(p.0[0]);
    }
    let range = (max_v - min_v).max(1) as f32;
    for p in tile.pixels_mut() {
        let v = ((p.0[0] - min_v) as f32 / range * 255.0) as u8;
        // Invert if background is dark (phone photos vary).
        p.0[0] = v;
    }
    // Otsu-ish fixed midpoint after stretch.
    let mut sum = 0u64;
    let n = (tile.width() * tile.height()) as u64;
    for p in tile.pixels() {
        sum += p.0[0] as u64;
    }
    let mean = (sum / n.max(1)) as u8;
    // If mean is low, image is mostly dark → digits might be light; invert.
    if mean < 127 {
        for p in tile.pixels_mut() {
            p.0[0] = 255 - p.0[0];
        }
    }
    let thresh = 180u8;
    for p in tile.pixels_mut() {
        p.0[0] = if p.0[0] < thresh { 0 } else { 255 };
    }
}

fn ink_ratio(tile: &GrayImage) -> f32 {
    let mut ink = 0u32;
    let mut total = 0u32;
    for p in tile.pixels() {
        total += 1;
        if p.0[0] < 128 {
            ink += 1;
        }
    }
    ink as f32 / total.max(1) as f32
}

fn read_digit(img: &Image, args: &Args) -> Result<(u8, f32), OcrError> {
    // Prefer TSV data for confidence.
    match rusty_tesseract::image_to_data(img, args) {
        Ok(data) => {
            let mut best_digit = 0u8;
            let mut best_conf = -1.0f32;
            for row in &data.data {
                let t = row.text.trim();
                if t.len() == 1 {
                    if let Some(d) = t.chars().next().and_then(|ch| ch.to_digit(10)) {
                        if (1..=9).contains(&d) && row.conf > best_conf {
                            best_conf = row.conf;
                            best_digit = d as u8;
                        }
                    }
                }
            }
            if best_digit > 0 {
                return Ok((best_digit, best_conf.max(0.0)));
            }
        }
        Err(_) => { /* fall through */ }
    }

    let text = rusty_tesseract::image_to_string(img, args)
        .map_err(|e| OcrError::Tesseract(e.to_string()))?;
    let digit = text
        .chars()
        .find_map(|ch| ch.to_digit(10))
        .filter(|&d| (1..=9).contains(&d))
        .map(|d| d as u8)
        .unwrap_or(0);
    let conf = if digit > 0 { 50.0 } else { 0.0 };
    Ok((digit, conf))
}

