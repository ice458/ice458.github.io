'use strict';

// ============================================================
//  State
// ============================================================
const state = {
    srcType: 'V',
    timeScale: 1e-6,      // seconds per display unit
    valScale: 1e-3,       // SI per display unit
    timeUnitLabel: 'µs',
    valUnitLabel: 'mV',
    points: [[0, 0], [5e-6, 0]],  // SI base: [seconds, V or A]
    selectedIndices: new Set(),
    view: { xMin: 0, xMax: 10, yMin: -5, yMax: 5 },  // display units
    snap: { enabled: true, t: 1, v: 1 },             // display units
    minDtDisplay: 1e-3,   // minimum time separation in display units
};

// ============================================================
//  Unit maps
// ============================================================
const TIME_UNITS = {
    '1e-15': 'fs', '1e-12': 'ps', '1e-9': 'ns',
    '1e-6': 'µs', '1e-3': 'ms', '1': 's',
};
const VAL_UNITS_V = { '1e-6': 'µV', '1e-3': 'mV', '1': 'V', '1e3': 'kV' };
const VAL_UNITS_I = { '1e-12': 'pA', '1e-9': 'nA', '1e-6': 'µA', '1e-3': 'mA', '1': 'A' };

// ============================================================
//  DOM refs
// ============================================================
const canvas    = document.getElementById('plot');
const ctx       = canvas.getContext('2d');
const wrap      = document.getElementById('canvasWrap');
const pwlOutput = document.getElementById('pwlOutput');
const statusMsg = document.getElementById('statusMsg');
const cursorCoord = document.getElementById('cursorCoord');
const pointList   = document.getElementById('pointList');
const pointEditor = document.getElementById('pointEditor');
const editT = document.getElementById('editT');
const editV = document.getElementById('editV');
const xMinI = document.getElementById('xMin');
const xMaxI = document.getElementById('xMax');
const yMinI = document.getElementById('yMin');
const yMaxI = document.getElementById('yMax');

// ============================================================
//  Coordinate helpers
// ============================================================
function toDisplay(tSI, vSI) {
    return [tSI / state.timeScale, vSI / state.valScale];
}
function toSI(tD, vD) {
    return [tD * state.timeScale, vD * state.valScale];
}

function plotPad() { return { l: 72, r: 20, t: 20, b: 44 }; }

function px2disp(px, py) {
    const { xMin, xMax, yMin, yMax } = state.view;
    const W = canvas.width, H = canvas.height;
    const pad = plotPad();
    const x = xMin + (px - pad.l) / (W - pad.l - pad.r) * (xMax - xMin);
    const y = yMax - (py - pad.t) / (H - pad.t - pad.b) * (yMax - yMin);
    return [x, y];
}
function disp2px(dx, dy) {
    const { xMin, xMax, yMin, yMax } = state.view;
    const W = canvas.width, H = canvas.height;
    const pad = plotPad();
    const px = pad.l + (dx - xMin) / (xMax - xMin) * (W - pad.l - pad.r);
    const py = pad.t + (yMax - dy) / (yMax - yMin) * (H - pad.t - pad.b);
    return [px, py];
}

// ============================================================
//  Minimum time separation (SI seconds)
//  Converts the user-facing display value to SI, floored at 1e-15.
// ============================================================
function minDt() {
    return Math.max(1e-15, state.minDtDisplay * state.timeScale);
}

// ============================================================
//  Snap helper
// ============================================================
function snapDisp(td, vd) {
    if (!state.snap.enabled) return [td, vd];
    const st = state.snap.t, sv = state.snap.v;
    if (st <= 0 || sv <= 0) return [td, vd];
    return [Math.round(td / st) * st, Math.round(vd / sv) * sv];
}

// ============================================================
//  Point helpers
// ============================================================
function sortPoints() {
    state.points.sort((a, b) => a[0] - b[0]);
}

// Nudge tSI forward until it is at least minDt() away from all
// existing points (optionally excluding one index).
function resolveTime(tSI, excludeIdx = null) {
    const dt = minDt();
    const others = state.points
        .filter((_, i) => i !== excludeIdx)
        .map(p => p[0]);
    // iterate up to a safe limit to avoid an infinite loop
    for (let iter = 0; iter < 10000; iter++) {
        const clash = others.find(t => Math.abs(t - tSI) < dt);
        if (clash === undefined) break;
        tSI = clash + dt;  // step just past the occupied slot
    }
    return tSI;
}

