// Unit tests for the model layer of schematic.js -- the geometry and topology
// that M8's netlist extraction will read. Run with:  deno run --allow-read test_schematic.js
//
// schematic.js is a plain browser script, so it is loaded by eval rather than
// import. That is also the point of the model/render split: everything tested
// below runs with no Konva and no DOM.
const src = Deno.readTextFileSync(new URL("./schematic.js", import.meta.url));

// Stubs only for what the file touches at load time.
globalThis.window = globalThis;
globalThis.document = {
  addEventListener() {}, dispatchEvent() {},
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null
};

// Konva nodes only need to absorb what the renderer does to them. Tests that
// call render() care about the model it was built from, not the pixels.
globalThis.Konva = new Proxy({}, {
  get: () => class {
    constructor(cfg = {}) { this._attrs = { ...cfg }; }
    setAttr(k, v) { this._attrs[k] = v; }
    getAttr(k) { return this._attrs[k]; }
    fill(v) { this._attrs.fill = v; }
    stroke(v) { this._attrs.stroke = v; }
    add() {}
  }
});

const hook = `
globalThis.__t = {
  normalizeWires, computeJunctions, absPins, pinAbs, wireSegments, assignName, peekName,
  bodySpans, subtractSpan, valueSymbol, liftAttachedWires, routeRubber,
  textAnchor, autoTextAnchor, symbolBox, textFontSize, textBoxes, hitText, textWidth, contentBounds,
  rectsOverlap, wireRect,
  liftGroupWires, routeGroupRubber,
  beginGroupDrag, updateDrag, endDrag,
  beginMultiMove, commitMultiPlacing, copySelection, transformGhostGroup,
  beginDrag,
  get input() { return input; },
  get clipboard() { return clipboard; },
  get model() { return model; },
  set model(m) { model = m; },
  deleteSelection, commit,
  get selections() { return selections; },
  set selections(v) { selections = v; },
  // NOTE: assign only to variables schematic.js actually declares. This hook is
  // eval'd as a sloppy-mode script, so a typo here does not throw -- it creates
  // an implicit global that masks a ReferenceError in the source under test.
  // A stale assignment to the old singular name hid exactly that bug once.
  reset() {
    model = { components: [], wires: [] };
    counters = {};
    selections = { comps: new Set(), wires: new Set() };
    errorHighlights.clear();
    // Enough of a layer for render() to run headlessly.
    const layer = () => ({ destroyChildren() {}, add() {}, batchDraw() {}, getIntersection: () => null });
    gridLayer = layer(); wireLayer = layer(); compLayer = layer();
    junctionLayer = layer(); overlayLayer = layer();
    // setMode -> updateCursor touches the stage container's style.
    stage = { container: () => ({ style: {} }) };
    input.mode = 'idle';
  },
};
`;
(0, eval)(src + hook);

// The source must not read any global the harness happens to have lying around.
// This is the guard for the failure above: schematic.js referenced an undeclared
// `selection` for six lines and every test still passed.
for (const leaked of ["selection"]) {
  if (leaked in globalThis) {
    console.log(`FAIL harness leaked global '${leaked}' -- it can mask a ReferenceError`);
    Deno.exit(1);
  }
}
const t = globalThis.__t;

let failures = 0;
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) { console.log(`FAIL ${name}\n  got      ${a}\n  expected ${b}`); failures++; }
  else console.log(`ok   ${name}`);
};

// --- pin transform: mirror, then rotate, then translate (Konva's own order) ---
t.reset();
const R = (x, y, rot, mirror) => ({ type: "R", x, y, rot, mirror });
eq("R unrotated pins", t.absPins(R(100, 100, 0, false)), [{ x: 80, y: 100 }, { x: 120, y: 100 }]);
eq("R rotated 90 pins", t.absPins(R(100, 100, 90, false)), [{ x: 100, y: 80 }, { x: 100, y: 120 }]);
eq("R rotated 180 pins", t.absPins(R(100, 100, 180, false)), [{ x: 120, y: 100 }, { x: 80, y: 100 }]);
eq("R mirrored pins", t.absPins(R(100, 100, 0, true)), [{ x: 120, y: 100 }, { x: 80, y: 100 }]);
// OpAmp is asymmetric in y, so it catches a mirror/rotate order mixup.
eq("OpAmp rot90 pins", t.absPins({ type: "O", x: 0, y: 0, rot: 90, mirror: false }),
   [{ x: 10, y: -30 }, { x: -10, y: -30 }, { x: 0, y: 30 }]);

// --- wire routing ---
eq("L-route long axis first", t.wireSegments({ x: 0, y: 0 }, { x: 100, y: 30 }).map(s => [s.x1, s.y1, s.x2, s.y2]),
   [[0, 0, 100, 0], [100, 0, 100, 30]]);
eq("straight route drops empty leg", t.wireSegments({ x: 0, y: 0 }, { x: 100, y: 0 }).map(s => [s.x1, s.y1, s.x2, s.y2]),
   [[0, 0, 100, 0]]);
eq("zero-length route is nothing", t.wireSegments({ x: 0, y: 0 }, { x: 0, y: 0 }), []);

