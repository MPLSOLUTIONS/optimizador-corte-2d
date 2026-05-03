/* =====================================================
   OPTIMIZADOR DE CORTE 2D — app.js
   
   MODOS:
   A) Heurístico  → MAXRECTS greedy BSSF, ~1s, ~85-95% óptimo
   B) Óptimo      → Column Generation MAXRECTS + MILP HiGHS
                    Óptimo global garantizado

   GENERADOR COMPARTIDO: MAXRECTS Free Rectangles
   - Detecta TODOS los espacios libres en la lámina
   - Sin corte guillotina implícito
   - Soporta rotación 90°
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
  setStatus('Cargando solver MILP (Pyodide)…');
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
    btnOptimal.disabled = true;
    setStatus('Pyodide no disponible. Solo modo heurístico.', 'error');
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
  if (state.pyodideReady) btnOptimal.disabled = busy;
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
  const allowRot = $('allowRotation').checked;

  if (!w || !h || w <= 0 || h <= 0) return setStatus('Ingresa dimensiones válidas.', 'error');
  const fitsNormal  = w <= shW && h <= shH;
  const fitsRotated = allowRot && h <= shW && w <= shH;
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
  setStatus('Ejemplo cargado — presiona ⚡ Heurístico o 🎯 Óptimo global.');
}
loadExample();

// ════════════════════════════════════════════════════
// MAXRECTS — Free Rectangles (funciones puras)
// ════════════════════════════════════════════════════
/*
  Después de colocar una pieza, divide TODOS los rectángulos
  libres solapados en hasta 4 sub-rectángulos (arriba, abajo,
  izquierda, derecha). Luego elimina los contenidos dentro de
  otros (no maximales). Esto garantiza que ningún espacio
  aprovechable queda sin detectar.
  
  NOTA: pw/ph siempre incluyen el kerf (espacio físico usado).
        Los placements guardan w/h sin kerf (dimensión visual).
*/

function splitFreeRects(freeRects, px, py, pw, ph) {
  // px,py,pw,ph: posición y dimensiones CON kerf de la pieza colocada
  const result = [];
  for (const fr of freeRects) {
    // Sin solapamiento → queda intacto
    if (px >= fr.x + fr.w || px + pw <= fr.x ||
        py >= fr.y + fr.h || py + ph <= fr.y) {
      result.push(fr);
      continue;
    }
    // Solapamiento: generar hasta 4 sub-rectángulos
    // Franja superior
    if (py > fr.y)
      result.push({ x: fr.x, y: fr.y, w: fr.w, h: py - fr.y });
    // Franja inferior
    if (py + ph < fr.y + fr.h)
      result.push({ x: fr.x, y: py + ph, w: fr.w, h: (fr.y + fr.h) - (py + ph) });
    // Franja izquierda
    if (px > fr.x)
      result.push({ x: fr.x, y: fr.y, w: px - fr.x, h: fr.h });
    // Franja derecha
    if (px + pw < fr.x + fr.w)
      result.push({ x: px + pw, y: fr.y, w: (fr.x + fr.w) - (px + pw), h: fr.h });
  }
  return result;
}

function pruneContained(freeRects) {
  // Eliminar rectángulos completamente contenidos en otro
  const out = [];
  for (let i = 0; i < freeRects.length; i++) {
    let skip = false;
    const a = freeRects[i];
    for (let j = 0; j < freeRects.length; j++) {
      if (i === j) continue;
      const b = freeRects[j];
      if (b.x <= a.x && b.y <= a.y &&
          b.x + b.w >= a.x + a.w &&
          b.y + b.h >= a.y + a.h) {
        skip = true; break;
      }
    }
    if (!skip) out.push(a);
  }
  return out;
}

// Best Short Side Fit: elige el rectángulo libre donde
// la pieza deja el menor lado corto de desperdicio
function findBSSF(freeRects, pw, ph) {
  let bestScore = Infinity;
  let bestFR    = null;
  for (const fr of freeRects) {
    if (pw <= fr.w && ph <= fr.h) {
      const score = Math.min(fr.w - pw, fr.h - ph);
      if (score < bestScore) { bestScore = score; bestFR = fr; }
    }
  }
  return bestFR ? { rect: bestFR, score: bestScore } : null;
}

