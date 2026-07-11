# sudoku-solver

Rust Sudoku solver with **camera / photo scan** on [GitHub Pages](https://sn99.github.io/sudoku-solver/), and **native OCR** via [rusty-tesseract](https://github.com/thomasgruebl/rusty-tesseract).

[![CI](https://github.com/sn99/sudoku-solver/actions/workflows/ci.yml/badge.svg)](https://github.com/sn99/sudoku-solver/actions/workflows/ci.yml)

## Features

- **Web (GitHub Pages):** open the rear camera or upload a photo, detect the board, classify digits with a **pretrained CNN** (no training in this repo), edit low-confidence cells, solve with **Rust compiled to WASM**
- **CLI:** type a grid on stdin, or pass an image path to OCR with **rusty-tesseract** (system Tesseract required)

## How the web scanner works

The browser pipeline is adapted from [atomic14/ar-browser-sudoku](https://github.com/atomic14/ar-browser-sudoku) (CC0):

1. Adaptive threshold + largest connected component to find the board
2. Corner points → perspective warp to a square grid
3. Per-cell ink blobs → **pretrained TensorFlow.js digit model** (`web/models/digit-cnn/`)
4. Fallback **line-peak** crop for phone screenshots / flat app UIs

No new model training is required; weights are reused as-is.

## Web app

After enabling **Settings → Pages → GitHub Actions**, the site deploys from [`.github/workflows/pages.yml`](.github/workflows/pages.yml).

Local preview:

```bash
# requires wasm-pack and rustup target wasm32-unknown-unknown
wasm-pack build crates/sudoku-wasm --target web --out-dir ../../web/pkg --release
cd web && python3 -m http.server 8080
# open http://127.0.0.1:8080
```

Camera requires a **secure context** (HTTPS or localhost). Digit CNN loads TensorFlow.js from jsDelivr (needs network on first load).

## CLI

```bash
# Build
cargo build -p sudoku-cli --release

# Text grid (0 = empty), 9 lines
cargo run -p sudoku-cli --release
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
| `web/` | Static UI + vision scanner for Pages |
| `web/models/digit-cnn/` | Pretrained digit classifier (CC0) |

## License

MIT (application). Digit model and vision ideas from atomic14/ar-browser-sudoku are CC0 — see `web/models/digit-cnn/NOTICE.txt`.
