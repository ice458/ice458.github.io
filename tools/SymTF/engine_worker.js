/**
 * engine_worker.js
 * Runs Pyodide + SymPy in a Web Worker so that long symbolic computations
 * never block the UI thread. The page stays responsive (editing, panning,
 * typing values) while a solve is in flight, and a runaway computation can
 * be abandoned by terminating this worker from the main thread.
 *
 * Protocol (postMessage):
 *   main -> worker : { id, fn, args }   fn = engine function name,
 *                                       args = array of JSON strings
 *   worker -> main : { type:'ready' }                       init done
 *                    { type:'init_error', error }           init failed
 *                    { id, ok:true, result }                result = JSON string
 *                    { id, ok:false, error }                call failed
 */

importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.1/full/pyodide.js");

let api = null;

async function init() {
    const pyodide = await loadPyodide({
        indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.1/full/"
    });

    await pyodide.loadPackage(["sympy", "numpy"]);

    // cache: 'no-cache' forces revalidation. engine.py is fetched (not a
    // <script src>), so it does not get the ?v= bust the tags do, and a
    // stale copy silently runs old analysis code.
    const response = await fetch('engine.py', { cache: 'no-cache' });
    if (!response.ok) {
        throw new Error(`Failed to fetch engine.py: ${response.statusText}`);
    }
    const engineCode = await response.text();

    pyodide.FS.writeFile('/engine.py', engineCode);
    pyodide.runPython(`
import sys
if '/' not in sys.path:
    sys.path.append('/')
sys.setrecursionlimit(3000)
import engine
    `);

    api = {
        parse_netlist: pyodide.runPython("engine.parse_netlist"),
        solve: pyodide.runPython("engine.solve"),
        substitute: pyodide.runPython("engine.substitute"),
        flatten: pyodide.runPython("engine.flatten"),
        approximate: pyodide.runPython("engine.approximate"),
        freq_response: pyodide.runPython("engine.freq_response"),
        poles_zeros: pyodide.runPython("engine.poles_zeros"),
        sensitivity: pyodide.runPython("engine.sensitivity"),
    };
}

const initPromise = init();
initPromise.then(
    () => self.postMessage({ type: 'ready' }),
    (err) => self.postMessage({ type: 'init_error', error: String(err?.message || err) })
);

self.onmessage = async (e) => {
    const { id, fn, args } = e.data;
    try {
        // Calls arriving before init finishes simply queue behind it.
        await initPromise;
        if (!api[fn]) throw new Error(`Unknown engine function '${fn}'`);
        const result = api[fn](...args);
        self.postMessage({ id, ok: true, result });
    } catch (err) {
        self.postMessage({ id, ok: false, error: String(err?.message || err) });
    }
};
