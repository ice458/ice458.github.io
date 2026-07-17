/**
 * app.js
 * Main UI logic for Symbolic Circuit Analyzer
 */


// State
let currentCircuitJson = null;
let currentTf = null;
let currentSubstitutedTf = null;
let currentApproxTf = null;
let isFullyNumeric = false;

// Numeric-first mode. A circuit whose symbolic transfer function is
// exponentially large (a deep op-amp cascade, a long ladder) cannot be solved
// symbolically -- but with component values it collapses to a small numeric
// polynomial. When the engine reports that, we drop into this mode: the Values
// table is filled from the circuit's symbols, and once every one has a value we
// solve numerically (options.values) instead of substituting into a symbolic
// H(s) that was never formed.
let numericMode = false;
let numericSymbols = [];

// LRU cache of solve results, keyed by the exact circuit JSON (elements +
// ports + options). Undo/redo and port round-trips re-issue identical solves;
// this keeps them instant. Only deterministic outcomes are cached -- a success
// or a "too large" verdict -- never a transient transport failure.
const _solveCache = new Map();
const _SOLVE_CACHE_MAX = 8;

async function solveCircuitCached(circuitJson) {
    const key = JSON.stringify(circuitJson);
    const hit = _solveCache.get(key);
    if (hit) {
        _solveCache.delete(key);   // refresh LRU recency
        _solveCache.set(key, hit);
        return hit;
    }
    const result = await Bridge.solveCircuit(circuitJson);
    if (result.ok || result.reason === 'too_large') {
        _solveCache.set(key, result);
        while (_solveCache.size > _SOLVE_CACHE_MAX) {
            _solveCache.delete(_solveCache.keys().next().value);
        }
    }
    return result;
}

// DOM Elements
const els = {
    engineStatus: document.getElementById('engine-status'),
    engineStatusText: document.getElementById('engine-status-text'),
    engineCancelBtn: document.getElementById('engine-cancel-btn'),
    shareBtn: document.getElementById('share-btn'),
    schematicSampleSelect: document.getElementById('schematic-sample-select'),
    schematicClearBtn: document.getElementById('schematic-clear-btn'),
    autoscaleBtn: document.getElementById('autoscale-btn'),
    fullscreenBtn: document.getElementById('fullscreen-btn'),
    shortcutsBtn: document.getElementById('shortcuts-btn'),
    shortcutsPanel: document.getElementById('shortcuts-panel'),
    globalErrorBanner: document.getElementById('global-error-banner'),
    globalErrorText: document.getElementById('global-error-text'),
    closeErrorBtn: document.getElementById('close-error-btn'),
    importBtn: document.getElementById('import-btn'),
    exportBtn: document.getElementById('export-btn'),
    importFile: document.getElementById('import-file'),
    netlistInput: document.getElementById('netlist-input'),
    copyNetlistBtn: document.getElementById('copy-netlist-btn'),
    inputSource: document.getElementById('input-source'),
    outputNode: document.getElementById('output-node'),
    parseErrorBox: document.getElementById('parse-error-box'),
    resultPlaceholder: document.getElementById('result-placeholder'),
    resultContainer: document.getElementById('result-container'),
    tfKindLabel: document.getElementById('tf-kind-label'),
    numDegreeBadge: document.getElementById('num-degree-badge'),
    denDegreeBadge: document.getElementById('den-degree-badge'),
    latexOutput: document.getElementById('latex-output'),
    toggleCoeffsBtn: document.getElementById('toggle-coeffs-btn'),
    coeffsContainer: document.getElementById('coeffs-container'),
    numCoeffsList: document.getElementById('num-coeffs-list'),
    denCoeffsList: document.getElementById('den-coeffs-list'),
    togglePzBtn: document.getElementById('toggle-pz-btn'),
    pzContainer: document.getElementById('pz-container'),
    zerosList: document.getElementById('zeros-list'),
    polesList: document.getElementById('poles-list'),
    zerosCount: document.getElementById('zeros-count'),
    polesCount: document.getElementById('poles-count'),
    pzNotes: document.getElementById('pz-notes'),

    // Tabs. Both panes use .tab-btn, so scope to the right pane's own
    // [data-tab] -- an unscoped selector also grabs the left pane's
    // [data-left-tab] buttons, which have no dataset.tab.
    tabs: document.querySelectorAll('.tab-btn[data-tab]'),
    tabContents: document.querySelectorAll('.tab-content'),
    
    // Substitution
    subsPlaceholder: document.getElementById('subs-placeholder'),
    subsContainer: document.getElementById('subs-container'),
    subsTbody: document.getElementById('subs-tbody'),
    clearSubsBtn: document.getElementById('clear-subs-btn'),
    subsError: document.getElementById('subs-error'),
    
    // Plotting
    plotWarning: document.getElementById('plot-warning'),
    plotConfigContainer: document.getElementById('plot-config-container'),
    plotFmin: document.getElementById('plot-fmin'),
    plotFmax: document.getElementById('plot-fmax'),
    plotPoints: document.getElementById('plot-points'),
    plotType: document.getElementById('plot-type'),
    bodePlots: document.getElementById('bode-plots'),
    nyquistPlots: document.getElementById('nyquist-plots'),
    bodeReadout: document.getElementById('bode-readout'),
    compareReadout: document.getElementById('compare-readout'),

    // Approximation
    approxWarning: document.getElementById('approx-warning'),
    approxConfigContainer: document.getElementById('approx-config-container'),
    approxMode: document.getElementById('approx-mode'),
    approxCfgs: document.querySelectorAll('.approx-cfg'),
    truncNum: document.getElementById('trunc-num'),
    truncDen: document.getElementById('trunc-den'),
    assumeInput: document.getElementById('assume-input'),
    numThresh: document.getElementById('num-thresh'),
    runApproxBtn: document.getElementById('run-approx-btn'),
    undoApproxBtn: document.getElementById('undo-approx-btn'),
    resetApproxBtn: document.getElementById('reset-approx-btn'),
    approxSteps: document.getElementById('approx-steps'),
    approxResultsContainer: document.getElementById('approx-results-container'),
    approxLatexOutput: document.getElementById('approx-latex-output'),
    approxZerosList: document.getElementById('approx-zeros-list'),
    approxPolesList: document.getElementById('approx-poles-list'),
    approxZerosCount: document.getElementById('approx-zeros-count'),
    approxPolesCount: document.getElementById('approx-poles-count'),
    approxPzNotes: document.getElementById('approx-pz-notes'),
    droppedTermsContainer: document.getElementById('dropped-terms-container'),
    droppedTermsList: document.getElementById('dropped-terms-list'),
    comparePlotBtn: document.getElementById('compare-plot-btn'),
    comparePlotWrapper: document.getElementById('compare-plot-wrapper')
};

// --- Left Tabs (Schematic / Text) ---
const leftTabs = document.querySelectorAll('.tab-btn[data-left-tab]');
const leftTabContents = document.querySelectorAll('.left-tab-content');

leftTabs.forEach(tab => {
    tab.addEventListener('click', () => {
        // Remove active class from all left tabs
        leftTabs.forEach(t => t.classList.remove('active'));
        // Add active class to clicked left tab
        tab.classList.add('active');
        
        // Hide all left tab contents
        leftTabContents.forEach(content => content.classList.add('hidden'));
        // Show the corresponding left tab content
        const tabId = tab.dataset.leftTab;
        document.getElementById(`left-tab-${tabId}`).classList.remove('hidden');
        
        if (tabId === 'schematic') {
            syncSchematicIoOptions();
        } else {
            updateNetlistPreview();
        }
    });
});

// --- Right Tabs ---

// The schematic editor is pure JS and works from the first paint; only analysis
// needs SymPy. Blocking the whole page behind a ~30MB CDN download meant a
// first-time visitor sat and watched a spinner when they could have been
// drawing. So: gate the Analyze button, not the app.
let engineReady = false;

// Set when the netlist itself is unusable. Kept apart from the engine gate so
// the two reasons to disable Analyze cannot overwrite each other.
let analyzeBlocked = false;

// True once the user has analysed at least once. After that, edits re-analyse
// automatically so H(s), the symbol list (e.g. a newly non-ideal op-amp's A0 and
// GBW), and the plots track the circuit without a second click.
let hasAnalyzed = false;

function setEngineStatus(state, text) {
    els.engineStatus.className = `engine-status ${state}`;
    els.engineStatusText.textContent = text;
}

Bridge.onInitComplete = (isRestart) => {
    engineReady = true;
    setEngineStatus('ready', 'SymPy ready');
    // After a user cancel the worker restarts; re-analysing here would
    // immediately re-launch the very computation that was just cancelled.
    if (isRestart) return;
    // The circuit is already on screen (the editor does not wait for SymPy), so
    // analyse it right away: opening the page ends with H(s) visible, no click.
    // Silent -- a half-drawn restored circuit just doesn't produce a result yet.
    // Success sets hasAnalyzed, which turns on auto-refresh for later edits, so
    // from here the whole pipeline is automatic.
    analyzeSchematic(true);
};

