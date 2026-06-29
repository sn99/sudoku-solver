/**
 * Sudoku scan UI: grid-line detection + multi-pass Tesseract.js OCR → touch/mouse pad edit → Rust WASM solve.
 */

const CONFIDENCE_THRESHOLD = 35;
const LOW_CONF_UI = 65;
const GRID_SIZE = 1080; // working resolution for OCR canvas

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
/** @type {{ digit: number, confidence: number, _wasGiven?: boolean }[]} */
let cells = emptyCells();
let solutionMode = false;
let activeIndex = 0;

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
  const candidates = ["./pkg/sudoku_wasm.js", "../pkg/sudoku_wasm.js"];
  let lastErr;
  for (const url of candidates) {
    try {
      const mod = await import(url);
      await mod.default();
      wasm = mod;
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  console.warn("WASM load failed", lastErr);
  setStatus("Solver WASM missing — you can still edit the grid. Build with wasm-pack (see README).", "error");
}

/* -------------------- board / input -------------------- */

function conflictSet() {
  const bad = new Set();
  const d = cells.map((c) => c.digit);
  for (let r = 0; r < 9; r++) {
    const seen = new Map();
    for (let c = 0; c < 9; c++) {
      const v = d[r * 9 + c];
      if (!v) continue;
      if (seen.has(v)) {
        bad.add(r * 9 + c);
        bad.add(seen.get(v));
      } else seen.set(v, r * 9 + c);
    }
  }
  for (let c = 0; c < 9; c++) {
    const seen = new Map();
    for (let r = 0; r < 9; r++) {
      const v = d[r * 9 + c];
      if (!v) continue;
      if (seen.has(v)) {
        bad.add(r * 9 + c);
        bad.add(seen.get(v));
      } else seen.set(v, r * 9 + c);
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
          if (seen.has(v)) {
            bad.add(i);
            bad.add(seen.get(v));
          } else seen.set(v, i);
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
    btn.role = "gridcell";
    btn.dataset.index = String(i);
    btn.setAttribute("aria-label", `Row ${Math.floor(i / 9) + 1} column ${(i % 9) + 1}${digit ? `, ${digit}` : ", empty"}`);
    if (digit > 0) btn.textContent = String(digit);

    if (!solutionMode && confidence >= 0 && confidence < LOW_CONF_UI && (digit > 0 || confidence < CONFIDENCE_THRESHOLD)) {
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
    setSolveStatus("Start a new scan or clear to edit.", "error");
    return;
  }
  if (activeIndex == null || activeIndex < 0 || activeIndex > 80) activeIndex = 0;
  cells[activeIndex] = { digit, confidence: 100, _wasGiven: digit > 0 };
  // advance to next cell on digit entry (not erase)
  if (digit > 0 && activeIndex < 80) activeIndex += 1;
  setSolveStatus("");
  renderBoard();
}

function showBoard() {
  boardSection.classList.remove("hidden");
  solutionMode = false;
  if (activeIndex == null) activeIndex = 0;
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
  const d = parseInt(t.dataset.digit, 10);
  setDigitAtActive(d);
});

boardEl.addEventListener("keydown", (e) => {
  if (solutionMode) return;
  const key = e.key;
  if (key >= "1" && key <= "9") {
    e.preventDefault();
    setDigitAtActive(parseInt(key, 10));
    return;
  }
  if (key === "0" || key === "Backspace" || key === "Delete" || key === " ") {
    e.preventDefault();
    setDigitAtActive(0);
    return;
  }
  const row = Math.floor(activeIndex / 9);
  const col = activeIndex % 9;
  let nr = row, nc = col;
  if (key === "ArrowLeft") nc = Math.max(0, col - 1);
  else if (key === "ArrowRight") nc = Math.min(8, col + 1);
  else if (key === "ArrowUp") nr = Math.max(0, row - 1);
  else if (key === "ArrowDown") nr = Math.min(8, row + 1);
  else return;
  e.preventDefault();
  activeIndex = nr * 9 + nc;
  renderBoard();
});

/* -------------------- image / grid geometry -------------------- */

function sourceSize(source) {
  return {
    w: source.videoWidth || source.naturalWidth || source.width,
    h: source.videoHeight || source.naturalHeight || source.height,
  };
}

/** Draw largest centered square (with guide inset) to working canvas */
function drawSquareToCanvas(source) {
  const { w, h } = sourceSize(source);
  const side = Math.min(w, h);
  const sx = (w - side) / 2;
  const sy = (h - side) / 2;
  const inset = side * 0.06;
  const crop = side - inset * 2;
  snapCanvas.width = GRID_SIZE;
  snapCanvas.height = GRID_SIZE;
  const ctx = snapCanvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx + inset, sy + inset, crop, crop, 0, 0, GRID_SIZE, GRID_SIZE);
  return snapCanvas;
}

function toGray(data, n) {
  const g = new Float32Array(n);
  for (let i = 0, p = 0; p < n; i += 4, p++) {
    g[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return g;
}

/** Otsu threshold on grayscale Float32Array */
function otsuThreshold(gray) {
  const hist = new Array(256).fill(0);
  for (let i = 0; i < gray.length; i++) hist[Math.max(0, Math.min(255, gray[i] | 0))]++;
  const total = gray.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = 0, thresh = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) {
      maxVar = v;
      thresh = t;
    }
  }
  return thresh;
}

/**
 * Find 10 grid line positions (including outer borders) using projection of dark pixels.
 * Falls back to uniform division if detection fails.
 */
function findGridLines(binary, size) {
  // binary: 1 = ink/dark, 0 = paper
  const rowSum = new Float64Array(size);
  const colSum = new Float64Array(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = binary[y * size + x];
      rowSum[y] += v;
      colSum[x] += v;
    }
  }

  function smooth(arr, k = 5) {
    const out = new Float64Array(arr.length);
    const h = (k - 1) >> 1;
    for (let i = 0; i < arr.length; i++) {
      let s = 0, c = 0;
      for (let j = i - h; j <= i + h; j++) {
        if (j >= 0 && j < arr.length) {
          s += arr[j];
          c++;
        }
      }
      out[i] = s / c;
    }
    return out;
  }

  function pickLines(proj) {
    const s = smooth(proj, 7);
    const mean = s.reduce((a, b) => a + b, 0) / s.length;
    // Peak prominence: local maxima above mean * factor
    const peaks = [];
    for (let i = 2; i < s.length - 2; i++) {
      if (s[i] > s[i - 1] && s[i] >= s[i + 1] && s[i] > mean * 1.15) {
        peaks.push({ i, v: s[i] });
      }
    }
    peaks.sort((a, b) => b.v - a.v);

    // Greedy non-max suppression by min distance ~ size/18
    const minDist = size / 18;
    const chosen = [];
    for (const p of peaks) {
      if (chosen.every((c) => Math.abs(c - p.i) >= minDist)) chosen.push(p.i);
      if (chosen.length >= 12) break;
    }
    chosen.sort((a, b) => a - b);

    // Prefer exactly 10 lines spanning the grid
    if (chosen.length >= 10) {
      // If more than 10, pick subset maximizing span regularity
      return pickBestTen(chosen, size);
    }

    // Uniform fallback
    const lines = [];
    for (let k = 0; k <= 9; k++) lines.push(Math.round((k * (size - 1)) / 9));
    return lines;
  }

  function pickBestTen(lines, size) {
    if (lines.length === 10) return lines;
    // take first and last extremes and 8 in between by spacing
    const out = [lines[0]];
    const target = [];
    for (let k = 0; k <= 9; k++) target.push((k * (size - 1)) / 9);
    for (let t = 1; t <= 8; t++) {
      let best = lines[0], bestD = Infinity;
      for (const L of lines) {
        const d = Math.abs(L - target[t]);
        if (d < bestD) {
          bestD = d;
          best = L;
        }
      }
      out.push(best);
    }
    out.push(lines[lines.length - 1]);
    // unique + sort
    return [...new Set(out)].sort((a, b) => a - b).length === 10
      ? [...new Set(out)].sort((a, b) => a - b)
      : target.map((t) => Math.round(t));
  }

  let xs = pickLines(colSum);
  let ys = pickLines(rowSum);
  if (xs.length !== 10) {
    xs = [];
    for (let k = 0; k <= 9; k++) xs.push(Math.round((k * (size - 1)) / 9));
  }
  if (ys.length !== 10) {
    ys = [];
    for (let k = 0; k <= 9; k++) ys.push(Math.round((k * (size - 1)) / 9));
  }
  return { xs, ys };
}

