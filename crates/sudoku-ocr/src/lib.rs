//! Sudoku OCR: adaptive per-cell binarization + multi-pass rusty-tesseract + hole-based corrections.

use std::collections::HashMap;
use std::path::Path;

use image::imageops::FilterType;
use image::{DynamicImage, GrayImage, Luma};
use rusty_tesseract::{Args, Image};
use sudoku_core::{RecognizedCell, RecognizedGrid};
use thiserror::Error;

pub const DEFAULT_CONFIDENCE_THRESHOLD: f32 = 30.0;

const TARGET: u32 = 900;
const CELL_INSET: f32 = 0.14;
const INK_DELTA: u8 = 35;
const INK_ABS_MAX: u8 = 190;
const MIN_INK_RATIO: f32 = 0.008;
const MAX_INK_RATIO: f32 = 0.45;

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
    _confidence_threshold: f32,
) -> Result<RecognizedGrid, OcrError> {
    let gray = img.to_luma8();
    let square = prepare_square(&gray)?;
    let mut grid = RecognizedGrid::empty();

    let base_args = Args {
        lang: "eng".into(),
        config_variables: HashMap::from([
            ("tessedit_char_whitelist".into(), "123456789".into()),
            ("classify_bln_numeric_mode".into(), "1".into()),
        ]),
        dpi: Some(300),
        psm: Some(10),
        oem: Some(3),
    };

    let cell = TARGET / 9;
    for r in 0..9u32 {
        for c in 0..9u32 {
            let tile =
                image::imageops::crop_imm(&square, c * cell, r * cell, cell, cell).to_image();
            let (bin, ink_ratio) = cell_to_binary_digit(&tile);

            if ink_ratio < MIN_INK_RATIO {
                grid.cells[r as usize][c as usize] = RecognizedCell {
                    digit: 0,
                    confidence: Some(100.0),
                };
                continue;
            }
            if ink_ratio > MAX_INK_RATIO {
                grid.cells[r as usize][c as usize] = RecognizedCell {
                    digit: 0,
                    confidence: Some(15.0),
                };
                continue;
            }

            let mut candidates: Vec<(u8, f32)> = Vec::new();
            // Multi-scale + multi-PSM Tesseract
            for &(size, filter, pad) in &[
                (120u32, FilterType::Nearest, 24u32),
            ] {
                let up = image::imageops::resize(&bin, size, size, filter);
                let padded = pad_white(&up, pad);
                let dyn_img = DynamicImage::ImageLuma8(padded);
                let Ok(ti) = Image::from_dynamic_image(&dyn_img) else {
                    continue;
                };
                for psm in [10i64, 8, 13] {
                    let mut args = base_args.clone();
                    args.psm = Some(psm as i32);
                    if let Ok((d, conf)) = read_digit(&ti, &args) {
                        if d > 0 {
                            candidates.push((d, conf));
                        }
                    }
                }
            }

            // Vote: highest confidence wins; tie-break by frequency
            candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let mut digit = candidates.first().map(|c| c.0).unwrap_or(0);
            let mut conf = candidates.first().map(|c| c.1).unwrap_or(0.0);

            // Hole-aware corrections (6/8/9 and false 8s)
            let (holes, hole_yc) = glyph_holes(&bin);
            if digit == 8 && holes < 2 {
                // Open 4 often misread as 8
                if let Some(&(d, c)) = candidates.iter().find(|(d, _)| *d != 8 && *d > 0) {
                    digit = d;
                    conf = c;
                } else if holes == 0 {
                    digit = 4;
                    conf = conf.max(60.0);
                }
            }
            // Hole topology corrections (narrow, to avoid breaking open 4s).
            if holes >= 2 {
                digit = 8;
                conf = conf.max(92.0);
            } else if holes == 1 {
                let yc = hole_yc[0];
                if digit == 0 {
                    digit = if yc < 0.5 { 9 } else { 6 };
                    conf = 92.0;
                } else if digit == 2 && yc < 0.48 {
                    // Common: 9 misread as 2
                    digit = 9;
                    conf = conf.max(95.0);
                } else if digit == 5 && yc > 0.52 {
                    digit = 6;
                    conf = conf.max(95.0);
                } else if (digit == 6 || digit == 9) {
                    digit = if yc < 0.5 { 9 } else { 6 };
                    conf = conf.max(95.0);
                }
            }

            grid.cells[r as usize][c as usize] = RecognizedCell {
                digit,
                confidence: Some(if digit > 0 { conf } else { 0.0 }),
            };
        }
    }

    Ok(grid)
}