Bridge.onInitFailed = (err) => {
    setEngineStatus('failed', 'SymPy failed to load');
    showGlobalError('The analysis engine failed to load. Reload the page to try again.\n' + (err?.message || ''));
};

// Engine runs in a worker, so the page never freezes -- but the user still
// needs to see that a computation is in flight, and a way out of one that
// grows without bound. The status chip doubles as that indicator, and the
// Cancel button appears only while something is actually running.
Bridge.onBusyChange = (busyCount) => {
    if (!engineReady) return;   // init progress owns the chip until ready
    if (busyCount > 0) {
        setEngineStatus('busy', 'Computing…');
        els.engineCancelBtn?.classList.remove('hidden');
    } else {
        setEngineStatus('ready', 'SymPy ready');
        els.engineCancelBtn?.classList.add('hidden');
    }
};

els.engineCancelBtn?.addEventListener('click', () => {
    // terminate + respawn: SymPy reloads in the background; the editor is
    // unaffected. In-flight calls resolve as cancelled errors.
    Bridge.cancel();
    engineReady = false;
    lastSolvedKey = null;
    _solveCache.clear();   // results from the terminated worker are moot
    els.engineCancelBtn.classList.add('hidden');
    setEngineStatus('loading', 'Cancelled — restarting engine…');
});

// --- Persistence -----------------------------------------------------------
// A public page gets reloaded, refreshed and closed by accident, and losing a
// drawn circuit to any of those is the worst thing this tool can do. So the
// schematic is saved locally on every change. Three levels, in priority order
// when the page opens: a shared link, then the last local autosave, then the
// default sample.

const STORAGE_KEY = 'symtf.schematic.v1';

function saveLocal() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(window.Schematic.getModel()));
    } catch (e) {
        // Private mode or a full quota. Not worth interrupting the user over.
        console.warn('Autosave failed:', e);
    }
}

function loadLocal() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const model = JSON.parse(raw);
        return model?.components?.length ? model : null;
    } catch (e) {
        console.warn('Could not read the autosave:', e);
        return null;
    }
}

// --- Share links ---
// The circuit rides in the URL fragment, which is never sent to the server --
// fitting for a static GitHub Pages app with no backend to send it to.
// CompressionStream is native, so this costs no dependency.

async function encodeModelToFragment(model) {
    const json = JSON.stringify(model);
    const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decodeModelFromFragment(frag) {
    const b64 = frag.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return JSON.parse(await new Response(stream).text());
}

els.shareBtn?.addEventListener('click', async () => {
    try {
        const frag = await encodeModelToFragment(window.Schematic.getModel());
        const url = `${location.origin}${location.pathname}#c=${frag}`;
        await navigator.clipboard.writeText(url);
        const prev = els.shareBtn.textContent;
        els.shareBtn.textContent = 'Copied!';
        setTimeout(() => { els.shareBtn.textContent = prev; }, 1500);
    } catch (e) {
        showGlobalError('Could not create a share link: ' + e.message);
    }
});

// --- Schematic samples ---

function loadSchematicSample(key) {
    const sample = window.Samples?.[key];
    if (!sample) return false;
    // Deep copy: the samples are module state and must survive being edited.
    window.Schematic.setModel(JSON.parse(JSON.stringify(sample.model)));
    syncSchematicIoOptions();
    window.Schematic.fitToView();
    return true;
}

function initSchematicSamples() {
    if (!window.Samples || !els.schematicSampleSelect) return;
    for (const [key, sample] of Object.entries(window.Samples)) {
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = sample.title;
        els.schematicSampleSelect.appendChild(opt);
    }
    els.schematicSampleSelect.addEventListener('change', (e) => {
        if (e.target.value) loadSchematicSample(e.target.value);
        e.target.value = '';   // it is an action, not a mode
        e.target.blur();
    });
}

els.schematicClearBtn?.addEventListener('click', () => {
    window.Schematic.clear();
    els.schematicClearBtn.blur();
});

els.autoscaleBtn?.addEventListener('click', () => {
    window.Schematic.fitToView();
    els.autoscaleBtn.blur();
});

// Full-screen editor: a body class does the layout (see CSS); the stage follows
// via its ResizeObserver. Fit once after the resize so the circuit re-centres in
// the new, larger canvas.
function toggleSchematicFullscreen(force) {
    const on = force !== undefined ? force : !document.body.classList.contains('schematic-full');
    document.body.classList.toggle('schematic-full', on);
    els.fullscreenBtn.textContent = on ? '⛶ Exit full screen' : '⛶ Full screen';
    // Let layout settle before measuring for the fit.
    requestAnimationFrame(() => window.Schematic.fitToView());
}

els.fullscreenBtn?.addEventListener('click', () => {
    toggleSchematicFullscreen();
    els.fullscreenBtn.blur();
});

document.addEventListener('toggleSchematicFullscreen', () => toggleSchematicFullscreen());

// Keyboard cheat sheet: the shortcuts existed but were written down nowhere a
// user could find them.
function toggleShortcuts(force) {
    els.shortcutsPanel.classList.toggle('hidden', force !== undefined ? !force : undefined);
}
els.shortcutsBtn?.addEventListener('click', () => { toggleShortcuts(); els.shortcutsBtn.blur(); });
document.addEventListener('keydown', (e) => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === '?') toggleShortcuts();
    else if (e.key === 'Escape') toggleShortcuts(false);
});

document.addEventListener('keydown', (e) => {
    // Esc leaves full screen. The schematic's own Esc (cancel placement) still
    // runs in its handler; this only reacts when already full screen.
    if (e.key === 'Escape' && document.body.classList.contains('schematic-full')) {
        toggleSchematicFullscreen(false);
    }
});

// --- Event Listeners ---


// The netlist the engine will actually be handed, including the virtual source.
// It is a view of the schematic, not an input -- so it is regenerated whenever
// the circuit or the chosen ports change, and never read back.
function selectedVirtualInput() {
    const opt = els.inputSource.selectedOptions[0];
    return opt && opt.dataset.isVirtual ? opt.value : null;
}

// Extraction is the single authority on whether the circuit can be analysed,
// and this runs on every schematic edit -- so fixing whatever was wrong clears
// the error and re-enables Analyze immediately, with no re-analyse needed. That
// was the bug: the gate was only ever set true on failure and never recomputed,
// so a floating-node error stuck even after the node was wired up.
function updateNetlistPreview() {
    if (!window.Netlist || !window.Schematic) return;
    const res = window.Netlist.extract(window.Schematic.getModel(), {
        virtualInput: selectedVirtualInput()
    });
    // '*' starts a comment in this format, so the reasons it will not analyse
    // can sit in the preview without making the text invalid.
    const notes = res.errors.map(e => '* ERROR: ' + e.msg)
        .concat(res.warnings.map(w => '* warning: ' + w.msg));
    els.netlistInput.value = [res.text, ...notes].filter(Boolean).join('\n');

    if (res.ok) {
        hideParseError();
    } else {
        setParseError(res.errors.map(e => e.msg));
    }
    analyzeBlocked = !res.ok;
    return res;
}

els.copyNetlistBtn?.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(els.netlistInput.value);
        const prev = els.copyNetlistBtn.textContent;
        els.copyNetlistBtn.textContent = 'Copied!';
        setTimeout(() => { els.copyNetlistBtn.textContent = prev; }, 1200);
    } catch (e) {
        showGlobalError('Could not copy: ' + e.message);
    }
});

// Changing a port changes the question being asked, so re-analyse right away
// (updateNetlistPreview runs inside analyzeSchematic).
els.inputSource.addEventListener('change', () => analyzeSchematic(true));
els.outputNode.addEventListener('change', () => analyzeSchematic(true));

// Runs the whole schematic -> H(s) path. `silent` is the auto-refresh mode: it
// suppresses the error banners and placeholder changes a manual click makes, so
// re-analysing after an edit never nags mid-drawing -- it just updates or quietly
// does nothing.
async function analyzeSchematic(silent = false) {
    // The schematic is the only input path now; the Netlist tab is a view.
    // updateNetlistPreview is the one place that extracts, writes the preview,
    // and sets the gate + error box -- reuse it so the click cannot disagree
    // with what the Netlist tab shows.
    const res = updateNetlistPreview();
    if (!res || !res.ok) {
        if (silent) return;
        if (res) window.Schematic.setErrorHighlights(res.errors);
        els.resultPlaceholder.classList.remove('hidden');
        els.resultPlaceholder.textContent = "Fix extraction errors to analyze.";
        els.resultContainer.classList.add('hidden');
        return;
    }
    window.Schematic.setErrorHighlights([]);

    const inOption = els.inputSource.selectedOptions[0];
    const outNode = els.outputNode.value;

    // Pass the ports explicitly. The element the engine wants is the injected
    // V_in, whose name exists only in the generated netlist -- the dropdown
    // holds the label the user picked.
    const inputName = res.virtualSource || (inOption ? inOption.value : null);
    if (!inputName || !outNode) {
        if (!silent) showGlobalError("Please specify both input and output.");
        return;
    }

    // The silent auto-refresh fires on EVERY schematic edit, including pure
    // moves that leave the netlist identical. Re-solving those wastes seconds
    // of SymPy time for a result already on screen -- skip when nothing the
    // engine sees has changed.
    if (silent && solveKey(inputName, outNode) === lastSolvedKey) return;

    await handleNetlistChange();         // engine parse -> currentCircuitJson
    if (analyzeBlocked) return;          // engine rejected the netlist

    runAnalysis({ kind: 'V', name: inputName }, { node: outNode }, silent).catch(() => {});
}


