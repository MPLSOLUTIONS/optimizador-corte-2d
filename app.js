/* =====================================================
   OPTIMIZADOR DE CORTE 2D — app.js
   Arquitectura: Column Generation + MILP (HiGHS via Pyodide)
   
   FLUJO:
   1. Usuario ingresa lámina + piezas
   2. generatePatterns2D() → enumera arreglos válidos de piezas
      usando Skyline packing exhaustivo con poda
   3. solveMILP() → Pyodide ejecuta Python con scipy.optimize.milp
      Minimiza: número de láminas
      S.t.: cobertura de demanda de cada tipo de pieza
   4. renderCanvas() → dibuja resultado en Canvas interactivo
   ===================================================== */

'use strict';

// ── COLORES POR PIEZA ─────────────────────────────
const PIECE_COLORS = [
  '#4a90d9','#e8a838','#3daa6e','#9b59b6','#e74c3c',
  '#16a085','#d35400','#2980b9','#8e44ad','#27ae60',
  '#c0392b','#f39c12','#1abc9c','#2c3e50','#e91e63',
  '#00bcd4','#ff5722','#607d8b','#795548','#009688'
];

// ── ESTADO GLOBAL ─────────────────────────────────
const state = {
  pieces: [],        // [{id, label, w, h, qty, color}]
  solution: null,    // resultado del solver
  currentSheet: 0,   // lámina visible en canvas
  zoom: 1.0,
  pyodideReady: false,
  pyodide: null,
};

// ── DOM REFS ──────────────────────────────────────
const $ = id => document.getElementById(id);
const solverBadge   = $('solverBadge');
const solverStatus  = $('solverStatus');
const statusBar     = $('statusBar');
const pieceList     = $('pieceList');
const btnSolve      = $('btnSolve');
const emptyState    = $('emptyState');
const resultsSection = $('resultsSection');
const canvas        = $('cutCanvas');
const ctx           = canvas.getContext('2d');

// ── INIT PYODIDE ──────────────────────────────────
async function initPyodide() {
  setStatus('Cargando Pyodide…');
  try {
    const pyodide = await loadPyodide({
      indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/'
    });
    await pyodide.loadPackage(['scipy', 'numpy']);
    state.pyodide = pyodide;
    state.pyodideReady = true;
    solverStatus.textContent = 'HiGHS listo ⚡';
    const dot = solverBadge.querySelector('.dot');
    dot.classList.add('ready');
    setStatus('');
  } catch (e) {
    solverStatus.textContent = 'Solver no disponible';
    const dot = solverBadge.querySelector('.dot');
    dot.classList.add('error');
    setStatus('Error al cargar Pyodide. Verifica tu conexión.', 'error');
  }
}

// Cargar Pyodide script dinámicamente
const pyScript = document.createElement('script');
pyScript.src = 'https://cdn.jsdelivr.net/pyodide/v0.25.1/full/pyodide.js';
pyScript.onload = initPyodide;
document.head.appendChild(pyScript);

// ── UI HELPERS ────────────────────────────────────
function setStatus(msg, type = '') {
  statusBar.textContent = msg;
  statusBar.className = 'status-bar' + (type ? ' ' + type : '');
}

