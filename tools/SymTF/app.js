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
    toggleFlatBtn: document.getElementById('toggle-flat-btn'),
    toggleStdBtn: document.getElementById('toggle-std-btn'),
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
    solveLongBtn: document.getElementById('solve-long-btn'),
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
    comparePlotWrapper: document.getElementById('compare-plot-wrapper'),

    // Sensitivity
    sensWarning: document.getElementById('sens-warning'),
    sensConfigContainer: document.getElementById('sens-config-container'),
    sensTarget: document.getElementById('sens-target'),
    sensCfgStandard: document.getElementById('sens-cfg-standard'),
    sensCfgAtFreq: document.getElementById('sens-cfg-at-freq'),
    sensSection: document.getElementById('sens-section'),
    sensFreq: document.getElementById('sens-freq'),
    runSensBtn: document.getElementById('run-sens-btn'),
    sensError: document.getElementById('sens-error'),
    sensResultsContainer: document.getElementById('sens-results-container'),
    sensResultsList: document.getElementById('sens-results-list'),
    sensNotes: document.getElementById('sens-notes'),

    // Driving-point impedance (a separate, one-off measurement from H(s))
    impedanceNode: document.getElementById('impedance-node'),
    computeImpedanceBtn: document.getElementById('compute-impedance-btn'),
    impedanceResult: document.getElementById('impedance-result'),
    impedanceLatex: document.getElementById('impedance-latex'),
    impedanceError: document.getElementById('impedance-error')
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

