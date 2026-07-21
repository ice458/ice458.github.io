// schematic.js - Schematic Editor (M6 / M7)
//
// Architecture
//   model   : plain JS objects in world coordinates. The single source of truth.
//   render  : model -> Konva. Konva nodes are disposable views and are never read back.
//   input   : one state machine (idle / placing / wiring / dragging / panning).
//
// World coordinates are what the model stores and what the netlist extractor (M8)
// will read. Screen coordinates exist only inside the pointer helpers below.

const GRID_SIZE = 10;

// ---------------------------------------------------------------------------
// Symbol library
// ---------------------------------------------------------------------------
// pins are in the symbol's own local coordinates, before mirror and rotation.

const COLORS = {
    stroke: '#e2e8f0',
    wire: '#94a3b8',
    active: '#38bdf8',
    selected: '#f59e0b',
    error: '#ef4444',
    label: '#fcd34d',
    text: '#94a3b8',
    value: '#64748b',
    junction: '#e2e8f0',
    grid: 'rgba(255, 255, 255, 0.15)',
    ghost: 'rgba(56, 189, 248, 0.6)'
};

const SYMBOLS = {
    R: {
        // New-JIS (IEC) rectangular resistor: a plain box with two leads.
        box: [-20, -7, 20, 7],
        pins: [{ x: -20, y: 0 }, { x: 20, y: 0 }],
        draw: () => [new Konva.Path({
            data: 'M -20 0 L -12 0 M -12 -6 L 12 -6 L 12 6 L -12 6 Z M 12 0 L 20 0',
            strokeWidth: 2, lineJoin: 'round'
        })]
    },
    C: {
        box: [-20, -10, 20, 10],
        pins: [{ x: -20, y: 0 }, { x: 20, y: 0 }],
        draw: () => [new Konva.Path({
            data: 'M -20 0 L -5 0 M -5 -10 L -5 10 M 5 -10 L 5 10 M 5 0 L 20 0',
            strokeWidth: 2
        })]
    },
    L: {
        // Three half-circle humps bulging up. Screen y is down, so sweep-flag 1
        // is the upward arc; radius 4, coil spans x -12..12 with 8px leads.
        box: [-20, -6, 20, 4],
        pins: [{ x: -20, y: 0 }, { x: 20, y: 0 }],
        draw: () => [new Konva.Path({
            data: 'M -20 0 L -12 0 A 4 4 0 0 1 -4 0 A 4 4 0 0 1 4 0 A 4 4 0 0 1 12 0 L 20 0',
            strokeWidth: 2, lineCap: 'round'
        })]
    },
    GND: {
        box: [-10, 0, 10, 18],
        pins: [{ x: 0, y: 0 }],
        draw: () => [new Konva.Path({
            data: 'M 0 0 L 0 10 M -10 10 L 10 10 M -6 14 L 6 14 M -2 18 L 2 18',
            strokeWidth: 2
        })]
    },
    O: {
        box: [-30, -20, 30, 20],
        // pins: in+, in-, out. The + is drawn by the top (in+) pin and the -
        // by the bottom (in-) pin so the input polarity is readable at a glance.
        pins: [{ x: -30, y: -10 }, { x: -30, y: 10 }, { x: 30, y: 0 }],
        draw: () => [
            new Konva.Path({
                data: 'M -20 -20 L -20 20 L 20 0 Z M -30 -10 L -20 -10 M -30 10 L -20 10 M 20 0 L 30 0',
                strokeWidth: 2
            }),
            new Konva.Path({
                // "+" beside in+ ; "-" beside in-
                data: 'M -17 -10 L -11 -10 M -14 -13 L -14 -7 M -17 10 L -11 10',
                strokeWidth: 1.5, lineCap: 'round'
            })
        ]
    },
    E: {
        box: [-20, -20, 30, 20],
        // pins: out+, out-, ctrl+, ctrl-
        pins: [{ x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: -20 }, { x: -20, y: 20 }],
        draw: (comp) => controlledSourceShapes('E', comp && comp.flip)
    },
    G: {
        box: [-20, -20, 30, 20],
        pins: [{ x: 20, y: -20 }, { x: 20, y: 20 }, { x: -20, y: -20 }, { x: -20, y: 20 }],
        draw: (comp) => controlledSourceShapes('G', comp && comp.flip)
    },
    // A netname is not a conductor, so its anchor is deliberately a hollow
    // diamond -- never a solder dot, which means "wires are joined here".
    LABEL: {
        box: [-5, -5, 5, 5],
        pins: [{ x: 0, y: 0 }],
        draw: () => [new Konva.Line({
            points: [0, -5, 5, 0, 0, 5, -5, 0], closed: true, strokeWidth: 1.5
        })]
    }
};

// Which types carry an editable value symbol (R1 -> "Rload", "1k", ...).
const HAS_VALUE = new Set(['R', 'C', 'L', 'E', 'G', 'O']);

// Terminal names, in the same order as each symbol's pins. Only used to say
// which pin an extraction error is about.
const PIN_NAMES = {
    R: ['1', '2'],
    C: ['1', '2'],
    L: ['1', '2'],
    GND: ['gnd'],
    O: ['in+', 'in-', 'out'],
    E: ['out+', 'out-', 'ctrl+', 'ctrl-'],
    G: ['out+', 'out-', 'ctrl+', 'ctrl-'],
    LABEL: ['anchor']
};

function pinName(type, index) {
    return PIN_NAMES[type]?.[index] ?? String(index + 1);
}

// A '+' mark centred at (20, y) and a '-' at (20, -y). `flip` swaps them, which
// is how the output polarity is drawn -- and it matches the netlist, which
// swaps the two output terminals for a flipped source.
function polarityMarks(y) {
    const plusY = y, minusY = -y;
    return `M 17 ${plusY} L 23 ${plusY} M 20 ${plusY - 3} L 20 ${plusY + 3} M 17 ${minusY} L 23 ${minusY}`;
}

function controlledSourceShapes(kind, flip = false) {
    const shapes = [
        new Konva.Path({ data: 'M 20 -10 L 30 0 L 20 10 L 10 0 Z', strokeWidth: 2 }),
        new Konva.Line({ points: [20, -20, 20, -10], strokeWidth: 2 }),
        new Konva.Line({ points: [20, 10, 20, 20], strokeWidth: 2 }),
        new Konva.Line({ points: [-20, -20, -20, -10], strokeWidth: 2 }),
        new Konva.Line({ points: [-20, 10, -20, 20], strokeWidth: 2 }),
        new Konva.Circle({ x: -20, y: -10, radius: 2, strokeWidth: 1 }),
        new Konva.Circle({ x: -20, y: 10, radius: 2, strokeWidth: 1 }),
        new Konva.Line({ points: [-20, -8, -20, 8], strokeWidth: 1, dash: [2, 2] }),
        // Control-input polarity: + by the top control pin, - by the bottom, so
        // which way the sensed voltage points is visible on the input side too.
        new Konva.Path({
            data: 'M -15 -10 L -11 -10 M -13 -12 L -13 -8 M -15 10 L -11 10',
            strokeWidth: 1.5, lineCap: 'round'
        })
    ];
    if (kind === 'E') {
        // Voltage source: + and - stacked inside the diamond. flip puts - on top.
        shapes.push(new Konva.Path({
            data: polarityMarks(flip ? 6 : -5),
            strokeWidth: 1.5, lineCap: 'round'
        }));
    } else {
        // Current source: an arrow through the diamond; flip reverses it.
        const arrow = flip
            ? 'M 20 7 L 20 -5 M 16 0 L 20 -5 L 24 0'
            : 'M 20 -7 L 20 5 M 16 0 L 20 5 L 24 0';
        shapes.push(new Konva.Path({
            data: arrow,
            strokeWidth: 1.5, lineCap: 'round', lineJoin: 'round'
        }));
    }
    return shapes;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------
// components: { id, type, name, value, x, y, rot (0|90|180|270), mirror (bool) }
// wires:      { id, x1, y1, x2, y2 }  -- always a single axis-aligned segment
//
// `value` is the symbol the netlist uses for the part (M8 emits
// "<Name> <Node1> <Node2> <Value>"). It starts equal to the name, which is what
// makes a fresh R1 analyse as the symbol R1.

let model = { components: [], wires: [] };
let counters = {};
let nextId = 1;
let clipboard = null;

function newId() { return nextId++; }

function assignName(type) {
    if (type === 'GND') return '0';
    counters[type] = (counters[type] || 0) + 1;
    return `${type}${counters[type]}`;
}

function snapToGrid(v) {
    return Math.round(v / GRID_SIZE) * GRID_SIZE;
}

// Konva applies translate -> rotate -> scale, so a local point is mirrored
// first, then rotated, then offset. Pin math must use the same order or pins
// drift away from the drawn symbol.
const ROT_COS_SIN = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] };

function pinAbs(comp, p) {
    const [cos, sin] = ROT_COS_SIN[comp.rot] || ROT_COS_SIN[0];
    const lx = comp.mirror ? -p.x : p.x;
    const ly = p.y;
    return {
        x: comp.x + lx * cos - ly * sin,
        y: comp.y + lx * sin + ly * cos
    };
}

function absPins(comp) {
    return (SYMBOLS[comp.type]?.pins || []).map(p => pinAbs(comp, p));
}

function findComponent(id) { return model.components.find(c => c.id === id); }

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------

let undoStack = [];
let redoStack = [];

function snapshot() {
    return JSON.stringify({ model, counters, nextId });
}

function restore(snap) {
    const s = JSON.parse(snap);
    model = s.model;
    counters = s.counters;
    nextId = s.nextId;
    selections = { comps: new Set(), wires: new Set() };
    errorHighlights.clear();
}

// Notifies listeners (preview, autosave, port dropdowns) that the model
// changed. Deferred to a microtask and coalesced, for two reasons:
//   1. commit() runs *before* a mutation (it snapshots the pre-change state for
//      undo), so dispatching there directly would report the OLD model. The
//      microtask runs after the current operation finishes, so listeners see
//      the final state. This is the bug behind "delete the part, but Analyze
//      stays disabled": the gate was recomputed against the not-yet-deleted
//      model, then the actual delete never re-notified.
//   2. Coalescing means a burst of commits in one gesture fires one refresh,
//      and it breaks the setErrorHighlights -> render loop from firing twice.
let notifyScheduled = false;
function notifyChange() {
    if (notifyScheduled) return;
    notifyScheduled = true;
    queueMicrotask(() => {
        notifyScheduled = false;
        document.dispatchEvent(new Event('schematicChange'));
    });
}

