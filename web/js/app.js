/**
 * Sudoku scan UI — fast grid crop + parallel Tesseract.js (scheduler) + hole fixes.
 */

const CONFIDENCE_THRESHOLD = 30;
const LOW_CONF_UI = 65;
/** Higher board res improves gray-cell / moiré digits (sudoku.com screenshots). */
const GRID_SIZE = 720;
const CELL_INSET = 0.14;
const INK_DELTA = 28;
const INK_ABS_MAX = 180;
const MIN_INK_RATIO = 0.0025;
const MAX_INK_RATIO = 0.55;
/** Reject OCR guesses below this unless topology (holes) is decisive. */
const MIN_ACCEPT_CONF = 42;
const OCR_DIGIT_SIZE = 64;
const OCR_PAD = 12;
const OCR_CELL_TIMEOUT_MS = 10000;
const OCR_TOTAL_TIMEOUT_MS = 120000;

const statusEl = document.getElementById("status");
const solveStatusEl = document.getElementById("solve-status");
const video = document.getElementById("video");
const previewImg = document.getElementById("preview-img");
const snapCanvas = document.getElementById("snap-canvas");
const boardEl = document.getElementById("board");
const boardSection = document.getElementById("board-section");
const numpad = document.getElementById("numpad");

let stream = null;
let wasm = null;
let cells = emptyCells();
let solutionMode = false;
let activeIndex = 0;
/** @type {import('tesseract.js').Worker | null} */
let ocrWorker = null;
let ocrWarmPromise = null;
let ocrBusy = false;
/** Portrait phone photos of apps — suppress flaky "1" reads (matches Rust). */
let lastCapturePortrait = false;

function yieldToUi() {
  return new Promise((r) => setTimeout(r, 0));
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function emptyCells() {
  return Array.from({ length: 81 }, () => ({ digit: 0, confidence: -1 }));
}

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}
function setSolveStatus(msg, kind = "") {
  solveStatusEl.textContent = msg;
  solveStatusEl.className = "status" + (kind ? ` ${kind}` : "");
}

async function loadWasm() {
  // Relative to this page (works on https://user.github.io/sudoku-solver/).
  const base = new URL(".", import.meta.url);
  const candidates = [
    new URL("../pkg/sudoku_wasm.js", base).href,
    new URL("./pkg/sudoku_wasm.js", base).href,
    "./pkg/sudoku_wasm.js",
  ];
  for (const url of candidates) {
    try {
      const mod = await import(url);
      await mod.default();
      wasm = mod;
      return;
    } catch (e) {
      console.warn("WASM load failed for", url, e);
    }
  }
  setStatus("Solver WASM missing — refresh or use Enter manually.", "error");
}

function conflictSet() {
  const bad = new Set();
  const d = cells.map((c) => c.digit);
  const mark = (i, j) => {
    bad.add(i);
    bad.add(j);
  };
  for (let r = 0; r < 9; r++) {
    const seen = new Map();
    for (let c = 0; c < 9; c++) {
      const v = d[r * 9 + c];
      if (!v) continue;
      const i = r * 9 + c;
      if (seen.has(v)) mark(i, seen.get(v));
      else seen.set(v, i);
    }
  }
  for (let c = 0; c < 9; c++) {
    const seen = new Map();
    for (let r = 0; r < 9; r++) {
      const v = d[r * 9 + c];
      if (!v) continue;
      const i = r * 9 + c;
      if (seen.has(v)) mark(i, seen.get(v));
      else seen.set(v, i);
    }
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const seen = new Map();
      for (let r = br * 3; r < br * 3 + 3; r++) {
        for (let c = bc * 3; c < bc * 3 + 3; c++) {
          const v = d[r * 9 + c];
          if (!v) continue;
          const i = r * 9 + c;
          if (seen.has(v)) mark(i, seen.get(v));
          else seen.set(v, i);
        }
      }
    }
  }
  return bad;
}

function renderBoard() {
  const conflicts = conflictSet();
  boardEl.innerHTML = "";
  for (let i = 0; i < 81; i++) {
    const { digit, confidence } = cells[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cell";
    btn.dataset.index = String(i);
    if (digit > 0) btn.textContent = String(digit);
    if (
      !solutionMode &&
      confidence >= 0 &&
      confidence < LOW_CONF_UI &&
      (digit > 0 || confidence < CONFIDENCE_THRESHOLD)
    ) {
      btn.classList.add("low-conf");
    }
    if (conflicts.has(i)) btn.classList.add("conflict");
    if (solutionMode && digit > 0 && !cells[i]._wasGiven) btn.classList.add("solution");
    if (activeIndex === i && !solutionMode) btn.classList.add("active");
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (solutionMode) return;
      activeIndex = i;
      renderBoard();
      boardEl.focus({ preventScroll: true });
    });
    boardEl.appendChild(btn);
  }
}

function setDigitAtActive(digit) {
  if (solutionMode) {
    setSolveStatus("Clear or New scan to edit.", "error");
    return;
  }
  if (activeIndex == null || activeIndex < 0 || activeIndex > 80) activeIndex = 0;
  cells[activeIndex] = { digit, confidence: 100, _wasGiven: digit > 0 };
  if (digit > 0 && activeIndex < 80) activeIndex += 1;
  setSolveStatus("");
  renderBoard();
}

function showBoard() {
  boardSection.classList.remove("hidden");
  solutionMode = false;
  renderBoard();
  boardEl.focus({ preventScroll: true });
}

function digitsArray() {
  return Uint8Array.from(cells.map((c) => c.digit));
}

numpad.addEventListener("pointerdown", (e) => {
  const t = e.target.closest("[data-digit]");
  if (!t) return;
  e.preventDefault();
  setDigitAtActive(parseInt(t.dataset.digit, 10));
});

