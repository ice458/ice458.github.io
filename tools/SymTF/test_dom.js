// Cross-checks the ids the JS reaches for against the ids index.html actually
// has. This is the class of bug that produced a live "getElementById(...) is
// null": a DOM refactor leaves JS grabbing an element that no longer exists,
// and nothing catches it until someone clicks the right thing in a browser.
//
// Run with: deno run --allow-read test_dom.js

const read = (f) => Deno.readTextFileSync(new URL(f, import.meta.url));
const html = read("./index.html");
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

const SOURCES = ["./app.js", "./schematic.js", "./netlist.js", "./samples.js", "./pyodide_bridge.js"];
let failures = 0;
const fail = (msg) => { console.log("FAIL " + msg); failures++; };

for (const f of SOURCES) {
  const src = read(f);
  for (const m of src.matchAll(/getElementById\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    if (!htmlIds.has(m[1])) fail(`${f}: getElementById("${m[1]}") -- no such id in index.html`);
  }
  for (const m of src.matchAll(/querySelector(?:All)?\(\s*['"]#([A-Za-z0-9_-]+)['"]/g)) {
    if (!htmlIds.has(m[1])) fail(`${f}: querySelector("#${m[1]}") -- no such id in index.html`);
  }
}

// Duplicate ids make getElementById silently pick one of them.
const seen = new Set();
for (const m of html.matchAll(/id="([^"]+)"/g)) {
  if (seen.has(m[1])) fail(`index.html: duplicate id "${m[1]}"`);
  seen.add(m[1]);
}

// Every script index.html loads must exist -- a rename that misses the tag
// yields a 404 and a page that half works.
for (const m of html.matchAll(/<script src="([^"]+?)(?:\?[^"]*)?"/g)) {
  const src = m[1];
  // Site-root paths ("/consent.js") resolve against the deployed site, not this
  // folder, so there is nothing here to check them against.
  if (src.startsWith("http") || src.startsWith("/")) continue;
  try { read("./" + src); } catch { fail(`index.html loads "${src}", which does not exist`); }
}

// The right pane's tabs are driven by [data-tab]; each needs its panel.
for (const m of html.matchAll(/data-tab="([^"]+)"/g)) {
  if (!htmlIds.has(`tab-${m[1]}`)) fail(`tab button "${m[1]}" has no #tab-${m[1]} panel`);
}
for (const m of html.matchAll(/data-left-tab="([^"]+)"/g)) {
  if (!htmlIds.has(`left-tab-${m[1]}`)) fail(`left tab "${m[1]}" has no #left-tab-${m[1]} panel`);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
if (failures) Deno.exit(1);
