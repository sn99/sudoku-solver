//! Native Sudoku OCR using [rusty-tesseract](https://github.com/thomasgruebl/rusty-tesseract).
//!
//! Requires the `tesseract` binary and English traineddata on the host.
//! Browser uses the same cell model via Tesseract.js + grid-line detection in `web/js/app.js`.

use std::collections::HashMap;
use std::path::Path;

use image::imageops::FilterType;
use image::{DynamicImage, GrayImage};
use rusty_tesseract::{Args, Image};
use sudoku_core::{RecognizedCell, RecognizedGrid};
use thiserror::Error;

/// Minimum confidence (0–100) to accept a digit without low-conf highlighting intent.
pub const DEFAULT_CONFIDENCE_THRESHOLD: f32 = 35.0;

const TARGET: u32 = 1080;

#[derive(Debug, Error)]
pub enum OcrError {
    #[error("failed to load image: {0}")]
    Load(#[from] image::ImageError),
    #[error("tesseract error: {0}")]
    Tesseract(String),
    #[error("image too small for a 9×9 grid")]
    TooSmall,
}

pub fn recognize_path(path: impl AsRef<Path>) -> Result<RecognizedGrid, OcrError> {
    let img = image::open(path)?;
    recognize_image(&img)
}

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

    let side = w.min(h);
    let x0 = (w - side) / 2;
    let y0 = (h - side) / 2;
    let inset = (side as f32 * 0.06) as u32;
    let crop_side = side.saturating_sub(inset * 2).max(90);
    let square = image::imageops::crop_imm(&gray, x0 + inset, y0 + inset, crop_side, crop_side)
        .to_image();
    let square = image::imageops::resize(&square, TARGET, TARGET, FilterType::CatmullRom);
    let square = ensure_dark_on_light(square);

    let binary = otsu_binary(&square);
    let (xs, ys) = find_grid_lines(&binary, TARGET as usize);

    let mut grid = RecognizedGrid::empty();

    let args_psm10 = Args {
        lang: "eng".into(),
        config_variables: HashMap::from([
            ("tessedit_char_whitelist".into(), "123456789".into()),
            ("classify_bln_numeric_mode".into(), "1".into()),
        ]),
        dpi: Some(300),
        psm: Some(10),
        oem: Some(3),
    };
    let args_psm8 = Args {
        psm: Some(8),
        ..args_psm10.clone()
    };

    for r in 0..9 {
        for c in 0..9 {
            let x0 = xs[c] as u32;
            let x1 = xs[c + 1] as u32;
            let y0 = ys[r] as u32;
            let y1 = ys[r + 1] as u32;
            let mut tile = crop_cell(&square, x0, y0, x1, y1);
            preprocess_tile(&mut tile);
            let ratio = ink_ratio(&tile);
            if ratio < 0.012 {
                grid.cells[r][c] = RecognizedCell {
                    digit: 0,
                    confidence: Some(100.0),
                };
                continue;
            }
            if ratio > 0.55 {
                grid.cells[r][c] = RecognizedCell {
                    digit: 0,
                    confidence: Some(20.0),
                };
                continue;
            }

            let padded = pad_white(&tile, 16);
            let dyn_img = DynamicImage::ImageLuma8(padded);
            let tess_img = Image::from_dynamic_image(&dyn_img)
                .map_err(|e| OcrError::Tesseract(e.to_string()))?;

            let (mut digit, mut conf) = read_digit(&tess_img, &args_psm10)?;
            if digit == 0 || conf < 55.0 {
                let (d2, c2) = read_digit(&tess_img, &args_psm8)?;
                if d2 > 0 && c2 > conf {
                    digit = d2;
                    conf = c2;
                }
            }

            // Keep low-confidence guesses for editing; only drop near-noise.
            if digit > 0 && conf < 15.0 {
                digit = 0;
            }
            let _ = confidence_threshold; // reserved for CLI display thresholds
            grid.cells[r][c] = RecognizedCell {
                digit,
                confidence: Some(if digit > 0 { conf } else { 0.0 }),
            };
        }
    }

