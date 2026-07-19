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


# --- Numeric-first mode (options.values) -----------------------------------

def _solve_opts(netlist, input_name, output_spec, options):
    pr = json.loads(parse_netlist(netlist))
    assert pr["ok"], pr.get("errors")
    circuit = json.loads(pr["circuit_json"])
    circuit["input"] = {"name": input_name}
    circuit["output"] = output_spec
    circuit["options"] = options
    return json.loads(solve(json.dumps(circuit)))


def test_numeric_first_matches_symbolic_then_substitute():
    """Solving with options.values must equal the symbolic solve then a
    numeric substitution of the same values."""
    netlist, inp, out = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1", "Vin", "out"
    out_spec = {"kind": "node_voltage", "node": out}
    vals = {"R1": "1000", "C1": "1e-9"}

    numeric = _solve_opts(netlist, inp, out_spec, {"method": "auto", "values": vals})
    assert numeric["ok"], numeric.get("errors")
    assert numeric["tf"]["symbols"] == []            # fully numeric
    assert numeric["stats"]["method"] == "fast"

    # Reference: symbolic H, then substitute the same values (Rational, exact).
    from engine import substitute
    sym = _solve_opts(netlist, inp, out_spec, {"method": "auto"})
    subbed = json.loads(substitute(json.dumps(sym["tf"]), json.dumps(vals)))["tf"]
    # Compare as rational functions.
    a = sympify(numeric["tf"]["H_expr"])
    b = sympify(subbed["H_expr"])
    assert simplify(cancel(a - b)) == 0


def test_too_large_reports_reason_and_symbols():
    """A deep symbolic cascade overflows the guard and reports the numeric
    escape hatch: reason='too_large' plus the symbols that still need values."""
    from bench.circuits import get
    netlist, inp, out = get("mfb4")
    r = _solve_opts(netlist, inp, {"kind": "node_voltage", "node": out}, {"method": "auto"})
    assert r["ok"] is False
    assert r.get("reason") == "too_large"
    assert len(r.get("symbols", [])) > 0


def test_too_large_becomes_solvable_with_values():
    """The same over-large circuit solves once values are supplied."""
    from bench.circuits import get
    netlist, inp, out = get("mfb4")
    r = _solve_opts(netlist, inp, {"kind": "node_voltage", "node": out}, {"method": "auto"})
    vals = {name: "1000" if name.startswith("R") else "1e-9" for name in r["symbols"]}
    solved = _solve_opts(netlist, inp, {"kind": "node_voltage", "node": out},
                         {"method": "auto", "values": vals})
    assert solved["ok"], solved.get("errors")
    assert solved["tf"]["symbols"] == []
    assert solved["tf"]["den_degree"] == 8   # 4 cascaded biquads


def test_partial_values_keep_symbols_symbolic():
    """Values for a subset of components: the rest stay symbolic in H(s).

    This is the 50-element partial-sweep workflow: fix most components
    numerically, keep the interesting few symbolic."""
    from bench.circuits import get
    netlist, inp, out = get("sk10")   # ~51 elements, 40 symbols
    r = _solve_opts(netlist, inp, {"kind": "node_voltage", "node": out}, {"method": "auto"})
    assert r.get("reason") == "too_large"
    keep = {"R1a", "C1a"}
    vals = {name: "1000" if name.startswith("R") else "1e-9"
            for name in r["symbols"] if name not in keep}
    solved = _solve_opts(netlist, inp, {"kind": "node_voltage", "node": out},
                         {"method": "auto", "values": vals})
    assert solved["ok"], solved.get("errors")
    assert set(solved["tf"]["symbols"]) == keep
    assert solved["tf"]["den_degree"] == 20   # 10 cascaded biquads


