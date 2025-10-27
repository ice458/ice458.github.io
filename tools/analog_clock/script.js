const updateClock = () => {
    const now = new Date();
    const seconds = now.getSeconds();
    const minutes = now.getMinutes();
    const hours = now.getHours() % 12;

    const secondHand = document.querySelector('.second-hand');
    const minuteHand = document.querySelector('.minute-hand');
    const hourHand = document.querySelector('.hour-hand');

    // 針が0秒から360秒にジャンプするとき、アニメーション効果を一時的に無効化
    if (seconds === 0) {
        secondHand.style.transition = 'none';
    } else {
        secondHand.style.transition = 'all 0.05s cubic-bezier(0.1, 2.7, 0.58, 1)';
    }

    const secondsDegrees = ((seconds / 60) * 360);
    const minutesDegrees = ((minutes / 60) * 360) + ((seconds / 60) * 6);
    const hoursDegrees = ((hours / 12) * 360) + ((minutes / 60) * 30);

    secondHand.style.transform = `translateX(-50%) rotate(${secondsDegrees}deg)`;
    minuteHand.style.transform = `translateX(-50%) rotate(${minutesDegrees}deg)`;
    hourHand.style.transform = `translateX(-50%) rotate(${hoursDegrees}deg)`;
};

setInterval(updateClock, 1000);
updateClock();

// テーマ切替 + 背景色カスタム
(() => {
    const root = document.documentElement;
    const btn = document.getElementById('themeToggle');
    const bgInput = document.getElementById('bgColor');
    const bgReset = document.getElementById('bgReset');
    const bgChk = document.getElementById('bgTransparent');

    const applyTheme = (mode) => {
        if (mode === 'dark') {
            root.setAttribute('data-theme', 'dark');
        } else {
            root.removeAttribute('data-theme'); // light はデフォルト
        }
        if (btn) {
            const isDark = mode === 'dark';
            btn.setAttribute('aria-pressed', String(isDark));
            btn.textContent = isDark ? 'ライトモード' : 'ダークモード';
        }
    };

    const savedTheme = localStorage.getItem('theme');
    const preferredDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const initialTheme = savedTheme ? savedTheme : (preferredDark ? 'dark' : 'light');
    applyTheme(initialTheme);

    // 背景色カスタム + 透明
    const applyBg = (color) => root.style.setProperty('--bg', color);
    const clearBg = () => root.style.removeProperty('--bg');

    // 背景に対するUI文字色を黒(#000)か白(#fff)で自動調整
    const setUiTextForBg = (hexColor) => {
        if (!hexColor || typeof hexColor !== 'string' || !hexColor.startsWith('#') || (hexColor.length !== 7)) return;
        const r = parseInt(hexColor.slice(1, 3), 16);
        const g = parseInt(hexColor.slice(3, 5), 16);
        const b = parseInt(hexColor.slice(5, 7), 16);
        // YIQによる輝度判定（簡易）: 明るければ黒、暗ければ白
        const yiq = (r * 299 + g * 587 + b * 114) / 1000;
        const text = yiq >= 128 ? '#000000' : '#ffffff';
        root.style.setProperty('--ui-fg', text);
    };
    const clearUiText = () => root.style.removeProperty('--ui-fg');

    const savedBg = localStorage.getItem('bgColor');
    const savedTransparent = localStorage.getItem('bgTransparent') === 'true';
    const defaultBgByTheme = (theme) => (theme === 'dark' ? '#1a1a1a' : '#f5f5f7');

    const setColorInput = (val) => { if (bgInput) bgInput.value = val; };
    const setColorDisabled = (flag) => { if (bgInput) bgInput.disabled = flag; };

    // 初期化
    if (bgChk) bgChk.checked = savedTransparent;
    if (savedTransparent) {
        applyBg('transparent');
        setColorDisabled(true);
        setColorInput(savedBg || defaultBgByTheme(initialTheme));
        // 透明時はUI文字色を黒で固定
        root.style.setProperty('--ui-fg', '#000000');
    } else {
        if (savedBg) {
            applyBg(savedBg);
            setUiTextForBg(savedBg);
        }
        setColorInput(savedBg || defaultBgByTheme(initialTheme));
        setColorDisabled(false);
        if (!savedBg) clearUiText();
    }

    if (bgInput) {
        bgInput.addEventListener('input', (e) => {
            const val = e.target.value;
            applyBg(val);
            setUiTextForBg(val);
            localStorage.setItem('bgColor', val);
        });
    }

    if (bgChk) {
        bgChk.addEventListener('change', (e) => {
            const on = e.target.checked;
            if (on) {
                applyBg('transparent');
                setColorDisabled(true);
                // 透明時はUI文字色を黒で固定
                root.style.setProperty('--ui-fg', '#000000');
                localStorage.setItem('bgTransparent', 'true');
            } else {
                setColorDisabled(false);
                const val = (bgInput && bgInput.value) || defaultBgByTheme(initialTheme);
                applyBg(val);
                setUiTextForBg(val);
                localStorage.setItem('bgColor', val);
                localStorage.removeItem('bgTransparent');
            }
        });
    }

    if (bgReset) {
        bgReset.addEventListener('click', () => {
            clearBg();
            localStorage.removeItem('bgColor');
            localStorage.removeItem('bgTransparent');
            if (bgChk) bgChk.checked = false;
            setColorDisabled(false);
            const nowThemeIsDark = root.getAttribute('data-theme') === 'dark';
            setColorInput(defaultBgByTheme(nowThemeIsDark ? 'dark' : 'light'));
            // UI文字色の上書きを解除してテーマ既定に戻す（ダーク時に黒固定が残らないように）
            clearUiText();
        });
    }

    if (btn) {
        btn.addEventListener('click', () => {
            const isDark = root.getAttribute('data-theme') === 'dark';
            const next = isDark ? 'light' : 'dark';
            applyTheme(next);
            localStorage.setItem('theme', next);
            const hasCustomColor = !!localStorage.getItem('bgColor');
            const transparentOn = bgChk && bgChk.checked;
            // 透明ONなら背景は常に transparent を維持
            if (transparentOn) {
                applyBg('transparent');
                // 透明時はUI文字色を黒で固定
                root.style.setProperty('--ui-fg', '#000000');
                if (!hasCustomColor && bgInput) setColorInput(defaultBgByTheme(next));
                return;
            }
            // 透明OFFでカスタム色なしなら、テーマのデフォルトに入力値を同期
            if (!hasCustomColor && bgInput) {
                const def = defaultBgByTheme(next);
                setColorInput(def);
                clearUiText();
            }
            // カスタム色ありならUI文字色を再計算
            if (hasCustomColor) {
                const val = localStorage.getItem('bgColor');
                if (val) setUiTextForBg(val);
            }
        });
    }

    // UIの表示/非表示
    const setUiHidden = (hidden) => {
        root.classList.toggle('controls-hidden', hidden);
        localStorage.setItem('hideUI', String(hidden));
    };
    const params = new URLSearchParams(window.location.search);
    const urlUi = params.get('ui'); // on/off
    const savedHide = localStorage.getItem('hideUI');
    const computeInitialHide = () => {
        if (urlUi === 'off') return true;
        if (urlUi === 'on') return false;
        return savedHide === 'true';
    };
    setUiHidden(computeInitialHide());

    // キーボードでトグル（Uキー）
    window.addEventListener('keydown', (e) => {
        if (e.key && e.key.toLowerCase() === 'u') {
            const hidden = root.classList.contains('controls-hidden');
            setUiHidden(!hidden);
        }
    });
})();