//! Sudoku OCR inspired by OpenCV pipelines (SolveSudoku, SnapSudoku, cv-sudoku-solver,
//! sudoku-extraction): adaptive threshold → largest-contour corners → perspective warp →
//! per-cell largest-feature isolation → rusty-tesseract + topological digit fixes.

use std::collections::HashMap;
use std::path::Path;

use image::imageops::FilterType;
use image::{DynamicImage, GrayImage, Luma};
use rusty_tesseract::{Args, Image};
use sudoku_core::{RecognizedCell, RecognizedGrid};
use thiserror::Error;

pub const DEFAULT_CONFIDENCE_THRESHOLD: f32 = 30.0;
const TARGET: u32 = 900;
const MIN_INK_RATIO: f32 = 0.003;
const MAX_INK_RATIO: f32 = 0.55;
const DIGIT_SIZE: u32 = 48;

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

    let board = extract_board(&gray);
    let board = image::imageops::resize(&board, TARGET, TARGET, FilterType::CatmullRom);
    // Stronger median on screen/moiré photos (high-frequency noise), lighter on clean scans.
    let noisy = estimate_noise(&board) > 12.0;
    let board = median_n(&board, if noisy { 5 } else { 3 });
    let board = stretch_contrast(&board, 2, 98);

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
    for r in 0..9usize {
        for c in 0..9usize {
            let tile = image::imageops::crop_imm(&board, c as u32 * cell, r as u32 * cell, cell, cell).to_image();
            let (digit_img, ink_ratio) = isolate_digit(&tile, DIGIT_SIZE);
            if ink_ratio < MIN_INK_RATIO {
                grid.cells[r][c] = RecognizedCell {
                    digit: 0,
                    confidence: Some(100.0),
                };
                continue;
            }
            if ink_ratio > MAX_INK_RATIO {
                grid.cells[r][c] = RecognizedCell {
                    digit: 0,
                    confidence: Some(15.0),
                };
                continue;
            }

            let mut candidates: Vec<(u8, f32)> = Vec::new();
            let padded = pad_white(&digit_img, 20);
            if let Ok(ti) = Image::from_dynamic_image(&DynamicImage::ImageLuma8(padded)) {
                for psm in [10i32, 8, 13, 7] {
                    let mut args = base_args.clone();
                    args.psm = Some(psm);
                    if let Ok((d, conf)) = read_digit(&ti, &args) {
                        if d > 0 {
                            candidates.push((d, conf));
                        }
                    }
                }
            }
            // Vote: prefer highest confidence, break ties by frequency.
            let mut best: Option<(u8, f32, u32)> = None;
            for &(d, conf) in &candidates {
                let freq = candidates.iter().filter(|(x, _)| *x == d).count() as u32;
                let score = conf + freq as f32 * 8.0;
                if best.map(|(_, s, _)| score > s).unwrap_or(true) {
                    best = Some((d, score, freq));
                }
            }
            let mut digit = best.map(|b| b.0).unwrap_or(0);
            let mut conf = candidates
                .iter()
                .filter(|(d, _)| *d == digit)
                .map(|(_, c)| *c)
                .fold(0.0f32, f32::max);

            let (holes, hole_yc) = glyph_holes(&digit_img);
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
    // Only repair when clues are inconsistent — never invent a different puzzle silently.
    if !grid_is_consistent(&grid) || !grid_is_solvable(&grid) {
        repair_until_solvable(&mut grid);
    }
    Ok(grid)
}

/// Extract a frontal 9×9 board (square GrayImage) from a photo or digital screenshot.
/// Tries several hypotheses (contour warp, edge-scored square, content bounds, portrait prior)
/// and picks the board with the strongest 9×9 grid-line signature — same multi-stage idea as
/// OpenCV solvers that fall back when the largest contour is UI chrome, not the puzzle.
fn extract_board(gray: &GrayImage) -> GrayImage {
    let mut candidates: Vec<GrayImage> = Vec::new();

    let (w, h) = gray.dimensions();

    // Hypothesis 0: projection-peak 9×9 (best for phone screenshots of apps).
    // Prefer this when the peak model is confident — multi-hypothesis scoring otherwise
    // tends to reward UI chrome (titles) with high edge energy.
    if let Some((gx, gy, gs)) = find_grid_by_line_peaks(gray) {
        let cover = (gs as f64 * gs as f64) / ((w as f64) * (h as f64));
        let margin = gx > w / 25 || gy > h / 25
            || gx + gs < w.saturating_sub(w / 25)
            || gy + gs < h.saturating_sub(h / 25);
        // Trust line peaks for embedded boards (phone photo of an app). For an image that
        // is already a tight board crop, fall through to content-bounds / other hypotheses.
        if cover < 0.82 || margin {
            return image::imageops::crop_imm(gray, gx, gy, gs, gs).to_image();
        }
        candidates.push(image::imageops::crop_imm(gray, gx, gy, gs, gs).to_image());
    }
    let max_side = 960u32;
    let scale = if w.max(h) > max_side {
        max_side as f32 / w.max(h) as f32
    } else {
        1.0
    };
    let sw = ((w as f32) * scale).round().max(1.0) as u32;
    let sh = ((h as f32) * scale).round().max(1.0) as u32;
    let small = if scale < 1.0 {
        image::imageops::resize(gray, sw, sh, FilterType::Triangle)
    } else {
        gray.clone()
    };

    // Hypothesis A: perspective warp from largest grid-like blob (SolveSudoku / SnapSudoku).
    if let Some(corners) = detect_grid_corners(&small) {
        let inv = 1.0 / scale;
        let corners_full = [
            (corners[0].0 * inv, corners[0].1 * inv),
            (corners[1].0 * inv, corners[1].1 * inv),
            (corners[2].0 * inv, corners[2].1 * inv),
            (corners[3].0 * inv, corners[3].1 * inv),
        ];
        let side = max_edge_len(&corners_full).round().max(200.0) as u32;
        if let Some(warped) = warp_perspective(gray, &corners_full, side.max(TARGET)) {
            candidates.push(warped);
        }
        // Also try slightly inset corners (outer border vs inner grid).
        let cx = corners_full.iter().map(|p| p.0).sum::<f32>() / 4.0;
        let cy = corners_full.iter().map(|p| p.1).sum::<f32>() / 4.0;
        for inset in [0.04f32, 0.08] {
            let mut c2 = corners_full;
            for p in &mut c2 {
                p.0 += (cx - p.0) * inset;
                p.1 += (cy - p.1) * inset;
            }
            let side = max_edge_len(&c2).round().max(200.0) as u32;
            if let Some(warped) = warp_perspective(gray, &c2, side.max(TARGET)) {
                candidates.push(warped);
            }
        }
    }

    // Hypothesis B: axis-aligned edge-scored square search.
    {
        let (gx, gy, gside) = find_grid_square_fallback(gray);
        candidates.push(image::imageops::crop_imm(gray, gx, gy, gside, gside).to_image());
    }

    // Hypothesis C: content-bounds square (clean digital exports).
    {
        let (cx0, cy0, cx1, cy1) = content_bounds(gray);
        let cw = cx1.saturating_sub(cx0);
        let ch = cy1.saturating_sub(cy0);
        let cside = cw.min(ch).max(90);
        let sx = cx0 + cw.saturating_sub(cside) / 2;
        let sy = cy0 + ch.saturating_sub(cside) / 2;
        let inset = ((cside as f32) * 0.01) as u32;
        let s = cside.saturating_sub(inset * 2).max(90);
        candidates.push(
            image::imageops::crop_imm(gray, sx + inset, sy + inset, s, s).to_image(),
        );
    }

    // Hypothesis D: portrait phone-of-app prior (sudoku.com style screenshots).
    if h as f32 > w as f32 * 1.15 {
        for &(xf, yf, sf) in &[
            // x fraction of width, y fraction of height, side fraction of min(w,h)
            (0.05f32, 0.20f32, 0.90f32),
            (0.06, 0.22, 0.88),
            (0.08, 0.24, 0.84),
            (0.04, 0.18, 0.92),
            (0.07, 0.26, 0.80),
            (0.10, 0.28, 0.78),
        ] {
            let x = (w as f32 * xf) as u32;
            let y = (h as f32 * yf) as u32;
            let s = ((w.min(h) as f32) * sf) as u32;
            let s = s.min(w.saturating_sub(x)).min(h.saturating_sub(y)).max(200);
            candidates.push(image::imageops::crop_imm(gray, x, y, s, s).to_image());
        }
    }

    // Hypothesis E: centered square covering most of the shorter side.
    {
        let s = (w.min(h) as f32 * 0.92) as u32;
        let x = w.saturating_sub(s) / 2;
        let y = h.saturating_sub(s) / 2;
        candidates.push(image::imageops::crop_imm(gray, x, y, s, s).to_image());
    }

    let mut best_sc = f32::MIN;
    let mut best = candidates
        .first()
        .cloned()
        .unwrap_or_else(|| gray.clone());
    for cand in candidates {
        let resized = image::imageops::resize(&cand, TARGET, TARGET, FilterType::Triangle);
        let sc = score_board_grid(&resized);
        if sc > best_sc {
            best_sc = sc;
            best = cand;
        }
    }
    best
}

/// Score how Sudoku-like a board is via 1D projection peaks (10 grid lines) and balance.
fn score_board_grid(board: &GrayImage) -> f32 {
    let (w, h) = board.dimensions();
    if w < 90 || h < 90 {
        return -1.0e9;
    }
    let side = w.min(h) as usize;
    // Dark-pixel projection (ink = low gray).
    let mut row_dark = vec![0f32; side];
    let mut col_dark = vec![0f32; side];
    let mut row_grad = vec![0f32; side];
    let mut col_grad = vec![0f32; side];
    for y in 1..side - 1 {
        for x in 1..side - 1 {
            let v = board.get_pixel(x as u32, y as u32).0[0] as f32;
            let dark = (255.0 - v).max(0.0);
            row_dark[y] += dark;
            col_dark[x] += dark;
            let gx = board.get_pixel((x + 1) as u32, y as u32).0[0] as i16
                - board.get_pixel((x - 1) as u32, y as u32).0[0] as i16;
            let gy = board.get_pixel(x as u32, (y + 1) as u32).0[0] as i16
                - board.get_pixel(x as u32, (y - 1) as u32).0[0] as i16;
            row_grad[y] += gy.unsigned_abs() as f32;
            col_grad[x] += gx.unsigned_abs() as f32;
        }
    }
    // Prefer boards where the 10 equally spaced lines land on gradient peaks.
    let cell = side as f32 / 9.0;
    let mut line_fit = 0.0f32;
    let mut peak_row = 0.0f32;
    let mut peak_col = 0.0f32;
    for i in 0..10 {
        let y = ((i as f32 * cell) as usize).min(side - 1);
        let x = ((i as f32 * cell) as usize).min(side - 1);
        // Local max in a small window around expected line.
        let win = (cell * 0.12).max(2.0) as usize;
        let mut best_r = 0.0f32;
        let mut best_c = 0.0f32;
        for d in 0..=win * 2 {
            let yy = y + d - win;
            let xx = x + d - win;
            if yy < side {
                best_r = best_r.max(row_grad[yy]);
            }
            if xx < side {
                best_c = best_c.max(col_grad[xx]);
            }
        }
        // Also compare to mean gradient — lines should be strong.
        peak_row += best_r;
        peak_col += best_c;
        line_fit += best_r + best_c;
    }
    let mean_rg: f32 = row_grad.iter().sum::<f32>() / side as f32;
    let mean_cg: f32 = col_grad.iter().sum::<f32>() / side as f32;
    // Penalize if edges are much darker than center (cut-off digits / UI chrome).
    let edge_band = (side / 20).max(2);
    let mut edge_dark = 0.0f32;
    let mut mid_dark = 0.0f32;
    let mut edge_n = 0.0f32;
    let mut mid_n = 0.0f32;
    for y in 0..side {
        for x in 0..side {
            let v = 255.0 - board.get_pixel(x as u32, y as u32).0[0] as f32;
            let on_edge = x < edge_band
                || y < edge_band
                || x >= side - edge_band
                || y >= side - edge_band;
            if on_edge {
                edge_dark += v;
                edge_n += 1.0;
            } else if x > side / 4 && x < 3 * side / 4 && y > side / 4 && y < 3 * side / 4 {
                mid_dark += v;
                mid_n += 1.0;
            }
        }
    }
    let edge_r = edge_dark / edge_n.max(1.0);
    let mid_r = mid_dark / mid_n.max(1.0);
    // Cut-off digits make outer band unusually dark.
    let edge_penalty = if edge_r > mid_r * 1.35 { -80.0 } else { 20.0 };

    // UI chrome often has sparse text in top 8% only — penalize strong dark in a thin top strip
    // with bright band below (difficulty selector).
    let top_h = (side as f32 * 0.08) as usize;
    let mut top_dark = 0.0f32;
    let mut below_dark = 0.0f32;
    for y in 0..top_h {
        top_dark += row_dark[y];
    }
    for y in top_h..top_h * 2 {
        below_dark += row_dark[y];
    }
    // Strong penalty for app chrome (titles / difficulty tabs) above the grid.
    let chrome_penalty = if top_h > 0 && top_dark > below_dark * 1.05 {
        -250.0 - (top_dark / (below_dark + 1.0)) * 40.0
    } else {
        30.0
    };
    // Prefer nearly full use of the square by grid lines (outer line near border).
    let border_bonus = {
        let edge = (side / 25).max(2);
        let mut outer = 0.0f32;
        for i in 0..edge {
            outer += row_grad[i] + row_grad[side - 1 - i] + col_grad[i] + col_grad[side - 1 - i];
        }
        let mid = row_grad[side / 2] + col_grad[side / 2];
        if outer / (edge as f32 * 4.0) > mid * 0.8 {
            60.0
        } else {
            -40.0
        }
    };

    let contrast = (peak_row / (mean_rg * 10.0 + 1.0)) + (peak_col / (mean_cg * 10.0 + 1.0));
    // Extra: fraction of top band that looks like text (dark blobs not forming a full-width line).
    let header_penalty = {
        let top_h = ((side as f32) * 0.18) as usize;
        let mut dark_frac = 0.0f32;
        let mut tot = 0.0f32;
        for y in 0..top_h.max(1) {
            for x in 0..side {
                tot += 1.0;
                if board.get_pixel(x as u32, y as u32).0[0] < 120 {
                    dark_frac += 1.0;
                }
            }
        }
        let df = dark_frac / tot.max(1.0);
        // Title text is sparse (~2-8%); full top grid line is a thin strip.
        // Header UI (logo + tabs) often 3-12% dark with uneven distribution.
        if df > 0.025 && df < 0.20 {
            // Check if darkness is concentrated in a few rows (line) vs spread (text)
            let mut row_max = 0.0f32;
            let mut row_sum = 0.0f32;
            for y in 0..top_h.max(1) {
                let mut rd = 0.0f32;
                for x in 0..side {
                    if board.get_pixel(x as u32, y as u32).0[0] < 120 {
                        rd += 1.0;
                    }
                }
                rd /= side as f32;
                row_max = row_max.max(rd);
                row_sum += rd;
            }
            let mean_r = row_sum / top_h.max(1) as f32;
            // Text: many rows moderately dark. Line: one row very dark.
            if row_max < 0.55 && mean_r > 0.02 {
                -400.0
            } else {
                0.0
            }
        } else {
            0.0
        }
    };
    line_fit / (side as f32) + contrast * 40.0 + edge_penalty + chrome_penalty + border_bonus + header_penalty
}

/// Adaptive-threshold → dilate → largest blob → extreme corners (TL, TR, BR, BL).
/// Matches SolveSudoku / PuzzlVision / SnapSudoku style localization.
fn detect_grid_corners(gray: &GrayImage) -> Option<[(f32, f32); 4]> {
    let proc = preprocess_for_contours(gray);
    let (w, h) = proc.dimensions();
    let area_img = (w * h) as f32;

    // Connected components on white (ink/grid) pixels.
    let labels = label_components(&proc);
    let mut best_area = 0u32;
    let mut best_label = 0u32;
    let mut areas: HashMap<u32, u32> = HashMap::new();
    for &lab in &labels {
        if lab == 0 {
            continue;
        }
        *areas.entry(lab).or_insert(0) += 1;
    }
    for (lab, a) in &areas {
        let af = *a as f32;
        if af < area_img * 0.08 || af > area_img * 0.92 {
            continue;
        }
        if *a > best_area {
            best_area = *a;
            best_label = *lab;
        }
    }
    if best_label == 0 {
        return None;
    }

    // Collect pixels of best component and compute extreme corners.
    let mut min_sum = f32::MAX;
    let mut max_sum = f32::MIN;
    let mut min_diff = f32::MAX;
    let mut max_diff = f32::MIN;
    let mut tl = (0f32, 0f32);
    let mut br = (0f32, 0f32);
    let mut tr = (0f32, 0f32);
    let mut bl = (0f32, 0f32);
    let mut min_x = w;
    let mut max_x = 0u32;
    let mut min_y = h;
    let mut max_y = 0u32;
    let mut count = 0u32;

    for y in 0..h {
        for x in 0..w {
            if labels[(y * w + x) as usize] != best_label {
                continue;
            }
            count += 1;
            min_x = min_x.min(x);
            max_x = max_x.max(x);
            min_y = min_y.min(y);
            max_y = max_y.max(y);
            let xf = x as f32;
            let yf = y as f32;
            let s = xf + yf;
            let d = xf - yf;
            if s < min_sum {
                min_sum = s;
                tl = (xf, yf);
            }
            if s > max_sum {
                max_sum = s;
                br = (xf, yf);
            }
            if d > max_diff {
                max_diff = d;
                tr = (xf, yf);
            }
            if d < min_diff {
                min_diff = d;
                bl = (xf, yf);
            }
        }
    }
    if count < 100 {
        return None;
    }

    let bw = (max_x - min_x + 1) as f32;
    let bh = (max_y - min_y + 1) as f32;
    let aspect = bw / bh.max(1.0);
    if !(0.55..=1.85).contains(&aspect) {
        return None;
    }
    // Prefer large, reasonably square boards.
    let fill = (bw * bh) / area_img;
    if fill < 0.08 {
        return None;
    }

    // Nudge corners slightly inward to avoid outer chrome.
    let corners = [tl, tr, br, bl];
    let cx = (tl.0 + tr.0 + br.0 + bl.0) / 4.0;
    let cy = (tl.1 + tr.1 + br.1 + bl.1) / 4.0;
    let inset = 0.012;
    let mut out = [(0f32, 0f32); 4];
    for i in 0..4 {
        out[i] = (
            corners[i].0 + (cx - corners[i].0) * inset,
            corners[i].1 + (cy - corners[i].1) * inset,
        );
    }
    Some(out)
}

/// Gaussian-ish blur + adaptive threshold + invert + cross dilate (SolveSudoku pre_process_image).
fn preprocess_for_contours(gray: &GrayImage) -> GrayImage {
    let blurred = box_blur(gray, 4);
    let mut bin = adaptive_threshold_mean(&blurred, 15, 4);
    // Invert: grid lines become white.
    for p in bin.pixels_mut() {
        p.0[0] = 255 - p.0[0];
    }
    dilate_cross(&bin, 1)
}

fn box_blur(img: &GrayImage, radius: i32) -> GrayImage {
    let (w, h) = img.dimensions();
    let mut tmp = GrayImage::new(w, h);
    let mut out = GrayImage::new(w, h);
    // Horizontal
    for y in 0..h {
        let mut sum = 0u32;
        let mut n = 0u32;
        for x in 0..w.min(radius as u32 + 1) {
            sum += img.get_pixel(x, y).0[0] as u32;
            n += 1;
        }
        for x in 0..w {
            tmp.put_pixel(x, y, Luma([(sum / n) as u8]));
            let add = x as i32 + radius + 1;
            let rem = x as i32 - radius;
            if add < w as i32 {
                sum += img.get_pixel(add as u32, y).0[0] as u32;
                n += 1;
            }
            if rem >= 0 {
                sum -= img.get_pixel(rem as u32, y).0[0] as u32;
                n -= 1;
            }
        }
    }
    // Vertical
    for x in 0..w {
        let mut sum = 0u32;
        let mut n = 0u32;
        for y in 0..h.min(radius as u32 + 1) {
            sum += tmp.get_pixel(x, y).0[0] as u32;
            n += 1;
        }
        for y in 0..h {
            out.put_pixel(x, y, Luma([(sum / n) as u8]));
            let add = y as i32 + radius + 1;
            let rem = y as i32 - radius;
            if add < h as i32 {
                sum += tmp.get_pixel(x, add as u32).0[0] as u32;
                n += 1;
            }
            if rem >= 0 {
                sum -= tmp.get_pixel(x, rem as u32).0[0] as u32;
                n -= 1;
            }
        }
    }
    out
}

fn adaptive_threshold_mean(img: &GrayImage, block: u32, c: i32) -> GrayImage {
    let (w, h) = img.dimensions();
    let r = (block / 2) as i32;
    // Integral image for fast mean.
    let mut integ = vec![0u64; ((w + 1) * (h + 1)) as usize];
    let iw = (w + 1) as usize;
    for y in 0..h as usize {
        let mut row = 0u64;
        for x in 0..w as usize {
            row += img.get_pixel(x as u32, y as u32).0[0] as u64;
            integ[(y + 1) * iw + (x + 1)] = integ[y * iw + (x + 1)] + row;
        }
    }
    let mut out = GrayImage::new(w, h);
    for y in 0..h as i32 {
        for x in 0..w as i32 {
            let x0 = (x - r).max(0) as u32;
            let y0 = (y - r).max(0) as u32;
            let x1 = (x + r + 1).min(w as i32) as u32;
            let y1 = (y + r + 1).min(h as i32) as u32;
            let area = ((x1 - x0) * (y1 - y0)) as i64;
            let sum = integ[(y1 as usize) * iw + x1 as usize]
                + integ[(y0 as usize) * iw + x0 as usize]
                - integ[(y0 as usize) * iw + x1 as usize]
                - integ[(y1 as usize) * iw + x0 as usize];
            let mean = (sum as i64 / area.max(1)) as i32;
            let v = img.get_pixel(x as u32, y as u32).0[0] as i32;
            let thr = (mean - c).clamp(0, 255) as u8;
            out.put_pixel(x as u32, y as u32, Luma([if v > thr as i32 { 255 } else { 0 }]));
        }
    }
    out
}

fn dilate_cross(img: &GrayImage, iters: usize) -> GrayImage {
    let (w, h) = img.dimensions();
    let mut cur = img.clone();
    for _ in 0..iters {
        let mut next = GrayImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let mut m = cur.get_pixel(x, y).0[0];
                if x > 0 {
                    m = m.max(cur.get_pixel(x - 1, y).0[0]);
                }
                if x + 1 < w {
                    m = m.max(cur.get_pixel(x + 1, y).0[0]);
                }
                if y > 0 {
                    m = m.max(cur.get_pixel(x, y - 1).0[0]);
                }
                if y + 1 < h {
                    m = m.max(cur.get_pixel(x, y + 1).0[0]);
                }
                next.put_pixel(x, y, Luma([m]));
            }
        }
        cur = next;
    }
    cur
}