// Builds the port dropdowns from the schematic's netnames. This is now their
// only source -- it used to bail out unless the Schematic tab was showing,
// because the text-netlist path rebuilt the same <select> from parsed elements
// and the two would overwrite each other. With that path gone the guard only
// stopped the ports tracking the circuit while the Netlist tab was open.
function syncSchematicIoOptions() {
    if (!window.Netlist || !window.Schematic) return;
    const model = window.Schematic.getModel();
    const res = window.Netlist.extract(model);
    
    const prevInput = els.inputSource.value;
    const prevOutput = els.outputNode.value;
    
    els.inputSource.innerHTML = '';
    els.outputNode.innerHTML = '';

    // Options are node names only -- the label beside each dropdown already says
    // what the choice means (input voltage source / output voltage). Choosing an
    // input node injects the input voltage source there; "virtual" is an
    // implementation detail and stays out of the UI.
    (res.labels || []).forEach(lbl => {
        const inOpt = document.createElement('option');
        inOpt.value = lbl;
        inOpt.textContent = lbl;
        inOpt.dataset.kind = 'V';
        inOpt.dataset.isVirtual = 'true';
        els.inputSource.appendChild(inOpt);

        const outOpt = document.createElement('option');
        outOpt.value = lbl;
        outOpt.textContent = lbl;
        els.outputNode.appendChild(outOpt);
    });

    const labels = res.labels || [];
    const has = (sel, v) => Array.from(sel.options).some(o => o.value === v);
    const prefer = (patterns) => labels.find(l => patterns.some(p => p.test(l)));

    if (labels.length === 0) {
        for (const sel of [els.inputSource, els.outputNode]) {
            const opt = document.createElement('option');
            opt.textContent = "Place a netname (N) to choose ports";
            opt.disabled = true;
            sel.appendChild(opt);
        }
        return;
    }

    // Keep the user's picks when they survive; otherwise guess sensibly. The
    // browser's default is index 0 for BOTH selects, which made the output
    // default to the input node -- H(s) = 1 until the user noticed. Prefer
    // conventional names, else first label in, last label out.
    if (has(els.inputSource, prevInput)) {
        els.inputSource.value = prevInput;
    } else {
        els.inputSource.value = prefer([/^v?in$/i]) ?? labels[0];
    }
    if (has(els.outputNode, prevOutput)) {
        els.outputNode.value = prevOutput;
    } else {
        const guess = prefer([/^v?out$/i]) ?? labels[labels.length - 1];
        // Same-node in/out is never what anyone wants; dodge it if possible.
        els.outputNode.value = (guess === els.inputSource.value && labels.length > 1)
            ? labels.find(l => l !== els.inputSource.value)
            : guess;
    }
}
let autosaveTimer = null;
document.addEventListener('schematicChange', () => {
    window.Schematic.setErrorHighlights([]);
    syncSchematicIoOptions();
    // The netlist tab is a view of the schematic, so it tracks it. Order
    // matters: the ports must be rebuilt first, since the preview includes the
    // virtual source for whichever input is selected.
    updateNetlistPreview();
    // Debounced: the event fires on every edit, including each frame of a drag.
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(saveLocal, 400);

    // Once analysed, keep the results in step with the circuit. Silent, so a
    // half-finished edit does not throw error banners; entered substitution
    // values are preserved across the refresh (see populateSubstitutionTable).
    if (hasAnalyzed && engineReady) {
        clearTimeout(reanalyzeTimer);
        reanalyzeTimer = setTimeout(() => analyzeSchematic(true), 500);
    }
});
let reanalyzeTimer = null;

els.toggleCoeffsBtn.addEventListener('click', () => {
    els.coeffsContainer.classList.toggle('hidden');
    const isHidden = els.coeffsContainer.classList.contains('hidden');
    els.toggleCoeffsBtn.textContent = isHidden ? "View Coefficients" : "Hide Coefficients";
});

// Poles & Zeros are computed lazily -- rooting the polynomials is a Pyodide
// round-trip, so it only runs while the panel is open (and again whenever the
// displayed H(s) changes, see renderTf). pzVisible is that gate.
let pzVisible = false;
els.togglePzBtn.addEventListener('click', () => {
    pzVisible = !pzVisible;
    els.pzContainer.classList.toggle('hidden', !pzVisible);
    els.togglePzBtn.textContent = pzVisible ? "Hide Poles & Zeros" : "View Poles & Zeros";
    if (pzVisible) renderPolesZeros(currentSubstitutedTf);
});

// Tab Switching
els.tabs.forEach(btn => {
    btn.addEventListener('click', () => {
        // Remove active class from all
        els.tabs.forEach(t => t.classList.remove('active'));
        els.tabContents.forEach(c => c.classList.add('hidden'));
        
        // Add active to clicked
        btn.classList.add('active');
        const tabId = btn.dataset.tab;
        document.getElementById(`tab-${tabId}`).classList.remove('hidden');
    });
});

// Substitution is live: editing a value updates H(s) (and, when fully numeric,
// the plot) -- debounced so a mid-typed "1k" is not substituted as "1" first.
// There is no Apply button; the fields are the interface.
let subsLiveTimer = null;
let fixedLiveTimer = null;
els.subsTbody.addEventListener('input', (e) => {
    if (e.target.classList.contains('subs-val-input')) {
        clearTimeout(subsLiveTimer);
        subsLiveTimer = setTimeout(() => {
            // In numeric-first mode there is no symbolic H(s) to substitute
            // into; the values drive a numeric re-solve instead.
            const fn = numericMode ? maybeRunNumericSolve : applySubstitution;
            try { fn(); } catch (err) { showGlobalError('UI Error: ' + err.message); }
        }, 350);
        return;
    }
    // A schematic-fixed value ("R2 = 1k"): write it back to the part. The
    // commit fires schematicChange, and the silent re-analysis takes it from
    // there -- including moving the row to the symbols if the user typed a
    // symbol name instead of a number. Extraction's own validation catches
    // anything malformed and shows it in the error box.
    if (e.target.classList.contains('subs-fixed-input')) {
        const id = Number(e.target.dataset.compId);
        const value = e.target.value.trim();
        clearTimeout(fixedLiveTimer);
        fixedLiveTimer = setTimeout(() => {
            window.Schematic.setComponentValue(id, value);
        }, 500);
    }
});

els.clearSubsBtn.addEventListener('click', () => {
    document.querySelectorAll('.subs-val-input').forEach(input => input.value = '');
    clearSubsError();
    if (numericMode) {
        // No symbolic form to fall back to; just drop the stale numeric result
        // and wait for values again.
        currentTf = null;
        currentSubstitutedTf = null;
        isFullyNumeric = false;
        els.resultContainer.classList.add('hidden');
        els.resultPlaceholder.classList.remove('hidden');
        updatePlotTabState();
    } else {
        applySubstitution();   // no fields set -> restores the symbolic form
    }
});

// Plotting
els.plotType.addEventListener('change', (e) => {
    if (e.target.value === 'bode') {
        els.bodePlots.classList.remove('hidden');
        els.nyquistPlots.classList.add('hidden');
    } else {
        els.bodePlots.classList.add('hidden');
        els.nyquistPlots.classList.remove('hidden');
    }
    schedulePlot();
});

// Approximation
els.approxMode.addEventListener('change', (e) => {
    els.approxCfgs.forEach(cfg => cfg.classList.add('hidden'));
    document.getElementById(`approx-cfg-${e.target.value}`).classList.remove('hidden');
});
els.runApproxBtn.addEventListener('click', handleApproximation);
els.undoApproxBtn.addEventListener('click', () => { approxChain.pop(); renderApproxChain(); });
els.resetApproxBtn.addEventListener('click', () => { approxChain = []; renderApproxChain(); });
els.comparePlotBtn.addEventListener('click', handleComparePlots);

// Global Errors
els.closeErrorBtn.addEventListener('click', hideGlobalError);

// Import / Export
els.exportBtn.addEventListener('click', handleExport);
els.importBtn.addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', handleImport);

// --- UI Logic ---

function showGlobalError(msg) {
    els.globalErrorText.textContent = msg;
    els.globalErrorBanner.classList.remove('hidden');
    
    // Auto-hide after 10s
    setTimeout(hideGlobalError, 10000);
}