function addPointSI(tSI, vSI) {
    tSI = Math.max(0, tSI);
    tSI = resolveTime(tSI);
    state.points.push([tSI, vSI]);
    sortPoints();
    return state.points.findIndex(p => Math.abs(p[0] - tSI) < minDt() * 0.1);
}

function deleteSelected() {
    if (state.selectedIndices.size === 0) return;
    if (state.points.length - state.selectedIndices.size < 2) { setStatus('最低2点必要です'); return; }
    const toDelete = Array.from(state.selectedIndices).sort((a, b) => b - a);
    toDelete.forEach(idx => state.points.splice(idx, 1));
    state.selectedIndices.clear();
    refreshAll();
}

// ============================================================
//  Drawing
// ============================================================
function resizeCanvas() {
    canvas.width  = wrap.clientWidth;
    canvas.height = wrap.clientHeight;
}

const COLORS = {
    line: '#2196f3', point: '#2196f3', sel: '#e53935',
    grid: '#e0e0e0', gridSnap: '#bdbdbd', axis: '#666', label: '#444',
};

function draw() {
    resizeCanvas();
    const W = canvas.width, H = canvas.height;
    const pad = plotPad();
    const { xMin, xMax, yMin, yMax } = state.view;
    ctx.clearRect(0, 0, W, H);

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b);
    ctx.clip();

    ctx.fillStyle = '#fff';
    ctx.fillRect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b);

    drawGrid(pad, xMin, xMax, yMin, yMax, W, H);
    if (state.snap.enabled) drawSnapGrid(pad, xMin, xMax, yMin, yMax, W, H);

    if (state.points.length >= 2) {
        ctx.beginPath();
        ctx.strokeStyle = COLORS.line;
        ctx.lineWidth = 2;
        state.points.forEach(([tSI, vSI], i) => {
            const [px, py] = disp2px(...toDisplay(tSI, vSI));
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
        ctx.stroke();
    }

    state.points.forEach(([tSI, vSI], i) => {
        const [dx, dy] = toDisplay(tSI, vSI);
        const [px, py] = disp2px(dx, dy);
        let sel = state.selectedIndices.has(i);
        if (boxSelecting && boxStart && boxCurrent) {
            const minX = Math.min(boxStart[0], boxCurrent[0]);
            const maxX = Math.max(boxStart[0], boxCurrent[0]);
            const minY = Math.min(boxStart[1], boxCurrent[1]);
            const maxY = Math.max(boxStart[1], boxCurrent[1]);
            if (px >= minX && px <= maxX && py >= minY && py <= maxY) sel = true;
        }
        ctx.beginPath();
        ctx.arc(px, py, sel ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = sel ? COLORS.sel : COLORS.point;
        ctx.fill();
        if (sel) {
            ctx.strokeStyle = '#b71c1c';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        ctx.fillStyle = COLORS.label;
        ctx.font = '10px Consolas, monospace';
        ctx.fillText(`(${fmtNum(dx)}, ${fmtNum(dy)})`, px + 8, py - 4);
    });

    if (boxSelecting && boxStart && boxCurrent) {
        ctx.fillStyle = 'rgba(33, 150, 243, 0.15)';
        ctx.strokeStyle = 'rgba(33, 150, 243, 0.6)';
        ctx.lineWidth = 1;
        const bx = Math.min(boxStart[0], boxCurrent[0]);
        const by = Math.min(boxStart[1], boxCurrent[1]);
        const bw = Math.abs(boxStart[0] - boxCurrent[0]);
        const bh = Math.abs(boxStart[1] - boxCurrent[1]);
        ctx.fillRect(bx, by, bw, bh);
        ctx.strokeRect(bx, by, bw, bh);
    }

    ctx.restore();
    drawAxes(pad, xMin, xMax, yMin, yMax, W, H);
}

function niceStep(range, targetTicks = 8) {
    if (range <= 0 || !isFinite(range)) return 1;
    const raw = range / targetTicks;
    const exp = Math.floor(Math.log10(raw));
    const base = Math.pow(10, exp);
    const m = raw / base;
    const nice = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
    return nice * base;
}

function drawGrid(pad, xMin, xMax, yMin, yMax, W, H) {
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    const xStep = niceStep(xMax - xMin);
    const yStep = niceStep(yMax - yMin);
    for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax + xStep * 0.01; x += xStep) {
        const [px] = disp2px(x, 0);
        ctx.beginPath(); ctx.moveTo(px, pad.t); ctx.lineTo(px, H - pad.b); ctx.stroke();
    }
    for (let y = Math.ceil(yMin / yStep) * yStep; y <= yMax + yStep * 0.01; y += yStep) {
        const [, py] = disp2px(0, y);
        ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(W - pad.r, py); ctx.stroke();
    }
}

function drawSnapGrid(pad, xMin, xMax, yMin, yMax, W, H) {
    const st = state.snap.t, sv = state.snap.v;
    if (st <= 0 || sv <= 0) return;
    // Skip if grid is too dense to render usefully (avoids billions of iterations on unit change)
    if ((xMax - xMin) / st > 500 || (yMax - yMin) / sv > 500) return;
    ctx.strokeStyle = COLORS.gridSnap;
    ctx.lineWidth = 0.5;
    for (let x = Math.ceil(xMin / st) * st; x <= xMax + st * 0.01; x += st) {
        const [px] = disp2px(x, 0);
        ctx.beginPath(); ctx.moveTo(px, pad.t); ctx.lineTo(px, H - pad.b); ctx.stroke();
    }
    for (let y = Math.ceil(yMin / sv) * sv; y <= yMax + sv * 0.01; y += sv) {
        const [, py] = disp2px(0, y);
        ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(W - pad.r, py); ctx.stroke();
    }
}

function drawAxes(pad, xMin, xMax, yMin, yMax, W, H) {
    ctx.strokeStyle = COLORS.axis;
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b);

    ctx.fillStyle = COLORS.label;
    ctx.font = '11px Segoe UI, sans-serif';

    const xStep = niceStep(xMax - xMin);
    for (let x = Math.ceil(xMin / xStep) * xStep; x <= xMax + xStep * 0.01; x += xStep) {
        const [px] = disp2px(x, 0);
        ctx.beginPath(); ctx.moveTo(px, H - pad.b); ctx.lineTo(px, H - pad.b + 4); ctx.stroke();
        ctx.textAlign = 'center';
        ctx.fillText(fmtNum(x), px, H - pad.b + 16);
    }

    const yStep = niceStep(yMax - yMin);
    for (let y = Math.ceil(yMin / yStep) * yStep; y <= yMax + yStep * 0.01; y += yStep) {
        const [, py] = disp2px(0, y);
        ctx.beginPath(); ctx.moveTo(pad.l - 4, py); ctx.lineTo(pad.l, py); ctx.stroke();
        ctx.textAlign = 'right';
        ctx.fillText(fmtNum(y), pad.l - 7, py + 4);
    }

    ctx.fillStyle = '#333';
    ctx.font = '12px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Time (${state.timeUnitLabel})`, pad.l + (W - pad.l - pad.r) / 2, H - 2);
    ctx.save();
    ctx.translate(14, pad.t + (H - pad.t - pad.b) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(`${state.srcType === 'V' ? 'Voltage' : 'Current'} (${state.valUnitLabel})`, 0, 0);
    ctx.restore();

    ctx.strokeStyle = '#aaa';
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    if (xMin <= 0 && 0 <= xMax) {
        const [px] = disp2px(0, 0);
        ctx.beginPath(); ctx.moveTo(px, pad.t); ctx.lineTo(px, H - pad.b); ctx.stroke();
    }
    if (yMin <= 0 && 0 <= yMax) {
        const [, py] = disp2px(0, 0);
        ctx.beginPath(); ctx.moveTo(pad.l, py); ctx.lineTo(W - pad.r, py); ctx.stroke();
    }
    ctx.setLineDash([]);
}

function fmtNum(n) {
    if (n === 0) return '0';
    const abs = Math.abs(n);
    if (abs >= 1e4 || (abs < 1e-3 && abs > 0)) return n.toExponential(3);
    return parseFloat(n.toPrecision(4)).toString();
}

// ============================================================
//  PWL output
// ============================================================
function fmtSI(v) {
    if (v === 0) return '0';
    // toPrecision(15) uses full double precision; parseFloat+toString strips trailing zeros
    return parseFloat(v.toPrecision(15)).toString();
}

function generatePWL() {
    const sorted = [...state.points].sort((a, b) => a[0] - b[0]);
    const pairs = sorted.map(([t, v]) => `${fmtSI(t)} ${fmtSI(v)}`).join(' ');
    return `PWL(${pairs})`;
}

function updateOutput() {
    pwlOutput.value = generatePWL();
}

// ============================================================
//  Point list
// ============================================================
function updatePointList() {
    pointList.innerHTML = '';
    state.points.forEach(([tSI, vSI], i) => {
        const [td, vd] = toDisplay(tSI, vSI);
        const row = document.createElement('div');
        row.className = 'point-row' + (state.selectedIndices.has(i) ? ' selected' : '');

        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = state.selectedIndices.has(i);
        chk.style.marginRight = '8px';
        chk.addEventListener('click', e => e.stopPropagation());
        chk.addEventListener('change', e => {
            if (e.target.checked) state.selectedIndices.add(i);
            else state.selectedIndices.delete(i);
            refreshAll();
        });
        row.appendChild(chk);

        const lbl = document.createElement('span');
        lbl.textContent = `${fmtNum(td)} ${state.timeUnitLabel}, ${fmtNum(vd)} ${state.valUnitLabel}`;
        row.appendChild(lbl);

        const del = document.createElement('button');
        del.className = 'del-btn';
        del.textContent = '×';
        del.title = 'Delete';
        del.addEventListener('click', e => {
            e.stopPropagation();
            if (state.points.length <= 2) { setStatus('最低2点必要です'); return; }
            state.points.splice(i, 1);
            const newSel = new Set();
            for (let si of state.selectedIndices) {
                if (si < i) newSel.add(si);
                else if (si > i) newSel.add(si - 1);
            }
            state.selectedIndices = newSel;
            refreshAll();
        });
        row.appendChild(del);

        row.addEventListener('click', (e) => {
            if (e.ctrlKey || e.shiftKey) {
                if (state.selectedIndices.has(i)) state.selectedIndices.delete(i);
                else state.selectedIndices.add(i);
            } else {
                selectPoint(i);
            }
            refreshAll();
        });
        pointList.appendChild(row);
    });
}

// ============================================================
//  Selection & editor
// ============================================================
function selectPoint(idx) {
    state.selectedIndices.clear();
    if (idx !== null) state.selectedIndices.add(idx);
}

function updateEditorVisibility() {
    if (state.selectedIndices.size === 1) {
        const sIdx = Array.from(state.selectedIndices)[0];
        const [td, vd] = toDisplay(...state.points[sIdx]);
        editT.value = fmtNum(td);
        editV.value = fmtNum(vd);
        pointEditor.style.display = '';
    } else {
        pointEditor.style.display = 'none';
    }
}

function applyEditorToPoint() {
    if (state.selectedIndices.size !== 1) return;
    const sIdx = Array.from(state.selectedIndices)[0];
    const td = parseFloat(editT.value);
    const vd = parseFloat(editV.value);
    if (isNaN(td) || isNaN(vd)) return;

    let [tSI, vSI] = toSI(td, vd);
    tSI = Math.max(0, tSI);

    // Resolve any time collision by nudging forward.
    // We keep the current point excluded while resolving, then apply.
    const resolved = resolveTime(tSI, sIdx);
    const nudged = Math.abs(resolved - tSI) > minDt() * 0.5;

    state.points[sIdx] = [resolved, vSI];
    sortPoints();
    const newIdx = state.points.findIndex(
        p => Math.abs(p[0] - resolved) < minDt() * 0.1 && Math.abs(p[1] - vSI) < 1e-30
    );
    state.selectedIndices.clear();
    if (newIdx !== -1) state.selectedIndices.add(newIdx);

    if (nudged) {
        const [rdD] = toDisplay(resolved, 0);
        setStatus(`時刻が重複していたため ${fmtNum(rdD)} ${state.timeUnitLabel} にずらしました`);
    }
    refreshAll();
}

// ============================================================
//  Auto scale
// ============================================================
function autoScale() {
    if (state.points.length === 0) return;
    const ts = state.points.map(p => p[0] / state.timeScale);
    const vs = state.points.map(p => p[1] / state.valScale);
    const tMin = Math.min(...ts), tMax = Math.max(...ts);
    const vMin = Math.min(...vs), vMax = Math.max(...vs);
    const tPad = (tMax - tMin) * 0.12 || 1;
    const vPad = (vMax - vMin) * 0.15 || 1;
    state.view.xMin = Math.max(0, tMin - tPad);
    state.view.xMax = tMax + tPad;
    state.view.yMin = vMin - vPad;
    state.view.yMax = vMax + vPad;
    syncRangeInputs();
    refreshAll();
}

// ============================================================
//  View range
// ============================================================
function syncRangeInputs() {
    xMinI.value = fmtNum(state.view.xMin);
    xMaxI.value = fmtNum(state.view.xMax);
    yMinI.value = fmtNum(state.view.yMin);
    yMaxI.value = fmtNum(state.view.yMax);
}

function readRangeInputs() {
    const xn = parseFloat(xMinI.value), xx = parseFloat(xMaxI.value);
    const yn = parseFloat(yMinI.value), yx = parseFloat(yMaxI.value);
    if (!isNaN(xn)) state.view.xMin = Math.max(0, xn);
    if (!isNaN(xx)) state.view.xMax = xx;
    if (!isNaN(yn)) state.view.yMin = yn;
    if (!isNaN(yx)) state.view.yMax = yx;
    syncRangeInputs();
    draw();
}

// ============================================================
//  Status
// ============================================================
function setStatus(msg) { statusMsg.textContent = msg; }

// ============================================================
//  Full refresh
// ============================================================
function refreshAll() {
    sortPoints();
    draw();
    updatePointList();
    updateOutput();
    updateEditorVisibility();
    const n = state.points.length;
    const selCount = state.selectedIndices.size;
    if (selCount === 1) {
        const sIdx = Array.from(state.selectedIndices)[0];
        setStatus(`点 ${sIdx + 1}/${n} を選択中 — ドラッグで移動、右パネルで数値編集`);
    } else if (selCount > 1) {
        setStatus(`${selCount}/${n} 点を選択中`);
    } else {
        setStatus(`${n} 点 — ダブルクリックで追加、クリックで選択`);
    }
}

// ============================================================
//  Mouse interaction
// ============================================================
let dragging = false;
let panning  = false;
let panStart = null;
let panView  = null;
let boxSelecting = false;
let boxStart = null;
let boxCurrent = null;

function canvasMousePos(e) {
    const rect = canvas.getBoundingClientRect();
    return [
        (e.clientX - rect.left) * (canvas.width  / rect.width),
        (e.clientY - rect.top)  * (canvas.height / rect.height),
    ];
}

function nearestPoint(px, py) {
    const pad = plotPad();
    if (px < pad.l || px > canvas.width - pad.r || py < pad.t || py > canvas.height - pad.b) return null;
    let best = null, bestDist = Infinity;
    state.points.forEach(([tSI, vSI], i) => {
        const [cpx, cpy] = disp2px(...toDisplay(tSI, vSI));
        const d = Math.hypot(px - cpx, py - cpy);
        if (d < bestDist) { bestDist = d; best = i; }
    });
    return bestDist < 14 ? best : null;
}

canvas.addEventListener('mousedown', e => {
    const [px, py] = canvasMousePos(e);
    if (e.button === 2) {
        panning  = true;
        panStart = [px, py];
        panView  = { ...state.view };
        e.preventDefault();
        return;
    }
    if (e.button !== 0) return;
    const idx = nearestPoint(px, py);
    if (idx !== null) {
        if (e.ctrlKey || e.shiftKey) {
            if (state.selectedIndices.has(idx)) state.selectedIndices.delete(idx);
            else state.selectedIndices.add(idx);
        } else {
            selectPoint(idx);
            dragging = true;
        }
        refreshAll();
    } else {
        if (!e.ctrlKey && !e.shiftKey) state.selectedIndices.clear();
        boxSelecting = true;
        boxStart = [px, py];
        boxCurrent = [px, py];
        refreshAll();
    }
});

canvas.addEventListener('mousemove', e => {
    const [px, py] = canvasMousePos(e);
    const [dx, dy] = px2disp(px, py);
    const pad = plotPad();
    const inPlot = px >= pad.l && px <= canvas.width - pad.r
                && py >= pad.t && py <= canvas.height - pad.b;
    cursorCoord.textContent = inPlot
        ? `${fmtNum(dx)} ${state.timeUnitLabel}, ${fmtNum(dy)} ${state.valUnitLabel}`
        : '';

    if (panning && panStart) {
        const [sdx, sdy] = px2disp(...panStart);
        const ddx = sdx - dx, ddy = sdy - dy;
        const newXMin = Math.max(0, panView.xMin + ddx);
        const shift = newXMin - (panView.xMin + ddx);
        state.view.xMin = newXMin;
        state.view.xMax = panView.xMax + ddx + shift;
        state.view.yMin = panView.yMin + ddy;
        state.view.yMax = panView.yMax + ddy;
        syncRangeInputs();
        draw();
        return;
    }

    if (boxSelecting) {
        boxCurrent = [px, py];
        draw();
        return;
    }

    if (dragging && state.selectedIndices.size === 1) {
        const sIdx = Array.from(state.selectedIndices)[0];
        let [td, vd] = px2disp(px, py);
        [td, vd] = snapDisp(td, vd);
        let [tSI, vSI] = toSI(td, vd);
        tSI = Math.max(0, tSI);
        tSI = resolveTime(tSI, sIdx);
        state.points[sIdx] = [tSI, vSI];
        sortPoints();
        const newIdx = state.points.findIndex(
            p => Math.abs(p[0] - tSI) < minDt() * 0.1 && Math.abs(p[1] - vSI) < 1e-30
        );
        state.selectedIndices.clear();
        if (newIdx !== -1) state.selectedIndices.add(newIdx);
        draw();
        updatePointList();
        updateOutput();
        updateEditorVisibility();
    }
});

canvas.addEventListener('mouseup', () => {
    if (boxSelecting) {
        boxSelecting = false;
        if (boxStart && boxCurrent) {
            const minX = Math.min(boxStart[0], boxCurrent[0]);
            const maxX = Math.max(boxStart[0], boxCurrent[0]);
            const minY = Math.min(boxStart[1], boxCurrent[1]);
            const maxY = Math.max(boxStart[1], boxCurrent[1]);
            state.points.forEach(([tSI, vSI], i) => {
                const [dx, dy] = toDisplay(tSI, vSI);
                const [px, py] = disp2px(dx, dy);
                if (px >= minX && px <= maxX && py >= minY && py <= maxY) {
                    state.selectedIndices.add(i);
                }
            });
        }
        refreshAll();
    }
    dragging = false; panning = false;
    panStart = null; panView = null;
    boxStart = null; boxCurrent = null;
});

canvas.addEventListener('mouseleave', () => {
    cursorCoord.textContent = '';
    dragging = false; panning = false;
    if (boxSelecting) {
        boxSelecting = false;
        refreshAll();
    }
});

canvas.addEventListener('contextmenu', e => e.preventDefault());

canvas.addEventListener('dblclick', e => {
    const [px, py] = canvasMousePos(e);
    const pad = plotPad();
    if (px < pad.l || px > canvas.width - pad.r || py < pad.t || py > canvas.height - pad.b) return;
    let [td, vd] = px2disp(px, py);
    [td, vd] = snapDisp(td, vd);
    const [tSI, vSI] = toSI(td, vd);
    const newIdx = addPointSI(tSI, vSI);
    selectPoint(newIdx);
    refreshAll();
});

canvas.addEventListener('wheel', e => {
    e.preventDefault();
    const [px, py] = canvasMousePos(e);
    const pad = plotPad();
    // Clamp to plot area so zooming over axis labels uses the nearest plot edge as pivot
    const cpx = Math.max(pad.l, Math.min(canvas.width  - pad.r, px));
    const cpy = Math.max(pad.t, Math.min(canvas.height - pad.b, py));
    const [cx, cy] = px2disp(cpx, cpy);
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    const { xMin, xMax, yMin, yMax } = state.view;

    if (!e.ctrlKey) {   // zoom X unless Ctrl held
        let newXMin = cx - (cx - xMin) * factor;
        let newXMax = cx + (xMax - cx) * factor;
        if (newXMin < 0) { newXMax -= newXMin; newXMin = 0; }
        state.view.xMin = newXMin;
        state.view.xMax = newXMax;
    }
    if (!e.shiftKey) {  // zoom Y unless Shift held
        state.view.yMin = cy - (cy - yMin) * factor;
        state.view.yMax = cy + (yMax - cy) * factor;
    }
    syncRangeInputs();
    draw();
}, { passive: false });

document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.key === 'Delete' || e.key === 'Backspace') deleteSelected();
    if (e.key === 'f' || e.key === 'F') autoScale();
    if (e.key === 'Escape') { selectPoint(null); refreshAll(); }
});