// --- wire normalization ---
t.reset();
t.model.wires = [
  { id: 1, x1: 0, y1: 0, x2: 50, y2: 0 },
  { id: 2, x1: 50, y1: 0, x2: 100, y2: 0 },   // touches #1 -> merge
  { id: 3, x1: 30, y1: 0, x2: 60, y2: 0 },    // overlaps -> merge
  { id: 4, x1: 200, y1: 0, x2: 250, y2: 0 },  // disjoint, same row -> stays separate
  { id: 5, x1: 0, y1: 40, x2: 0, y2: 90 },
];
t.normalizeWires();
eq("merge collinear runs",
   t.model.wires.map(w => [w.x1, w.y1, w.x2, w.y2]).sort(),
   [[0, 0, 100, 0], [0, 40, 0, 90], [200, 0, 250, 0]].sort());

// --- junctions ---
// T-junction: a wire ending on the middle of another (1 + 2 = 3).
t.reset();
t.model.wires = [
  { id: 1, x1: 0, y1: 0, x2: 100, y2: 0 },
  { id: 2, x1: 50, y1: 0, x2: 50, y2: 50 },
];
eq("T-junction gets a dot", t.computeJunctions(), [{ x: 50, y: 0 }]);

// L-corner: two wire ends meeting (1 + 1 = 2). No dot.
t.reset();
t.model.wires = [
  { id: 1, x1: 0, y1: 0, x2: 50, y2: 0 },
  { id: 2, x1: 50, y1: 0, x2: 50, y2: 50 },
];
eq("L-corner gets no dot", t.computeJunctions(), []);

// Crossing wires that merely overlap are NOT connected (2 + 2 = 4 would be
// wrong) -- a real crossing has no shared endpoint, so no candidate point.
t.reset();
t.model.wires = [
  { id: 1, x1: 0, y1: 0, x2: 100, y2: 0 },
  { id: 2, x1: 50, y1: -50, x2: 50, y2: 50 },
];
eq("crossing wires get no dot", t.computeJunctions(), []);

// Pin at a wire end (1 + 1 = 2): no dot.
t.reset();
t.model.components = [{ id: 1, type: "R", x: 100, y: 0, rot: 0, mirror: false }];
t.model.wires = [{ id: 2, x1: 120, y1: 0, x2: 200, y2: 0 }];
eq("pin at wire end gets no dot", t.computeJunctions(), []);

// Pin landing mid-wire (1 + 2 = 3): dot.
t.reset();
t.model.components = [{ id: 1, type: "R", x: 100, y: 0, rot: 0, mirror: false }];
t.model.wires = [{ id: 2, x1: 0, y1: 0, x2: 200, y2: 0 }];
eq("pin mid-wire gets a dot", t.computeJunctions().sort((a, b) => a.x - b.x), [{ x: 80, y: 0 }, { x: 120, y: 0 }]);

// A rotated component's pins must still be found -- this is the case the old
// code got wrong (candidates ignored rotation, degrees did not).
t.reset();
t.model.components = [{ id: 1, type: "R", x: 50, y: 50, rot: 90, mirror: false }];
t.model.wires = [
  { id: 2, x1: 50, y1: 30, x2: 50, y2: 0 },   // ends on the rotated top pin
  { id: 3, x1: 0, y1: 30, x2: 50, y2: 30 },   // also ends there -> 1 + 1 + 1 = 3
];
eq("rotated pin still forms a junction", t.computeJunctions(), [{ x: 50, y: 30 }]);

// --- wires piercing a component body ---
const wireList = () => t.model.wires.map(w => [w.x1, w.y1, w.x2, w.y2]).sort();
const withR = (rot) => { t.reset(); t.model.components = [{ id: 1, type: "R", x: 100, y: 100, rot, mirror: false }]; };

// The reported case: a wire crossing both terminals shorts R out.
withR(0);
t.model.wires = [{ id: 2, x1: 0, y1: 100, x2: 200, y2: 100 }];
t.normalizeWires();
eq("wire through both pins is split in two", wireList(), [[0, 100, 80, 100], [120, 100, 200, 100]].sort());

// Same, but assembled from separate segments -- merging must happen first or
// the pierce goes unnoticed.
withR(0);
t.model.wires = [
  { id: 2, x1: 0, y1: 100, x2: 80, y2: 100 },
  { id: 3, x1: 80, y1: 100, x2: 200, y2: 100 },
];
t.normalizeWires();
eq("pierce is found across merged segments", wireList(), [[0, 100, 80, 100], [120, 100, 200, 100]].sort());

// A wire drawn exactly pin-to-pin is nothing but a short.
withR(0);
t.model.wires = [{ id: 2, x1: 80, y1: 100, x2: 120, y2: 100 }];
t.normalizeWires();
eq("pin-to-pin short is removed entirely", wireList(), []);

// Reaching a terminal and stopping is a normal connection.
withR(0);
t.model.wires = [{ id: 2, x1: 0, y1: 100, x2: 80, y2: 100 }];
t.normalizeWires();
eq("wire ending on a pin survives", wireList(), [[0, 100, 80, 100]]);

// Crossing the body without touching both pins connects nothing, so it stays.
withR(0);
t.model.wires = [{ id: 2, x1: 100, y1: 0, x2: 100, y2: 200 }];
t.normalizeWires();
eq("wire merely crossing the symbol survives", wireList(), [[100, 0, 100, 200]]);

withR(90);
t.model.wires = [{ id: 2, x1: 100, y1: 0, x2: 100, y2: 200 }];
t.normalizeWires();
eq("pierce works on a rotated part", wireList(), [[100, 0, 100, 80], [100, 120, 100, 200]].sort());

