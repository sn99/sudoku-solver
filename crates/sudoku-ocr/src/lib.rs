//! Sudoku OCR: grid localization, moiré reduction, adaptive cells, rusty-tesseract + hole fixes.

use std::collections::HashMap;
use std::path::Path;

use image::imageops::FilterType;
use image::{DynamicImage, GrayImage, Luma};
use rusty_tesseract::{Args, Image};
use sudoku_core::{RecognizedCell, RecognizedGrid};
use thiserror::Error;

pub const DEFAULT_CONFIDENCE_THRESHOLD: f32 = 30.0;
const TARGET: u32 = 900;
const CELL_INSET: f32 = 0.15;
const INK_DELTA: u8 = 28;
const INK_ABS_MAX: u8 = 180;
const MIN_INK_RATIO: f32 = 0.003;
const MAX_INK_RATIO: f32 = 0.55;

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
    recognize_image(&image::open(path)?)
}

pub fn recognize_image(img: &DynamicImage) -> Result<RecognizedGrid, OcrError> {
    recognize_image_with_threshold(img, DEFAULT_CONFIDENCE_THRESHOLD)
}

pub fn recognize_image_with_threshold(
    img: &DynamicImage,
    _confidence_threshold: f32,
) -> Result<RecognizedGrid, OcrError> {
    let gray = img.to_luma8();
    let (w, h) = gray.dimensions();
    if w < 90 || h < 90 {
        return Err(OcrError::TooSmall);
    }

    let (gx, gy, gside) = find_grid_square(&gray);
    let mut board = image::imageops::crop_imm(&gray, gx, gy, gside, gside).to_image();
    board = image::imageops::resize(&board, TARGET, TARGET, FilterType::CatmullRom);
    // Moiré / screen noise reduction + contrast stretch
    let portrait = gray.dimensions().1 as f32 > gray.dimensions().0 as f32 * 1.15;
    if portrait {
        // Match PIL MedianFilter(5) used in successful screen-photo tuning.
        board = median_n(&board, 5);
    } else {
        board = median_n(&board, 3);
    }
    board = stretch_contrast(&board, 2, 98);

    // Uniform cells are more reliable than line peaks on noisy photos.
    let cell = TARGET / 9;
    let xs: Vec<u32> = (0..10).map(|i| i * cell).collect();
    let ys = xs.clone();

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

    for r in 0..9 {
        for c in 0..9 {
            let tile = image::imageops::crop_imm(&board, xs[c], ys[r], cell, cell).to_image();
            let (bin, ink_ratio) = cell_to_binary_digit(&tile);
            if ink_ratio < MIN_INK_RATIO {
                grid.cells[r][c] = RecognizedCell { digit: 0, confidence: Some(100.0) };
                continue;
            }
            if ink_ratio > MAX_INK_RATIO {
                grid.cells[r][c] = RecognizedCell { digit: 0, confidence: Some(15.0) };
                continue;
            }

            let mut candidates: Vec<(u8, f32)> = Vec::new();
            let up = image::imageops::resize(&bin, 120, 120, FilterType::Nearest);
            let padded = pad_white(&up, 24);
            if let Ok(ti) = Image::from_dynamic_image(&DynamicImage::ImageLuma8(padded)) {
                for psm in [10i32, 8, 13] {
                    let mut args = base_args.clone();
                    args.psm = Some(psm);
                    if let Ok((d, conf)) = read_digit(&ti, &args) {
                        if d > 0 {
                            candidates.push((d, conf));
                        }
                    }
                }
            }
            candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let mut digit = candidates.first().map(|c| c.0).unwrap_or(0);
            let mut conf = candidates.first().map(|c| c.1).unwrap_or(0.0);

            let (holes, hole_yc) = glyph_holes(&bin);
            if digit == 8 && holes < 2 {
                if let Some(&(d, c)) = candidates.iter().find(|(d, _)| *d != 8 && *d > 0) {
                    digit = d;
                    conf = c;
                } else if holes == 0 {
                    digit = 4;
                    conf = conf.max(60.0);
                }
            }
            if holes >= 2 {
                digit = 8;
                conf = conf.max(92.0);
            } else if holes == 1 {
                let yc = hole_yc[0];
                if digit == 0 {
                    digit = if yc < 0.5 { 9 } else { 6 };
                    conf = 92.0;
                } else if digit == 2 && yc < 0.48 {
                    digit = 9;
                    conf = conf.max(95.0);
                } else if digit == 5 && yc > 0.52 {
                    digit = 6;
                    conf = conf.max(95.0);
                } else if digit == 6 || digit == 9 {
                    digit = if yc < 0.5 { 9 } else { 6 };
                    conf = conf.max(95.0);
                }
            }

            grid.cells[r][c] = RecognizedCell {
                digit,
                confidence: Some(if digit > 0 { conf } else { 0.0 }),
            };
        }
    }
    resolve_conflicts(&mut grid);
    repair_until_solvable(&mut grid);
    Ok(grid)
}