boardEl.addEventListener("keydown", (e) => {
  if (solutionMode) return;
  if (e.key >= "1" && e.key <= "9") {
    e.preventDefault();
    setDigitAtActive(+e.key);
    return;
  }
  if (e.key === "0" || e.key === "Backspace" || e.key === "Delete" || e.key === " ") {
    e.preventDefault();
    setDigitAtActive(0);
    return;
  }
  const row = Math.floor(activeIndex / 9);
  const col = activeIndex % 9;
  let nr = row,
    nc = col;
  if (e.key === "ArrowLeft") nc = Math.max(0, col - 1);
  else if (e.key === "ArrowRight") nc = Math.min(8, col + 1);
  else if (e.key === "ArrowUp") nr = Math.max(0, row - 1);
  else if (e.key === "ArrowDown") nr = Math.min(8, row + 1);
  else return;
  e.preventDefault();
  activeIndex = nr * 9 + nc;
  renderBoard();
});

/* ---------- image prep / OCR (mirrors Rust sudoku-ocr) ---------- */


function sourceSize(source) {
  return {
    w: source.videoWidth || source.naturalWidth || source.width,
    h: source.videoHeight || source.naturalHeight || source.height,
  };
}

/**
 * Projection-peak 9×9 finder (closer to Rust). Finer search + portrait priors so we
 * don't lock onto UI chrome below the board (that shifted cells by ~2 rows).
 */
function findGridByLinePeaks(w, h, gray) {
  const rowGrad = new Float32Array(h);
  const colGrad = new Float32Array(w);
  const step = Math.max(1, Math.floor(Math.max(w, h) / 800));
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      const gy = gray[(y + 1) * w + x] - gray[(y - 1) * w + x];
      const gx = gray[y * w + (x + 1)] - gray[y * w + (x - 1)];
      rowGrad[y] += Math.abs(gy);
      colGrad[x] += Math.abs(gx);
    }
  }
  const smooth = (v) => {
    const o = new Float32Array(v.length);
    for (let i = 0; i < v.length; i++) {
      let s = 0,
        c = 0;
      for (let d = -2; d <= 2; d++) {
        const j = i + d;
        if (j >= 0 && j < v.length) {
          s += v[j];
          c++;
        }
      }
      o[i] = s / c;
    }
    return o;
  };
  const rg = smooth(rowGrad);
  const cg = smooth(colGrad);
  const rowMean = rg.reduce((a, b) => a + b, 0) / (rg.length || 1);
  const colMean = cg.reduce((a, b) => a + b, 0) / (cg.length || 1);

  const scoreLines = (proj, mean, start, cell) => {
    const n = proj.length;
    let sc = 0;
    let minPeak = Infinity;
    for (let i = 0; i < 10; i++) {
      const y = start + i * cell;
      if (y < 2 || y + 2 >= n) return -1;
      let peak = 0;
      for (let d = -2; d <= 2; d++) peak = Math.max(peak, proj[y + d] || 0);
      sc += Math.max(0, peak - mean * 1.2);
      minPeak = Math.min(minPeak, peak);
    }
    return sc + minPeak * 0.5;
  };

  const portrait = h > w * 1.15;
  const minSide = Math.min(w, h);
  const minCell = Math.floor(minSide * 0.06);
  const maxCell = Math.floor(minSide * 0.14);
  const cellStep = Math.max(1, Math.floor((maxCell - minCell) / 40));
  let bestSc = -1;
  let best = null;

  // Portrait phone UIs: board sits in the upper/mid band — never start too low.
  const yLo = portrait ? Math.floor(h * 0.12) : 2;
  const yHiFrac = portrait ? 0.55 : 0.95;

  for (let cell = minCell; cell <= maxCell; cell += cellStep) {
    const span = cell * 9;
    if (span + 4 > minSide) continue;
    const maxY0 = Math.min(h - span - 2, Math.floor(h * yHiFrac));
    const maxX0 = w - span - 2;
    if (maxY0 < yLo || maxX0 < 2) continue;
    const yStep = Math.max(2, Math.floor((maxY0 - yLo) / 40));
    const xStep = Math.max(2, Math.floor(maxX0 / 40));
    for (let y0 = yLo; y0 <= maxY0; y0 += yStep) {
      const rs = scoreLines(rg, rowMean, y0, cell);
      if (rs < 0) continue;
      for (let x0 = 2; x0 <= maxX0; x0 += xStep) {
        const cs = scoreLines(cg, colMean, x0, cell);
        if (cs < 0) continue;
        // Prefer larger boards; slight preference for higher placement on portrait.
        let sc = rs + cs + cell * 0.8;
        if (portrait) sc += (1 - y0 / h) * 80;
        if (sc > bestSc) {
          bestSc = sc;
          best = { x: x0, y: y0, s: span };
        }
      }
    }
  }

  // Portrait priors (sudoku.com framing) — score and compete with peaks.
  if (portrait) {
    const priors = [
      [0.078, 0.231, 0.9],
      [0.06, 0.22, 0.88],
      [0.08, 0.24, 0.85],
      [0.05, 0.2, 0.9],
      [0.07, 0.25, 0.84],
    ];
    for (const [xf, yf, sf] of priors) {
      const x0 = Math.floor(w * xf);
      const y0 = Math.floor(h * yf);
      const span = Math.floor(Math.min(w, h) * sf);
      if (x0 + span >= w || y0 + span >= h) continue;
      const cell = Math.floor(span / 9);
      const rs = scoreLines(rg, rowMean, y0, cell);
      const cs = scoreLines(cg, colMean, x0, cell);
      if (rs < 0 || cs < 0) continue;
      const sc = rs + cs + cell * 0.8 + (1 - y0 / h) * 80 + 40; // bonus for known priors
      if (sc > bestSc) {
        bestSc = sc;
        best = { x: x0, y: y0, s: span };
      }
    }
  }

  if (!best) return null;

  const cell0 = Math.floor(best.s / 9);
  let best2 = best;
  let bestSc2 = bestSc;
  for (let dc = -3; dc <= 3; dc++) {
    const cell = cell0 + dc;
    if (cell < minCell) continue;
    const span = cell * 9;
    for (let dy = -8; dy <= 8; dy += 2) {
      for (let dx = -8; dx <= 8; dx += 2) {
        const x0 = best.x + dx;
        const y0 = best.y + dy;
        if (x0 < 0 || y0 < 0 || x0 + span >= w || y0 + span >= h) continue;
        if (portrait && y0 > h * 0.55) continue;
        const sc =
          scoreLines(rg, rowMean, y0, cell) +
          scoreLines(cg, colMean, x0, cell) +
          cell * 0.8 +
          (portrait ? (1 - y0 / h) * 40 : 0);
        if (sc > bestSc2) {
          bestSc2 = sc;
          best2 = { x: x0, y: y0, s: span };
        }
      }
    }
  }
  const inset = Math.max(1, Math.floor(best2.s * 0.012));
  return {
    x: best2.x + inset,
    y: best2.y + inset,
    s: Math.max(90, best2.s - inset * 2),
  };
}

