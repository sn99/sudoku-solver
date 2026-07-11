/**
 * Sudoku image analysis — adapted from atomic14/ar-browser-sudoku (CC0):
 * adaptive threshold → largest connected component → corner homography →
 * cell digit crops → pretrained TF.js CNN (no training here).
 *
 * Fallback: projection-peak 9×9 crop when the blob detector misses (phone app UIs).
 */

const PROCESSING_SIZE = 900;
const IMAGE_SIZE = 20;
const MIN_BOXES = 12;
const CLASSES = [1, 2, 3, 4, 5, 6, 7, 8, 9];

/* ---------- grayscale Image ---------- */

class GrayImage {
  constructor(bytes, width, height) {
    this.bytes = bytes instanceof Uint8ClampedArray ? bytes : new Uint8ClampedArray(bytes);
    this.width = width;
    this.height = height;
  }

  static withSize(width, height) {
    return new GrayImage(new Uint8ClampedArray(width * height), width, height);
  }

  clone() {
    return new GrayImage(new Uint8ClampedArray(this.bytes), this.width, this.height);
  }

  subImage(x1, y1, x2, y2) {
    const width = x2 - x1;
    const height = y2 - y1;
    const bytes = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        bytes[y * width + x] = this.bytes[(y + y1) * this.width + x + x1];
      }
    }
    return new GrayImage(bytes, width, height);
  }

  toImageData() {
    const imageData = new ImageData(this.width, this.height);
    for (let i = 0; i < this.bytes.length; i++) {
      const v = this.bytes[i];
      const o = i * 4;
      imageData.data[o] = v;
      imageData.data[o + 1] = v;
      imageData.data[o + 2] = v;
      imageData.data[o + 3] = 255;
    }
    return imageData;
  }
}

/* ---------- capture ---------- */

function captureFromSource(source) {
  const w = source.videoWidth || source.naturalWidth || source.width;
  const h = source.videoHeight || source.naturalHeight || source.height;
  if (!w || !h) throw new Error("Image has no dimensions");

  // Cap detection resolution for speed on large phone photos.
  const maxSide = 960;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));

  const canvas = document.createElement("canvas");
  canvas.width = dw;
  canvas.height = dh;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, dw, dh);
  const imageData = ctx.getImageData(0, 0, dw, dh);
  const bytes = new Uint8ClampedArray(dw * dh);
  for (let i = 0, p = 0; p < bytes.length; i += 4, p++) {
    // Luma via green channel (atomic14) blended with standard gray for robustness.
    const r = imageData.data[i];
    const g = imageData.data[i + 1];
    const b = imageData.data[i + 2];
    bytes[p] = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
  }
  return {
    image: new GrayImage(bytes, dw, dh),
    fullW: w,
    fullH: h,
    scale,
    source,
  };
}

/* ---------- box blur + adaptive threshold ---------- */

function precomputeIntegral(bytes, width, height) {
  const result = new Float64Array(bytes.length);
  let dst = 0;
  let src = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let tot = bytes[src];
      if (x > 0) tot += result[dst - 1];
      if (y > 0) tot += result[dst - width];
      if (x > 0 && y > 0) tot -= result[dst - width - 1];
      result[dst] = tot;
      dst++;
      src++;
    }
  }
  return result;
}

function readIntegral(pre, w, h, x, y) {
  if (x < 0) x = 0;
  else if (x >= w) x = w - 1;
  if (y < 0) y = 0;
  else if (y >= h) y = h - 1;
  return pre[x + y * w];
}

function boxBlur(src, boxw, boxh) {
  const { width, height, bytes } = src;
  const pre = precomputeIntegral(bytes, width, height);
  const result = new Uint8ClampedArray(width * height);
  const mul = 1 / ((boxw * 2 + 1) * (boxh * 2 + 1));
  let dst = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tot =
        readIntegral(pre, width, height, x + boxw, y + boxh) +
        readIntegral(pre, width, height, x - boxw, y - boxh) -
        readIntegral(pre, width, height, x - boxw, y + boxh) -
        readIntegral(pre, width, height, x + boxw, y - boxh);
      result[dst++] = tot * mul;
    }
  }
  return new GrayImage(result, width, height);
}

function adaptiveThreshold(image, threshold, blurSize) {
  const { width, height } = image;
  const blurred = boxBlur(image, blurSize, blurSize);
  const out = new Uint8ClampedArray(width * height);
  const src = image.bytes;
  const blur = blurred.bytes;
  for (let i = 0; i < src.length; i++) {
    out[i] = blur[i] - src[i] > threshold ? 255 : 0;
  }
  return new GrayImage(out, width, height);
}

