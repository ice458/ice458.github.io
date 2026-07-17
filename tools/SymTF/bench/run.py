"""Benchmark runner for SymTF solve strategies.

Times ``engine.solve`` on the BENCH_SUITE circuits, comparing available
``options.method`` values. Each case runs in a subprocess with a wall-clock
timeout so one runaway case cannot stall the whole table.

Usage:
    python -m bench.run                 # all cases, methods auto+legacy
    python -m bench.run rc8 mfb3        # selected cases
    python -m bench.run --method auto   # one method only
    python -m bench.run --timeout 30    # per-case cap (seconds)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent   # tools/SymTF


def _run_one(name: str, method: str, timeout: float):
    """Solve one case in a subprocess; return (elapsed, status, degree_str)."""
    code = (
        "import json, time, sys;"
        "sys.path.insert(0, r'%s');"
        "import engine;"
        "from bench.circuits import get;"
        "engine._MAX_SIZE = 10**9;"
        "netlist, inp, out = get('%s');"
        "pr = json.loads(engine.parse_netlist(netlist));"
        "circuit = json.loads(pr['circuit_json']);"
        "circuit['input'] = {'name': inp};"
        "circuit['output'] = {'node': out};"
        "circuit['options'] = {'method': '%s'};"
        "t0 = time.perf_counter();"
        "sr = json.loads(engine.solve(json.dumps(circuit)));"
        "dt = time.perf_counter() - t0;"
        "deg = (str(sr['tf']['num_degree']) + '/' + str(sr['tf']['den_degree'])) if sr['ok'] else 'ERR';"
        "print(json.dumps({'dt': dt, 'ok': sr['ok'], 'deg': deg, 'errors': sr.get('errors', [])}))"
        % (str(ROOT), name, method)
    )
    t0 = time.perf_counter()
    try:
        out = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True, text=True, timeout=timeout, cwd=str(ROOT),
        )
    except subprocess.TimeoutExpired:
        return timeout, "TIMEOUT", "-"
    if out.returncode != 0:
        return time.perf_counter() - t0, "CRASH", (out.stderr.strip().splitlines() or ["?"])[-1][:40]
    try:
        payload = json.loads(out.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        return time.perf_counter() - t0, "BADOUT", out.stdout[:40]
    status = "ok" if payload["ok"] else "fail"
    return payload["dt"], status, payload["deg"]


def main():
    from bench.circuits import BENCH_SUITE, get, system_size

    ap = argparse.ArgumentParser()
    ap.add_argument("cases", nargs="*", help="case names (default: all)")
    ap.add_argument("--method", action="append",
                    help="method(s) to test (default: auto, legacy)")
    ap.add_argument("--timeout", type=float, default=60.0)
    args = ap.parse_args()

    cases = args.cases or list(BENCH_SUITE)
    methods = args.method or ["auto", "legacy"]

    header = f"{'case':7s} {'n':>4s} " + " ".join(f"{m:>18s}" for m in methods)
    print(header)
    print("-" * len(header))
    for name in cases:
        netlist, inp, out = get(name)
        n = system_size(netlist)
        cells = []
        for m in methods:
            dt, status, deg = _run_one(name, m, args.timeout)
            if status == "ok":
                cells.append(f"{dt:8.3f}s {deg:>8s}")
            elif status == "TIMEOUT":
                cells.append(f"{'>%.0fs' % args.timeout:>18s}")
            else:
                cells.append(f"{status:>10s} {deg:>7s}")
        print(f"{name:7s} {n:>4d} " + " ".join(cells), flush=True)


if __name__ == "__main__":
    main()