// Call *before* mutating the model.
function commit() {
    undoStack.push(snapshot());
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    notifyChange();
}

function undo() {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    restore(undoStack.pop());
    render();
    notifyChange();
}

function redo() {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    restore(redoStack.pop());
    render();
    notifyChange();
}

// ---------------------------------------------------------------------------
// Wire topology
// ---------------------------------------------------------------------------

// Splits every wire into horizontal/vertical buckets and merges collinear runs
// that overlap or touch. Purely a model operation -- nothing is drawn here.
function normalizeWires() {
    const horizontal = [];
    const vertical = [];

    for (const w of model.wires) {
        if (w.x1 === w.x2 && w.y1 === w.y2) continue;
        if (w.y1 === w.y2) {
            horizontal.push({ cross: w.y1, a: Math.min(w.x1, w.x2), b: Math.max(w.x1, w.x2) });
        } else if (w.x1 === w.x2) {
            vertical.push({ cross: w.x1, a: Math.min(w.y1, w.y2), b: Math.max(w.y1, w.y2) });
        }
    }

    const merge = (segs) => {
        const byCross = new Map();
        for (const s of segs) {
            if (!byCross.has(s.cross)) byCross.set(s.cross, []);
            byCross.get(s.cross).push(s);
        }
        const out = [];
        for (const [cross, group] of byCross) {
            group.sort((p, q) => p.a - q.a);
            let cur = null;
            for (const s of group) {
                if (cur && s.a <= cur.b) {
                    cur.b = Math.max(cur.b, s.b);
                } else {
                    if (cur) out.push(cur);
                    cur = { cross, a: s.a, b: s.b };
                }
            }
            if (cur) out.push(cur);
        }
        return out;
    };

    const wires = [];
    for (const s of merge(horizontal)) {
        wires.push({ id: newId(), x1: s.a, y1: s.cross, x2: s.b, y2: s.cross });
    }
    for (const s of merge(vertical)) {
        wires.push({ id: newId(), x1: s.cross, y1: s.a, x2: s.cross, y2: s.b });
    }
    model.wires = wires;
    cutWiresThroughBodies();
    splitWiresAtJunctions();

    // Merging replaces wire objects, so any wire selection no longer refers to
    // anything real. Component selections survive -- their ids are untouched.
    selections.wires.clear();
    errorHighlights.clear();
}

// The axis-aligned spans between pairs of a symbol's own pins. A wire lying
// across such a span runs straight through the body and shorts the part out.
// Which pin PAIRS count as "a wire across these is an accidental short".
// This must not be every same-axis pair: for a controlled source, a wire from
// ctrl- to out- is a source-referenced VCCS (every MOSFET small-signal model),
// and ctrl+ to out+ is a diode connection -- both completely normal circuits.
// Cutting them silently disconnected the shipped cascode sample's gates.
const SHORT_PAIRS = {
    R: [[0, 1]], C: [[0, 1]], L: [[0, 1]],
    O: [[0, 1]],              // shorting the two op-amp inputs
    E: [[0, 1], [2, 3]],      // out+/out- and ctrl+/ctrl- -- never cross pairs
    G: [[0, 1], [2, 3]]
};

function bodySpans(comp) {
    const pairs = SHORT_PAIRS[comp.type];
    if (!pairs) return [];
    const pins = absPins(comp);
    const spans = [];
    for (const [i, j] of pairs) {
        const a = pins[i], b = pins[j];
        if (!a || !b) continue;
        if (a.x === b.x && a.y !== b.y) {
            spans.push({ vertical: true, cross: a.x, a: Math.min(a.y, b.y), b: Math.max(a.y, b.y) });
        } else if (a.y === b.y && a.x !== b.x) {
            spans.push({ vertical: false, cross: a.y, a: Math.min(a.x, b.x), b: Math.max(a.x, b.x) });
        }
    }
    return spans;
}

// Removes the pierced span from a wire, keeping whatever sticks out at each
// end. Only a wire that covers the span *entirely* is pierced: one that merely
// reaches a pin and stops is a normal connection and is left alone.
function subtractSpan(w, span) {
    const vertical = w.x1 === w.x2;
    if (vertical !== span.vertical) return [w];
    if ((vertical ? w.x1 : w.y1) !== span.cross) return [w];

    const wa = vertical ? Math.min(w.y1, w.y2) : Math.min(w.x1, w.x2);
    const wb = vertical ? Math.max(w.y1, w.y2) : Math.max(w.x1, w.x2);
    if (wa > span.a || wb < span.b) return [w];

    const make = (a, b) => (a === b ? null : (vertical
        ? { id: newId(), x1: span.cross, y1: a, x2: span.cross, y2: b }
        : { id: newId(), x1: a, y1: span.cross, x2: b, y2: span.cross }));

    return [make(wa, span.a), make(span.b, wb)].filter(Boolean);
}

// Runs after merging, so a run assembled from several segments is cut as one
// wire. The cut pieces end exactly on the pins, leaving each terminal connected
// while the short between them is gone.
function cutWiresThroughBodies() {
    const spans = model.components.flatMap(bodySpans);
    if (!spans.length) return;

    const out = [];
    for (const w of model.wires) {
        let pieces = [w];
        for (const span of spans) {
            pieces = pieces.flatMap(p => subtractSpan(p, span));
        }
        out.push(...pieces);
    }
    model.wires = out;
}

function isStrictlyInside(px, py, w) {
    if (w.x1 === w.x2 && px === w.x1) {
        return py > Math.min(w.y1, w.y2) && py < Math.max(w.y1, w.y2);
    }
    if (w.y1 === w.y2 && py === w.y1) {
        return px > Math.min(w.x1, w.x2) && px < Math.max(w.x1, w.x2);
    }
    return false;
}

// A point is a junction when three or more conductors meet there. A wire that
// passes straight through a point contributes two (it arrives and it leaves),
// which is why an L-corner (1+1) and a pin at a wire end (1+1) stay dots-free
// while a pin mid-wire (1+2) does not.
function computeJunctions() {
    // A netname only names the net it sits on -- it carries no current, so it
    // must not push a point up to junction degree. Otherwise dropping a label
    // mid-wire would sprout a solder dot that means something quite different.
    const conductors = model.components.filter(c => c.type !== 'LABEL');

    const candidates = new Map();
    const add = (p) => candidates.set(`${p.x},${p.y}`, p);

    for (const c of conductors) absPins(c).forEach(add);
    for (const w of model.wires) {
        add({ x: w.x1, y: w.y1 });
        add({ x: w.x2, y: w.y2 });
    }

    const junctions = [];
    for (const p of candidates.values()) {
        let degree = 0;
        for (const c of conductors) {
            for (const pin of absPins(c)) {
                if (pin.x === p.x && pin.y === p.y) degree++;
            }
        }
        for (const w of model.wires) {
            if ((w.x1 === p.x && w.y1 === p.y) || (w.x2 === p.x && w.y2 === p.y)) degree++;
            else if (isStrictlyInside(p.x, p.y, w)) degree += 2;
        }
        if (degree >= 3) junctions.push(p);
    }
    return junctions;
}

// Cuts every wire at whichever junctions (T or X crossings, or a component
// pin landing mid-span) fall strictly inside it, so each side of the
// crossing becomes its own wire object instead of one run threading through
// it. Without this, a long bus with a tap partway along was a single wire:
// selecting or dragging "just the part past the junction" was impossible,
// since that was the same object as the part before it.
//
// The cut points are exactly where computeJunctions() would draw a solder
// dot, read from the current (still-merged) wires -- splitting a wire into
// two pieces that both end exactly at that point does not change any
// point's degree (an interior pass-through contributes 2; two new endpoints
// meeting there also contribute 2), so this cannot itself create or erase a
// junction and one pass is enough.
function splitWiresAtJunctions() {
    const junctions = computeJunctions();
    if (!junctions.length) return;

    const out = [];
    for (const w of model.wires) {
        const vertical = w.x1 === w.x2;
        const cuts = junctions
            .filter(p => isStrictlyInside(p.x, p.y, w))
            .map(p => vertical ? p.y : p.x)
            .sort((a, b) => a - b);

        if (!cuts.length) { out.push(w); continue; }

        const a = vertical ? Math.min(w.y1, w.y2) : Math.min(w.x1, w.x2);
        const b = vertical ? Math.max(w.y1, w.y2) : Math.max(w.x1, w.x2);
        const bounds = [a, ...cuts, b];
        for (let i = 0; i < bounds.length - 1; i++) {
            const lo = bounds[i], hi = bounds[i + 1];
            if (lo === hi) continue;
            out.push(vertical
                ? { id: newId(), x1: w.x1, y1: lo, x2: w.x1, y2: hi }
                : { id: newId(), x1: lo, y1: w.y1, x2: hi, y2: w.y1 });
        }
    }
    model.wires = out;
}

// ---------------------------------------------------------------------------
// Stage / layers
// ---------------------------------------------------------------------------

let stage, gridLayer, wireLayer, compLayer, junctionLayer, overlayLayer;
let selections = { comps: new Set(), wires: new Set() };
let errorHighlights = new Set(); // component IDs

function pointerWorld() {
    const p = stage.getPointerPosition();
    if (!p) return null;
    return stage.getAbsoluteTransform().copy().invert().point(p);
}

function pointerSnapped() {
    const p = pointerWorld();
    if (!p) return null;
    return { x: snapToGrid(p.x), y: snapToGrid(p.y) };
}

function visibleWorldRect() {
    const s = stage.scaleX();
    return {
        x1: -stage.x() / s,
        y1: -stage.y() / s,
        x2: (-stage.x() + stage.width()) / s,
        y2: (-stage.y() + stage.height()) / s
    };
}

// World-space bounding box of everything drawn: symbol boxes (which already
// account for rotation) plus wire endpoints. null when the canvas is empty.
function contentBounds() {
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const grow = (ax1, ay1, ax2, ay2) => {
        x1 = Math.min(x1, ax1); y1 = Math.min(y1, ay1);
        x2 = Math.max(x2, ax2); y2 = Math.max(y2, ay2);
    };
    for (const c of model.components) {
        const b = symbolBox(c);
        grow(b.x1, b.y1, b.x2, b.y2);
        // Names and values sit outside the symbol box and are part of what the
        // user wants to see -- without them, Fit zooms until the labels spill
        // off the edges.
        for (const t of textBoxes(c)) grow(t.x, t.y, t.x + t.w, t.y + t.h);
    }
    for (const w of model.wires) {
        grow(Math.min(w.x1, w.x2), Math.min(w.y1, w.y2), Math.max(w.x1, w.x2), Math.max(w.y1, w.y2));
    }
    return x1 === Infinity ? null : { x1, y1, x2, y2 };
}