/* ---------- connected components ---------- */

function getConnectedComponent(image, x, y) {
  const { width, height, bytes } = image;
  let minX = x,
    minY = y,
    maxX = x,
    maxY = y;
  const points = [];
  const frontier = [{ x, y }];
  points.push({ x, y });
  bytes[y * width + x] = 0;
  while (frontier.length) {
    const seed = frontier.pop();
    minX = Math.min(seed.x, minX);
    maxX = Math.max(seed.x, maxX);
    minY = Math.min(seed.y, minY);
    maxY = Math.max(seed.y, maxY);
    for (let dy = Math.max(0, seed.y - 1); dy < height && dy <= seed.y + 1; dy++) {
      for (let dx = Math.max(0, seed.x - 1); dx < width && dx <= seed.x + 1; dx++) {
        if (bytes[dy * width + dx] === 255) {
          points.push({ x: dx, y: dy });
          frontier.push({ x: dx, y: dy });
          bytes[dy * width + dx] = 0;
        }
      }
    }
  }
  return {
    points,
    bounds: { topLeft: { x: minX, y: minY }, bottomRight: { x: maxX, y: maxY } },
    get width() {
      return this.bounds.bottomRight.x - this.bounds.topLeft.x;
    },
    get height() {
      return this.bounds.bottomRight.y - this.bounds.topLeft.y;
    },
    get aspectRatio() {
      return this.width / this.height;
    },
  };
}

function getLargestConnectedComponent(image, opts) {
  const { minAspectRatio, maxAspectRatio, minSize, maxSize } = opts;
  let maxRegion = null;
  const tmp = image.clone();
  const { width, height, bytes } = tmp;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (bytes[row + x] === 255) {
        const region = getConnectedComponent(tmp, x, y);
        const rw = region.bounds.bottomRight.x - region.bounds.topLeft.x;
        const rh = region.bounds.bottomRight.y - region.bounds.topLeft.y;
        if (
          region.aspectRatio >= minAspectRatio &&
          region.aspectRatio <= maxAspectRatio &&
          rh >= minSize &&
          rw >= minSize &&
          rh <= maxSize &&
          rw <= maxSize
        ) {
          if (!maxRegion || region.points.length > maxRegion.points.length) {
            maxRegion = region;
          }
        }
      }
    }
  }
  return maxRegion;
}

function getNearestPoint(points, x, y) {
  let closest = points[0];
  let minD = Infinity;
  for (const p of points) {
    const d = Math.abs(p.x - x) + Math.abs(p.y - y);
    if (d < minD) {
      minD = d;
      closest = p;
    }
  }
  return closest;
}

function getCornerPoints(region) {
  const { x: minX, y: minY } = region.bounds.topLeft;
  const { x: maxX, y: maxY } = region.bounds.bottomRight;
  const { points } = region;
  return {
    topLeft: getNearestPoint(points, minX, minY),
    topRight: getNearestPoint(points, maxX, minY),
    bottomLeft: getNearestPoint(points, minX, maxY),
    bottomRight: getNearestPoint(points, maxX, maxY),
  };
}

function sanityCheckCorners({ topLeft, topRight, bottomLeft, bottomRight }) {
  const len = (p1, p2) => {
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.hypot(dx, dy);
  };
  const top = len(topLeft, topRight);
  const left = len(topLeft, bottomLeft);
  const right = len(topRight, bottomRight);
  const bottom = len(bottomLeft, bottomRight);
  if (top < 0.5 * bottom || top > 1.5 * bottom) return false;
  if (left < 0.7 * right || left > 1.3 * right) return false;
  if (left < 0.5 * bottom || left > 1.5 * bottom) return false;
  return true;
}

/* ---------- homography (no mathjs) ---------- */