function buildBinaryFromCanvas(canvas) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const { width: size } = canvas;
  const img = ctx.getImageData(0, 0, size, size);
  const gray = toGray(img.data, size * size);
  // ensure dark digits on light: if mean is dark, invert
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  const mean = sum / gray.length;
  if (mean < 110) {
    for (let i = 0; i < gray.length; i++) gray[i] = 255 - gray[i];
  }
  const thr = otsuThreshold(gray);
  const binary = new Uint8Array(size * size);
  for (let i = 0; i < gray.length; i++) binary[i] = gray[i] < thr ? 1 : 0;
  return { binary, gray, thr, size };
}

/** Extract cell as padded white-background canvas for OCR */
function extractCellCanvas(srcCanvas, x0, y0, x1, y1) {
  const padFrac = 0.18;
  const w = x1 - x0;
  const h = y1 - y0;
  const ix = Math.floor(w * padFrac);
  const iy = Math.floor(h * padFrac);
  const sx = x0 + ix;
  const sy = y0 + iy;
  const sw = Math.max(1, w - 2 * ix);
  const sh = Math.max(1, h - 2 * iy);

  const outSize = 128;
  const tile = document.createElement("canvas");
  tile.width = outSize;
  tile.height = outSize;
  const tctx = tile.getContext("2d", { willReadFrequently: true });
  // white pad
  tctx.fillStyle = "#fff";
  tctx.fillRect(0, 0, outSize, outSize);
  const margin = 16;
  tctx.imageSmoothingEnabled = true;
  tctx.drawImage(srcCanvas, sx, sy, sw, sh, margin, margin, outSize - 2 * margin, outSize - 2 * margin);

  // binarize tile: dark on white
  const id = tctx.getImageData(0, 0, outSize, outSize);
  const g = toGray(id.data, outSize * outSize);
  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  if (sum / g.length < 127) {
    for (let i = 0; i < g.length; i++) g[i] = 255 - g[i];
  }
  const thr = Math.min(otsuThreshold(g) + 10, 240);
  for (let i = 0, p = 0; p < g.length; i += 4, p++) {
    const v = g[p] < thr ? 0 : 255;
    id.data[i] = id.data[i + 1] = id.data[i + 2] = v;
    id.data[i + 3] = 255;
  }
  tctx.putImageData(id, 0, 0);
  return tile;
}