fn prepare_square(gray: &GrayImage) -> Result<GrayImage, OcrError> {
    let (w, h) = gray.dimensions();
    if w < 90 || h < 90 {
        return Err(OcrError::TooSmall);
    }
    let (x0, y0, x1, y1) = content_bounds(gray);
    let cropped = image::imageops::crop_imm(
        gray,
        x0,
        y0,
        x1.saturating_sub(x0).max(1),
        y1.saturating_sub(y0).max(1),
    )
    .to_image();
    let (w, h) = cropped.dimensions();
    let side = w.min(h);
    let sx = (w - side) / 2;
    let sy = (h - side) / 2;
    let inset = ((side as f32) * 0.008) as u32;
    let side2 = side.saturating_sub(inset * 2).max(90);
    let square =
        image::imageops::crop_imm(&cropped, sx + inset, sy + inset, side2, side2).to_image();
    Ok(image::imageops::resize(
        &square,
        TARGET,
        TARGET,
        FilterType::CatmullRom,
    ))
}

fn content_bounds(gray: &GrayImage) -> (u32, u32, u32, u32) {
    let (w, h) = gray.dimensions();
    let mut min_x = w;
    let mut min_y = h;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    let mut found = false;
    for y in 0..h {
        for x in 0..w {
            if gray.get_pixel(x, y).0[0] < 248 {
                found = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }
    if !found {
        return (0, 0, w, h);
    }
    (
        min_x.saturating_sub(1),
        min_y.saturating_sub(1),
        (max_x + 2).min(w),
        (max_y + 2).min(h),
    )
}

fn cell_to_binary_digit(tile: &GrayImage) -> (GrayImage, f32) {
    let (w, h) = tile.dimensions();
    let ix = ((w as f32) * CELL_INSET) as u32;
    let iy = ((h as f32) * CELL_INSET) as u32;
    let cw = w.saturating_sub(ix * 2).max(1);
    let ch = h.saturating_sub(iy * 2).max(1);
    let inner = image::imageops::crop_imm(tile, ix, iy, cw, ch).to_image();

    let mut vals: Vec<u8> = inner.pixels().map(|p| p.0[0]).collect();
    vals.sort_unstable();
    let n = vals.len();
    let light = vals[n * 90 / 100].max(vals[n / 2]);
    let thr = light.saturating_sub(INK_DELTA).min(INK_ABS_MAX);

    let mut ink = 0u32;
    let mut total = 0u32;
    let mut out = GrayImage::new(cw, ch);
    for (x, y, p) in inner.enumerate_pixels() {
        total += 1;
        if p.0[0] < thr {
            ink += 1;
            out.put_pixel(x, y, Luma([0]));
        } else {
            out.put_pixel(x, y, Luma([255]));
        }
    }
    (out, ink as f32 / total.max(1) as f32)
}

fn pad_white(tile: &GrayImage, pad: u32) -> GrayImage {
    let mut out =
        GrayImage::from_pixel(tile.width() + pad * 2, tile.height() + pad * 2, Luma([255]));
    image::imageops::replace(&mut out, tile, pad as i64, pad as i64);
    out
}

fn ink_bbox(bin: &GrayImage) -> Option<(u32, u32, u32, u32)> {
    let (w, h) = bin.dimensions();
    let mut min_x = w;
    let mut min_y = h;
    let mut max_x = 0u32;
    let mut max_y = 0u32;
    let mut any = false;
    for y in 0..h {
        for x in 0..w {
            if bin.get_pixel(x, y).0[0] < 128 {
                any = true;
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
    }
    any.then_some((min_x, min_y, max_x, max_y))
}

/// Returns (hole_count, hole_centroid_y as fraction of glyph height).
fn glyph_holes(bin: &GrayImage) -> (usize, Vec<f32>) {
    let Some((x0, y0, x1, y1)) = ink_bbox(bin) else {
        return (0, vec![]);
    };
    let cw = (x1 - x0 + 1).max(1);
    let ch = (y1 - y0 + 1).max(1);
    // Normalize to fixed size for stable hole topology
    let crop = image::imageops::crop_imm(bin, x0, y0, cw, ch).to_image();
    let nw = 32usize;
    let nh = 40usize;
    let resized = image::imageops::resize(&crop, nw as u32, nh as u32, FilterType::Nearest);
    let ink: Vec<u8> = resized
        .pixels()
        .map(|p| if p.0[0] < 128 { 1 } else { 0 })
        .collect();
    analyze_holes(&ink, nw, nh)
}

fn analyze_holes(ink: &[u8], w: usize, h: usize) -> (usize, Vec<f32>) {
    let mut vis = vec![false; w * h];
    let mut q = Vec::new();
    for x in 0..w {
        for y in [0, h - 1] {
            if ink[y * w + x] == 0 && !vis[y * w + x] {
                vis[y * w + x] = true;
                q.push((x, y));
            }
        }
    }
    for y in 0..h {
        for x in [0, w - 1] {
            if ink[y * w + x] == 0 && !vis[y * w + x] {
                vis[y * w + x] = true;
                q.push((x, y));
            }
        }
    }
    let mut qi = 0;
    while qi < q.len() {
        let (x, y) = q[qi];
        qi += 1;
        for (nx, ny) in [
            (x.wrapping_sub(1), y),
            (x + 1, y),
            (x, y.wrapping_sub(1)),
            (x, y + 1),
        ] {
            if nx < w && ny < h && ink[ny * w + nx] == 0 && !vis[ny * w + nx] {
                vis[ny * w + nx] = true;
                q.push((nx, ny));
            }
        }
    }
    let mut hole_yc = Vec::new();
    for y in 0..h {
        for x in 0..w {
            let i = y * w + x;
            if ink[i] != 0 || vis[i] {
                continue;
            }
            let mut sy = 0u32;
            let mut n = 0u32;
            let mut qq = vec![(x, y)];
            vis[i] = true;
            let mut qj = 0;
            while qj < qq.len() {
                let (cx, cy) = qq[qj];
                qj += 1;
                sy += cy as u32;
                n += 1;
                for (nx, ny) in [
                    (cx.wrapping_sub(1), cy),
                    (cx + 1, cy),
                    (cx, cy.wrapping_sub(1)),
                    (cx, cy + 1),
                ] {
                    if nx < w && ny < h {
                        let j = ny * w + nx;
                        if ink[j] == 0 && !vis[j] {
                            vis[j] = true;
                            qq.push((nx, ny));
                        }
                    }
                }
            }
            // ignore speckles
            if n >= 4 {
                hole_yc.push(sy as f32 / n as f32 / h as f32);
            }
        }
    }
    (hole_yc.len(), hole_yc)
}

fn read_digit(img: &Image, args: &Args) -> Result<(u8, f32), OcrError> {
    if let Ok(data) = rusty_tesseract::image_to_data(img, args) {
        let mut best_digit = 0u8;
        let mut best_conf = -1.0f32;
        for row in &data.data {
            for ch in row.text.chars() {
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

pub fn recognize_digits(path: impl AsRef<Path>) -> Result<[[u8; 9]; 9], OcrError> {
    let g = recognize_path(path)?;
    let mut out = [[0u8; 9]; 9];
    for r in 0..9 {
        for c in 0..9 {
            out[r][c] = g.cells[r][c].digit;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/pasted-puzzle.png")
    }

    const EXPECTED: [[u8; 9]; 9] = [
        [0, 6, 0, 3, 0, 0, 4, 1, 0],
        [1, 8, 5, 0, 2, 0, 7, 0, 3],
        [0, 0, 0, 5, 0, 0, 9, 2, 8],
        [0, 9, 6, 8, 0, 2, 0, 5, 7],
        [2, 1, 0, 0, 4, 0, 3, 0, 0],
        [0, 5, 0, 0, 0, 6, 0, 8, 4],
        [5, 0, 0, 0, 0, 4, 6, 0, 0],
        [0, 0, 0, 6, 1, 3, 5, 4, 0],
        [0, 0, 9, 0, 0, 7, 0, 0, 0],
    ];

    #[test]
    fn recognizes_pasted_puzzle_perfectly() {
        let path = fixture();
        assert!(path.exists(), "missing {}", path.display());
        let got = recognize_digits(&path).expect("ocr");
        if got != EXPECTED {
            let mut mismatches = 0;
            for r in 0..9 {
                for c in 0..9 {
                    if got[r][c] != EXPECTED[r][c] {
                        mismatches += 1;
                        eprintln!("({r},{c}): expected {} got {}", EXPECTED[r][c], got[r][c]);
                    }
                }
            }
            eprintln!("got:");
            for row in &got {
                eprintln!("{:?}", row);
            }
            panic!("{mismatches} cells wrong");
        }
    }
}
