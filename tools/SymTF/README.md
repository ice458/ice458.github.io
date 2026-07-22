# SymTF - Symbolic Circuit Analyzer

SymTF is a web-based symbolic circuit analyzer that allows you to draw analog circuits and symbolically derive their transfer functions $H(s)$ entirely within the browser. 

It runs a Python engine powered by SymPy via Pyodide in a Web Worker, performing Modified Nodal Analysis (MNA) to derive the exact symbolic equations without requiring a backend server.

## Features

- **Interactive Schematic Editor:** Draw circuits intuitively with a built-in HTML5 canvas editor.
- **Symbolic Analysis:** Get the exact symbolic transfer function $H(s)$ in LaTeX format.
- **Poles and Zeros:** Compute and display poles, zeros, and Q factors.
- **Bode & Nyquist Plots:** Instantly visualize frequency responses.
- **Approximations:** Perform symbolic approximations (e.g., DC limits, high-frequency limits, or drop small terms).
- **Client-Side Execution:** No server required. The Python analysis engine runs purely in your browser via WebAssembly (Pyodide).

## Usage

You can use the live version hosted on GitHub Pages:
**[Launch SymTF](https://ice458.github.io/SymTF/)** (or via the portfolio link [ice458.github.io/tools/SymTF/](https://ice458.github.io/tools/SymTF/))

## Development

SymTF is built with Vanilla HTML/JS/CSS on the frontend and Python/SymPy on the backend.

### Architecture
- **Frontend:** `app.js`, `schematic.js`, `netlist.js` handle the UI, circuit drawing, and netlist extraction.
- **Backend (Web Worker):** `engine.py` (Python) handles the math, powered by `SymPy` and executed via `Pyodide` (`engine_worker.js`).

### Running Locally
Since SymTF uses Web Workers, you must serve the files via a local HTTP server to avoid CORS issues.
```bash
# Using Python's built-in server
python -m http.server 8000
```
Then open `http://localhost:8000/` in your browser.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