// Zoom and pan so the whole circuit fills the viewport with a margin. Empty
// canvas recenters at 1:1. Bound to the Fit button and the F key.
function fitToView() {
    const b = contentBounds();
    const vw = stage.width(), vh = stage.height();
    if (!b) {
        stage.scale({ x: 1, y: 1 });
        stage.position({ x: vw / 2, y: vh / 2 });
        gridLayer.batchDraw();
        stage.batchDraw();
        return;
    }
    const PAD = 40;
    const bw = Math.max(b.x2 - b.x1, GRID_SIZE);
    const bh = Math.max(b.y2 - b.y1, GRID_SIZE);
    // Clamp to the same range the wheel uses, so Fit never lands somewhere the
    // user cannot then zoom back out of.
    const scale = Math.min(8, Math.max(0.15, Math.min((vw - 2 * PAD) / bw, (vh - 2 * PAD) / bh)));
    stage.scale({ x: scale, y: scale });
    stage.position({
        x: vw / 2 - (b.x1 + b.x2) / 2 * scale,
        y: vh / 2 - (b.y1 + b.y2) / 2 * scale
    });
    gridLayer.batchDraw();
    stage.batchDraw();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function buildGrid() {
    return new Konva.Shape({
        listening: false,
        sceneFunc: (ctx) => {
            const scale = stage.scaleX();
            // Below this the dots merge into noise; drop to a coarser grid.
            let step = GRID_SIZE;
            while (step * scale < 6) step *= 5;
            if (step * scale < 6) return;

            const r = visibleWorldRect();
            const radius = 1 / scale;
            ctx.beginPath();
            const startX = Math.floor(r.x1 / step) * step;
            const startY = Math.floor(r.y1 / step) * step;
            for (let x = startX; x <= r.x2; x += step) {
                for (let y = startY; y <= r.y2; y += step) {
                    ctx.moveTo(x + radius, y);
                    ctx.arc(x, y, radius, 0, Math.PI * 2);
                }
            }
            ctx.fillStyle = COLORS.grid;
            ctx.fill();
        }
    });
}

function componentColor(comp) {
    if (errorHighlights.has(comp.id)) return COLORS.error;
    if (selections.comps.has(comp.id)) return COLORS.selected;
    return comp.type === 'LABEL' ? COLORS.label : COLORS.stroke;
}

function buildComponent(comp, opts = {}) {
    const sym = SYMBOLS[comp.type];
    if (!sym) return null;

    const isError = errorHighlights.has(comp.id) && !opts.ghost;
    const color = isError ? COLORS.error : (opts.ghost ? COLORS.ghost : componentColor(comp));
    const group = new Konva.Group({
        x: comp.x,
        y: comp.y,
        rotation: comp.rot,
        scaleX: comp.mirror ? -1 : 1,
        listening: !opts.ghost,
        opacity: opts.ghost ? 0.7 : 1
    });
    group.setAttr('modelKind', 'comp');
    group.setAttr('modelId', comp.id);

    // A transparent hit area covering the whole symbol box. Without it, Konva's
    // hit graph is only the painted strokes, so parts drawn with sparse or
    // hollow geometry (C, the op-amp triangle, the sources) can only be grabbed
    // by clicking exactly on a line -- and clicking the gap does nothing. That
    // also blocked group drag: pressing an already-selected part in its gap
    // never registered a hit. Drawn nothing (empty sceneFunc); the hitFunc
    // fills the box so the entire footprint is clickable.
    if (!opts.ghost) {
        const [bx1, by1, bx2, by2] = sym.box || [-20, -20, 20, 20];
        const hitArea = new Konva.Shape({
            sceneFunc: () => {},
            hitFunc: (ctx, shape) => {
                ctx.beginPath();
                ctx.rect(bx1, by1, bx2 - bx1, by2 - by1);
                ctx.closePath();
                ctx.fillStrokeShape(shape);
            },
            fill: '#000'
        });
        group.add(hitArea);
    }

    for (const shape of sym.draw(comp)) {
        // Symbol definitions declare geometry only; colour is applied here so
        // selections and ghost states reuse the same drawings.
        if (shape.getAttr('paint') === 'fill') shape.fill(color);
        else shape.stroke(color);
        group.add(shape);
    }
    return group;
}

function textFontSize(comp) {
    return comp.type === 'LABEL' ? 14 : 12;
}

// The symbol's drawn extent in world coordinates, rotation and mirror included.
// pinAbs is the same transform the pins use, so the box tracks the artwork.
function symbolBox(comp) {
    const b = SYMBOLS[comp.type]?.box || [-20, -20, 20, 20];
    const corners = [
        { x: b[0], y: b[1] }, { x: b[2], y: b[1] },
        { x: b[2], y: b[3] }, { x: b[0], y: b[3] }
    ].map(p => pinAbs(comp, p));
    const xs = corners.map(c => c.x);
    const ys = corners.map(c => c.y);
    return {
        x1: Math.min(...xs), y1: Math.min(...ys),
        x2: Math.max(...xs), y2: Math.max(...ys)
    };
}

// The one place that decides where a component's texts sit. Both the renderer
// and the inline editor read it, so the edit box always lands exactly on the
// text it is replacing, at any zoom.
//
// Name above the body, value below it, derived from the box rather than from
// per-type magic numbers: a Konva text box grows downward from y and is fontSize
// tall, so anything less than that between them makes their hit areas overlap
// and a click meant for the value lands on the name.
function rectsOverlap(a, b) {
    return a.x1 <= b.x2 && a.x2 >= b.x1 && a.y1 <= b.y2 && a.y2 >= b.y1;
}

// Wires are axis-aligned, so a wire *is* its own bounding box: exact, not an
// approximation.
function wireRect(w) {
    return {
        x1: Math.min(w.x1, w.x2), y1: Math.min(w.y1, w.y2),
        x2: Math.max(w.x1, w.x2), y2: Math.max(w.y1, w.y2)
    };
}

const TEXT_GAP = 4;

// Where a text sits when the user has not placed it by hand.
//
// A netname is deliberately dropped onto the thing it names -- that is what it
// is for -- so its text lands on top of that thing and both become hard to
// read. Try each side of the anchor and take the first one that is clear.
//
// Both wires and parts count as obstacles: a label is just as often attached
// straight to a pin as to a wire, and dodging only wires puts the text right
// on the part's artwork. Parts themselves do not need any of this -- their
// texts sit off the ends of their own body, away from the pins.
function autoTextAnchor(comp, field, wires = model.wires, comps = model.components) {
    const box = symbolBox(comp);
    const fs = textFontSize(comp);
    const text = field === 'value' ? displayValue(comp) : comp.name;
    const w = textWidth(text, fs);

    // Everything the text should try not to overlap: wires and other symbols.
    // The part's own value text is added below for the name (and vice versa) so
    // the two labels do not stack on the same spot.
    const isSelf = (c) => c === comp || (comp.id != null && c.id === comp.id);
    const obstacles = [
        ...wires.map(wireRect),
        ...comps.filter(c => !isSelf(c)).map(symbolBox)
    ];
    // Keep name and value from colliding. The two share their side candidates
    // (same y on the left/right), so if the name is pushed off "above" and the
    // value off "below" they can both fall to the exact same side slot. Resolve
    // the name first and make the value avoid its ACTUAL rect (not just its
    // default slot); the name in turn is biased away from the value's default.
    if (comp.type !== 'LABEL' && HAS_VALUE.has(comp.type)) {
        if (field === 'value') {
            const na = autoTextAnchor(comp, 'name', wires, comps);
            const nw = textWidth(comp.name, fs);
            obstacles.push({ x1: na.x, y1: na.y, x2: na.x + nw, y2: na.y + fs });
        } else {
            const vw = textWidth(displayValue(comp), fs);
            const vcx = (box.x1 + box.x2) / 2 - vw / 2;
            const vy = box.y2 + TEXT_GAP;
            obstacles.push({ x1: vcx, y1: vy, x2: vcx + vw, y2: vy + fs });
        }
    }

    const centerX = (box.x1 + box.x2) / 2 - w / 2;
    const midY = (box.y1 + box.y2) / 2 - fs / 2;
    const above = box.y1 - TEXT_GAP - fs, below = box.y2 + TEXT_GAP;
    const rightX = box.x2 + TEXT_GAP, leftX = box.x1 - TEXT_GAP - w;

    let candidates;
    if (comp.type === 'LABEL') {
        // A netname is dropped onto the thing it names, so its own anchor is
        // covered; try each side then the quadrants.
        candidates = [
            { x: rightX, y: midY }, { x: leftX, y: midY },
            { x: centerX, y: above }, { x: centerX, y: below },
            { x: rightX, y: above }, { x: rightX, y: below },
            { x: leftX, y: above }, { x: leftX, y: below }
        ];
    } else if (field === 'value') {
        // Value prefers below the body, then the far side, then above.
        candidates = [
            { x: centerX, y: below }, { x: rightX, y: midY },
            { x: leftX, y: midY }, { x: centerX, y: above }
        ];
    } else {
        // Name prefers above the body.
        candidates = [
            { x: centerX, y: above }, { x: rightX, y: midY },
            { x: leftX, y: midY }, { x: centerX, y: below }
        ];
    }

    const clear = candidates.find(c =>
        !obstacles.some(o => rectsOverlap({ x1: c.x, y1: c.y, x2: c.x + w, y2: c.y + fs }, o)));
    return clear || candidates[0];
}

// The one place that decides where a text sits. A manual offset is stored
// against the component's own origin, not against the auto position, so the
// text stays put even if auto placement would have picked another side.
function textAnchor(comp, field, wires = model.wires, comps = model.components) {
    const off = comp.textOff && comp.textOff[field];
    if (off) return { x: comp.x + off.dx, y: comp.y + off.dy };
    return autoTextAnchor(comp, field, wires, comps);
}

// JetBrains Mono advances 600/1000 em per glyph. Because the font is monospaced
// the text's width is known from its length alone, with no canvas to measure
// against -- which is what lets the hit boxes live in the model.
const MONO_ADVANCE = 0.6;
const TEXT_HIT_PAD = 2;

function textWidth(text, fontSize) {
    return Math.max(1, text.length) * fontSize * MONO_ADVANCE;
}

// Hit boxes for a component's texts, in world coordinates.
//
// Konva is deliberately not asked about these. Its hit graph for a Text is the
// painted glyphs themselves (drawHit reuses sceneFunc, so fillText paints the
// hit colour), which means clicks landing in the gaps between letters miss
// entirely. That is what made the value impossible to hit.
function textBoxes(comp) {
    if (comp.type === 'GND') return [];
    const fs = textFontSize(comp);
    const boxes = [];

    const add = (field, text) => {
        const p = textAnchor(comp, field);
        boxes.push({
            field,
            x: p.x - TEXT_HIT_PAD,
            y: p.y - TEXT_HIT_PAD,
            w: textWidth(text, fs) + TEXT_HIT_PAD * 2,
            h: fs + TEXT_HIT_PAD * 2
        });
    };

    add('name', comp.name);
    if (HAS_VALUE.has(comp.type)) add('value', displayValue(comp));
    return boxes;
}

// Later components are drawn on top, so they win the hit.
function hitText(world) {
    for (let i = model.components.length - 1; i >= 0; i--) {
        const comp = model.components[i];
        for (const b of textBoxes(comp)) {
            if (world.x >= b.x && world.x <= b.x + b.w &&
                world.y >= b.y && world.y <= b.y + b.h) {
                return { kind: 'comp', id: comp.id, field: b.field };
            }
        }
    }
    return null;
}

// Texts are drawn outside the component group so that rotating or mirroring a
// part never rotates, mirrors, or flings away its name.
function buildComponentTexts(comp, opts = {}) {
    if (comp.type === 'GND') return [];
    const isError = errorHighlights.has(comp.id) && !opts.ghost;
    const color = isError ? COLORS.error : (opts.ghost ? COLORS.ghost : componentColor(comp));

    const make = (field, text, dim) => {
        const p = textAnchor(comp, field);
        const node = new Konva.Text({
            x: p.x,
            y: p.y,
            text,
            fontSize: textFontSize(comp),
            fontFamily: 'JetBrains Mono',
            fill: dim && !opts.ghost ? COLORS.value : color,
            fontStyle: comp.type === 'LABEL' ? 'bold' : 'normal',
            // hitText handles these; Konva's glyph-shaped hit region does not.
            listening: false,
            opacity: opts.ghost ? 0.7 : 1
        });
        return node;
    };

    const texts = [make('name', comp.name, false)];
    if (HAS_VALUE.has(comp.type)) texts.push(make('value', displayValue(comp), true));
    return texts;
}

// An unset value means "same symbol as the name", which is the default the
// netlist expects -- so it is shown rather than left blank and mysterious.
function valueSymbol(comp) {
    return comp.value || comp.name;
}

// What the value text shows on the canvas. The op-amp is special: it has no
// "same as name" default -- an empty value means an ideal op-amp, and a set
// value is "A0 GBW" for a finite-gain model.
function displayValue(comp) {
    if (comp.type === 'O') return comp.value && comp.value.trim() ? comp.value : 'ideal';
    return valueSymbol(comp);
}

// What the inline editor pre-fills. The op-amp edits its raw value (blank when
// ideal) rather than the "ideal" placeholder.
function editValue(comp) {
    return comp.type === 'O' ? (comp.value || '') : valueSymbol(comp);
}

function buildWire(w) {
    const selected = selections.wires.has(w.id);
    const line = new Konva.Line({
        points: [w.x1, w.y1, w.x2, w.y2],
        stroke: selected ? COLORS.selected : COLORS.wire,
        strokeWidth: 2,
        lineCap: 'round',
        hitStrokeWidth: 10
    });
    line.setAttr('modelKind', 'wire');
    line.setAttr('modelId', w.id);
    return line;
}

function render() {
    wireLayer.destroyChildren();
    compLayer.destroyChildren();
    junctionLayer.destroyChildren();

    for (const w of model.wires) wireLayer.add(buildWire(w));

    for (const c of model.components) {
        const g = buildComponent(c);
        if (g) compLayer.add(g);
        for (const t of buildComponentTexts(c)) compLayer.add(t);
    }

    for (const p of computeJunctions()) {
        junctionLayer.add(new Konva.Circle({
            x: p.x, y: p.y, radius: 4, fill: COLORS.junction, listening: false
        }));
    }

    gridLayer.batchDraw();
    wireLayer.batchDraw();
    compLayer.batchDraw();
    junctionLayer.batchDraw();
}

function renderOverlay() {
    overlayLayer.destroyChildren();

    if (input.mode === 'placingMulti' && input.ghostMulti && input.ghostMulti.cursor) {
        const cx = input.ghostMulti.cursor.x;
        const cy = input.ghostMulti.cursor.y;
        input.ghostMulti.comps.forEach(c => {
            const ghostComp = { ...c, x: c.x + cx, y: c.y + cy };
            const g = buildComponent(ghostComp, { ghost: true });
            if (g) overlayLayer.add(g);
            for (const t of buildComponentTexts(ghostComp, { ghost: true })) overlayLayer.add(t);
        });
        input.ghostMulti.wires.forEach(w => {
            overlayLayer.add(new Konva.Line({
                points: [w.x1 + cx, w.y1 + cy, w.x2 + cx, w.y2 + cy],
                stroke: COLORS.ghost,
                strokeWidth: 2,
                listening: false
            }));
        });
    }

    if (input.mode === 'placing' && input.ghost) {
        const g = buildComponent(input.ghost, { ghost: true });
        if (g) overlayLayer.add(g);
        for (const t of buildComponentTexts(input.ghost, { ghost: true })) overlayLayer.add(t);
    }

    if (input.mode === 'wiring' && input.wireStart && input.wireEnd) {
        const pts = wirePath(input.wireStart, input.wireEnd);
        overlayLayer.add(new Konva.Line({
            points: pts,
            stroke: COLORS.active,
            strokeWidth: 2,
            lineCap: 'round',
            lineJoin: 'round',
            listening: false
        }));
    }

    if (input.mode === 'rubberBanding' && input.rubberStart && input.rubberEnd) {
        const t = stage.getAbsoluteTransform().copy().invert();
        const p1 = t.point(input.rubberStart);
        const p2 = t.point(input.rubberEnd);
        overlayLayer.add(new Konva.Rect({
            x: Math.min(p1.x, p2.x),
            y: Math.min(p1.y, p2.y),
            width: Math.abs(p2.x - p1.x),
            height: Math.abs(p2.y - p1.y),
            fill: 'rgba(56, 189, 248, 0.1)',
            stroke: 'rgba(56, 189, 248, 0.5)',
            strokeWidth: 1 / stage.scaleX(),
            listening: false
        }));
    }

    overlayLayer.batchDraw();
}

// L-shaped orthogonal route: travel along the longer axis first.
function wirePath(from, to) {
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    const corner = dx > dy ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
    return [from.x, from.y, corner.x, corner.y, to.x, to.y];
}

function wireSegments(from, to) {
    const pts = wirePath(from, to);
    const segs = [];
    for (let i = 0; i < pts.length - 2; i += 2) {
        const [x1, y1, x2, y2] = [pts[i], pts[i + 1], pts[i + 2], pts[i + 3]];
        if (x1 === x2 && y1 === y2) continue;
        segs.push({ id: newId(), x1, y1, x2, y2 });
    }
    return segs;
}

// ---------------------------------------------------------------------------
// Input state machine
// ---------------------------------------------------------------------------
//
//   idle     - selecting, hovering, ready to start anything
//   placing  - a ghost part (new, or a part picked up with M) follows the cursor
//   wiring   - drawing a wire; W keeps this mode sticky between wires
//   dragging - a placed part is being dragged by the mouse
//   panning  - middle/right drag
//
// Exactly one mode is active at a time, so no two handlers can fight over the
// same mouse event.

const input = {
    mode: 'idle',
    ghost: null,          // placing: component being positioned
    ghostOrigin: null,
    ghostMulti: null,
    wireStart: null,
    wireEnd: null,
    rubberStart: null,
    rubberEnd: null,
    drag: null,
    pressed: null,        // idle: candidate drag, promoted once the pointer moves
    prevMode: null,       // panning: mode to return to on release
    panMoved: false,      // panning: distinguishes a right-drag from a right-click
    panFrom: null         // panning: where the press landed
};

function setMode(mode) {
    input.mode = mode;
    updateCursor();
    renderOverlay();
}

function updateCursor() {
    const c = stage.container();
    if (input.mode === 'wiring') c.style.cursor = 'crosshair';
    else if (input.mode === 'placing') c.style.cursor = 'none';
    else if (input.mode === 'panning') c.style.cursor = 'grabbing';
    else if (input.mode === 'dragging') c.style.cursor = 'move';
    else c.style.cursor = 'default';

    const wireBtn = document.querySelector('.palette-btn[data-type="WIRE"]');
    if (wireBtn) {
        wireBtn.style.background = input.mode === 'wiring' ? 'rgba(255,255,255,0.2)' : '';
    }
}

function cancelToIdle() {
    // A single part picked up with M, or a whole selection moved with M, is put
    // back where it came from (both pushed an undo entry when lifted).
    if (input.mode === 'placing' && input.ghostOrigin != null) undo();
    if (input.mode === 'placingMulti' && input.ghostMulti?.isMove) undo();

    input.ghost = null;
    input.ghostOrigin = null;
    input.ghostMulti = null;
    input.wireStart = null;
    input.wireEnd = null;
    input.drag = null;
    input.pressed = null;
    setMode('idle');
}

function startPlacing(type, labelText) {
    if (!SYMBOLS[type]) return;
    cancelToIdle();
    const p = pointerSnapped() || centerOfView();
    input.ghost = {
        id: null,
        type,
        name: type === 'LABEL' ? labelText : peekName(type),
        value: '',
        x: p.x, y: p.y,
        rot: 0, mirror: false
    };
    input.ghostOrigin = null;
    setMode('placing');
}

// Placing a controlled source and pressing its key again flips the output
// polarity, rather than restarting the placement -- so E, E, E cycles the sign
// while the part is still on the cursor. Any other part starts fresh.
function placeOrFlip(type) {
    if ((type === 'E' || type === 'G') &&
        input.mode === 'placing' && input.ghost && input.ghost.type === type) {
        input.ghost.flip = !input.ghost.flip;
        renderOverlay();
        return;
    }
    startPlacing(type);
}

// The ghost shows the name the part will get, without consuming the counter --
// cancelling a placement must not burn R3.
function peekName(type) {
    if (type === 'GND') return '0';
    return `${type}${(counters[type] || 0) + 1}`;
}

function centerOfView() {
    const r = visibleWorldRect();
    return { x: snapToGrid((r.x1 + r.x2) / 2), y: snapToGrid((r.y1 + r.y2) / 2) };
}


// Copy the current selection into the clipboard, relative to its own top-left
// corner so a later paste can drop it at the cursor.
function copySelection() {
    const comps = model.components.filter(c => selections.comps.has(c.id));
    const wires = model.wires.filter(w => selections.wires.has(w.id));
    if (!comps.length && !wires.length) return;

    let minX = Infinity, minY = Infinity;
    for (const c of comps) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); }
    for (const w of wires) { minX = Math.min(minX, w.x1, w.x2); minY = Math.min(minY, w.y1, w.y2); }

    clipboard = {
        comps: comps.map(c => ({ ...JSON.parse(JSON.stringify(c)), x: c.x - minX, y: c.y - minY })),
        wires: wires.map(w => ({ x1: w.x1 - minX, y1: w.y1 - minY, x2: w.x2 - minX, y2: w.y2 - minY }))
    };
}