/// 4-connected component labeling; labels[y*w+x], 0 = background (black).
fn label_components(bin: &GrayImage) -> Vec<u32> {
    let (w, h) = bin.dimensions();
    let (w, h) = (w as usize, h as usize);
    let mut labels = vec![0u32; w * h];
    let mut next = 1u32;
    let mut parent: Vec<u32> = vec![0];
    let find = |parent: &mut Vec<u32>, mut a: u32| -> u32 {
        while parent[a as usize] != a {
            parent[a as usize] = parent[parent[a as usize] as usize];
            a = parent[a as usize];
        }
        a
    };
    let union = |parent: &mut Vec<u32>, a: u32, b: u32| {
        let ra = {
            let mut a = a;
            while parent[a as usize] != a {
                parent[a as usize] = parent[parent[a as usize] as usize];
                a = parent[a as usize];
            }
            a
        };
        let rb = {
            let mut b = b;
            while parent[b as usize] != b {
                parent[b as usize] = parent[parent[b as usize] as usize];
                b = parent[b as usize];
            }
            b
        };
        if ra != rb {
            parent[rb as usize] = ra;
        }
    };

    for y in 0..h {
        for x in 0..w {
            if bin.get_pixel(x as u32, y as u32).0[0] < 128 {
                continue;
            }
            let mut neigh = Vec::new();
            if x > 0 && labels[y * w + x - 1] != 0 {
                neigh.push(labels[y * w + x - 1]);
            }
            if y > 0 && labels[(y - 1) * w + x] != 0 {
                neigh.push(labels[(y - 1) * w + x]);
            }
            if neigh.is_empty() {
                parent.push(next);
                labels[y * w + x] = next;
                next += 1;
            } else {
                let m = *neigh.iter().min().unwrap();
                labels[y * w + x] = m;
                for &n in &neigh {
                    if n != m {
                        union(&mut parent, m, n);
                    }
                }
            }
        }
    }
    for lab in labels.iter_mut() {
        if *lab != 0 {
            *lab = find(&mut parent, *lab);
        }
    }
    labels
}