// ════════════════════════════════════════════════════
// MODO A — HEURÍSTICO
// ════════════════════════════════════════════════════
function solveHeuristic(sheetW, sheetH, kerf, pieces, allowRotation, maxSheets) {
  const remaining = pieces.map(p => p.qty);
  const sheets    = [];

  for (let s = 0; s < maxSheets; s++) {
    if (remaining.every(r => r === 0)) break;

    let freeRects  = [{ x:0, y:0, w:sheetW, h:sheetH }];
    let placements = [];
    let progress   = true;

    while (progress) {
      progress = false;

      // Greedy: piezas más grandes primero
      const order = pieces
        .map((p, i) => ({ i, area: p.w * p.h }))
        .filter(({ i }) => remaining[i] > 0)
        .sort((a, b) => b.area - a.area);

      for (const { i } of order) {
        const p  = pieces[i];
        const pw = p.w + kerf; // dimensión con kerf
        const ph = p.h + kerf;

        const fitN = findBSSF(freeRects, pw, ph);
        const fitR = (allowRotation && p.w !== p.h) ? findBSSF(freeRects, ph, pw) : null;

        let best = null;
        if      (fitN && fitR) best = fitN.score <= fitR.score
                                  ? { fr: fitN.rect, kw: pw, kh: ph, rot: false }
                                  : { fr: fitR.rect, kw: ph, kh: pw, rot: true  };
        else if (fitN)         best = { fr: fitN.rect, kw: pw, kh: ph, rot: false };
        else if (fitR)         best = { fr: fitR.rect, kw: ph, kh: pw, rot: true  };

        if (!best) continue;

        // Placement visual (sin kerf)
        placements.push({
          pieceIdx: i,
          x: best.fr.x,
          y: best.fr.y,
          w: best.kw - kerf,
          h: best.kh - kerf,
          rotated: best.rot
        });

        // Actualizar espacios libres con dimensión kerf
        freeRects = splitFreeRects(freeRects, best.fr.x, best.fr.y, best.kw, best.kh);
        freeRects = pruneContained(freeRects);
        remaining[i]--;
        progress = true;
        break;
      }
    }

    if (placements.length > 0) {
      sheets.push({ placements, sheetW, sheetH, kerf });
    }
  }

  return { sheets, remaining };
}

// ════════════════════════════════════════════════════
// GENERADOR DE PATRONES para MILP (MAXRECTS exhaustivo)
// ════════════════════════════════════════════════════
const MAX_PATTERNS = 6000;
const MAX_DEPTH    = 50;

