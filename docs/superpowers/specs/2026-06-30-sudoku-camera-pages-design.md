# Sudoku camera scan + GitHub Pages design

**Date:** 2026-06-30  
**Repo:** https://github.com/sn99/sudoku-solver

## Goals

- Scan a Sudoku with a **phone camera** or **photo upload**
- **Editable grid** with **low OCR confidence** highlights
- **Solve** using the existing Rust backtracking algorithm
- Host the interactive app on **GitHub Pages**
- Keep the project **Rust-first** for the solver (WASM); vision runs in the browser

## Constraints

- GitHub Pages is static only (no server-side processing)

## Architecture

Cargo workspace (CLI / native OCR crates removed):

| Crate / path | Role |
| --- | --- |
| `crates/sudoku-core` | Grid, parse, validate, solve |
| `crates/sudoku-wasm` | `solve` / `validate_givens` for the browser |
| `web/` | Camera, upload, CV + pretrained digit CNN, editable UI |

Shared model: each cell is `{ digit: 0–9, confidence: 0–100 }` (or unknown).

### Data flow (Pages)

Camera/file → adaptive threshold / line-peak board find → perspective warp → per-cell CNN digits → optional edit → Rust WASM `solve` → show solution (clues vs filled).

## Deploy

GitHub Actions: `wasm-pack build crates/sudoku-wasm --target web --out-dir web/pkg`, upload `web/` to GitHub Pages.

## Out of scope

- Perfect OCR on every moiré phone-of-screen photo without any manual cell edits
- Multi-puzzle pages / batch