/** Match Rust extract_board: line peaks for embedded grids, else content square. */
function findGridRect(w, h, gray) {
  const peaks = findGridByLinePeaks(w, h, gray);
  if (peaks) {
    const cover = (peaks.s * peaks.s) / (w * h);
    const margin =
      peaks.x > w / 25 ||
      peaks.y > h / 25 ||
      peaks.x + peaks.s < w - w / 25 ||
      peaks.y + peaks.s < h - h / 25;
    if (cover < 0.82 || margin) return peaks;
  }
  // Full-frame / landscape: largest content square
  let minX = w,
    minY = h,
    maxX = 0,
    maxY = 0,
    found = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (gray[y * w + x] < 248) {
        found = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (!found) return { x: 0, y: 0, s: Math.min(w, h) };
  minX = Math.max(0, minX - 1);
  minY = Math.max(0, minY - 1);
  maxX = Math.min(w, maxX + 2);
  maxY = Math.min(h, maxY + 2);
  const cw = maxX - minX;
  const ch = maxY - minY;
  const side = Math.min(cw, ch);
  const sx = minX + Math.floor((cw - side) / 2);
  const sy = minY + Math.floor((ch - side) / 2);
  const inset = Math.floor(side * 0.01);
  return { x: sx + inset, y: sy + inset, s: Math.max(side - 2 * inset, 90) };
}

function stretchContrastGray(gray, w, h, loPct = 2, hiPct = 98) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
  const total = gray.length;
  const loT = Math.floor((total * loPct) / 100);
  const hiT = Math.floor((total * hiPct) / 100);
  let acc = 0, lo = 0, hi = 255;
  for (let i = 0; i < 256; i++) {
    acc += hist[i];
    if (acc >= loT) {
      lo = i;
      break;
    }
  }
  acc = 0;
  for (let i = 255; i >= 0; i--) {
    acc += hist[i];
    if (acc >= total - hiT) {
      hi = i;
      break;
    }
  }
  if (hi <= lo) return gray;
  const range = hi - lo;
  const out = new Uint8ClampedArray(gray.length);
  for (let i = 0; i < gray.length; i++) {
    const v = Math.min(hi, Math.max(lo, gray[i]));
    out[i] = ((v - lo) / range) * 255;
  }
  return out;
}

/** Fast separable box blur (denoise without O(n·k² log) median sorts). */
function boxBlurGray(gray, w, h, radius) {
  const tmp = new Float32Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  const r = radius | 0;
  for (let y = 0; y < h; y++) {
    let sum = 0;
    let n = 0;
    for (let x = 0; x <= Math.min(w - 1, r); x++) {
      sum += gray[y * w + x];
      n++;
    }
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = sum / n;
      const add = x + r + 1;
      const rem = x - r;
      if (add < w) {
        sum += gray[y * w + add];
        n++;
      }
      if (rem >= 0) {
        sum -= gray[y * w + rem];
        n--;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    let n = 0;
    for (let y = 0; y <= Math.min(h - 1, r); y++) {
      sum += tmp[y * w + x];
      n++;
    }
    for (let y = 0; y < h; y++) {
      out[y * w + x] = sum / n;
      const add = y + r + 1;
      const rem = y - r;
      if (add < h) {
        sum += tmp[add * w + x];
        n++;
      }
      if (rem >= 0) {
        sum -= tmp[rem * w + x];
        n--;
      }
    }
  }
  return out;
}

function drawSquareToCanvas(source) {
  const { w: sw, h: sh } = sourceSize(source);
  lastCapturePortrait = sh > sw * 1.15;
  // Downscale huge phone photos before grid search (biggest win for line-peak scan).
  const maxDetect = 720;
  const detScale = Math.min(1, maxDetect / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * detScale));
  const dh = Math.max(1, Math.round(sh * detScale));
  const tmp = document.createElement("canvas");
  tmp.width = dw;
  tmp.height = dh;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  tctx.drawImage(source, 0, 0, dw, dh);
  const id = tctx.getImageData(0, 0, dw, dh);
  const gray = new Uint8ClampedArray(dw * dh);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    gray[p] = 0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2];
  }
  let { x: sx, y: sy, s: side } = findGridRect(dw, dh, gray);
  // Map rect back to full-res source for a sharper board crop.
  const inv = 1 / detScale;
  const fx = Math.floor(sx * inv);
  const fy = Math.floor(sy * inv);
  const fs = Math.min(Math.ceil(side * inv), sw - fx, sh - fy);

  snapCanvas.width = GRID_SIZE;
  snapCanvas.height = GRID_SIZE;
  const ctx = snapCanvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, fx, fy, fs, fs, 0, 0, GRID_SIZE, GRID_SIZE);

  const board = ctx.getImageData(0, 0, GRID_SIZE, GRID_SIZE);
  let g = new Uint8ClampedArray(GRID_SIZE * GRID_SIZE);
  for (let i = 0, p = 0; p < g.length; i += 4, p++) {
    g[p] = 0.299 * board.data[i] + 0.587 * board.data[i + 1] + 0.114 * board.data[i + 2];
  }
  let noiseAcc = 0,
    noiseN = 0;
  const nstep = Math.max(2, Math.floor(GRID_SIZE / 80));
  for (let y = 1; y < GRID_SIZE - 1; y += nstep) {
    for (let x = 1; x < GRID_SIZE - 1; x += nstep) {
      const v = g[y * GRID_SIZE + x];
      noiseAcc += Math.abs(v - g[y * GRID_SIZE + x + 1]) + Math.abs(v - g[(y + 1) * GRID_SIZE + x]);
      noiseN += 2;
    }
  }
  const noisy = noiseAcc / Math.max(1, noiseN) > 12;
  g = boxBlurGray(g, GRID_SIZE, GRID_SIZE, noisy ? 2 : 1);
  g = stretchContrastGray(g, GRID_SIZE, GRID_SIZE, 2, 98);
  for (let i = 0, p = 0; p < g.length; i += 4, p++) {
    board.data[i] = board.data[i + 1] = board.data[i + 2] = g[p];
    board.data[i + 3] = 255;
  }
  ctx.putImageData(board, 0, 0);
  return snapCanvas;
}

