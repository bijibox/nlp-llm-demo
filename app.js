const canvas = document.getElementById("spaceCanvas");
const ctx = canvas.getContext("2d");

const textInput = document.getElementById("textInput");
const addWordsButton = document.getElementById("addWordsButton");
const randomizeButton = document.getElementById("randomizeButton");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const windowSizeInput = document.getElementById("windowSizeInput");
const lineBreaksInput = document.getElementById("lineBreaksInput");
const speedInput = document.getElementById("speedInput");
const stepInput = document.getElementById("stepInput");
const repulsionInput = document.getElementById("repulsionInput");
const minDistanceInput = document.getElementById("minDistanceInput");
const wordCount = document.getElementById("wordCount");
const tokenCount = document.getElementById("tokenCount");
const activeWindow = document.getElementById("activeWindow");
const graphHint = document.getElementById("graphHint");

const minSpaceScale = 0.28;
const maxSpaceScale = 8;
const placementSize = 10;
const placementLimit = placementSize / 2;
const maxLayoutCoordinate = 80;
const maxLayoutPairsPerStep = 2600;
const maxNegativeSamplesPerActiveWord = 5;
const maxExplicitNegativePairsPerStep = 48;
const gridStep = 1;

const state = {
  mode: "2d",
  words: new Map(),
  tokens: [],
  tokenLines: [],
  running: false,
  cursor: 0,
  layoutStep: 0,
  stepAccumulator: 0,
  activeTokens: [],
  activePairKeys: new Set(),
  negativePairEvents: [],
  width: 0,
  height: 0,
  dpr: 1,
  spaceScale: 1,
  viewX: 0,
  viewY: 0,
  angleX: -0.58,
  angleY: 0.72,
  drag: null,
  pointers: new Map(),
  pinch: null,
  lastFrameAt: performance.now(),
};

const textTemplates = Object.fromEntries(
  [...document.querySelectorAll("[data-text-template]")].map((template) => [
    template.dataset.textTemplate,
    template.content.textContent.trim(),
  ]),
);

textInput.value = textTemplates.base;

function tokenizeLine(text) {
  return (text.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || [])
    .map((token) => token.trim())
    .filter(Boolean);
}

function tokenizeTextByLine(text) {
  return text.split(/\r\n?|\n/).map(tokenizeLine);
}

function tokenize(text) {
  return tokenizeTextByLine(text).flat();
}

function parseTextTraining(text) {
  const tokenLines = [];
  const negativePairEvents = [];
  const negativeMarkerPattern = /(^|\s)(?:!=|≠|!)(?=\s|$)/;

  for (const rawLine of text.split(/\r\n?|\n/)) {
    const tokens = tokenizeLine(rawLine);
    if (!tokens.length) {
      tokenLines.push([]);
      continue;
    }

    if (negativeMarkerPattern.test(rawLine) && tokens.length >= 2) {
      for (let index = 0; index < tokens.length - 1; index += 2) {
        const first = tokens[index];
        const second = tokens[index + 1];
        if (first !== second) negativePairEvents.push({ first, second });
      }
      continue;
    }

    tokenLines.push(tokens);
  }

  return { tokenLines, negativePairEvents };
}

function clampNumber(input, fallback) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) return fallback;
  const min = Number(input.min);
  const max = Number(input.max);
  return Math.min(Math.max(value, min), max);
}

function getPlacementBounds() {
  return {
    x: placementLimit,
    y: placementLimit,
    z: placementLimit,
  };
}

function randomPosition() {
  const bounds = getPlacementBounds();
  return {
    x: (Math.random() * 2 - 1) * bounds.x,
    y: (Math.random() * 2 - 1) * bounds.y,
    z: state.mode === "3d" ? (Math.random() * 2 - 1) * bounds.z : 0,
  };
}

function addWord(word) {
  if (state.words.has(word)) return false;
  state.words.set(word, {
    word,
    ...randomPosition(),
    age: performance.now(),
  });
  return true;
}

function pruneEdges(wordsInText) {
  for (const key of [...state.activePairKeys]) {
    const [first, second] = key.split("\u0000");
    if (!wordsInText.has(first) || !wordsInText.has(second)) state.activePairKeys.delete(key);
  }
}

function updateTemplateButtons() {
  document.querySelectorAll(".template-button").forEach((button) => {
    button.classList.toggle("active", textInput.value === textTemplates[button.dataset.template]);
  });
}

function buildWordUpdateMessage(added, removed, stoppedProcessing) {
  const stopNotice = stoppedProcessing ? ". Обработка остановлена: нужно минимум два слова." : "";

  if (!state.tokens.length) {
    return `Текст пуст: пространство очищено${stopNotice}`;
  }

  const changes = [];
  if (added) changes.push(`добавлено: ${added}`);
  if (removed) changes.push(`удалено: ${removed}`);
  if (!changes.length) changes.push("состав не изменился");

  return `Слова обновлены: ${changes.join(", ")}${stopNotice}`;
}