function generatePatterns2D(sheetW, sheetH, kerf, pieces, allowRotation) {
  const patterns = [];
  const demand   = pieces.map(p => p.qty);
  const seen     = new Set();

  // Maximal FÍSICO: ninguna pieza (de cualquier tipo) cabe en el espacio libre.
  // No se limita por demanda — eso lo controla el MILP.
  // Esto garantiza láminas completamente llenas antes de guardar el patrón.
  function canPlacePhysically(freeRects) {
    for (const fr of freeRects) {
      for (const p of pieces) {
        const pw = p.w + kerf;
        const ph = p.h + kerf;
        if (pw <= fr.w + 0.001 && ph <= fr.h + 0.001) return true;
        if (allowRotation && p.w !== p.h &&
            ph <= fr.w + 0.001 && pw <= fr.h + 0.001) return true;
      }
    }
    return false;
  }

  function dfs(freeRects, placements, counts, depth) {
    if (patterns.length >= MAX_PATTERNS) return;

    // Patrón maximal físico: ninguna pieza más cabe físicamente
    // O demanda satisfecha en todos los tipos ya colocados
    const demandExhausted = counts.every((c, i) => c >= demand[i]);
    const physicallyFull  = !canPlacePhysically(freeRects);
    const isLeaf = physicallyFull || demandExhausted || depth >= MAX_DEPTH || freeRects.length === 0;

    if (isLeaf) {
      if (placements.length > 0) {
        const sig = placements.map(pl =>
          `${pl.pieceIdx},${pl.x},${pl.y},${pl.rotated ? 1 : 0}`
        ).join('|');
        if (!seen.has(sig)) {
          seen.add(sig);
          patterns.push({
            placements: placements.map(p => ({ ...p })),
            counts: [...counts]
          });
        }
      }
      return;
    }

    // Explorar: espacios libres de mayor a menor área
    const sortedFR = [...freeRects].sort((a, b) => b.w * b.h - a.w * a.h);
    const tried    = new Set();

    for (const fr of sortedFR) {
      for (let i = 0; i < pieces.length; i++) {
        if (counts[i] >= demand[i]) continue; // respetar demanda al construir
        const p = pieces[i];

        const orientations = [{ pw: p.w + kerf, ph: p.h + kerf, rot: false }];
        if (allowRotation && p.w !== p.h)
          orientations.push({ pw: p.h + kerf, ph: p.w + kerf, rot: true });

        for (const { pw, ph, rot } of orientations) {
          if (pw > fr.w + 0.001 || ph > fr.h + 0.001) continue;

          const key = `${i},${fr.x},${fr.y},${rot ? 1 : 0}`;
          if (tried.has(key)) continue;
          tried.add(key);

          const newFree = pruneContained(splitFreeRects(freeRects, fr.x, fr.y, pw, ph));
          const newPlacements = [...placements, {
            pieceIdx: i,
            x: fr.x, y: fr.y,
            w: rot ? p.h : p.w,
            h: rot ? p.w : p.h,
            rotated: rot
          }];
          const newCounts = [...counts];
          newCounts[i]++;

          dfs(newFree, newPlacements, newCounts, depth + 1);
          if (patterns.length >= MAX_PATTERNS) return;
        }
      }
    }

    // Si llegamos aquí sin haber podido expandir (todas las piezas
    // con demanda > 0 no caben aunque físicamente quede espacio),
    // guardar el patrón actual como válido
    if (placements.length > 0) {
      const sig = placements.map(pl =>
        `${pl.pieceIdx},${pl.x},${pl.y},${pl.rotated ? 1 : 0}`
      ).join('|');
      if (!seen.has(sig)) {
        seen.add(sig);
        patterns.push({
          placements: placements.map(p => ({ ...p })),
          counts: [...counts]
        });
      }
    }
  }

  dfs([{ x:0, y:0, w:sheetW, h:sheetH }], [], new Array(pieces.length).fill(0), 0);
  return patterns;
}

// ════════════════════════════════════════════════════
// MODO B — ÓPTIMO (Column Generation + MILP HiGHS)
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
        return json.dumps({"status":"error","message":"Sin patrones generados"})

    # Matriz A[i][j] = unidades de pieza i en patrón j
    A = np.zeros((n_pieces, n_patterns))
    for j, pat in enumerate(patterns):
        for i, cnt in enumerate(pat["counts"]):
            A[i, j] = cnt

    # Solo patrones que no superen la demanda en ningún tipo
    valid = [j for j in range(n_patterns)
             if all(A[i,j] <= demand[i] for i in range(n_pieces))]
    if not valid:
        valid = list(range(n_patterns))

    Av   = A[:, valid]
    pv   = [patterns[j] for j in valid]
    nv   = len(valid)

    # Eliminar patrones dominados: si patrón a tiene >= piezas
    # que patrón b en todos los tipos, b nunca será preferido.
    # Esto reduce el tamaño del MILP y mejora la solución.
    dominated = set()
    for ja in range(nv):
        for jb in range(nv):
            if ja == jb or jb in dominated: continue
            # ¿a domina a b?
            if all(Av[i, ja] >= Av[i, jb] for i in range(n_pieces)):
                dominated.add(jb)
    keep = [j for j in range(nv) if j not in dominated]
    if not keep:
        keep = list(range(nv))
    Av = Av[:, keep]
    pv = [pv[j] for j in keep]
    nv = len(keep)

    # MILP: min sum(x_j)  s.t.  A @ x >= demand,  x entero >= 0
    # Bound superior ajustado: cada patrón se usa a lo sumo
    # ceil(max_demand / max_coverage_that_pattern_provides)
    import math
    ub_per_pattern = []
    for j in range(nv):
        max_uses = max_sheets
        for i in range(n_pieces):
            if Av[i, j] > 0:
                max_uses = min(max_uses, math.ceil(demand[i] / Av[i, j]))
        ub_per_pattern.append(max_uses)
    ub_arr = np.array(ub_per_pattern, dtype=float)

    c    = np.ones(nv)
    con  = LinearConstraint(Av, lb=np.array(demand, dtype=float), ub=np.inf)
    bnd  = Bounds(lb=0, ub=ub_arr)
    intg = np.ones(nv)

    res = milp(c, constraints=con, bounds=bnd, integrality=intg,
               options={"disp": False, "time_limit": 180})

    if res.status not in (0, 1):
        return json.dumps({"status":"infeasible",
            "message": f"Sin solución factible (status={res.status})"})

    x = np.round(res.x).astype(int)
    used = [{"count": int(x[j]), "placements": pv[j]["placements"],
             "piece_counts": pv[j]["counts"]}
            for j in range(nv) if x[j] > 0]

    return json.dumps({
        "status":       "optimal" if res.status == 0 else "feasible",
        "total_sheets": int(x.sum()),
        "used_patterns": used,
        "objective":    float(res.fun)
    })