// The Cancel button is the only stop the engine needs. A long solve does not
// freeze anything -- it runs in the worker while the page stays live -- so
// there is no automatic time limit: if the user decides a computation is
// taking too long, they press Cancel. (There is no way to interrupt Pyodide
// mid-computation anyway; Cancel terminates and respawns the worker, which is
// exactly what this does.) Fast structural guards in the engine still reject a
// genuinely explosive symbolic solve in well under a second and route it to
// numeric mode -- that is prediction, not a timeout, so it stays.
els.engineCancelBtn?.addEventListener('click', () => {
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
    // Full screen hides the entire right pane (CSS), Bode/Nyquist plots
    // included. Any auto-plot that fired while it was hidden drew into a
    // 0x0 container, so exiting needs a fresh plot now that it is visible
    // again -- otherwise the graph comes back blank or stuck on stale data.
    if (!on) schedulePlot();
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

// Whether the injected virtual source drives the chosen node with a voltage
// ('V', the default -- gain analysis) or a current ('I' -- transimpedance;
// and, when the output node is the SAME node, the driving-point impedance
// Z(s) there, since this tool never has a second independent source to kill).
let inputKind = 'V';
document.querySelectorAll('input[name="input-kind"]').forEach(r =>
    r.addEventListener('change', () => {
        inputKind = document.querySelector('input[name="input-kind"]:checked').value;
        analyzeSchematic(true);
    })
);

// Extraction is the single authority on whether the circuit can be analysed,
// and this runs on every schematic edit -- so fixing whatever was wrong clears
// the error and re-enables Analyze immediately, with no re-analyse needed. That
// was the bug: the gate was only ever set true on failure and never recomputed,
// so a floating-node error stuck even after the node was wired up.
function updateNetlistPreview() {
    if (!window.Netlist || !window.Schematic) return;
    const res = window.Netlist.extract(window.Schematic.getModel(), {
        virtualInput: selectedVirtualInput(),
        virtualInputKind: inputKind
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

    runAnalysis({ kind: inputKind, name: inputName }, { node: outNode }, silent).catch(() => {});
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
    const prevImpedance = els.impedanceNode ? els.impedanceNode.value : null;

    els.inputSource.innerHTML = '';
    els.outputNode.innerHTML = '';
    if (els.impedanceNode) els.impedanceNode.innerHTML = '';

    // Options are node names only -- the label beside each dropdown already says
    // what the choice means (input voltage source / output voltage). Choosing an
    // input node injects the input voltage source there; "virtual" is an
    // implementation detail and stays out of the UI.
    (res.labels || []).forEach(lbl => {
        const inOpt = document.createElement('option');
        inOpt.value = lbl;
        inOpt.textContent = lbl;
        inOpt.dataset.kind = inputKind;
        inOpt.dataset.isVirtual = 'true';
        els.inputSource.appendChild(inOpt);

        const outOpt = document.createElement('option');
        outOpt.value = lbl;
        outOpt.textContent = lbl;
        els.outputNode.appendChild(outOpt);

        if (els.impedanceNode) {
            const zOpt = document.createElement('option');
            zOpt.value = lbl;
            zOpt.textContent = lbl;
            els.impedanceNode.appendChild(zOpt);
        }
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
    // Zout (the output node) is the more common ask than Zin, so default there.
    if (els.impedanceNode) {
        els.impedanceNode.value = has(els.impedanceNode, prevImpedance)
            ? prevImpedance
            : (prefer([/^v?out$/i]) ?? labels[labels.length - 1]);
    }
}

// Driving-point impedance at any node -- a separate, one-off measurement,
// deliberately NOT wired through the main Input Source/Output selection or
// currentTf/currentSubstitutedTf. Zin/Zout has a real definition: kill the
// circuit's own independent source (short it if it's a voltage source, open
// it if current -- the two are not interchangeable) and read V/I from a
// unit test current injected at the node in question. Reusing the "same
// node, current input" trick from the main analysis would force throwing
// away the real driven H(s) just to peek at an impedance; this keeps both on
// screen at once by building its own one-off circuit and calling solve()
// directly, leaving currentCircuitJson/currentTf untouched.
function setImpedanceError(msg) {
    els.impedanceError.textContent = msg;
    els.impedanceError.classList.remove('hidden');
    els.impedanceResult.classList.add('hidden');
}
function clearImpedanceError() {
    els.impedanceError.classList.add('hidden');
}

async function computeImpedance() {
    if (!currentCircuitJson || !currentCircuitJson.elements) {
        setImpedanceError('Analyze a circuit first.');
        return;
    }
    const probeNode = els.impedanceNode.value;
    const realInput = currentCircuitJson.input;
    if (!probeNode || !realInput || !realInput.name) {
        setImpedanceError('No input source to kill for this measurement.');
        return;
    }

    const elements = currentCircuitJson.elements.map(el => ({ ...el }));
    const idx = elements.findIndex(el => el.name === realInput.name);
    if (idx === -1) {
        setImpedanceError('Could not find the input source element.');
        return;
    }

    // Kill the real source: a voltage source becomes a short (0 V, branch
    // kept -- the correct way to zero a voltage source, since removing the
    // branch entirely would be an open, not a short); an independent current
    // source becomes an open (removed entirely -- it has no "0 A" stamp to
    // fall back to, per _build_mna's own "I" handling).
    const killed = elements[idx].type === 'V'
        ? elements.map((el, i) => i === idx ? { ...el, value: '0' } : el)
        : elements.filter((_, i) => i !== idx);
    killed.push({ name: '_Ztest', type: 'I', n1: probeNode, n2: '0', value: '1' });

    const circuit = {
        elements: killed,
        input: { kind: 'I', name: '_Ztest' },
        output: { kind: 'node_voltage', node: probeNode }
    };

    els.computeImpedanceBtn.disabled = true;
    try {
        const result = await Bridge.solveCircuit(circuit);
        if (!result.ok) {
            setImpedanceError('Impedance solve failed: ' + (result.errors || []).join('; '));
            return;
        }
        clearImpedanceError();
        els.impedanceResult.classList.remove('hidden');
        katex.render(`Z(s) = ${result.tf.latex}`, els.impedanceLatex,
            { displayMode: true, throwOnError: false });
    } catch (e) {
        setImpedanceError('UI Error: ' + e.message);
    } finally {
        els.computeImpedanceBtn.disabled = false;
    }
}
els.computeImpedanceBtn?.addEventListener('click', computeImpedance);

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

        // The Bode/Nyquist plots live in this tab and keep re-drawing (via
        // schedulePlot on every value edit) even while this tab is hidden --
        // Plotly measures a display:none container as 0x0, so a plot built
        // while the Approximation tab was showing comes back blank or stale
        // once the user switches back, with nothing left to trigger a
        // redraw. Re-plotting now, with the container visible again, is the
        // same fix already used for the Bode/Nyquist toggle above.
        if (tabId === 'workbench') schedulePlot();
    });
});

// Substitution is live: editing a value updates H(s) (and, when fully numeric,
// the plot) -- debounced so a mid-typed "1k" is not substituted as "1" first.
// There is no Apply button; the fields are the interface.
let subsLiveTimer = null;
let fixedLiveTimer = null;

// Persists typed substitution values by symbol name across table rebuilds,
// even through a rebuild where a symbol has no row at all (see
// populateSubstitutionTable). Only "Clear" resets it.
let subsValueCache = {};
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
    subsValueCache = {};
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

// Sensitivity
els.sensTarget?.addEventListener('change', (e) => {
    els.sensCfgStandard.classList.toggle('hidden', e.target.value !== 'standard_param');
    els.sensCfgAtFreq.classList.toggle('hidden', e.target.value !== 'at_freq');
});
els.runSensBtn?.addEventListener('click', handleSensitivity);

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
        // A user-requested Cancel already has its own, non-alarming status in
        // the engine chip ("Cancelled — restarting engine…"); surfacing the
        // same event here too, worded as "Analysis: Cancelled", reads like a
        // failure for something the user explicitly asked for.
        if (result.errors.length === 1 && result.errors[0] === 'Cancelled') {
            throw new Error("Cancelled");
        }
        // With no Analyze button there is no manual retry, so solve
        // failures always land in the persistent parse-error box
        // rather than being swallowed (silent) or modal (manual).
        setParseError(result.errors.map(m => "Analysis: " + m));
        throw new Error("Analysis failed");
    }

    hasAnalyzed = true;   // enables auto-refresh on later edits
    numericMode = false;  // a symbolic result supersedes any numeric-first state
    els.solveLongBtn?.classList.add('hidden');
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
    // A fresh solve resets the factored/flat and standard-form views to default.
    flatViewExpanded = false;
    flatCache = { key: null, tf: null };
    standardFormView = false;
    // A fresh solve invalidates any approximation chain built on the old H(s).
    approxChain = [];
    if (els.approxSteps) renderApproxChain();
    isFullyNumeric = (tf.symbols.length === 0);
    populateSubstitutionTable(tf.symbols);
    renderTf(tf);
    updatePlotTabState();
    updateApproxTabState();
    updateSensitivityTabState();

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
        'Too large for a quick fully symbolic result — enter component values below, ' +
        'or press "Solve harder" to attempt the full symbolic H(s). ' +
        'Any field left blank stays symbolic; the more you leave blank, the longer ' +
        'the solve can take (no time limit — press Cancel in the header to stop it).';
    els.resultContainer.classList.add('hidden');

    setParseError(errors.concat(
        ['Enter values below, or press "Solve harder" for the full symbolic H(s). ' +
         'Blank fields stay symbolic; a large symbolic solve can run a while — Cancel stops it.']));

    populateSubstitutionTable(symbols);
    els.subsPlaceholder.classList.add('hidden');
    els.subsContainer.classList.remove('hidden');
    els.solveLongBtn?.classList.remove('hidden');
    updatePlotTabState();
    updateApproxTabState();
    updateSensitivityTabState();

    // Values may already be filled (an edit re-analysed an already-numeric
    // circuit) -- solve straight away if so.
    maybeRunNumericSolve();
}