// Controlled sources: only the out pair and the ctrl pair are shorts. A wire
// joining ctrl- to out- is a source-referenced VCCS (every MOSFET model) and a
// ctrl+ to out+ tie is a diode connection -- both must SURVIVE normalization.
// Cutting them silently disconnected the shipped cascode sample's gates.
{
  // G at (200,280): out+ (220,260) out- (220,300) ctrl+ (180,260) ctrl- (180,300).
  t.reset();
  t.model.components = [{ id: 1, type: "G", name: "G1", value: "", x: 200, y: 280, rot: 0, mirror: false }];
  t.model.wires = [{ id: 2, x1: 180, y1: 300, x2: 220, y2: 300 }];  // ctrl- to out- (source tie)
  t.normalizeWires();
  eq("ctrl- to out- tie survives", wireList(), [[180, 300, 220, 300]]);

  t.reset();
  t.model.components = [{ id: 1, type: "G", name: "G1", value: "", x: 200, y: 280, rot: 0, mirror: false }];
  t.model.wires = [{ id: 2, x1: 180, y1: 260, x2: 220, y2: 260 }];  // ctrl+ to out+ (diode connection)
  t.normalizeWires();
  eq("diode connection survives", wireList(), [[180, 260, 220, 260]]);

  // The genuine shorts are still cut: across the output pair...
  t.reset();
  t.model.components = [{ id: 1, type: "G", name: "G1", value: "", x: 200, y: 280, rot: 0, mirror: false }];
  t.model.wires = [{ id: 2, x1: 220, y1: 260, x2: 220, y2: 300 }];
  t.normalizeWires();
  eq("output-pair short is still cut", wireList(), []);

  // ...and across the control pair.
  t.reset();
  t.model.components = [{ id: 1, type: "G", name: "G1", value: "", x: 200, y: 280, rot: 0, mirror: false }];
  t.model.wires = [{ id: 2, x1: 180, y1: 260, x2: 180, y2: 300 }];
  t.normalizeWires();
  eq("control-pair short is still cut", wireList(), []);
}

// An op-amp's two inputs are a pin pair too.
t.reset();
t.model.components = [{ id: 1, type: "O", x: 0, y: 0, rot: 0, mirror: false }];
t.model.wires = [{ id: 2, x1: -30, y1: -50, x2: -30, y2: 50 }];
t.normalizeWires();
eq("wire shorting op-amp inputs is split", wireList(), [[-30, -50, -30, -10], [-30, 10, -30, 50]].sort());

// --- attached wires re-route instead of going diagonal ---
// Dragging perpendicular to a wire is the case that turns a moved endpoint into
// a diagonal, which normalizeWires would silently drop.
withR(0);
const r0 = t.model.components[0];
t.model.wires = [
  { id: 2, x1: 0, y1: 100, x2: 80, y2: 100 },     // into the left pin
  { id: 3, x1: 300, y1: 100, x2: 500, y2: 100 },  // unrelated, must not move
];
const rubber = t.liftAttachedWires(r0);
eq("only touching wires are lifted", wireList(), [[300, 100, 500, 100]]);
r0.y = 150; // drag straight down
eq("lifted wire re-routes as an L",
   t.routeRubber(r0, rubber).map(w => [w.x1, w.y1, w.x2, w.y2]),
   [[0, 100, 80, 100], [80, 100, 80, 150]]);

// Sliding along the wire's own axis should stay a single straight wire.
withR(0);
const r1 = t.model.components[0];
t.model.wires = [{ id: 2, x1: 0, y1: 100, x2: 80, y2: 100 }];
const rubber1 = t.liftAttachedWires(r1);
r1.x = 140;
eq("sliding along the axis stays straight",
   t.routeRubber(r1, rubber1).map(w => [w.x1, w.y1, w.x2, w.y2]),
   [[0, 100, 120, 100]]);

// A part dragged back onto its wire's own endpoint leaves no zero-length stub.
withR(0);
const r2 = t.model.components[0];
t.model.wires = [{ id: 2, x1: 0, y1: 100, x2: 80, y2: 100 }];
const rubber2 = t.liftAttachedWires(r2);
r2.x = 20; // left pin lands exactly on the wire's fixed end
eq("collapsed rubber wire disappears", t.routeRubber(r2, rubber2), []);

// --- a netname is not a conductor ---
t.reset();
t.model.components = [{ id: 1, type: "LABEL", name: "vout", x: 50, y: 0, rot: 0, mirror: false }];
t.model.wires = [{ id: 2, x1: 0, y1: 0, x2: 100, y2: 0 }];
eq("label mid-wire draws no solder dot", t.computeJunctions(), []);
t.normalizeWires();
eq("label does not pierce the wire it names", wireList(), [[0, 0, 100, 0]]);

// ...but it must not suppress a real one either.
t.reset();
t.model.components = [{ id: 1, type: "LABEL", name: "vout", x: 50, y: 0, rot: 0, mirror: false }];
t.model.wires = [
  { id: 2, x1: 0, y1: 0, x2: 100, y2: 0 },
  { id: 3, x1: 50, y1: 0, x2: 50, y2: 50 },
];
eq("label on a real T keeps the dot", t.computeJunctions(), [{ x: 50, y: 0 }]);

// --- value defaults to the name ---
eq("unset value shows the name", t.valueSymbol({ name: "R1", value: "" }), "R1");
eq("set value wins", t.valueSymbol({ name: "R1", value: "2*R" }), "2*R");