// Start placing a copy of the clipboard as a floating group (not a move -- new
// ids and names on commit). commitMultiPlacing handles the click.
function pasteClipboard() {
    if (!clipboard || (!clipboard.comps.length && !clipboard.wires.length)) return;
    input.ghostMulti = JSON.parse(JSON.stringify(clipboard));
    input.ghostMulti.cursor = pointerSnapped() || centerOfView();
    setMode('placingMulti');
    renderOverlay();
}

// Lift the current selection off the canvas and follow the cursor, LTspice-M.
// The parts keep their ids and names (this is a move, not a copy), which is what
// commitMultiPlacing checks via ghostMulti.isMove. commit() here is the undo
// point; cancelToIdle undoes it if the move is abandoned.
function beginMultiMove() {
    const comps = model.components.filter(c => selections.comps.has(c.id));
    const wires = model.wires.filter(w => selections.wires.has(w.id));
    if (!comps.length && !wires.length) return;

    let minX = Infinity, minY = Infinity;
    for (const c of comps) { minX = Math.min(minX, c.x); minY = Math.min(minY, c.y); }
    for (const w of wires) { minX = Math.min(minX, w.x1, w.x2); minY = Math.min(minY, w.y1, w.y2); }

    commit();
    input.ghostMulti = {
        isMove: true,
        cursor: { x: minX, y: minY },   // starts exactly where the group was
        comps: comps.map(c => ({ ...c, x: c.x - minX, y: c.y - minY,
            _id: c.id, _name: c.name, _value: c.value || '' })),
        wires: wires.map(w => ({ x1: w.x1 - minX, y1: w.y1 - minY,
            x2: w.x2 - minX, y2: w.y2 - minY, _id: w.id }))
    };
    model.components = model.components.filter(c => !selections.comps.has(c.id));
    model.wires = model.wires.filter(w => !selections.wires.has(w.id));
    selections = { comps: new Set(), wires: new Set() };
    errorHighlights.clear();
    setMode('placingMulti');
    render();
    renderOverlay();
}

