/* =====================================================
   OPTIMIZADOR DE CORTE 2D — app.js
   
   MODOS:
   A) Heurístico  → MAXRECTS greedy (Best Short Side Fit)
                    Resultado inmediato, ~85-95% óptimo
   B) Óptimo      → Column Generation + MILP (HiGHS via Pyodide)
                    Óptimo global garantizado, 10-60s

   GENERADOR COMPARTIDO (ambos modos):
   - Algoritmo MAXRECTS con Free Rectangles
   - Detecta TODOS los espacios libres rectangulares
     después de cada colocación, no solo el skyline
   - Soporta rotación 90°
   - No hay corte guillotina implícito
   ===================================================== */

'use strict';

// ── COLORES ───────────────────────────────────────
const PIECE_COLORS = [
  '#4a90d9','#e8a838','#3daa6e','#9b59b6','#e74c3c',
  '#16a085','#d35400','#2980b9','#8e44ad','#27ae60',
  '#c0392b','#f39c12','#1abc9c','#34495e','#e91e63',
  '#00bcd4','#ff5722','#607d8b','#795548','#009688'
];

// ── ESTADO ────────────────────────────────────────
const state = {
  pieces: [],
  solution: null,
  currentSheet: 0,
  zoom: 1.0,
  pyodideReady: false,
  pyodide: null,
};

// ── DOM ───────────────────────────────────────────
const $ = id => document.getElementById(id);
const statusBar      = $('statusBar');
const pieceList      = $('pieceList');
const btnHeuristic   = $('btnHeuristic');
const btnOptimal     = $('btnOptimal');
const emptyState     = $('emptyState');
const resultsSection = $('resultsSection');
const canvas         = $('cutCanvas');
const ctx            = canvas.getContext('2d');

