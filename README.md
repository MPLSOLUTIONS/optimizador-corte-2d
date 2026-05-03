# ✦ Optimizador de Corte 2D

Herramienta web para planificación de cortes en láminas rectangulares (planchas, vidrio, madera, metales) que **minimiza el número de láminas usadas** — óptimo global garantizado mediante programación lineal entera (MILP) con solver HiGHS.

---

## ¿Qué hace?

Dado el tamaño de una lámina estándar y una lista de piezas rectangulares a cortar, la herramienta calcula el **plan de corte óptimo**: cuántas láminas usar, cómo distribuir las piezas en cada una (con rotación 90° opcional), y cuánto material se desperdicia — garantizando que no existe una solución mejor.

---

## Demo

🔗 **[Abrir herramienta](https://MPLSOLUTIONS.github.io/optimizador-corte-2d/)**

---

## Características

- **Óptimo global garantizado** — usa `scipy.optimize.milp` con solver HiGHS, el mismo estándar industrial
- **Sin instalación** — corre 100% en el navegador (Pyodide + WebAssembly)
- **Rotación 90°** — permite rotar piezas para mejorar el aprovechamiento
- **Empaquetado libre** — no se limita a cortes guillotina; coloca piezas en cualquier posición válida
- **Visualización interactiva** — Canvas con zoom, navegación entre láminas, kerf visual
- **Kerf configurable** — incluye el ancho de corte de la sierra en los cálculos
- **Ejemplo precargado** — viene con un caso de prueba listo para usar

---

## Cómo usar

1. Ingresa el **ancho y alto de tu lámina estándar** (ej: 2440 × 1220 mm)
2. Ingresa el **kerf** de tu sierra (ej: 3 mm)
3. Define el **máximo de láminas** que deseas usar
4. Agrega las **piezas que necesitas** con su ancho, alto y cantidad
5. Activa o desactiva **rotación 90°** según tu proceso
6. Presiona **Optimizar cortes**
7. Espera que el solver calcule (10–30 segundos la primera vez mientras carga Pyodide)
8. Navega entre láminas con las flechas y revisa las estadísticas de eficiencia

---

## Tecnología

| Componente | Detalle |
|---|---|
| **Solver** | `scipy.optimize.milp` con HiGHS (MILP industrial) |
| **Runtime Python** | Pyodide 0.25 (Python 3.11 en WebAssembly) |
| **Generador de patrones** | Skyline packing exhaustivo con poda |
| **Formulación** | Column Generation + MILP de cobertura |
| **Frontend** | HTML + CSS + JS puro, sin frameworks |

---

## Contexto técnico

El problema de corte 2D es una extensión del **2D Bin Packing Problem**, clasificado como NP-hard. La herramienta lo resuelve en dos etapas:

1. **Generación de patrones**: usando un empaquetador Skyline exhaustivo, enumera todos los arreglos físicamente válidos de piezas que caben en una lámina (hasta 5.000 patrones distintos), con soporte para rotación 90°.

2. **MILP de selección**: formula el problema como minimizar el número de láminas (`Σ xⱼ`) sujeto a que cada tipo de pieza quede completamente cubierto por los patrones seleccionados, y lo resuelve con HiGHS garantizando el óptimo global.

Esta arquitectura — **Column Generation + MILP** — es la misma usada en software industrial de corte y es idéntica en concepto al Optimizador 1D de este portal.

---

## Estructura del proyecto

```
optimizador-corte-2d/
├── index.html   # Estructura HTML e inputs
├── style.css    # Estilos (identidad visual MPL Solutions)
└── app.js       # Lógica completa: generador, solver, Canvas
```

Los archivos están separados para facilitar edición sin gastar tokens innecesariamente.

---

## Limitaciones

- La primera carga tarda ~15–30 segundos (descarga Pyodide ~30 MB, solo una vez por sesión)
- Para instancias muy grandes (+20 tipos de piezas con alta demanda), el tiempo de resolución puede aumentar significativamente
- El generador de patrones está limitado a 5.000 patrones para mantener el MILP tratable; en casos extremos puede no alcanzar el óptimo teórico
- Requiere conexión a internet para cargar Pyodide desde CDN

---

## Parte del Portal MPL Solutions

Este optimizador es parte del **[Portal de Gestión Empresarial MPL Solutions](https://mplsolutions.github.io/)**, una colección de herramientas gratuitas de gestión desarrolladas con Claude AI.

| Herramienta | Descripción |
|---|---|
| [Optimizador de Corte 1D](https://mplsolutions.github.io/optimizador-corte/) | Minimiza desperdicio en cortes lineales |
| [Optimizador de Corte 2D](https://mplsolutions.github.io/optimizador-corte-2d/) | Minimiza desperdicio en láminas rectangulares |
| [Evaluador de Proyectos](https://mplsolutions.github.io/evaluador-proyectos/) | VAN, TIR, Payback, análisis de sensibilidad |

---

## Desarrollo

Desarrollado por **Matías Parra** · MPL Solutions  
Construido con Claude AI · Anthropic

---

## Licencia

MIT — libre para uso personal y comercial.
