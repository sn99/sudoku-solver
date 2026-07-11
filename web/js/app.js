/**
 * Sudoku Solver web UI — camera/upload + vision scan + WASM solve.
 * Digit scan: atomic14-style CV + pretrained CNN (see vision.js).
 */

import { analyzeSudoku, warmVision } from "./vision.js";

const LOW_CONF_UI = 65;

const statusEl = document.getElementById("status");
const solveStatusEl = document.getElementById("solve-status");
const video = document.getElementById("video");
const previewImg = document.getElementById("preview-img");
const boardEl = document.getElementById("board");
const boardSection = document.getElementById("board-section");
const captureSection = document.getElementById("capture-section");
const numpad = document.getElementById("numpad");
const methodEl = document.getElementById("scan-method");

let stream = null;
let wasm = null;
let cells = emptyCells();
let solutionMode = false;
let activeIndex = 0;
let scanning = false;

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

function yieldToUi() {
  return new Promise((r) => setTimeout(r, 0));
}

async function loadWasm() {
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

function resolveConflicts(list) {
  const out = list.map((c) => ({ ...c }));
  const clearPair = (i, j) => {
    if ((out[i].confidence || 0) < (out[j].confidence || 0)) {
      out[i] = { digit: 0, confidence: 0 };
    } else {
      out[j] = { digit: 0, confidence: 0 };
    }
  };
  const checkGroup = (indices) => {
    const seen = new Map();
    for (const i of indices) {
      const v = out[i].digit;
      if (!v) continue;
      if (seen.has(v)) clearPair(i, seen.get(v));
      else seen.set(v, i);
    }
  };
  for (let r = 0; r < 9; r++) checkGroup(Array.from({ length: 9 }, (_, c) => r * 9 + c));
  for (let c = 0; c < 9; c++) checkGroup(Array.from({ length: 9 }, (_, r) => r * 9 + c));
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const idx = [];
      for (let r = br * 3; r < br * 3 + 3; r++)
        for (let c = bc * 3; c < bc * 3 + 3; c++) idx.push(r * 9 + c);
      checkGroup(idx);
    }
  }
  return out;
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
    btn.setAttribute("role", "gridcell");
    if (digit > 0) btn.textContent = String(digit);
    if (
      !solutionMode &&
      confidence >= 0 &&
      confidence < LOW_CONF_UI &&
      (digit > 0 || confidence >= 0)
    ) {
      if (digit > 0 && confidence < LOW_CONF_UI) btn.classList.add("low-conf");
    }
    if (conflicts.has(i)) btn.classList.add("conflict");
    if (solutionMode && digit > 0 && !cells[i]._wasGiven) btn.classList.add("solution");
    if (solutionMode && cells[i]._wasGiven) btn.classList.add("given");
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
  captureSection.classList.add("compact");
  solutionMode = false;
  renderBoard();
  boardEl.focus({ preventScroll: true });
}

function digitsArray() {
  return Uint8Array.from(cells.map((c) => c.digit));
}

function sourceSize(source) {
  return {
    w: source.videoWidth || source.naturalWidth || source.width,
    h: source.videoHeight || source.naturalHeight || source.height,
  };
}

async function processSource(source) {
  if (scanning) {
    setStatus("Already scanning — please wait.", "error");
    return;
  }
  scanning = true;
  const snapBtn = document.getElementById("btn-snap");
  if (snapBtn) snapBtn.disabled = true;
  try {
    setStatus("Preparing…");
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

    const t0 = performance.now();
    const { cells: read, method, boxCount } = await analyzeSudoku(source, (msg) => {
      setStatus(msg);
    });

    cells = read.map((c) => ({ ...c, _wasGiven: c.digit > 0 }));
    activeIndex = 0;
    const filled = cells.filter((c) => c.digit > 0).length;
    const low = cells.filter(
      (c) => c.digit > 0 && c.confidence >= 0 && c.confidence < LOW_CONF_UI
    ).length;
    const ms = Math.round(performance.now() - t0);
    if (methodEl) {
      methodEl.textContent = `Detected via ${method} · ${boxCount} ink cells · ${ms}ms`;
    }
    setStatus(
      filled >= 28
        ? `Read ${filled} digits${low ? ` (${low} low-confidence)` : ""}. Check the grid, then Solve.`
        : `Only ${filled} digits found — fill missing cells from the photo, then Solve.`,
      filled >= 22 ? "ok" : "error"
    );
    showBoard();
  } catch (e) {
    console.error(e);
    setStatus(`Scan failed: ${e.message || e}. Try another photo or Enter manually.`, "error");
  } finally {
    scanning = false;
    if (snapBtn && video.srcObject) snapBtn.disabled = false;
  }
}

/* ---------- events ---------- */

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

const scanOverlay = document.getElementById("scan-overlay");

document.getElementById("btn-camera").addEventListener("click", async () => {
  try {
    previewImg.classList.add("hidden");
    video.classList.remove("hidden");
    if (scanOverlay) scanOverlay.classList.add("hidden");
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
    setStatus("Frame the puzzle, then tap Capture.");
  } catch (e) {
    setStatus(`Camera error: ${e.message}. Use Upload photo.`, "error");
  }
});

document.getElementById("btn-snap").addEventListener("click", async () => {
  if (!video.srcObject) return;
  await processSource(video);
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
  if (methodEl) methodEl.textContent = "Manual entry";
  setStatus("Tap cells and use the pad (or keys 1–9).");
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
    setSolveStatus(`Need more clues (have ${clueCount}).`, "error");
    return;
  }
  if (emptyCount > 45 || clueCount < 28) {
    const ok = confirm(
      `Only ${clueCount} clues were read. Incomplete scans can produce a different valid puzzle.\n\nSolve with current clues anyway?`
    );
    if (!ok) {
      setSolveStatus("Fill empty cells from the photo, then Solve.", "error");
      return;
    }
  }
  try {
    const givens = cells.map((c) => ({
      digit: c.digit,
      confidence: c.confidence,
      _wasGiven: c.digit > 0,
    }));
    const digits = digitsArray();
    const result = wasm.solve(digits);
    const arr = result instanceof Uint8Array ? result : Uint8Array.from(result);
    cells = Array.from(arr, (digit, i) => ({
      digit,
      confidence: givens[i]?.confidence ?? 100,
      _wasGiven: givens[i]?._wasGiven ?? false,
    }));
    solutionMode = true;
    renderBoard();
    setSolveStatus("Solved.", "ok");
  } catch (e) {
    setSolveStatus(`${e.message || e} — fix clues and try again.`, "error");
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
  captureSection.classList.remove("compact");
  setSolveStatus("");
  setStatus("");
  if (methodEl) methodEl.textContent = "";
  previewImg.classList.add("hidden");
  video.classList.remove("hidden");
  if (scanOverlay && !video.srcObject) scanOverlay.classList.remove("hidden");
});

loadWasm();
warmVision();