function inkRatioFromCanvas(tile) {
  const ctx = tile.getContext("2d");
  const { width, height } = tile;
  const d = ctx.getImageData(0, 0, width, height).data;
  let ink = 0, total = 0;
  // ignore outer margin
  const m = 12;
  for (let y = m; y < height - m; y++) {
    for (let x = m; x < width - m; x++) {
      const i = (y * width + x) * 4;
      total++;
      if (d[i] < 128) ink++;
    }
  }
  return ink / Math.max(total, 1);
}

function parseDigitFromText(text) {
  const chars = (text || "").replace(/[^1-9]/g, "");
  if (!chars) return 0;
  // majority vote if multiple
  const counts = {};
  for (const ch of chars) counts[ch] = (counts[ch] || 0) + 1;
  let best = "0", bestN = 0;
  for (const [ch, n] of Object.entries(counts)) {
    if (n > bestN) {
      bestN = n;
      best = ch;
    }
  }
  return parseInt(best, 10);
}

async function recognizeCell(worker, tile) {
  const ratio = inkRatioFromCanvas(tile);
  // empty cell: very little ink
  if (ratio < 0.012) return { digit: 0, confidence: 100 };
  // too much ink often means grid-line junk
  if (ratio > 0.55) return { digit: 0, confidence: 20 };

  const attempts = [];
  // Pass 1: single character
  await worker.setParameters({
    tessedit_char_whitelist: "123456789",
    tessedit_pageseg_mode: "10",
    classify_bln_numeric_mode: "1",
  });
  let r1 = await worker.recognize(tile);
  attempts.push({
    digit: parseDigitFromText(r1.data.text),
    confidence: r1.data.confidence ?? 0,
  });

  // Pass 2: single word / sparse text if first failed or low conf
  if (!attempts[0].digit || attempts[0].confidence < 55) {
    await worker.setParameters({
      tessedit_char_whitelist: "123456789",
      tessedit_pageseg_mode: "8",
      classify_bln_numeric_mode: "1",
    });
    const r2 = await worker.recognize(tile);
    attempts.push({
      digit: parseDigitFromText(r2.data.text),
      confidence: r2.data.confidence ?? 0,
    });
  }

  // Pass 3: raw line
  if (!attempts.some((a) => a.digit && a.confidence >= 50)) {
    await worker.setParameters({
      tessedit_char_whitelist: "123456789",
      tessedit_pageseg_mode: "7",
      classify_bln_numeric_mode: "1",
    });
    const r3 = await worker.recognize(tile);
    attempts.push({
      digit: parseDigitFromText(r3.data.text),
      confidence: r3.data.confidence ?? 0,
    });
  }

  attempts.sort((a, b) => {
    if (!!a.digit !== !!b.digit) return a.digit ? -1 : 1;
    return b.confidence - a.confidence;
  });
  const best = attempts[0] || { digit: 0, confidence: 0 };
  // Keep low-confidence guesses so user can see them (highlighted), unless conf is garbage
  if (best.digit && best.confidence < 15) return { digit: 0, confidence: best.confidence };
  if (best.digit && best.confidence < CONFIDENCE_THRESHOLD) {
    return { digit: best.digit, confidence: best.confidence }; // show but highlight
  }
  return { digit: best.digit || 0, confidence: best.digit ? best.confidence : 0 };
}

