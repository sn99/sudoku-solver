/**
 * Sudoku scan UI: camera / upload → Tesseract.js (cell + confidence) → edit → Rust WASM solve.
 * Confidence model matches native rusty-tesseract path (0–100, low-conf highlight).
 */

const CONFIDENCE_THRESHOLD = 45;
const LOW_CONF_UI = 70;

const statusEl = document.getElementById("status");
const solveStatusEl = document.getElementById("solve-status");
const video = document.getElementById("video");
const snapCanvas = document.getElementById("snap-canvas");
const boardEl = document.getElementById("board");
const boardSection = document.getElementById("board-section");
const captureSection = document.getElementById("capture-section");

let stream = null;
let wasm = null;
/** @type {{ digit: number, confidence: number }[]} */
let cells = Array.from({ length: 81 }, () => ({ digit: 0, confidence: -1 }));
let solutionMode = false;
let activeIndex = null;

function setStatus(msg, kind = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? ` ${kind}` : "");
}

function setSolveStatus(msg, kind = "") {
  solveStatusEl.textContent = msg;
  solveStatusEl.className = "status" + (kind ? ` ${kind}` : "");
}

async function loadWasm() {
  // GitHub Pages project site: /sudoku-solver/pkg/ ; local: /pkg/ or ./pkg/
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
  setStatus("Solver WASM not found — build with wasm-pack (see README). You can still edit the grid if OCR works.", "error");
}

function renderBoard() {
  boardEl.innerHTML = "";
  for (let i = 0; i < 81; i++) {
    const { digit, confidence } = cells[i];
    const div = document.createElement("button");
    div.type = "button";
    div.className = "cell";
    div.dataset.index = String(i);
    if (digit > 0) div.textContent = String(digit);
    if (
      !solutionMode &&
      confidence >= 0 &&
      (confidence < LOW_CONF_UI || (digit === 0 && confidence < CONFIDENCE_THRESHOLD))
    ) {
      // Highlight uncertain OCR cells (including cleared low-conf digits)
      if (confidence < LOW_CONF_UI && (digit > 0 || confidence < CONFIDENCE_THRESHOLD)) {
        div.classList.add("low-conf");
      }
    }
    if (solutionMode && digit > 0) {
      // clues vs filled: clues have confidence >= 0 from OCR/edit before solve
      if (cells[i]._wasGiven) div.classList.remove("solution");
      else div.classList.add("solution");
    }
    if (activeIndex === i) div.classList.add("active");
    div.addEventListener("click", () => onCellClick(i));
    boardEl.appendChild(div);
  }
}

function onCellClick(i) {
  if (solutionMode) return;
  activeIndex = i;
  renderBoard();
  const cur = cells[i].digit;
  const next = window.prompt("Digit 1–9, or 0 / empty to clear", cur ? String(cur) : "");
  if (next === null) {
    activeIndex = null;
    renderBoard();
    return;
  }
  const n = parseInt(next.trim(), 10);
  if (Number.isNaN(n) || n < 0 || n > 9) {
    setSolveStatus("Enter a digit 0–9", "error");
  } else {
    cells[i] = { digit: n, confidence: 100 };
    setSolveStatus("");
  }
  activeIndex = null;
  renderBoard();
}

function showBoard() {
  boardSection.classList.remove("hidden");
  solutionMode = false;
  renderBoard();
}

function digitsArray() {
  return Uint8Array.from(cells.map((c) => c.digit));
}

/** Largest centered square from video/image into canvas, return ImageData-ish canvas */
function drawSquareToCanvas(source) {
  const w = source.videoWidth || source.naturalWidth || source.width;
  const h = source.videoHeight || source.naturalHeight || source.height;
  const side = Math.min(w, h);
  const sx = (w - side) / 2;
  const sy = (h - side) / 2;
  // Apply frame-guide inset (~8% each side) so we OCR the guided region
  const inset = side * 0.08;
  const crop = side - inset * 2;
  snapCanvas.width = 900;
  snapCanvas.height = 900;
  const ctx = snapCanvas.getContext("2d");
  ctx.drawImage(source, sx + inset, sy + inset, crop, crop, 0, 0, 900, 900);
  return snapCanvas;
}

function inkRatio(imageData) {
  const d = imageData.data;
  let ink = 0;
  let total = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] + d[i + 1] + d[i + 2]) / 3;
    total++;
    if (g < 128) ink++;
  }
  return ink / Math.max(total, 1);
}

