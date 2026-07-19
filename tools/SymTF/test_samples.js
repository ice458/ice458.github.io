// Every sample must extract to the netlist it is supposed to be. The
// coordinates are hand-laid, and a lead one grid step off produces a circuit
// that still looks right on screen but analyses as something else -- so the
// check is the extracted netlist, never the picture.
//
// Run with: deno run --allow-read test_samples.js

const read = (f) => Deno.readTextFileSync(new URL(f, import.meta.url));

globalThis.window = globalThis;
globalThis.document = {
  addEventListener() {}, dispatchEvent() {},
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null
};
globalThis.Konva = new Proxy({}, {
  get: () => class {
    constructor(cfg = {}) { this._attrs = { ...cfg }; }
    setAttr(k, v) { this._attrs[k] = v; }
    getAttr(k) { return this._attrs[k]; }
    fill() {} stroke() {} add() {}
  }
});

(0, eval)(read("./schematic.js") + `
globalThis.absPins = absPins;
globalThis.isStrictlyInside = isStrictlyInside;
// Headless layers/stage so setModel's render path runs.
{
  const L = () => ({ destroyChildren() {}, add() {}, batchDraw() {}, getIntersection: () => null });
  gridLayer = L(); wireLayer = L(); compLayer = L(); junctionLayer = L(); overlayLayer = L();
  stage = { container: () => ({ style: {} }) };
}
`);
(0, eval)(read("./netlist.js"));
(0, eval)(read("./samples.js"));

// What the browser does with a sample: setModel normalizes the wires (merging,
// cutting shorts through bodies) before anything is extracted. Testing the raw
// authored model let a sample ship whose leads the normalizer then removed --
// it extracted fine here and arrived broken in the browser.
function loadAsBrowserWould(model) {
  window.Schematic.setModel(JSON.parse(JSON.stringify(model)), { undoable: false });
  return window.Schematic.getModel();
}

let failures = 0;
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) { console.log(`FAIL ${name}\n  got      ${a}\n  expected ${b}`); failures++; }
  else console.log(`ok   ${name}`);
};

// Each sample: the netlist it must produce, given "in" as the virtual input.
// Node names for unlabelled nets are auto-assigned, so they are matched loosely
// via a placeholder; everything else is exact.
const EXPECTED = {
  rc_lpf: ["C1 out 0 C1", "R1 in out R1", "V_in in 0 V_in"],
  rlc_series: ["C1 out 0 C", "L1 <n> out L", "R1 in <n> R", "V_in in 0 V_in"],
  inverting_amp: ["O1 0 <n> out", "R1 in <n> R1", "R2 <n> out R2", "V_in in 0 V_in"],
  cs_amp: ["G1 out 0 in 0 gm", "RL out 0 RL", "ro out 0 ro", "V_in in 0 V_in"],
  cascode: ["G1 <n> 0 in 0 gm1", "G2 out <n> 0 <n> gm2", "RL out 0 RL",
            "ro1 <n> 0 ro1", "ro2 out <n> ro2", "V_in in 0 V_in"]
};

// The cascade sample has several auto-assigned internal nets, so the single-<n>
// collapse used for the small samples does not apply. It gets a structural
// check instead (below): it exists to prove the circuit analyses to the right
// shape, not to pin an exact node numbering.
const STRUCTURAL = {
  active_lpf_x3: { elements: 15, opamps: 3, stages: 3 },
  active_lpf_fb3: { elements: 16, opamps: 3, stages: 3, feedback: true },
};

for (const [key, sample] of Object.entries(window.Samples)) {
  const res = Netlist.extract(loadAsBrowserWould(sample.model), { virtualInput: "in" });

  eq(`${key}: extracts cleanly`, { ok: res.ok, errors: res.errors.map(e => e.msg) },
     { ok: true, errors: [] });
  if (!res.ok) continue;

  if (STRUCTURAL[key]) {
    const spec = STRUCTURAL[key];
    const lines = res.text.split("\n").filter(Boolean);
    const count = (re) => lines.filter(l => re.test(l)).length;
    const rco = count(/^[RCO]/);      // Ra*/Rb*/Ca*/Cb*/O* element lines
    const opamps = count(/^O\d/);
    // Chain check: stage k's op-amp output node feeds stage k+1's Ra input.
    const raIns = lines.filter(l => /^Ra\d/.test(l)).map(l => l.split(" ")[1]);
    const opOuts = lines.filter(l => /^O\d/.test(l)).map(l => l.split(" ")[3]);
    const chained = raIns.filter(n => opOuts.includes(n)).length; // internal links
    eq(`${key}: element count`, rco, spec.elements);
    eq(`${key}: op-amp count`, opamps, spec.opamps);
    eq(`${key}: stages chain (internal links)`, chained, spec.stages - 1);
    eq(`${key}: labels offered as ports`, res.labels.sort(), ["in", "out"]);
    if (spec.feedback) {
      // The overall feedback: an Rfb resistor with 'out' as one terminal and an
      // internal (auto) node as the other. It is what makes the whole thing one
      // strongly-connected block rather than a factorable chain.
      const rfb = lines.find(l => /^Rfb\b/.test(l));
      const terms = rfb ? rfb.split(" ").slice(1, 3) : [];
      eq(`${key}: feedback resistor onto output`,
         { hasRfb: !!rfb, touchesOut: terms.includes("out") },
         { hasRfb: true, touchesOut: true });
    }
    continue;
  }

  // Collapse auto node names (N001...) to <n> so the test pins the topology
  // rather than the numbering, which is an implementation detail.
  const autos = new Set(res.nodes.names.filter(n => /^N\d{3}$/.test(n)));
  const lines = res.text.split("\n").map(l =>
    l.split(" ").map(tok => (autos.has(tok) ? "<n>" : tok)).join(" "));
  eq(`${key}: netlist`, lines, EXPECTED[key]);

  // Every auto node must be a single net: if a lead is misrouted, a net that
  // should be one splits in two and the count goes up.
  eq(`${key}: no stray nets`, autos.size, EXPECTED[key].join(" ").includes("<n>") ? 1 : 0);

  eq(`${key}: labels offered as ports`, res.labels.sort(), ["in", "out"]);
}

// The default sample is what a first-time visitor sees; it must exist.
eq("rc_lpf is available as the default sample", typeof window.Samples.rc_lpf?.model, "object");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
if (failures) Deno.exit(1);