function solveLinearSystem(A, B) {
  // Gaussian elimination with partial pivoting on n x n system (n=8).
  const n = B.length;
  const M = A.map((row, i) => row.slice().concat([B[i]]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) throw new Error("Singular homography");
    if (pivot !== col) {
      const tmp = M[col];
      M[col] = M[pivot];
      M[pivot] = tmp;
    }
    const div = M[col][col];
    for (let c = col; c <= n; c++) M[col][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

function findHomographicTransform(size, corners) {
  // Map unit square [0..size]^2 → image corners (atomic14 formulation).
  const A = Array.from({ length: 8 }, () => Array(8).fill(0));
  A[0][2] = 1;
  A[1][5] = 1;
  A[2][0] = size;
  A[2][2] = 1;
  A[2][6] = -size * corners.topRight.x;
  A[3][3] = size;
  A[3][5] = 1;
  A[3][6] = -size * corners.topRight.y;
  A[4][1] = size;
  A[4][2] = 1;
  A[4][7] = -size * corners.bottomLeft.x;
  A[5][4] = size;
  A[5][5] = 1;
  A[5][7] = -size * corners.bottomLeft.y;
  A[6][0] = size;
  A[6][1] = size;
  A[6][2] = 1;
  A[6][6] = -size * corners.bottomRight.x;
  A[6][7] = -size * corners.bottomRight.x;
  A[7][3] = size;
  A[7][4] = size;
  A[7][5] = 1;
  A[7][6] = -size * corners.bottomRight.y;
  A[7][7] = -size * corners.bottomRight.y;

  const B = [
    corners.topLeft.x,
    corners.topLeft.y,
    corners.topRight.x,
    corners.topRight.y,
    corners.bottomLeft.x,
    corners.bottomLeft.y,
    corners.bottomRight.x,
    corners.bottomRight.y,
  ];

  // Least squares: (A^T A) lambda = A^T B — here A is square so direct solve.
  const lambda = solveLinearSystem(A, B);
  return {
    a: lambda[0],
    b: lambda[1],
    c: lambda[2],
    d: lambda[3],
    e: lambda[4],
    f: lambda[5],
    g: lambda[6],
    h: lambda[7],
  };
}

function extractSquareFromRegion(source, size, transform) {
  const { a, b, c, d, e, f, g, h } = transform;
  const result = GrayImage.withSize(size, size);
  for (let y = 0; y < size; y++) {
    const sxPre1 = b * y + c;
    const sxPre2 = h * y + 1;
    const syPre1 = e * y + f;
    const syPre2 = h * y + 1;
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((a * x + sxPre1) / (g * x + sxPre2));
      const sy = Math.floor((d * x + syPre1) / (g * x + syPre2));
      if (sx >= 0 && sy >= 0 && sx < source.width && sy < source.height) {
        result.bytes[y * size + x] = source.bytes[sy * source.width + sx];
      }
    }
  }
  return result;
}

/* ---------- extract digit boxes ---------- */

function extractBoxes(greyScale, thresholded) {
  const results = [];
  const size = greyScale.width;
  const boxSize = size / 9;
  const searchSize = boxSize / 5;
  const work = thresholded.clone();

  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      let minX = Infinity,
        minY = Infinity,
        maxX = 0,
        maxY = 0,
        pointsCount = 0;
      const searchX1 = x * boxSize + searchSize;
      const searchY1 = y * boxSize + searchSize;
      const searchX2 = x * boxSize + boxSize - searchSize;
      const searchY2 = y * boxSize + boxSize - searchSize;
      for (let searchY = searchY1 | 0; searchY < searchY2; searchY++) {
        for (let searchX = searchX1 | 0; searchX < searchX2; searchX++) {
          if (work.bytes[searchY * size + searchX] === 255) {
            const component = getConnectedComponent(work, searchX, searchY);
            const foundWidth = component.bounds.bottomRight.x - component.bounds.topLeft.x;
            const foundHeight = component.bounds.bottomRight.y - component.bounds.topLeft.y;
            if (
              component.points.length > 10 &&
              foundWidth < boxSize &&
              foundHeight < boxSize
            ) {
              minX = Math.min(minX, component.bounds.topLeft.x);
              minY = Math.min(minY, component.bounds.topLeft.y);
              maxX = Math.max(maxX, component.bounds.bottomRight.x);
              maxY = Math.max(maxY, component.bounds.bottomRight.y);
              pointsCount += component.points.length;
            }
          }
        }
      }
      const foundWidth = maxX - minX;
      const foundHeight = maxY - minY;
      if (
        pointsCount > 10 &&
        foundWidth < boxSize &&
        foundHeight < boxSize &&
        foundWidth > boxSize / 10 &&
        foundHeight > boxSize / 3
      ) {
        const numberImage = greyScale.subImage(
          Math.max(0, minX - 2),
          Math.max(0, minY - 2),
          Math.min(size - 1, maxX + 2),
          Math.min(size - 1, maxY + 2)
        );
        results.push({ x, y, numberImage, contents: 0, confidence: 0 });
      }
    }
  }
  return results;
}

/* ---------- projection-peak fallback (screen / app photos) ---------- */