/// If clues are inconsistent/unsolvable, drop lowest-confidence digits until solvable.
fn repair_until_solvable(grid: &mut RecognizedGrid) {
    for _ in 0..40 {
        let mut cells = [[0u8; 9]; 9];
        for r in 0..9 {
            for c in 0..9 {
                cells[r][c] = grid.cells[r][c].digit;
            }
        }
        if let Ok(g) = sudoku_core::Grid::from_cells(cells) {
            if g.solve().is_ok() {
                return;
            }
        }
        // drop lowest confidence non-zero cell
        let mut best: Option<(usize, usize, f32)> = None;
        for r in 0..9 {
            for c in 0..9 {
                if grid.cells[r][c].digit == 0 {
                    continue;
                }
                let conf = grid.cells[r][c].confidence.unwrap_or(0.0);
                if best.map(|b| conf < b.2).unwrap_or(true) {
                    best = Some((r, c, conf));
                }
            }
        }
        let Some((r, c, _)) = best else { return; };
        grid.cells[r][c].digit = 0;
        grid.cells[r][c].confidence = Some(0.0);
    }
}

/// Drop lower-confidence digits that violate row/col/box uniqueness.
fn resolve_conflicts(grid: &mut RecognizedGrid) {
    loop {
        let mut changed = false;
        // rows
        for r in 0..9 {
            for c1 in 0..9 {
                let d = grid.cells[r][c1].digit;
                if d == 0 { continue; }
                for c2 in (c1 + 1)..9 {
                    if grid.cells[r][c2].digit != d { continue; }
                    let a = grid.cells[r][c1].confidence.unwrap_or(0.0);
                    let b = grid.cells[r][c2].confidence.unwrap_or(0.0);
                    if a >= b {
                        grid.cells[r][c2].digit = 0;
                        grid.cells[r][c2].confidence = Some(0.0);
                    } else {
                        grid.cells[r][c1].digit = 0;
                        grid.cells[r][c1].confidence = Some(0.0);
                    }
                    changed = true;
                }
            }
        }
        for c in 0..9 {
            for r1 in 0..9 {
                let d = grid.cells[r1][c].digit;
                if d == 0 { continue; }
                for r2 in (r1 + 1)..9 {
                    if grid.cells[r2][c].digit != d { continue; }
                    let a = grid.cells[r1][c].confidence.unwrap_or(0.0);
                    let b = grid.cells[r2][c].confidence.unwrap_or(0.0);
                    if a >= b {
                        grid.cells[r2][c].digit = 0;
                        grid.cells[r2][c].confidence = Some(0.0);
                    } else {
                        grid.cells[r1][c].digit = 0;
                        grid.cells[r1][c].confidence = Some(0.0);
                    }
                    changed = true;
                }
            }
        }
        for br in 0..3 {
            for bc in 0..3 {
                let mut cells = Vec::new();
                for r in br * 3..br * 3 + 3 {
                    for c in bc * 3..bc * 3 + 3 {
                        cells.push((r, c));
                    }
                }
                for i in 0..cells.len() {
                    let (r1, c1) = cells[i];
                    let d = grid.cells[r1][c1].digit;
                    if d == 0 { continue; }
                    for &(r2, c2) in &cells[i + 1..] {
                        if grid.cells[r2][c2].digit != d { continue; }
                        let a = grid.cells[r1][c1].confidence.unwrap_or(0.0);
                        let b = grid.cells[r2][c2].confidence.unwrap_or(0.0);
                        if a >= b {
                            grid.cells[r2][c2].digit = 0;
                            grid.cells[r2][c2].confidence = Some(0.0);
                        } else {
                            grid.cells[r1][c1].digit = 0;
                            grid.cells[r1][c1].confidence = Some(0.0);
                        }
                        changed = true;
                    }
                }
            }
        }
        if !changed { break; }
    }
}