fn max_edge_len(c: &[(f32, f32); 4]) -> f32 {
    let d = |i: usize, j: usize| {
        let dx = c[i].0 - c[j].0;
        let dy = c[i].1 - c[j].1;
        (dx * dx + dy * dy).sqrt()
    };
    d(0, 1).max(d(1, 2)).max(d(2, 3)).max(d(3, 0))
}

/// Warp `src` so corners (TL,TR,BR,BL) map to a square of `side`×`side`.
fn warp_perspective(src: &GrayImage, corners: &[(f32, f32); 4], side: u32) -> Option<GrayImage> {
    let dst = [
        (0.0, 0.0),
        (side as f32 - 1.0, 0.0),
        (side as f32 - 1.0, side as f32 - 1.0),
        (0.0, side as f32 - 1.0),
    ];
    // Homography maps dest → source for inverse sampling.
    let h = compute_homography(&dst, corners)?;
    let (sw, sh) = src.dimensions();
    let mut out = GrayImage::new(side, side);
    for y in 0..side {
        for x in 0..side {
            let (sx, sy) = apply_homography(&h, x as f32, y as f32);
            let v = sample_bilinear(src, sx, sy, sw, sh);
            out.put_pixel(x, y, Luma([v]));
        }
    }
    Some(out)
}