function hideGlobalError() {
    els.globalErrorBanner.classList.add('hidden');
}


// Parses the generated netlist into the circuit the engine solves. Deliberately
// does not touch the port dropdowns: those are built from the schematic's
// labels by syncSchematicIoOptions, and having this rebuild them too meant two
// systems overwriting the same <select> in turn.
async function handleNetlistChange() {
    if (!engineReady) return;

    const text = els.netlistInput.value.trim();
    if (!text) {
        setParseError("Draw a circuit to analyze.");
        analyzeBlocked = true;
        return;
    }

    const result = await Bridge.parseNetlist(text);

    if (!result.ok) {
        setParseError(result.errors);
        analyzeBlocked = true;
        return;
    }

    hideParseError();

    // parseNetlist returns circuit_json as a *string*, not an object.
    try {
        currentCircuitJson = JSON.parse(result.circuit_json);
        analyzeBlocked = false;
    } catch (e) {
        setParseError("Failed to parse circuit JSON internally.");
        analyzeBlocked = true;
    }
}

// User-controlled strings (component names, and error messages that quote
// them) must never reach innerHTML raw. A share link is an attack vector: a
// circuit whose part is named R<img/src=x/onerror=...> would execute in the
// browser of anyone who opens the link and analyses. Everything interpolated
// into markup goes through this.
function escHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Accepts a plain string or an array of messages (joined with line breaks).
// Content is escaped here so no caller can forget.
function setParseError(msg) {
    const parts = Array.isArray(msg) ? msg : [msg];
    els.parseErrorBox.innerHTML = parts.map(escHtml).join('<br>');
    els.parseErrorBox.classList.remove('hidden');
}

function hideParseError() {
    els.parseErrorBox.classList.add('hidden');
}

// Identity of a solved problem: what the engine reads (the generated netlist)
// plus the ports asked about. Matching key = the result on screen is already
// the answer, so the silent auto-refresh can skip the solve entirely.
let lastSolvedKey = null;
function solveKey(inName, outNode) {
    // '\n*' cannot appear inside a netlist line, so the join is unambiguous.
    return `${els.netlistInput.value}\n*IN=${inName}\n*OUT=${outNode}`;
}

// Rapid edits can queue several solves in the worker; they complete in order,
// but only the newest one may write to the screen. Each call takes a ticket
// and checks it still holds the newest before rendering.
let solveSeq = 0;

async function runAnalysis(forceInput = null, forceOutput = null, silent = false) {
    if (!currentCircuitJson) {
        throw new Error("No valid circuit JSON");
    }

    // Build complete spec
    let inKind, inName, outNode;

    if (forceInput && forceOutput) {
        inKind = forceInput.kind;
        inName = forceInput.name;
        outNode = forceOutput.node;
    } else {
        const inOption = els.inputSource.selectedOptions[0];
        outNode = els.outputNode.value;
        if (!inOption || !outNode) {
            showGlobalError("Please specify both input and output.");
            throw new Error("Missing I/O");
        }
        inKind = inOption.dataset.kind;
        inName = inOption.value;
    }

    currentCircuitJson.input = { kind: inKind, name: inName };
    currentCircuitJson.output = { kind: "node_voltage", node: outNode };

    // No speculative size warning here any more: the solve runs in a worker (the
    // UI never freezes), the fast path handles far larger systems than the old
    // n>12 threshold, and anything genuinely too large to solve symbolically is
    // caught by the engine and routed to numeric mode. Real warnings and the
    // too-large verdict come back with the result below.
    const key = solveKey(inName, outNode);
    const seq = ++solveSeq;
    const result = await solveCircuitCached(currentCircuitJson);

    // A newer solve was issued while this one ran: its result owns the screen.
    if (seq !== solveSeq) throw new Error("Superseded by a newer analysis");

    if (!result.ok) {
        lastSolvedKey = null;
        // Too large to solve symbolically: not a dead end -- offer the numeric
        // path. This is a normal outcome for big filters, not an error to throw.
        if (result.reason === 'too_large') {
            hasAnalyzed = true;
            enterNumericMode(result.symbols || [], result.errors || []);
            return null;
        }
        // With no Analyze button there is no manual retry, so solve
        // failures always land in the persistent parse-error box
        // rather than being swallowed (silent) or modal (manual).
        setParseError(result.errors.map(m => "Analysis: " + m));
        throw new Error("Analysis failed");
    }

    hasAnalyzed = true;   // enables auto-refresh on later edits
    numericMode = false;  // a symbolic result supersedes any numeric-first state
    lastSolvedKey = key;
    if (result.errors && result.errors.length > 0) {
        setParseError(result.errors.map(m => "Analysis: " + m));
    } else {
        hideParseError();
    }
    try {
        renderResults(result.tf);
    } catch (err) {
        console.error("Error during rendering:", err);
        showGlobalError("UI Error: " + err.message);
        throw err;
    }
    return result.tf;
}

// A fresh solve: this transfer function is the symbolic ground truth. It stays
// in currentTf and is what every substitution applies to -- so values can be
// changed or cleared later without re-analysing. The value fields are built
// once here, from the full symbol list, and persist.
function renderResults(tf) {
    currentTf = tf;
    currentSubstitutedTf = tf;
    currentApproxTf = null;
    // A fresh solve invalidates any approximation chain built on the old H(s).
    approxChain = [];
    if (els.approxSteps) renderApproxChain();
    isFullyNumeric = (tf.symbols.length === 0);
    populateSubstitutionTable(tf.symbols);
    renderTf(tf);
    updatePlotTabState();
    updateApproxTabState();

    // If values carried over from a previous analysis (auto-refresh after an
    // edit), re-apply them so a substituted view stays substituted rather than
    // snapping back to the symbolic form.
    if (els.subsTbody.querySelector('.subs-val-input') &&
        [...els.subsTbody.querySelectorAll('.subs-val-input')].some(i => i.value.trim() !== '')) {
        applySubstitution();
    }
}

// The symbolic solve overflowed: this circuit's symbolic H(s) is too large to
// form. Switch the Values table into "fill every field, then I solve
// numerically" mode. The symbol list comes from the engine (it knows exactly
// which values are still needed), so the fields appear even though there is no
// symbolic transfer function to substitute into.
function enterNumericMode(symbols, errors) {
    numericMode = true;
    numericSymbols = symbols;
    currentTf = null;
    currentSubstitutedTf = null;
    currentApproxTf = null;
    isFullyNumeric = false;
    approxChain = [];
    if (els.approxSteps) renderApproxChain();

    els.resultPlaceholder.classList.remove('hidden');
    els.resultPlaceholder.textContent =
        'Too large for a symbolic result — enter a value for every component below to plot the numeric response.';
    els.resultContainer.classList.add('hidden');

    setParseError(errors.concat(
        ['Enter a value for every symbol below; the response is then computed numerically.']));

    populateSubstitutionTable(symbols);
    els.subsPlaceholder.classList.add('hidden');
    els.subsContainer.classList.remove('hidden');
    updatePlotTabState();
    updateApproxTabState();

    // Values may already be filled (an edit re-analysed an already-numeric
    // circuit) -- solve straight away if so.
    maybeRunNumericSolve();
}

// In numeric mode, once every symbol has a value, solve with options.values so
// the engine substitutes into the MNA and returns a small numeric H(s) it never
// had to build symbolically. Debounced through the same live path as
// substitution, and guarded by the solve sequence so stale results never land.
async function maybeRunNumericSolve() {
    if (!numericMode || !currentCircuitJson) return;

    const values = {};
    let missing = false;
    document.querySelectorAll('.subs-val-input').forEach(inp => {
        const v = inp.value.trim();
        if (v === '') missing = true;
        else values[inp.dataset.sym] = parseSIValue(v);
    });
    if (missing || numericSymbols.some(sym => !(sym in values))) {
        // Not all values in yet: keep the guidance up, nothing to solve.
        return;
    }

    const circuit = { ...currentCircuitJson, options: { method: 'auto', values } };
    const seq = ++solveSeq;
    let result;
    try {
        result = await solveCircuitCached(circuit);
    } catch (e) {
        return;
    }
    if (seq !== solveSeq) return;
    if (!result.ok) {
        setSubsError((result.errors || ['Numeric solve failed.']).join('; '));
        return;
    }
    clearSubsError();
    hideParseError();
    currentTf = result.tf;
    currentSubstitutedTf = result.tf;
    isFullyNumeric = (result.tf.symbols.length === 0);
    els.resultPlaceholder.classList.add('hidden');
    els.resultContainer.classList.remove('hidden');
    renderTf(result.tf);
    updatePlotTabState();
}