function commitMultiPlacing() {
    if (!input.ghostMulti || !input.ghostMulti.cursor) return;
    const isMove = input.ghostMulti.isMove;
    commit();

    const cx = input.ghostMulti.cursor.x;
    const cy = input.ghostMulti.cursor.y;

    input.ghostMulti.comps.forEach(c => {
        const placed = { ...c, x: c.x + cx, y: c.y + cy };
        if (isMove) {
            // Restore identity: this part is the same one that was lifted.
            placed.id = c._id;
            placed.name = c._name;
            placed.value = c._value || '';
        } else if (c.type === 'GND') {
            // Every ground is node "0" -- that collision is correct, not a name
            // clash. Skipping this was an infinite loop: assignName('GND')
            // always returns "0", so the de-dupe loop below never terminated
            // when the circuit already had a ground.
            placed.id = newId();
            placed.name = '0';
        } else {
            placed.id = newId();
            if (c.type !== 'LABEL') {
                // Fresh, non-colliding name. assignName advances the counter;
                // the loop skips any name already in the circuit (the counter
                // can lag when parts arrived from a paste or an import).
                let name;
                do { name = assignName(c.type); } while (model.components.some(x => x.name === name));
                placed.name = name;
            }
        }
        delete placed._id; delete placed._name; delete placed._value;
        model.components.push(placed);
    });

    input.ghostMulti.wires.forEach(w => {
        model.wires.push({
            id: isMove && w._id != null ? w._id : newId(),
            x1: w.x1 + cx, y1: w.y1 + cy,
            x2: w.x2 + cx, y2: w.y2 + cy
        });
    });

    normalizeWires();
    render();
    notifyChange();

    if (isMove) {
        // A move places once and is done.
        input.ghostMulti = null;
        setMode('idle');
        return;
    }
    // A paste stays armed so the group can be stamped repeatedly.
    input.ghostMulti = JSON.parse(JSON.stringify(clipboard));
    input.ghostMulti.cursor = { x: cx, y: cy };
    renderOverlay();
}
function commitPlacing() {
    const g = input.ghost;
    if (!g) return;

    if (input.ghostOrigin != null) {
        // Finishing a move. Picking the part up removed it from the model (that
        // is what makes the ghost the only copy on screen), so put it back --
        // same id, new placement. The undo entry was pushed at pick-up time.
        // Spread the ghost rather than listing fields, so anything the part
        // carries (a hand-placed textOff, say) survives the round trip.
        model.components.push({ ...g, id: input.ghostOrigin, value: g.value || '' });
        input.ghost = null;
        input.ghostOrigin = null;
        normalizeWires();
        setMode('idle');
        render();
        return;
    }

    commit();
    const comp = {
        id: newId(),
        type: g.type,
        name: g.type === 'LABEL' ? g.name : assignName(g.type),
        value: '',
        x: g.x, y: g.y, rot: g.rot, mirror: g.mirror
    };
    if (g.flip) comp.flip = true;   // controlled-source output polarity
    model.components.push(comp);
    render();

    // Stay armed so parts can be placed one after another, LTspice-style.
    input.ghost = { ...g, name: g.type === 'LABEL' ? g.name : peekName(g.type) };
    renderOverlay();
}

function startWiring() {
    cancelToIdle();
    setMode('wiring');
}

function commitWire(from, to) {
    const segs = wireSegments(from, to);
    if (!segs.length) return;
    commit();
    model.wires.push(...segs);
    normalizeWires();
    render();
}

function nodeToHit(node) {
    let n = node;
    while (n && n !== stage) {
        const kind = n.getAttr('modelKind');
        if (kind) return { kind, id: n.getAttr('modelId'), field: n.getAttr('modelField') || null };
        n = n.parent;
    }
    return null;
}

// Konva hit-tests layers top-down, so a wire running under a component would be
// permanently unreachable. Asking each layer separately gets both, and repeated
// clicks on the same spot cycle through them. Texts come from the model.
function hitCandidates(screenPos, world) {
    const out = [];

    const text = hitText(world);
    if (text) out.push(text);

    const body = nodeToHit(compLayer.getIntersection(screenPos));
    if (body && !(text && text.id === body.id)) out.push(body);

    const wire = nodeToHit(wireLayer.getIntersection(screenPos));
    if (wire) out.push(wire);
    return out;
}

let clickCycle = null; // { x, y, keys, index }

function pickHit(screenPos, world) {
    const cands = hitCandidates(screenPos, world);
    if (!cands.length) { clickCycle = null; return null; }

    const keys = cands.map(c => `${c.kind}:${c.id}`).join('|');
    const sameSpot = clickCycle
        && clickCycle.keys === keys
        && Math.hypot(screenPos.x - clickCycle.x, screenPos.y - clickCycle.y) <= DRAG_THRESHOLD;

    if (sameSpot) clickCycle.index = (clickCycle.index + 1) % cands.length;
    else clickCycle = { x: screenPos.x, y: screenPos.y, keys, index: 0 };

    return cands[clickCycle.index];
}

// Wires touching a moving part are lifted out of the model and re-routed from
// scratch on every frame. Dragging the endpoint alone would bend the wire into
// a diagonal the moment the part moves off the wire's own axis, and diagonals
// are not representable here -- normalizeWires would drop them on the floor.
//
// Each lifted wire is remembered as its two ends, where an end is either a pin
// index (moves with the part) or a fixed point (stays put).
function liftAttachedWires(comp) {
    const pins = absPins(comp);
    const pinAt = (x, y) => pins.findIndex(p => p.x === x && p.y === y);

    const rubber = [];
    model.wires = model.wires.filter(w => {
        const i1 = pinAt(w.x1, w.y1);
        const i2 = pinAt(w.x2, w.y2);
        if (i1 < 0 && i2 < 0) return true;
        rubber.push({
            a: i1 >= 0 ? { pin: i1 } : { pt: { x: w.x1, y: w.y1 } },
            b: i2 >= 0 ? { pin: i2 } : { pt: { x: w.x2, y: w.y2 } }
        });
        return false;
    });
    return rubber;
}

function routeRubber(comp, rubber) {
    const pins = absPins(comp);
    const resolve = (end) => (end.pin !== undefined ? pins[end.pin] : end.pt);
    return rubber.flatMap(r => wireSegments(resolve(r.a), resolve(r.b)));
}

// Dragging a name or a value moves only that text, never the part. The offset
// is snapped against the component's origin so it stays a whole number of grid
// steps, keeping every stored coordinate on the grid.
function beginTextDrag(comp, field, world) {
    commit();
    const anchor = textAnchor(comp, field);
    input.drag = {
        text: { id: comp.id, field },
        grab: { x: anchor.x - world.x, y: anchor.y - world.y }
    };
    setMode('dragging');
}

