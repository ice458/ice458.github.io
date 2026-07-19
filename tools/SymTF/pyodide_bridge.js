/**
 * pyodide_bridge.js
 * RPC front-end for the engine Web Worker (engine_worker.js).
 *
 * Pyodide used to run on the main thread, which froze the whole page for the
 * duration of every solve — seconds to minutes on larger circuits. All engine
 * calls now go through a worker and return Promises; the UI keeps painting,
 * and a runaway computation can be cancelled (worker terminate + respawn).
 *
 * Every method resolves (never rejects) with the engine's parsed JSON, or with
 * {ok:false, errors:[...]} on transport-level failure — so call sites only
 * ever check result.ok.
 */

const Bridge = {
    worker: null,
    isReady: false,

    // Callbacks for UI updates
    onInitComplete: null,   // (isRestart) => void
    onInitFailed: null,     // (error) => void
    onBusyChange: null,     // (busyCount) => void

    _pending: new Map(),    // id -> resolve
    _nextId: 1,
    _isRestart: false,

    init() {
        this._spawn();
    },

    _spawn() {
        this.worker = new Worker('engine_worker.js?v=7');

        this.worker.onmessage = (e) => {
            const msg = e.data;

            if (msg.type === 'ready') {
                this.isReady = true;
                console.log("Engine worker ready.");
                if (this.onInitComplete) this.onInitComplete(this._isRestart);
                return;
            }
            if (msg.type === 'init_error') {
                console.error("Engine worker init error:", msg.error);
                if (this.onInitFailed) this.onInitFailed(new Error(msg.error));
                return;
            }

            const resolve = this._pending.get(msg.id);
            if (!resolve) return;   // cancelled / stale
            this._pending.delete(msg.id);
            this._notifyBusy();

            if (msg.ok) {
                try {
                    resolve(JSON.parse(msg.result));
                } catch (err) {
                    resolve({ ok: false, errors: ["Bridge error: " + err.message] });
                }
            } else {
                resolve({ ok: false, errors: ["Engine error: " + msg.error] });
            }
        };

        this.worker.onerror = (e) => {
            // A worker-level crash fails every in-flight call; the page keeps
            // working for editing, and analysis reports the error.
            console.error("Engine worker error:", e);
            this._failAllPending("Engine worker crashed: " + (e.message || "unknown error"));
        };
    },

    _notifyBusy() {
        if (this.onBusyChange) this.onBusyChange(this._pending.size);
    },

    _failAllPending(message) {
        for (const resolve of this._pending.values()) {
            resolve({ ok: false, errors: [message] });
        }
        this._pending.clear();
        this._notifyBusy();
    },

    /**
     * Abandon whatever the engine is doing. Pyodide cannot be interrupted
     * mid-computation without cross-origin isolation (unavailable on GitHub
     * Pages), so cancel = terminate the worker and start a fresh one. SymPy
     * reloads in the background; in-flight calls resolve as cancelled.
     */
    cancel() {
        if (!this.worker) return;
        this.worker.terminate();
        this.isReady = false;
        this._isRestart = true;
        this._failAllPending("Cancelled");
        this._spawn();
    },

    _call(fn, ...args) {
        if (!this.isReady) {
            return Promise.resolve({ ok: false, errors: ["Engine not ready"] });
        }
        return new Promise((resolve) => {
            const id = this._nextId++;
            this._pending.set(id, resolve);
            this._notifyBusy();
            this.worker.postMessage({ id, fn, args });
        });
    },

    // Same method names as the old synchronous bridge, now Promise-returning.
    parseNetlist(text) {
        return this._call('parse_netlist', text);
    },

    solveCircuit(circuitJsonObj) {
        return this._call('solve', JSON.stringify(circuitJsonObj));
    },

    substitute(tfJsonObj, subsMapObj) {
        return this._call('substitute', JSON.stringify(tfJsonObj), JSON.stringify(subsMapObj));
    },

    flatten(tfJsonObj) {
        return this._call('flatten', JSON.stringify(tfJsonObj));
    },

    freqResponse(tfJsonObj, rangeObj) {
        return this._call('freq_response', JSON.stringify(tfJsonObj), JSON.stringify(rangeObj));
    },

    approximate(tfJsonObj, specObj) {
        return this._call('approximate', JSON.stringify(tfJsonObj), JSON.stringify(specObj));
    },

    polesZeros(tfJsonObj) {
        return this._call('poles_zeros', JSON.stringify(tfJsonObj));
    }
};

// Initialize immediately on load
document.addEventListener("DOMContentLoaded", () => {
    Bridge.init();
});