def test_effort_long_has_no_symbol_count_refusal():
    """effort='long' no longer refuses a solve up front by free-symbol count.

    That refusal existed only because a single multivariate gcd is
    uninterruptible, so a high-variable-count solve could burn minutes with no
    way to stop it. Cancel terminates the whole worker (killing even a mid-flight
    gcd), so the user, not a structural element count, owns the stop -- the same
    call already made for the wall-clock budget. The size guards (term/product
    caps) stay: they are what still route a genuinely explosive flat form to
    numeric mode, and they fire in well under a second."""
    import engine
    assert engine._EFFORT_LIMITS["long"]["max_vars"] is None
    assert engine._EFFORT_LIMITS["quick"]["max_vars"] is None
    assert engine._EFFORT_LIMITS["long"]["max_terms"] == 12000
    assert engine._EFFORT_LIMITS["long"]["max_product"] == 1_000_000

    # The direct solver still honours an explicit max_vars if a caller passes one
    # (the mechanism is kept, just unused by the presets): a 2-symbol RC divider
    # capped at 1 generator must refuse by count.
    import sympy as sp
    from engine import _frac_solve_H, _SolverTooLarge
    s, R, C = sp.symbols("s R C", positive=True)
    A = sp.Matrix([[1 / R + s * C, -s * C], [-s * C, s * C]])
    z = sp.Matrix([1 / R, 0])
    try:
        _frac_solve_H(A, z, 0, None, max_vars=1)
        assert False, "max_vars=1 should have refused this 3-generator system"
    except _SolverTooLarge as exc:
        assert "symbols still free" in str(exc)

    # An unknown effort value falls back to quick rather than erroring.
    ok = _solve_opts("Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1", "Vin",
                     {"kind": "node_voltage", "node": "out"},
                     {"method": "auto", "effort": "bogus"})
    assert ok["ok"], ok.get("errors")


# --- Phase 1: field-direct post-processing == Expr post-processing ----------

def test_field_extraction_matches_expr_postproc():
    """The fast tf fields (read straight off the solved FracElement) must be
    byte-identical to what the old Expr post-processing produced.

    :func:`engine._tf_fields_from_field` replaced a
    cancel -> fraction -> expand -> Poly -> LC-normalise chain
    (:func:`engine._tf_fields_from_expr`) with a direct read of the
    numerator/denominator monomials. Feeding the SAME raw solve through both
    must yield the same coefficient strings, degrees, and symbol list -- this
    pins the two paths together so a future change to either is caught."""
    import sympy as sp
    import engine
    from bench.circuits import get

    # Cover a spread: single/multi-symbol, opamp (pi placeholder), differential,
    # frequency-independent (no s generator).
    cases = [
        ("Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1", "Vin", {"node": "out"}),
        ("Vin in 0 Vin\nR1 in out R1\nR2 out 0 R2", "Vin", {"node": "out"}),
        ("Vin in 0 Vin\nR1 in inv R1\nR2 inv out R2\nO1 0 inv out A0 GBW", "Vin",
         {"node": "out"}),
        ("Vin in 0 Vin\nR1 in a R1\nR2 a b R2\nR3 b 0 R3", "Vin",
         {"from": "a", "to": "b"}),
    ]
    for name in ("mfb1", "mfb2", "sk2", "svf1"):
        netlist, inp, out = get(name)
        cases.append((netlist, inp, {"node": out}))

    for netlist, inp, out_spec in cases:
        pr = json.loads(parse_netlist(netlist))
        circuit = json.loads(pr["circuit_json"])
        elements = circuit["elements"]
        A, z, node_list, var_names, errs = engine._build_mna(elements)
        node_idx = {nd: i for i, nd in enumerate(node_list)}
        group2 = [el["name"] for el in elements if el["type"] in ("V", "E", "O")]
        branch_map = {nm: len(node_list) + i for i, nm in enumerate(group2)}
        z_tf = engine.zeros(A.rows, 1)
        z_tf[branch_map[inp]] = sp.Integer(1)
        if "node" in out_spec:
            oi, oi2 = node_idx[out_spec["node"]], None
        else:
            oi = node_idx[out_spec["from"]] if out_spec["from"] != "0" else None
            oi2 = node_idx[out_spec["to"]] if out_spec["to"] != "0" else None

        H_field, F_ring, has_pi = engine._frac_solve_field(A, z_tf, oi, oi2, max_terms=500)
        fast = engine._tf_fields_from_field(H_field, F_ring, has_pi)
        H_expr = H_field.as_expr()
        if has_pi:
            H_expr = H_expr.subs(engine._PI_SYM, sp.pi)
        slow = engine._tf_fields_from_expr(H_expr)

        assert fast["num_coeffs"] == slow["num_coeffs"], (name, fast, slow)
        assert fast["den_coeffs"] == slow["den_coeffs"], (name, fast, slow)
        assert fast["num_degree"] == slow["num_degree"]
        assert fast["den_degree"] == slow["den_degree"]
        assert fast["symbols"] == slow["symbols"]