// The Solve harder button: same solve, engine effort 'long' -- much more
// generous structural guards and no element/symbol-count refusal, no time
// limit. Explicit user action only: the automatic per-keystroke attempts stay
// on the quick guards so editing never silently queues a heavy job. It can run
// a while; Cancel (in the header, shown while computing) stops it.
els.solveLongBtn?.addEventListener('click', async () => {
    const btn = els.solveLongBtn;
    const prev = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Solving… (Cancel in header)';
    try {
        await maybeRunNumericSolve('long');
    } finally {
        btn.disabled = false;
        btn.textContent = prev;
    }
});

// In numeric mode the value fields drive re-solves with options.values: the
// engine substitutes into the MNA and solves whatever stays symbolic. Not all
// fields are required -- any symbol left blank stays symbolic in H(s), which is
// how a 50-element filter can still be swept over a chosen handful of
// components. Debounced through the same live path as substitution, and guarded
// by the solve sequence so stale results never land. effort='long' (the Solve
// harder button) relaxes the engine's size guards and drops the symbol-count
// refusal entirely, with no time cap -- Cancel stops it.
async function maybeRunNumericSolve(effort = 'quick') {
    if (!numericMode || !currentCircuitJson) return;

    const values = {};
    document.querySelectorAll('.subs-val-input').forEach(inp => {
        const v = inp.value.trim();
        if (v !== '') values[inp.dataset.sym] = parseSIValue(v);
    });
    // With no values at all, a quick attempt is exactly the symbolic solve
    // that just failed -- skip. The Solve harder button may still try it.
    if (effort === 'quick' && Object.keys(values).length === 0) return;

    const options = { method: 'auto', values };
    if (effort === 'long') options.effort = 'long';
    const circuit = { ...currentCircuitJson, options };
    const seq = ++solveSeq;
    let result;
    try {
        result = await solveCircuitCached(circuit);
    } catch (e) {
        return;
    }
    if (seq !== solveSeq) return;
    if (!result.ok) {
        if (result.reason === 'too_large') {
            setSubsError((result.errors || []).join(' ') +
                (effort === 'quick'
                    ? ' — fill more fields, or press "Solve harder".'
                    : ''));
        } else {
            setSubsError((result.errors || ['Numeric solve failed.']).join('; '));
        }
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
    updateApproxTabState();
    updateSensitivityTabState();
}

// Draws a transfer function into the banner. Display only -- no state, no table
// rebuild -- so it is safe to call on every keystroke while editing values.
const _KIND_MAP = {
    'voltage_gain': 'Voltage Gain (V/V)',
    'current_gain': 'Current Gain (I/I)',
    'transimpedance': 'Transimpedance (V/I)',
    'admittance_transfer': 'Admittance Transfer (I/V)'
};

// A transimpedance result (current-source input, voltage output) where the
// input and output happen to be the SAME node is exactly the driving-point
// impedance Z(s) at that node -- same analysis, clearer label for the case
// the user actually asked for (pick one node, drive it with current, read
// its own voltage).
function kindLabel(kind) {
    if (kind === 'transimpedance' && inputKind === 'I' &&
        els.inputSource.value && els.inputSource.value === els.outputNode.value) {
        return 'Impedance Z(s) (Ω)';
    }
    return _KIND_MAP[kind] || 'Transfer Function';
}

// A decomposable cascade is shown FACTORED by default (a product of readable
// per-stage biquads). The user can expand it to the single flat H(s) when the
// engine says that is small enough (tf.flat_available); flatViewExpanded is that
// choice and flatCache holds the expansion for the currently displayed tf, keyed
// by its H_expr so a circuit edit invalidates it.
let flatViewExpanded = false;
let flatCache = { key: null, tf: null };

// The factored sections can be shown either as their component-value fractions
// (default) or in the analog standard form -- each section as its canonical
// first/second-order template with f0, Q and gain. standardFormView is that
// choice; the parameters ride along on each factor from the engine.
let standardFormView = false;

// Renders the factored sections in analog standard form: per section, its type,
// the canonical formula (omega_0/Q/K template), and the parameter values.
function renderStandardSections(factors) {
    els.latexOutput.innerHTML = '';
    factors.forEach((st, i) => {
        const std = st.standard;
        const block = document.createElement('div');
        block.className = 'std-section';

        const head = document.createElement('div');
        head.className = 'std-section-head';
        head.textContent = `Section ${i + 1}${std && std.type ? ' — ' + std.type : ''}`;
        block.appendChild(head);

        const formula = document.createElement('div');
        formula.className = 'std-section-formula';
        katex.render(`H_{${i + 1}}(s) = ${(std && std.formula_latex) || st.latex}`,
            formula, { displayMode: true, throwOnError: false });
        block.appendChild(formula);

        if (std && std.params && std.params.length) {
            const params = document.createElement('div');
            params.className = 'std-section-params';
            const pl = std.params.map(p => `${p.sym} = ${p.latex}`).join(',\\quad ');
            katex.render(pl, params, { displayMode: true, throwOnError: false });
            block.appendChild(params);
        }
        els.latexOutput.appendChild(block);
    });
}

function renderTf(tf) {
    els.resultPlaceholder.classList.add('hidden');
    els.resultContainer.classList.remove('hidden');

    // If the user asked to see the flat form and we have expanded THIS tf, show
    // the expansion; otherwise show tf as-is (factored or plain flat).
    const canFlat = !!(tf.factored && tf.flat_available);
    const showingFlat = canFlat && flatViewExpanded
        && flatCache.key === tf.H_expr && flatCache.tf;
    const disp = showingFlat ? flatCache.tf : tf;
    const factoredView = !!disp.factored;

    // Expand/collapse control: only for a factored tf whose flat form is small
    // enough to be worth forming.
    if (els.toggleFlatBtn) {
        els.toggleFlatBtn.classList.toggle('hidden', !canFlat);
        els.toggleFlatBtn.textContent = showingFlat
            ? 'Show factored sections' : 'Expand to flat H(s)';
    }
    // Standard-form control: only when factored sections are on screen.
    if (els.toggleStdBtn) {
        els.toggleStdBtn.classList.toggle('hidden', !factoredView);
        els.toggleStdBtn.textContent = standardFormView
            ? 'Component form' : 'Standard form (f₀, Q)';
    }

    els.tfKindLabel.textContent = kindLabel(disp.kind)
        + (factoredView ? ` — factored, ${disp.factors.length} stages` : '');
    els.numDegreeBadge.textContent = `Num Deg: ${disp.num_degree}`;
    els.denDegreeBadge.textContent = `Den Deg: ${disp.den_degree}`;

    // A factored H(s) renders as its stacked stages -- either the component-value
    // fractions or, in standard-form view, each section's canonical f0/Q form. A
    // flat H(s) renders as the single fraction.
    if (factoredView && standardFormView) {
        renderStandardSections(disp.factors);
    } else if (factoredView) {
        const stages = disp.factors.map((st, i) =>
            `H_{${i + 1}}(s) &= ${st.latex}`).join(' \\\\[4pt] ');
        katex.render(`\\begin{aligned} ${stages} \\end{aligned}`, els.latexOutput, {
            displayMode: true, throwOnError: false
        });
    } else {
        katex.render(`H(s) = ${disp.latex}`, els.latexOutput, {
            displayMode: true, throwOnError: false
        });
    }

    renderCoeffsList(els.numCoeffsList, disp.num_coeffs, disp.num_degree);
    renderCoeffsList(els.denCoeffsList, disp.den_coeffs, disp.den_degree);

    // Poles & Zeros track H(s) -- only while the panel is open, so a substitution
    // keystroke does not pay for rooting when nobody is looking. Always root the
    // factored form when there is one: each stage is degree <= 2 (closed-form
    // roots), where the flat polynomial of a deep cascade has none.
    if (pzVisible) renderPolesZeros(tf.factored ? tf : disp);
}

// Expand a factored cascade to its flat H(s) (and back). The expansion is a
// worker round-trip the first time for a given tf, then cached.
els.toggleFlatBtn?.addEventListener('click', async () => {
    const tf = currentSubstitutedTf;
    if (!tf || !tf.factored || !tf.flat_available) return;
    flatViewExpanded = !flatViewExpanded;
    if (flatViewExpanded && flatCache.key !== tf.H_expr) {
        els.toggleFlatBtn.disabled = true;
        els.toggleFlatBtn.textContent = 'Expanding…';
        try {
            const r = await Bridge.flatten(tf);
            if (r.ok) {
                flatCache = { key: tf.H_expr, tf: r.tf };
            } else {
                showGlobalError((r.errors || ['Could not expand to flat form.']).join(' '));
                flatViewExpanded = false;
            }
        } finally {
            els.toggleFlatBtn.disabled = false;
        }
    }
    // Re-render whatever is current (a value edit may have moved it on).
    if (currentSubstitutedTf) renderTf(currentSubstitutedTf);
});

// Toggle the factored sections between component-value fractions and the analog
// standard form. No worker round-trip -- the parameters are already on the tf.
els.toggleStdBtn?.addEventListener('click', () => {
    standardFormView = !standardFormView;
    if (currentSubstitutedTf) renderTf(currentSubstitutedTf);
});

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

    // A factored H(s) has no flat coefficient lists to root, but the poles and
    // zeros of a product are just the union of each stage's -- and every stage
    // is small. Root each stage and concatenate, so the panel still works on a
    // deep symbolic cascade (the flat solve could never reach it).
    if (tf.factored) {
        const zeros = [], poles = [];
        const notes = [];
        for (let i = 0; i < tf.factors.length; i++) {
            const r = await Bridge.polesZeros(tf.factors[i]);
            if (!r.ok) { notes.push(`Stage ${i + 1}: ${(r.errors || []).join(' ')}`); continue; }
            zeros.push(...r.zeros);
            poles.push(...r.poles);
            (r.notes || []).forEach(n => notes.push(`Stage ${i + 1}: ${n}`));
        }
        renderRootList(target.zerosList, zeros);
        renderRootList(target.polesList, poles);
        target.zerosCount.textContent = zeros.length ? `(${zeros.length})` : '';
        target.polesCount.textContent = poles.length ? `(${poles.length})` : '';
        target.notes.classList.toggle('hidden', notes.length === 0);
        target.notes.textContent = notes.join(' ');
        return;
    }

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

    // A factored H(s) never forms its flat coefficient lists (that expansion is
    // exactly what the factored form avoids). Say so instead of crashing on null.
    if (!coeffsStrArray) {
        const note = document.createElement('div');
        note.className = 'coeff-item';
        note.style.color = 'var(--text-secondary)';
        note.textContent = 'Factored form — flat coefficients not expanded. '
            + 'Enter component values to get the numeric coefficients.';
        container.appendChild(note);
        return;
    }

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
    // Match number part and an optional suffix -- but ONLY one of the
    // recognized SI prefixes. This used to accept ANY trailing letters
    // ([a-zA-Z]*), so a unit written the way a datasheet or schematic would
    // ("4.7uF", "10kOhm", "1MEG") matched with an unrecognized suffix, and
    // that suffix was then silently ignored (no multiplier applies to
    // "uF"), returning the UNSCALED number with no warning -- "4.7uF" quietly
    // became 4.7, six orders of magnitude off, for anyone who included the
    // unit the way it is normally written. Restricting the suffix
    // alternation to known prefixes means anything else falls through to the
    // "pass raw to sympy" branch below, which surfaces as a visible parse
    // error instead of a wrong, silent value.
    const match = str.match(/^([-+]?[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?)(T|G|Meg|M|k|m|u|μ|n|p|f)?$/);
    if (!match) return str; // Pass raw to sympy if parsing fails

    let val = parseFloat(match[1]);
    const suffix = match[2];

    const multipliers = {
        'T': 1e12, 'G': 1e9, 'M': 1e6, 'Meg': 1e6, 'k': 1e3,
        'm': 1e-3, 'u': 1e-6, 'μ': 1e-6, 'n': 1e-9, 'p': 1e-12, 'f': 1e-15
    };

    if (suffix) {
        val *= multipliers[suffix];
    }

    return val.toString();
}

// Component-name order: R2 before R10. The engine sorts symbols
// lexicographically (R1, R10, R11, ..., R2, ...), which is unreadable as soon
// as a circuit has ten parts of one kind; numeric-aware compare fixes the
// display without touching the engine's JSON contract.
const natCompare = (a, b) =>
    String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

function populateSubstitutionTable(symbols) {
    els.subsPlaceholder.classList.add('hidden');
    els.subsContainer.classList.remove('hidden');

    // Keep whatever the user already typed: a re-analysis (including the silent
    // auto-refresh after an edit) rebuilds this table, and wiping the values
    // every time would make the numbers impossible to keep.
    //
    // Scraping only the currently-rendered rows into a LOCAL object was not
    // enough: a symbol that temporarily has no row (e.g. it drops out of the
    // transfer function entirely for a current-source input -- a component in
    // series with an ideal current source cannot affect a downstream reading,
    // by definition of a current source, so it correctly has nothing to
    // substitute) never gets its typed value carried anywhere, and switching
    // back loses it for good. subsValueCache is the persistent version: it
    // only ever gains entries here (merged from whatever is on screen right
    // before the rebuild), so a symbol's value survives however many rebuilds
    // happen while it happens not to be shown, and reappears the moment it is
    // relevant again. Only the "Clear" button resets it.
    els.subsTbody.querySelectorAll('.subs-val-input').forEach(inp => {
        if (inp.value.trim() !== '') subsValueCache[inp.dataset.sym] = inp.value;
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

    [...symbols].sort(natCompare).forEach(sym => {
        const tr = document.createElement('tr');
        const val = subsValueCache[sym] ? ` value="${escHtml(subsValueCache[sym])}"` : '';
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
        c.value && window.Netlist?.isNumericValue(c.value.trim()))
        .sort((a, b) => natCompare(a.name, b.name));
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

    // Keys must match engine.py's freq_response range_json exactly
    // (f_start/f_end/n_points) -- sending f_min/f_max/points meant every one
    // of these fields silently fell through to the engine's own defaults
    // (1 Hz .. 1 GHz, 200 points) regardless of what was typed here.
    const range = { f_start: f_min, f_end: f_max, n_points: Math.min(Math.max(points, 10), 1000) };
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

// Every linked plot shares one frequency axis, so zooming or panning any one
// of them must move the rest (2 for the compare plots, 3 for mag/phase/group
// delay). Plotly reports the change as a relayout event; mirror the new
// x-range (or an autorange reset) onto every other plot in the group. The
// flag stops the mirrored call from bouncing straight back.
function linkFrequencyZoom(...ids) {
    const nodes = ids.map(id => document.getElementById(id)).filter(Boolean);
    if (nodes.length < 2) return;
    let syncing = false;

    const mirror = (others) => (ev) => {
        if (syncing) return;
        let upd = null;
        if (ev['xaxis.range[0]'] !== undefined) {
            upd = { 'xaxis.range[0]': ev['xaxis.range[0]'], 'xaxis.range[1]': ev['xaxis.range[1]'] };
        } else if (ev['xaxis.autorange']) {
            upd = { 'xaxis.autorange': true };
        }
        if (!upd) return;
        syncing = true;
        Promise.all(others.map(n => Plotly.relayout(n, upd))).then(() => { syncing = false; });
    };

    nodes.forEach((node, i) => {
        const others = nodes.filter((_, j) => j !== i);
        node.on('plotly_relayout', mirror(others));
    });
}

// Hovering any linked plot puts the cursor (line + value chip) on ALL of them
// at the same sample and fills the shared readout. They all share the
// frequency array, so one point index addresses the same frequency
// everywhere. `readout(i)` -> HTML for the readout bar; `chips[k](i)` -> the
// chip text for the k-th plot (its own quantity: dB, degrees, seconds, ...).
function linkHoverReadout(ids, readoutEl, readout, freqs, chips) {
    const nodes = ids.map(id => document.getElementById(id)).filter(Boolean);
    if (nodes.length < 2) return;

    const show = (d) => {
        const i = d.points[0].pointIndex;
        if (readoutEl) readoutEl.innerHTML = readout(i);
        nodes.forEach((node, k) => moveCursor(node, freqs[i], chips[k](i)));
    };
    const hide = () => nodes.forEach(hideCursor);

    nodes.forEach(node => {
        node.on('plotly_hover', show);
        node.on('plotly_unhover', hide);
    });
}

const fmtHz = (f) => f >= 1e6 ? (f / 1e6).toPrecision(4) + ' MHz'
    : f >= 1e3 ? (f / 1e3).toPrecision(4) + ' kHz'
    : f.toPrecision(4) + ' Hz';

const fmtSeconds = (t) => {
    const a = Math.abs(t);
    if (a === 0) return '0 s';
    if (a >= 1) return t.toPrecision(4) + ' s';
    if (a >= 1e-3) return (t * 1e3).toPrecision(4) + ' ms';
    if (a >= 1e-6) return (t * 1e6).toPrecision(4) + ' µs';
    return (t * 1e9).toPrecision(4) + ' ns';
};

// Group delay: tau_g = -dphi/domega. phase_deg is already unwrapped by the
// engine (no phase-jump artifacts to guard against), and degrees are
// dimensionless, so deg/Hz is already seconds; dividing by 360 converts
// degrees to cycles, and cycles per Hz is exactly seconds. A central
// difference over the (non-uniform, log-spaced) frequency array; the two
// endpoints fall back to a one-sided difference.
function groupDelay(f, phaseDeg) {
    const n = f.length;
    const tau = new Array(n);
    for (let i = 0; i < n; i++) {
        const lo = i > 0 ? i - 1 : i;
        const hi = i < n - 1 ? i + 1 : i;
        tau[i] = lo === hi ? 0 : -(phaseDeg[hi] - phaseDeg[lo]) / (360 * (f[hi] - f[lo]));
    }
    return tau;
}

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

    const tau = groupDelay(data.f, data.phase_deg);
    Plotly.newPlot('bode-delay-plot', [{
        x: data.f, y: tau, type: 'scatter', mode: 'lines',
        line: { color: '#f59e0b', width: 2 }, name: 'Group delay', hoverinfo: 'none'
    }], {
        ...PLOT_BASE_LAYOUT, title: 'Group Delay', hovermode: 'x',
        xaxis: freqAxis('Frequency (Hz)'), yaxis: valueAxis('Delay (s)')
    }, PLOT_CONFIG);

    linkFrequencyZoom('bode-mag-plot', 'bode-phase-plot', 'bode-delay-plot');
    linkHoverReadout(['bode-mag-plot', 'bode-phase-plot', 'bode-delay-plot'], els.bodeReadout, (i) =>
        `<b>f</b> ${fmtHz(data.f[i])}` +
        ` &nbsp; <b>Gain</b> ${data.mag_db[i].toFixed(2)} dB` +
        ` &nbsp; <b>Phase</b> ${data.phase_deg[i].toFixed(2)}°` +
        ` &nbsp; <b>Delay</b> ${fmtSeconds(tau[i])}`,
    data.f,
    [(i) => `${fmtHz(data.f[i])}  ${data.mag_db[i].toFixed(2)} dB`,
     (i) => `${fmtHz(data.f[i])}  ${data.phase_deg[i].toFixed(2)}°`,
     (i) => `${fmtHz(data.f[i])}  ${fmtSeconds(tau[i])}`]);

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
    // Approximation works on the flat H(s). A plain flat result always qualifies;
    // a factored cascade qualifies when its flat form is small enough to form
    // (flat_available) -- the engine flattens it internally. Only a deep cascade
    // whose flat form would explode is disabled (enter values for a numeric H,
    // or expand a shallower one).
    const canApprox = currentTf && (!currentTf.factored || currentTf.flat_available);
    if (canApprox) {
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

// The display label for a step, derived purely from its spec -- no DOM
// reads. Shared by buildApproxSpec (a step just entered on the form) and by
// replaying a chain restored from an imported session, so the two paths
// cannot describe the same spec two different ways.
function specLabel(spec) {
    if (spec.mode === 'limit') {
        return spec.direction === 'dc' ? 'Limit s → 0' : 'Limit s → ∞';
    }
    if (spec.mode === 'truncate') {
        return `Truncate: num ≤ s^${spec.max_num_order}, den ≤ s^${spec.max_den_order}`;
    }
    if (spec.mode === 'assumption') {
        return 'Assume ' + spec.assumptions.join(', ');
    }
    if (spec.mode === 'numerical') {
        return `Numerical (threshold ${spec.threshold})`;
    }
    return spec.mode;
}

function buildApproxSpec() {
    const mode = els.approxMode.value;
    const spec = { mode };

    if (mode === 'limit') {
        spec.direction = document.querySelector('input[name="limit_dir"]:checked').value;
    } else if (mode === 'truncate') {
        spec.max_num_order = parseInt(els.truncNum.value);
        spec.max_den_order = parseInt(els.truncDen.value);
    } else if (mode === 'assumption') {
        const val = els.assumeInput.value.trim();
        spec.assumptions = val ? val.split(',').map(t => t.trim()) : [];
        if (!spec.assumptions.length) {
            showGlobalError('Enter at least one assumption, e.g. "gm*ro >> 1".');
            return null;
        }
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
    }
    return { spec, label: specLabel(spec) };
}

// Runs one approximation step against wherever the chain currently stands
// and, on success, pushes it. The spec is kept on the pushed entry (not just
// the resulting tf) so the chain can be serialized as "what the user asked
// for" and replayed -- see replayApproxChain -- rather than trusting a
// resulting H(s) baked into a session file.
async function runApproxStep(spec, label) {
    const base = approxChain.length ? approxChain[approxChain.length - 1].tf : currentTf;
    const result = await Bridge.approximate(base, spec);
    if (result.ok) {
        approxChain.push({
            label,
            spec,
            tf: result.tf_approx,
            dropped: result.dropped_terms || []
        });
    }
    return result;
}

async function handleApproximation() {
    if (!currentTf) return;
    const built = buildApproxSpec();
    if (!built) return;

    els.runApproxBtn.disabled = true;
    els.runApproxBtn.querySelector('.btn-spinner').classList.remove('hidden');

    try {
        const result = await runApproxStep(built.spec, built.label);
        if (!result.ok) {
            showGlobalError("Approximation Error:\n" + result.errors.join("\n"));
        } else {
            renderApproxChain();
        }
    } catch (e) {
        showGlobalError("UI Error: " + e.message);
    } finally {
        els.runApproxBtn.disabled = false;
        els.runApproxBtn.querySelector('.btn-spinner').classList.add('hidden');
    }
}

// Rebuilds the chain from a saved list of specs (an imported session), one
// engine round trip per step, exactly as if the user had clicked "Apply"
// that many times. Only the specs are trusted from the file; every tf and
// dropped-term list is regenerated here, never read from the file itself.
async function replayApproxChain(specs) {
    approxChain = [];
    for (const spec of specs) {
        const result = await runApproxStep(spec, specLabel(spec));
        if (!result.ok) {
            showGlobalError("Could not replay a saved approximation step: " +
                (result.errors || []).join('; '));
            break;
        }
    }
    renderApproxChain();
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
            // band the user is actually looking at. Keys must match
            // engine.py's freq_response (f_start/f_end/n_points), same fix
            // as handlePlotting's range object.
            const range = {
                f_start: parseFloat(parseSIValue(els.plotFmin.value)) || 1,
                f_end: parseFloat(parseSIValue(els.plotFmax.value)) || 1e6,
                n_points: parseInt(els.plotPoints.value) || 200
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
            linkHoverReadout(['compare-mag-plot', 'compare-phase-plot'], els.compareReadout, (i) =>
                `<b>f</b> ${fmtHz(orig.f[i])}` +
                ` &nbsp; <b>Gain</b> ${orig.mag_db[i].toFixed(2)}/${approx.mag_db[i].toFixed(2)} dB` +
                ` &nbsp; <b>Phase</b> ${orig.phase_deg[i].toFixed(2)}/${approx.phase_deg[i].toFixed(2)}°`,
            orig.f,
            [(i) => `${fmtHz(orig.f[i])}  ${orig.mag_db[i].toFixed(2)} / ${approx.mag_db[i].toFixed(2)} dB`,
             (i) => `${fmtHz(orig.f[i])}  ${orig.phase_deg[i].toFixed(2)} / ${approx.phase_deg[i].toFixed(2)}°`]);

        } catch (e) {
            showGlobalError("UI Plot Error: " + e.message);
        } finally {
            els.comparePlotBtn.disabled = false;
            els.comparePlotBtn.textContent = "Compare Bode Plots";
        }
    })();
}

// --- Sensitivity Logic ---

function updateSensitivityTabState() {
    if (currentTf) {
        els.sensWarning?.classList.add('hidden');
        els.sensConfigContainer?.classList.remove('hidden');
        populateSensSections();
    } else {
        els.sensWarning?.classList.remove('hidden');
        els.sensConfigContainer?.classList.add('hidden');
    }
}

// Always reads currentTf (never currentSubstitutedTf): substitute() -- even
// a single symbol's worth -- always returns a flat tf with no "factors" at
// all, AND bakes whatever was substituted straight into H_expr as literal
// numbers, which would silently drop that symbol from sensitivity's own
// results (it can only report on the symbols it can still see). currentTf is
// the untouched, always-fully-symbolic ground truth every substitution
// applies to -- exactly what a numeric evaluation-at-nominal-values needs to
// stay eligible for every one of its own free symbols.
//
// The section picker offers the factored cascade's stages, or -- when the
// current H(s) is not a cascade -- the whole thing as a single section: most
// circuits are one stage, and a plain 1st/2nd-order filter is just as
// eligible for f0/Q sensitivity as one stage of a larger cascade (a section
// past 2nd order surfaces the engine's own error on Compute, same as any
// other invalid input here).
function populateSensSections() {
    if (!els.sensSection) return;
    const tf = currentTf;
    els.sensSection.innerHTML = '';
    if (!tf) return;
    const sections = tf.factored ? tf.factors : [tf];
    sections.forEach((st, i) => {
        const opt = document.createElement('option');
        opt.value = String(i);
        opt.textContent = tf.factored
            ? `Section ${i + 1}${st.standard && st.standard.type ? ' — ' + st.standard.type : ''}`
            : 'Whole H(s)';
        els.sensSection.appendChild(opt);
    });
}

function setSensError(msg) {
    els.sensError.textContent = msg;
    els.sensError.classList.remove('hidden');
}
function clearSensError() {
    els.sensError.classList.add('hidden');
}

async function handleSensitivity() {
    const tf = currentTf;   // always the fully-symbolic ground truth; see populateSensSections
    if (!tf) return;

    // Every symbol needs a nominal value -- the same "fill in the Values
    // tab" requirement the numerical approximation mode already uses.
    const values = {};
    let missing = false;
    document.querySelectorAll('.subs-val-input').forEach(input => {
        const v = parseSIValue(input.value);
        if (!v) missing = true;
        else values[input.dataset.sym] = parseFloat(v);
    });
    if (missing || Object.keys(values).length === 0) {
        setSensError("Sensitivity needs a value for every symbol in the Values tab.");
        return;
    }

    let sensTf, target;
    if (els.sensTarget.value === 'standard_param') {
        const sections = tf.factored ? tf.factors : [tf];
        const section = sections[parseInt(els.sensSection.value)];
        if (!section) { setSensError("No section selected."); return; }
        sensTf = { num_coeffs: section.num_coeffs, den_coeffs: section.den_coeffs };
        target = { kind: 'standard_param',
            param: document.querySelector('input[name="sens-param"]:checked').value };
    } else {
        const f_hz = parseFloat(parseSIValue(els.sensFreq.value));
        if (isNaN(f_hz) || f_hz < 0) { setSensError("Enter a valid frequency (Hz, 0 = DC)."); return; }
        sensTf = tf;   // needs H_expr, present on both factored and flat tf
        target = { kind: 'at_freq', f_hz,
            quantity: document.querySelector('input[name="sens-quantity"]:checked').value };
    }

    els.runSensBtn.disabled = true;
    els.runSensBtn.querySelector('.btn-spinner').classList.remove('hidden');
    try {
        const result = await Bridge.sensitivity(sensTf, target, values);
        if (!result.ok) {
            setSensError((result.errors || ['Sensitivity failed.']).join('; '));
            return;
        }
        clearSensError();
        renderSensResults(result.results, result.notes || []);
    } catch (e) {
        setSensError('UI Error: ' + e.message);
    } finally {
        els.runSensBtn.disabled = false;
        els.runSensBtn.querySelector('.btn-spinner').classList.add('hidden');
    }
}

// Reuses the coeff-list item styling (symbol + value pair) already used for
// the H(s) coefficient lists -- a sensitivity table is the same shape of
// data: a component name against a number.
function renderSensResults(results, notes) {
    els.sensResultsContainer.classList.remove('hidden');
    els.sensResultsList.innerHTML = '';
    if (!results.length) {
        const note = document.createElement('div');
        note.className = 'coeff-item';
        note.style.color = 'var(--text-secondary)';
        note.textContent = 'No sensitivities to show (see notes below).';
        els.sensResultsList.appendChild(note);
    } else {
        results.forEach(r => {
            const item = document.createElement('div');
            item.className = 'coeff-item';
            const sym = document.createElement('div');
            sym.className = 'coeff-power';
            sym.textContent = r.symbol;
            const val = document.createElement('div');
            val.className = 'coeff-expr';
            val.textContent = `${r.sensitivity.toPrecision(4)}  (${r.unit})`;
            item.appendChild(sym);
            item.appendChild(val);
            els.sensResultsList.appendChild(item);
        });
    }
    els.sensNotes.classList.toggle('hidden', notes.length === 0);
    els.sensNotes.textContent = notes.join(' ');
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
    
    // 2. Approximation Config (the form fields for the NEXT step to build)
    const approxConfig = {
        mode: els.approxMode.value,
        limit_dir: document.querySelector('input[name="limit_dir"]:checked').value,
        trunc_num: els.truncNum.value,
        trunc_den: els.truncDen.value,
        assumptions: els.assumeInput.value,
        num_thresh: els.numThresh.value
    };

    const sessionData = {
        version: "1.2",
        // v1.0 saved only the netlist text, so anyone who drew a circuit and
        // round-tripped through Export/Import lost the drawing -- the schematic
        // is the tool's primary input, which made this worse than no feature.
        schematic,
        netlist: els.netlistInput.value,
        input: currentCircuitJson?.input || null,
        output: currentCircuitJson?.output || null,
        substitution: subsMap,
        approximation: approxConfig,
        // v1.2: the steps actually APPLIED (not just the form fields for the
        // next one). Only the specs -- what the user asked for -- are saved;
        // each step's resulting H(s) and dropped-term list are recomputed on
        // import (see replayApproxChain), never trusted from the file.
        approxChain: approxChain.map(step => step.spec),
        // v1.2: plot range/type and the view toggles are all things the user
        // set by hand, not calculation results, so they round-trip too. The
        // flat/standard-form expansions and poles & zeros themselves are not
        // saved -- only whether to re-show them -- since those regenerate
        // from the restored H(s) on demand.
        plot: {
            f_min: els.plotFmin.value,
            f_max: els.plotFmax.value,
            points: els.plotPoints.value,
            type: els.plotType.value
        },
        view: {
            standardForm: standardFormView,
            flatExpanded: flatViewExpanded,
            polesZerosVisible: pzVisible
        }
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

            // 4. Restore Approximation form fields (the next step to build)
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

            // 5. Replay the approximation steps that were actually applied.
            if (data.approxChain && data.approxChain.length && currentTf) {
                await replayApproxChain(data.approxChain);
            }

            // 6. Plot range/type -- dispatching 'change' both applies the
            // bode/nyquist visibility and re-plots with the restored range.
            if (data.plot) {
                if (data.plot.f_min != null) els.plotFmin.value = data.plot.f_min;
                if (data.plot.f_max != null) els.plotFmax.value = data.plot.f_max;
                if (data.plot.points != null) els.plotPoints.value = data.plot.points;
                if (data.plot.type) els.plotType.value = data.plot.type;
                els.plotType.dispatchEvent(new Event('change'));
            }

            // 7. View toggles: which form the factored/flat H(s) and the
            // poles & zeros panel are shown in. The underlying expansions
            // are recomputed here (renderTf / renderPolesZeros), not read
            // from the file.
            if (data.view) {
                standardFormView = !!data.view.standardForm;
                if (currentSubstitutedTf) renderTf(currentSubstitutedTf);

                if (data.view.flatExpanded && currentSubstitutedTf?.factored &&
                    currentSubstitutedTf.flat_available && !flatViewExpanded) {
                    els.toggleFlatBtn?.click();
                }

                pzVisible = !!data.view.polesZerosVisible;
                els.pzContainer.classList.toggle('hidden', !pzVisible);
                els.togglePzBtn.textContent = pzVisible ? "Hide Poles & Zeros" : "View Poles & Zeros";
                if (pzVisible) renderPolesZeros(currentSubstitutedTf);
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
