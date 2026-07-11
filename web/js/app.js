/**
 * Sudoku Solver web UI — camera/upload + vision scan + WASM solve.
 * Edit pad is opt-in; rescan returns to a clean capture screen.
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
const scanOverlay = document.getElementById("scan-overlay");
const editPanel = document.getElementById("edit-panel");
const btnEdit = document.getElementById("btn-edit");
const btnSnap = document.getElementById("btn-snap");
const btnCamera = document.getElementById("btn-camera");
const resultSummary = document.getElementById("result-summary");
const boardTitle = document.getElementById("board-title");
const thumbWrap = document.getElementById("thumb-wrap");
const thumbImg = document.getElementById("thumb-img");

let stream = null;
let wasm = null;
let cells = emptyCells();
let solutionMode = false;
let editMode = false;
let activeIndex = 0;
let scanning = false;
let lastPreviewUrl = "";

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

function stopCamera() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  video.srcObject = null;
  btnSnap.classList.add("hidden");
  btnSnap.disabled = true;
  btnCamera.classList.remove("hidden");
  captureSection.classList.remove("camera-live");
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
  setStatus("Solver WASM missing — refresh or use Type grid.", "error");
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

function setEditMode(on, { focus = true } = {}) {
  editMode = !!on;
  if (editMode) {
    // Drop out of solution view so user can fix clues.
    if (solutionMode) {
      solutionMode = false;
      // Restore only givens if we were in solution mode — keep current digits as editable.
    }
    editPanel.classList.remove("hidden");
    btnEdit.textContent = "Editing…";
    btnEdit.classList.add("active-edit");
    boardEl.classList.add("editing");
    boardEl.classList.remove("view-only");
    if (focus) {
      boardEl.focus({ preventScroll: true });
    }
  } else {
    editPanel.classList.add("hidden");
    btnEdit.textContent = "Edit cells";
    btnEdit.classList.remove("active-edit");
    boardEl.classList.remove("editing");
    boardEl.classList.add("view-only");
  }
  renderBoard();
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
    btn.tabIndex = editMode ? 0 : -1;
    if (digit > 0) btn.textContent = String(digit);
    if (!solutionMode && digit > 0 && confidence >= 0 && confidence < LOW_CONF_UI) {
      btn.classList.add("low-conf");
    }
    if (conflicts.has(i)) btn.classList.add("conflict");
    if (solutionMode && digit > 0 && !cells[i]._wasGiven) btn.classList.add("solution");
    if (solutionMode && cells[i]._wasGiven) btn.classList.add("given");
    if (editMode && activeIndex === i && !solutionMode) btn.classList.add("active");
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      if (!editMode || solutionMode) return;
      activeIndex = i;
      renderBoard();
      boardEl.focus({ preventScroll: true });
    });
    boardEl.appendChild(btn);
  }
}

function setDigitAtActive(digit) {
  if (!editMode) return;
  if (solutionMode) {
    setSolveStatus("Turn on Edit cells to change the board.", "error");
    return;
  }
  if (activeIndex == null || activeIndex < 0 || activeIndex > 80) activeIndex = 0;
  cells[activeIndex] = { digit, confidence: 100, _wasGiven: digit > 0 };
  if (digit > 0 && activeIndex < 80) activeIndex += 1;
  setSolveStatus("");
  renderBoard();
}

function showBoardView({ summary = "", title = "Grid", openEdit = false } = {}) {
  captureSection.classList.add("hidden");
  boardSection.classList.remove("hidden");
  boardTitle.textContent = title;
  resultSummary.textContent = summary;
  if (lastPreviewUrl) {
    thumbImg.src = lastPreviewUrl;
    thumbWrap.classList.remove("hidden");
  } else {
    thumbWrap.classList.add("hidden");
  }
  setEditMode(openEdit, { focus: openEdit });
  if (!openEdit) renderBoard();
}

function showCaptureView() {
  setEditMode(false);
  solutionMode = false;
  boardSection.classList.add("hidden");
  captureSection.classList.remove("hidden");
  captureSection.classList.remove("camera-live");
  previewImg.classList.add("hidden");
  previewImg.removeAttribute("src");
  video.classList.remove("hidden");
  if (scanOverlay) scanOverlay.classList.remove("hidden");
  if (methodEl) methodEl.textContent = "";
  setSolveStatus("");
  setStatus("");
  lastPreviewUrl = "";
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

function setPreviewFromSource(source) {
  if (source === video) {
    const { w, h } = sourceSize(video);
    const t = document.createElement("canvas");
    t.width = w;
    t.height = h;
    t.getContext("2d").drawImage(video, 0, 0);
    lastPreviewUrl = t.toDataURL("image/jpeg", 0.8);
    previewImg.src = lastPreviewUrl;
  } else if (source?.src) {
    lastPreviewUrl = source.src;
    previewImg.src = source.src;
  } else {
    lastPreviewUrl = "";
  }
  if (lastPreviewUrl) {
    previewImg.classList.remove("hidden");
    video.classList.add("hidden");
  }
}

async function processSource(source) {
  if (scanning) {
    setStatus("Already scanning — please wait.", "error");
    return;
  }
  scanning = true;
  btnSnap.disabled = true;
  try {
    setStatus("Preparing…");
    await yieldToUi();
    setPreviewFromSource(source);

    const t0 = performance.now();
    const { cells: read, method, boxCount } = await analyzeSudoku(source, (msg) => {
      setStatus(msg);
    });

    // Stop camera after a successful capture so Rescan is clean.
    stopCamera();

    cells = read.map((c) => ({ ...c, _wasGiven: c.digit > 0 }));
    activeIndex = 0;
    solutionMode = false;
    const filled = cells.filter((c) => c.digit > 0).length;
    const low = cells.filter(
      (c) => c.digit > 0 && c.confidence >= 0 && c.confidence < LOW_CONF_UI
    ).length;
    const ms = Math.round(performance.now() - t0);
    if (methodEl) {
      methodEl.textContent = `Detected via ${method} · ${boxCount} cells · ${ms}ms`;
    }

    const summary =
      filled >= 28
        ? `${filled} digits read${low ? ` · ${low} low-confidence` : ""}. Solve, or Edit if something looks wrong.`
        : `Only ${filled} digits found. Tap Edit cells to fill missing ones, then Solve.`;

    setStatus(
      filled >= 22 ? `Scan complete — ${filled} digits.` : `Weak scan — ${filled} digits.`,
      filled >= 22 ? "ok" : "error"
    );

    showBoardView({
      summary,
      title: "Scanned grid",
      // Auto-open editor only when the scan is clearly incomplete.
      openEdit: filled < 22,
    });
  } catch (e) {
    console.error(e);
    setStatus(`Scan failed: ${e.message || e}. Try another photo or Type grid.`, "error");
  } finally {
    scanning = false;
    if (video.srcObject) btnSnap.disabled = false;
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
  if (!editMode || solutionMode) return;
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

btnCamera.addEventListener("click", async () => {
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
    captureSection.classList.add("camera-live");
    btnSnap.classList.remove("hidden");
    btnSnap.disabled = false;
    btnCamera.classList.add("hidden");
    setStatus("Frame the puzzle, then Capture.");
  } catch (e) {
    setStatus(`Camera error: ${e.message}. Use Upload.`, "error");
  }
});

btnSnap.addEventListener("click", async () => {
  if (!video.srcObject) return;
  await processSource(video);
});

document.getElementById("file-input").addEventListener("change", async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = async () => {
    if (scanOverlay) scanOverlay.classList.add("hidden");
    await processSource(img);
  };
  img.onerror = () => setStatus("Could not load image", "error");
  img.src = url;
  ev.target.value = "";
});

document.getElementById("btn-manual").addEventListener("click", () => {
  stopCamera();
  cells = emptyCells();
  activeIndex = 0;
  solutionMode = false;
  lastPreviewUrl = "";
  if (methodEl) methodEl.textContent = "";
  setStatus("");
  showBoardView({
    summary: "Empty grid — fill clues, then Solve.",
    title: "Manual grid",
    openEdit: true,
  });
});

btnEdit.addEventListener("click", () => {
  if (editMode) {
    setEditMode(false);
    setSolveStatus("");
  } else {
    setEditMode(true);
    setSolveStatus("Editing — tap a cell, then a digit.");
  }
});

document.getElementById("btn-done-edit").addEventListener("click", () => {
  setEditMode(false);
  setSolveStatus("");
});

document.getElementById("btn-solve").addEventListener("click", () => {
  if (!wasm?.solve) {
    setSolveStatus("WASM solver not loaded — refresh the page.", "error");
    return;
  }
  // Leave edit mode for a clean result view.
  setEditMode(false);
  cells = resolveConflicts(cells.map((c) => ({ ...c })));
  renderBoard();
  if (conflictSet().size) {
    setSolveStatus("Fix conflicting digits (red) first — open Edit cells.", "error");
    setEditMode(true);
    return;
  }
  const clueCount = cells.filter((c) => c.digit > 0).length;
  const emptyCount = 81 - clueCount;
  if (clueCount < 17) {
    setSolveStatus(`Need more clues (have ${clueCount}). Open Edit cells.`, "error");
    setEditMode(true);
    return;
  }
  if (emptyCount > 45 || clueCount < 28) {
    const ok = confirm(
      `Only ${clueCount} clues were read. Incomplete scans can produce a different valid puzzle.\n\nSolve with current clues anyway?`
    );
    if (!ok) {
      setSolveStatus("Open Edit cells to add missing digits, then Solve.", "error");
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
    boardTitle.textContent = "Solution";
    resultSummary.textContent = "Blue digits were filled by the solver. Rescan for a new puzzle.";
    setSolveStatus("Solved.", "ok");
  } catch (e) {
    setSolveStatus(`${e.message || e} — open Edit cells and fix clues.`, "error");
  }
});

document.getElementById("btn-clear").addEventListener("click", () => {
  if (!editMode) return;
  cells = emptyCells();
  solutionMode = false;
  activeIndex = 0;
  renderBoard();
  setSolveStatus("Board cleared.");
});

document.getElementById("btn-rescan").addEventListener("click", () => {
  stopCamera();
  cells = emptyCells();
  showCaptureView();
  setStatus("Take a new photo or upload another image.");
});

loadWasm();
warmVision();