# --- Phase 2: xreplace substitution and the sympify cache -------------------

def _case(name):
    from bench.circuits import get
    netlist, inp, out = get(name)
    return netlist, inp, {"kind": "node_voltage", "node": out}


def test_substitute_equivalent_to_reference_subs():
    """New xreplace-based substitute == an independent subs-based reference.

    Values are floats, so the two paths differ only in last-digit rounding and
    an exact ``== 0`` on the symbolic difference is the wrong test; compare the
    two H(s) numerically at a spread of frequencies (relative tolerance). Covers
    a full-numeric and a partial value map."""
    import cmath
    import engine
    for name in ("mfb2", "mfb3", "sk4"):
        tf = _solve(*_case(name), method="auto")
        syms = tf["symbols"]
        for keep in (set(), {syms[0]}):   # full-numeric, then partial
            vals = {nm: ("1000" if nm[0] == "R" else "1e-9")
                    for nm in syms if nm not in keep}
            out = json.loads(engine.substitute(json.dumps(tf), json.dumps(vals)))
            assert out["ok"], out.get("errors")
            got = sympify(out["tf"]["H_expr"])
            # Independent reference: subs (not xreplace) the same values.
            ref = _H(tf).subs({Symbol(k, positive=True): sympify(v)
                               for k, v in vals.items()})
            # Pin any leftover (partial-map) symbol, matching each expression's
            # own symbol objects (got has plain symbols, ref positive ones).
            fill = {x: 3.3 for x in (got.free_symbols | ref.free_symbols) if x != s}
            for w in (1.0, 1e3, 1e5, 1e7):
                pt = {s: 1j * w, **fill}
                gv = complex(got.subs(pt)); rv = complex(ref.subs(pt))
                assert abs(gv - rv) <= 1e-9 * max(abs(rv), 1e-300), (name, keep, w)
            assert (len(out["tf"]["symbols"]) == 0) == (len(keep) == 0)


def test_sympify_cache_isolates_distinct_exprs():
    """The H_expr cache must never return one transfer function's parse for
    another. Two different H_exprs substituted in turn must each be right."""
    import engine
    engine._SYMPIFY_CACHE.clear()
    tf_a = _solve(*_case("mfb2"), method="auto")
    tf_b = _solve(*_case("sk4"), method="auto")
    va = {nm: "1000" if nm[0] == "R" else "1e-9" for nm in tf_a["symbols"]}
    vb = {nm: "2000" if nm[0] == "R" else "2e-9" for nm in tf_b["symbols"]}
    ra1 = json.loads(engine.substitute(json.dumps(tf_a), json.dumps(va)))
    rb = json.loads(engine.substitute(json.dumps(tf_b), json.dumps(vb)))
    ra2 = json.loads(engine.substitute(json.dumps(tf_a), json.dumps(va)))  # cache hit
    assert ra1["tf"]["den_coeffs"] == ra2["tf"]["den_coeffs"]
    assert ra1["tf"]["num_degree"] == 0 and ra1["tf"]["den_degree"] == 4  # mfb2 biquad
    assert rb["tf"]["den_degree"] == 8 and rb["ok"]                       # sk4: 4 biquads
    # A hit really occurred (mfb2's H_expr is resident).
    assert tf_a["H_expr"] in engine._SYMPIFY_CACHE