function otsuThreshold(vals) {
  const hist = new Array(256).fill(0);
  for (const v of vals) hist[v | 0]++;
  const total = vals.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestThr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between >= best) {
      best = between;
      bestThr = t;
    }
  }
  return bestThr;
}

function thresholdCandidates(vals) {
  const sorted = vals.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const light = Math.max(sorted[Math.floor(n * 0.88)], sorted[Math.floor(n / 2)]);
  const median = sorted[Math.floor(n / 2)];
  const p10 = sorted[Math.floor(n * 0.1)];
  const p15 = sorted[Math.floor(n * 0.15)];
  const lightThr = Math.min(light - INK_DELTA, INK_ABS_MAX);
  const grayThr = Math.min(175, Math.max(p10 + 10, Math.floor((p15 + median) / 2)));
  const otsu = otsuThreshold(vals);
  // Unique-ish list: default, Otsu, gray-friendly, aggressive.
  const set = new Set([
    lightThr,
    Math.min(200, otsu + 5),
    grayThr,
    Math.min(200, lightThr + 20),
    Math.min(200, otsu + 15),
  ]);
  return [...set];
}

function binarizeVals(vals, w, h, thr) {
  let ink = 0;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const octx = out.getContext("2d");
  const oid = octx.createImageData(w, h);
  for (let p = 0, i = 0; p < vals.length; p++, i += 4) {
    const isInk = vals[p] < thr;
    if (isInk) ink++;
    const v = isInk ? 0 : 255;
    oid.data[i] = oid.data[i + 1] = oid.data[i + 2] = v;
    oid.data[i + 3] = 255;
  }
  octx.putImageData(oid, 0, 0);
  return { canvas: out, inkRatio: ink / vals.length };
}

/**
 * Local min–max stretch (critical for gray sudoku.com cells).
 * Skip stretch on nearly-blank / low-contrast tiles — stretching moiré turns empties into fake ink/holes (false 8s).
 * @returns {{ vals: number[], span: number, mean: number, lo: number, hi: number, stretched: boolean }}
 */
function stretchVals(vals) {
  let lo = 255,
    hi = 0,
    sum = 0;
  for (const v of vals) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    sum += v;
  }
  const mean = sum / (vals.length || 1);
  const span = hi - lo;
  // Empty / grid-line noise: no real dark ink.
  if (span <= 50 || (mean > 215 && span < 90) || lo > 190) {
    return { vals: vals.slice(), span, mean, lo, hi, stretched: false };
  }
  if (span <= 12) {
    return { vals: vals.slice(), span, mean, lo, hi, stretched: false };
  }
  return {
    vals: vals.map((v) => Math.round(((v - lo) / span) * 255)),
    span,
    mean,
    lo,
    hi,
    stretched: true,
  };
}

/** True when the cell looks empty (no digit ink worth OCR). */
function cellLooksEmpty(span, mean, lo) {
  return span <= 50 || (mean > 215 && span < 90) || lo > 190;
}

function glyphIsCoherent(binCanvas) {
  const ctx = binCanvas.getContext("2d");
  const { width: w, height: h } = binCanvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  const ink = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4] < 128) ink.push(y * w + x);
    }
  }
  if (ink.length < 10) return false;
  // BFS largest component
  const seen = new Uint8Array(w * h);
  let best = 0;
  const q = [];
  for (const start of ink) {
    if (seen[start]) continue;
    let n = 0;
    q.length = 0;
    q.push(start);
    seen[start] = 1;
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi];
      n++;
      const x = i % w,
        y = (i / w) | 0;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx,
          ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (seen[j] || d[j * 4] >= 128) continue;
        seen[j] = 1;
        q.push(j);
      }
    }
    if (n > best) best = n;
  }
  return best / ink.length >= 0.55;
}

/** @returns {{ bins: {canvas: HTMLCanvasElement, inkRatio: number}[], primary: {canvas, inkRatio} }} */
function cellToBinaryVariants(srcCanvas, x, y, cell) {
  const ix = Math.floor(cell * CELL_INSET);
  const iy = Math.floor(cell * CELL_INSET);
  const cw = Math.max(1, cell - 2 * ix);
  const ch = Math.max(1, cell - 2 * iy);
  const ctx = srcCanvas.getContext("2d", { willReadFrequently: true });
  const id = ctx.getImageData(x + ix, y + iy, cw, ch);
  let vals = [];
  for (let i = 0; i < id.data.length; i += 4) {
    vals.push(0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2]);
  }
  const stretch = stretchVals(vals);
  vals = stretch.vals;
  // Blank cells: do not invent glyphs from stretched moiré / grid crumbs.
  if (cellLooksEmpty(stretch.span, stretch.mean, stretch.lo)) {
    const b = binarizeVals(vals, cw, ch, 128);
    return { bins: [], primary: { canvas: b.canvas, inkRatio: 0 } };
  }
  const thrs = [...thresholdCandidates(vals), 190, 200];
  const bins = [];
  for (const thr of new Set(thrs)) {
    const b = binarizeVals(vals, cw, ch, thr);
    if (b.inkRatio >= MIN_INK_RATIO && b.inkRatio <= MAX_INK_RATIO && glyphIsCoherent(b.canvas)) {
      bins.push(b);
    }
  }
  if (!bins.length) {
    const b = binarizeVals(vals, cw, ch, thresholdCandidates(vals)[0] || 180);
    return { bins: [], primary: b };
  }
  bins.sort((a, b) => {
    const score = (r) => -Math.abs(Math.log((r.inkRatio + 1e-4) / 0.08));
    return score(b) - score(a);
  });
  return { bins: bins.slice(0, 4), primary: bins[0] };
}