    Ok(grid)
}

fn ensure_dark_on_light(mut img: GrayImage) -> GrayImage {
    let mut sum = 0u64;
    let n = (img.width() * img.height()) as u64;
    for p in img.pixels() {
        sum += p.0[0] as u64;
    }
    if n > 0 && sum / n < 110 {
        for p in img.pixels_mut() {
            p.0[0] = 255 - p.0[0];
        }
    }
    img
}

fn otsu_binary(img: &GrayImage) -> Vec<u8> {
    let mut hist = [0u32; 256];
    for p in img.pixels() {
        hist[p.0[0] as usize] += 1;
    }
    let total = (img.width() * img.height()) as f64;
    let mut sum = 0f64;
    for (t, &h) in hist.iter().enumerate() {
        sum += t as f64 * h as f64;
    }
    let mut sum_b = 0f64;
    let mut w_b = 0f64;
    let mut max_var = 0f64;
    let mut thresh = 128u8;
    for t in 0..256 {
        w_b += hist[t] as f64;
        if w_b == 0.0 {
            continue;
        }
        let w_f = total - w_b;
        if w_f == 0.0 {
            break;
        }
        sum_b += t as f64 * hist[t] as f64;
        let m_b = sum_b / w_b;
        let m_f = (sum - sum_b) / w_f;
        let v = w_b * w_f * (m_b - m_f) * (m_b - m_f);
        if v > max_var {
            max_var = v;
            thresh = t as u8;
        }
    }
    let mut binary = Vec::with_capacity(img.width() as usize * img.height() as usize);
    for p in img.pixels() {
        binary.push(if p.0[0] < thresh { 1 } else { 0 });
    }
    binary
}

fn find_grid_lines(binary: &[u8], size: usize) -> (Vec<usize>, Vec<usize>) {
    let mut row_sum = vec![0f64; size];
    let mut col_sum = vec![0f64; size];
    for y in 0..size {
        for x in 0..size {
            let v = binary[y * size + x] as f64;
            row_sum[y] += v;
            col_sum[x] += v;
        }
    }
    (pick_lines(&col_sum, size), pick_lines(&row_sum, size))
}

fn smooth(arr: &[f64], k: usize) -> Vec<f64> {
    let h = (k - 1) / 2;
    let mut out = vec![0f64; arr.len()];
    for i in 0..arr.len() {
        let mut s = 0f64;
        let mut c = 0f64;
        for j in i.saturating_sub(h)..=(i + h).min(arr.len() - 1) {
            s += arr[j];
            c += 1.0;
        }
        out[i] = s / c;
    }
    out
}

fn pick_lines(proj: &[f64], size: usize) -> Vec<usize> {
    let s = smooth(proj, 7);
    let mean = s.iter().sum::<f64>() / s.len() as f64;
    let mut peaks: Vec<(usize, f64)> = Vec::new();
    for i in 2..s.len().saturating_sub(2) {
        if s[i] > s[i - 1] && s[i] >= s[i + 1] && s[i] > mean * 1.15 {
            peaks.push((i, s[i]));
        }
    }
    peaks.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let min_dist = size as f64 / 18.0;
    let mut chosen: Vec<usize> = Vec::new();
    for (i, _) in peaks {
        if chosen.iter().all(|&c| (c as isize - i as isize).unsigned_abs() as f64 >= min_dist) {
            chosen.push(i);
        }
        if chosen.len() >= 12 {
            break;
        }
    }
    chosen.sort_unstable();
    if chosen.len() >= 10 {
        return best_ten(&chosen, size);
    }
    (0..=9).map(|k| k * (size - 1) / 9).collect()
}