// Like liftAttachedWires, but an end may belong to any of several moving parts.
// The single-part version records the far end as a fixed point, which is wrong
// here: a wire strung between two selected parts has *both* ends moving, and
// pinning one of them would leave the wire stretched back to where the part
// used to be.
function liftGroupWires(comps, keepIds) {
    const pinAt = new Map();
    for (const c of comps) {
        absPins(c).forEach((p, i) => pinAt.set(`${p.x},${p.y}`, { comp: c.id, pin: i }));
    }
    const rubber = [];
    model.wires = model.wires.filter(w => {
        if (keepIds.has(w.id)) return true;   // selected: travels rigidly instead
        const a = pinAt.get(`${w.x1},${w.y1}`);
        const b = pinAt.get(`${w.x2},${w.y2}`);
        if (!a && !b) return true;
        rubber.push({
            a: a || { pt: { x: w.x1, y: w.y1 } },
            b: b || { pt: { x: w.x2, y: w.y2 } }
        });
        return false;
    });
    return rubber;
}

function routeGroupRubber(rubber) {
    const resolve = (end) => {
        if (end.pt) return end.pt;
        const comp = findComponent(end.comp);
        return comp ? absPins(comp)[end.pin] : null;
    };
    return rubber.flatMap(r => {
        const a = resolve(r.a), b = resolve(r.b);
        return a && b ? wireSegments(a, b) : [];
    });
}

// Moving a whole selection. Selected wires travel rigidly with it; unselected
// wires that touch a moving part rubber-band, exactly as in a single drag.
function beginGroupDrag(world) {
    commit();
    const comps = model.components.filter(c => selections.comps.has(c.id));
    const wires = model.wires
        .filter(w => selections.wires.has(w.id))
        .map(w => ({ id: w.id, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 }));
    const rubber = liftGroupWires(comps, selections.wires);

    input.drag = {
        group: { comps: comps.map(c => ({ id: c.id, x: c.x, y: c.y })), wires, rubber },
        origin: { x: snapToGrid(world.x), y: snapToGrid(world.y) },
        rest: model.wires
    };
    setMode('dragging');
}

// Dragging a bare wire (or several selected wires) slides it rigidly. The parts
// it used to touch are left where they are -- the wire simply detaches, which is
// the natural meaning of "move this wire".
function beginWireDrag(world) {
    commit();
    input.drag = {
        wireMove: model.wires
            .filter(w => selections.wires.has(w.id))
            .map(w => ({ id: w.id, x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 })),
        origin: { x: snapToGrid(world.x), y: snapToGrid(world.y) }
    };
    setMode('dragging');
}

function beginDrag(hit, world) {
    const comp = findComponent(hit.id);

    if (hit.field && comp) { beginTextDrag(comp, hit.field, world); return; }

    const selected = hit.kind === 'comp' ? selections.comps : selections.wires;
    const total = selections.comps.size + selections.wires.size;
    if (total > 1 && selected.has(hit.id)) { beginGroupDrag(world); return; }

    // A lone wire: findComponent(hit.id) is null, so this must come before the
    // component path or the drag would silently do nothing (the reported bug).
    if (hit.kind === 'wire') { beginWireDrag(world); return; }

    if (!comp) return;
    commit();
    const rubber = liftAttachedWires(comp);
    input.drag = {
        id: comp.id,
        offset: { x: comp.x - snapToGrid(world.x), y: comp.y - snapToGrid(world.y) },
        rubber,
        rest: model.wires
    };
    setMode('dragging');
}

function updateDrag(world) {
    const d = input.drag;

    if (d.wireMove) {
        const dx = snapToGrid(world.x) - d.origin.x;
        const dy = snapToGrid(world.y) - d.origin.y;
        const moved = new Map(d.wireMove.map(w =>
            [w.id, { id: w.id, x1: w.x1 + dx, y1: w.y1 + dy, x2: w.x2 + dx, y2: w.y2 + dy }]));
        model.wires = model.wires.map(w => moved.get(w.id) || w);
        render();
        return;
    }

    if (d.text) {
        const comp = findComponent(d.text.id);
        if (!comp) return;
        comp.textOff = comp.textOff || {};
        comp.textOff[d.text.field] = {
            dx: snapToGrid(world.x + d.grab.x - comp.x),
            dy: snapToGrid(world.y + d.grab.y - comp.y)
        };
        render();
        return;
    }

    if (d.group) {
        const dx = snapToGrid(world.x) - d.origin.x;
        const dy = snapToGrid(world.y) - d.origin.y;

        // Move the parts first: the rubber routing reads their new pins.
        for (const home of d.group.comps) {
            const comp = findComponent(home.id);
            if (!comp) continue;
            comp.x = home.x + dx;
            comp.y = home.y + dy;
        }
        const moved = new Map(d.group.wires.map(w =>
            [w.id, { id: w.id, x1: w.x1 + dx, y1: w.y1 + dy, x2: w.x2 + dx, y2: w.y2 + dy }]));
        model.wires = [...d.rest.map(w => moved.get(w.id) || w), ...routeGroupRubber(d.group.rubber)];
        render();
        return;
    }

    const comp = findComponent(d.id);
    if (!comp) return;
    comp.x = snapToGrid(world.x) + d.offset.x;
    comp.y = snapToGrid(world.y) + d.offset.y;
    model.wires = [...d.rest, ...routeRubber(comp, d.rubber)];
    render();
}

function endDrag() {
    input.drag = null;
    normalizeWires();
    setMode('idle');
    render();
    // beginDrag's commit() fired at the *start*, with the part still at its old
    // spot; the final position (which can change the topology -- a part dragged
    // onto or off a wire) needs its own notify.
    notifyChange();
}

function setSelection(sel, toggle = false) {
    if (!sel) {
        selections = { comps: new Set(), wires: new Set() };
    } else {
        const set = sel.kind === 'comp' ? selections.comps : selections.wires;
        if (toggle) {
            if (set.has(sel.id)) set.delete(sel.id);
            else set.add(sel.id);
        } else {
            selections = { comps: new Set(), wires: new Set() };
            const newSet = sel.kind === 'comp' ? selections.comps : selections.wires;
            newSet.add(sel.id);
        }
    }
    render();
}

function deleteSelection() {
    if (!selections.comps.size && !selections.wires.size) return;
    commit();
    model.components = model.components.filter(c => !selections.comps.has(c.id));
    model.wires = model.wires.filter(w => !selections.wires.has(w.id));
    selections = { comps: new Set(), wires: new Set() };
    errorHighlights.clear();
    render();
}

// Rotating or mirroring re-routes attached wires exactly as a drag does.
function transformSelected(fn) {
    if (selections.comps.size !== 1) return;
    const id = [...selections.comps][0];
    const comp = findComponent(id);
    if (!comp) return;

    commit();
    const rubber = liftAttachedWires(comp);
    fn(comp);
    model.wires.push(...routeRubber(comp, rubber));
    normalizeWires();
    render();
}

function rotate(comp) { comp.rot = (comp.rot + 90) % 360; }
function mirror(comp) { comp.mirror = !comp.mirror; }

// Rotate or mirror the whole floating group (a paste or an M-move) about its
// own centre. The position transform matches pinAbs's rotation exactly -- a
// point (dx,dy) -> (-dy,dx) for +90 -- so each part's body and its pins turn
// the same way. Everything is re-snapped to the grid afterwards.
function transformGhostGroup(kind) {
    const g = input.ghostMulti;
    if (!g) return;

    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    const grow = (ax, ay, bx, by) => {
        x1 = Math.min(x1, ax); y1 = Math.min(y1, ay);
        x2 = Math.max(x2, bx); y2 = Math.max(y2, by);
    };
    g.comps.forEach(c => { const b = symbolBox(c); grow(b.x1, b.y1, b.x2, b.y2); });
    g.wires.forEach(w => grow(Math.min(w.x1, w.x2), Math.min(w.y1, w.y2),
        Math.max(w.x1, w.x2), Math.max(w.y1, w.y2)));
    if (x1 === Infinity) return;

    const cx = snapToGrid((x1 + x2) / 2), cy = snapToGrid((y1 + y2) / 2);
    const tf = kind === 'rotate'
        ? (dx, dy) => ({ x: -dy, y: dx })
        : (dx, dy) => ({ x: -dx, y: dy });
    const map = (x, y) => {
        const p = tf(x - cx, y - cy);
        return { x: snapToGrid(cx + p.x), y: snapToGrid(cy + p.y) };
    };

    g.comps.forEach(c => {
        const p = map(c.x, c.y);
        c.x = p.x; c.y = p.y;
        if (kind === 'rotate') c.rot = ((c.rot || 0) + 90) % 360;
        else c.mirror = !c.mirror;
    });
    g.wires.forEach(w => {
        const a = map(w.x1, w.y1), b = map(w.x2, w.y2);
        w.x1 = a.x; w.y1 = a.y; w.x2 = b.x; w.y2 = b.y;
    });
    renderOverlay();
}

// ---------------------------------------------------------------------------
// Inline text editing
// ---------------------------------------------------------------------------

// An <input> floated over the canvas at the text's own position, rather than a
// modal: editing R1 should feel like typing on the schematic.
function beginEdit(comp, field) {
    const container = stage.container();
    container.querySelector('.schematic-inline-edit')?.remove();

    const screen = stage.getAbsoluteTransform().point(textAnchor(comp, field));
    const el = document.createElement('input');
    el.className = 'schematic-inline-edit';
    el.value = field === 'value' ? editValue(comp) : comp.name;
    el.spellcheck = false;
    el.style.left = `${screen.x}px`;
    el.style.top = `${screen.y}px`;
    el.style.fontSize = `${textFontSize(comp) * stage.scaleX()}px`;
    container.appendChild(el);
    el.focus();
    el.select();

    let closed = false;
    const finish = (save) => {
        if (closed) return;
        closed = true;
        const text = el.value.trim();
        el.remove();
        // A name can never be emptied, but a value can -- clearing an op-amp's
        // value returns it to ideal.
        if (save && (text || field === 'value')) applyEdit(comp.id, field, text);
    };

    // The global shortcut handler already ignores INPUT, but stopping here also
    // keeps Escape from cancelling the editor *and* the current mode at once.
    el.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
    });
    el.addEventListener('blur', () => finish(true));
}