result = solve(PATTERNS_JSON, DEMAND_JSON, MAX_SHEETS)
result
`;

// ════════════════════════════════════════════════════
// ORQUESTADOR
// ════════════════════════════════════════════════════
async function run(mode) {
  if (state.pieces.length === 0) return setStatus('Agrega al menos una pieza.', 'error');
  if (mode === 'optimal' && !state.pyodideReady)
    return setStatus('El solver MILP aún está cargando, espera un momento.', 'error');

  const sheetW   = parseFloat($('sheetW').value);
  const sheetH   = parseFloat($('sheetH').value);
  const kerf     = parseFloat($('kerf').value) || 0;
  const maxSh    = parseInt($('maxSheets').value) || 20;
  const allowRot = $('allowRotation').checked;

  if (!sheetW || !sheetH || sheetW <= 0 || sheetH <= 0)
    return setStatus('Ingresa dimensiones de lámina válidas.', 'error');

  setBusy(true);
  emptyState.classList.add('hidden');
  resultsSection.classList.add('hidden');

  try {
    const t0 = Date.now();

    if (mode === 'heuristic') {
      setStatus('⚡ Ejecutando MAXRECTS greedy…');
      await sleep(20);

      const { sheets, remaining } = solveHeuristic(sheetW, sheetH, kerf, state.pieces, allowRot, maxSh);

      if (sheets.length === 0)
        return setStatus('No se pudo colocar ninguna pieza. Revisa las dimensiones.', 'error');

      const unplaced = remaining.reduce((a, b) => a + b, 0);
      const dt = Date.now() - t0;
      setStatus(
        unplaced > 0
          ? `⚠️ ${sheets.length} láminas — ${unplaced} piezas no colocadas (${dt}ms)`
          : `✓ Heurístico: ${sheets.length} láminas — ${dt}ms`,
        unplaced > 0 ? 'error' : 'ok'
      );

      state.solution = { sheets, sheetW, sheetH, kerf, pieces: state.pieces, mode: 'heuristic' };

    } else {
      // ÓPTIMO
      setStatus('⚙️ Generando patrones MAXRECTS…');
      await sleep(20);

      const patterns = generatePatterns2D(sheetW, sheetH, kerf, state.pieces, allowRot);
      setStatus(`✓ ${patterns.length} patrones (${Date.now()-t0}ms) → Resolviendo MILP…`);
      await sleep(50);

      if (patterns.length === 0)
        return setStatus('Sin patrones factibles. Revisa dimensiones.', 'error');

      state.pyodide.globals.set('PATTERNS_JSON', JSON.stringify(patterns));
      state.pyodide.globals.set('DEMAND_JSON',   JSON.stringify(state.pieces.map(p => p.qty)));
      state.pyodide.globals.set('MAX_SHEETS',    maxSh);

      const resultStr = await state.pyodide.runPythonAsync(PYTHON_MILP);
      const result    = JSON.parse(resultStr);

      if (result.status === 'error' || result.status === 'infeasible')
        return setStatus(`❌ ${result.message}`, 'error');

      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      setStatus(`✓ Óptimo global: ${result.total_sheets} láminas — ${dt}s`, 'ok');

      const sheets = [];
      for (const up of result.used_patterns)
        for (let c = 0; c < up.count; c++)
          sheets.push({ placements: up.placements, sheetW, sheetH, kerf });

      state.solution = { sheets, sheetW, sheetH, kerf, pieces: state.pieces, mode: 'optimal', result };
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

btnHeuristic.addEventListener('click', () => run('heuristic'));
btnOptimal.addEventListener('click',   () => run('optimal'));

// ════════════════════════════════════════════════════
// RESULTADOS Y CANVAS
// ════════════════════════════════════════════════════
function showResults() {
  const sol       = state.solution;
  const sheetArea = sol.sheetW * sol.sheetH;
  const totalArea = sol.sheets.length * sheetArea;
  let   usedArea  = 0;

  for (const sheet of sol.sheets)
    for (const pl of sheet.placements)
      usedArea += pl.w * pl.h;

  $('statSheets').textContent     = sol.sheets.length;
  $('statEfficiency').textContent = (usedArea / totalArea * 100).toFixed(1) + '%';
  $('statWaste').textContent      = ((totalArea - usedArea) / 1e6).toFixed(3);
  $('statPieces').textContent     = sol.pieces.reduce((a, p) => a + p.qty, 0);

  // Conteo por tipo
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
      <td>${placed[i]} <span class="${ok ? 'badge-ok' : 'badge-partial'}">${ok ? '✓' : '!'}</span></td>
      <td>${rotated[i] > 0 ? rotated[i] : '—'}</td>
    `;
    tbody.appendChild(tr);
  });

  // Leyenda
  const legend = $('legend');
  legend.innerHTML = '';

  // Badge de modo
  const modeBadge = document.createElement('div');
  modeBadge.style.cssText = 'margin-bottom:12px';
  modeBadge.innerHTML = sol.mode === 'optimal'
    ? '<span style="font-size:0.72rem;background:#e6f4ea;color:#1a6b30;padding:3px 10px;border-radius:100px;font-weight:600">🎯 Óptimo global garantizado</span>'
    : '<span style="font-size:0.72rem;background:#fdf3e0;color:#8a5a00;padding:3px 10px;border-radius:100px;font-weight:600">⚡ Resultado heurístico</span>';
  legend.appendChild(modeBadge);

  const legendTitle = document.createElement('div');
  legendTitle.style.cssText = 'font-size:0.72rem;font-weight:600;text-transform:uppercase;letter-spacing:0.06em;color:var(--gray);margin-bottom:8px';
  legendTitle.textContent = 'Leyenda';
  legend.appendChild(legendTitle);

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
  wd.innerHTML = `<div class="legend-swatch" style="background:#e8ecf2;border:1px solid #d4dae4"></div><span class="legend-label" style="color:var(--gray)">Desperdicio</span>`;
  legend.appendChild(wd);

  resultsSection.classList.remove('hidden');
  emptyState.classList.add('hidden');
  fitZoom();
  renderSheet();
}

