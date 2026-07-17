"""test_speedup.py — regression guard for the fast solve core.

The new elimination core (engine solve with ``options.method='auto'``) must
produce transfer functions identical to the legacy Cramer/berkowitz path
(``options.method='legacy'``). This module is the exact new-vs-old oracle:

  * On the small consistency circuits it compares auto vs legacy directly.
  * It also re-checks a spread of element types (R/L/C/V/I/G/E/O, ideal and
    finite-gain op-amp, differential output) so no stamp is left behind.

Before Phase 1 lands, ``auto`` falls back to the legacy path, so these tests
pass trivially -- that is the intended scaffold state. They become a real
guard the moment the new core is wired in.
"""

import json

import pytest
from sympy import Symbol, cancel, simplify, sympify

from engine import parse_netlist, solve

s = Symbol("s")


def _solve(netlist, input_name, output_spec, method):
    pr = json.loads(parse_netlist(netlist))
    assert pr["ok"], f"parse failed: {pr.get('errors')}"
    circuit = json.loads(pr["circuit_json"])
    circuit["input"] = {"name": input_name}
    circuit["output"] = output_spec
    circuit["options"] = {"method": method}
    sr = json.loads(solve(json.dumps(circuit)))
    assert sr["ok"], f"solve({method}) failed: {sr.get('errors')}"
    return sr["tf"]


def _H(tf):
    local = {"s": s}
    for name in tf.get("symbols", []):
        local[name] = Symbol(name, positive=True)
    return sympify(tf["H_expr"], locals=local)


def assert_methods_agree(netlist, input_name, output_spec):
    legacy = _solve(netlist, input_name, output_spec, "legacy")
    auto = _solve(netlist, input_name, output_spec, "auto")
    diff = simplify(cancel(_H(legacy) - _H(auto)))
    assert diff == 0 or diff.equals(0), (
        f"auto vs legacy disagree:\n  legacy: {legacy['H_expr']}\n  auto:   {auto['H_expr']}"
    )
    # Degrees and kind must match too -- coefficient lists feed poles/zeros.
    assert legacy["num_degree"] == auto["num_degree"]
    assert legacy["den_degree"] == auto["den_degree"]
    assert legacy["kind"] == auto["kind"]


# --- Element-coverage circuits (each names one or two stamps) ---------------

ELEMENT_CASES = {
    "rc_lowpass": ("Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1",
                   "Vin", {"kind": "node_voltage", "node": "out"}),
    "rlc_series": ("Vin in 0 Vin\nR1 in a R\nL1 a b L\nC1 b 0 C",
                   "Vin", {"kind": "node_voltage", "node": "b"}),
    "divider": ("Vin in 0 Vin\nR1 in out R1\nR2 out 0 R2",
                "Vin", {"kind": "node_voltage", "node": "out"}),
    "vccs": ("Vin in 0 Vin\nG1 out 0 in 0 gm\nR1 out 0 R\nC1 out 0 C",
             "Vin", {"kind": "node_voltage", "node": "out"}),
    "vcvs": ("Vin in 0 Vin\nR1 in a R1\nR2 a 0 R2\nE1 out 0 a 0 Av\nRL out 0 RL",
             "Vin", {"kind": "node_voltage", "node": "out"}),
    "opamp_ideal": ("Vin in 0 Vin\nR1 in inv R1\nR2 inv out R2\nO1 0 inv out",
                    "Vin", {"kind": "node_voltage", "node": "out"}),
    "opamp_finite": ("Vin in 0 Vin\nR1 in inv R1\nR2 inv out R2\nO1 0 inv out A0 GBW",
                     "Vin", {"kind": "node_voltage", "node": "out"}),
    "sallen_key": ("Vin in 0 Vin\nR1 in a R1\nR2 a b R2\nC1 a out C1\nC2 b 0 C2\nO1 b out out",
                   "Vin", {"kind": "node_voltage", "node": "out"}),
    "cascode": ("Vin in 0 Vin\nG1 mid 0 in 0 gm1\nro1 mid 0 ro1\n"
                "G2 out mid 0 mid gm2\nro2 out mid ro2\nRL out 0 RL",
                "Vin", {"kind": "node_voltage", "node": "out"}),
    "differential_out": ("Vin in 0 Vin\nR1 in a R1\nR2 a b R2\nR3 b 0 R3",
                          "Vin", {"kind": "node_voltage", "from": "a", "to": "b"}),
    "current_source": ("Iin 0 out Iin\nR1 out 0 R1\nC1 out 0 C1",
                       "Iin", {"kind": "node_voltage", "node": "out"}),
}


@pytest.mark.parametrize("name", sorted(ELEMENT_CASES))
def test_element_stamp_agreement(name):
    netlist, inp, out = ELEMENT_CASES[name]
    assert_methods_agree(netlist, inp, out)


# --- Structural consistency circuits (the fast bench instances) -------------

def test_bench_consistency_cases():
    from bench.circuits import CONSISTENCY_CASES, get
    for cname in CONSISTENCY_CASES:
        netlist, inp, out = get(cname)
        assert_methods_agree(netlist, inp, {"kind": "node_voltage", "node": out})
