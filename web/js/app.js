/**
 * Sudoku scan UI — adaptive per-cell binarization + multi-pass Tesseract.js
 * + hole-based 6/8/9 corrections (mirrors crates/sudoku-ocr).
 */

const CONFIDENCE_THRESHOLD = 30;
const LOW_CONF_UI = 65;
const GRID_SIZE = 900;
const CELL_INSET = 0.14;
const INK_DELTA = 35;
const INK_ABS_MAX = 190;
const MIN_INK_RATIO = 0.008;
const MAX_INK_RATIO = 0.45;

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
  for (const url of ["./pkg/sudoku_wasm.js", "../pkg/sudoku_wasm.js"]) {
    try {
      const mod = await import(url);
      await mod.default();
      wasm = mod;
      return;
    } catch (e) {
      /* try next */
    }
  }
  setStatus("Solver WASM missing — edit grid still works.", "error");
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

function contentBoundsGray(gray, w, h) {
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
  if (!found) return [0, 0, w, h];
  return [Math.max(0, minX - 1), Math.max(0, minY - 1), Math.min(w, maxX + 2), Math.min(h, maxY + 2)];
}

function drawSquareToCanvas(source) {
  const { w, h } = sourceSize(source);
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d", { willReadFrequently: true });
  tctx.drawImage(source, 0, 0);
  const id = tctx.getImageData(0, 0, w, h);
  const gray = new Uint8Array(w * h);
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    gray[p] = 0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2];
  }
  let [x0, y0, x1, y1] = contentBoundsGray(gray, w, h);
  let cw = Math.max(1, x1 - x0);
  let ch = Math.max(1, y1 - y0);
  const side = Math.min(cw, ch);
  const sx = x0 + Math.floor((cw - side) / 2);
  const sy = y0 + Math.floor((ch - side) / 2);
  const inset = Math.floor(side * 0.008);
  snapCanvas.width = GRID_SIZE;
  snapCanvas.height = GRID_SIZE;
  const ctx = snapCanvas.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    tmp,
    sx + inset,
    sy + inset,
    side - 2 * inset,
    side - 2 * inset,
    0,
    0,
    GRID_SIZE,
    GRID_SIZE
  );
  return snapCanvas;
}

function otsuLikeThresholdFromLight(vals) {
  const sorted = vals.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const light = Math.max(sorted[Math.floor(n * 0.9)], sorted[Math.floor(n / 2)]);
  return Math.min(light - INK_DELTA, INK_ABS_MAX);
}

/** @returns {{ canvas: HTMLCanvasElement, inkRatio: number }} */
function cellToBinary(srcCanvas, x, y, cell) {
  const ix = Math.floor(cell * CELL_INSET);
  const iy = Math.floor(cell * CELL_INSET);
  const cw = Math.max(1, cell - 2 * ix);
  const ch = Math.max(1, cell - 2 * iy);
  const ctx = srcCanvas.getContext("2d", { willReadFrequently: true });
  const id = ctx.getImageData(x + ix, y + iy, cw, ch);
  const vals = [];
  for (let i = 0; i < id.data.length; i += 4) {
    vals.push(0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2]);
  }
  const thr = otsuLikeThresholdFromLight(vals);
  let ink = 0;
  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  const octx = out.getContext("2d");
  const oid = octx.createImageData(cw, ch);
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
  if (holes >= 2) return { digit: 8, conf: Math.max(conf, 92) };
  if (holes === 1) {
    const yc = holeYc[0];
    if (digit === 0) return { digit: yc < 0.5 ? 9 : 6, conf: 92 };
    if (digit === 2 && yc < 0.48) return { digit: 9, conf: Math.max(conf, 95) };
    if (digit === 5 && yc > 0.52) return { digit: 6, conf: Math.max(conf, 95) };
    if (digit === 6 || digit === 9) return { digit: yc < 0.5 ? 9 : 6, conf: Math.max(conf, 95) };
  }
  if (digit === 8 && holes < 2) {
    // open 4 misread as 8
    return { digit: holes === 0 ? 4 : digit, conf: Math.max(conf, 60) };
  }
  return { digit, conf };
}

async function recognizeCanvas(canvas) {
  setStatus("Loading OCR…");
  const worker = await Tesseract.createWorker("eng", 1, { logger: () => {} });
  const cell = GRID_SIZE / 9;
  const out = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const { canvas: bin, inkRatio } = cellToBinary(canvas, c * cell, r * cell, cell);
      if (inkRatio < MIN_INK_RATIO) {
        out.push({ digit: 0, confidence: 100 });
        continue;
      }
      if (inkRatio > MAX_INK_RATIO) {
        out.push({ digit: 0, confidence: 15 });
        continue;
      }

      const padded = padWhite(bin, 24, 120);
      const candidates = [];
      for (const psm of ["10", "8", "13"]) {
        await worker.setParameters({
          tessedit_char_whitelist: "123456789",
          tessedit_pageseg_mode: psm,
          classify_bln_numeric_mode: "1",
        });
        const {
          data: { text, confidence },
        } = await worker.recognize(padded);
        const d = parseDigit(text);
        if (d > 0) candidates.push({ digit: d, conf: confidence || 50 });
      }
      candidates.sort((a, b) => b.conf - a.conf);
      let digit = candidates[0]?.digit || 0;
      let conf = candidates[0]?.conf || 0;
      if (digit === 8 && candidates.length > 1) {
        const alt = candidates.find((x) => x.digit !== 8);
        if (alt) {
          const { holes } = glyphHoles(bin);
          if (holes < 2) {
            digit = alt.digit;
            conf = alt.conf;
          }
        }
      }
      const { holes, holeYc } = glyphHoles(bin);
      ({ digit, conf } = applyHoleCorrections(digit, conf, holes, holeYc));
      out.push({ digit, confidence: digit ? conf : 0 });
    }
    setStatus(`Reading digits… row ${r + 1}/9`);
  }
  await worker.terminate();
  return out;
}

async function processSource(source) {
  try {
    setStatus("Preparing image…");
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
    const canvas = drawSquareToCanvas(source);
    cells = await recognizeCanvas(canvas);
    cells = cells.map((c) => ({ ...c, _wasGiven: c.digit > 0 }));
    activeIndex = 0;
    const filled = cells.filter((c) => c.digit > 0).length;
    setStatus(`OCR done — ${filled} digits. Fix any mistakes, then Solve.`, "ok");
    showBoard();
  } catch (e) {
    console.error(e);
    setStatus(`OCR failed: ${e.message || e}`, "error");
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
    setSolveStatus("WASM solver not loaded.", "error");
    return;
  }
  if (conflictSet().size) {
    setSolveStatus("Fix conflicting digits (red) first.", "error");
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
    setSolveStatus("Solved.", "ok");
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