/// 4-point homography (DLT), maps (x,y) in src-space of `from` → `to`.
fn compute_homography(from: &[(f32, f32); 4], to: &[(f32, f32); 4]) -> Option<[f32; 9]> {
    // Solve Ah = b for h (8 dof), h33 = 1.
    // Each point pair contributes 2 equations.
    let mut a = [[0f64; 8]; 8];
    let mut b = [0f64; 8];
    for i in 0..4 {
        let (x, y) = (from[i].0 as f64, from[i].1 as f64);
        let (u, v) = (to[i].0 as f64, to[i].1 as f64);
        let r = i * 2;
        a[r] = [x, y, 1.0, 0.0, 0.0, 0.0, -u * x, -u * y];
        b[r] = u;
        a[r + 1] = [0.0, 0.0, 0.0, x, y, 1.0, -v * x, -v * y];
        b[r + 1] = v;
    }
    let h8 = solve8(&mut a, &mut b)?;
    Some([
        h8[0] as f32,
        h8[1] as f32,
        h8[2] as f32,
        h8[3] as f32,
        h8[4] as f32,
        h8[5] as f32,
        h8[6] as f32,
        h8[7] as f32,
        1.0,
    ])
}

fn solve8(a: &mut [[f64; 8]; 8], b: &mut [f64; 8]) -> Option<[f64; 8]> {
    // Gaussian elimination with partial pivoting.
    for col in 0..8 {
        let mut piv = col;
        for r in col + 1..8 {
            if a[r][col].abs() > a[piv][col].abs() {
                piv = r;
            }
        }
        if a[piv][col].abs() < 1e-12 {
            return None;
        }
        a.swap(col, piv);
        b.swap(col, piv);
        let div = a[col][col];
        for c in col..8 {
            a[col][c] /= div;
        }
        b[col] /= div;
        for r in 0..8 {
            if r == col {
                continue;
            }
            let f = a[r][col];
            for c in col..8 {
                a[r][c] -= f * a[col][c];
            }
            b[r] -= f * b[col];
        }
    }
    let mut x = [0f64; 8];
    x.copy_from_slice(b);
    Some(x)
}