fn best_ten(lines: &[usize], size: usize) -> Vec<usize> {
    if lines.len() == 10 {
        return lines.to_vec();
    }
    let targets: Vec<f64> = (0..=9).map(|k| k as f64 * (size - 1) as f64 / 9.0).collect();
    let mut out = Vec::with_capacity(10);
    for t in targets {
        let mut best = lines[0];
        let mut best_d = f64::MAX;
        for &l in lines {
            let d = (l as f64 - t).abs();
            if d < best_d {
                best_d = d;
                best = l;
            }
        }
        out.push(best);
    }
    out.sort_unstable();
    out.dedup();
    if out.len() == 10 {
        out
    } else {
        (0..=9).map(|k| k * (size - 1) / 9).collect()
    }
}

fn crop_cell(img: &GrayImage, x0: u32, y0: u32, x1: u32, y1: u32) -> GrayImage {
    let w = x1.saturating_sub(x0).max(1);
    let h = y1.saturating_sub(y0).max(1);
    let pad_x = ((w as f32) * 0.18) as u32;
    let pad_y = ((h as f32) * 0.18) as u32;
    let sx = x0 + pad_x;
    let sy = y0 + pad_y;
    let sw = w.saturating_sub(pad_x * 2).max(1);
    let sh = h.saturating_sub(pad_y * 2).max(1);
    image::imageops::crop_imm(img, sx, sy, sw, sh).to_image()
}

fn pad_white(tile: &GrayImage, pad: u32) -> GrayImage {
    let w = tile.width() + pad * 2;
    let h = tile.height() + pad * 2;
    let mut out = GrayImage::from_pixel(w, h, image::Luma([255]));
    image::imageops::replace(&mut out, tile, pad as i64, pad as i64);
    out
}

fn preprocess_tile(tile: &mut GrayImage) {
    let mut min_v = 255u8;
    let mut max_v = 0u8;
    for p in tile.pixels() {
        min_v = min_v.min(p.0[0]);
        max_v = max_v.max(p.0[0]);
    }
    let range = (max_v - min_v).max(1) as f32;
    for p in tile.pixels_mut() {
        p.0[0] = (((p.0[0] - min_v) as f32 / range) * 255.0) as u8;
    }
    let mut sum = 0u64;
    let n = (tile.width() * tile.height()) as u64;
    for p in tile.pixels() {
        sum += p.0[0] as u64;
    }
    if n > 0 && sum / n < 127 {
        for p in tile.pixels_mut() {
            p.0[0] = 255 - p.0[0];
        }
    }
    // Otsu on tile
    let bin = otsu_binary(tile);
    for (p, &b) in tile.pixels_mut().zip(bin.iter()) {
        p.0[0] = if b == 1 { 0 } else { 255 };
    }
}

fn ink_ratio(tile: &GrayImage) -> f32 {
    let mut ink = 0u32;
    let mut total = 0u32;
    let mx = tile.width().saturating_sub(2).max(1);
    let my = tile.height().saturating_sub(2).max(1);
    for y in 1..my {
        for x in 1..mx {
            total += 1;
            if tile.get_pixel(x, y).0[0] < 128 {
                ink += 1;
            }
        }
    }
    ink as f32 / total.max(1) as f32
}

fn read_digit(img: &Image, args: &Args) -> Result<(u8, f32), OcrError> {
    if let Ok(data) = rusty_tesseract::image_to_data(img, args) {
        let mut best_digit = 0u8;
        let mut best_conf = -1.0f32;
        for row in &data.data {
            let t = row.text.trim();
            for ch in t.chars() {
                if let Some(d) = ch.to_digit(10) {
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

    let text = rusty_tesseract::image_to_string(img, args)
        .map_err(|e| OcrError::Tesseract(e.to_string()))?;
    let digit = text
        .chars()
        .find_map(|ch| ch.to_digit(10))
        .filter(|&d| (1..=9).contains(&d))
        .map(|d| d as u8)
        .unwrap_or(0);
    Ok((digit, if digit > 0 { 50.0 } else { 0.0 }))
}