/** @returns {{ canvas: HTMLCanvasElement, inkRatio: number }} */
function cellToBinary(srcCanvas, x, y, cell) {
  return cellToBinaryVariants(srcCanvas, x, y, cell).primary;
}

function padWhite(tile, pad, size) {
  const out = document.createElement("canvas");
  out.width = size + pad * 2;
  out.height = size + pad * 2;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tile, 0, 0, tile.width, tile.height, pad, pad, size, size);
  return out;
}

function inkBBox(binCanvas) {
  const ctx = binCanvas.getContext("2d");
  const { width: w, height: h } = binCanvas;
  const d = ctx.getImageData(0, 0, w, h).data;
  let minX = w,
    minY = h,
    maxX = 0,
    maxY = 0,
    any = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4] < 128) {
        any = true;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

function glyphHoles(binCanvas) {
  const bb = inkBBox(binCanvas);
  if (!bb) return { holes: 0, holeYc: [] };
  const { minX, minY, maxX, maxY } = bb;
  const cw = maxX - minX + 1;
  const ch = maxY - minY + 1;
  const nw = 32,
    nh = 40;
  const tmp = document.createElement("canvas");
  tmp.width = nw;
  tmp.height = nh;
  const tctx = tmp.getContext("2d");
  tctx.fillStyle = "#fff";
  tctx.fillRect(0, 0, nw, nh);
  tctx.imageSmoothingEnabled = false;
  tctx.drawImage(binCanvas, minX, minY, cw, ch, 0, 0, nw, nh);
  const d = tctx.getImageData(0, 0, nw, nh).data;
  const ink = new Uint8Array(nw * nh);
  for (let i = 0, p = 0; p < ink.length; i += 4, p++) ink[p] = d[i] < 128 ? 1 : 0;

  const vis = new Uint8Array(nw * nh);
  const q = [];
  const push = (x, y) => {
    const i = y * nw + x;
    if (ink[i] === 0 && !vis[i]) {
      vis[i] = 1;
      q.push([x, y]);
    }
  };
  for (let x = 0; x < nw; x++) {
    push(x, 0);
    push(x, nh - 1);
  }
  for (let y = 0; y < nh; y++) {
    push(0, y);
    push(nw - 1, y);
  }
  for (let qi = 0; qi < q.length; qi++) {
    const [x, y] = q[qi];
    for (const [nx, ny] of [
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    ]) {
      if (nx >= 0 && ny >= 0 && nx < nw && ny < nh) push(nx, ny);
    }
  }
  const holeYc = [];
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const i = y * nw + x;
      if (ink[i] !== 0 || vis[i]) continue;
      let sy = 0,
        n = 0;
      const qq = [[x, y]];
      vis[i] = 1;
      for (let qj = 0; qj < qq.length; qj++) {
        const [cx, cy] = qq[qj];
        sy += cy;
        n++;
        for (const [nx, ny] of [
          [cx - 1, cy],
          [cx + 1, cy],
          [cx, cy - 1],
          [cx, cy + 1],
        ]) {
          if (nx >= 0 && ny >= 0 && nx < nw && ny < nh) {
            const j = ny * nw + nx;
            if (ink[j] === 0 && !vis[j]) {
              vis[j] = 1;
              qq.push([nx, ny]);
            }
          }
        }
      }
      if (n >= 4) holeYc.push(sy / n / nh);
    }
  }
  return { holes: holeYc.length, holeYc };
}

function parseDigit(text) {
  const chars = (text || "").replace(/[^1-9]/g, "");
  if (!chars) return 0;
  const counts = {};
  for (const ch of chars) counts[ch] = (counts[ch] || 0) + 1;
  let best = "0",
    n = 0;
  for (const [ch, c] of Object.entries(counts)) {
    if (c > n) {
      n = c;
      best = ch;
    }
  }
  return parseInt(best, 10);
}

function applyHoleCorrections(digit, conf, holes, holeYc) {
  // Do not invent 8 from holes alone — moiré empty cells get 2+ fake holes.
  if (holes >= 2 && digit !== 0 && conf >= 50) {
    return { digit: 8, conf: Math.max(conf, 92) };
  }
  if (holes === 1) {
    const yc = holeYc[0];
    if (digit === 0) return { digit: yc < 0.5 ? 9 : 6, conf: 92 };
    if (digit === 2 && yc < 0.48) return { digit: 9, conf: Math.max(conf, 95) };
    if (digit === 5 && yc > 0.52) return { digit: 6, conf: Math.max(conf, 95) };
    if (digit === 6 || digit === 9) return { digit: yc < 0.5 ? 9 : 6, conf: Math.max(conf, 95) };
  }
  if (digit === 8 && holes === 0) {
    return { digit: 4, conf: Math.max(conf, 60) };
  }
  return { digit, conf };
}