// --- text placement: name and value must not share hit area ---
// A Konva text box starts at its anchor and runs fontSize downward, so the two
// boxes overlap (and a click for one lands on the other) unless they clear each
// other. This is what stopped the value from being editable.
const overlaps = (comp) => {
  const fs = t.textFontSize(comp);
  const name = t.textAnchor(comp, "name");
  const value = t.textAnchor(comp, "value");
  const lo = Math.min(name.y, value.y), hi = Math.max(name.y, value.y);
  return lo + fs > hi;
};
for (const type of ["R", "C", "L", "E", "G"]) {
  for (const rot of [0, 90, 180, 270]) {
    const comp = { type, name: "X1", value: "", x: 0, y: 0, rot, mirror: false };
    eq(`${type} rot${rot}: name/value boxes are disjoint`, overlaps(comp), false);
  }
}

// Texts must also clear the artwork, at any rotation -- name above, value below.
for (const type of ["R", "C", "L", "E", "G"]) {
  for (const rot of [0, 90]) {
    const comp = { type, name: "X1", value: "", x: 0, y: 0, rot, mirror: false };
    const box = t.symbolBox(comp);
    const fs = t.textFontSize(comp);
    eq(`${type} rot${rot}: name sits above the body`,
       t.textAnchor(comp, "name").y + fs <= box.y1, true);
    eq(`${type} rot${rot}: value sits below the body`,
       t.textAnchor(comp, "value").y >= box.y2, true);
  }
}

// The box has to follow the artwork through a rotation, or the text placement
// it drives is meaningless. R's box is [-20,-7,20,7]; rotating 90 swaps axes.
eq("box rotates with the symbol",
   t.symbolBox({ type: "R", x: 0, y: 0, rot: 90, mirror: false }),
   { x1: -7, y1: -20, x2: 7, y2: 20 });

// Redrawing the artwork must not move the pins -- extraction depends on them.
// (The pins are declared separately from draw(), but this pins the contract.)
eq("R pins unchanged after redraw",
   t.absPins({ type: "R", x: 0, y: 0, rot: 0, mirror: false }), [{ x: -20, y: 0 }, { x: 20, y: 0 }]);
eq("L pins unchanged after redraw",
   t.absPins({ type: "L", x: 0, y: 0, rot: 0, mirror: false }), [{ x: -20, y: 0 }, { x: 20, y: 0 }]);
eq("O pins unchanged after redraw",
   t.absPins({ type: "O", x: 0, y: 0, rot: 0, mirror: false }),
   [{ x: -30, y: -10 }, { x: -30, y: 10 }, { x: 30, y: 0 }]);

// --- clicking the texts ---
// Aiming at the middle of each text must reach that text and no other. This is
// the whole path that was broken: Konva's hit region for a Text is the painted
// glyphs, so the gaps between letters missed and the value never opened.
t.reset();
t.model.components = [{ id: 7, type: "R", name: "R1", value: "2*R", x: 100, y: 100, rot: 0, mirror: false }];
const centreOf = (comp, field) => {
  const b = t.textBoxes(comp).find(b => b.field === field);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
};
const r = t.model.components[0];
eq("clicking the name text hits the name", t.hitText(centreOf(r, "name")), { kind: "comp", id: 7, field: "name" });
eq("clicking the value text hits the value", t.hitText(centreOf(r, "value")), { kind: "comp", id: 7, field: "value" });

// A gap between two letters must still hit -- the old glyph-shaped hit region
// is exactly what this replaces.
const nameBox = t.textBoxes(r).find(b => b.field === "name");
eq("a gap between glyphs still hits",
   t.hitText({ x: nameBox.x + nameBox.w - 1, y: nameBox.y + nameBox.h / 2 }),
   { kind: "comp", id: 7, field: "name" });

eq("the body itself is not a text hit", t.hitText({ x: 100, y: 100 }), null);
eq("empty space is not a text hit", t.hitText({ x: 500, y: 500 }), null);

// The value box has to track the value's own length, not the name's.
const long = { id: 8, type: "R", name: "R1", value: "gm*ro*Rload", x: 0, y: 0, rot: 0, mirror: false };
const shortV = { id: 9, type: "R", name: "R1", value: "", x: 0, y: 0, rot: 0, mirror: false };
eq("value box widens with the value text",
   t.textBoxes(long).find(b => b.field === "value").w >
   t.textBoxes(shortV).find(b => b.field === "value").w, true);

// GND has no text, so a right-click on it must not open an editor.
eq("GND has no text boxes", t.textBoxes({ type: "GND", name: "0", x: 0, y: 0, rot: 0, mirror: false }), []);

// Labels are edited through their single name field.
const lbl = { id: 10, type: "LABEL", name: "vout", value: "", x: 0, y: 0, rot: 0, mirror: false };
eq("label exposes only a name field", t.textBoxes(lbl).map(b => b.field), ["name"]);
eq("clicking a label's text hits it", t.hitText(centreOf(lbl, "name")), null); // not in model yet
t.model.components.push(lbl);
eq("label in the model is hit", t.hitText(centreOf(lbl, "name")), { kind: "comp", id: 10, field: "name" });

// --- selection-dependent paths must not throw ---
// These read module state that the multi-select refactor renamed. Each one is a
// path the browser hits constantly (normalizeWires runs after every wire edit),
// so a ReferenceError here breaks the editor outright rather than degrading it.
const noThrow = (name, fn) => {
  try { fn(); console.log(`ok   ${name}`); }
  catch (e) { console.log(`FAIL ${name}\n  threw ${e.constructor.name}: ${e.message}`); failures++; }
};