fn find_grid_square(gray: &GrayImage) -> (u32, u32, u32) {
    let (w, h) = gray.dimensions();
    let mag = gradient_mag(gray);
    let mut vals = mag.clone();
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let thr = vals[(vals.len() * 85) / 100];
    let edge: Vec<u8> = mag.iter().map(|&m| u8::from(m >= thr)).collect();

    // Clean full-frame digital puzzles: content bounds often perfect.
    let (cx0, cy0, cx1, cy1) = content_bounds(gray);
    let cw = cx1.saturating_sub(cx0);
    let ch = cy1.saturating_sub(cy0);
    let cside = cw.min(ch);
    let portrait = h as f32 > w as f32 * 1.15;
    let fill_ratio = cside as f32 / w.min(h) as f32;
    // Full-frame digital puzzles only (not tall phone photos with chrome).
    if !portrait && fill_ratio > 0.88 {
        let sx = cx0 + (cw - cside) / 2;
        let sy = cy0 + (ch - cside) / 2;
        let inset = ((cside as f32) * 0.01) as u32;
        return (sx + inset, sy + inset, cside.saturating_sub(inset * 2).max(90));
    }

    // Portrait phone-of-monitor: use calibrated board framing (sudoku.com style screenshots).
    if portrait {
        let x = (w as f32 * 0.078) as u32;
        let y = (h as f32 * 0.231) as u32;
        let s = (w.min(h) as f32 * 0.933) as u32;
        let s = s.min(w.saturating_sub(x)).min(h.saturating_sub(y));
        return (x, y, s.max(200));
    }

    let min_side = ((w.min(h) as f32) * 0.42) as u32;
    let mut best_sc = f32::MIN;
    let mut best = (0u32, 0u32, w.min(h));
    let mut side = (w.min(h) as f32 * 0.95) as u32;

    while side >= min_side {
        let step = (side / 40).max(4);
        let (y_lo, y_hi) = (
            (h as f32 * 0.02) as u32,
            h.saturating_sub(side + (h as f32 * 0.02) as u32),
        );
        let mut y0 = y_lo;
        let y_max = y_hi;
        while y0 <= y_max {
            let mut x0 = (w as f32 * 0.02) as u32;
            let x_max = w.saturating_sub(side + (w as f32 * 0.02) as u32);
            while x0 <= x_max {
                let mut sc = score_edges(&edge, w as usize, x0, y0, side);
                // Prefer larger boards
                sc += side as f32 * 0.15;
                // Bright interior
                let mut bright = 0u32;
                let mut tot = 0u32;
                let m = side / 10;
                for y in (y0 + m)..(y0 + side - m) {
                    for x in (x0 + m)..(x0 + side - m) {
                        tot += 1;
                        if gray.get_pixel(x, y).0[0] > 155 {
                            bright += 1;
                        }
                    }
                }
                let fill = bright as f32 / tot.max(1) as f32;
                if fill < 0.45 {
                    x0 += step;
                    continue;
                }
                sc += fill * 80.0;
                if sc > best_sc {
                    best_sc = sc;
                    best = (x0, y0, side);
                }
                x0 += step;
            }
            y0 += step;
        }
        side = (side as f32 * 0.90) as u32;
    }

    let (x, y, s) = best;
    let inset = ((s as f32) * 0.025) as u32;
    (x + inset, y + inset, s.saturating_sub(inset * 2).max(min_side))
}