// Draws a transfer function into the banner. Display only -- no state, no table
// rebuild -- so it is safe to call on every keystroke while editing values.
function renderTf(tf) {
    els.resultPlaceholder.classList.add('hidden');
    els.resultContainer.classList.remove('hidden');

    // Headers
    const kindMap = {
        'voltage_gain': 'Voltage Gain (V/V)',
        'current_gain': 'Current Gain (I/I)',
        'transimpedance': 'Transimpedance (V/I)',
        'admittance_transfer': 'Admittance Transfer (I/V)'
    };
    els.tfKindLabel.textContent = kindMap[tf.kind] || 'Transfer Function';
    els.numDegreeBadge.textContent = `Num Deg: ${tf.num_degree}`;
    els.denDegreeBadge.textContent = `Den Deg: ${tf.den_degree}`;

    // Render main LaTeX
    // Format: H(s) = \frac{num}{den}
    // tf.latex already contains the RHS latex representation from SymPy
    const displayLatex = `H(s) = ${tf.latex}`;
    katex.render(displayLatex, els.latexOutput, {
        displayMode: true,
        throwOnError: false
    });

    // Render Coefficients
    renderCoeffsList(els.numCoeffsList, tf.num_coeffs, tf.num_degree);
    renderCoeffsList(els.denCoeffsList, tf.den_coeffs, tf.den_degree);

    // Poles & Zeros track the displayed H(s) -- but only while the panel is
    // open, so a substitution keystroke does not pay for rooting when nobody is
    // looking at the result.
    if (pzVisible) renderPolesZeros(tf);
}

// The set of DOM nodes one poles/zeros panel writes into. There are two: the
// main result panel and the approximation result panel, so renderPolesZeros is
// told which one to fill rather than hard-coding either.
const PZ_MAIN = () => ({
    zerosList: els.zerosList, polesList: els.polesList,
    zerosCount: els.zerosCount, polesCount: els.polesCount, notes: els.pzNotes,
});
const PZ_APPROX = () => ({
    zerosList: els.approxZerosList, polesList: els.approxPolesList,
    zerosCount: els.approxZerosCount, polesCount: els.approxPolesCount,
    notes: els.approxPzNotes,
});

// Fills a Poles & Zeros panel from the engine's root solver. Zeros are the
// numerator roots, poles the denominator roots; for a fully-numeric H(s) each
// carries the corner frequency it maps to on the Bode axis.
async function renderPolesZeros(tf, target = PZ_MAIN()) {
    if (!tf) return;
    const result = await Bridge.polesZeros(tf);
    if (!result.ok) {
        target.zerosList.innerHTML = '';
        target.polesList.innerHTML = '';
        target.zerosCount.textContent = '';
        target.polesCount.textContent = '';
        target.notes.classList.remove('hidden');
        target.notes.textContent = (result.errors || ['Could not compute poles and zeros.']).join(' ');
        return;
    }

    renderRootList(target.zerosList, result.zeros);
    renderRootList(target.polesList, result.poles);
    target.zerosCount.textContent = result.zeros.length ? `(${result.zeros.length})` : '';
    target.polesCount.textContent = result.poles.length ? `(${result.poles.length})` : '';

    if (result.notes && result.notes.length) {
        target.notes.classList.remove('hidden');
        target.notes.textContent = result.notes.join(' ');
    } else {
        target.notes.classList.add('hidden');
        target.notes.textContent = '';
    }
}

function renderRootList(container, roots) {
    container.innerHTML = '';

    if (!roots || roots.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'pz-empty';
        empty.textContent = 'none';
        container.appendChild(empty);
        return;
    }

    roots.forEach((root, i) => {
        const item = document.createElement('div');
        item.className = 'pz-item';

        const idx = document.createElement('div');
        idx.className = 'pz-index';
        idx.textContent = `s${subscript(i + 1)}`;

        const value = document.createElement('div');
        value.className = 'pz-value';
        // root.latex is the s-plane value: a symbolic expression, or a numeric
        // real/complex value already rewritten for KaTeX by the engine.
        katex.render(root.latex, value, { throwOnError: false });

        item.appendChild(idx);
        item.appendChild(value);

        // Numeric roots also report the frequency they land on, so they can be
        // read straight against the Bode plot.
        if (root.f_hz != null) {
            const freq = document.createElement('div');
            freq.className = 'pz-freq';
            freq.textContent = fmtHz(root.f_hz);
            item.appendChild(freq);
        }

        container.appendChild(item);
    });
}

// Unicode subscript digits for the root index (s₁, s₂, …), matching the
// coefficient list's compact monospace look without pulling KaTeX in for it.
function subscript(n) {
    const map = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄',
                  '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉' };
    return String(n).replace(/[0-9]/g, d => map[d]);
}

function renderCoeffsList(container, coeffsStrArray, degree) {
    container.innerHTML = '';
    
    // coeffsStrArray is ordered highest degree first (from SymPy Poly.all_coeffs())
    coeffsStrArray.forEach((exprStr, index) => {
        const currentDegree = degree - index;
        
        const item = document.createElement('div');
        item.className = 'coeff-item';
        
        const powerDiv = document.createElement('div');
        powerDiv.className = 'coeff-power';
        powerDiv.textContent = `s^${currentDegree}`;
        
        const exprDiv = document.createElement('div');
        exprDiv.className = 'coeff-expr';
        // Basic render of the string - we can use KaTeX here if we parse it, 
        // but simply displaying the text is safe. For a better look, we can 
        // rely on SymPy's latex generation, but we only have string coeffs here.
        // As a quick fix, we render it as text.
        exprDiv.textContent = exprStr;

        item.appendChild(powerDiv);
        item.appendChild(exprDiv);
        container.appendChild(item);
    });
}

// --- M3: Substitution Logic ---

function parseSIValue(str) {
    if (!str) return null;
    str = str.trim();
    // Match number part and optional SI suffix
    const match = str.match(/^([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)([a-zA-Z]*)$/);
    if (!match) return str; // Pass raw to sympy if parsing fails
    
    let val = parseFloat(match[1]);
    const suffix = match[2];
    
    const multipliers = {
        'T': 1e12, 'G': 1e9, 'M': 1e6, 'Meg': 1e6, 'k': 1e3,
        'm': 1e-3, 'u': 1e-6, 'μ': 1e-6, 'n': 1e-9, 'p': 1e-12, 'f': 1e-15
    };
    
    if (suffix && multipliers[suffix]) {
        val *= multipliers[suffix];
    }
    
    return val.toString();
}

function populateSubstitutionTable(symbols) {
    els.subsPlaceholder.classList.add('hidden');
    els.subsContainer.classList.remove('hidden');

    // Keep whatever the user already typed: a re-analysis (including the silent
    // auto-refresh after an edit) rebuilds this table, and wiping the values
    // every time would make the numbers impossible to keep.
    const prev = {};
    els.subsTbody.querySelectorAll('.subs-val-input').forEach(inp => {
        if (inp.value.trim() !== '') prev[inp.dataset.sym] = inp.value;
    });

    // The rebuild may happen while the user is typing in this very table (the
    // fixed-value rows commit to the schematic, which triggers the silent
    // re-analysis that rebuilds us). Losing focus mid-edit would make those
    // fields untypable, so note where the caret is and put it back afterwards.
    const active = document.activeElement;
    const focusKey = active && els.subsTbody.contains(active)
        ? { sym: active.dataset.sym, compId: active.dataset.compId, pos: active.selectionStart }
        : null;

    els.subsTbody.innerHTML = '';

    symbols.forEach(sym => {
        const tr = document.createElement('tr');
        const val = prev[sym] ? ` value="${escHtml(prev[sym])}"` : '';
        tr.innerHTML = `
            <td>${escHtml(sym)}</td>
            <td><input type="text" class="text-input subs-val-input" data-sym="${escHtml(sym)}"${val} placeholder="e.g. 1k, 4.7u"></td>
        `;
        els.subsTbody.appendChild(tr);
    });

    // Parts whose value is a literal number ("R2 = 1k") are baked into the
    // coefficients by the engine and never appear as symbols -- which read as
    // "R2 vanished from the variables". List them here too, editable: a change
    // writes back to the schematic and the auto-refresh re-solves.
    const model = window.Schematic ? window.Schematic.getModel() : { components: [] };
    const fixed = model.components.filter(c =>
        ['R', 'C', 'L', 'E', 'G'].includes(c.type) &&
        c.value && window.Netlist?.isNumericValue(c.value.trim()));
    fixed.forEach(c => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escHtml(c.name)} <span class="subs-fixed-tag" title="Value set on the schematic">fixed</span></td>
            <td><input type="text" class="text-input subs-fixed-input" data-comp-id="${c.id}"
                 value="${escHtml(c.value.trim())}"></td>
        `;
        els.subsTbody.appendChild(tr);
    });

    if (symbols.length === 0 && fixed.length === 0) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="2" style="text-align:center; color:var(--text-secondary)">No symbols to substitute.</td>`;
        els.subsTbody.appendChild(tr);
    }

    if (focusKey) {
        const sel = focusKey.sym
            ? `.subs-val-input[data-sym="${focusKey.sym}"]`
            : `.subs-fixed-input[data-comp-id="${focusKey.compId}"]`;
        const inp = els.subsTbody.querySelector(sel);
        if (inp) {
            inp.focus();
            if (focusKey.pos != null) inp.setSelectionRange(focusKey.pos, focusKey.pos);
        }
    }
}