async function recognizeCanvas(canvas) {
  setStatus("Detecting grid lines…");
  const { binary, size } = buildBinaryFromCanvas(canvas);
  const { xs, ys } = findGridLines(binary, size);

  setStatus("Loading OCR engine…");
  const worker = await Tesseract.createWorker("eng", 1, { logger: () => {} });

  const out = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const x0 = xs[c];
      const x1 = xs[c + 1];
      const y0 = ys[r];
      const y1 = ys[r + 1];
      const tile = extractCellCanvas(canvas, x0, y0, x1, y1);
      const cell = await recognizeCell(worker, tile);
      out.push(cell);
    }
    setStatus(`Reading digits… row ${r + 1}/9`);
  }
  await worker.terminate();
  return out;
}

async function processSource(source) {
  try {
    setStatus("Preparing image…");
    // show still preview when from video
    if (source === video) {
      const tmp = document.createElement("canvas");
      const { w, h } = sourceSize(video);
      tmp.width = w;
      tmp.height = h;
      tmp.getContext("2d").drawImage(video, 0, 0);
      previewImg.src = tmp.toDataURL("image/jpeg", 0.85);
      previewImg.classList.remove("hidden");
      video.classList.add("hidden");
    } else if (source && source.src) {
      previewImg.src = source.src;
      previewImg.classList.remove("hidden");
      video.classList.add("hidden");
    }

    const canvas = drawSquareToCanvas(source);
    cells = await recognizeCanvas(canvas);
    cells = cells.map((c) => ({ ...c, _wasGiven: c.digit > 0 }));
    activeIndex = 0;
    const filled = cells.filter((c) => c.digit > 0).length;
    setStatus(`OCR done — ${filled} digits found. Fix yellow/red cells, then Solve.`, "ok");
    showBoard();
  } catch (e) {
    console.error(e);
    setStatus(`OCR failed: ${e.message || e}`, "error");
  }
}

/* -------------------- capture controls -------------------- */

document.getElementById("btn-camera").addEventListener("click", async () => {
  try {
    previewImg.classList.add("hidden");
    video.classList.remove("hidden");
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1920 },
      },
    });
    video.srcObject = stream;
    await video.play();
    document.getElementById("btn-snap").disabled = false;
    setStatus("Fill the blue frame with the puzzle, then Capture.");
  } catch (e) {
    setStatus(`Camera error: ${e.message}. Use Upload photo instead.`, "error");
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
  const file = ev.target.files && ev.target.files[0];
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
  setStatus("Manual entry — select cells and use the pad.");
  showBoard();
});

document.getElementById("btn-solve").addEventListener("click", () => {
  if (!wasm || typeof wasm.solve !== "function") {
    setSolveStatus("WASM solver not loaded.", "error");
    return;
  }
  if (conflictSet().size) {
    setSolveStatus("Fix conflicting digits (red) before solving.", "error");
    return;
  }
  try {
    const givens = cells.map((c) => ({
      digit: c.digit,
      confidence: c.confidence,
      _wasGiven: c.digit > 0,
    }));
    const result = wasm.solve(digitsArray());
    const arr = result instanceof Uint8Array ? result : Uint8Array.from(result);
    cells = Array.from(arr, (digit, i) => ({
      digit,
      confidence: givens[i].confidence,
      _wasGiven: givens[i]._wasGiven,
    }));
    solutionMode = true;
    renderBoard();
    setSolveStatus("Solved. Clues are white; filled digits are blue.", "ok");
  } catch (e) {
    setSolveStatus(String(e.message || e), "error");
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
