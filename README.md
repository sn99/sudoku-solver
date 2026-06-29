# sudoku-solver

Rust Sudoku solver with **camera / photo scan** on [GitHub Pages](https://sn99.github.io/sudoku-solver/), and **native OCR** via [rusty-tesseract](https://github.com/thomasgruebl/rusty-tesseract).

[![CI](https://github.com/sn99/sudoku-solver/actions/workflows/ci.yml/badge.svg)](https://github.com/sn99/sudoku-solver/actions/workflows/ci.yml)

## Features

- **Web (GitHub Pages):** open the rear camera or upload a photo, OCR digits (Tesseract.js), edit low-confidence cells, solve with **Rust compiled to WASM**
- **CLI:** type a grid on stdin, or pass an image path to OCR with **rusty-tesseract** (system Tesseract required)

## Web app

After enabling **Settings → Pages → GitHub Actions**, the site deploys from [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

Local preview:

```bash
# requires wasm-pack and rustup target wasm32-unknown-unknown
wasm-pack build crates/sudoku-wasm --target web --out-dir ../../web/pkg --release
cd web && python3 -m http.server 8080
# open http://127.0.0.1:8080
```

Camera requires a **secure context** (HTTPS or localhost).

## CLI

```bash
# Build
cargo build -p sudoku-cli --release

# Text grid (0 = empty), 9 lines
cargo run -p sudoku-cli --release
```

Example input:

```
0 0 8 0 0 0 9 0 0
3 5 0 0 0 0 0 8 6
0 7 0 9 0 6 0 3 0
8 0 2 0 9 0 6 0 1
0 0 0 7 0 8 0 0 0
7 0 5 0 2 0 4 0 8
0 2 0 1 0 3 0 6 0
9 6 0 0 0 0 0 5 2
0 0 3 0 0 0 7 0 0
```

OCR from image (install [Tesseract](https://github.com/tesseract-ocr/tesseract) first):

```bash
cargo run -p sudoku-cli --release -- path/to/puzzle.png
```

`*` marks lower-confidence OCR digits; `?` marks rejected/empty uncertain cells.

## Workspace layout

| Path | Description |
| --- | --- |
| `crates/sudoku-core` | Grid + backtracking solver |
| `crates/sudoku-ocr` | Native OCR (`rusty-tesseract`) |
| `crates/sudoku-cli` | `sudoku-solver` binary |
| `crates/sudoku-wasm` | Browser bindings |
| `web/` | Static UI for Pages |

## License

MIT