fn apply_homography(h: &[f32; 9], x: f32, y: f32) -> (f32, f32) {
    let den = h[6] * x + h[7] * y + h[8];
    if den.abs() < 1e-8 {
        return (0.0, 0.0);
    }
    (
        (h[0] * x + h[1] * y + h[2]) / den,
        (h[3] * x + h[4] * y + h[5]) / den,
    )
}

fn sample_bilinear(img: &GrayImage, x: f32, y: f32, w: u32, h: u32) -> u8 {
    if x < 0.0 || y < 0.0 || x >= (w as f32 - 1.0) || y >= (h as f32 - 1.0) {
        // Clamp edge
        let xi = x.round().clamp(0.0, (w - 1) as f32) as u32;
        let yi = y.round().clamp(0.0, (h - 1) as f32) as u32;
        return img.get_pixel(xi, yi).0[0];
    }
    let x0 = x.floor() as u32;
    let y0 = y.floor() as u32;
    let x1 = x0 + 1;
    let y1 = y0 + 1;
    let fx = x - x0 as f32;
    let fy = y - y0 as f32;
    let p00 = img.get_pixel(x0, y0).0[0] as f32;
    let p10 = img.get_pixel(x1, y0).0[0] as f32;
    let p01 = img.get_pixel(x0, y1).0[0] as f32;
    let p11 = img.get_pixel(x1, y1).0[0] as f32;
    let v = p00 * (1.0 - fx) * (1.0 - fy)
        + p10 * fx * (1.0 - fy)
        + p01 * (1.0 - fx) * fy
        + p11 * fx * fy;
    v.round().clamp(0.0, 255.0) as u8
}