// ============================================================
//  Unit / source type
// ============================================================
document.getElementById('srcType').addEventListener('change', e => {
    state.srcType = e.target.value;
    const valSel = document.getElementById('valUnit');
    const units = state.srcType === 'V' ? VAL_UNITS_V : VAL_UNITS_I;
    valSel.innerHTML = Object.entries(units)
        .map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    const def = '1e-3';
    valSel.value = def;
    state.valScale = parseFloat(def);
    state.valUnitLabel = units[def];
    autoScale();
});

document.getElementById('timeUnit').addEventListener('change', e => {
    state.timeScale = parseFloat(e.target.value);
    state.timeUnitLabel = TIME_UNITS[e.target.value];
    autoScale();
});

document.getElementById('valUnit').addEventListener('change', e => {
    state.valScale = parseFloat(e.target.value);
    const units = state.srcType === 'V' ? VAL_UNITS_V : VAL_UNITS_I;
    state.valUnitLabel = units[e.target.value];
    autoScale();
});

// ============================================================
//  Range inputs
// ============================================================
[xMinI, xMaxI, yMinI, yMaxI].forEach(el => {
    el.addEventListener('change', readRangeInputs);
    el.addEventListener('keydown', ev => { if (ev.key === 'Enter') readRangeInputs(); });
});

