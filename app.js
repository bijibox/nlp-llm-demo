const canvas = document.getElementById("spaceCanvas");
const ctx = canvas.getContext("2d");

const textInput = document.getElementById("textInput");
const addWordsButton = document.getElementById("addWordsButton");
const randomizeButton = document.getElementById("randomizeButton");
const startButton = document.getElementById("startButton");
const stopButton = document.getElementById("stopButton");
const windowSizeInput = document.getElementById("windowSizeInput");
const speedInput = document.getElementById("speedInput");
const stepInput = document.getElementById("stepInput");
const repulsionInput = document.getElementById("repulsionInput");
const minDistanceInput = document.getElementById("minDistanceInput");
const wordCount = document.getElementById("wordCount");
const tokenCount = document.getElementById("tokenCount");
const activeWindow = document.getElementById("activeWindow");
const graphHint = document.getElementById("graphHint");

const minSpaceScale = 0.45;
const maxSpaceScale = 2.5;
const coordinateLimit = 10;

const state = {
  mode: "2d",
  words: new Map(),
  edges: new Map(),
  tokens: [],
  running: false,
  cursor: 0,
  stepAccumulator: 0,
  activeTokens: [],
  activeEdgeKeys: new Set(),
  activeNegativePairs: [],
  width: 0,
  height: 0,
  dpr: 1,
  spaceScale: 1,
  angleX: -0.58,
  angleY: 0.72,
  drag: null,
  pointers: new Map(),
  pinch: null,
  lastFrameAt: performance.now(),
};

const sampleText =
  "Модель языка читает текст и размещает слова в пространстве. " +
  "Слова рядом в тексте постепенно сближаются, поэтому похожие контексты образуют группы.";

textInput.value = sampleText;