// ── PYODIDE ───────────────────────────────────────
async function initPyodide() {
  setStatus('Cargando solver MILP…');
  try {
    const py = await loadPyodide({ indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/' });
    await py.loadPackage(['scipy', 'numpy']);
    state.pyodide = py;
    state.pyodideReady = true;
    $('solverStatus').textContent = 'HiGHS listo ⚡';
    $('solverBadge').querySelector('.dot').classList.add('ready');
    setStatus('');
  } catch(e) {
    $('solverStatus').textContent = 'Solver offline';
    $('solverBadge').querySelector('.dot').classList.add('error');
    setStatus('Pyodide no disponible. Solo modo heurístico.', 'error');
    btnOptimal.disabled = true;
  }
}
const pyScript = document.createElement('script');
pyScript.src = 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.js';
pyScript.onload = initPyodide;
document.head.appendChild(pyScript);

// ── HELPERS ───────────────────────────────────────
function setStatus(msg, type = '') {
  statusBar.textContent = msg;
  statusBar.className = 'status-bar' + (type ? ' ' + type : '');
}
function setBusy(busy) {
  btnHeuristic.disabled = busy;
  btnOptimal.disabled   = busy;
}
function nextColor() {
  return PIECE_COLORS[state.pieces.length % PIECE_COLORS.length];
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── LISTA DE PIEZAS ───────────────────────────────
function renderPieceList() {
  pieceList.innerHTML = '';
  state.pieces.forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'piece-item';
    div.innerHTML = `
      <div class="piece-swatch" style="background:${p.color}"></div>
      <div class="piece-info">
        <div class="piece-name">${p.label}</div>
        <div class="piece-dim">${p.w} × ${p.h} mm</div>
      </div>
      <span class="piece-qty">×${p.qty}</span>
      <button class="btn-del" data-i="${i}">✕</button>
    `;
    pieceList.appendChild(div);
  });
  pieceList.querySelectorAll('.btn-del').forEach(btn =>
    btn.addEventListener('click', () => {
      state.pieces.splice(+btn.dataset.i, 1);
      renderPieceList();
    })
  );
}

$('btnAdd').addEventListener('click', () => {
  const w   = parseFloat($('pieceW').value);
  const h   = parseFloat($('pieceH').value);
  const qty = parseInt($('pieceQty').value) || 1;
  const lbl = $('pieceLabel').value.trim();
  const shW = parseFloat($('sheetW').value);
  const shH = parseFloat($('sheetH').value);

  if (!w || !h || w <= 0 || h <= 0) return setStatus('Ingresa dimensiones válidas.', 'error');
  const fitsNormal   = w <= shW && h <= shH;
  const fitsRotated  = $('allowRotation').checked && h <= shW && w <= shH;
  if (!fitsNormal && !fitsRotated) return setStatus('La pieza no cabe en la lámina.', 'error');

  const label = lbl || `Pieza ${String.fromCharCode(65 + state.pieces.length)}`;
  state.pieces.push({ id: state.pieces.length, label, w, h, qty, color: nextColor() });
  renderPieceList();
  $('pieceW').value = ''; $('pieceH').value = '';
  $('pieceQty').value = '1'; $('pieceLabel').value = '';
  setStatus('');
});

function loadExample() {
  $('sheetW').value = 2440; $('sheetH').value = 1220; $('kerf').value = 3;
  state.pieces = [
    { id:0, label:'Panel A',  w:800,  h:600, qty:4, color:PIECE_COLORS[0] },
    { id:1, label:'Panel B',  w:1200, h:400, qty:3, color:PIECE_COLORS[1] },
    { id:2, label:'Tapa',     w:500,  h:300, qty:6, color:PIECE_COLORS[2] },
    { id:3, label:'Lateral',  w:600,  h:900, qty:2, color:PIECE_COLORS[3] },
  ];
  renderPieceList();
  setStatus('Ejemplo cargado.');
}
loadExample();

// ════════════════════════════════════════════════════
// MAXRECTS — Free Rectangle Packing
// ════════════════════════════════════════════════════
/*
  Mantiene una lista de rectángulos libres (freeRects).
  Al colocar una pieza, divide TODOS los rectángulos
  libres que se solapan con ella en hasta 4 sub-rectángulos
  (arriba, abajo, izquierda, derecha), luego elimina los
  que quedan contenidos dentro de otros (maximalidad).

  Esto garantiza que NINGÚN espacio aprovechable queda
  sin detectar — sin importar la forma en que quedó el
  espacio libre. No hay corte guillotina implícito.
*/

class MaxRects {
  constructor(W, H) {
    this.W = W;
    this.H = H;
    // Espacio libre inicial = lámina completa
    this.freeRects = [{ x:0, y:0, w:W, h:H }];
    this.placements = [];
  }

  // Heurística BSSF: Best Short Side Fit
  // Elige el rectángulo libre donde la pieza deja
  // el menor "lado corto" de desperdicio
  findBSSF(pw, ph) {
    let bestScore = Infinity;
    let bestRect  = null;
    let bestRot   = false;

    for (const fr of this.freeRects) {
      // Sin rotación
      if (pw <= fr.w && ph <= fr.h) {
        const score = Math.min(fr.w - pw, fr.h - ph);
        if (score < bestScore) {
          bestScore = score; bestRect = fr; bestRot = false;
        }
      }
      // Con rotación
      if (ph <= fr.w && pw <= fr.h) {
        const score = Math.min(fr.w - ph, fr.h - pw);
        if (score < bestScore) {
          bestScore = score; bestRect = fr; bestRot = true;
        }
      }
    }
    return bestRect ? { rect: bestRect, rotated: bestRot, score: bestScore } : null;
  }

  // Colocar pieza en posición (x,y) con dimensiones (pw,ph)
  // Retorna true si se colocó
  place(pieceIdx, pw, ph, rotated) {
    const fit = this.findBSSF(pw, ph);
    if (!fit) return false;

    const placed = {
      pieceIdx,
      x: fit.rect.x, y: fit.rect.y,
      w: rotated ? ph : pw,
      h: rotated ? pw : ph,
      rotated
    };
    this.placements.push(placed);
    this._splitFreeRects(placed);
    this._pruneContained();
    return true;
  }

  // Intentar colocar en posición específica (para enumeración)
  placeAt(pieceIdx, x, y, pw, ph, rotated) {
    const actualW = rotated ? ph : pw;
    const actualH = rotated ? pw : ph;

    // Verificar que hay un rectángulo libre que contiene (x,y,actualW,actualH)
    const ok = this.freeRects.some(fr =>
      x >= fr.x && y >= fr.y &&
      x + actualW <= fr.x + fr.w &&
      y + actualH <= fr.y + fr.h
    );
    if (!ok) return false;

    const placed = { pieceIdx, x, y, w: actualW, h: actualH, rotated };
    this.placements.push(placed);
    this._splitFreeRects(placed);
    this._pruneContained();
    return true;
  }

  _splitFreeRects(placed) {
    const { x: px, y: py, w: pw, h: ph } = placed;
    const newFree = [];

    for (const fr of this.freeRects) {
      // ¿Se solapan?
      if (px >= fr.x + fr.w || px + pw <= fr.x ||
          py >= fr.y + fr.h || py + ph <= fr.y) {
        newFree.push(fr); // sin solapamiento → queda igual
        continue;
      }
      // Se solapan: generar hasta 4 sub-rectángulos
      // Arriba
      if (py > fr.y)
        newFree.push({ x: fr.x, y: fr.y, w: fr.w, h: py - fr.y });
      // Abajo
      if (py + ph < fr.y + fr.h)
        newFree.push({ x: fr.x, y: py + ph, w: fr.w, h: (fr.y + fr.h) - (py + ph) });
      // Izquierda
      if (px > fr.x)
        newFree.push({ x: fr.x, y: fr.y, w: px - fr.x, h: fr.h });
      // Derecha
      if (px + pw < fr.x + fr.w)
        newFree.push({ x: px + pw, y: fr.y, w: (fr.x + fr.w) - (px + pw), h: fr.h });
    }
    this.freeRects = newFree;
  }

  _pruneContained() {
    // Eliminar rectángulos que están completamente
    // contenidos dentro de otro (no son maximales)
    const result = [];
    for (let i = 0; i < this.freeRects.length; i++) {
      let dominated = false;
      for (let j = 0; j < this.freeRects.length; j++) {
        if (i === j) continue;
        const a = this.freeRects[i];
        const b = this.freeRects[j];
        if (b.x <= a.x && b.y <= a.y &&
            b.x + b.w >= a.x + a.w &&
            b.y + b.h >= a.y + a.h) {
          dominated = true; break;
        }
      }
      if (!dominated) result.push(this.freeRects[i]);
    }
    this.freeRects = result;
  }

  // Área libre total
  freeArea() {
    return this.freeRects.reduce((s, r) => s + r.w * r.h, 0);
  }
}

// ════════════════════════════════════════════════════
// MODO A — HEURÍSTICO (MAXRECTS greedy multi-lámina)
// ════════════════════════════════════════════════════
function solveHeuristic(sheetW, sheetH, kerf, pieces, allowRotation, maxSheets) {
  // Demanda pendiente por tipo
  const remaining = pieces.map(p => p.qty);
  const sheets    = [];

  for (let s = 0; s < maxSheets; s++) {
    // ¿Quedan piezas?
    if (remaining.every(r => r === 0)) break;

    const mr = new MaxRects(sheetW, sheetH);
    let placed = true;

    while (placed) {
      placed = false;
      // Ordenar por área descendente (greedy: piezas grandes primero)
      const order = pieces
        .map((p, i) => ({ i, area: p.w * p.h, rem: remaining[i] }))
        .filter(x => x.rem > 0)
        .sort((a, b) => b.area - a.area);

      for (const { i } of order) {
        if (remaining[i] === 0) continue;
        const p = pieces[i];
        const pw = p.w + kerf;
        const ph = p.h + kerf;

        // Intentar colocar (MAXRECTS BSSF)
        const fit = mr.findBSSF(
          allowRotation ? Math.min(pw, ph) : pw,
          allowRotation ? Math.max(pw, ph) : ph
        );

        // Intentar sin rotación
        let fitNormal = mr.findBSSF(pw, ph);
        let fitRot    = allowRotation && p.w !== p.h ? mr.findBSSF(ph, pw) : null;

        // Elegir el mejor fit
        let chosen = null;
        if (fitNormal && fitRot) {
          chosen = fitNormal.score <= fitRot.score ? { fit: fitNormal, rot: false } : { fit: fitRot, rot: true };
        } else if (fitNormal) {
          chosen = { fit: fitNormal, rot: false };
        } else if (fitRot) {
          chosen = { fit: fitRot, rot: true };
        }

        if (chosen) {
          const actualW = chosen.rot ? ph : pw;
          const actualH = chosen.rot ? pw : ph;
          mr.placeAt(i, chosen.fit.rect.x, chosen.fit.rect.y, pw, ph, chosen.rot);
          // Ajustar última colocación a dimensión real (sin kerf en display)
          const last = mr.placements[mr.placements.length - 1];
          last.w -= kerf; last.h -= kerf;
          remaining[i]--;
          placed = true;
          break; // reiniciar orden con pieza más grande disponible
        }
      }
    }

    if (mr.placements.length > 0) {
      sheets.push({ placements: mr.placements, sheetW, sheetH, kerf });
    }
  }

  // Calcular estadísticas
  const totalPlaced = pieces.map((_, i) => pieces[i].qty - remaining[i]);
  return { sheets, totalPlaced, remaining };
}

// ════════════════════════════════════════════════════
// GENERADOR DE PATRONES para MILP
// ════════════════════════════════════════════════════
/*
  Usa MAXRECTS con DFS exhaustivo:
  En cada paso, enumera TODOS los rectángulos libres
  disponibles × TODOS los tipos de pieza × orientaciones.
  Esto genera patrones con piezas en cualquier posición
  válida, no solo en posiciones guillotina.
  
  La poda evita explosión combinatorial:
  - Máx MAX_PATTERNS patrones distintos
  - Máx profundidad MAX_DEPTH
  - No repetir el mismo tipo de pieza en la misma
    posición libre si ya se probó en esa rama
*/
const MAX_PATTERNS = 6000;
const MAX_DEPTH    = 50;

function generatePatterns2D(sheetW, sheetH, kerf, pieces, allowRotation) {
  const patterns = [];
  const demand   = pieces.map(p => p.qty);
  const seen     = new Set();

  function dfs(freeRects, placements, counts, depth) {
    if (patterns.length >= MAX_PATTERNS) return;

    if (placements.length > 0) {
      // Firma única del patrón por posiciones de piezas
      const sig = placements.map(pl =>
        `${pl.pieceIdx},${pl.x},${pl.y},${pl.rotated?1:0}`
      ).join('|');
      if (!seen.has(sig)) {
        seen.add(sig);
        patterns.push({
          placements: placements.map(p => ({...p})),
          counts: [...counts]
        });
      }
    }

    if (depth >= MAX_DEPTH || freeRects.length === 0) return;

    // Para cada rectángulo libre × tipo de pieza × orientación
    // Ordenamos freeRects: primero el más pequeño (explorar espacios ajustados)
    const sortedFR = [...freeRects].sort((a,b) => a.w*a.h - b.w*b.h);

    const tried = new Set(); // evitar probar mismo tipo×posición×rot en esta rama

    for (const fr of sortedFR) {
      for (let i = 0; i < pieces.length; i++) {
        if (counts[i] >= demand[i]) continue;
        const p = pieces[i];

        const orientations = [
          { pw: p.w + kerf, ph: p.h + kerf, rot: false }
        ];
        if (allowRotation && p.w !== p.h) {
          orientations.push({ pw: p.h + kerf, ph: p.w + kerf, rot: true });
        }

        for (const { pw, ph, rot } of orientations) {
          if (pw > fr.w + 0.001 || ph > fr.h + 0.001) continue;

          const key = `${i},${fr.x},${fr.y},${rot?1:0}`;
          if (tried.has(key)) continue;
          tried.add(key);

          // Simular colocación en (fr.x, fr.y)
          const actualW = rot ? p.h : p.w; // dimensión display (sin kerf)
          const actualH = rot ? p.w : p.h;

          // Calcular nuevos freeRects (split MAXRECTS)
          const newFree = splitFreeRects(freeRects, fr.x, fr.y, pw, ph);
          const prunedFree = pruneContained(newFree);

          const newPlacements = [...placements, {
            pieceIdx: i,
            x: fr.x, y: fr.y,
            w: actualW, h: actualH,
            rotated: rot
          }];
          const newCounts = [...counts];
          newCounts[i]++;

          dfs(prunedFree, newPlacements, newCounts, depth + 1);

          if (patterns.length >= MAX_PATTERNS) return;
        }
      }
    }
  }

  const initialFree  = [{ x:0, y:0, w:sheetW, h:sheetH }];
  const initialCounts = new Array(pieces.length).fill(0);
  dfs(initialFree, [], initialCounts, 0);
  return patterns;
}

// ── MAXRECTS FUNCIONES PURAS (para el generador) ──

function splitFreeRects(freeRects, px, py, pw, ph) {
  const result = [];
  for (const fr of freeRects) {
    if (px >= fr.x + fr.w || px + pw <= fr.x ||
        py >= fr.y + fr.h || py + ph <= fr.y) {
      result.push(fr);
      continue;
    }
    if (py > fr.y)
      result.push({ x: fr.x, y: fr.y, w: fr.w, h: py - fr.y });
    if (py + ph < fr.y + fr.h)
      result.push({ x: fr.x, y: py + ph, w: fr.w, h: (fr.y + fr.h) - (py + ph) });
    if (px > fr.x)
      result.push({ x: fr.x, y: fr.y, w: px - fr.x, h: fr.h });
    if (px + pw < fr.x + fr.w)
      result.push({ x: px + pw, y: fr.y, w: (fr.x + fr.w) - (px + pw), h: fr.h });
  }
  return result;
}

function pruneContained(freeRects) {
  const result = [];
  for (let i = 0; i < freeRects.length; i++) {
    let dominated = false;
    for (let j = 0; j < freeRects.length; j++) {
      if (i === j) continue;
      const a = freeRects[i], b = freeRects[j];
      if (b.x <= a.x && b.y <= a.y &&
          b.x + b.w >= a.x + a.w &&
          b.y + b.h >= a.y + a.h) {
        dominated = true; break;
      }
    }
    if (!dominated) result.push(freeRects[i]);
  }
  return result;
}

// ════════════════════════════════════════════════════
// MODO B — ÓPTIMO (Column Generation + MILP)
// ════════════════════════════════════════════════════
const PYTHON_MILP = `
import json
import numpy as np
from scipy.optimize import milp, LinearConstraint, Bounds

def solve(patterns_json, demand_json, max_sheets):
    patterns = json.loads(patterns_json)
    demand   = json.loads(demand_json)
    n_pieces   = len(demand)
    n_patterns = len(patterns)

    if n_patterns == 0:
        return json.dumps({"status":"error","message":"Sin patrones"})

    # Matriz cobertura A[i][j] = piezas tipo i en patrón j
    A = np.zeros((n_pieces, n_patterns))
    for j, pat in enumerate(patterns):
        for i, cnt in enumerate(pat["counts"]):
            A[i, j] = cnt

    # Filtrar patrones que no superen la demanda en ningún tipo
    valid = [j for j in range(n_patterns)
             if all(A[i,j] <= demand[i] for i in range(n_pieces))]
    if not valid:
        valid = list(range(n_patterns))

    A_v = A[:, valid]
    pats_v = [patterns[j] for j in valid]
    nv = len(valid)

    c = np.ones(nv)
    constraints = LinearConstraint(A_v,
        lb=np.array(demand, dtype=float), ub=np.inf)
    bounds = Bounds(lb=0, ub=max_sheets)
    integrality = np.ones(nv)

    res = milp(c, constraints=constraints, bounds=bounds,
               integrality=integrality,
               options={"disp":False,"time_limit":180})

    if res.status not in (0,1):
        return json.dumps({"status":"infeasible",
            "message":f"Sin solución (status={res.status})"})

    x = np.round(res.x).astype(int)
    used = []
    for j in range(nv):
        if x[j] > 0:
            used.append({
                "count": int(x[j]),
                "placements": pats_v[j]["placements"],
                "piece_counts": pats_v[j]["counts"]
            })

    return json.dumps({
        "status": "optimal" if res.status==0 else "feasible",
        "total_sheets": int(x.sum()),
        "used_patterns": used,
        "objective": float(res.fun)
    })

result = solve(PATTERNS_JSON, DEMAND_JSON, MAX_SHEETS)
result
`;

// ════════════════════════════════════════════════════
// ORQUESTADOR PRINCIPAL
// ════════════════════════════════════════════════════
async function run(mode) {
  if (state.pieces.length === 0) return setStatus('Agrega al menos una pieza.', 'error');
  if (mode === 'optimal' && !state.pyodideReady)
    return setStatus('Espera que el solver MILP termine de cargar.', 'error');

  const sheetW = parseFloat($('sheetW').value);
  const sheetH = parseFloat($('sheetH').value);
  const kerf   = parseFloat($('kerf').value) || 0;
  const maxSh  = parseInt($('maxSheets').value) || 20;
  const allowRot = $('allowRotation').checked;

  if (!sheetW || !sheetH) return setStatus('Ingresa dimensiones de lámina.', 'error');

  setBusy(true);
  emptyState.classList.add('hidden');
  resultsSection.classList.add('hidden');

  try {
    const t0 = Date.now();

    if (mode === 'heuristic') {
      // ── MODO HEURÍSTICO ──────────────────────────
      setStatus('⚡ Ejecutando MAXRECTS greedy…');
      await sleep(20);

      const { sheets, remaining } = solveHeuristic(
        sheetW, sheetH, kerf, state.pieces, allowRot, maxSh
      );

      if (sheets.length === 0)
        return setStatus('No se pudo colocar ninguna pieza.', 'error');

      const unplaced = remaining.reduce((a,b) => a+b, 0);
      const t1 = Date.now();
      const msg = unplaced > 0
        ? `⚠️ Heurístico: ${sheets.length} láminas (${unplaced} piezas no colocadas) — ${t1-t0}ms`
        : `✓ Heurístico: ${sheets.length} láminas — ${t1-t0}ms`;
      setStatus(msg, unplaced > 0 ? 'error' : 'ok');

      state.solution = {
        sheets, sheetW, sheetH, kerf,
        pieces: state.pieces,
        mode: 'heuristic'
      };

    } else {
      // ── MODO ÓPTIMO ──────────────────────────────
      setStatus('⚙️ Generando patrones MAXRECTS…');
      await sleep(20);

      const patterns = generatePatterns2D(sheetW, sheetH, kerf, state.pieces, allowRot);
      const t1 = Date.now();

      if (patterns.length === 0)
        return setStatus('Sin patrones factibles. Revisa dimensiones.', 'error');

      setStatus(`✓ ${patterns.length} patrones (${t1-t0}ms) → Resolviendo MILP…`);
      await sleep(50);

      state.pyodide.globals.set('PATTERNS_JSON', JSON.stringify(patterns));
      state.pyodide.globals.set('DEMAND_JSON',   JSON.stringify(state.pieces.map(p => p.qty)));
      state.pyodide.globals.set('MAX_SHEETS',    maxSh);

      const resultStr = await state.pyodide.runPythonAsync(PYTHON_MILP);
      const result    = JSON.parse(resultStr);

      if (result.status === 'error' || result.status === 'infeasible')
        return setStatus(`❌ ${result.message}`, 'error');

      const t2 = Date.now();
      setStatus(`✓ Óptimo global: ${result.total_sheets} láminas — ${((t2-t0)/1000).toFixed(1)}s`, 'ok');

      const sheets = expandPatterns(result.used_patterns, sheetW, sheetH, kerf);
      state.solution = {
        sheets, sheetW, sheetH, kerf,
        pieces: state.pieces,
        mode: 'optimal',
        result
      };
    }

    state.currentSheet = 0;
    state.zoom = 1.0;
    showResults();

  } catch(e) {
    setStatus(`Error: ${e.message}`, 'error');
    console.error(e);
  } finally {
    setBusy(false);
  }
}

function expandPatterns(usedPatterns, sheetW, sheetH, kerf) {
  const sheets = [];
  for (const up of usedPatterns) {
    for (let c = 0; c < up.count; c++) {
      sheets.push({ placements: up.placements, sheetW, sheetH, kerf });
    }
  }
  return sheets;
}

btnHeuristic.addEventListener('click', () => run('heuristic'));
btnOptimal.addEventListener('click',   () => run('optimal'));

// ════════════════════════════════════════════════════
// VISUALIZACIÓN
// ════════════════════════════════════════════════════
function showResults() {
  const sol = state.solution;
  const sheetArea  = sol.sheetW * sol.sheetH;
  const totalArea  = sol.sheets.length * sheetArea;
  let   usedArea   = 0;

  for (const sheet of sol.sheets)
    for (const pl of sheet.placements)
      usedArea += pl.w * pl.h;

  const efficiency = (usedArea / totalArea * 100).toFixed(1);
  const wasteM2    = ((totalArea - usedArea) / 1e6).toFixed(3);

  $('statSheets').textContent     = sol.sheets.length;
  $('statEfficiency').textContent = efficiency + '%';
  $('statWaste').textContent      = wasteM2;
  $('statPieces').textContent     = sol.pieces.reduce((a,p) => a+p.qty, 0);

  // Conteo por pieza
  const placed  = new Array(sol.pieces.length).fill(0);
  const rotated = new Array(sol.pieces.length).fill(0);
  for (const sheet of sol.sheets)
    for (const pl of sheet.placements) {
      placed[pl.pieceIdx]++;
      if (pl.rotated) rotated[pl.pieceIdx]++;
    }

  // Tabla
  const tbody = $('resultTableBody');
  tbody.innerHTML = '';
  sol.pieces.forEach((p, i) => {
    const ok = placed[i] >= p.qty;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div class="td-name">
        <div class="td-swatch" style="background:${p.color}"></div>${p.label}
      </div></td>
      <td>${p.w} × ${p.h}</td>
      <td>${p.qty}</td>
      <td>${placed[i]} <span class="${ok?'badge-ok':'badge-partial'}">${ok?'✓':'!'}</span></td>
      <td>${rotated[i] > 0 ? rotated[i] : '—'}</td>
    `;
    tbody.appendChild(tr);
  });

  // Leyenda
  const legend = $('legend');
  legend.innerHTML = '<div style="font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--gray);margin-bottom:8px">Leyenda</div>';
  sol.pieces.forEach(p => {
    const div = document.createElement('div');
    div.className = 'legend-item';
    div.innerHTML = `
      <div class="legend-swatch" style="background:${p.color}"></div>
      <span class="legend-label">${p.label}</span>
      <span class="legend-dim">${p.w}×${p.h}</span>
    `;
    legend.appendChild(div);
  });
  const wd = document.createElement('div');
  wd.className = 'legend-item';
  wd.innerHTML = `<div class="legend-swatch" style="background:#e8ecf2;border:1px solid #d4dae4"></div><span class="legend-label">Desperdicio</span>`;
  legend.appendChild(wd);

  // Badge de modo
  const modeBadge = sol.mode === 'optimal'
    ? '<span style="font-size:0.7rem;background:#e6f4ea;color:#1a6b30;padding:2px 8px;border-radius:100px;font-weight:600">🎯 Óptimo global</span>'
    : '<span style="font-size:0.7rem;background:#fdf3e0;color:#8a5a00;padding:2px 8px;border-radius:100px;font-weight:600">⚡ Heurístico</span>';
  legend.insertAdjacentHTML('afterbegin', modeBadge + '<br><br>');

  resultsSection.classList.remove('hidden');
  emptyState.classList.add('hidden');
  fitZoom();
  renderSheet();
}

// ── CANVAS ────────────────────────────────────────
function fitZoom() {
  const sol   = state.solution;
  const wrap  = $('canvasWrap');
  const availW = wrap.clientWidth - 40;
  const availH = Math.min(580, window.innerHeight * 0.55);
  state.zoom = Math.min(availW / sol.sheetW, availH / sol.sheetH, 2.0);
  $('zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
}

function renderSheet() {
  const sol   = state.solution;
  if (!sol) return;
  const sheet = sol.sheets[state.currentSheet];
  const z     = state.zoom;
  const W     = Math.round(sol.sheetW * z);
  const H     = Math.round(sol.sheetH * z);

  canvas.width = W; canvas.height = H;

  // Fondo
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Grid sutil
  ctx.strokeStyle = 'rgba(100,120,150,0.07)';
  ctx.lineWidth = 1;
  const gs = 200 * z;
  for (let x = 0; x <= W; x += gs) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
  for (let y = 0; y <= H; y += gs) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

  // Piezas
  for (const pl of sheet.placements) {
    const piece = sol.pieces[pl.pieceIdx];
    const px = Math.round(pl.x * z);
    const py = Math.round(pl.y * z);
    const pw = Math.round(pl.w * z);
    const ph = Math.round(pl.h * z);

    // Relleno
    ctx.fillStyle = hexToRgba(piece.color, 0.20);
    ctx.fillRect(px, py, pw, ph);

    // Borde
    ctx.strokeStyle = piece.color;
    ctx.lineWidth = Math.max(1.5, 1.8 * z);
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

    // Etiqueta
    if (pw > 28 && ph > 18) {
      ctx.save();
      const fs = Math.min(12, Math.max(7, Math.min(pw, ph) * 0.13));
      ctx.font = `600 ${fs}px 'DM Sans',sans-serif`;
      ctx.fillStyle = darken(piece.color, 0.45);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lbl = piece.label + (pl.rotated ? ' ↻' : '');
      ctx.fillText(lbl, px + pw/2, py + ph/2 - (ph > 32 ? fs*0.7 : 0));
      if (ph > 32 && pw > 50) {
        ctx.font = `400 ${Math.max(6, fs*0.8)}px 'DM Mono',monospace`;
        ctx.fillStyle = darken(piece.color, 0.3);
        ctx.fillText(`${pl.w}×${pl.h}`, px + pw/2, py + ph/2 + fs*0.8);
      }
      ctx.restore();
    }

    // Kerf visual
    if (sol.kerf > 0 && pw > 6) {
      const kz = Math.max(1, sol.kerf * z);
      ctx.fillStyle = 'rgba(220,60,40,0.09)';
      ctx.fillRect(px + pw, py, kz, ph + kz);
      ctx.fillRect(px, py + ph, pw, kz);
    }
  }

  // Borde lámina
  ctx.strokeStyle = '#243b55';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W-2, H-2);

  $('sheetIndicator').textContent = `Lámina ${state.currentSheet+1} / ${sol.sheets.length}`;
}

function hexToRgba(hex, a) {
  return `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`;
}
function darken(hex, amt) {
  return `rgb(${Math.round(parseInt(hex.slice(1,3),16)*(1-amt))},${Math.round(parseInt(hex.slice(3,5),16)*(1-amt))},${Math.round(parseInt(hex.slice(5,7),16)*(1-amt))})`;
}

// ── CONTROLES ─────────────────────────────────────
$('btnPrev').addEventListener('click', () => {
  if (!state.solution) return;
  state.currentSheet = Math.max(0, state.currentSheet - 1);
  renderSheet();
});
$('btnNext').addEventListener('click', () => {
  if (!state.solution) return;
  state.currentSheet = Math.min(state.solution.sheets.length-1, state.currentSheet+1);
  renderSheet();
});
$('btnZoomIn').addEventListener('click', () => {
  state.zoom = Math.min(state.zoom * 1.25, 4.0);
  $('zoomLevel').textContent = Math.round(state.zoom*100)+'%';
  renderSheet();
});
$('btnZoomOut').addEventListener('click', () => {
  state.zoom = Math.max(state.zoom / 1.25, 0.1);
  $('zoomLevel').textContent = Math.round(state.zoom*100)+'%';
  renderSheet();
});
$('btnZoomFit').addEventListener('click', () => { fitZoom(); renderSheet(); });

document.addEventListener('keydown', e => {
  if (!state.solution) return;
  if (e.key === 'ArrowLeft')  $('btnPrev').click();
  if (e.key === 'ArrowRight') $('btnNext').click();
  if (e.key === '+') $('btnZoomIn').click();
  if (e.key === '-') $('btnZoomOut').click();
});
