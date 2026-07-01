# Sudoku camera scan + GitHub Pages design

**Date:** 2026-06-30  
**Repo:** https://github.com/sn99/sudoku-solver

## Goals

- Scan a Sudoku with a **phone camera** or **photo upload**
- **Editable grid** with **low OCR confidence** highlights
- **Solve** using the existing Rust backtracking algorithm
- Host the interactive app on **GitHub Pages**
- Keep the project **Rust-first**; use **rusty-tesseract** for native OCR

## Constraints

- `rusty-tesseract` / native Tesseract FFI **cannot run in the browser**
- GitHub Pages is static only (no server-side Tesseract)

## Architecture

Cargo workspace:

| Crate / path | Role |
| --- | --- |
| `crates/sudoku-core` | Grid, parse, validate, solve |
| `crates/sudoku-ocr` | Full-frame grid OCR via **rusty-tesseract** (`image_to_data` confidence) |
| `crates/sudoku-cli` | Binary: stdin text or image path |
| `crates/sudoku-wasm` | `solve` / `validate_givens` for the browser |
| `web/` | Camera, upload, Tesseract.js OCR, editable UI |

Shared model: each cell is `{ digit: 0–9, confidence: 0–100 }` (or unknown). Thresholds: accept digit if conf ≥ 45; UI highlights conf &lt; 70.

### Data flow (Pages)

Camera/file → centered square crop (guide frame) → 81 tiles → Tesseract.js (whitelist `1-9`, single char) → editable board → Rust WASM `solve` → show solution (clues vs filled).

### Data flow (CLI)

`sudoku-solver puzzle.png` → `sudoku-ocr` (line-peak / contour grid extract → cell binarize → rusty-tesseract) → print grid → `sudoku-core` solve.

### Grid localization (2026-07 update)

Borrowed techniques from OpenCV projects (mukund0502/SudokuSolver, aakashjhawar/SolveSudoku, prajwalkr/SnapSudoku, rg1990/cv-sudoku-solver, trflorian/sudoku-extraction): adaptive threshold + largest blob corners + perspective warp, plus **projection-peak** search for equally spaced 9×9 lines (best on phone photos of sudoku apps). Multi-PSM Tesseract + hole-based 6/8/9 fixes; conflict resolution drops inconsistent low-confidence digits.

## Deploy

GitHub Actions: `wasm-pack build crates/sudoku-wasm --target web --out-dir web/pkg`, upload `web/` to GitHub Pages.

## Out of scope

- Perfect OCR on every moiré phone-of-screen photo without any manual cell edits
- Multi-puzzle pages / batch