function updateWordsFromText({ announce = true, resetCursor = true } = {}) {
  const training = parseTextTraining(textInput.value);
  state.tokenLines = training.tokenLines;
  state.tokens = state.tokenLines.flat();
  state.negativePairEvents = training.negativePairEvents;

  const wordsInText = new Set(state.tokens);
  for (const pair of state.negativePairEvents) {
    wordsInText.add(pair.first);
    wordsInText.add(pair.second);
  }

  let added = 0;

  for (const token of wordsInText) {
    if (addWord(token)) added += 1;
  }

  let removed = 0;
  for (const word of [...state.words.keys()]) {
    if (!wordsInText.has(word)) {
      state.words.delete(word);
      removed += 1;
    }
  }

  pruneEdges(wordsInText);

  if (resetCursor) {
    state.cursor = 0;
    state.layoutStep = 0;
  } else {
    const cursorLimit = getCursorLimit();
    if (state.cursor >= cursorLimit) state.cursor = cursorLimit ? state.cursor % cursorLimit : 0;
  }

  let stoppedProcessing = false;
  if (state.running && state.tokens.length < 2) {
    state.running = false;
    state.stepAccumulator = 0;
    state.activeTokens = [];
    state.activePairKeys.clear();
    startButton.disabled = false;
    stopButton.disabled = true;
    stoppedProcessing = true;
  } else if (state.running) {
    state.activeTokens = buildActiveWindow();
    state.activePairKeys.clear();
  } else {
    state.activeTokens = [];
    state.activePairKeys.clear();
  }

  updateTemplateButtons();

  if (announce) {
    updateStatus(buildWordUpdateMessage(added, removed, stoppedProcessing));
  }

  return { added, removed, stoppedProcessing };
}

function randomizeWords() {
  if (!state.words.size) {
    updateStatus("Сначала обновите слова");
    return;
  }

  for (const word of state.words.values()) {
    Object.assign(word, randomPosition());
  }

  if (state.mode === "2d") flattenTo2d();
  state.layoutStep = 0;
  resetView();
  updateStatus("Слова случайно разбросаны в стартовой области 10×10");
}

function getWindowSize() {
  return Math.round(clampNumber(windowSizeInput, 3));
}

function shouldKeepWindowsWithinLine() {
  return lineBreaksInput.checked;
}

function getStepsPerSecond() {
  return Math.round(clampNumber(speedInput, 60));
}

function getMovementStep() {
  return clampNumber(stepInput, 0.05);
}

function getRepulsionStep() {
  return clampNumber(repulsionInput, 0.02);
}

function getMinDistance() {
  return clampNumber(minDistanceInput, 1.5);
}

function buildLineWindowStarts() {
  const requestedSize = getWindowSize();
  const starts = [];

  for (let lineIndex = 0; lineIndex < state.tokenLines.length; lineIndex += 1) {
    const tokens = state.tokenLines[lineIndex];
    const size = Math.min(requestedSize, tokens.length);
    if (!size) continue;

    const lastStart = tokens.length - size;
    for (let tokenIndex = 0; tokenIndex <= lastStart; tokenIndex += 1) {
      starts.push({ lineIndex, tokenIndex });
    }
  }

  return starts;
}

function getCursorLimit() {
  if (shouldKeepWindowsWithinLine()) return buildLineWindowStarts().length;
  return state.tokens.length;
}

function buildFlatActiveWindow() {
  const tokens = state.tokens;
  if (!tokens.length) return [];

  const size = Math.min(getWindowSize(), tokens.length);
  const windowTokens = [];
  for (let index = 0; index < size; index += 1) {
    windowTokens.push(tokens[(state.cursor + index) % tokens.length]);
  }
  return windowTokens;
}

function buildLineBoundedActiveWindow() {
  const starts = buildLineWindowStarts();
  if (!starts.length) return [];

  const { lineIndex, tokenIndex } = starts[state.cursor % starts.length];
  const tokens = state.tokenLines[lineIndex] || [];
  const size = Math.min(getWindowSize(), tokens.length);
  return tokens.slice(tokenIndex, tokenIndex + size);
}

function buildActiveWindow() {
  return shouldKeepWindowsWithinLine() ? buildLineBoundedActiveWindow() : buildFlatActiveWindow();
}