t.reset();
t.model.wires = [{ id: 1, x1: 0, y1: 0, x2: 50, y2: 0 }];
noThrow("normalizeWires does not throw", () => t.normalizeWires());
noThrow("deleteSelection on empty selection does not throw", () => t.deleteSelection());

// Deleting must remove every selected item, not just one.
t.reset();
t.model.components = [
  { id: 1, type: "R", name: "R1", value: "", x: 0, y: 0, rot: 0, mirror: false },
  { id: 2, type: "R", name: "R2", value: "", x: 100, y: 0, rot: 0, mirror: false },
  { id: 3, type: "C", name: "C1", value: "", x: 200, y: 0, rot: 0, mirror: false },
];
t.model.wires = [
  { id: 10, x1: 0, y1: 50, x2: 50, y2: 50 },
  { id: 11, x1: 0, y1: 90, x2: 50, y2: 90 },
];
t.selections = { comps: new Set([1, 3]), wires: new Set([10]) };
t.deleteSelection();
eq("delete removes every selected component", t.model.components.map(c => c.name), ["R2"]);
eq("delete removes every selected wire", t.model.wires.map(w => w.id), [11]);
eq("delete clears the selection", [t.selections.comps.size, t.selections.wires.size], [0, 0]);

// Merging replaces wire objects, so wire ids go stale -- but component ids do not.
t.reset();
t.model.components = [{ id: 1, type: "R", name: "R1", value: "", x: 0, y: 200, rot: 0, mirror: false }];
t.model.wires = [{ id: 10, x1: 0, y1: 0, x2: 50, y2: 0 }];
t.selections = { comps: new Set([1]), wires: new Set([10]) };
t.normalizeWires();
eq("normalize drops the stale wire selection", t.selections.wires.size, 0);
eq("normalize keeps the component selection", [...t.selections.comps], [1]);

// --- a netname's text keeps clear of the wires it names ---
// A label is dropped onto a wire by definition, so the default position lands
// the text right on top of it.
{
  const label = { type: "LABEL", name: "vout", value: "", x: 100, y: 100, rot: 0, mirror: false };
  const fs = t.textFontSize(label);
  const w = t.textWidth(label.name, fs);
  const boxOf = (a) => ({ x: a.x, y: a.y, w, h: fs });
  const hits = (wire, a) =>
    Math.min(wire.x1, wire.x2) <= a.x + w && Math.max(wire.x1, wire.x2) >= a.x &&
    Math.min(wire.y1, wire.y2) <= a.y + fs && Math.max(wire.y1, wire.y2) >= a.y;

  // No wires: keep the preferred side (right of the anchor).
  const free = t.autoTextAnchor(label, "name", []);
  eq("label text defaults to the right", free.x > label.x, true);

  // A horizontal wire running through the label covers the right side.
  const horizontal = [{ id: 1, x1: 0, y1: 100, x2: 300, y2: 100 }];
  const dodged = t.autoTextAnchor(label, "name", horizontal);
  eq("label text dodges the wire it names", hits(horizontal[0], dodged), false);

  // Boxed in horizontally and vertically: it must still land somewhere clear.
  const cross = [
    { id: 1, x1: 0, y1: 100, x2: 300, y2: 100 },
    { id: 2, x1: 100, y1: 0, x2: 100, y2: 300 }
  ];
  const a = t.autoTextAnchor(label, "name", cross);
  eq("label text dodges a crossing too", cross.some(wire => hits(wire, a)), false);

  // A hand-placed offset always wins, wires or not.
  const moved = { ...label, textOff: { name: { dx: -40, dy: -30 } } };
  eq("a hand-placed text offset overrides auto placement",
     t.textAnchor(moved, "name", horizontal), { x: 60, y: 70 });
  eq("the offset follows the part", t.textAnchor({ ...moved, x: 200 }, "name", horizontal), { x: 160, y: 70 });

  // A label is attached straight to a pin at least as often as to a wire, so a
  // part is an obstacle too. Dodging only wires put the text on the artwork.
  const r = { id: 9, type: "R", name: "R1", value: "", x: 120, y: 100, rot: 0, mirror: false };
  const onPin = { id: 8, type: "LABEL", name: "vout", value: "", x: 100, y: 100, rot: 0, mirror: false };
  const onPinAnchor = t.autoTextAnchor(onPin, "name", [], [r, onPin]);
  const onPinRect = { x1: onPinAnchor.x, y1: onPinAnchor.y, x2: onPinAnchor.x + w, y2: onPinAnchor.y + fs };
  eq("a pin-attached label's text keeps off the part", t.rectsOverlap(onPinRect, t.symbolBox(r)), false);

  // The label must not dodge its own diamond, or it would never find a side.
  eq("a lone label still takes the preferred side",
     t.autoTextAnchor(onPin, "name", [], [onPin]), free);
}

// The samples ship as the first thing a visitor sees, so their labels must be
// legible -- this exact bug shipped in rc_lpf.
{
  const samplesSrc = Deno.readTextFileSync(new URL("./samples.js", import.meta.url));
  (0, eval)(samplesSrc);
  for (const [key, sample] of Object.entries(globalThis.Samples)) {
    const { components, wires } = sample.model;
    let collisions = 0;
    for (const label of components.filter(c => c.type === "LABEL")) {
      const a = t.autoTextAnchor(label, "name", wires, components);
      const fs2 = t.textFontSize(label);
      const rect = { x1: a.x, y1: a.y, x2: a.x + t.textWidth(label.name, fs2), y2: a.y + fs2 };
      const hitsPart = components.some(c => c !== label && t.rectsOverlap(rect, t.symbolBox(c)));
      const hitsWire = wires.some(wi => t.rectsOverlap(rect, t.wireRect(wi)));
      if (hitsPart || hitsWire) collisions++;
    }
    eq(`sample ${key}: no label text lands on a part or wire`, collisions, 0);
  }
}