function setSubsError(msg) {
    els.subsError.textContent = msg;
    els.subsError.classList.remove('hidden');
}
function clearSubsError() {
    els.subsError.classList.add('hidden');
}

// Reads the value fields and shows H(s) with those values applied. Always
// substitutes into the original currentTf, so every field is independent: change
// one and the rest keep their values, clear one and its symbol comes back, clear
// them all and the fully symbolic form returns -- no re-analyse. Called on the
// button and, debounced, on every keystroke.
let subsSeq = 0;
async function applySubstitution() {
    if (!currentTf) return;

    const subsMap = {};
    document.querySelectorAll('.subs-val-input').forEach(input => {
        if (input.value.trim() !== '') subsMap[input.dataset.sym] = parseSIValue(input.value);
    });

    // Nothing entered: show the original symbolic transfer function.
    if (Object.keys(subsMap).length === 0) {
        currentSubstitutedTf = currentTf;
        isFullyNumeric = (currentTf.symbols.length === 0);
        renderTf(currentTf);
        updatePlotTabState();
        return;
    }

    const seq = ++subsSeq;
    const result = await Bridge.substitute(currentTf, subsMap);
    // Keystrokes can outrun the worker; only the newest substitution renders.
    if (seq !== subsSeq) return;
    if (!result.ok) {
        setSubsError(result.errors.join('; '));
        return;
    }
    clearSubsError();
    currentSubstitutedTf = result.tf;
    isFullyNumeric = result.fully_numeric;
    renderTf(result.tf);
    updatePlotTabState();
}


// --- M3: Plotting Logic ---

function updatePlotTabState() {
    if (isFullyNumeric) {
        els.plotWarning.classList.add('hidden');
        els.plotConfigContainer.classList.remove('hidden');
        // Fully numeric is the plottable state, so plot -- this is what makes
        // typing a value flow straight through to the curve with no button.
        schedulePlot();
    } else {
        els.plotWarning.classList.remove('hidden');
        els.plotConfigContainer.classList.add('hidden');
    }
}

// Redraws the plot from the current tf and range settings. There is no Plot
// button: this runs whenever the values become fully numeric or a range field
// changes. Auto-triggered, so invalid/mid-typed configuration is a silent skip
// rather than an error banner.
let plotSeq = 0;
async function handlePlotting() {
    if (!currentSubstitutedTf || !isFullyNumeric) return;

    const f_min = parseFloat(parseSIValue(els.plotFmin.value));
    const f_max = parseFloat(parseSIValue(els.plotFmax.value));
    const points = parseInt(els.plotPoints.value);
    if (isNaN(f_min) || isNaN(f_max) || isNaN(points) || f_min <= 0 || f_max <= f_min) return;

    const range = { f_min, f_max, points: Math.min(Math.max(points, 10), 1000) };
    try {
        const tf = currentSubstitutedTf;
        const seq = ++plotSeq;
        const result = await Bridge.freqResponse(tf, range);
        if (seq !== plotSeq) return;   // a newer plot request superseded this one
        if (result.ok) renderPlotly(result.data, tf.kind);
        else console.warn('freq_response:', result.errors);
    } catch (e) {
        console.warn('plot error:', e);
    }
}

// One debounced entry point for every auto-plot trigger.
let plotTimer = null;
function schedulePlot() {
    clearTimeout(plotTimer);
    plotTimer = setTimeout(handlePlotting, 250);
}

[els.plotFmin, els.plotFmax, els.plotPoints].forEach(el =>
    el.addEventListener('input', schedulePlot));

const PLOT_BASE_LAYOUT = {
    font: { family: 'Inter, sans-serif', color: '#94a3b8' },
    margin: { l: 60, r: 20, t: 30, b: 45 },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'rgba(0,0,0,0.02)',
    showlegend: false
};
const PLOT_CONFIG = { responsive: true, displaylogo: false, displayModeBar: false };

// Grid styling: the lines guide, the data speaks -- so the mesh is faint and
// only the zero line (0 dB, 0 deg) keeps full clarity. The y axes previously
// used Plotly's DEFAULT gridcolor, near-white on this dark theme, which is why
// the mesh shouted.
const GRID_FAINT = 'rgba(255,255,255,0.05)';
const GRID_ZERO = 'rgba(255,255,255,0.28)';

function freqAxis(title) {
    return {
        type: 'log', title,
        gridcolor: GRID_FAINT, zeroline: false
    };
}

function valueAxis(title, dtick) {
    const ax = {
        title,
        gridcolor: GRID_FAINT,
        zeroline: true, zerolinecolor: GRID_ZERO, zerolinewidth: 1
    };
    if (dtick) ax.dtick = dtick;
    return ax;
}

// Phase reads in protractor steps. Pick the step from the data span so there
// are a handful of lines, never a wall of them.
function phaseDtick(values) {
    const span = Math.max(...values) - Math.min(...values);
    for (const step of [5, 15, 30, 45, 90]) {
        if (span / step <= 8) return step;
    }
    return 180;
}

// The hover cursor: a DOM line plus a small frequency/value chip drawn on BOTH
// plots. All DOM, none of it Plotly's -- shapes needed relayout (which wiped
// hover state) and Fx.hover never rendered a tooltip on the plot the pointer
// was not in, which is why the partner side stayed bare. Traces are created
// with hoverinfo 'none': plotly_hover still fires, but the only labels are
// ours, identical on both plots.
// Pixel positions come from the axis converters (ax.d2p handles log axes);
// _fullLayout internals are stable enough with plotly pinned to 2.32.0.
function moveCursor(gd, f, labelText) {
    const xa = gd._fullLayout?.xaxis, ya = gd._fullLayout?.yaxis;
    if (!xa || !ya) return;

    let line = gd.querySelector(':scope > .plot-cursor-line');
    if (!line) {
        line = document.createElement('div');
        line.className = 'plot-cursor-line';
        gd.appendChild(line);
    }
    const px = xa._offset + xa.d2p(f);
    line.style.left = `${px}px`;
    line.style.top = `${ya._offset}px`;
    line.style.height = `${ya._length}px`;
    line.style.display = 'block';

    let chip = gd.querySelector(':scope > .plot-cursor-chip');
    if (!chip) {
        chip = document.createElement('div');
        chip.className = 'plot-cursor-chip';
        gd.appendChild(chip);
    }
    chip.textContent = labelText;
    chip.style.top = `${ya._offset + 4}px`;
    // Keep the chip inside the plot: flip to the left of the line on the
    // right half.
    const onRight = xa.d2p(f) > xa._length / 2;
    chip.style.left = `${px + (onRight ? -8 : 8)}px`;
    chip.style.transform = onRight ? 'translateX(-100%)' : 'none';
    chip.style.display = 'block';
}

function hideCursor(gd) {
    for (const sel of ['.plot-cursor-line', '.plot-cursor-chip']) {
        const el = gd.querySelector(`:scope > ${sel}`);
        if (el) el.style.display = 'none';
    }
}

// Gain and phase share one frequency axis, so zooming or panning either must
// move the other. Plotly reports the change as a relayout event; mirror the new
// x-range (or an autorange reset) onto the partner. The flag stops the mirrored
// call from bouncing straight back.
function linkFrequencyZoom(idA, idB) {
    const a = document.getElementById(idA);
    const b = document.getElementById(idB);
    if (!a || !b) return;
    let syncing = false;

    const mirror = (dst) => (ev) => {
        if (syncing) return;
        let upd = null;
        if (ev['xaxis.range[0]'] !== undefined) {
            upd = { 'xaxis.range[0]': ev['xaxis.range[0]'], 'xaxis.range[1]': ev['xaxis.range[1]'] };
        } else if (ev['xaxis.autorange']) {
            upd = { 'xaxis.autorange': true };
        }
        if (!upd) return;
        syncing = true;
        Plotly.relayout(dst, upd).then(() => { syncing = false; });
    };

    a.on('plotly_relayout', mirror(idB));
    b.on('plotly_relayout', mirror(idA));
}

// Hovering either plot puts the cursor (line + value chip) on BOTH at the same
// sample and fills the shared readout. Both plots share the frequency array,
// so one point index addresses the same frequency everywhere.
// `readout(i)` -> HTML for the readout bar; `chipA(i)` / `chipB(i)` -> the chip
// text for each plot (its own quantity: dB on the gain pane, deg on phase).
function linkHoverReadout(idA, idB, readoutEl, readout, freqs, chipA, chipB) {
    const a = document.getElementById(idA);
    const b = document.getElementById(idB);
    if (!a || !b) return;

    const show = (d) => {
        const i = d.points[0].pointIndex;
        if (readoutEl) readoutEl.innerHTML = readout(i);
        moveCursor(a, freqs[i], chipA(i));
        moveCursor(b, freqs[i], chipB(i));
    };
    const hide = () => { hideCursor(a); hideCursor(b); };

    a.on('plotly_hover', show);
    b.on('plotly_hover', show);
    a.on('plotly_unhover', hide);
    b.on('plotly_unhover', hide);
}