function nextColor() {
  return PIECE_COLORS[state.pieces.length % PIECE_COLORS.length];
}

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
      <button class="btn-del" data-i="${i}" title="Eliminar">✕</button>
    `;
    pieceList.appendChild(div);
  });
  pieceList.querySelectorAll('.btn-del').forEach(btn => {
    btn.addEventListener('click', () => {
      state.pieces.splice(+btn.dataset.i, 1);
      renderPieceList();
    });
  });
}

// ── ADD PIECE ─────────────────────────────────────
$('btnAdd').addEventListener('click', () => {
  const w   = parseFloat($('pieceW').value);
  const h   = parseFloat($('pieceH').value);
  const qty = parseInt($('pieceQty').value) || 1;
  const lbl = $('pieceLabel').value.trim();
  const shW = parseFloat($('sheetW').value);
  const shH = parseFloat($('sheetH').value);

  if (!w || !h || w <= 0 || h <= 0) return setStatus('Ingresa dimensiones válidas.', 'error');
  if ((w > shW && h > shH) || (h > shW && w > shH)) return setStatus('La pieza no cabe en la lámina.', 'error');

  const label = lbl || `Pieza ${String.fromCharCode(65 + state.pieces.length)}`;
  state.pieces.push({ id: state.pieces.length, label, w, h, qty, color: nextColor() });
  renderPieceList();

  // Reset inputs
  $('pieceW').value = ''; $('pieceH').value = '';
  $('pieceQty').value = '1'; $('pieceLabel').value = '';
  setStatus('');
});

// ── CARGAR EJEMPLO ────────────────────────────────
function loadExample() {
  $('sheetW').value = 2440; $('sheetH').value = 1220; $('kerf').value = 3;
  state.pieces = [
    { id:0, label:'Panel A', w:800, h:600, qty:4, color:PIECE_COLORS[0] },
    { id:1, label:'Panel B', w:1200, h:400, qty:3, color:PIECE_COLORS[1] },
    { id:2, label:'Tapa',    w:500, h:300, qty:6, color:PIECE_COLORS[2] },
    { id:3, label:'Lateral', w:600, h:900, qty:2, color:PIECE_COLORS[3] },
  ];
  renderPieceList();
  setStatus('Ejemplo cargado. Presiona Optimizar.');
}
// Auto-cargar ejemplo
loadExample();

// ── GENERADOR DE PATRONES 2D ──────────────────────
/*
  Genera todos los arreglos válidos de piezas en una lámina.
  Método: Skyline exhaustivo con poda por demanda.
  
  Un "patrón" es un objeto:
    { placements: [{pieceIdx, x, y, w, h, rotated}], counts: [n0, n1, ...] }
  
  Estrategia: para evitar explosión combinatorial, usamos
  un enfoque de "skyline + enumeración de llenado" que:
  1. Mantiene el perfil skyline de la lámina
  2. En cada paso, prueba colocar cada tipo de pieza (con y sin rotación)
     en la posición de skyline más baja (leftmost-bottommost)
  3. Poda cuando ya no caben más piezas o se supera la demanda
  4. Registra el patrón completo (no solo el llenado máximo)
  
  Para el MILP necesitamos TODOS los patrones que sean
  subconjuntos de la demanda total.
  
  Limitamos a MAX_PATTERNS para mantener el MILP tratable.
*/
const MAX_PATTERNS = 5000;

function generatePatterns2D(sheetW, sheetH, kerf, pieces, allowRotation) {
  const patterns = [];
  const demand = pieces.map(p => p.qty);
  
  // Tipos de pieza expandidos con rotación
  // typeVariants[i] = [{w, h, rotated}] para pieza i
  const typeVariants = pieces.map((p, i) => {
    const variants = [{ pieceIdx: i, w: p.w + kerf, h: p.h + kerf, rotated: false }];
    if (allowRotation && p.w !== p.h) {
      variants.push({ pieceIdx: i, w: p.h + kerf, h: p.w + kerf, rotated: true });
    }
    return variants;
  });

  // BFS/DFS con Skyline packing
  // Estado: { skyline: [height per column strip], placements, counts }
  // Skyline simplificado: array de {x, y, w} segmentos horizontales
  
  function packRecursive(skyline, placements, counts, depth) {
    if (patterns.length >= MAX_PATTERNS) return;

    // Registrar patrón actual si tiene al menos una pieza
    if (placements.length > 0) {
      patterns.push({
        placements: placements.map(p => ({...p})),
        counts: [...counts]
      });
    }
    if (depth > 60) return; // límite de profundidad

    // Encontrar el punto más bajo-izquierdo en el skyline
    const pt = findLowestPoint(skyline, sheetW, sheetH);
    if (!pt) return; // lámina llena

    // Probar cada tipo de pieza y variante
    for (let i = 0; i < pieces.length; i++) {
      if (counts[i] >= demand[i]) continue; // demanda satisfecha
      
      for (const variant of typeVariants[i]) {
        const pw = variant.w;
        const ph = variant.h;

        // ¿Cabe en la posición del skyline?
        if (pt.x + pw > sheetW + 0.001) continue;
        if (pt.y + ph > sheetH + 0.001) continue;

        // ¿El espacio está libre en el skyline?
        if (!canPlace(skyline, pt.x, pt.y, pw, ph)) continue;

        // Colocar
        const newSkyline = updateSkyline(skyline, pt.x, pt.y, pw, ph);
        const newPlacements = [...placements, {
          pieceIdx: i,
          x: pt.x, y: pt.y,
          w: pw - kerf, h: ph - kerf, // dimensión real sin kerf
          rotated: variant.rotated
        }];
        const newCounts = [...counts];
        newCounts[i]++;

        packRecursive(newSkyline, newPlacements, newCounts, depth + 1);

        if (patterns.length >= MAX_PATTERNS) return;
      }
    }
  }

  // Skyline inicial: un solo segmento a altura 0
  const initialSkyline = [{ x: 0, y: 0, w: sheetW }];
  const initialCounts = new Array(pieces.length).fill(0);

  packRecursive(initialSkyline, [], initialCounts, 0);

  // Eliminar duplicados por firma de counts
  const seen = new Set();
  const unique = [];
  for (const p of patterns) {
    // La firma incluye el hash de placements para distinguir arreglos distintos
    // con el mismo conteo (distintas posiciones = distintos patrones físicos)
    const sig = p.placements.map(pl => `${pl.pieceIdx},${pl.x},${pl.y},${pl.rotated?1:0}`).join('|');
    if (!seen.has(sig)) { seen.add(sig); unique.push(p); }
  }

  return unique;
}

// ── SKYLINE HELPERS ───────────────────────────────

function findLowestPoint(skyline, sheetW, sheetH) {
  // Encuentra el segmento con menor altura (más bajo) y más a la izquierda
  let best = null;
  for (const seg of skyline) {
    if (seg.y >= sheetH) continue;
    if (!best || seg.y < best.y || (seg.y === best.y && seg.x < best.x)) {
      best = { x: seg.x, y: seg.y };
    }
  }
  return best;
}

function canPlace(skyline, x, y, w, h) {
  // Verifica que el rectángulo [x, x+w] × [y, y+h] no viole el skyline
  // es decir, que para todo segmento que se superponga en X, su altura <= y
  for (const seg of skyline) {
    const segEnd = seg.x + seg.w;
    const rectEnd = x + w;
    // ¿Se superponen en X?
    if (seg.x < rectEnd && segEnd > x) {
      if (seg.y > y) return false; // hay algo más alto que bloquea
    }
  }
  return true;
}

function updateSkyline(skyline, x, y, w, h) {
  // Coloca una pieza y actualiza el skyline
  // La nueva altura en [x, x+w] es y+h
  const newTop = y + h;
  const rectEnd = x + w;

  // Clonar skyline y aplicar el nuevo bloque
  let segs = skyline.map(s => ({...s}));
  
  // Dividir/actualizar segmentos afectados
  const result = [];
  for (const seg of segs) {
    const segEnd = seg.x + seg.w;
    // Sin solapamiento
    if (segEnd <= x || seg.x >= rectEnd) {
      result.push(seg);
      continue;
    }
    // Parte izquierda que no se solapa
    if (seg.x < x) result.push({ x: seg.x, y: seg.y, w: x - seg.x });
    // Parte derecha que no se solapa
    if (segEnd > rectEnd) result.push({ x: rectEnd, y: seg.y, w: segEnd - rectEnd });
  }
  // Agregar el nuevo segmento elevado
  result.push({ x, y: newTop, w });
  
  // Ordenar por x y fusionar segmentos adyacentes de igual altura
  result.sort((a, b) => a.x - b.x);
  const merged = [];
  for (const seg of result) {
    if (merged.length > 0) {
      const last = merged[merged.length - 1];
      if (Math.abs(last.x + last.w - seg.x) < 0.001 && Math.abs(last.y - seg.y) < 0.001) {
        last.w += seg.w;
        continue;
      }
    }
    merged.push({...seg});
  }
  return merged;
}

// ── PYTHON MILP (ejecutado en Pyodide) ───────────
/*
  Formulación:
  - Variables:  x_j ∈ Z⁺  (cuántas veces se usa el patrón j)
  - Objetivo:   min Σ x_j   (minimizar láminas)
  - S.t.:       Σ_j a_{ij} * x_j >= demand_i   ∀ i (cubrir demanda)
                x_j <= max_sheets
                x_j ∈ Z⁺
  
  donde a_{ij} = número de piezas de tipo i en el patrón j
*/

const PYTHON_SOLVER = `
import json
import numpy as np
from scipy.optimize import milp, LinearConstraint, Bounds