/// Binarize a cell for Tesseract (inset + adaptive ink threshold). Avoid over-aggressive
/// connected-component cropping on moiré photos — it often eats real strokes.
fn isolate_digit(tile: &GrayImage, size: u32) -> (GrayImage, f32) {
    let (w, h) = tile.dimensions();
    let inset = ((w.min(h) as f32) * 0.15) as u32;
    let iw = w.saturating_sub(inset * 2).max(1);
    let ih = h.saturating_sub(inset * 2).max(1);
    let inner = image::imageops::crop_imm(tile, inset, inset, iw, ih).to_image();

    let mut vals: Vec<u8> = inner.pixels().map(|p| p.0[0]).collect();
    vals.sort_unstable();
    let n = vals.len().max(1);
    let light = vals[n * 88 / 100].max(vals[n / 2]);
    let median = vals[n / 2];
    let p10 = vals[n * 10 / 100];
    // On gray-tinted cells (sudoku.com left column), light-28 is too high — use a gap-based thr.
    let mut thr = light.saturating_sub(28).min(180);
    if median < 200 {
        // Darker paper/UI tint: threshold between dark ink cluster and background.
        thr = ((p10 as u16 + median as u16) / 2).min(170) as u8;
        thr = thr.max(p10.saturating_add(8));
    }
    // Also try a more aggressive thr if ink is sparse with the default.

    let mut bin = GrayImage::from_pixel(iw, ih, Luma([255]));
    let mut ink_count = 0u32;
    for (x, y, p) in inner.enumerate_pixels() {
        if p.0[0] < thr {
            ink_count += 1;
            bin.put_pixel(x, y, Luma([0]));
        }
    }
    let mut ink_ratio = ink_count as f32 / (iw * ih).max(1) as f32;
    if ink_ratio < MIN_INK_RATIO {
        // Retry with a more aggressive threshold (catches faint digits on gray cells).
        let thr2 = thr.saturating_add(18).min(200);
        ink_count = 0;
        bin = GrayImage::from_pixel(iw, ih, Luma([255]));
        for (x, y, p) in inner.enumerate_pixels() {
            if p.0[0] < thr2 {
                ink_count += 1;
                bin.put_pixel(x, y, Luma([0]));
            }
        }
        ink_ratio = ink_count as f32 / (iw * ih).max(1) as f32;
        if ink_ratio < MIN_INK_RATIO {
            return (GrayImage::from_pixel(size, size, Luma([255])), ink_ratio);
        }
    }

    // Optional: drop components that only touch the border (grid-line remnants).
    let mut mask = GrayImage::from_pixel(iw, ih, Luma([0]));
    for (x, y, p) in bin.enumerate_pixels() {
        if p.0[0] < 128 {
            mask.put_pixel(x, y, Luma([255]));
        }
    }
    let labels = label_components(&mask);
    let mut areas: HashMap<u32, u32> = HashMap::new();
    let mut touches_border: HashMap<u32, bool> = HashMap::new();
    let mut touches_center: HashMap<u32, bool> = HashMap::new();
    let mx = (iw as f32 * 0.2) as u32;
    let my = (ih as f32 * 0.2) as u32;
    for y in 0..ih {
        for x in 0..iw {
            let lab = labels[(y * iw + x) as usize];
            if lab == 0 {
                continue;
            }
            *areas.entry(lab).or_insert(0) += 1;
            if x == 0 || y == 0 || x + 1 == iw || y + 1 == ih {
                touches_border.insert(lab, true);
            }
            if x >= mx && x < iw - mx && y >= my && y < ih - my {
                touches_center.insert(lab, true);
            }
        }
    }
    // Remove border-only fragments.
    let mut cleaned = bin.clone();
    for y in 0..ih {
        for x in 0..iw {
            let lab = labels[(y * iw + x) as usize];
            if lab == 0 {
                continue;
            }
            let border = touches_border.get(&lab).copied().unwrap_or(false);
            let center = touches_center.get(&lab).copied().unwrap_or(false);
            if border && !center {
                cleaned.put_pixel(x, y, Luma([255]));
            }
        }
    }
    // Recompute ink after cleaning
    let mut ink2 = 0u32;
    for p in cleaned.pixels() {
        if p.0[0] < 128 {
            ink2 += 1;
        }
    }
    let ink_ratio2 = ink2 as f32 / (iw * ih).max(1) as f32;
    let ink_ratio = if ink_ratio2 >= MIN_INK_RATIO {
        ink_ratio2
    } else {
        ink_ratio
    };
    let use_img = if ink_ratio2 >= MIN_INK_RATIO {
        cleaned
    } else {
        bin
    };

    let up = image::imageops::resize(&use_img, size, size, FilterType::Nearest);
    (up, ink_ratio)
}

fn estimate_noise(img: &GrayImage) -> f32 {
    let (w, h) = img.dimensions();
    let step = (w.max(h) / 100).max(2);
    let mut acc = 0.0f32;
    let mut n = 0.0f32;
    for y in (1..h - 1).step_by(step as usize) {
        for x in (1..w - 1).step_by(step as usize) {
            let v = img.get_pixel(x, y).0[0] as i16;
            let r = img.get_pixel(x + 1, y).0[0] as i16;
            let d = img.get_pixel(x, y + 1).0[0] as i16;
            acc += (v - r).unsigned_abs() as f32 + (v - d).unsigned_abs() as f32;
            n += 2.0;
        }
    }
    acc / n.max(1.0)
}