// --- part name/value dodge wires and each other ---
{
  const fs = t.textFontSize({ type: "R" });
  const rectAt = (a, text) => ({ x1: a.x, y1: a.y, x2: a.x + t.textWidth(text, fs), y2: a.y + fs });

  // R1 with a wire running right across where its name would sit (above).
  const r = { id: 1, type: "R", name: "R1", value: "1k", x: 100, y: 100, rot: 0, mirror: false };
  const wireAbove = [{ id: 2, x1: 60, y1: 91, x2: 140, y2: 91 }];  // just above the box top (93)
  const comps = [r];

  const nameA = t.autoTextAnchor(r, "name", wireAbove, comps);
  eq("name dodges a wire in its default slot",
     wireAbove.some(w => t.rectsOverlap(rectAt(nameA, "R1"), t.wireRect(w))), false);

  // Name and value must never share the same rectangle.
  const nameB = t.autoTextAnchor(r, "name", [], comps);
  const valB = t.autoTextAnchor(r, "value", [], comps);
  eq("name and value do not overlap",
     t.rectsOverlap(rectAt(nameB, "R1"), rectAt(valB, "1k")), false);

  // The hard case: wires block BOTH above and below, so name and value are each
  // pushed to a side -- they must not land on the same side slot.
  const boxed = [
    { id: 3, x1: 60, y1: 84, x2: 140, y2: 84 },   // across the "above" slot
    { id: 4, x1: 60, y1: 116, x2: 140, y2: 116 },  // across the "below" slot
  ];
  const nameC = t.autoTextAnchor(r, "name", boxed, comps);
  const valC = t.autoTextAnchor(r, "value", boxed, comps);
  eq("name and value never coincide even when boxed in",
     t.rectsOverlap(rectAt(nameC, "R1"), rectAt(valC, "1k")), false);

  // Default (nothing in the way): name above, value below, both centred.
  eq("name sits above the box", nameB.y < 93, true);
  eq("value sits below the box", valB.y > 107, true);
  const cx = 100;   // R box centred on origin -> centre at comp.x
  eq("name is centred", Math.abs((nameB.x + t.textWidth("R1", fs) / 2) - cx) < 0.01, true);
}

// --- moving a whole selection ---
{
  // R1 --w20-- R2, plus an unselected lead into R1 from the left.
  t.reset();
  t.model.components = [
    { id: 1, type: "R", name: "R1", value: "", x: 100, y: 100, rot: 0, mirror: false },
    { id: 2, type: "R", name: "R2", value: "", x: 180, y: 100, rot: 0, mirror: false },
  ];
  t.model.wires = [
    { id: 20, x1: 120, y1: 100, x2: 160, y2: 100 },  // between the two parts
    { id: 21, x1: 0, y1: 100, x2: 80, y2: 100 },     // outside lead into R1
  ];
  // Both parts and the wire between them are selected.
  const rubber = t.liftGroupWires(t.model.components, new Set([20]));
  eq("selected wires are not lifted", t.model.wires.map(w => w.id), [20]);

  // Move both parts down by 50; the lifted outside lead must re-route to follow.
  t.model.components.forEach(c => { c.y += 50; });
  const routed = t.routeGroupRubber(rubber);
  eq("the outside lead follows the moved part",
     routed.map(w => [w.x1, w.y1, w.x2, w.y2]),
     [[0, 100, 80, 100], [80, 100, 80, 150]]);
}

{
  // A wire between two moving parts, left unselected: both of its ends move, so
  // it must not be pinned to where either part used to be.
  t.reset();
  t.model.components = [
    { id: 1, type: "R", name: "R1", value: "", x: 100, y: 100, rot: 0, mirror: false },
    { id: 2, type: "R", name: "R2", value: "", x: 180, y: 100, rot: 0, mirror: false },
  ];
  t.model.wires = [{ id: 20, x1: 120, y1: 100, x2: 160, y2: 100 }];
  const rubber = t.liftGroupWires(t.model.components, new Set());
  eq("the interior wire is lifted", t.model.wires.length, 0);

  t.model.components.forEach(c => { c.x += 40; c.y += 50; });
  eq("an interior wire moves with both its parts",
     t.routeGroupRubber(rubber).map(w => [w.x1, w.y1, w.x2, w.y2]),
     [[160, 150, 200, 150]]);
}

// --- naming ---
t.reset();
eq("peek does not consume the counter", [t.peekName("R"), t.peekName("R")], ["R1", "R1"]);
eq("assign consumes it", [t.assignName("R"), t.assignName("R"), t.peekName("R")], ["R1", "R2", "R3"]);
eq("GND is always node 0", [t.assignName("GND"), t.assignName("GND")], ["0", "0"]);