def solve_2d_milp(patterns_json, demand_json, max_sheets):
    patterns = json.loads(patterns_json)
    demand = json.loads(demand_json)
    
    n_pieces = len(demand)
    n_patterns = len(patterns)
    
    if n_patterns == 0:
        return json.dumps({"status": "error", "message": "No se generaron patrones"})
    
    # Matriz A: A[i][j] = piezas de tipo i en patrón j
    A = np.zeros((n_pieces, n_patterns), dtype=float)
    for j, pat in enumerate(patterns):
        for i, cnt in enumerate(pat["counts"]):
            A[i, j] = cnt
    
    # Filtrar patrones que son subconjunto de la demanda
    # (no tiene sentido usar un patrón con más piezas de las que necesitamos)
    valid = []
    for j in range(n_patterns):
        ok = all(A[i, j] <= demand[i] for i in range(n_pieces))
        if ok:
            valid.append(j)
    
    if not valid:
        # Si no hay patrones válidos, usar todos
        valid = list(range(n_patterns))
    
    A = A[:, valid]
    patterns_valid = [patterns[j] for j in valid]
    n_patterns = len(valid)
    
    # Función objetivo: minimizar suma de x_j
    c = np.ones(n_patterns)
    
    # Restricciones: A @ x >= demand
    constraints = LinearConstraint(A, lb=np.array(demand, dtype=float), ub=np.inf)
    
    # Bounds: 0 <= x_j <= max_sheets, x_j entero
    bounds = Bounds(lb=0, ub=max_sheets)
    integrality = np.ones(n_patterns)  # todas enteras
    
    result = milp(c, constraints=constraints, bounds=bounds,
                  integrality=integrality,
                  options={"disp": False, "time_limit": 120})
    
    if result.status not in (0, 1):
        return json.dumps({
            "status": "infeasible",
            "message": f"Sin solución factible (status={result.status})"
        })
    
    # Construir solución
    x = np.round(result.x).astype(int)
    used_patterns = []
    for j in range(n_patterns):
        if x[j] > 0:
            used_patterns.append({
                "count": int(x[j]),
                "placements": patterns_valid[j]["placements"],
                "piece_counts": patterns_valid[j]["counts"]
            })
    
    total_sheets = int(x.sum())
    
    return json.dumps({
        "status": "optimal" if result.status == 0 else "feasible",
        "total_sheets": total_sheets,
        "used_patterns": used_patterns,
        "objective": float(result.fun)
    })