// A small properties popover for the op-amp. The finite-gain model needs two
// values (A0 and GBW), and a checkbox states plainly what is being turned on --
// far clearer than expecting the user to find and type into a tiny "ideal" text.
// Unchecked writes an empty value (ideal); checked writes "A0 GBW", so those
// symbols then appear in the substitution table like any other.
function beginOpampEditor(comp) {
    const container = stage.container();
    container.querySelector('.schematic-opamp-editor')?.remove();
    container.querySelector('.schematic-inline-edit')?.remove();

    const toks = (comp.value || '').trim().split(/\s+/).filter(Boolean);
    const initialNonIdeal = toks.length === 2;

    const screen = stage.getAbsoluteTransform().point({ x: comp.x, y: comp.y });
    const box = document.createElement('div');
    box.className = 'schematic-opamp-editor';
    box.style.left = `${screen.x + 20}px`;
    box.style.top = `${screen.y - 20}px`;
    box.innerHTML = `
        <label class="oae-row"><span>Name</span><input class="oae-name" spellcheck="false" value="${comp.name}"></label>
        <label class="oae-check"><input type="checkbox" class="oae-nonideal"> Non-ideal (finite gain)</label>
        <div class="oae-params">
            <label class="oae-row"><span>A0</span><input class="oae-a0" spellcheck="false"></label>
            <label class="oae-row"><span>GBW</span><input class="oae-gbw" spellcheck="false"><small>Hz</small></label>
        </div>
        <div class="oae-actions"><button class="oae-ok">OK</button></div>
    `;
    container.appendChild(box);

    const nameEl = box.querySelector('.oae-name');
    const checkEl = box.querySelector('.oae-nonideal');
    const a0El = box.querySelector('.oae-a0');
    const gbwEl = box.querySelector('.oae-gbw');
    const paramsEl = box.querySelector('.oae-params');

    checkEl.checked = initialNonIdeal;
    a0El.value = initialNonIdeal ? toks[0] : 'A0';
    gbwEl.value = initialNonIdeal ? toks[1] : 'GBW';
    const syncParams = () => { paramsEl.style.display = checkEl.checked ? '' : 'none'; };
    syncParams();
    checkEl.addEventListener('change', syncParams);

    let closed = false;
    const finish = (save) => {
        if (closed) return;
        closed = true;
        box.remove();
        if (!save) return;
        const name = nameEl.value.trim() || comp.name;
        const value = checkEl.checked
            ? `${(a0El.value.trim() || 'A0')} ${(gbwEl.value.trim() || 'GBW')}`
            : '';
        const target = findComponent(comp.id);
        if (!target) return;
        if (target.name === name && (target.value || '') === value) return;
        commit();
        target.name = name;
        target.value = value;
        render();
    };

    box.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
    });
    // Close when focus leaves the popover entirely.
    box.addEventListener('focusout', () => {
        setTimeout(() => { if (!box.contains(document.activeElement)) finish(true); }, 0);
    });
    box.querySelector('.oae-ok').addEventListener('click', () => finish(true));
    nameEl.focus();
    nameEl.select();
}