function resolveConflicts(cells) {
  let changed = true;
  while (changed) {
    changed = false;
    const clear = (i, j) => {
      const a = cells[i].confidence ?? 0;
      const b = cells[j].confidence ?? 0;
      const drop = a >= b ? j : i;
      if (cells[drop].digit === 0) return;
      cells[drop] = { digit: 0, confidence: 0 };
      changed = true;
    };
    for (let r = 0; r < 9; r++) {
      for (let c1 = 0; c1 < 9; c1++) {
        const d = cells[r * 9 + c1].digit;
        if (!d) continue;
        for (let c2 = c1 + 1; c2 < 9; c2++) {
          if (cells[r * 9 + c2].digit === d) clear(r * 9 + c1, r * 9 + c2);
        }
      }
    }
    for (let c = 0; c < 9; c++) {
      for (let r1 = 0; r1 < 9; r1++) {
        const d = cells[r1 * 9 + c].digit;
        if (!d) continue;
        for (let r2 = r1 + 1; r2 < 9; r2++) {
          if (cells[r2 * 9 + c].digit === d) clear(r1 * 9 + c, r2 * 9 + c);
        }
      }
    }
    for (let br = 0; br < 3; br++) {
      for (let bc = 0; bc < 3; bc++) {
        const idx = [];
        for (let r = br * 3; r < br * 3 + 3; r++)
          for (let c = bc * 3; c < bc * 3 + 3; c++) idx.push(r * 9 + c);
        for (let i = 0; i < idx.length; i++) {
          const d = cells[idx[i]].digit;
          if (!d) continue;
          for (let j = i + 1; j < idx.length; j++) {
            if (cells[idx[j]].digit === d) clear(idx[i], idx[j]);
          }
        }
      }
    }
  }
  return cells;
}

function repairUntilSolvable(cells) {
  if (!wasm?.solve) return cells;
  for (let n = 0; n < 40; n++) {
    try {
      wasm.solve(Uint8Array.from(cells.map((c) => c.digit)));
      return cells;
    } catch (_) {
      /* drop lowest confidence */
    }
    let bestI = -1;
    let bestC = Infinity;
    for (let i = 0; i < 81; i++) {
      if (!cells[i].digit) continue;
      const conf = cells[i].confidence ?? 0;
      if (conf < bestC) {
        bestC = conf;
        bestI = i;
      }
    }
    if (bestI < 0) return cells;
    cells[bestI] = { digit: 0, confidence: 0 };
  }
  return cells;
}

async function ensureOcrWorker() {
  if (ocrWorker) return ocrWorker;
  if (ocrWarmPromise) return ocrWarmPromise;
  ocrWarmPromise = (async () => {
    setStatus("Loading OCR engine…");
    const w = await withTimeout(
      Tesseract.createWorker("eng", 1, {
        logger: () => {},
        // Prefer CDN defaults; avoid custom paths that can hang offline.
      }),
      45000,
      "Tesseract worker load"
    );
    await w.setParameters({
      tessedit_char_whitelist: "123456789",
      tessedit_pageseg_mode: "10",
      classify_bln_numeric_mode: "1",
    });
    ocrWorker = w;
    return w;
  })();
  try {
    return await ocrWarmPromise;
  } catch (e) {
    ocrWarmPromise = null;
    ocrWorker = null;
    throw e;
  }
}

async function ocrOneBin(worker, bin, psm) {
  const padded = padWhite(bin, OCR_PAD, OCR_DIGIT_SIZE);
  await worker.setParameters({
    tessedit_char_whitelist: "123456789",
    tessedit_pageseg_mode: String(psm),
    classify_bln_numeric_mode: "1",
  });
  const {
    data: { text, confidence },
  } = await withTimeout(worker.recognize(padded), OCR_CELL_TIMEOUT_MS, `psm${psm}`);
  const digit = parseDigit(text);
  // Tesseract.js often returns confidence 0 even when the whitelist digit is correct.
  let conf = confidence || 0;
  if (digit > 0 && conf < 40) {
    const cleaned = (text || "").replace(/[^1-9]/g, "");
    if (cleaned.length === 1) conf = Math.max(conf, 55);
    else if (cleaned.length >= 1) conf = Math.max(conf, 48);
  }
  return { digit, conf };
}

/**
 * Prefer empty over a weak wrong digit. Primary threshold + PSM-10 first;
 * extra thresholds/PSM only when the first pass is weak (gray/moiré cells).
 */
async function recognizeCellDigit(worker, bins) {
  const votes = new Map();
  let bestBin = bins[0].canvas;

  const record = (bin, digit, conf) => {
    if (digit <= 0) return;
    const prev = votes.get(digit) || 0;
    if (conf >= prev) {
      votes.set(digit, conf);
      bestBin = bin;
    }
  };

  // Fast path: best bin, PSM 10.
  try {
    const { digit, conf } = await ocrOneBin(worker, bins[0].canvas, 10);
    record(bins[0].canvas, digit, conf);
  } catch {
    /* fall through */
  }

  let topConf = votes.size ? Math.max(...votes.values()) : 0;
  const needMore = votes.size === 0 || topConf < MIN_ACCEPT_CONF + 10;

  if (needMore) {
    for (let bi = 0; bi < bins.length; bi++) {
      const bin = bins[bi].canvas;
      for (const psm of bi === 0 ? [8] : [10, 8]) {
        try {
          const { digit, conf } = await ocrOneBin(worker, bin, psm);
          record(bin, digit, conf);
        } catch {
          /* next */
        }
      }
    }
  }

  let digit = 0;
  let conf = 0;
  for (const [d, c] of votes) {
    if (c > conf) {
      digit = d;
      conf = c;
    }
  }
  if (votes.size >= 2) {
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked[0][1] - ranked[1][1] < 10) {
      digit = 0;
      conf = 0;
    }
  }

  const { holes, holeYc } = glyphHoles(bestBin);
  const ctx = bestBin.getContext("2d");
  const { width: bw, height: bh } = bestBin;
  const bd = ctx.getImageData(0, 0, bw, bh).data;
  let inkN = 0;
  for (let i = 0; i < bd.length; i += 4) if (bd[i] < 128) inkN++;
  const inkRatio = inkN / (bw * bh);

  // Grid-line crumbs often look like "8" (two small holes). Only force 8 with real mass.
  if (holes >= 2 && inkRatio >= 0.12 && digit !== 0 && conf >= 40) {
    digit = 8;
    conf = Math.max(conf, 90);
  } else if (holes >= 2 && inkRatio < 0.1) {
    // Noise holes — do not invent an 8.
    if (digit === 8) {
      digit = 0;
      conf = 0;
    }
  } else if (holes === 1 && (digit === 0 || digit === 2 || digit === 5)) {
    digit = holeYc[0] < 0.42 ? 9 : 6;
    conf = Math.max(conf, 88);
  } else if (holes === 1 && digit === 9 && holeYc[0] > 0.55) {
    digit = 6;
    conf = Math.max(conf, 88);
  } else if (holes === 1 && digit === 6 && holeYc[0] < 0.38) {
    digit = 9;
    conf = Math.max(conf, 88);
  } else if (!(holes >= 2 && inkRatio < 0.1)) {
    ({ digit, conf } = applyHoleCorrections(digit, conf, holes, holeYc));
  }

  // Portrait phone-of-app: never emit "1" (moiré false positives) — same as Rust.
  if (lastCapturePortrait && digit === 1) {
    // "19" / broken 9 often misread as 1 — recover 9 when there is a hole.
    if (holes === 1) {
      digit = holeYc[0] < 0.5 ? 9 : 6;
      conf = Math.max(conf, 70);
    } else {
      return { digit: 0, confidence: 0 };
    }
  }
  if (lastCapturePortrait && digit === 5 && inkRatio < 0.07) {
    return { digit: 0, confidence: 0 };
  }
  // Spurious 8s from grid-line junctions / moiré. Keep real 8s with solid ink+conf
  // even when topology only finds one hole (common on moiré phone photos).
  if (digit === 8) {
    const strong8 = inkRatio >= 0.1 && conf >= 70;
    const topology8 = holes >= 2 && inkRatio >= 0.11;
    if (!strong8 && !topology8) {
      return { digit: 0, confidence: 0 };
    }
  }

  // Accept a clear single-digit read even if Tess conf is oddly low (common in browser).
  if (digit > 0 && conf < MIN_ACCEPT_CONF && holes === 0 && inkRatio < 0.06) {
    return { digit: 0, confidence: conf };
  }
  if (digit > 0 && conf < 35 && holes === 0) {
    return { digit: 0, confidence: conf };
  }
  if (lastCapturePortrait && digit > 0 && holes === 0 && conf < 45 && digit !== 4 && inkRatio < 0.08) {
    return { digit: 0, confidence: 0 };
  }
  if (!glyphIsCoherent(bestBin) && digit > 0) {
    return { digit: 0, confidence: 0 };
  }
  return { digit, confidence: digit ? conf : 0 };
}

