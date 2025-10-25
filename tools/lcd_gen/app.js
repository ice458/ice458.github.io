(function(){
  const FONT = (typeof window !== 'undefined' && window.FONT_5X8) ? window.FONT_5X8 : {};
  const $ = (id) => document.getElementById(id);
  const setStatus = (msg, isError=false) => {
    const el = $("status");
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#b00020' : '#57606a';
  };

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 0, g: 0, b: 0 };
  }
  function rgbToCss({ r, g, b }) { return `rgb(${r}, ${g}, ${b})`; }
  function getTextRows(text, rows) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const out = new Array(rows).fill(' ');
    for (let i = 0; i < rows; i++) out[i] = (lines[i] ?? '').toString();
    return out;
  }

  function draw() {
    try {
      const rows = Math.max(1, Math.min(100, parseInt($("rows").value, 10) || 2));
      const cols = Math.max(1, Math.min(200, parseInt($("cols").value, 10) || 16));
      const dotSize = Math.max(1, Math.min(50, parseInt($("dotSize").value, 10) || 10));
      const charGapX = Math.max(0, Math.min(100, parseInt($("charGapX").value, 10) || 0));
      const charGapY = Math.max(0, Math.min(100, parseInt($("charGapY").value, 10) || 0));
      const canvasWidth = Math.max(10, Math.min(4096, parseInt($("canvasWidth").value, 10) || 300));
      const canvasHeight = Math.max(10, Math.min(4096, parseInt($("canvasHeight").value, 10) || 150));
      const centerDisplay = $("centerDisplay").checked;

      const bg = hexToRgb($("bgColor").value);
      const on = hexToRgb($("dotOnColor").value);
      const off = hexToRgb($("dotOffColor").value);

      const canvas = $("canvas");
      const ctx = canvas.getContext('2d');
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;

      const CHAR_W = 5; const CHAR_H = 8;
      const lcdWidth = (cols * CHAR_W * dotSize) + ((cols - 1) * charGapX);
      const lcdHeight = (rows * CHAR_H * dotSize) + ((rows - 1) * charGapY);
      const offsetX = centerDisplay ? Math.floor((canvasWidth - lcdWidth) / 2) : 0;
      const offsetY = centerDisplay ? Math.floor((canvasHeight - lcdHeight) / 2) : 0;

      ctx.fillStyle = rgbToCss(bg);
      ctx.fillRect(0, 0, canvasWidth, canvasHeight);

      const rowTexts = getTextRows($("textArea").value, rows);
      for (let row = 0; row < rows; row++) {
        const text = (rowTexts[row] || '').padEnd(cols, ' ').slice(0, cols);
        for (let col = 0; col < cols; col++) {
          const ch = text[col] || ' ';
          const pattern = (FONT && FONT[ch]) || (FONT && FONT[' ']) || [0,0,0,0,0,0,0,0];

          const charX = offsetX + col * (CHAR_W * dotSize + charGapX);
          const charY = offsetY + row * (CHAR_H * dotSize + charGapY);

          for (let dy = 0; dy < CHAR_H; dy++) {
            const rowBits = pattern && pattern[dy] != null ? pattern[dy] : 0;
            for (let dx = 0; dx < CHAR_W; dx++) {
              const bitPos = (CHAR_W - 1 - dx);
              const isOn = (rowBits >> bitPos) & 1;
              const px = charX + dx * dotSize;
              const py = charY + dy * dotSize;
              ctx.fillStyle = isOn ? rgbToCss(on) : rgbToCss(off);
              ctx.fillRect(px, py, dotSize, dotSize);
            }
          }
        }
      }
      setStatus('描画を更新しました');
    } catch (err) {
      console.error(err);
      setStatus('描画エラー: ' + (err && err.message ? err.message : String(err)), true);
    }
  }

  function preset() {
    $("rows").value = '2';
    $("cols").value = '16';
    $("dotSize").value = '10';
    $("charGapX").value = '10';
    $("charGapY").value = '20';
    $("canvasWidth").value = '990';
    $("canvasHeight").value = '330';
    $("centerDisplay").checked = true;
    $("bgColor").value = '#639978';
    $("dotOnColor").value = '#1E2E24';
    $("dotOffColor").value = '#598F6E';
    $("textArea").value = 'LCD Character\nDisplay';
    draw();
  }
  function downloadPng() {
    const canvas = $("canvas");
    const url = canvas.toDataURL('image/png');
    const a = document.createElement('a');
    a.href = url; a.download = 'lcd_display.png';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  }
  function init() {
    $("btnRender").addEventListener('click', draw);
    $("btnPreset").addEventListener('click', preset);
    $("btnDownload").addEventListener('click', downloadPng);

    const liveInputs = [
      'rows','cols','dotSize','charGapX','charGapY','canvasWidth','canvasHeight','centerDisplay','bgColor','dotOnColor','dotOffColor','textArea'
    ];
    let timer = null; const schedule = () => { clearTimeout(timer); timer = setTimeout(draw, 120); };
    for (const id of liveInputs) {
      const el = $(id); if (!el) continue;
      el.addEventListener('input', schedule); el.addEventListener('change', schedule);
    }
    preset();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
