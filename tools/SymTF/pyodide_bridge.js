/**
 * pyodide_bridge.js
 * Handles Pyodide initialization and exposes engine.py JSON APIs to JavaScript.
 */

const Bridge = {
    pyodide: null,
    isReady: false,
    
    // Callbacks for UI updates
    onInitComplete: null,
    onInitFailed: null,
    
    // Expose Python functions
    api: {
        parse_netlist: null,
        solve: null,
        substitute: null,
        approximate: null,
        freq_response: null,
        poles_zeros: null
    },

    async init() {
        try {
            console.log("Loading Pyodide...");
            // loadPyodide is available globally from CDN script
            this.pyodide = await loadPyodide({
                indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.1/full/"
            });
            
            console.log("Loading SymPy package...");
            await this.pyodide.loadPackage("sympy");
            await this.pyodide.loadPackage("numpy");

            console.log("Fetching engine.py...");
            // cache: 'no-cache' forces revalidation. engine.py is fetched (not a
            // <script src>), so it does not get the ?v= bust the tags do, and a
            // stale copy silently runs old analysis code -- e.g. a pi-dropping
            // display-rounding that made the transfer function lose its pi while
            // the coefficient list (plain strings) still showed it.
            const response = await fetch('engine.py', { cache: 'no-cache' });
            if (!response.ok) {
                throw new Error(`Failed to fetch engine.py: ${response.statusText}`);
            }
            const engineCode = await response.text();

            console.log("Mounting engine.py to Pyodide virtual FS...");
            // Write to virtual filesystem so we can import it
            this.pyodide.FS.writeFile('/engine.py', engineCode);

            console.log("Importing engine module...");
            // Import the module and keep a reference
            this.pyodide.runPython(`
import sys
if '/' not in sys.path:
    sys.path.append('/')
sys.setrecursionlimit(3000)
import engine
            `);

            // Map python functions to JS via globals
            this.api.parse_netlist = this.pyodide.runPython("engine.parse_netlist");
            this.api.solve = this.pyodide.runPython("engine.solve");
            this.api.substitute = this.pyodide.runPython("engine.substitute");
            this.api.approximate = this.pyodide.runPython("engine.approximate");
            this.api.freq_response = this.pyodide.runPython("engine.freq_response");
            this.api.poles_zeros = this.pyodide.runPython("engine.poles_zeros");

            this.isReady = true;
            console.log("Pyodide bridge initialized successfully.");
            
            if (this.onInitComplete) {
                this.onInitComplete();
            }
            
        } catch (error) {
            console.error("Pyodide Initialization Error:", error);
            // Report through the UI's own status rather than a modal alert: the
            // editor still works without the engine, so this must not be a wall.
            if (this.onInitFailed) this.onInitFailed(error);
        }
    },

    // Wrapper functions to handle JSON string conversions automatically
    parseNetlist(text) {
        if (!this.isReady) return {ok: false, errors: ["Engine not ready"]};
        try {
            const resultStr = this.api.parse_netlist(text);
            return JSON.parse(resultStr);
        } catch (e) {
            return {ok: false, errors: ["Bridge error: " + e.message]};
        }
    },

    solveCircuit(circuitJsonObj) {
        if (!this.isReady) return {ok: false, errors: ["Engine not ready"]};
        try {
            console.log("Calling engine.solve...");
            const resultStr = this.api.solve(JSON.stringify(circuitJsonObj));
            console.log("engine.solve returned successfully.");
            return JSON.parse(resultStr);
        } catch (e) {
            console.error("Bridge Error in solveCircuit:", e);
            return {ok: false, errors: ["Bridge error: " + e.message]};
        }
    },

    substitute(tfJsonObj, subsMapObj) {
        if (!this.isReady) return {ok: false, errors: ["Engine not ready"]};
        try {
            const resultStr = this.api.substitute(JSON.stringify(tfJsonObj), JSON.stringify(subsMapObj));
            return JSON.parse(resultStr);
        } catch (e) {
            console.error("Bridge Error in substitute:", e);
            return {ok: false, errors: ["Bridge error: " + e.message]};
        }
    },

    freqResponse(tfJsonObj, rangeObj) {
        if (!this.isReady) return {ok: false, errors: ["Engine not ready"]};
        try {
            const resultStr = this.api.freq_response(JSON.stringify(tfJsonObj), JSON.stringify(rangeObj));
            return JSON.parse(resultStr);
        } catch (e) {
            console.error("Bridge Error in freqResponse:", e);
            return {ok: false, errors: ["Bridge error: " + e.message]};
        }
    },

    approximate(tfJsonObj, specObj) {
        if (!this.isReady) return {ok: false, errors: ["Engine not ready"]};
        try {
            const resultStr = this.api.approximate(JSON.stringify(tfJsonObj), JSON.stringify(specObj));
            return JSON.parse(resultStr);
        } catch (e) {
            console.error("Bridge Error in approximate:", e);
            return {ok: false, errors: ["Bridge error: " + e.message]};
        }
    },

    polesZeros(tfJsonObj) {
        if (!this.isReady) return {ok: false, errors: ["Engine not ready"]};
        try {
            const resultStr = this.api.poles_zeros(JSON.stringify(tfJsonObj));
            return JSON.parse(resultStr);
        } catch (e) {
            console.error("Bridge Error in polesZeros:", e);
            return {ok: false, errors: ["Bridge error: " + e.message]};
        }
    }
};

// Initialize immediately on load
document.addEventListener("DOMContentLoaded", () => {
    Bridge.init();
});