fn find_grid_by_line_peaks(gray: &GrayImage) -> Option<(u32, u32, u32)> {
    let (w, h) = gray.dimensions();
    let (wu, hu) = (w as usize, h as usize);
    let mut row_grad = vec![0f32; hu];
    let mut col_grad = vec![0f32; wu];
    // Subsample for speed on large photos.
    let step = ((w.max(h) / 800).max(1)) as usize;
    for y in (1..hu - 1).step_by(step) {
        for x in (1..wu - 1).step_by(step) {
            let gy = gray.get_pixel(x as u32, (y + 1) as u32).0[0] as i16
                - gray.get_pixel(x as u32, (y - 1) as u32).0[0] as i16;
            let gx = gray.get_pixel((x + 1) as u32, y as u32).0[0] as i16
                - gray.get_pixel((x - 1) as u32, y as u32).0[0] as i16;
            row_grad[y] += gy.unsigned_abs() as f32;
            col_grad[x] += gx.unsigned_abs() as f32;
        }
    }
    // Smooth projections.
    let smooth = |v: &[f32]| -> Vec<f32> {
        let n = v.len();
        let mut o = vec![0f32; n];
        for i in 0..n {
            let mut s = 0.0;
            let mut c = 0.0;
            for d in -2i32..=2 {
                let j = i as i32 + d;
                if j >= 0 && (j as usize) < n {
                    s += v[j as usize];
                    c += 1.0;
                }
            }
            o[i] = s / c;
        }
        o
    };
    let row_grad = smooth(&row_grad);
    let col_grad = smooth(&col_grad);

    let min_cell = ((w.min(h) as f32) * 0.06) as i32;
    let max_cell = ((w.min(h) as f32) * 0.14) as i32;
    let mut best_sc = 0.0f32;
    let mut best: Option<(u32, u32, u32)> = None;

    let score_lines = |proj: &[f32], start: i32, cell: i32| -> f32 {
        let n = proj.len() as i32;
        let mut sc = 0.0f32;
        let mean: f32 = proj.iter().sum::<f32>() / proj.len().max(1) as f32;
        for i in 0..10 {
            let y = start + i * cell;
            if y < 2 || y + 2 >= n {
                return -1.0;
            }
            // Peak in small window
            let mut peak = 0.0f32;
            for d in -2..=2 {
                let yy = (y + d) as usize;
                if yy < proj.len() {
                    peak = peak.max(proj[yy]);
                }
            }
            // Prefer sharp peaks well above mean
            sc += (peak - mean * 1.2).max(0.0);
        }
        // Prefer consistency: variance of peak strengths should not be huge — use min peak
        let mut min_peak = f32::MAX;
        for i in 0..10 {
            let y = start + i * cell;
            let mut peak = 0.0f32;
            for d in -2..=2 {
                let yy = (y + d) as usize;
                if yy < proj.len() {
                    peak = peak.max(proj[yy]);
                }
            }
            min_peak = min_peak.min(peak);
        }
        sc + min_peak * 0.5
    };

    let cell_step = ((max_cell - min_cell) / 40).max(1);
    let mut cell = min_cell;
    while cell <= max_cell {
        let span = cell * 9;
        if span as u32 + 4 > w.min(h) {
            cell += cell_step;
            continue;
        }
        // Search start positions for rows and cols
        let max_y0 = h as i32 - span - 2;
        let max_x0 = w as i32 - span - 2;
        if max_y0 < 2 || max_x0 < 2 {
            cell += cell_step;
            continue;
        }
        let y_step = (max_y0 / 50).max(2);
        let x_step = (max_x0 / 50).max(2);
        let mut y0 = 2i32;
        while y0 <= max_y0 {
            let rs = score_lines(&row_grad, y0, cell);
            if rs < 0.0 {
                y0 += y_step;
                continue;
            }
            let mut x0 = 2i32;
            while x0 <= max_x0 {
                let cs = score_lines(&col_grad, x0, cell);
                if cs < 0.0 {
                    x0 += x_step;
                    continue;
                }
                // Combined score; prefer larger cells slightly
                let sc = rs + cs + cell as f32 * 0.8;
                // Require both orientations strong
                if rs > 0.0 && cs > 0.0 && sc > best_sc {
                    // Side is 9 cells; include outer lines (span is start of last cell line to first)
                    // Lines at start, start+cell, ..., start+9*cell → side = 9*cell
                    let side = span as u32;
                    best_sc = sc;
                    best = Some((x0 as u32, y0 as u32, side));
                }
                x0 += x_step;
            }
            y0 += y_step;
        }
        cell += cell_step;
    }

    // Refine best with finer search
    if let Some((bx, by, bs)) = best {
        let cell0 = (bs / 9) as i32;
        let mut best2 = best;
        let mut best_sc2 = best_sc;
        for dc in -3..=3 {
            let cell = cell0 + dc;
            if cell < min_cell {
                continue;
            }
            let span = cell * 9;
            for dy in -8..=8 {
                for dx in -8..=8 {
                    let x0 = bx as i32 + dx;
                    let y0 = by as i32 + dy;
                    if x0 < 0 || y0 < 0 || x0 + span >= w as i32 || y0 + span >= h as i32 {
                        continue;
                    }
                    let rs = score_lines(&row_grad, y0, cell);
                    let cs = score_lines(&col_grad, x0, cell);
                    let sc = rs + cs + cell as f32 * 0.8;
                    if sc > best_sc2 {
                        best_sc2 = sc;
                        best2 = Some((x0 as u32, y0 as u32, span as u32));
                    }
                }
            }
        }
        // Small outer inset to sit inside thick border
        if let Some((x, y, s)) = best2 {
            let inset = ((s as f32) * 0.01).max(1.0) as u32;
            let s2 = s.saturating_sub(inset * 2).max(90);
            return Some((x + inset, y + inset, s2));
        }
    }
    None
}