async function recognizeCanvas(canvas) {
  if (ocrBusy) throw new Error("OCR already running — wait for the current scan.");
  ocrBusy = true;
  const t0 = performance.now();
  try {
    const worker = await ensureOcrWorker();
    const cell = GRID_SIZE / 9;
    const out = Array.from({ length: 81 }, () => ({ digit: 0, confidence: 100 }));
    const todo = [];

    for (let r = 0; r < 9; r++) {
      for (let c = 0; c < 9; c++) {
        const i = r * 9 + c;
        const { bins, primary } = cellToBinaryVariants(canvas, c * cell, r * cell, cell);
        if (!bins.length) {
          if (primary.inkRatio < MIN_INK_RATIO) out[i] = { digit: 0, confidence: 100 };
          else out[i] = { digit: 0, confidence: 15 };
          continue;
        }
        todo.push({ i, bins });
      }
    }

    const total = todo.length;
    setStatus(total ? `Reading ${total} cells…` : "No digits detected.");
    await yieldToUi();

    for (let k = 0; k < todo.length; k++) {
      if (performance.now() - t0 > OCR_TOTAL_TIMEOUT_MS) {
        setStatus("OCR taking too long — fill missing cells manually.", "error");
        break;
      }
      const { i, bins } = todo[k];
      try {
        out[i] = await recognizeCellDigit(worker, bins);
      } catch (err) {
        console.warn("cell OCR failed", err);
        out[i] = { digit: 0, confidence: 0 };
      }
      if (k === total - 1 || k % 2 === 0) {
        setStatus(`Reading digits… ${k + 1}/${total}`);
        await yieldToUi();
      }
    }

    // Conflicts only — do not drop clues just to force a (possibly wrong) solution.
    let cellsOut = resolveConflicts(out);
    console.info(`OCR finished in ${Math.round(performance.now() - t0)}ms (${total} cells)`);
    return cellsOut;
  } finally {
    ocrBusy = false;
  }
}

function conflictSetFrom(list) {
  const bad = new Set();
  const d = list.map((c) => c.digit);
  const mark = (i, j) => {
    bad.add(i);
    bad.add(j);
  };
  for (let r = 0; r < 9; r++) {
    const seen = new Map();
    for (let c = 0; c < 9; c++) {
      const v = d[r * 9 + c];
      if (!v) continue;
      const i = r * 9 + c;
      if (seen.has(v)) mark(i, seen.get(v));
      else seen.set(v, i);
    }
  }
  for (let c = 0; c < 9; c++) {
    const seen = new Map();
    for (let r = 0; r < 9; r++) {
      const v = d[r * 9 + c];
      if (!v) continue;
      const i = r * 9 + c;
      if (seen.has(v)) mark(i, seen.get(v));
      else seen.set(v, i);
    }
  }
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const seen = new Map();
      for (let r = br * 3; r < br * 3 + 3; r++) {
        for (let c = bc * 3; c < bc * 3 + 3; c++) {
          const v = d[r * 9 + c];
          if (!v) continue;
          const i = r * 9 + c;
          if (seen.has(v)) mark(i, seen.get(v));
          else seen.set(v, i);
        }
      }
    }
  }
  return bad;
}