function preprocessCellCanvas(srcCanvas) {
  const ctx = srcCanvas.getContext("2d");
  const { width, height } = srcCanvas;
  const img = ctx.getImageData(0, 0, width, height);
  const d = img.data;
  let min = 255,
    max = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] + d[i + 1] + d[i + 2]) / 3;
    min = Math.min(min, g);
    max = Math.max(max, g);
  }
  const range = Math.max(max - min, 1);
  let sum = 0;
  const gray = new Uint8ClampedArray(width * height);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    let g = ((d[i] + d[i + 1] + d[i + 2]) / 3 - min) / range * 255;
    gray[p] = g;
    sum += g;
  }
  const mean = sum / gray.length;
  if (mean < 127) {
    for (let p = 0; p < gray.length; p++) gray[p] = 255 - gray[p];
  }
  const thresh = 180;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const v = gray[p] < thresh ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return srcCanvas;
}

async function recognizeCanvas(canvas) {
  setStatus("Running OCR (Tesseract.js)…");
  const cell = 100;
  const inset = Math.max(2, Math.floor(cell * 0.12));
  const worker = await Tesseract.createWorker("eng", 1, {
    logger: () => {},
  });
  await worker.setParameters({
    tessedit_char_whitelist: "123456789",
    tessedit_pageseg_mode: Tesseract.PSM.SINGLE_CHAR,
  });

  const out = [];
  for (let r = 0; r < 9; r++) {
    for (let c = 0; c < 9; c++) {
      const tile = document.createElement("canvas");
      tile.width = cell - inset * 2;
      tile.height = cell - inset * 2;
      const tctx = tile.getContext("2d");
      tctx.drawImage(
        canvas,
        c * cell + inset,
        r * cell + inset,
        cell - inset * 2,
        cell - inset * 2,
        0,
        0,
        tile.width,
        tile.height
      );
      preprocessCellCanvas(tile);
      const id = tctx.getImageData(0, 0, tile.width, tile.height);
      if (inkRatio(id) < 0.02) {
        out.push({ digit: 0, confidence: 100 });
        continue;
      }
      const {
        data: { text, confidence },
      } = await worker.recognize(tile);
      const ch = (text || "").replace(/\s/g, "").charAt(0);
      let digit = 0;
      if (ch >= "1" && ch <= "9") digit = parseInt(ch, 10);
      const conf = typeof confidence === "number" ? confidence : digit ? 50 : 0;
      const accept = digit > 0 && conf >= CONFIDENCE_THRESHOLD;
      out.push({
        digit: accept ? digit : 0,
        confidence: digit > 0 ? conf : 0,
      });
    }
    setStatus(`OCR row ${r + 1}/9…`);
  }
  await worker.terminate();
  return out;
}

async function processSource(source) {
  try {
    const canvas = drawSquareToCanvas(source);
    cells = await recognizeCanvas(canvas);
    cells = cells.map((c) => ({ ...c, _wasGiven: c.digit > 0 }));
    setStatus("OCR done — fix highlighted cells if needed, then Solve.", "ok");
    showBoard();
  } catch (e) {
    console.error(e);
    setStatus(`OCR failed: ${e.message || e}`, "error");
  }
}

document.getElementById("btn-camera").addEventListener("click", async () => {
  try {
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 1280 } },
    });
    video.srcObject = stream;
    await video.play();
    document.getElementById("btn-snap").disabled = false;
    setStatus("Align the puzzle in the frame, then Capture.");
  } catch (e) {
    setStatus(`Camera error: ${e.message}. Try Upload photo instead.`, "error");
  }
});

document.getElementById("btn-snap").addEventListener("click", async () => {
  if (!video.srcObject) return;
  document.getElementById("btn-snap").disabled = true;
  await processSource(video);
  document.getElementById("btn-snap").disabled = false;
});

document.getElementById("file-input").addEventListener("change", async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = async () => {
    await processSource(img);
    URL.revokeObjectURL(url);
  };
  img.onerror = () => setStatus("Could not load image", "error");
  img.src = url;
});

document.getElementById("btn-solve").addEventListener("click", () => {
  if (!wasm || typeof wasm.solve !== "function") {
    setSolveStatus("WASM solver not loaded.", "error");
    return;
  }
  try {
    const givens = cells.map((c) => ({ digit: c.digit, confidence: c.confidence, _wasGiven: c.digit > 0 }));
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
  cells = Array.from({ length: 81 }, () => ({ digit: 0, confidence: -1 }));
  solutionMode = false;
  renderBoard();
  setSolveStatus("");
});

document.getElementById("btn-rescan").addEventListener("click", () => {
  boardSection.classList.add("hidden");
  setSolveStatus("");
  setStatus("");
});

loadWasm();