fn find_grid_square_fallback(gray: &GrayImage) -> (u32, u32, u32) {
    let (w, h) = gray.dimensions();
    let mag = gradient_mag(gray);
    let mut vals = mag.clone();
    vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let thr = vals[(vals.len() * 85) / 100];
    let edge: Vec<u8> = mag.iter().map(|&m| u8::from(m >= thr)).collect();

    let (cx0, cy0, cx1, cy1) = content_bounds(gray);
    let cw = cx1.saturating_sub(cx0);
    let ch = cy1.saturating_sub(cy0);
    let cside = cw.min(ch);
    let portrait = h as f32 > w as f32 * 1.15;
    let fill_ratio = cside as f32 / w.min(h) as f32;
    if !portrait && fill_ratio > 0.88 {
        let sx = cx0 + (cw - cside) / 2;
        let sy = cy0 + (ch - cside) / 2;
        let inset = ((cside as f32) * 0.01) as u32;
        return (
            sx + inset,
            sy + inset,
            cside.saturating_sub(inset * 2).max(90),
        );
    }

    let min_side = ((w.min(h) as f32) * 0.42) as u32;
    let mut best_sc = f32::MIN;
    let mut best = (0u32, 0u32, w.min(h));
    let mut side = (w.min(h) as f32 * 0.95) as u32;

    while side >= min_side {
        let step = (side / 40).max(4);
        let y_lo = (h as f32 * 0.02) as u32;
        let y_hi = h.saturating_sub(side + (h as f32 * 0.02) as u32);
        let mut y0 = y_lo;
        while y0 <= y_hi {
            let mut x0 = (w as f32 * 0.02) as u32;
            let x_max = w.saturating_sub(side + (w as f32 * 0.02) as u32);
            while x0 <= x_max {
                let mut sc = score_edges(&edge, w as usize, x0, y0, side);
                sc += side as f32 * 0.15;
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
    (
        x + inset,
        y + inset,
        s.saturating_sub(inset * 2).max(min_side),
    )
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

fn glyph_holes(bin: &GrayImage) -> (usize, Vec<f32>) {
    let Some((x0, y0, x1, y1)) = ink_bbox(bin) else {
        return (0, vec![]);
    };
    let crop =
        image::imageops::crop_imm(bin, x0, y0, (x1 - x0 + 1).max(1), (y1 - y0 + 1).max(1)).to_image();
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
        for (nx, ny) in [
            (x.wrapping_sub(1), y),
            (x + 1, y),
            (x, y.wrapping_sub(1)),
            (x, y + 1),
        ] {
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
                for (nx, ny) in [
                    (cx.wrapping_sub(1), cy),
                    (cx + 1, cy),
                    (cx, cy.wrapping_sub(1)),
                    (cx, cy + 1),
                ] {
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

fn grid_is_consistent(grid: &RecognizedGrid) -> bool {
    let mut cells = [[0u8; 9]; 9];
    for r in 0..9 {
        for c in 0..9 {
            cells[r][c] = grid.cells[r][c].digit;
        }
    }
    sudoku_core::Grid::from_cells(cells).is_ok()
}

fn grid_is_solvable(grid: &RecognizedGrid) -> bool {
    let mut cells = [[0u8; 9]; 9];
    for r in 0..9 {
        for c in 0..9 {
            cells[r][c] = grid.cells[r][c].digit;
        }
    }
    match sudoku_core::Grid::from_cells(cells) {
        Ok(g) => g.solve().is_ok(),
        Err(_) => false,
    }
}

fn repair_until_solvable(grid: &mut RecognizedGrid) {
    for _ in 0..40 {
        if grid_is_solvable(grid) {
            return;
        }
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
        let Some((r, c, _)) = best else {
            return;
        };
        grid.cells[r][c].digit = 0;
        grid.cells[r][c].confidence = Some(0.0);
    }
}

fn resolve_conflicts(grid: &mut RecognizedGrid) {
    loop {
        let mut changed = false;
        for r in 0..9 {
            for c1 in 0..9 {
                let d = grid.cells[r][c1].digit;
                if d == 0 {
                    continue;
                }
                for c2 in (c1 + 1)..9 {
                    if grid.cells[r][c2].digit != d {
                        continue;
                    }
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
                if d == 0 {
                    continue;
                }
                for r2 in (r1 + 1)..9 {
                    if grid.cells[r2][c].digit != d {
                        continue;
                    }
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
                    if d == 0 {
                        continue;
                    }
                    for &(r2, c2) in &cells[i + 1..] {
                        if grid.cells[r2][c2].digit != d {
                            continue;
                        }
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
        if !changed {
            break;
        }
    }
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

/// Debug: write the extracted warped board to a path (for tuning).
pub fn extract_board_preview(path: impl AsRef<Path>, out: impl AsRef<Path>) -> Result<(), OcrError> {
    let img = image::open(path)?;
    let gray = img.to_luma8();
    let board = extract_board(&gray);
    let board = image::imageops::resize(&board, TARGET, TARGET, FilterType::CatmullRom);
    DynamicImage::ImageLuma8(board).save(out)?;
    Ok(())
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

    const EXPECTED_SOLUTION: [[u8; 9]; 9] = [
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

    fn assert_grid(path: &std::path::Path, label: &str) {
        assert!(path.exists(), "missing {label}");
        let got = recognize_digits(path).expect("ocr");
        if got != EXPECTED {
            let mut mismatches = 0;
            for r in 0..9 {
                for c in 0..9 {
                    if got[r][c] != EXPECTED[r][c] {
                        mismatches += 1;
                        eprintln!(
                            "{label} ({r},{c}): expected {} got {}",
                            EXPECTED[r][c], got[r][c]
                        );
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
                assert_eq!(solved.get(r, c), EXPECTED_SOLUTION[r][c]);
            }
        }
    }

    #[test]
    fn screen_photo_clues_are_correct_and_solvable() {
        // Phone-of-screen photos are hard (moiré + gray UI tint). Success means:
        // no wrong digits, enough correct clues for editing, and a consistent grid.
        // Full unique recovery may still need a couple of manual cell fixes in the UI.
        let path = fixtures_dir().join("screen-photo.jpg");
        let digits = recognize_digits(&path).expect("ocr");
        let mut cells = [[0u8; 9]; 9];
        let mut nz = 0u32;
        let mut agree = 0u32;
        for r in 0..9 {
            for c in 0..9 {
                cells[r][c] = digits[r][c];
                let d = digits[r][c];
                if d == 0 {
                    continue;
                }
                nz += 1;
                if d == EXPECTED_SOLUTION[r][c] {
                    agree += 1;
                } else {
                    eprintln!("wrong clue ({r},{c}): got {d} expected {}", EXPECTED_SOLUTION[r][c]);
                }
            }
        }
        eprintln!("screen-photo clues: {agree}/{nz} correct, digits={digits:?}");
        assert!(nz >= 25, "too few clues recognized: {nz}");
        assert_eq!(agree, nz, "every recognized clue must be correct: {agree}/{nz} {digits:?}");
        let grid = sudoku_core::Grid::from_cells(cells).expect("clues must be consistent");
        assert!(grid.solve().is_ok(), "grid must be solvable");
        // When we recover almost all clues, the solution must be unique and match.
        if nz >= 35 {
            let solved = grid.solve().unwrap();
            for r in 0..9 {
                for c in 0..9 {
                    assert_eq!(solved.get(r, c), EXPECTED_SOLUTION[r][c]);
                }
            }
        }
    }
}