function findGridByLinePeaks(w, h, gray) {
  const rowGrad = new Float32Array(h);
  const colGrad = new Float32Array(w);
  const step = Math.max(1, Math.floor(Math.max(w, h) / 800));
  for (let y = 1; y < h - 1; y += step) {
    for (let x = 1; x < w - 1; x += step) {
      rowGrad[y] += Math.abs(gray[(y + 1) * w + x] - gray[(y - 1) * w + x]);
      colGrad[x] += Math.abs(gray[y * w + (x + 1)] - gray[y * w + (x - 1)]);
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
  const yLo = portrait ? Math.floor(h * 0.08) : 2;
  const yHiFrac = portrait ? 0.65 : 0.95;

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
        let sc = rs + cs + cell * 0.8;
        if (portrait) sc += (1 - y0 / h) * 80;
        if (sc > bestSc) {
          bestSc = sc;
          best = { x: x0, y: y0, s: span };
        }
      }
    }
  }
  if (!best) return null;
  const inset = Math.max(1, Math.floor(best.s * 0.012));
  return {
    x: best.x + inset,
    y: best.y + inset,
    s: Math.max(90, best.s - inset * 2),
  };
}

function extractFromAxisAlignedRect(image, rect) {
  const size = PROCESSING_SIZE;
  const result = GrayImage.withSize(size, size);
  for (let y = 0; y < size; y++) {
    const sy = Math.min(image.height - 1, Math.floor(rect.y + (y / size) * rect.s));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(image.width - 1, Math.floor(rect.x + (x / size) * rect.s));
      result.bytes[y * size + x] = image.bytes[sy * image.width + sx];
    }
  }
  return result;
}

/* ---------- TF.js digit model ---------- */

let _model = null;
let _modelPromise = null;
let _tf = null;

async function loadTf() {
  if (_tf) return _tf;
  _tf = await import("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/+esm");
  return _tf;
}

async function loadDigitModel() {
  if (_model) return _model;
  if (_modelPromise) return _modelPromise;
  _modelPromise = (async () => {
    const tf = await loadTf();
    // Prefer webgl; fall back to cpu.
    try {
      await tf.setBackend("webgl");
    } catch {
      await tf.setBackend("cpu");
    }
    await tf.ready();
    const base = new URL("../models/digit-cnn/model.json", import.meta.url).href;
    _model = await tf.loadLayersModel(base);
    // Warm-up
    const dummy = tf.zeros([1, IMAGE_SIZE, IMAGE_SIZE, 1]);
    _model.predict(dummy).dispose();
    dummy.dispose();
    return _model;
  })();
  try {
    return await _modelPromise;
  } catch (e) {
    _modelPromise = null;
    throw e;
  }
}

async function classifyBoxes(boxes) {
  if (!boxes.length) return;
  const tf = await loadTf();
  const model = await loadDigitModel();

  const logits = tf.tidy(() => {
    const images = boxes.map((box) => {
      const img = tf.browser
        .fromPixels(box.numberImage.toImageData(), 1)
        .resizeBilinear([IMAGE_SIZE, IMAGE_SIZE])
        .toFloat();
      const mean = img.mean();
      const std = tf.moments(img).variance.sqrt().add(1e-6);
      const normalized = img.sub(mean).div(std);
      return normalized.reshape([1, IMAGE_SIZE, IMAGE_SIZE, 1]);
    });
    const input = tf.concat(images);
    return model.predict(input, { batchSize: boxes.length });
  });

  const arr = await logits.array();
  logits.dispose();

  arr.forEach((values, index) => {
    let maxProb = 0;
    let maxIndex = 0;
    for (let i = 0; i < values.length; i++) {
      if (values[i] > maxProb) {
        maxProb = values[i];
        maxIndex = i;
      }
    }
    boxes[index].contents = CLASSES[maxIndex];
    boxes[index].confidence = Math.round(maxProb * 100);
  });
}

/* ---------- conflict resolution ---------- */

function resolveConflicts(cells) {
  const out = cells.map((c) => ({ ...c }));
  const clearPair = (i, j) => {
    const a = out[i];
    const b = out[j];
    if ((a.confidence || 0) < (b.confidence || 0)) out[i] = { digit: 0, confidence: 0 };
    else out[j] = { digit: 0, confidence: 0 };
  };
  const check = (indices) => {
    const seen = new Map();
    for (const i of indices) {
      const v = out[i].digit;
      if (!v) continue;
      if (seen.has(v)) clearPair(i, seen.get(v));
      else seen.set(v, i);
    }
  };
  for (let r = 0; r < 9; r++) check(Array.from({ length: 9 }, (_, c) => r * 9 + c));
  for (let c = 0; c < 9; c++) check(Array.from({ length: 9 }, (_, r) => r * 9 + c));
  for (let br = 0; br < 3; br++) {
    for (let bc = 0; bc < 3; bc++) {
      const idx = [];
      for (let r = br * 3; r < br * 3 + 3; r++)
        for (let c = bc * 3; c < bc * 3 + 3; c++) idx.push(r * 9 + c);
      check(idx);
    }
  }
  return out;
}