// ============================================================
//  Snap
// ============================================================
document.getElementById('snapEnable').addEventListener('change', e => {
    state.snap.enabled = e.target.checked;
    draw();
});
document.getElementById('snapT').addEventListener('change', e => {
    state.snap.t = Math.max(1e-9, parseFloat(e.target.value) || 1);
    draw();
});
document.getElementById('snapV').addEventListener('change', e => {
    state.snap.v = Math.max(1e-9, parseFloat(e.target.value) || 1);
    draw();
});
document.getElementById('minDtInput').addEventListener('change', e => {
    const v = parseFloat(e.target.value);
    if (isFinite(v) && v > 0) state.minDtDisplay = v;
    else e.target.value = state.minDtDisplay;
});

// ============================================================
//  Editor
// ============================================================
editT.addEventListener('change', applyEditorToPoint);
editV.addEventListener('change', applyEditorToPoint);
editT.addEventListener('keydown', e => { if (e.key === 'Enter') applyEditorToPoint(); });
editV.addEventListener('keydown', e => { if (e.key === 'Enter') applyEditorToPoint(); });
document.getElementById('btnDelPoint').addEventListener('click', deleteSelected);

// ============================================================
//  Add point button
// ============================================================
document.getElementById('btnAddPoint').addEventListener('click', () => {
    const lastT = state.points.length ? Math.max(...state.points.map(p => p[0])) : 0;
    const newIdx = addPointSI(lastT + state.timeScale, 0);
    selectPoint(newIdx);
    refreshAll();
    pointList.scrollTop = pointList.scrollHeight;
});

// ============================================================
//  Auto scale button
// ============================================================
document.getElementById('btnAutoScale').addEventListener('click', autoScale);

// ============================================================
//  Copy
// ============================================================
document.getElementById('btnCopy').addEventListener('click', () => {
    const text = generatePWL();
    navigator.clipboard.writeText(text)
        .then(() => setStatus('クリップボードにコピーしました'))
        .catch(() => {
            pwlOutput.select();
            document.execCommand('copy');
            setStatus('クリップボードにコピーしました');
        });
});

// ============================================================
//  Resize observer + init
// ============================================================
new ResizeObserver(() => { draw(); }).observe(wrap);

// Sync state from DOM — browser may restore form values (bfcache) after reload
state.snap.enabled = document.getElementById('snapEnable').checked;
state.snap.t = Math.max(1e-9, parseFloat(document.getElementById('snapT').value) || 1);
state.snap.v = Math.max(1e-9, parseFloat(document.getElementById('snapV').value) || 1);
const _minDtVal = parseFloat(document.getElementById('minDtInput').value);
if (isFinite(_minDtVal) && _minDtVal > 0) state.minDtDisplay = _minDtVal;

syncRangeInputs();
refreshAll();