function getPairKey(first, second) {
  return first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`;
}

function resetAssociations() {
  state.activePairKeys.clear();
}

function buildActivePairs() {
  const pairs = new Map();
  state.activePairKeys.clear();

  for (let index = 0; index < state.activeTokens.length - 1; index += 1) {
    for (let secondIndex = index + 1; secondIndex < state.activeTokens.length; secondIndex += 1) {
      const first = state.activeTokens[index];
      const second = state.activeTokens[secondIndex];
      if (first === second) continue;

      const key = getPairKey(first, second);
      const gap = secondIndex - index;
      const strength = 1 / gap;
      const current = pairs.get(key);

      if (!current || strength > current.strength) {
        pairs.set(key, { first, second, strength });
      }
      state.activePairKeys.add(key);
    }
  }

  return [...pairs.values()];
}

// Нет постоянного графа связей. Эта функция только помечает пары текущего окна,
// чтобы интерфейс и раскладка знали, какие слова взаимодействуют на данном шаге.
function reinforceActiveEdges() {
  buildActivePairs();
}

function flattenTo2d() {
  for (const word of state.words.values()) {
    word.z = 0;
  }
}

function addDepthFor3d() {
  const words = [...state.words.values()];
  if (!words.length || words.some((word) => Math.abs(word.z) > 0.001)) return;

  for (const word of words) {
    word.z = (Math.random() - 0.5) * 0.9;
  }
}

function clampAxis(word, positionKey, limit) {
  if (word[positionKey] > limit) {
    word[positionKey] = limit;
  } else if (word[positionKey] < -limit) {
    word[positionKey] = -limit;
  }
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextHash(seed) {
  return (Math.imul(seed, 1664525) + 1013904223) >>> 0;
}

function getNegativeSampleCount() {
  return Math.max(1, Math.min(maxNegativeSamplesPerActiveWord, Math.round(1 + getRepulsionStep() * 4)));
}

function applyLayoutStep() {
  const wordNames = [...state.words.keys()];
  if (wordNames.length < 2) return;

  const is3d = state.mode === "3d";
  const attractionRate = getMovementStep() * 0.075;
  const repulsionRate = getRepulsionStep() * 0.055;
  const minDistance = getMinDistance();
  const clusterDistance = Math.max(minDistance, 0.35);
  const negativeDistance = clusterDistance * (3.6 + getRepulsionStep() * 1.35);
  const explicitNegativeDistance = clusterDistance * (4.5 + getRepulsionStep() * 1.55);
  const collisionDistance = clusterDistance * 0.92;
  const negativeSampleCount = getNegativeSampleCount();
  const activeSet = new Set(state.activeTokens);
  const activePairs = buildActivePairs();
  const activePairStrength = new Map(activePairs.map((pair) => [getPairKey(pair.first, pair.second), pair.strength]));
  const deltas = new Map(
    wordNames.map((word) => [
      word,
      {
        x: 0,
        y: 0,
        z: 0,
      },
    ]),
  );

  function clampValue(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function addDelta(word, x, y, z) {
    const delta = deltas.get(word);
    if (!delta) return;
    delta.x += x;
    delta.y += y;
    if (is3d) delta.z += z;
  }

  function getPairVector(a, b, firstIndex, secondIndex) {
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    let dz = is3d ? b.z - a.z : 0;
    let distance = Math.hypot(dx, dy, dz);

    if (distance < 0.0001) {
      const seed = (firstIndex + 1) * 97 + (secondIndex + 1) * 37 + a.word.length * 11 + b.word.length * 19;
      const angle = seed * 0.017;
      dx = Math.cos(angle) * 0.0001;
      dy = Math.sin(angle) * 0.0001;
      dz = is3d ? Math.sin(angle * 0.7) * 0.0001 : 0;
      distance = Math.hypot(dx, dy, dz);
    }

    return {
      dx,
      dy,
      dz,
      distance,
      nx: dx / distance,
      ny: dy / distance,
      nz: dz / distance,
    };
  }

  // Положительные примеры: только пары из текущего окна временно притягиваются.
  // Информация о прошлом не хранится в ребрах; она остается только в координатах слов.
  for (const pair of activePairs) {
    const a = state.words.get(pair.first);
    const b = state.words.get(pair.second);
    if (!a || !b || a === b) continue;

    const vector = getPairVector(a, b, pair.first.length, pair.second.length);
    const target = clusterDistance * (0.94 + (1 - pair.strength) * 0.56);
    const spring = (vector.distance - target) * attractionRate * (0.7 + pair.strength * 0.75);
    const force = clampValue(spring, -repulsionRate * 0.25, attractionRate * 2.8);

    addDelta(pair.first, vector.nx * force, vector.ny * force, vector.nz * force);
    addDelta(pair.second, -vector.nx * force, -vector.ny * force, -vector.nz * force);
  }

  function pushPairApart(first, second, target, scale, cap) {
    const a = state.words.get(first);
    const b = state.words.get(second);
    if (!a || !b || a === b) return;

    const vector = getPairVector(a, b, first.length, second.length);
    if (vector.distance >= target) return;

    const push = Math.min((target - vector.distance) * repulsionRate * scale, repulsionRate * cap);
    if (push <= 0) return;

    addDelta(first, -vector.nx * push, -vector.ny * push, -vector.nz * push);
    addDelta(second, vector.nx * push, vector.ny * push, vector.nz * push);
  }

  // Отрицательные примеры теперь не перебирают все неактивные слова.
  // Это важно: иначе почти каждая родственная пара чаще получает отталкивание,
  // чем притяжение, потому что два слова редко активны одновременно.
  const uniqueActiveWords = [...activeSet].filter((word) => state.words.has(word));

  for (const word of uniqueActiveWords) {
    let seed = hashString(`${word}\u0000${state.layoutStep}`);
    const usedSamples = new Set([word, ...activeSet]);
    let picked = 0;
    let attempts = 0;

    while (picked < negativeSampleCount && attempts < wordNames.length * 3 && usedSamples.size < wordNames.length) {
      seed = nextHash(seed);
      attempts += 1;

      const candidate = wordNames[seed % wordNames.length];
      if (usedSamples.has(candidate)) continue;
      if (activePairStrength.has(getPairKey(word, candidate))) continue;

      pushPairApart(word, candidate, negativeDistance, 0.34, 1.15);
      usedSamples.add(candidate);
      picked += 1;
    }
  }

  // Явные отрицательные обучающие события: строки вида "лево != право".
  // Это не постоянные ребра графа; это такие же временные тренировочные события,
  // как обычные положительные окна, только с обратным знаком.
  if (state.negativePairEvents.length) {
    const limit = Math.min(state.negativePairEvents.length, maxExplicitNegativePairsPerStep);
    const startIndex = state.layoutStep % state.negativePairEvents.length;

    for (let offset = 0; offset < limit; offset += 1) {
      const pair = state.negativePairEvents[(startIndex + offset) % state.negativePairEvents.length];
      pushPairApart(pair.first, pair.second, explicitNegativeDistance, 1.05, 1.8);
    }
  }

  // Коллизионное отталкивание остается глобальным, но слабым и коротким.
  // Оно не должно учить семантике; оно только не дает точкам схлопнуться.
  const totalPairs = (wordNames.length * (wordNames.length - 1)) / 2;
  const pairStride = totalPairs > maxLayoutPairsPerStep ? Math.ceil(totalPairs / maxLayoutPairsPerStep) : 1;
  const pairPhase = pairStride > 1 ? state.cursor % pairStride : 0;
  let pairOrdinal = 0;

  for (let firstIndex = 0; firstIndex < wordNames.length; firstIndex += 1) {
    const first = wordNames[firstIndex];
    const a = state.words.get(first);
    if (!a) continue;

    for (let secondIndex = firstIndex + 1; secondIndex < wordNames.length; secondIndex += 1) {
      const includePair = pairStride === 1 || pairOrdinal % pairStride === pairPhase;
      pairOrdinal += 1;
      if (!includePair) continue;

      const second = wordNames[secondIndex];
      const b = state.words.get(second);
      if (!b) continue;

      const key = getPairKey(first, second);
      const vector = getPairVector(a, b, firstIndex, secondIndex);
      if (vector.distance >= collisionDistance) continue;

      const isPositiveNow = activePairStrength.has(key);
      const scale = isPositiveNow ? 0.06 : 0.16;
      const push = Math.min((collisionDistance - vector.distance) * repulsionRate * scale, repulsionRate * 0.35);
      if (push <= 0) continue;

      addDelta(first, -vector.nx * push, -vector.ny * push, -vector.nz * push);
      addDelta(second, vector.nx * push, vector.ny * push, vector.nz * push);
    }
  }

  // Мягкое удержание около центра нужно не для масштаба пространства, а чтобы
  // учебные примеры не улетали далеко при длительной обработке.
  const centerPull = 0.0005;
  const maxDelta = Math.max(0.075, clusterDistance * 0.22);

  for (const [wordName, delta] of deltas) {
    const word = state.words.get(wordName);
    if (!word) continue;

    delta.x -= word.x * centerPull;
    delta.y -= word.y * centerPull;
    if (is3d) delta.z -= word.z * centerPull;

    const length = Math.hypot(delta.x, delta.y, is3d ? delta.z : 0);
    if (length > maxDelta) {
      const factor = maxDelta / length;
      delta.x *= factor;
      delta.y *= factor;
      delta.z *= factor;
    }

    word.x += delta.x;
    word.y += delta.y;
    word.z = is3d ? word.z + delta.z : 0;

    clampAxis(word, "x", maxLayoutCoordinate);
    clampAxis(word, "y", maxLayoutCoordinate);
    if (is3d) clampAxis(word, "z", maxLayoutCoordinate);
  }

  state.layoutStep += 1;
}

function runSimulationSteps(dt) {
  if (!state.running || !state.tokens.length) return;

  const cursorLimit = getCursorLimit();
  if (!cursorLimit) return;

  const stepsPerSecond = getStepsPerSecond();
  state.stepAccumulator = Math.min(state.stepAccumulator + dt * stepsPerSecond, stepsPerSecond);
  const steps = Math.min(Math.floor(state.stepAccumulator), 30);

  if (!steps) return;

  for (let index = 0; index < steps; index += 1) {
    state.activeTokens = buildActiveWindow();
    reinforceActiveEdges();
    applyLayoutStep();
    state.cursor = (state.cursor + 1) % cursorLimit;
  }

  state.stepAccumulator -= steps;
  updateStatus();
}

function project2d(point) {
  const scale = getCoordinateScale();
  return {
    x: state.width / 2 + (point.x - state.viewX) * scale,
    y: state.height / 2 + (point.y - state.viewY) * scale,
    depth: 0,
    scale: 1,
  };
}

function rotate3d(point) {
  const cy = Math.cos(state.angleY);
  const sy = Math.sin(state.angleY);
  const cx = Math.cos(state.angleX);
  const sx = Math.sin(state.angleX);

  const x1 = point.x * cy - point.z * sy;
  const z1 = point.x * sy + point.z * cy;
  const y1 = point.y * cx - z1 * sx;
  const z2 = point.y * sx + z1 * cx;

  return { x: x1, y: y1, z: z2 };
}

function getCoordinateScale() {
  const basis = Math.max(1, Math.min(state.width || 1, state.height || 1));
  return (basis * 0.9 * state.spaceScale) / placementSize;
}

function getVisible2dBounds(padding = 0) {
  const scale = getCoordinateScale();
  const halfWidth = state.width / (2 * scale);
  const halfHeight = state.height / (2 * scale);

  return {
    left: state.viewX - halfWidth - padding,
    right: state.viewX + halfWidth + padding,
    top: state.viewY - halfHeight - padding,
    bottom: state.viewY + halfHeight + padding,
  };
}

function getAxisLimit() {
  const bounds = getVisible2dBounds(0);
  return Math.max(
    placementLimit,
    Math.ceil(Math.max(Math.abs(bounds.left), Math.abs(bounds.right), Math.abs(bounds.top), Math.abs(bounds.bottom))),
  );
}

function project3d(point) {
  const rotated = rotate3d(point);
  const camera = 34;
  const perspective = camera / (camera - rotated.z);
  const scale = getCoordinateScale();

  return {
    x: state.width / 2 + (rotated.x - state.viewX) * scale * perspective,
    y: state.height / 2 + (rotated.y - state.viewY) * scale * perspective,
    depth: rotated.z,
    scale: perspective,
  };
}

function project(point) {
  return state.mode === "3d" ? project3d(point) : project2d(point);
}

function drawGrid() {
  ctx.clearRect(0, 0, state.width, state.height);

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = "#e3e8f1";

  if (state.mode === "2d") {
    const bounds = getVisible2dBounds(1);
    const xStart = Math.floor(bounds.left / gridStep) * gridStep;
    const xEnd = Math.ceil(bounds.right / gridStep) * gridStep;
    const yStart = Math.floor(bounds.top / gridStep) * gridStep;
    const yEnd = Math.ceil(bounds.bottom / gridStep) * gridStep;

    ctx.strokeStyle = "#e3e8f1";
    for (let value = xStart; value <= xEnd; value += gridStep) {
      const lineStart = project2d({ x: value, y: bounds.top });
      const lineEnd = project2d({ x: value, y: bounds.bottom });
      ctx.beginPath();
      ctx.moveTo(lineStart.x, lineStart.y);
      ctx.lineTo(lineEnd.x, lineEnd.y);
      ctx.stroke();
    }

    for (let value = yStart; value <= yEnd; value += gridStep) {
      const lineStart = project2d({ x: bounds.left, y: value });
      const lineEnd = project2d({ x: bounds.right, y: value });
      ctx.beginPath();
      ctx.moveTo(lineStart.x, lineStart.y);
      ctx.lineTo(lineEnd.x, lineEnd.y);
      ctx.stroke();
    }

    ctx.strokeStyle = "#b9c4d7";
    ctx.beginPath();
    if (bounds.top <= 0 && bounds.bottom >= 0) {
      const xAxisStart = project2d({ x: bounds.left, y: 0 });
      const xAxisEnd = project2d({ x: bounds.right, y: 0 });
      ctx.moveTo(xAxisStart.x, xAxisStart.y);
      ctx.lineTo(xAxisEnd.x, xAxisEnd.y);
    }
    if (bounds.left <= 0 && bounds.right >= 0) {
      const yAxisStart = project2d({ x: 0, y: bounds.top });
      const yAxisEnd = project2d({ x: 0, y: bounds.bottom });
      ctx.moveTo(yAxisStart.x, yAxisStart.y);
      ctx.lineTo(yAxisEnd.x, yAxisEnd.y);
    }
    ctx.stroke();
  } else {
    const axisLimit = getAxisLimit();
    const axes = [
      {
        color: "#0b6f85",
        from: { x: -axisLimit, y: 0, z: 0 },
        to: { x: axisLimit, y: 0, z: 0 },
        label: "X",
      },
      {
        color: "#d35f2d",
        from: { x: 0, y: -axisLimit, z: 0 },
        to: { x: 0, y: axisLimit, z: 0 },
        label: "Y",
      },
      {
        color: "#667085",
        from: { x: 0, y: 0, z: -axisLimit },
        to: { x: 0, y: 0, z: axisLimit },
        label: "Z",
      },
    ];

    ctx.font = "12px Inter, system-ui, sans-serif";
    for (const axis of axes) {
      const from = project3d(axis.from);
      const to = project3d(axis.to);
      ctx.strokeStyle = axis.color;
      ctx.fillStyle = axis.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
      ctx.fillText(axis.label, to.x + 6, to.y + 4);
    }
  }

  ctx.restore();
}

function drawWords() {
  const activeSet = new Set(state.activeTokens);
  const entries = [...state.words.values()]
    .map((word) => ({ word, screen: project(word) }))
    .sort((a, b) => a.screen.depth - b.screen.depth);
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const entry of entries) {
    const { word, screen } = entry;
    const isActive = activeSet.has(word.word);
    const radius = isActive ? 8 + screen.scale * 1.6 : 5.8 + screen.scale;
    const fontSize = Math.max(11, Math.min(16, 12.5 * screen.scale));

    ctx.beginPath();
    ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? "#d35f2d" : "#0b6f85";
    ctx.fill();
    ctx.lineWidth = isActive ? 4 : 2;
    ctx.strokeStyle = isActive ? "rgba(255, 226, 212, 0.95)" : "rgba(255,255,255,0.95)";
    ctx.stroke();

    const labelY = screen.y - radius - 12;
    ctx.font = `650 ${fontSize}px Inter, system-ui, sans-serif`;
    const labelWidth = ctx.measureText(word.word).width + 12;
    ctx.fillStyle = isActive ? "rgba(255, 226, 212, 0.92)" : "rgba(255,255,255,0.86)";
    ctx.fillRect(screen.x - labelWidth / 2, labelY - fontSize / 2 - 3, labelWidth, fontSize + 6);
    ctx.strokeStyle = isActive ? "rgba(211, 95, 45, 0.32)" : "rgba(184, 193, 211, 0.55)";
    ctx.strokeRect(screen.x - labelWidth / 2, labelY - fontSize / 2 - 3, labelWidth, fontSize + 6);
    ctx.fillStyle = isActive ? "#8d3717" : "#172033";
    ctx.fillText(word.word, screen.x, labelY);
  }

  ctx.restore();
}

function drawCenteredWrappedText(text, centerX, startY, maxWidth, lineHeight) {
  const words = text.split(" ");
  const lines = [];
  let line = "";

  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= maxWidth || !line) {
      line = next;
    } else {
      lines.push(line);
      line = word;
    }
  }

  if (line) lines.push(line);

  for (let index = 0; index < lines.length; index += 1) {
    ctx.fillText(lines[index], centerX, startY + index * lineHeight);
  }
}

function drawEmptyState() {
  if (state.words.size) return;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#657086";
  const maxWidth = Math.max(220, state.width - 48);
  ctx.font = "650 18px Inter, system-ui, sans-serif";
  ctx.fillText("Обновите слова из текста", state.width / 2, state.height / 2 - 12);
  ctx.font = "14px Inter, system-ui, sans-serif";
  drawCenteredWrappedText(
    "Каждое слово появится как точка в векторном пространстве",
    state.width / 2,
    state.height / 2 + 18,
    maxWidth,
    19,
  );
  ctx.restore();
}

function render(now) {
  const dt = Math.min((now - state.lastFrameAt) / 1000, 0.05);
  state.lastFrameAt = now;

  runSimulationSteps(dt);
  drawGrid();
  drawWords();
  drawEmptyState();

  requestAnimationFrame(render);
}

function resizeCanvas() {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(window.devicePixelRatio || 1, 2));

  state.width = Math.floor(rect.width);
  state.height = Math.floor(rect.height);
  state.dpr = dpr;

  canvas.width = Math.floor(rect.width * dpr);
  canvas.height = Math.floor(rect.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function updateStatus(message) {
  const tokenLength = tokenize(textInput.value).length;
  wordCount.textContent = `${state.words.size} слов в пространстве`;
  tokenCount.textContent = `${tokenLength} слов в тексте`;

  if (message) {
    graphHint.textContent = message;
  } else if (state.running) {
    graphHint.textContent =
      "Идет обработка: пары текущего окна временно сближаются; случайные отрицательные примеры и строки с != раздвигают точки. " +
      getNavigationHint();
  } else {
    graphHint.textContent = `Обновите слова, затем запустите обработку окна. ${getNavigationHint()}`;
  }

  if (state.running && state.activeTokens.length) {
    activeWindow.textContent = `Окно: ${state.activeTokens.join(" ")}`;
  } else {
    activeWindow.textContent = "Окно не активно";
  }
}

function startProcessing() {
  updateWordsFromText({ announce: false, resetCursor: true });
  if (state.tokens.length < 2) {
    updateStatus("Для обработки нужно минимум два слова в тексте");
    return;
  }

  state.running = true;
  state.cursor = 0;
  state.layoutStep = 0;
  state.stepAccumulator = 0;
  resetAssociations();
  state.activeTokens = buildActiveWindow();
  startButton.disabled = true;
  stopButton.disabled = false;
  updateStatus();
}

function stopProcessing() {
  state.running = false;
  state.activeTokens = [];
  state.activePairKeys.clear();
  state.stepAccumulator = 0;
  startButton.disabled = false;
  stopButton.disabled = true;
  updateStatus("Обработка остановлена: положение заморожено");
}

function getLineBreakModeMessage() {
  return shouldKeepWindowsWithinLine()
    ? "Переносы учитываются: окно слов остается внутри одной строки"
    : "Переносы игнорируются: окно слов идет по всему тексту";
}

function handleLineBreakModeChange() {
  state.cursor = 0;
  state.stepAccumulator = 0;
  state.activeTokens = state.running ? buildActiveWindow() : [];
  resetAssociations();
  updateStatus(getLineBreakModeMessage());
}

function getNavigationHint() {
  return state.mode === "3d"
    ? "Колесо — масштаб. Перетаскивание — поворот. Shift или правая кнопка — сдвиг."
    : "Колесо — масштаб. Перетаскивание — сдвиг пространства.";
}

function setMode(mode) {
  state.mode = mode;
  if (mode === "2d") {
    flattenTo2d();
  } else {
    addDepthFor3d();
  }

  document.querySelectorAll(".mode-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.mode === mode);
  });
  graphHint.textContent =
    mode === "3d"
      ? `3D режим: расчет идет в X/Y/Z. ${getNavigationHint()}`
      : `2D режим: расчет идет только в плоскости X/Y. ${getNavigationHint()}`;
}

function clampSpaceScale(value) {
  return Math.min(Math.max(value, minSpaceScale), maxSpaceScale);
}

function getCanvasPointFromClient(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: clientX - rect.left,
    y: clientY - rect.top,
  };
}

function getCanvasPoint(event) {
  return getCanvasPointFromClient(event.clientX, event.clientY);
}

function screenToViewWorld(screenX, screenY) {
  const scale = getCoordinateScale();
  return {
    x: state.viewX + (screenX - state.width / 2) / scale,
    y: state.viewY + (screenY - state.height / 2) / scale,
  };
}

function zoomAtCanvasPoint(nextScale, point) {
  const worldBefore = screenToViewWorld(point.x, point.y);
  state.spaceScale = clampSpaceScale(nextScale);
  const scaleAfter = getCoordinateScale();
  state.viewX = worldBefore.x - (point.x - state.width / 2) / scaleAfter;
  state.viewY = worldBefore.y - (point.y - state.height / 2) / scaleAfter;
}

function resetView() {
  state.viewX = 0;
  state.viewY = 0;
  state.spaceScale = 1;
}

function getPinchDistance() {
  if (state.pointers.size < 2) return 0;
  const points = [...state.pointers.values()];
  return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
}

function getPinchCenter() {
  const points = [...state.pointers.values()];
  return getCanvasPointFromClient((points[0].x + points[1].x) / 2, (points[0].y + points[1].y) / 2);
}

function startPinch() {
  const distance = getPinchDistance();
  if (!distance) return;
  state.drag = null;
  state.pinch = {
    distance,
    scale: state.spaceScale,
  };
}

function handlePointerDown(event) {
  event.preventDefault();
  try {
    canvas.focus({ preventScroll: true });
  } catch {
    canvas.focus();
  }
  canvas.setPointerCapture(event.pointerId);
  state.pointers.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY,
  });

  if (state.pointers.size >= 2) {
    startPinch();
    return;
  }

  const shouldRotate =
    state.mode === "3d" && event.button === 0 && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;

  state.drag = {
    kind: shouldRotate ? "rotate" : "pan",
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    viewX: state.viewX,
    viewY: state.viewY,
    angleX: state.angleX,
    angleY: state.angleY,
  };
}

function handlePointerMove(event) {
  if (state.pointers.has(event.pointerId)) {
    state.pointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
  }

  if (state.pinch && state.pointers.size >= 2) {
    const distance = getPinchDistance();
    if (distance) {
      zoomAtCanvasPoint(state.pinch.scale * (distance / state.pinch.distance), getPinchCenter());
    }
    return;
  }

  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - state.drag.x;
  const dy = event.clientY - state.drag.y;

  if (state.drag.kind === "pan") {
    const scale = getCoordinateScale();
    state.viewX = state.drag.viewX - dx / scale;
    state.viewY = state.drag.viewY - dy / scale;
    return;
  }

  state.angleY = state.drag.angleY + dx * 0.01;
  state.angleX = Math.max(-1.35, Math.min(1.35, state.drag.angleX + dy * 0.01));
}

function handlePointerUp(event) {
  state.pointers.delete(event.pointerId);

  if (state.drag?.pointerId === event.pointerId) {
    state.drag = null;
  }

  if (state.pinch && state.pointers.size < 2) {
    state.pinch = null;
  }
}

function handleCanvasWheel(event) {
  event.preventDefault();
  const point = getCanvasPoint(event);
  const modeMultiplier = event.deltaMode === 1 ? 0.055 : 0.0014;
  const zoomFactor = Math.exp(-event.deltaY * modeMultiplier);
  zoomAtCanvasPoint(state.spaceScale * zoomFactor, point);
}

function handleCanvasDoubleClick(event) {
  event.preventDefault();
  resetView();
  updateStatus("Навигация сброшена: центр и масштаб вернулись к стартовым значениям");
}

function handleCanvasKeyDown(event) {
  const panStep = (event.shiftKey ? 1.2 : 0.45) / state.spaceScale;
  const center = { x: state.width / 2, y: state.height / 2 };

  switch (event.key) {
    case "ArrowLeft":
      state.viewX -= panStep;
      break;
    case "ArrowRight":
      state.viewX += panStep;
      break;
    case "ArrowUp":
      state.viewY -= panStep;
      break;
    case "ArrowDown":
      state.viewY += panStep;
      break;
    case "+":
    case "=":
      zoomAtCanvasPoint(state.spaceScale * 1.12, center);
      break;
    case "-":
    case "_":
      zoomAtCanvasPoint(state.spaceScale / 1.12, center);
      break;
    case "0":
      resetView();
      updateStatus("Навигация сброшена: центр и масштаб вернулись к стартовым значениям");
      break;
    default:
      return;
  }

  event.preventDefault();
}

addWordsButton.addEventListener("click", () => updateWordsFromText());
randomizeButton.addEventListener("click", randomizeWords);
startButton.addEventListener("click", startProcessing);
stopButton.addEventListener("click", stopProcessing);
lineBreaksInput.addEventListener("change", handleLineBreakModeChange);

textInput.addEventListener("input", () => {
  updateTemplateButtons();
  updateStatus();
});

document.querySelectorAll(".template-button").forEach((button) => {
  button.addEventListener("click", () => {
    const template = textTemplates[button.dataset.template];
    if (!template) return;
    textInput.value = template;
    updateTemplateButtons();
    updateStatus("Пример выбран. Нажмите «Обновить слова», чтобы изменить пространство.");
  });
});

document.querySelectorAll(".mode-button").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

canvas.tabIndex = 0;
canvas.addEventListener("pointerdown", handlePointerDown);
canvas.addEventListener("pointermove", handlePointerMove);
canvas.addEventListener("pointerup", handlePointerUp);
canvas.addEventListener("pointercancel", handlePointerUp);
canvas.addEventListener("wheel", handleCanvasWheel, { passive: false });
canvas.addEventListener("dblclick", handleCanvasDoubleClick);
canvas.addEventListener("keydown", handleCanvasKeyDown);
canvas.addEventListener("contextmenu", (event) => event.preventDefault());

window.addEventListener("resize", resizeCanvas);

resizeCanvas();
updateStatus();
requestAnimationFrame(render);