/* ---------- main analyze API ---------- */

/**
 * Analyze a video frame or HTMLImageElement / canvas.
 * @returns {Promise<{cells: {digit:number, confidence:number}[], method: string, boardPreview: HTMLCanvasElement|null}>}
 */
export async function analyzeSudoku(source, onProgress) {
  const progress = (msg) => {
    if (onProgress) onProgress(msg);
  };

  progress("Loading digit model…");
  await loadDigitModel();

  progress("Capturing image…");
  const { image } = captureFromSource(source);

  let extractedGrey = null;
  let method = "";

  // --- Primary: blob + perspective (atomic14) ---
  progress("Finding puzzle board…");
  const minDim = Math.min(image.width, image.height);
  for (const thr of [15, 20, 25, 12, 30]) {
    const thresholded = adaptiveThreshold(image.clone(), thr, 20);
    const largest = getLargestConnectedComponent(thresholded, {
      minAspectRatio: 0.5,
      maxAspectRatio: 1.5,
      minSize: minDim * 0.25,
      maxSize: minDim * 0.98,
    });
    if (!largest) continue;
    const corners = getCornerPoints(largest);
    if (!sanityCheckCorners(corners)) continue;
    try {
      const transform = findHomographicTransform(PROCESSING_SIZE, corners);
      extractedGrey = extractSquareFromRegion(image, PROCESSING_SIZE, transform);
      method = `perspective (thr=${thr})`;
      break;
    } catch {
      /* try next threshold */
    }
  }

  // --- Fallback: line peaks (screen / centered boards) ---
  if (!extractedGrey) {
    progress("Trying line-based grid find…");
    const rect = findGridByLinePeaks(image.width, image.height, image.bytes);
    if (rect) {
      extractedGrey = extractFromAxisAlignedRect(image, rect);
      method = "line-peaks";
    }
  }

  if (!extractedGrey) {
    // Last resort: centered square
    const side = Math.min(image.width, image.height);
    const x = Math.floor((image.width - side) / 2);
    const y = Math.floor((image.height - side) / 2);
    extractedGrey = extractFromAxisAlignedRect(image, { x, y, s: side });
    method = "center-crop";
  }

  progress("Extracting digits…");
  const thresholdedBoard = adaptiveThreshold(extractedGrey.clone(), 20, 20);
  let boxes = extractBoxes(extractedGrey, thresholdedBoard);

  // Retry threshold if too few / too many boxes
  if (boxes.length < MIN_BOXES || boxes.length > 55) {
    for (const thr of [12, 18, 25, 30]) {
      const t2 = adaptiveThreshold(extractedGrey.clone(), thr, 16);
      const b2 = extractBoxes(extractedGrey, t2);
      if (b2.length >= MIN_BOXES && b2.length <= 55 && Math.abs(b2.length - 30) < Math.abs(boxes.length - 30)) {
        boxes = b2;
      }
    }
  }

  progress(`Classifying ${boxes.length} cells…`);
  // Drop very low-confidence after classify by thresholding softmax later
  await classifyBoxes(boxes);

  const cells = Array.from({ length: 81 }, () => ({ digit: 0, confidence: 100 }));
  for (const box of boxes) {
    const i = box.y * 9 + box.x;
    // Softmax conf: accept >= 55 typically; keep low-conf for UI highlight
    if (box.contents > 0 && box.confidence >= 40) {
      cells[i] = { digit: box.contents, confidence: box.confidence };
    } else if (box.contents > 0) {
      cells[i] = { digit: box.contents, confidence: box.confidence };
    }
  }

  const cleaned = resolveConflicts(cells);

  // Board preview for debug / UI
  const boardPreview = document.createElement("canvas");
  boardPreview.width = PROCESSING_SIZE;
  boardPreview.height = PROCESSING_SIZE;
  const pctx = boardPreview.getContext("2d");
  pctx.putImageData(extractedGrey.toImageData(), 0, 0);

  return { cells: cleaned, method, boardPreview, boxCount: boxes.length };
}

export function warmVision() {
  return loadDigitModel().catch((e) => console.warn("Digit model warm-up failed", e));
}