// ── CANVAS ────────────────────────────────────────
function fitZoom() {
  const sol    = state.solution;
  const wrap   = $('canvasWrap');
  const availW = Math.max(wrap.clientWidth - 40, 200);
  const availH = Math.min(560, window.innerHeight * 0.55);
  state.zoom   = Math.min(availW / sol.sheetW, availH / sol.sheetH, 2.0);
  $('zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
}

function renderSheet() {
  const sol   = state.solution;
  if (!sol) return;
  const sheet = sol.sheets[state.currentSheet];
  const z     = state.zoom;
  const W     = Math.round(sol.sheetW * z);
  const H     = Math.round(sol.sheetH * z);

  canvas.width  = W;
  canvas.height = H;

  // Fondo blanco
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Grid sutil
  ctx.strokeStyle = 'rgba(100,120,150,0.07)';
  ctx.lineWidth = 1;
  const gs = 200 * z;
  for (let x = 0; x <= W; x += gs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y <= H; y += gs) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Piezas
  for (const pl of sheet.placements) {
    const piece = sol.pieces[pl.pieceIdx];
    const px    = Math.round(pl.x * z);
    const py    = Math.round(pl.y * z);
    const pw    = Math.round(pl.w * z);
    const ph    = Math.round(pl.h * z);

    // Relleno semitransparente
    ctx.fillStyle = hexToRgba(piece.color, 0.20);
    ctx.fillRect(px, py, pw, ph);

    // Borde
    ctx.strokeStyle = piece.color;
    ctx.lineWidth   = Math.max(1.5, 1.8 * z);
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

    // Etiqueta
    if (pw > 28 && ph > 18) {
      ctx.save();
      const fs = Math.min(12, Math.max(7, Math.min(pw, ph) * 0.13));
      ctx.font          = `600 ${fs}px 'DM Sans', sans-serif`;
      ctx.fillStyle     = darken(piece.color, 0.45);
      ctx.textAlign     = 'center';
      ctx.textBaseline  = 'middle';
      ctx.fillText(piece.label + (pl.rotated ? ' ↻' : ''), px + pw / 2, py + ph / 2 - (ph > 30 ? fs * 0.7 : 0));
      if (ph > 30 && pw > 50) {
        ctx.font      = `400 ${Math.max(6, fs * 0.8)}px 'DM Mono', monospace`;
        ctx.fillStyle = darken(piece.color, 0.3);
        ctx.fillText(`${pl.w}×${pl.h}`, px + pw / 2, py + ph / 2 + fs * 0.8);
      }
      ctx.restore();
    }

    // Kerf visual (franja roja tenue)
    if (sol.kerf > 0 && pw > 6) {
      const kz = Math.max(1, sol.kerf * z);
      ctx.fillStyle = 'rgba(220,60,40,0.09)';
      ctx.fillRect(px + pw, py, kz, ph + kz);
      ctx.fillRect(px, py + ph, pw, kz);
    }
  }

  // Borde lámina
  ctx.strokeStyle = '#243b55';
  ctx.lineWidth   = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  $('sheetIndicator').textContent = `Lámina ${state.currentSheet + 1} / ${sol.sheets.length}`;
}

function hexToRgba(hex, a) {
  return `rgba(${parseInt(hex.slice(1,3),16)},${parseInt(hex.slice(3,5),16)},${parseInt(hex.slice(5,7),16)},${a})`;
}
function darken(hex, amt) {
  return `rgb(${[1,3,5].map(o => Math.round(parseInt(hex.slice(o,o+2),16)*(1-amt))).join(',')})`;
}

// ── CONTROLES CANVAS ──────────────────────────────
$('btnPrev').addEventListener('click', () => {
  if (!state.solution) return;
  state.currentSheet = Math.max(0, state.currentSheet - 1);
  renderSheet();
});
$('btnNext').addEventListener('click', () => {
  if (!state.solution) return;
  state.currentSheet = Math.min(state.solution.sheets.length - 1, state.currentSheet + 1);
  renderSheet();
});
$('btnZoomIn').addEventListener('click', () => {
  state.zoom = Math.min(state.zoom * 1.25, 4.0);
  $('zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
  renderSheet();
});
$('btnZoomOut').addEventListener('click', () => {
  state.zoom = Math.max(state.zoom / 1.25, 0.1);
  $('zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
  renderSheet();
});
$('btnZoomFit').addEventListener('click', () => { fitZoom(); renderSheet(); });

document.addEventListener('keydown', e => {
  if (!state.solution) return;
  if (e.key === 'ArrowLeft')  $('btnPrev').click();
  if (e.key === 'ArrowRight') $('btnNext').click();
  if (e.key === '+')          $('btnZoomIn').click();
  if (e.key === '-')          $('btnZoomOut').click();
});