// --- group drag moves the whole selection together ---
// The reported bug ("can't move several parts at once") was really that the
// parts could not be grabbed in their gaps; the move logic itself must move
// every selected part and carry a selected wire rigidly along.
{
  t.reset();
  t.model.components = [
    { id: 1, type: "R", name: "R1", value: "", x: 100, y: 100, rot: 0, mirror: false },
    { id: 2, type: "R", name: "R2", value: "", x: 200, y: 100, rot: 0, mirror: false },
  ];
  t.model.wires = [{ id: 10, x1: 100, y1: 60, x2: 200, y2: 60 }];  // selected, rides along
  t.selections = { comps: new Set([1, 2]), wires: new Set([10]) };

  t.beginGroupDrag({ x: 100, y: 100 });     // grab near R1
  t.updateDrag({ x: 130, y: 150 });         // move +30,+50 (snaps to grid)
  t.endDrag();

  eq("both parts moved by the same delta",
     t.model.components.map(c => [c.x, c.y]), [[130, 150], [230, 150]]);
  const w = t.model.wires.find(x => x.id === 10) || t.model.wires[0];
  eq("the selected wire moved with them", [w.x1, w.y1, w.x2, w.y2], [130, 110, 230, 110]);
}

// --- a lone wire can be dragged (it just slides) ---
{
  t.reset();
  t.model.wires = [{ id: 10, x1: 100, y1: 100, x2: 160, y2: 100 }];
  t.selections = { comps: new Set(), wires: new Set([10]) };

  t.beginDrag({ kind: "wire", id: 10 }, { x: 100, y: 100 });
  eq("a wire drag actually starts", t.input.drag != null && !!t.input.drag.wireMove, true);
  t.updateDrag({ x: 100, y: 150 });   // +0,+50
  t.endDrag();
  eq("the wire slid by the delta", t.model.wires.map(w => [w.x1, w.y1, w.x2, w.y2]), [[100, 150, 160, 150]]);
}

// --- M on a multi-selection lifts and re-places, keeping ids and names ---
{
  t.reset();
  t.model.components = [
    { id: 1, type: "R", name: "R1", value: "1k", x: 100, y: 100, rot: 0, mirror: false },
    { id: 2, type: "C", name: "C1", value: "", x: 200, y: 100, rot: 0, mirror: false },
  ];
  t.model.wires = [{ id: 10, x1: 100, y1: 60, x2: 200, y2: 60 }];
  t.selections = { comps: new Set([1, 2]), wires: new Set([10]) };

  t.beginMultiMove();
  eq("originals are lifted off the canvas", [t.model.components.length, t.model.wires.length], [0, 0]);
  eq("the group is now a move ghost", t.input.ghostMulti.isMove, true);

  // Drop it +60,+40 from where it was (min corner was 100,60).
  t.input.ghostMulti.cursor = { x: 160, y: 100 };
  t.commitMultiPlacing();

  const byName = Object.fromEntries(t.model.components.map(c => [c.name, c]));
  eq("both parts came back with their ids and names",
     [t.model.components.length, "R1" in byName, "C1" in byName], [2, true, true]);
  eq("R1 kept its value and moved by the delta",
     [byName.R1.value, byName.R1.x, byName.R1.y], ["1k", 160, 140]);
  eq("the wire moved with them", t.model.wires.map(w => [w.x1, w.y1, w.x2, w.y2]), [[160, 100, 260, 100]]);
  eq("a move places once, then idles", t.input.ghostMulti, null);
}

// --- copy then paste creates independent copies (new ids/names) ---
{
  t.reset();
  t.model.components = [
    { id: 1, type: "R", name: "R1", value: "1k", x: 100, y: 100, rot: 0, mirror: false },
  ];
  t.model.wires = [{ id: 10, x1: 80, y1: 100, x2: 40, y2: 100 }];
  t.selections = { comps: new Set([1]), wires: new Set([10]) };

  t.copySelection();
  eq("clipboard holds the copied part and wire",
     [t.clipboard.comps.length, t.clipboard.wires.length], [1, 1]);
  // Stored relative to the group's top-left (min x=40, y=100).
  eq("clipboard is relative to its own corner",
     [t.clipboard.comps[0].x, t.clipboard.comps[0].y], [60, 0]);

  // Paste = a non-move ghost committed at a cursor.
  t.input.ghostMulti = JSON.parse(JSON.stringify(t.clipboard));
  t.input.ghostMulti.cursor = { x: 300, y: 300 };
  t.commitMultiPlacing();

  eq("original still there, plus the pasted copy", t.model.components.length, 2);
  const names = t.model.components.map(c => c.name).sort();
  eq("the paste got a fresh name, not a duplicate", names, ["R1", "R2"]);
  const pasted = t.model.components.find(c => c.name === "R2");
  eq("pasted part carries the value and lands at the cursor",
     [pasted.value, pasted.x, pasted.y], ["1k", 360, 300]);
  eq("paste stays armed for another stamp", t.input.ghostMulti !== null, true);
}

// Pasting a group that contains a ground into a circuit that already has one
// must NOT hang: every ground is "0", and the name-dedupe loop treated that as
// a never-resolving clash (an infinite loop -> the reported freeze).
{
  t.reset();
  t.model.components = [{ id: 1, type: "GND", name: "0", value: "", x: 0, y: 0, rot: 0, mirror: false }];
  t.input.ghostMulti = {
    isMove: false,
    cursor: { x: 200, y: 200 },
    comps: [{ type: "GND", name: "0", value: "", x: 0, y: 0, rot: 0, mirror: false }],
    wires: [],
  };
  t.commitMultiPlacing();   // would spin forever before the fix
  eq("pasting a ground next to a ground terminates", t.model.components.length, 2);
  eq("both grounds are still node 0", t.model.components.map(c => c.name), ["0", "0"]);
}