function applyEdit(id, field, text) {
    const comp = findComponent(id);
    if (!comp) return;

    if (field === 'name') {
        if (comp.name === text) return;
        commit();
        comp.name = text;
        render();
        return;
    }

    // Value edit.
    let next;
    if (comp.type === 'O') {
        // Blank or the word "ideal" resets to an ideal op-amp; otherwise the
        // raw "A0 GBW" string is stored.
        next = (!text || text.trim().toLowerCase() === 'ideal') ? '' : text.trim();
    } else {
        // '' rather than a copy of the name keeps "value follows name" the
        // default, so renaming R1 to Rload carries the value along.
        next = text === comp.name ? '' : text;
    }
    if ((comp.value || '') === next) return;
    commit();
    comp.value = next;
    render();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

const DRAG_THRESHOLD = 3;    // screen px before a click becomes a drag
const DBL_CLICK_MS = 400;    // matches Konva's own double-click window

let lastClickAt = { t: 0, x: 0, y: 0 };

function takeDoubleClick(screen) {
    const now = Date.now();
    const isDouble = now - lastClickAt.t < DBL_CLICK_MS
        && Math.hypot(screen.x - lastClickAt.x, screen.y - lastClickAt.y) <= DRAG_THRESHOLD;
    // A consumed double-click resets the clock, so a third click starts over
    // rather than reading as another double.
    lastClickAt = isDouble ? { t: 0, x: 0, y: 0 } : { t: now, x: screen.x, y: screen.y };
    return isDouble;
}

// Aimed at a text, that text's field is edited; aimed at the artwork, the name
// is. Returns false when there was nothing editable under the pointer.
function tryBeginEdit(screen, world) {
    const hit = hitText(world) || nodeToHit(compLayer.getIntersection(screen));
    if (!hit || hit.kind !== 'comp') return false;
    const comp = findComponent(hit.id);
    if (!comp || comp.type === 'GND') return false; // ground is always node 0
    // The op-amp has two parameters and an ideal/non-ideal choice, so it gets a
    // proper little form instead of a single text field.
    if (comp.type === 'O') { beginOpampEditor(comp); return true; }
    const field = hit.field === 'value' && HAS_VALUE.has(comp.type) ? 'value' : 'name';
    beginEdit(comp, field);
    return true;
}

function setupPointer() {
    const container = stage.container();
    container.addEventListener('contextmenu', e => e.preventDefault());

    stage.on('mousedown', (e) => {
        const button = e.evt.button;

        // Right-click abandons whatever part or wire is in hand (LTspice's
        // cancel), but only when there is something to abandon. Middle-drag
        // always pans, so the view stays reachable without leaving wire mode.
        if (button === 2 && (input.mode === 'placing' || input.mode === 'wiring')) {
            if (input.mode === 'wiring' && input.wireStart) {
                input.wireStart = null;
                input.wireEnd = null;
                renderOverlay();
            } else {
                cancelToIdle();
            }
            return;
        }
        if (button === 1 || button === 2) {
            // Held as a candidate, exactly like a left press: a right *drag*
            // pans, a right *click* opens the part's properties (LTspice).
            input.prevMode = input.mode;
            input.panMoved = false;
            input.panFrom = { screen: stage.getPointerPosition(), world: pointerWorld() };
            setMode('panning');
            return;
        }
        if (button !== 0) return;

        const world = pointerWorld();
        if (!world) return;

        if (input.mode === 'placingMulti') {
            commitMultiPlacing();
            return;
        }

        if (input.mode === 'placing') {
            commitPlacing();
            return;
        }

        if (input.mode === 'wiring') {
            const p = pointerSnapped();
            if (!input.wireStart) {
                input.wireStart = p;
                input.wireEnd = p;
            } else {
                commitWire(input.wireStart, p);
                // Chain from the end point, so long runs are click-click-click.
                input.wireStart = p;
                input.wireEnd = p;
            }
            renderOverlay();
            return;
        }

        if (input.mode !== 'idle') return;

        const screen = stage.getPointerPosition();

        // Konva's own dblclick compares the shape object from the first click
        // with the one from the second, but selecting re-renders and replaces
        // every node, so those are never the same object and dblclick never
        // fires. Detect it here instead, against the model rather than nodes.
        if (takeDoubleClick(screen) && tryBeginEdit(screen, world)) {
            // Keeps the browser from moving focus off the edit box we just
            // opened, which would blur it shut again immediately.
            e.evt.preventDefault();
            return;
        }

        const hit = pickHit(screen, world);
        if (!hit) {
            if (!e.evt.shiftKey && !e.evt.ctrlKey) {
                setSelection(null);
            }
            input.prevMode = input.mode;
            input.rubberStart = screen;
            input.rubberEnd = screen;
            setMode('rubberBanding');
            return;
        }
        const sel = { kind: hit.kind, id: hit.id };
        const toggling = e.evt.shiftKey || e.evt.ctrlKey;
        const set = hit.kind === 'comp' ? selections.comps : selections.wires;
        const inGroup = set.has(hit.id) && (selections.comps.size + selections.wires.size) > 1;

        // Pressing an item that is already part of a multi-selection must not
        // collapse it -- that would throw the group away just as the user goes
        // to drag it. Defer: a drag moves the group, a click without a drag
        // collapses to this one item (handled on mouseup).
        if (toggling || !inGroup) setSelection(sel, toggling);

        // Held as a candidate: a click selects, a click-and-move drags.
        input.pressed = { hit, origin: screen, world, collapseTo: inGroup && !toggling ? sel : null };
    });

    stage.on('mousemove', (e) => {
        if (input.mode === 'rubberBanding') {
            input.rubberEnd = stage.getPointerPosition();
            renderOverlay();
            return;
        }
        if (input.mode === 'panning') {
            if (e.evt.movementX || e.evt.movementY) input.panMoved = true;
            stage.x(stage.x() + e.evt.movementX);
            stage.y(stage.y() + e.evt.movementY);
            gridLayer.batchDraw();
            return;
        }

        if (input.mode === 'placingMulti' && input.ghostMulti?.cursor) {
            const p = pointerSnapped();
            if (p && (p.x !== input.ghostMulti.cursor.x || p.y !== input.ghostMulti.cursor.y)) {
                input.ghostMulti.cursor = p;
                renderOverlay();
            }
            return;
        }

        if (input.mode === 'placing' && input.ghost) {
            const p = pointerSnapped();
            if (p && (p.x !== input.ghost.x || p.y !== input.ghost.y)) {
                input.ghost.x = p.x;
                input.ghost.y = p.y;
                renderOverlay();
            }
            return;
        }

        if (input.mode === 'wiring' && input.wireStart) {
            const p = pointerSnapped();
            if (p && (p.x !== input.wireEnd.x || p.y !== input.wireEnd.y)) {
                input.wireEnd = p;
                renderOverlay();
            }
            return;
        }

        if (input.mode === 'dragging') {
            const world = pointerWorld();
            if (world) updateDrag(world);
            return;
        }

        if (input.mode === 'idle' && input.pressed) {
            const now = stage.getPointerPosition();
            if (!now) return;
            const dx = now.x - input.pressed.origin.x;
            const dy = now.y - input.pressed.origin.y;
            if (Math.hypot(dx, dy) > DRAG_THRESHOLD) {
                const pressed = input.pressed;
                input.pressed = null;
                beginDrag(pressed.hit, pressed.world);
            }
        }
    });

    // Released anywhere, including outside the canvas. Listening on window is
    // what keeps pan/drag from sticking when the mouse leaves the container.
    window.addEventListener('mouseup', (e) => {
        if (input.mode === 'rubberBanding' && e.button === 0) {
            applyRubberBandSelection(e.shiftKey || e.ctrlKey);
            setMode(input.prevMode || 'idle');
            renderOverlay();
            return;
        }
        if (input.mode === 'panning' && (e.button === 1 || e.button === 2)) {
            const from = input.panFrom;
            setMode(input.prevMode === 'wiring' ? 'wiring' : 'idle');
            // A right-click that never turned into a pan is a properties click.
            if (e.button === 2 && !input.panMoved && from && input.mode === 'idle') {
                tryBeginEdit(from.screen, from.world);
            }
            return;
        }
        if (input.mode === 'dragging' && e.button === 0) {
            endDrag();
            return;
        }
        if (e.button === 0) {
            // Pressed a group member and never dragged: that was a plain click,
            // so collapse the selection to it now.
            if (input.pressed?.collapseTo) setSelection(input.pressed.collapseTo);
            input.pressed = null;
        }
    });

    // Drag-style wiring: press, drag, release far away commits the wire.
    stage.on('mouseup', (e) => {
        if (e.evt.button !== 0) return;
        if (input.mode !== 'wiring' || !input.wireStart) return;
        const p = pointerSnapped();
        if (!p) return;
        if (p.x !== input.wireStart.x || p.y !== input.wireStart.y) {
            commitWire(input.wireStart, p);
            input.wireStart = p;
            input.wireEnd = p;
            renderOverlay();
        }
    });

    stage.on('wheel', (e) => {
        e.evt.preventDefault();
        const scaleBy = 1.1;
        const oldScale = stage.scaleX();
        const pointer = stage.getPointerPosition();
        if (!pointer) return;

        const worldPoint = {
            x: (pointer.x - stage.x()) / oldScale,
            y: (pointer.y - stage.y()) / oldScale
        };
        const newScale = e.evt.deltaY > 0 ? oldScale / scaleBy : oldScale * scaleBy;
        const clamped = Math.min(8, Math.max(0.15, newScale));

        stage.scale({ x: clamped, y: clamped });
        stage.position({
            x: pointer.x - worldPoint.x * clamped,
            y: pointer.y - worldPoint.y * clamped
        });
        gridLayer.batchDraw();
        stage.batchDraw();
    });
}

function promptNetname() {
    const netname = prompt('Enter Netname:');
    if (netname && netname.trim()) startPlacing('LABEL', netname.trim());
}

function setupKeyboard() {
    window.addEventListener('keydown', (e) => {
        const tag = e.target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        // A focused button owns Space/Enter (standard activation); hijacking
        // Space for autoscale there both surprises and breaks the button.
        if (tag === 'BUTTON') return;
        if (!stage) return;

        const key = e.key.toLowerCase();

        if (e.key === 'Escape') { cancelToIdle(); return; }

        if (e.ctrlKey && key === 'z') { e.preventDefault(); undo(); return; }
        if (e.ctrlKey && (key === 'y' || (key === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
        // Copy/paste MUST be handled before the `if (e.ctrlKey) return` below,
        // or the modifier check swallows them (which is exactly why paste never
        // worked and copy only fired on a plain 'c').
        if (e.ctrlKey && key === 'c') { e.preventDefault(); copySelection(); return; }
        if (e.ctrlKey && key === 'v') { e.preventDefault(); pasteClipboard(); return; }

        // Ctrl+R / Ctrl+E act on the ghost while placing, otherwise on the
        // selections -- same keys, whichever part is "in hand".
        if (e.ctrlKey && (key === 'r' || key === 'e')) {
            e.preventDefault();
            if (input.mode === 'placingMulti') {
                transformGhostGroup(key === 'r' ? 'rotate' : 'mirror');
                return;
            }
            if (input.mode === 'placing' && input.ghost) {
                (key === 'r' ? rotate : mirror)(input.ghost);
                renderOverlay();
            } else {
                transformSelected(key === 'r' ? rotate : mirror);
            }
            return;
        }

        if (e.ctrlKey) return;

        if (e.key === ' ') { e.preventDefault(); fitToView(); return; }   // autoscale
        if (key === 'f') { document.dispatchEvent(new Event('toggleSchematicFullscreen')); return; }
        if (key === 'w') { input.mode === 'wiring' ? cancelToIdle() : startWiring(); return; }
        if (key === 'n') { promptNetname(); return; }
        if (key === 'r') { startPlacing('R'); return; }
        if (key === 'e') { placeOrFlip('E'); return; }
        if (key === '0') { startPlacing('GND'); return; }
        if (key === 'c') { startPlacing('C'); return; }
        if (key === 'l') { startPlacing('L'); return; }
        if (key === 'g') { placeOrFlip('G'); return; }

        if (e.key === 'Delete' || e.key === 'Backspace') { deleteSelection(); return; }

        // Pick the selection up and follow the cursor until clicked. A lone part
        // uses the single-ghost path (its name text follows too); any larger
        // selection uses the group path.
        if (key === 'm') {
            const nComp = selections.comps.size, nWire = selections.wires.size;
            if (nComp === 0 && nWire === 0) return;
            if (nComp === 1 && nWire === 0) {
                const comp = findComponent([...selections.comps][0]);
                if (!comp) return;
                commit();
                input.ghost = { ...comp };
                input.ghostOrigin = comp.id;
                model.components = model.components.filter(c => c.id !== comp.id);
                selections = { comps: new Set(), wires: new Set() };
                errorHighlights.clear();
                setMode('placing');
                render();
            } else {
                beginMultiMove();
            }
            return;
        }
    });
}

function setupPalette() {
    document.querySelectorAll('.palette-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const type = btn.dataset.type;
            if (type === 'WIRE') {
                input.mode === 'wiring' ? cancelToIdle() : startWiring();
            } else if (type === 'LABEL') {
                promptNetname();
            } else {
                placeOrFlip(type);   // E/G: clicking again flips output polarity
            }
            // Otherwise the button keeps focus and swallows the next keystroke.
            btn.blur();
        });
    });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

function initSchematic() {
    const container = document.getElementById('schematic-container');
    if (!container) return;

    stage = new Konva.Stage({
        container: 'schematic-container',
        width: container.clientWidth,
        height: container.clientHeight
    });

    gridLayer = new Konva.Layer({ listening: false });
    wireLayer = new Konva.Layer();
    compLayer = new Konva.Layer();
    junctionLayer = new Konva.Layer({ listening: false });
    overlayLayer = new Konva.Layer({ listening: false });

    stage.add(gridLayer, wireLayer, compLayer, junctionLayer, overlayLayer);
    gridLayer.add(buildGrid());

    setupPointer();
    setupKeyboard();
    setupPalette();

    const resize = () => {
        stage.width(container.clientWidth);
        stage.height(container.clientHeight);
        gridLayer.batchDraw();
    };
    window.addEventListener('resize', resize);
    // The editor lives in a tab, so it can be laid out at zero width on load.
    if (window.ResizeObserver) new ResizeObserver(resize).observe(container);

    render();
}

// Read-only view of the circuit for netlist extraction (M8).
// Replace the whole circuit: a sample, an import, a restored session.
//
// Ids and name counters are rebuilt from the incoming parts, so anything placed
// afterwards gets a fresh id and a fresh name instead of colliding with what was
// just loaded. The wires are normalized on the way in, which also sanitises
// hand-edited or third-party files (merging, cutting shorts through bodies).
function setModel(next, { undoable = true } = {}) {
    if (!next || !Array.isArray(next.components) || !Array.isArray(next.wires)) return false;
    if (undoable) commit();

    model = {
        components: next.components.map(c => ({ ...c })),
        wires: next.wires.map(w => ({ ...w }))
    };

    nextId = 1;
    for (const item of [...model.components, ...model.wires]) {
        if (Number.isInteger(item.id)) nextId = Math.max(nextId, item.id + 1);
    }
    for (const item of [...model.components, ...model.wires]) {
        if (!Number.isInteger(item.id)) item.id = newId();
    }

    counters = {};
    for (const c of model.components) {
        const m = new RegExp(`^${c.type}(\\d+)$`).exec(c.name || '');
        if (m) counters[c.type] = Math.max(counters[c.type] || 0, Number(m[1]));
    }

    selections = { comps: new Set(), wires: new Set() };
    errorHighlights.clear();
    normalizeWires();
    render();
    notifyChange();
    return true;
}

window.Schematic = {
    getModel: () => JSON.parse(JSON.stringify(model)),
    setModel,
    fitToView,
    // Change one part's value from outside the canvas (the Values tab edits
    // schematic-fixed numerics through this). Undoable like any canvas edit;
    // commit() also notifies, so the preview/auto-reanalysis pick it up.
    setComponentValue: (id, value) => {
        const comp = findComponent(id);
        if (!comp || (comp.value || '') === value) return false;
        commit();
        comp.value = value;
        render();
        return true;
    },
    getJunctions: computeJunctions,
    absPins,
    getPins: (type) => SYMBOLS[type]?.pins || [],
    clear: () => { commit(); model = { components: [], wires: [] }; counters = {}; selections = { comps: new Set(), wires: new Set() };
    errorHighlights.clear(); render(); notifyChange(); },
    setErrorHighlights: (errs) => { 
        errorHighlights = new Set(errs.filter(e => e.componentId).map(e => e.componentId)); 
        render(); 
    }
};

document.addEventListener('DOMContentLoaded', () => {
    initSchematic();
});

function applyRubberBandSelection(addOnly) {
    if (!input.rubberStart || !input.rubberEnd) return;
    
    const t = stage.getAbsoluteTransform().copy().invert();
    const p1 = t.point(input.rubberStart);
    const p2 = t.point(input.rubberEnd);
    
    const minX = Math.min(p1.x, p2.x);
    const maxX = Math.max(p1.x, p2.x);
    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);
    
    if (!addOnly) {
        selections = { comps: new Set(), wires: new Set() };
    }
    
    model.components.forEach(c => {
        if (c.x >= minX && c.x <= maxX && c.y >= minY && c.y <= maxY) {
            selections.comps.add(c.id);
        }
    });
    
    model.wires.forEach(w => {
        if (w.x1 >= minX && w.x1 <= maxX && w.x2 >= minX && w.x2 <= maxX &&
            w.y1 >= minY && w.y1 <= maxY && w.y2 >= minY && w.y2 <= maxY) {
            selections.wires.add(w.id);
        }
    });
    
    input.rubberStart = null;
    input.rubberEnd = null;
    render();
}