function tokenize(text) {
  return (text.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]+(?:[-'][\p{L}\p{N}]+)*/gu) || [])
    .map((token) => token.trim())
    .filter(Boolean);
}

function clampNumber(input, fallback) {
  const value = Number(input.value);
  if (!Number.isFinite(value)) return fallback;
  const min = Number(input.min);
  const max = Number(input.max);
  return Math.min(Math.max(value, min), max);
}

function getWorldBounds() {
  return {
    x: coordinateLimit,
    y: coordinateLimit,
    z: coordinateLimit,
  };
}

function randomPosition() {
  const bounds = getWorldBounds();
  return {
    x: (Math.random() * 2 - 1) * bounds.x * 0.86,
    y: (Math.random() * 2 - 1) * bounds.y * 0.86,
    z: state.mode === "3d" ? (Math.random() * 2 - 1) * bounds.z * 0.86 : 0,
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

function addWordsFromText() {
  state.tokens = tokenize(textInput.value);
  let added = 0;
  for (const token of state.tokens) {
    if (addWord(token)) added += 1;
  }
  updateStatus(added ? `Добавлено новых слов: ${added}` : "Новых слов нет");
  return added;
}

function randomizeWords() {
  if (!state.words.size) {
    updateStatus("Сначала добавьте слова");
    return;
  }

  for (const word of state.words.values()) {
    Object.assign(word, randomPosition());
  }

  if (state.mode === "2d") flattenTo2d();
  updateStatus("Слова случайно разбросаны");
}

function getWindowSize() {
  return Math.round(clampNumber(windowSizeInput, 3));
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
  return clampNumber(minDistanceInput, 2.5);
}

function buildActiveWindow() {
  const tokens = state.tokens;
  if (!tokens.length) return [];

  const size = Math.min(getWindowSize(), tokens.length);
  const windowTokens = [];
  for (let index = 0; index < size; index += 1) {
    windowTokens.push(tokens[(state.cursor + index) % tokens.length]);
  }
  return windowTokens;
}

function getEdgeKey(first, second) {
  return first < second ? `${first}\u0000${second}` : `${second}\u0000${first}`;
}

function reinforceActiveEdges() {
  state.activeEdgeKeys.clear();

  for (let index = 0; index < state.activeTokens.length - 1; index += 1) {
    for (let secondIndex = index + 1; secondIndex < state.activeTokens.length; secondIndex += 1) {
      const first = state.activeTokens[index];
      const second = state.activeTokens[secondIndex];
      if (first === second) continue;

      const key = getEdgeKey(first, second);
      const edge = state.edges.get(key) || {
        first,
        second,
        weight: 0,
      };
      edge.weight = Math.min(edge.weight + 0.22 / (secondIndex - index), 5);
      state.edges.set(key, edge);
      state.activeEdgeKeys.add(key);
    }
  }
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

function applyLayoutStep() {
  const activeNames = [...new Set(state.activeTokens)].filter((word) => state.words.has(word));
  if (activeNames.length < 2) return;
  const activeSet = new Set(activeNames);
  state.activeNegativePairs = [];

  const is3d = state.mode === "3d";
  const attractionStep = getMovementStep();
  const repulsionStep = getRepulsionStep();
  const minDistance = getMinDistance();
  const spacing = Math.max(minDistance, 0.2);
  const bounds = getWorldBounds();
  const deltas = new Map(
    activeNames.map((word) => [
      word,
      {
        x: 0,
        y: 0,
        z: 0,
      },
    ]),
  );

  function addDelta(word, x, y, z) {
    const delta = deltas.get(word);
    if (!delta) return;
    delta.x += x;
    delta.y += y;
    if (is3d) delta.z += z;
  }

  for (const key of state.activeEdgeKeys) {
    const edge = state.edges.get(key);
    if (!edge) continue;

    const a = state.words.get(edge.first);
    const b = state.words.get(edge.second);
    if (!a || !b || a === b) continue;

    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = is3d ? b.z - a.z : 0;
    const distance = Math.hypot(dx, dy, dz) || 0.0001;
    const nx = dx / distance;
    const ny = dy / distance;
    const nz = dz / distance;
    const target = minDistance;
    const pull = Math.min(Math.max(distance - target, 0) * 0.5, attractionStep);

    addDelta(edge.first, nx * pull, ny * pull, nz * pull);
    addDelta(edge.second, -nx * pull, -ny * pull, -nz * pull);

    edge.weight *= 0.9995;
  }

  for (let firstIndex = 0; firstIndex < activeNames.length; firstIndex += 1) {
    const first = activeNames[firstIndex];
    const a = state.words.get(first);
    for (let secondIndex = firstIndex + 1; secondIndex < activeNames.length; secondIndex += 1) {
      const second = activeNames[secondIndex];
      const b = state.words.get(second);
      if (!a || !b) continue;

      let dx = b.x - a.x;
      let dy = b.y - a.y;
      let dz = is3d ? b.z - a.z : 0;
      let distance = Math.hypot(dx, dy, dz);

      if (distance < 0.0001) {
        const angle = (firstIndex * 97 + secondIndex * 37) * 0.017;
        dx = Math.cos(angle) * 0.0001;
        dy = Math.sin(angle) * 0.0001;
        dz = is3d ? Math.sin(angle * 0.7) * 0.0001 : 0;
        distance = Math.hypot(dx, dy, dz);
      }

      if (distance >= spacing) continue;

      const nx = dx / distance;
      const ny = dy / distance;
      const nz = dz / distance;
      const push = Math.min((spacing - distance) * 0.5, repulsionStep);

      addDelta(first, -nx * push, -ny * push, -nz * push);
      addDelta(second, nx * push, ny * push, nz * push);
    }
  }

  for (const activeName of activeNames) {
    const activeWord = state.words.get(activeName);
    if (!activeWord) continue;

    for (const [otherName, otherWord] of state.words) {
      if (activeSet.has(otherName)) continue;

      let dx = otherWord.x - activeWord.x;
      let dy = otherWord.y - activeWord.y;
      let dz = is3d ? otherWord.z - activeWord.z : 0;
      let distance = Math.hypot(dx, dy, dz);

      if (distance < 0.0001) {
        const angle = (activeName.length * 97 + otherName.length * 37) * 0.017;
        dx = Math.cos(angle) * 0.0001;
        dy = Math.sin(angle) * 0.0001;
        dz = is3d ? Math.sin(angle * 0.7) * 0.0001 : 0;
        distance = Math.hypot(dx, dy, dz);
      }

      const nx = dx / distance;
      const ny = dy / distance;
      const nz = dz / distance;
      const influence = (spacing / Math.max(distance, spacing)) ** 2;
      const push = repulsionStep * influence;

      addDelta(activeName, -nx * push, -ny * push, -nz * push);
      if (push >= repulsionStep * 0.2) {
        state.activeNegativePairs.push({
          first: activeName,
          second: otherName,
        });
      }
    }
  }

  for (const [wordName, delta] of deltas) {
    const word = state.words.get(wordName);
    if (!word) continue;

    word.x += delta.x;
    word.y += delta.y;
    word.z = is3d ? word.z + delta.z : 0;

    clampAxis(word, "x", bounds.x);
    clampAxis(word, "y", bounds.y);
    if (is3d) clampAxis(word, "z", bounds.z);
  }
}

function runSimulationSteps(dt) {
  if (!state.running || !state.tokens.length) return;

  const stepsPerSecond = getStepsPerSecond();
  state.stepAccumulator = Math.min(state.stepAccumulator + dt * stepsPerSecond, stepsPerSecond);
  const steps = Math.min(Math.floor(state.stepAccumulator), 30);

  if (!steps) return;

  for (let index = 0; index < steps; index += 1) {
    state.activeTokens = buildActiveWindow();
    reinforceActiveEdges();
    applyLayoutStep();
    state.cursor = (state.cursor + 1) % state.tokens.length;
  }

  state.stepAccumulator -= steps;
  updateStatus();
}

function project2d(point) {
  const scale = getCoordinateScale();
  return {
    x: state.width / 2 + point.x * scale,
    y: state.height / 2 + point.y * scale,
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
  return (Math.min(state.width, state.height) * 0.44 * state.spaceScale) / coordinateLimit;
}

function project3d(point) {
  const rotated = rotate3d(point);
  const camera = 34;
  const perspective = camera / (camera - rotated.z);
  const scale = getCoordinateScale();

  return {
    x: state.width / 2 + rotated.x * scale * perspective,
    y: state.height / 2 + rotated.y * scale * perspective,
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
    ctx.strokeStyle = "#e3e8f1";
    for (let value = -coordinateLimit; value <= coordinateLimit; value += 1) {
      const xLineStart = project2d({ x: value, y: -coordinateLimit });
      const xLineEnd = project2d({ x: value, y: coordinateLimit });
      ctx.beginPath();
      ctx.moveTo(xLineStart.x, xLineStart.y);
      ctx.lineTo(xLineEnd.x, xLineEnd.y);
      ctx.stroke();

      const yLineStart = project2d({ x: -coordinateLimit, y: value });
      const yLineEnd = project2d({ x: coordinateLimit, y: value });
      ctx.beginPath();
      ctx.moveTo(yLineStart.x, yLineStart.y);
      ctx.lineTo(yLineEnd.x, yLineEnd.y);
      ctx.stroke();
    }

    ctx.strokeStyle = "#b9c4d7";
    const xAxisStart = project2d({ x: -coordinateLimit, y: 0 });
    const xAxisEnd = project2d({ x: coordinateLimit, y: 0 });
    const yAxisStart = project2d({ x: 0, y: -coordinateLimit });
    const yAxisEnd = project2d({ x: 0, y: coordinateLimit });
    ctx.beginPath();
    ctx.moveTo(xAxisStart.x, xAxisStart.y);
    ctx.lineTo(xAxisEnd.x, xAxisEnd.y);
    ctx.moveTo(yAxisStart.x, yAxisStart.y);
    ctx.lineTo(yAxisEnd.x, yAxisEnd.y);
    ctx.stroke();

    ctx.fillStyle = "#657086";
    ctx.font = "12px Inter, system-ui, sans-serif";
    ctx.fillText("-10", xAxisStart.x - 18, xAxisStart.y - 6);
    ctx.fillText("10", xAxisEnd.x + 6, xAxisEnd.y - 6);
    ctx.fillText("10", yAxisEnd.x + 7, yAxisEnd.y + 4);
    ctx.fillText("-10", yAxisStart.x + 7, yAxisStart.y + 4);
  } else {
    const axes = [
      {
        color: "#0b6f85",
        from: { x: -coordinateLimit, y: 0, z: 0 },
        to: { x: coordinateLimit, y: 0, z: 0 },
        label: "X",
      },
      {
        color: "#d35f2d",
        from: { x: 0, y: -coordinateLimit, z: 0 },
        to: { x: 0, y: coordinateLimit, z: 0 },
        label: "Y",
      },
      {
        color: "#667085",
        from: { x: 0, y: 0, z: -coordinateLimit },
        to: { x: 0, y: 0, z: coordinateLimit },
        label: "Z",
      },
    ];

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

function drawActiveEdges(projected) {
  if (!state.activeEdgeKeys.size) return;

  ctx.save();
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = "rgba(211, 95, 45, 0.28)";

  for (const key of state.activeEdgeKeys) {
    const edge = state.edges.get(key);
    if (!edge) continue;

    const a = projected.get(edge.first);
    const b = projected.get(edge.second);
    if (!a || !b || edge.first === edge.second) continue;

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.restore();
}

function drawNegativeEdges(projected) {
  if (!state.activeNegativePairs.length) return;

  ctx.save();
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = "rgba(11, 111, 133, 0.22)";
  ctx.setLineDash([6, 5]);

  for (const pair of state.activeNegativePairs) {
    const a = projected.get(pair.first);
    const b = projected.get(pair.second);
    if (!a || !b || pair.first === pair.second) continue;

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.restore();
}

function drawWords() {
  const activeSet = new Set(state.activeTokens);
  const entries = [...state.words.values()]
    .map((word) => ({ word, screen: project(word) }))
    .sort((a, b) => a.screen.depth - b.screen.depth);
  const projected = new Map(entries.map((entry) => [entry.word.word, entry.screen]));

  drawNegativeEdges(projected);
  drawActiveEdges(projected);

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
  ctx.fillText("Добавьте слова из текста", state.width / 2, state.height / 2 - 12);
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
  const tokenLength = state.tokens.length || tokenize(textInput.value).length;
  wordCount.textContent = `${state.words.size} слов в пространстве`;
  tokenCount.textContent = `${tokenLength} слов в тексте`;

  if (message) {
    graphHint.textContent = message;
  } else if (state.running) {
    graphHint.textContent = "Идет обработка: оранжевые линии сближают, пунктир показывает отталкивание от внешних слов.";
  } else {
    graphHint.textContent = "Добавьте текст, затем запустите обработку окна.";
  }

  if (state.running && state.activeTokens.length) {
    activeWindow.textContent = `Окно: ${state.activeTokens.join(" ")}`;
  } else {
    activeWindow.textContent = "Окно не активно";
  }
}

function startProcessing() {
  state.tokens = tokenize(textInput.value);
  if (state.tokens.length < 2) {
    updateStatus("Для обработки нужно минимум два слова в тексте");
    return;
  }

  for (const token of state.tokens) {
    addWord(token);
  }

  state.running = true;
  state.cursor = 0;
  state.stepAccumulator = 0;
  state.edges.clear();
  state.activeEdgeKeys.clear();
  state.activeTokens = buildActiveWindow();
  startButton.disabled = true;
  stopButton.disabled = false;
  addWordsButton.disabled = true;
  updateStatus();
}

function stopProcessing() {
  state.running = false;
  state.activeTokens = [];
  state.activeEdgeKeys.clear();
  state.activeNegativePairs = [];
  state.stepAccumulator = 0;
  startButton.disabled = false;
  stopButton.disabled = true;
  addWordsButton.disabled = false;
  updateStatus("Обработка остановлена: положение заморожено");
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
      ? "3D режим: перетащите граф мышью, чтобы повернуть пространство."
      : "2D режим: расчет идет только в плоскости X/Y.";
}

function clampSpaceScale(value) {
  return Math.min(Math.max(value, minSpaceScale), maxSpaceScale);
}

function getPinchDistance() {
  if (state.pointers.size < 2) return 0;
  const points = [...state.pointers.values()];
  return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
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
  canvas.setPointerCapture(event.pointerId);
  state.pointers.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY,
  });

  if (state.pointers.size >= 2) {
    startPinch();
    return;
  }

  if (state.mode !== "3d") return;

  state.drag = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
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
      state.spaceScale = clampSpaceScale(state.pinch.scale * (distance / state.pinch.distance));
    }
    return;
  }

  if (!state.drag || state.drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - state.drag.x;
  const dy = event.clientY - state.drag.y;
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
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const direction = event.deltaY > 0 ? -1 : 1;
  const zoomFactor = 1 + direction * 0.08;
  state.spaceScale = clampSpaceScale(state.spaceScale * zoomFactor);
}

addWordsButton.addEventListener("click", addWordsFromText);
randomizeButton.addEventListener("click", randomizeWords);
startButton.addEventListener("click", startProcessing);
stopButton.addEventListener("click", stopProcessing);

textInput.addEventListener("input", () => {
  state.tokens = tokenize(textInput.value);
  updateStatus();
});

document.querySelectorAll(".mode-button").forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

canvas.addEventListener("pointerdown", handlePointerDown);
canvas.addEventListener("pointermove", handlePointerMove);
canvas.addEventListener("pointerup", handlePointerUp);
canvas.addEventListener("pointercancel", handlePointerUp);
canvas.addEventListener("wheel", handleCanvasWheel, { passive: false });

window.addEventListener("resize", resizeCanvas);

resizeCanvas();
updateStatus();
requestAnimationFrame(render);