const fmtHz = (f) => f >= 1e6 ? (f / 1e6).toPrecision(4) + ' MHz'
    : f >= 1e3 ? (f / 1e3).toPrecision(4) + ' kHz'
    : f.toPrecision(4) + ' Hz';

// The unit of H itself, so the Nyquist axes (which plot Re/Im of H) can be
// labelled. A voltage or current gain is a ratio -- dimensionless, no unit.
const TF_UNIT = {
    voltage_gain: '',
    current_gain: '',
    transimpedance: ' (Ω)',      // V/I -> ohms
    admittance_transfer: ' (S)'       // I/V -> siemens
};

function renderPlotly(data, kind) {
    Plotly.newPlot('bode-mag-plot', [{
        x: data.f, y: data.mag_db, type: 'scatter', mode: 'lines',
        line: { color: '#6366f1', width: 2 }, name: 'Gain', hoverinfo: 'none'
    }], {
        ...PLOT_BASE_LAYOUT, title: 'Magnitude', hovermode: 'x',
        xaxis: freqAxis('Frequency (Hz)'), yaxis: valueAxis('Gain (dB)')
    }, PLOT_CONFIG);

    Plotly.newPlot('bode-phase-plot', [{
        x: data.f, y: data.phase_deg, type: 'scatter', mode: 'lines',
        line: { color: '#a855f7', width: 2 }, name: 'Phase', hoverinfo: 'none'
    }], {
        ...PLOT_BASE_LAYOUT, title: 'Phase', hovermode: 'x',
        xaxis: freqAxis('Frequency (Hz)'),
        yaxis: valueAxis('Phase (°)', phaseDtick(data.phase_deg))
    }, PLOT_CONFIG);

    linkFrequencyZoom('bode-mag-plot', 'bode-phase-plot');
    linkHoverReadout('bode-mag-plot', 'bode-phase-plot', els.bodeReadout, (i) =>
        `<b>f</b> ${fmtHz(data.f[i])}` +
        ` &nbsp; <b>Gain</b> ${data.mag_db[i].toFixed(2)} dB` +
        ` &nbsp; <b>Phase</b> ${data.phase_deg[i].toFixed(2)}°`,
    data.f,
    (i) => `${fmtHz(data.f[i])}  ${data.mag_db[i].toFixed(2)} dB`,
    (i) => `${fmtHz(data.f[i])}  ${data.phase_deg[i].toFixed(2)}°`);

    const unit = TF_UNIT[kind] ?? '';
    Plotly.newPlot('nyquist-plot', [{
        x: data.re, y: data.im, type: 'scatter', mode: 'lines',
        line: { color: '#10b981', width: 2 }
    }], {
        ...PLOT_BASE_LAYOUT, title: 'Nyquist',
        xaxis: valueAxis(`Re{H}${unit}`),
        yaxis: { ...valueAxis(`Im{H}${unit}`), scaleanchor: 'x', scaleratio: 1 }
    }, PLOT_CONFIG);
}

// --- M4: Approximation Logic ---

function updateApproxTabState() {
    if (currentTf) {
        els.approxWarning.classList.add('hidden');
        els.approxConfigContainer.classList.remove('hidden');
        els.approxResultsContainer.classList.add('hidden');
    } else {
        els.approxWarning.classList.remove('hidden');
        els.approxConfigContainer.classList.add('hidden');
    }
}

// Approximation steps chain: each step applies to the previous step's result
// (the original H(s) for the first), so modes combine -- an assumption, then a
// truncation, then a limit. The chain is the state; the display re-renders
// from it, which is also what makes Undo/Reset trivial.
let approxChain = [];

function buildApproxSpec() {
    const mode = els.approxMode.value;
    const spec = { mode };
    let label = '';

    if (mode === 'limit') {
        spec.direction = document.querySelector('input[name="limit_dir"]:checked').value;
        label = spec.direction === 'dc' ? 'Limit s → 0' : 'Limit s → ∞';
    } else if (mode === 'truncate') {
        spec.max_num_order = parseInt(els.truncNum.value);
        spec.max_den_order = parseInt(els.truncDen.value);
        label = `Truncate: num ≤ s^${spec.max_num_order}, den ≤ s^${spec.max_den_order}`;
    } else if (mode === 'assumption') {
        const val = els.assumeInput.value.trim();
        spec.assumptions = val ? val.split(',').map(t => t.trim()) : [];
        if (!spec.assumptions.length) {
            showGlobalError('Enter at least one assumption, e.g. "gm*ro >> 1".');
            return null;
        }
        label = 'Assume ' + spec.assumptions.join(', ');
    } else if (mode === 'numerical') {
        spec.threshold = parseFloat(els.numThresh.value);
        const typicalValues = {};
        let missing = false;
        document.querySelectorAll('.subs-val-input').forEach(input => {
            const v = parseSIValue(input.value);
            if (!v) missing = true;
            else typicalValues[input.dataset.sym] = parseFloat(v);
        });
        if (missing) {
            showGlobalError("Numerical approximation requires ALL symbols to have a value in the Values tab.");
            return null;
        }
        spec.typical_values = typicalValues;
        label = `Numerical (threshold ${spec.threshold})`;
    }
    return { spec, label };
}

async function handleApproximation() {
    if (!currentTf) return;
    const built = buildApproxSpec();
    if (!built) return;

    els.runApproxBtn.disabled = true;
    els.runApproxBtn.querySelector('.btn-spinner').classList.remove('hidden');

    try {
        // The step applies to where the chain currently stands.
        const base = approxChain.length ? approxChain[approxChain.length - 1].tf : currentTf;
        const result = await Bridge.approximate(base, built.spec);
        if (!result.ok) {
            showGlobalError("Approximation Error:\n" + result.errors.join("\n"));
        } else {
            approxChain.push({
                label: built.label,
                tf: result.tf_approx,
                dropped: result.dropped_terms || []
            });
            renderApproxChain();
        }
    } catch (e) {
        showGlobalError("UI Error: " + e.message);
    } finally {
        els.runApproxBtn.disabled = false;
        els.runApproxBtn.querySelector('.btn-spinner').classList.add('hidden');
    }
}

// Redraws everything the chain implies: the steps list, the resulting H(s),
// the dropped terms (grouped per step), and currentApproxTf for the compare.
function renderApproxChain() {
    if (approxChain.length === 0) {
        currentApproxTf = null;
        els.approxResultsContainer.classList.add('hidden');
        els.comparePlotWrapper.classList.add('hidden');
        els.approxSteps.innerHTML = '';
        return;
    }

    const tail = approxChain[approxChain.length - 1];
    currentApproxTf = tail.tf;
    els.approxResultsContainer.classList.remove('hidden');

    els.approxSteps.innerHTML = '';
    approxChain.forEach((step, i) => {
        const li = document.createElement('li');
        const n = step.dropped.length;
        li.textContent = step.label + (n ? ` — ${n} term${n > 1 ? 's' : ''} dropped` : '');
        els.approxSteps.appendChild(li);
    });

    katex.render(`H_{approx}(s) = ${tail.tf.latex}`, els.approxLatexOutput, {
        displayMode: true,
        throwOnError: false
    });

    // The point of an approximation is often what it does to the poles and
    // zeros, so show them for the approximated H(s) too. This only runs when a
    // step is added/undone (not per keystroke), so computing them here is cheap.
    renderPolesZeros(tail.tf, PZ_APPROX());

    els.droppedTermsList.innerHTML = '';
    const anyDropped = approxChain.some(st => st.dropped.length);
    els.droppedTermsContainer.classList.toggle('hidden', !anyDropped);
    approxChain.forEach((step, i) => {
        step.dropped.forEach(term => {
            const li = document.createElement('li');
            li.textContent = `[step ${i + 1}] ${term}`;
            els.droppedTermsList.appendChild(li);
        });
    });

    els.comparePlotWrapper.classList.add('hidden');
}