async function processSource(source) {
  if (ocrBusy) {
    setStatus("Already scanning — please wait.", "error");
    return;
  }
  try {
    setStatus("Preparing image…");
    await yieldToUi();
    if (source === video) {
      const { w, h } = sourceSize(video);
      const t = document.createElement("canvas");
      t.width = w;
      t.height = h;
      t.getContext("2d").drawImage(video, 0, 0);
      previewImg.src = t.toDataURL("image/jpeg", 0.85);
      previewImg.classList.remove("hidden");
      video.classList.add("hidden");
    } else if (source?.src) {
      previewImg.src = source.src;
      previewImg.classList.remove("hidden");
      video.classList.add("hidden");
    }
    await yieldToUi();
    setStatus("Finding grid…");
    await yieldToUi();
    let canvas;
    try {
      canvas = drawSquareToCanvas(source);
    } catch (e) {
      console.error(e);
      setStatus(`Could not find grid: ${e.message || e}`, "error");
      return;
    }
    await yieldToUi();
    cells = await recognizeCanvas(canvas);
    cells = cells.map((c) => ({ ...c, _wasGiven: c.digit > 0 }));
    activeIndex = 0;
    const filled = cells.filter((c) => c.digit > 0).length;
    const low = cells.filter((c) => c.digit > 0 && c.confidence >= 0 && c.confidence < LOW_CONF_UI).length;
    // Do NOT auto-solve: a misaligned crop + partial OCR can invent a different
    // valid puzzle. User verifies the grid against the photo, then taps Solve.
    setStatus(
      filled >= 28
        ? `OCR done — ${filled} digits${low ? ` (${low} low-confidence)` : ""}. Compare to the photo (especially top rows), fix if needed, then Solve.`
        : `OCR read ${filled} digits — fill empties that match the photo, then Solve.`,
      filled >= 22 ? "ok" : "error"
    );
    showBoard();
  } catch (e) {
    console.error(e);
    ocrBusy = false;
    setStatus(`OCR failed: ${e.message || e}. Try again or Enter manually.`, "error");
  }
}

document.getElementById("btn-camera").addEventListener("click", async () => {
  try {
    previewImg.classList.add("hidden");
    video.classList.remove("hidden");
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1920 } },
    });
    video.srcObject = stream;
    await video.play();
    document.getElementById("btn-snap").disabled = false;
    setStatus("Fill the blue frame with the puzzle, then Capture.");
  } catch (e) {
    setStatus(`Camera error: ${e.message}. Use Upload photo.`, "error");
  }
});

document.getElementById("btn-snap").addEventListener("click", async () => {
  if (!video.srcObject) return;
  const btn = document.getElementById("btn-snap");
  btn.disabled = true;
  await processSource(video);
  btn.disabled = false;
});

document.getElementById("file-input").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = async () => {
    previewImg.src = url;
    previewImg.classList.remove("hidden");
    video.classList.add("hidden");
    await processSource(img);
  };
  img.onerror = () => setStatus("Could not load image", "error");
  img.src = url;
  ev.target.value = "";
});

document.getElementById("btn-manual").addEventListener("click", () => {
  cells = emptyCells();
  activeIndex = 0;
  setStatus("Manual entry — tap cells and use the pad.");
  showBoard();
});

document.getElementById("btn-solve").addEventListener("click", () => {
  if (!wasm?.solve) {
    setSolveStatus("WASM solver not loaded — refresh the page.", "error");
    return;
  }
  cells = resolveConflicts(cells.map((c) => ({ ...c })));
  renderBoard();
  if (conflictSet().size) {
    setSolveStatus("Fix conflicting digits (red) first.", "error");
    return;
  }
  const clueCount = cells.filter((c) => c.digit > 0).length;
  const emptyCount = 81 - clueCount;
  if (clueCount < 17) {
    setSolveStatus(`Need more clues (have ${clueCount}). Fill empty cells from the photo, then Solve.`, "error");
    return;
  }
  // Partial OCR of a unique puzzle can still admit *another* valid completion.
  // Ask the user to fill empties that should have givens before trusting Solve.
  if (emptyCount > 45 || clueCount < 28) {
    const ok = confirm(
      `Only ${clueCount} clues were read (${emptyCount} empty). ` +
        `If any empty cell should have a digit from your photo, fill it first — ` +
        `otherwise Solve may show a different valid puzzle.\n\nSolve with current clues anyway?`
    );
    if (!ok) {
      setSolveStatus("Fill empty cells that match the photo, then Solve.", "error");
      return;
    }
  }
  try {
    const givens = cells.map((c) => ({
      digit: c.digit,
      confidence: c.confidence,
      _wasGiven: c.digit > 0,
    }));
    let digits = digitsArray();
    let result;
    try {
      result = wasm.solve(digits);
    } catch (firstErr) {
      const repaired = repairUntilSolvable(cells.map((c) => ({ ...c })));
      const dropped = clueCount - repaired.filter((c) => c.digit > 0).length;
      cells = repaired;
      renderBoard();
      digits = digitsArray();
      result = wasm.solve(digits);
      if (dropped > 0) {
        setSolveStatus(`Solved after clearing ${dropped} conflicting OCR cell(s). Verify vs photo.`, "ok");
      }
    }
    const arr = result instanceof Uint8Array ? result : Uint8Array.from(result);
    cells = Array.from(arr, (digit, i) => ({
      digit,
      confidence: givens[i]?.confidence ?? 100,
      _wasGiven: givens[i]?._wasGiven ?? false,
    }));
    solutionMode = true;
    renderBoard();
    if (!document.getElementById("solve-status").textContent.startsWith("Solved after")) {
      setSolveStatus(
        emptyCount > 40
          ? "Solved from partial OCR — verify against your photo."
          : "Solved.",
        "ok"
      );
    }
  } catch (e) {
    setSolveStatus(
      `${e.message || e} — add missing clues (yellow/empty) and try again.`,
      "error"
    );
  }
});

document.getElementById("btn-clear").addEventListener("click", () => {
  cells = emptyCells();
  solutionMode = false;
  activeIndex = 0;
  renderBoard();
  setSolveStatus("");
});

document.getElementById("btn-rescan").addEventListener("click", () => {
  boardSection.classList.add("hidden");
  setSolveStatus("");
  setStatus("");
  previewImg.classList.add("hidden");
  video.classList.remove("hidden");
});

loadWasm();
// Warm a single OCR worker in the background (non-blocking).
if (typeof Tesseract !== "undefined") {
  ensureOcrWorker().catch((e) => console.warn("OCR warm-up failed", e));
}