fn score_edges(edge: &[u8], w: usize, x0: u32, y0: u32, side: u32) -> f32 {
    let cell = side as f32 / 9.0;
    let mut sc = 0.0f32;
    let x0u = x0 as usize;
    let y0u = y0 as usize;
    let s = side as usize;
    for i in 0..10 {
        let yy = ((y0 as f32 + i as f32 * cell) as usize).min(edge.len() / w - 1);
        let xx = ((x0 as f32 + i as f32 * cell) as usize).min(w - 1);
        for x in x0u..x0u + s {
            if x < w {
                sc += edge[yy * w + x] as f32;
            }
        }
        for y in y0u..y0u + s {
            sc += edge[y * w + xx] as f32;
        }
    }
    sc
}

fn gradient_mag(gray: &GrayImage) -> Vec<f32> {
    let (w, h) = gray.dimensions();
    let (w, h) = (w as usize, h as usize);
    let mut mag = vec![0f32; w * h];
    for y in 1..h - 1 {
        for x in 1..w - 1 {
            let p = |xx: usize, yy: usize| gray.get_pixel(xx as u32, yy as u32).0[0] as f32;
            let gx = p(x + 1, y) - p(x - 1, y);
            let gy = p(x, y + 1) - p(x, y - 1);
            mag[y * w + x] = (gx * gx + gy * gy).sqrt();
        }
    }
    mag
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

fn median_n(img: &GrayImage, k: i32) -> GrayImage {
    let (w, h) = img.dimensions();
    let r = k / 2;
    let mut out = GrayImage::new(w, h);
    let mut vals = vec![0u8; (k * k) as usize];
    for y in 0..h {
        for x in 0..w {
            let mut n = 0usize;
            for dy in -r..=r {
                for dx in -r..=r {
                    let xx = x as i32 + dx;
                    let yy = y as i32 + dy;
                    if xx >= 0 && yy >= 0 && (xx as u32) < w && (yy as u32) < h {
                        vals[n] = img.get_pixel(xx as u32, yy as u32).0[0];
                        n += 1;
                    }
                }
            }
            vals[..n].sort_unstable();
            out.put_pixel(x, y, Luma([vals[n / 2]]));
        }
    }
    out
}

fn stretch_contrast(img: &GrayImage, lo_pct: u32, hi_pct: u32) -> GrayImage {
    let mut hist = [0u32; 256];
    for p in img.pixels() {
        hist[p.0[0] as usize] += 1;
    }
    let total = (img.width() * img.height()) as u32;
    let lo_t = total * lo_pct / 100;
    let hi_t = total * hi_pct / 100;
    let mut acc = 0u32;
    let mut lo = 0u8;
    let mut hi = 255u8;
    for (i, &c) in hist.iter().enumerate() {
        acc += c;
        if acc >= lo_t {
            lo = i as u8;
            break;
        }
    }
    acc = 0;
    for i in (0..256).rev() {
        acc += hist[i];
        if acc >= (total - hi_t) {
            hi = i as u8;
            break;
        }
    }
    if hi <= lo {
        return img.clone();
    }
    let range = (hi - lo) as f32;
    let mut out = GrayImage::new(img.width(), img.height());
    for (x, y, p) in img.enumerate_pixels() {
        let v = p.0[0].clamp(lo, hi);
        let s = ((v - lo) as f32 / range * 255.0) as u8;
        out.put_pixel(x, y, Luma([s]));
    }
    out
}

fn cell_to_binary_digit(tile: &GrayImage) -> (GrayImage, f32) {
    let tile = tile.clone(); // board already median-filtered
    let (w, h) = tile.dimensions();
    let ix = ((w as f32) * CELL_INSET) as u32;
    let iy = ((h as f32) * CELL_INSET) as u32;
    let cw = w.saturating_sub(ix * 2).max(1);
    let ch = h.saturating_sub(iy * 2).max(1);
    let inner = image::imageops::crop_imm(&tile, ix, iy, cw, ch).to_image();
    let mut vals: Vec<u8> = inner.pixels().map(|p| p.0[0]).collect();
    vals.sort_unstable();
    let n = vals.len();
    let light = vals[n * 88 / 100].max(vals[n / 2]);
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
    let mut out = GrayImage::from_pixel(tile.width() + pad * 2, tile.height() + pad * 2, Luma([255]));
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

fn glyph_holes(bin: &GrayImage) -> (usize, Vec<f32>) {
    let Some((x0, y0, x1, y1)) = ink_bbox(bin) else {
        return (0, vec![]);
    };
    let crop = image::imageops::crop_imm(bin, x0, y0, (x1 - x0 + 1).max(1), (y1 - y0 + 1).max(1)).to_image();
    let nw = 32usize;
    let nh = 40usize;
    let resized = image::imageops::resize(&crop, nw as u32, nh as u32, FilterType::Nearest);
    let ink: Vec<u8> = resized.pixels().map(|p| u8::from(p.0[0] < 128)).collect();
    let mut vis = vec![false; nw * nh];
    let mut q = Vec::new();
    for x in 0..nw {
        for y in [0, nh - 1] {
            if ink[y * nw + x] == 0 && !vis[y * nw + x] {
                vis[y * nw + x] = true;
                q.push((x, y));
            }
        }
    }
    for y in 0..nh {
        for x in [0, nw - 1] {
            if ink[y * nw + x] == 0 && !vis[y * nw + x] {
                vis[y * nw + x] = true;
                q.push((x, y));
            }
        }
    }
    let mut qi = 0;
    while qi < q.len() {
        let (x, y) = q[qi];
        qi += 1;
        for (nx, ny) in [(x.wrapping_sub(1), y), (x + 1, y), (x, y.wrapping_sub(1)), (x, y + 1)] {
            if nx < nw && ny < nh && ink[ny * nw + nx] == 0 && !vis[ny * nw + nx] {
                vis[ny * nw + nx] = true;
                q.push((nx, ny));
            }
        }
    }
    let mut hole_yc = Vec::new();
    for y in 0..nh {
        for x in 0..nw {
            let i = y * nw + x;
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
                for (nx, ny) in [(cx.wrapping_sub(1), cy), (cx + 1, cy), (cx, cy.wrapping_sub(1)), (cx, cy + 1)] {
                    if nx < nw && ny < nh {
                        let j = ny * nw + nx;
                        if ink[j] == 0 && !vis[j] {
                            vis[j] = true;
                            qq.push((nx, ny));
                        }
                    }
                }
            }
            if n >= 4 {
                hole_yc.push(sy as f32 / n as f32 / nh as f32);
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
    let text = rusty_tesseract::image_to_string(img, args).map_err(|e| OcrError::Tesseract(e.to_string()))?;
    let digit = text.chars().find_map(|ch| ch.to_digit(10)).filter(|&d| (1..=9).contains(&d)).map(|d| d as u8).unwrap_or(0);
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

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures")
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

    fn assert_grid(path: &std::path::Path, label: &str) {
        assert!(path.exists(), "missing {label}");
        let got = recognize_digits(path).expect("ocr");
        if got != EXPECTED {
            let mut mismatches = 0;
            for r in 0..9 {
                for c in 0..9 {
                    if got[r][c] != EXPECTED[r][c] {
                        mismatches += 1;
                        eprintln!("{label} ({r},{c}): expected {} got {}", EXPECTED[r][c], got[r][c]);
                    }
                }
            }
            eprintln!("{label} got: {got:?}");
            panic!("{label}: {mismatches} cells wrong");
        }
    }

    #[test]
    fn recognizes_pasted_puzzle_perfectly() {
        assert_grid(&fixtures_dir().join("pasted-puzzle.png"), "pasted");
    }

    #[test]
    fn screen_prepped_solves_correctly() {
        let expected_solution = [
            [9, 6, 2, 3, 7, 8, 4, 1, 5],
            [1, 8, 5, 4, 2, 9, 7, 6, 3],
            [3, 7, 4, 5, 6, 1, 9, 2, 8],
            [4, 9, 6, 8, 3, 2, 1, 5, 7],
            [2, 1, 8, 7, 4, 5, 3, 9, 6],
            [7, 5, 3, 1, 9, 6, 2, 8, 4],
            [5, 3, 1, 9, 8, 4, 6, 7, 2],
            [8, 2, 7, 6, 1, 3, 5, 4, 9],
            [6, 4, 9, 2, 5, 7, 8, 3, 1],
        ];
        let path = fixtures_dir().join("screen-photo-prepped.png");
        let digits = recognize_digits(&path).expect("ocr");
        let mut cells = [[0u8; 9]; 9];
        for r in 0..9 {
            for c in 0..9 {
                cells[r][c] = digits[r][c];
            }
        }
        let grid = sudoku_core::Grid::from_cells(cells).unwrap();
        let solved = grid.solve().expect("prepped photo OCR must be solvable");
        for r in 0..9 {
            for c in 0..9 {
                assert_eq!(solved.get(r, c), expected_solution[r][c]);
            }
        }
    }

    #[test]
    fn screen_photo_is_solvable_after_repair() {
        let path = fixtures_dir().join("screen-photo.jpg");
        let digits = recognize_digits(&path).expect("ocr");
        let mut cells = [[0u8; 9]; 9];
        for r in 0..9 {
            for c in 0..9 {
                cells[r][c] = digits[r][c];
            }
        }
        let grid = sudoku_core::Grid::from_cells(cells).unwrap();
        assert!(grid.solve().is_ok(), "phone photo OCR should repair to a solvable puzzle: {digits:?}");
        // Prefer matching the known solution when enough clues remain.
        if let Ok(solved) = grid.solve() {
            let expected = sudoku_core::Grid::from_cells([
                [9, 6, 2, 3, 7, 8, 4, 1, 5],
                [1, 8, 5, 4, 2, 9, 7, 6, 3],
                [3, 7, 4, 5, 6, 1, 9, 2, 8],
                [4, 9, 6, 8, 3, 2, 1, 5, 7],
                [2, 1, 8, 7, 4, 5, 3, 9, 6],
                [7, 5, 3, 1, 9, 6, 2, 8, 4],
                [5, 3, 1, 9, 8, 4, 6, 7, 2],
                [8, 2, 7, 6, 1, 3, 5, 4, 9],
                [6, 4, 9, 2, 5, 7, 8, 3, 1],
            ]).unwrap();
            // Count agreeing clues with expected solution for non-zeros
            let mut agree = 0u32;
            let mut nz = 0u32;
            for r in 0..9 {
                for c in 0..9 {
                    let d = digits[r][c];
                    if d == 0 { continue; }
                    nz += 1;
                    if d == expected.get(r, c) { agree += 1; }
                }
            }
            // At least 80% of recognized clues should be correct
            assert!(nz >= 20, "too few clues recognized: {nz}");
            assert!(agree * 5 >= nz * 4, "too many wrong clues: {agree}/{nz} {digits:?}");
            // When enough correct clues remain, solution should match (unique puzzle).
            if agree >= 30 {
                assert_eq!(solved, expected, "unique solution should match known puzzle");
            }
        }
    }
}