result = solve_2d_milp(PATTERNS_JSON, DEMAND_JSON, MAX_SHEETS)
result
`;

// ── SOLVER PRINCIPAL ──────────────────────────────
async function solve() {
  if (state.pieces.length === 0) return setStatus('Agrega al menos una pieza.', 'error');
  if (!state.pyodideReady) return setStatus('Espera que el solver termine de cargar.', 'error');

  const sheetW = parseFloat($('sheetW').value);
  const sheetH = parseFloat($('sheetH').value);
  const kerf   = parseFloat($('kerf').value) || 0;
  const maxSh  = parseInt($('maxSheets').value) || 20;
  const allowRotation = $('allowRotation').checked;

  if (!sheetW || !sheetH) return setStatus('Ingresa dimensiones de lámina.', 'error');

  btnSolve.disabled = true;
  emptyState.classList.add('hidden');
  resultsSection.classList.add('hidden');

  try {
    // PASO 1: Generar patrones
    setStatus('⚙️ Generando patrones de corte…');
    await sleep(20);
    const t0 = Date.now();
    const patterns = generatePatterns2D(sheetW, sheetH, kerf, state.pieces, allowRotation);
    const t1 = Date.now();
    
    if (patterns.length === 0) {
      return setStatus('No se encontraron patrones factibles. Revisa las dimensiones.', 'error');
    }
    setStatus(`✓ ${patterns.length} patrones generados (${t1-t0}ms). Resolviendo MILP…`);
    await sleep(50);

    // PASO 2: MILP en Pyodide
    const patternsJSON = JSON.stringify(patterns);
    const demandJSON   = JSON.stringify(state.pieces.map(p => p.qty));

    state.pyodide.globals.set('PATTERNS_JSON', patternsJSON);
    state.pyodide.globals.set('DEMAND_JSON', demandJSON);
    state.pyodide.globals.set('MAX_SHEETS', maxSh);

    const resultStr = await state.pyodide.runPythonAsync(PYTHON_SOLVER);
    const result = JSON.parse(resultStr);

    if (result.status === 'error' || result.status === 'infeasible') {
      return setStatus(`❌ ${result.message}`, 'error');
    }

    const t2 = Date.now();
    setStatus(`✓ Óptimo encontrado en ${((t2-t0)/1000).toFixed(1)}s`, 'ok');

    // Expandir patrones en láminas individuales
    const sheets = expandToSheets(result.used_patterns, sheetW, sheetH, kerf);
    state.solution = { sheets, sheetW, sheetH, kerf, pieces: state.pieces, result };
    state.currentSheet = 0;
    state.zoom = 1.0;

    showResults();

  } catch (e) {
    setStatus(`Error: ${e.message}`, 'error');
    console.error(e);
  } finally {
    btnSolve.disabled = false;
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── EXPANDIR PATRONES A LÁMINAS INDIVIDUALES ─────
function expandToSheets(usedPatterns, sheetW, sheetH, kerf) {
  const sheets = [];
  for (const up of usedPatterns) {
    for (let c = 0; c < up.count; c++) {
      sheets.push({
        placements: up.placements,
        sheetW, sheetH, kerf
      });
    }
  }
  return sheets;
}

// ── MOSTRAR RESULTADOS ────────────────────────────
function showResults() {
  const sol = state.solution;
  const sheetArea = sol.sheetW * sol.sheetH;
  const totalArea = sol.sheets.length * sheetArea;

  // Área ocupada por piezas
  let usedArea = 0;
  for (const sheet of sol.sheets) {
    for (const pl of sheet.placements) {
      usedArea += pl.w * pl.h;
    }
  }
  const efficiency = (usedArea / totalArea * 100).toFixed(1);
  const wasteMm2   = totalArea - usedArea;
  const wasteM2    = (wasteMm2 / 1e6).toFixed(3);

  $('statSheets').textContent     = sol.sheets.length;
  $('statEfficiency').textContent = efficiency + '%';
  $('statWaste').textContent      = wasteM2;
  $('statPieces').textContent     = sol.pieces.reduce((a, p) => a + p.qty, 0);

  // Tabla de piezas
  const tbody = $('resultTableBody');
  tbody.innerHTML = '';
  
  // Contar piezas colocadas y rotadas
  const placed   = new Array(sol.pieces.length).fill(0);
  const rotated  = new Array(sol.pieces.length).fill(0);
  for (const sheet of sol.sheets) {
    for (const pl of sheet.placements) {
      placed[pl.pieceIdx]++;
      if (pl.rotated) rotated[pl.pieceIdx]++;
    }
  }

  sol.pieces.forEach((p, i) => {
    const ok = placed[i] >= p.qty;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><div class="td-name"><div class="td-swatch" style="background:${p.color}"></div>${p.label}</div></td>
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
  // Desperdicio
  const wasteDiv = document.createElement('div');
  wasteDiv.className = 'legend-item';
  wasteDiv.innerHTML = `<div class="legend-swatch" style="background:#e8ecf2;border:1px solid #d4dae4"></div><span class="legend-label">Desperdicio</span>`;
  legend.appendChild(wasteDiv);

  resultsSection.classList.remove('hidden');
  emptyState.classList.add('hidden');

  fitZoom();
  renderSheet();
}

// ── CANVAS RENDER ─────────────────────────────────
function fitZoom() {
  const sol = state.solution;
  const wrap = $('canvasWrap');
  const availW = wrap.clientWidth - 40;
  const availH = Math.min(600, window.innerHeight * 0.55);
  const zW = availW / sol.sheetW;
  const zH = availH / sol.sheetH;
  state.zoom = Math.min(zW, zH, 2.0);
  $('zoomLevel').textContent = Math.round(state.zoom * 100) + '%';
}

function renderSheet() {
  const sol = state.solution;
  if (!sol) return;

  const sheet = sol.sheets[state.currentSheet];
  const z = state.zoom;
  const W = Math.round(sol.sheetW * z);
  const H = Math.round(sol.sheetH * z);

  canvas.width  = W;
  canvas.height = H;

  // Fondo lámina
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);

  // Grid sutil
  ctx.strokeStyle = 'rgba(100,120,150,0.08)';
  ctx.lineWidth = 1;
  const gridStep = 200 * z;
  for (let x = 0; x < W; x += gridStep) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += gridStep) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // Piezas
  const kerf = sol.kerf;
  for (const pl of sheet.placements) {
    const piece = sol.pieces[pl.pieceIdx];
    const px = Math.round(pl.x * z);
    const py = Math.round(pl.y * z);
    const pw = Math.round(pl.w * z);
    const ph = Math.round(pl.h * z);

    // Fondo de pieza con color semitransparente
    ctx.fillStyle = hexToRgba(piece.color, 0.22);
    ctx.fillRect(px, py, pw, ph);

    // Borde
    ctx.strokeStyle = piece.color;
    ctx.lineWidth = Math.max(1.5, 2 * z);
    ctx.strokeRect(px + 0.5, py + 0.5, pw - 1, ph - 1);

    // Etiqueta
    if (pw > 30 && ph > 20) {
      ctx.save();
      ctx.font = `500 ${Math.min(11, Math.max(7, pw * 0.08))}px 'DM Sans', sans-serif`;
      ctx.fillStyle = darken(piece.color, 0.4);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      
      const label = piece.label + (pl.rotated ? ' ↻' : '');
      const dimStr = `${pl.w}×${pl.h}`;
      
      ctx.fillText(label, px + pw/2, py + ph/2 - (pw > 60 ? 7 : 0));
      if (pw > 60 && ph > 32) {
        ctx.font = `400 ${Math.min(9, Math.max(6, pw * 0.065))}px 'DM Mono', monospace`;
        ctx.fillStyle = darken(piece.color, 0.3);
        ctx.fillText(dimStr, px + pw/2, py + ph/2 + 9);
      }
      ctx.restore();
    }

    // Kerf visual (línea fina en el borde)
    if (kerf > 0 && pw > 8) {
      const kz = Math.max(1, kerf * z);
      ctx.fillStyle = 'rgba(200,50,50,0.10)';
      ctx.fillRect(px + pw, py, kz, ph + kz);
      ctx.fillRect(px, py + ph, pw, kz);
    }
  }

  // Borde exterior de la lámina
  ctx.strokeStyle = '#243b55';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  // Indicador de lámina
  $('sheetIndicator').textContent = `Lámina ${state.currentSheet + 1} / ${sol.sheets.length}`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function darken(hex, amount) {
  const r = Math.round(parseInt(hex.slice(1,3),16) * (1-amount));
  const g = Math.round(parseInt(hex.slice(3,5),16) * (1-amount));
  const b = Math.round(parseInt(hex.slice(5,7),16) * (1-amount));
  return `rgb(${r},${g},${b})`;
}

// ── NAVEGACIÓN Y ZOOM ─────────────────────────────
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
$('btnZoomFit').addEventListener('click', () => {
  fitZoom();
  renderSheet();
});

// Teclado
document.addEventListener('keydown', e => {
  if (!state.solution) return;
  if (e.key === 'ArrowLeft')  { $('btnPrev').click(); }
  if (e.key === 'ArrowRight') { $('btnNext').click(); }
  if (e.key === '+') { $('btnZoomIn').click(); }
  if (e.key === '-') { $('btnZoomOut').click(); }
});

// ── BOTÓN RESOLVER ────────────────────────────────
btnSolve.addEventListener('click', solve);
