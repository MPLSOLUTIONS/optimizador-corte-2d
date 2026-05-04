# ✦ Optimizador de Corte 2D

Herramienta web para planificación de cortes en láminas rectangulares (planchas, vidrio, madera, metales) que **minimiza el número de láminas usadas**. Ofrece dos modos: resultado inmediato con heurístico MAXRECTS o **óptimo global garantizado** mediante programación lineal entera (MILP) con solver HiGHS.

---

## ¿Qué hace?

Dado el tamaño de una lámina estándar y una lista de piezas rectangulares a cortar, calcula el **plan de corte óptimo**: cuántas láminas usar, cómo distribuir las piezas en cada una (con rotación 90° opcional), y cuánto material se desperdicia.

El algoritmo detecta y aprovecha **todos los espacios libres disponibles** en cada lámina — no solo posiciones guillotina. Piezas de distintos tamaños pueden intercalarse libremente en cualquier configuración rectangular válida.

---

## Demo

🔗 **[Abrir herramienta](https://MPLSOLUTIONS.github.io/optimizador-corte-2d/)**

---

## Dos modos de resolución

### ⚡ Heurístico (~1 segundo)
Usa MAXRECTS greedy con heurística **Best Short Side Fit (BSSF)**. Encuentra una buena solución de forma inmediata, típicamente dentro del 85–95% del óptimo. Útil para instancias grandes o para obtener una vista previa rápida antes de lanzar el solver.

### 🎯 Óptimo global (MILP · HiGHS)
Garantiza matemáticamente que no existe una solución con menos láminas. Usa el mismo solver HiGHS que herramientas industriales de corte. Puede tardar 10–60 segundos dependiendo del número de tipos de piezas y demanda total.

---

## Características

- **Empaquetado libre con MAXRECTS** — detecta todos los espacios rectangulares disponibles tras cada colocación; no hay restricción de corte guillotina implícita
- **Rotación 90°** — evalúa ambas orientaciones de cada pieza y elige la que mejor aprovecha el espacio
- **Patrones maximales** — el generador solo guarda arreglos completamente llenos (ninguna pieza más cabe físicamente), lo que produce patrones de alta calidad para el MILP
- **Óptimo global garantizado** — formulación Column Generation + MILP de cobertura con `scipy.optimize.milp` + HiGHS
- **Sin instalación** — corre 100% en el navegador (Pyodide + WebAssembly)
- **Visualización interactiva** — Canvas con zoom (+/−), navegación entre láminas (← →), kerf visual
- **Kerf configurable** — ancho de corte de la sierra incluido en todos los cálculos
- **Leyenda y tabla de resultados** — muestra piezas colocadas, rotadas y badge de modo (heurístico / óptimo)
- **Ejemplo precargado** — caso de prueba listo para usar al abrir la herramienta

---

## Cómo usar

1. Ingresa el **ancho y alto de tu lámina estándar** (ej: 2440 × 1220 mm)
2. Ingresa el **kerf** de tu sierra (ej: 3 mm)
3. Agrega las **piezas que necesitas** con ancho, alto, cantidad y etiqueta opcional
4. Activa o desactiva **rotación 90°** según tu proceso productivo
5. Elige el modo:
   - **⚡ Heurístico** para resultado inmediato
   - **🎯 Óptimo global** para la solución mínima garantizada (requiere que Pyodide termine de cargar)
6. Navega entre láminas con las flechas o teclas ← → y revisa las estadísticas

---

## Tecnología

| Componente | Detalle |
|---|---|
| **Solver óptimo** | `scipy.optimize.milp` con HiGHS (MILP industrial) |
| **Runtime Python** | Pyodide 0.25 (Python 3.11 en WebAssembly) |
| **Generador de patrones** | MAXRECTS exhaustivo con DFS — patrones maximales físicos |
| **Heurístico** | MAXRECTS greedy Best Short Side Fit (BSSF) |
| **Formulación** | Column Generation + MILP de cobertura |
| **Frontend** | HTML + CSS + JS puro, sin frameworks |

---

## Contexto técnico

El problema de corte 2D es una variante del **2D Bin Packing Problem**, clasificado como NP-hard. La herramienta lo resuelve en dos etapas:

### 1. Generador de patrones — MAXRECTS Free Rectangles

A diferencia del Skyline clásico, MAXRECTS mantiene una lista de **todos los rectángulos libres maximales** después de cada colocación. Al colocar una pieza en posición (x, y) con dimensiones (w, h), cada rectángulo libre que se solape se divide en hasta 4 sub-rectángulos (franja superior, inferior, izquierda, derecha), y luego se eliminan los que quedan contenidos dentro de otros.

Esto garantiza que **ningún espacio aprovechable queda sin detectar**, independientemente de cómo quedaron distribuidas las piezas anteriores.

El generador usa DFS exhaustivo con poda, y solo guarda patrones **maximales físicos**: aquellos donde ya no cabe ninguna pieza más en el espacio libre restante (sin importar la demanda). Esto asegura que el MILP solo trabaja con láminas bien aprovechadas, hasta un máximo de 6.000 patrones distintos.

### 2. MILP de selección — Column Generation

Con los patrones generados, se formula el problema de selección:

```
min  Σ xⱼ                           (minimizar láminas)
s.t. Σⱼ aᵢⱼ · xⱼ ≥ demandᵢ  ∀ i   (cubrir demanda de cada tipo)
     xⱼ ∈ ℤ⁺                        (enteras no negativas)
```

donde `aᵢⱼ` = unidades de pieza tipo `i` en el patrón `j`. HiGHS resuelve esto garantizando el óptimo global sobre el espacio de patrones generados.

Esta arquitectura es idéntica en concepto al **Optimizador de Corte 1D** de este portal.

---

## Estructura del proyecto

```
optimizador-corte-2d/
├── index.html   # Estructura HTML, inputs, layout
├── style.css    # Estilos — identidad visual MPL Solutions
└── app.js       # Lógica completa: MAXRECTS, MILP, Canvas
```

Los tres archivos están separados para facilitar edición quirúrgica sin reescribir el proyecto completo.

**Secciones de `app.js`:**
- `splitFreeRects / pruneContained / findBSSF` — núcleo MAXRECTS (funciones puras)
- `solveHeuristic()` — modo greedy multi-lámina
- `generatePatterns2D()` — DFS exhaustivo con patrones maximales
- `PYTHON_MILP` — código Python embebido, ejecutado en Pyodide
- `run()` — orquestador de ambos modos
- `renderSheet()` — Canvas con zoom y etiquetas

---

## Limitaciones

- La primera carga del modo óptimo tarda ~15–30 segundos (descarga Pyodide ~30 MB, una vez por sesión)
- El generador está limitado a 6.000 patrones; instancias con muchos tipos de piezas de tamaños muy distintos pueden no alcanzar el óptimo teórico absoluto
- Para instancias muy grandes (+15 tipos de piezas con alta demanda), el tiempo de resolución MILP puede superar el minuto
- Requiere conexión a internet para cargar Pyodide desde CDN
- El modo heurístico no garantiza óptimo global; puede usar 5–15% más láminas que el óptimo

---

## Parte del Portal MPL Solutions

Este optimizador es parte del **[Portal de Gestión Empresarial MPL Solutions](https://mplsolutions.github.io/)**, una colección de herramientas gratuitas desarrolladas con Claude AI.

| Herramienta | Descripción |
|---|---|
| [Optimizador de Corte 1D](https://mplsolutions.github.io/optimizador-corte/) | Minimiza desperdicio en cortes lineales (vigas, tubos, perfiles) |
| [Optimizador de Corte 2D](https://mplsolutions.github.io/optimizador-corte-2d/) | Minimiza desperdicio en láminas rectangulares |
| [Evaluador de Proyectos](https://mplsolutions.github.io/evaluador-proyectos/) | VAN, TIR, Payback, análisis de sensibilidad |

---

## Desarrollo

Desarrollado por **Matías Parra** · MPL Solutions  
Construido con Claude AI · Anthropic

---

## Licencia

MIT — libre para uso personal y comercial.