// --- rotating a floating group turns parts and their connections together ---
{
  t.reset();
  // Two parts wired pin-to-pin: R1 right pin (120,100) meets R2 left pin
  // (180,100) via a wire. After a group rotate they must still meet.
  t.input.ghostMulti = {
    isMove: false,
    cursor: { x: 0, y: 0 },
    comps: [
      { type: "R", name: "R1", value: "", x: 100, y: 100, rot: 0, mirror: false },
      { type: "R", name: "R2", value: "", x: 160, y: 100, rot: 0, mirror: false },
    ],
    wires: [{ x1: 120, y1: 100, x2: 140, y2: 100 }],
  };

  const pinsBefore = t.input.ghostMulti.comps.map(c => t.absPins(c));
  t.transformGhostGroup("rotate");
  const g = t.input.ghostMulti;

  eq("each part advanced 90 degrees", g.comps.map(c => c.rot), [90, 90]);
  // All coordinates stay on the grid.
  const onGrid = [...g.comps.flatMap(c => [c.x, c.y]),
                  ...g.wires.flatMap(w => [w.x1, w.y1, w.x2, w.y2])].every(v => v % 10 === 0);
  eq("group rotate keeps everything on the grid", onGrid, true);

  // The wire that joined the two pins still lands on both pins after rotation --
  // i.e. the connection (and thus the netlist) survives.
  const pinsAfter = g.comps.map(c => t.absPins(c));
  const wire = g.wires[0];
  const touches = (pt) => (Math.abs(pt.x - wire.x1) < 0.01 && Math.abs(pt.y - wire.y1) < 0.01) ||
                          (Math.abs(pt.x - wire.x2) < 0.01 && Math.abs(pt.y - wire.y2) < 0.01);
  eq("the joining wire still meets a pin of each part",
     [pinsAfter[0].some(touches), pinsAfter[1].some(touches)], [true, true]);
}

// --- content bounds (drives Fit to view) ---
{
  t.reset();
  eq("empty canvas has no bounds", t.contentBounds(), null);

  t.model.components = [{ id: 1, type: "R", name: "R1", value: "", x: 100, y: 100, rot: 0, mirror: false }];
  // Bounds now include the name text, which sits above the box -- so the box
  // ([-20,-7,20,7] -> 80..120, 93..107) grows up to the label and left to its
  // start. This is the point: Fit must not zoom until labels spill off-screen.
  const b = t.contentBounds();
  eq("bounds contain the symbol box", b.x1 <= 80 && b.y1 <= 93 && b.x2 >= 120 && b.y2 >= 107, true);
  eq("bounds grow beyond the box for text", b.y1 < 93 || b.y2 > 107, true);

  // A wire off to the side must extend the box.
  t.model.wires = [{ id: 2, x1: 200, y1: 300, x2: 260, y2: 300 }];
  const b2 = t.contentBounds();
  eq("wires extend the bounds", b2.x2 === 260 && b2.y2 === 300, true);
}

// --- setComponentValue (the Values tab edits fixed values through this) ---
{
  t.reset();
  t.model.components = [
    { id: 7, type: "R", name: "R2", value: "1k", x: 0, y: 0, rot: 0, mirror: false },
  ];
  eq("setComponentValue changes the value", globalThis.Schematic.setComponentValue(7, "2k"), true);
  eq("the model carries the new value", t.model.components[0].value, "2k");
  eq("same value is a no-op", globalThis.Schematic.setComponentValue(7, "2k"), false);
  eq("unknown id is a no-op", globalThis.Schematic.setComponentValue(999, "5k"), false);
  // Clearing returns the part to its symbolic default (value follows name).
  eq("empty value is accepted", globalThis.Schematic.setComponentValue(7, ""), true);
  eq("cleared back to symbolic", t.model.components[0].value, "");
}

// --- change notification reflects the POST-mutation model ---
// The bug: commit() ran before a mutation and dispatched schematicChange there,
// so a listener recomputed against the not-yet-changed model. Deleting a part
// then left the gate stale (Analyze stuck disabled) because nothing re-fired
// with the part actually gone. The notify is now deferred to a microtask.
await (async () => {
  t.reset();
  t.model.components = [
    { id: 1, type: "R", name: "R1", value: "", x: 100, y: 100, rot: 0, mirror: false },
    { id: 2, type: "L", name: "L1", value: "", x: 400, y: 400, rot: 0, mirror: false },
  ];

  let modelAtNotify = null;
  const orig = globalThis.document.dispatchEvent;
  globalThis.document.dispatchEvent = () => { modelAtNotify = globalThis.Schematic.getModel(); };

  t.selections = { comps: new Set([2]), wires: new Set() };
  t.deleteSelection();

  // Before microtasks flush, the deferred notify has not fired yet.
  eq("notify is deferred, not synchronous", modelAtNotify, null);

  await Promise.resolve();  // flush the microtask

  globalThis.document.dispatchEvent = orig;
  eq("notify fired after the delete", modelAtNotify !== null, true);
  eq("listener sees the part already removed",
     modelAtNotify.components.map(c => c.name), ["R1"]);
})();

// Coalescing: a burst of commits in one gesture fires a single notify.
await (async () => {
  t.reset();
  let count = 0;
  const orig = globalThis.document.dispatchEvent;
  globalThis.document.dispatchEvent = () => { count++; };
  t.commit(); t.commit(); t.commit();
  await Promise.resolve();
  globalThis.document.dispatchEvent = orig;
  eq("three commits in a tick coalesce to one notify", count, 1);
})();

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
if (failures) Deno.exit(1);