function handleComparePlots() {
    if (!currentTf || !currentApproxTf) return;

    // Get current substitution map
    const inputs = document.querySelectorAll('.subs-val-input');
    const subsMap = {};
    inputs.forEach(input => {
        if (input.value.trim() !== '') {
            subsMap[input.dataset.sym] = parseSIValue(input.value);
        }
    });

    els.comparePlotBtn.disabled = true;
    els.comparePlotBtn.textContent = "Plotting...";

    (async () => {
        try {
            // Substitute into both TFs. Independent calls, so issue them
            // together; the worker runs them back to back.
            const [origSubRes, approxSubRes] = await Promise.all([
                Bridge.substitute(currentTf, subsMap),
                Bridge.substitute(currentApproxTf, subsMap)
            ]);

            if (!origSubRes.ok || !approxSubRes.ok) {
                showGlobalError("Substitution failed during plot compare.");
                return;
            }

            if (!origSubRes.fully_numeric || !approxSubRes.fully_numeric) {
                showGlobalError("Cannot plot: Not all variables have values in the Substitution tab.");
                return;
            }

            // Same frequency range as the main plot, so "compare" compares the
            // band the user is actually looking at.
            const range = {
                f_min: parseFloat(parseSIValue(els.plotFmin.value)) || 1,
                f_max: parseFloat(parseSIValue(els.plotFmax.value)) || 1e6,
                points: parseInt(els.plotPoints.value) || 200
            };

            const [origPlotRes, approxPlotRes] = await Promise.all([
                Bridge.freqResponse(origSubRes.tf, range),
                Bridge.freqResponse(approxSubRes.tf, range)
            ]);

            if (!origPlotRes.ok || !approxPlotRes.ok) {
                showGlobalError("Freq Response generation failed.");
                return;
            }

            // Render Overlaid Plotly
            els.comparePlotWrapper.classList.remove('hidden');

            const orig = origPlotRes.data, approx = approxPlotRes.data;
            const layout = { ...PLOT_BASE_LAYOUT, showlegend: true, hovermode: 'x',
                legend: { orientation: 'h', y: 1.15 } };

            Plotly.newPlot('compare-mag-plot', [
                { x: orig.f, y: orig.mag_db, type: 'scatter', mode: 'lines',
                  name: 'Original', line: { color: '#6366f1', width: 2 }, hoverinfo: 'none' },
                { x: approx.f, y: approx.mag_db, type: 'scatter', mode: 'lines',
                  name: 'Approx', line: { color: '#ef4444', width: 2, dash: 'dash' }, hoverinfo: 'none' }
            ], { ...layout, title: 'Magnitude', xaxis: freqAxis('Frequency (Hz)'), yaxis: valueAxis('Gain (dB)') }, PLOT_CONFIG);

            Plotly.newPlot('compare-phase-plot', [
                { x: orig.f, y: orig.phase_deg, type: 'scatter', mode: 'lines',
                  name: 'Original', line: { color: '#a855f7', width: 2 }, hoverinfo: 'none' },
                { x: approx.f, y: approx.phase_deg, type: 'scatter', mode: 'lines',
                  name: 'Approx', line: { color: '#f59e0b', width: 2, dash: 'dash' }, hoverinfo: 'none' }
            ], { ...layout, title: 'Phase',
                 xaxis: freqAxis('Frequency (Hz)'),
                 yaxis: valueAxis('Phase (°)', phaseDtick(orig.phase_deg.concat(approx.phase_deg))) }, PLOT_CONFIG);

            linkFrequencyZoom('compare-mag-plot', 'compare-phase-plot');
            linkHoverReadout('compare-mag-plot', 'compare-phase-plot', els.compareReadout, (i) =>
                `<b>f</b> ${fmtHz(orig.f[i])}` +
                ` &nbsp; <b>Gain</b> ${orig.mag_db[i].toFixed(2)}/${approx.mag_db[i].toFixed(2)} dB` +
                ` &nbsp; <b>Phase</b> ${orig.phase_deg[i].toFixed(2)}/${approx.phase_deg[i].toFixed(2)}°`,
            orig.f,
            (i) => `${fmtHz(orig.f[i])}  ${orig.mag_db[i].toFixed(2)} / ${approx.mag_db[i].toFixed(2)} dB`,
            (i) => `${fmtHz(orig.f[i])}  ${orig.phase_deg[i].toFixed(2)} / ${approx.phase_deg[i].toFixed(2)}°`);

        } catch (e) {
            showGlobalError("UI Plot Error: " + e.message);
        } finally {
            els.comparePlotBtn.disabled = false;
            els.comparePlotBtn.textContent = "Compare Bode Plots";
        }
    })();
}

// --- M5: Export / Import Logic ---

function handleExport() {
    // Deliberately not gated on a successful analysis: a half-drawn circuit is
    // exactly the thing you want to save before walking away from it.
    const schematic = window.Schematic.getModel();
    if (!schematic.components.length && !els.netlistInput.value.trim()) {
        showGlobalError("Nothing to export yet -- draw a circuit or write a netlist first.");
        return;
    }

    // 1. Substitution Values
    const inputs = document.querySelectorAll('.subs-val-input');
    const subsMap = {};
    inputs.forEach(input => {
        if (input.value.trim() !== '') {
            subsMap[input.dataset.sym] = input.value.trim(); // Save raw string with prefixes
        }
    });
    
    // 2. Approximation Config
    const approxConfig = {
        mode: els.approxMode.value,
        limit_dir: document.querySelector('input[name="limit_dir"]:checked').value,
        trunc_num: els.truncNum.value,
        trunc_den: els.truncDen.value,
        assumptions: els.assumeInput.value,
        num_thresh: els.numThresh.value
    };

    const sessionData = {
        version: "1.1",
        // v1.0 saved only the netlist text, so anyone who drew a circuit and
        // round-tripped through Export/Import lost the drawing -- the schematic
        // is the tool's primary input, which made this worse than no feature.
        schematic,
        netlist: els.netlistInput.value,
        input: currentCircuitJson?.input || null,
        output: currentCircuitJson?.output || null,
        substitution: subsMap,
        approximation: approxConfig
    };

    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(sessionData, null, 2));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", dataStr);
    downloadAnchorNode.setAttribute("download", "symtf_session.json");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
}

function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (event) => {
        try {
            const data = JSON.parse(event.target.result);

            // The schematic is the only input path, so a file without one has
            // nothing to load. Saying that beats silently leaving the current
            // circuit on screen and showing its netlist as if it were the file's.
            if (!data.schematic?.components) {
                throw new Error(
                    "This file has no schematic. Sessions saved before the schematic " +
                    "editor stored only netlist text, which can no longer be analyzed."
                );
            }

            // 1. The schematic. Everything else here is derived from it.
            window.Schematic.setModel(data.schematic);
            syncSchematicIoOptions();
            updateNetlistPreview();
            await handleNetlistChange();
            
            // 2. Run Analysis to populate symbols (Wait for it)
            if (data.input && data.output && currentCircuitJson) {
                // Pre-select I/O options manually if possible, or pass force arguments
                try {
                    await runAnalysis(data.input, data.output);
                } catch (err) {
                    throw new Error("Failed to run analysis during import: " + err.message);
                }
            }

            // 3. Restore Substitution
            if (data.substitution && Object.keys(data.substitution).length > 0) {
                const inputs = document.querySelectorAll('.subs-val-input');
                inputs.forEach(input => {
                    const sym = input.dataset.sym;
                    if (data.substitution[sym] !== undefined) {
                        input.value = data.substitution[sym];
                    }
                });
                // Apply them through the live path.
                await applySubstitution();
            }

            // 4. Restore Approximation
            if (data.approximation) {
                els.approxMode.value = data.approximation.mode;
                // Dispatch change event to toggle UI containers
                els.approxMode.dispatchEvent(new Event('change'));
                
                document.querySelector(`input[name="limit_dir"][value="${data.approximation.limit_dir}"]`).checked = true;
                els.truncNum.value = data.approximation.trunc_num;
                els.truncDen.value = data.approximation.trunc_den;
                els.assumeInput.value = data.approximation.assumptions;
                els.numThresh.value = data.approximation.num_thresh;
            }

        } catch (err) {
            showGlobalError("Import Failed: " + err.message);
        } finally {
            // Clear input so same file can be uploaded again if needed
            e.target.value = '';
        }
    };
    reader.readAsText(file);
}


// --- Boot ------------------------------------------------------------------
// What a visitor sees, in priority order: a circuit someone shared with them,
// else their own last session, else the default sample -- because an empty
// canvas tells a first-time visitor nothing about what this tool does.

async function restoreInitialCircuit() {
    const shared = /^#c=(.+)$/.exec(location.hash);
    if (shared) {
        try {
            const model = await decodeModelFromFragment(shared[1]);
            if (window.Schematic.setModel(model, { undoable: false })) {
                syncSchematicIoOptions();
                window.Schematic.fitToView();
                return;
            }
        } catch (e) {
            showGlobalError('That share link could not be read; loading the example instead.');
        }
    }

    const saved = loadLocal();
    if (saved && window.Schematic.setModel(saved, { undoable: false })) {
        syncSchematicIoOptions();
        window.Schematic.fitToView();
        return;
    }

    loadSchematicSample('rc_lpf');
}

function boot() {
    initSchematicSamples();
    setEngineStatus('loading', 'Loading SymPy…');

    restoreInitialCircuit();
}

// index.html loads schematic.js before this file, so its DOMContentLoaded
// handler is registered first and the editor exists by the time boot() runs.
document.addEventListener('DOMContentLoaded', boot);
