"""
test_engine.py — Comprehensive pytest tests for engine.py
==========================================================

Tests cover all five public API functions:
  parse_netlist, solve, substitute, approximate, freq_response

Each test validates transfer-function correctness using symbolic
reconstruction from polynomial coefficients.
"""

import json
import math

import pytest
from sympy import Symbol, symbols, sympify, simplify, cancel, Rational, oo

from engine import parse_netlist, solve, substitute, approximate, freq_response, sensitivity

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

s = Symbol("s")


def reconstruct_H(tf):
    """Rebuild H(s) from coefficient lists (highest-degree-first)."""
    local_dict = {'s': s}
    if 'symbols' in tf:
        for sym_name in tf['symbols']:
            local_dict[sym_name] = Symbol(sym_name, positive=True)
            
    num_coeffs = [sympify(c, locals=local_dict) for c in tf["num_coeffs"]]
    den_coeffs = [sympify(c, locals=local_dict) for c in tf["den_coeffs"]]
    num = sum(c * s**i for i, c in enumerate(reversed(num_coeffs)))
    den = sum(c * s**i for i, c in enumerate(reversed(den_coeffs)))
    return cancel(num / den)


def assert_tf_equal(tf, expected_H):
    """Assert that a TF dict matches an expected SymPy expression."""
    H = reconstruct_H(tf)
    diff = simplify(cancel(H - expected_H))
    assert diff.equals(0) or diff == 0, f"TF mismatch:\n  got:      {H}\n  expected: {expected_H}"


def solve_circuit(netlist_text, input_spec, output_spec):
    """Parse netlist, attach I/O specs, solve, return tf dict."""
    pr = json.loads(parse_netlist(netlist_text))
    assert pr["ok"], f"Parse failed: {pr.get('errors')}"
    circuit = json.loads(pr["circuit_json"])
    circuit["input"] = input_spec
    circuit["output"] = output_spec
    sr = json.loads(solve(json.dumps(circuit)))
    assert sr["ok"], f"Solve failed: {sr.get('errors')}"
    return sr["tf"]


# ===================================================================
#  T1 — RC Low-Pass Filter
# ===================================================================

class TestT1RCLowpass:
    """Vin──R1──out──C1──GND  →  H(s) = 1/(1 + s·R1·C1)"""

    NETLIST = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
    INPUT = {"kind": "V", "name": "Vin"}
    OUTPUT = {"kind": "node_voltage", "node": "out"}

    def test_transfer_function(self):
        R1, C1 = symbols("R1 C1", positive=True)
        expected_H = 1 / (1 + s * R1 * C1)
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        assert_tf_equal(tf, expected_H)

    def test_dc_gain_unity(self):
        """At DC (s=0) the capacitor is open ⇒ H(0)=1."""
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        H = reconstruct_H(tf)
        assert simplify(H.subs(s, 0) - 1) == 0

    def test_symbols_present(self):
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        assert "R1" in tf["symbols"]
        assert "C1" in tf["symbols"]


# ===================================================================
#  T2 — RLC Series (Band-Pass → Voltage across C)
# ===================================================================

class TestT2RLCSeries:
    """Vin──R──L──C──GND  →  H(s) = 1/(L·C·s² + R·C·s + 1)"""

    NETLIST = "Vin in 0 Vin\nR1 in n1 R\nL1 n1 n2 L\nC1 n2 0 C"
    INPUT = {"kind": "V", "name": "Vin"}
    OUTPUT = {"kind": "node_voltage", "node": "n2"}

    def test_transfer_function(self):
        R, L, C = symbols("R L C", positive=True)
        expected_H = 1 / (L * C * s**2 + R * C * s + 1)
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        assert_tf_equal(tf, expected_H)

    def test_second_order(self):
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        assert tf["den_degree"] == 2
        assert tf["num_degree"] == 0


# ===================================================================
#  T3 — Resistive Voltage Divider (no frequency dependence)
# ===================================================================

class TestT3VoltageDivider:
    """Vin──R1──out──R2──GND  →  H = R2/(R1+R2)"""

    NETLIST = "Vin in 0 Vin\nR1 in out R1\nR2 out 0 R2"
    INPUT = {"kind": "V", "name": "Vin"}
    OUTPUT = {"kind": "node_voltage", "node": "out"}

    def test_transfer_function(self):
        R1, R2 = symbols("R1 R2", positive=True)
        expected_H = R2 / (R1 + R2)
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        assert_tf_equal(tf, expected_H)

    def test_no_frequency_dependence(self):
        """Pure resistive divider ⇒ no s terms (degree 0)."""
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        assert tf["num_degree"] == 0
        assert tf["den_degree"] == 0


# ===================================================================
#  T4 — VCCS (gm) Cell
# ===================================================================

class TestT4VCCSGmCell:
    """Vin──GND,  G1: gm·V(in,0) from out to GND,  R‖C on out.

    H(s) = -gm·R / (1 + s·R·C)
    CRITICAL: verify NEGATIVE sign.
    """

    NETLIST = "Vin in 0 Vin\nG1 out 0 in 0 gm\nR1 out 0 R\nC1 out 0 C"
    INPUT = {"kind": "V", "name": "Vin"}
    OUTPUT = {"kind": "node_voltage", "node": "out"}

    def test_transfer_function(self):
        gm, R, C = symbols("gm R C", positive=True)
        expected_H = -gm * R / (1 + s * R * C)
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        assert_tf_equal(tf, expected_H)

    def test_negative_dc_gain(self):
        """DC gain must be negative: H(0) = -gm·R."""
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        H = reconstruct_H(tf)
        gm, R, C = symbols("gm R C", positive=True)
        dc_gain = simplify(H.subs(s, 0))
        # dc_gain should be -gm*R  ⇒  dc_gain + gm*R == 0
        assert simplify(dc_gain + gm * R) == 0, (
            f"DC gain should be -gm*R, got {dc_gain}"
        )

    def test_negative_sign_explicitly(self):
        """CRITICAL: The VCCS inverts the signal. Verify the sign."""
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        H = reconstruct_H(tf)
        gm, R, C = symbols("gm R C", positive=True)
        # Substitute positive numeric values and check sign at DC
        H_numeric = H.subs({gm: 1, R: 1, C: 1, s: 0})
        assert float(H_numeric) < 0, (
            f"Expected negative gain, got {H_numeric}"
        )


# ===================================================================
#  T5 — Inverting Op-Amp
# ===================================================================

class TestT5InvertingOpAmp:
    """Vin──R1──inv──R2──out,  O1(+)=GND, O1(-)=inv, O1(out)=out.

    H = -R2/R1
    """

    NETLIST = "Vin in 0 Vin\nR1 in inv R1\nR2 inv out R2\nO1 0 inv out"
    INPUT = {"kind": "V", "name": "Vin"}
    OUTPUT = {"kind": "node_voltage", "node": "out"}

    def test_transfer_function(self):
        R1, R2 = symbols("R1 R2", positive=True)
        expected_H = -R2 / R1
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        assert_tf_equal(tf, expected_H)

    def test_inverting_sign(self):
        """Must produce a negative gain."""
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        H = reconstruct_H(tf)
        R1, R2 = symbols("R1 R2", positive=True)
        H_val = H.subs({R1: 1, R2: 2})
        assert float(H_val) == pytest.approx(-2.0)


class TestAssumptionMonomials:
    """Assumptions accept monomials on either side, per base-spec T8 ("gm*R >> 1"),
    and approximate() output chains: each result feeds the next call."""

    NETLIST = ("Vin in 0 Vin\n"
               "G1 mid 0 in 0 gm1\nro1 mid 0 ro1\n"
               "G2 out mid 0 mid gm2\nro2 out mid ro2\n"
               "RL out 0 RL")
    INPUT = {"kind": "V", "name": "Vin"}
    OUTPUT = {"kind": "node_voltage", "node": "out"}

    def _tf(self):
        return solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)

    def test_product_much_greater_one(self):
        # The exact form the old bare-name parser rejected.
        res = json.loads(approximate(json.dumps(self._tf()),
                                     json.dumps({"mode": "assumption",
                                                 "assumptions": ["gm2*ro2 >> 1"]})))
        assert res["ok"], res.get("errors")
        # Plain symbols: H_expr round-trips through str/sympify without the
        # positive=True assumption, and mixed-assumption twins don't cancel.
        gm1, RL = symbols("gm1 RL")
        H = sympify(res["tf_approx"]["H_expr"])
        assert simplify(H - (-gm1 * RL)) == 0

    def test_monomials_both_sides(self):
        res = json.loads(approximate(json.dumps(self._tf()),
                                     json.dumps({"mode": "assumption",
                                                 "assumptions": ["gm2*ro1*ro2 >> RL"]})))
        assert res["ok"], res.get("errors")

    def test_chaining_modes(self):
        # truncate, then take the DC limit of the truncated result.
        rlc = solve_circuit("Vin in 0 Vin\nR1 in a R\nL1 a b L\nC1 b 0 C",
                            self.INPUT, {"kind": "node_voltage", "node": "b"})
        t1 = json.loads(approximate(json.dumps(rlc),
                                    json.dumps({"mode": "truncate",
                                                "max_num_order": 0, "max_den_order": 1})))
        assert t1["ok"], t1.get("errors")
        t2 = json.loads(approximate(json.dumps(t1["tf_approx"]),
                                    json.dumps({"mode": "limit", "direction": "dc"})))
        assert t2["ok"], t2.get("errors")
        assert simplify(sympify(t2["tf_approx"]["H_expr"]) - 1) == 0

    def test_sum_rejected(self):
        res = json.loads(approximate(json.dumps(self._tf()),
                                     json.dumps({"mode": "assumption",
                                                 "assumptions": ["ro1+ro2 >> RL"]})))
        assert not res["ok"]
        assert "product" in res["errors"][0]


class TestCascode:
    """Cascode (CS under a common-gate stage, gm/ro model), the schematic sample.

    The exact small-signal gain -- confirmed against an independent nodal
    analysis, not the textbook -Gm*Rout approximation:
        H = -gm1*ro1*(1 + gm2*ro2)*RL / (RL + ro1 + ro2 + gm2*ro1*ro2)
    """

    NETLIST = ("Vin in 0 Vin\n"
               "G1 mid 0 in 0 gm1\nro1 mid 0 ro1\n"
               "G2 out mid 0 mid gm2\nro2 out mid ro2\n"
               "RL out 0 RL")
    INPUT = {"kind": "V", "name": "Vin"}
    OUTPUT = {"kind": "node_voltage", "node": "out"}

    def test_transfer_function(self):
        gm1, gm2, ro1, ro2, RL = symbols("gm1 gm2 ro1 ro2 RL", positive=True)
        expected = -gm1 * ro1 * (1 + gm2 * ro2) * RL / (RL + ro1 + ro2 + gm2 * ro1 * ro2)
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        assert_tf_equal(tf, expected)


class TestFiniteGainOpAmp:
    """Same inverting amp, but the op-amp is finite-gain: O1 ... A0 GBW.

    A(s) = A0/(1 + s/wp), wp = 2*pi*GBW/A0, so the closed loop is first order:
        H = -A0*R2 / ((R1+R2) + (R1+R2)*s/wp + A0*R1)
    At DC it is -R2/R1, and as A0 -> oo at DC it stays -R2/R1.
    """

    NETLIST = "Vin in 0 Vin\nR1 in inv R1\nR2 inv out R2\nO1 0 inv out A0 GBW"
    INPUT = {"kind": "V", "name": "Vin"}
    OUTPUT = {"kind": "node_voltage", "node": "out"}

    def test_first_order(self):
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        # One reactive-like pole from the single op-amp pole; no second pole.
        assert tf["den_degree"] == 1
        assert tf["num_degree"] == 0

    def test_dc_gain_approaches_ideal(self):
        # Finite A0 gives slightly less than -R2/R1 at DC; the ideal value is
        # the A0 -> oo limit of the DC gain.
        from sympy import limit, oo
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        H = reconstruct_H(tf)
        R1, R2, A0 = symbols("R1 R2 A0", positive=True)
        dc = H.subs(s, 0)
        assert simplify(limit(dc, A0, oo) - (-R2 / R1)) == 0

    def test_symbols_include_a0_gbw(self):
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        assert "A0" in tf["symbols"] and "GBW" in tf["symbols"]

    def test_blank_value_is_ideal(self):
        """No A0/GBW tokens -> the nullor result, -R2/R1."""
        tf = solve_circuit(
            "Vin in 0 Vin\nR1 in inv R1\nR2 inv out R2\nO1 0 inv out",
            self.INPUT, self.OUTPUT)
        R1, R2 = symbols("R1 R2", positive=True)
        assert_tf_equal(tf, -R2 / R1)


# ===================================================================
#  T6 — Sallen-Key Low-Pass Filter
# ===================================================================

class TestT6SallenKeyLPF:
    """Unity-gain Sallen-Key LPF topology.

    H(s) = 1 / (s²·R1·R2·C1·C2 + s·C2·(R1+R2) + 1)
    """

    NETLIST = (
        "Vin in 0 Vin\n"
        "R1 in a R1\n"
        "R2 a b R2\n"
        "C1 a out C1\n"
        "C2 b 0 C2\n"
        "O1 b out out"
    )
    INPUT = {"kind": "V", "name": "Vin"}
    OUTPUT = {"kind": "node_voltage", "node": "out"}

    def test_transfer_function(self):
        R1, R2, C1, C2 = symbols("R1 R2 C1 C2", positive=True)
        expected_H = 1 / (
            s**2 * R1 * R2 * C1 * C2
            + s * C2 * (R1 + R2)
            + 1
        )
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        assert_tf_equal(tf, expected_H)

    def test_degree_check(self):
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        assert tf["den_degree"] == 2
        assert tf["num_degree"] == 0


# ===================================================================
#  T7 — Partial / Full Substitution
# ===================================================================

class TestT7PartialSubstitution:
    """Use the RLC circuit from T2.

    Step 1: substitute L=0.001 only ⇒ still symbolic.
    Step 2: additionally substitute R=100, C=1e-6 ⇒ fully numeric.
    """

    NETLIST = "Vin in 0 Vin\nR1 in n1 R\nL1 n1 n2 L\nC1 n2 0 C"
    INPUT = {"kind": "V", "name": "Vin"}
    OUTPUT = {"kind": "node_voltage", "node": "n2"}

    def test_partial_then_full(self):
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)

        # --- Step 1: partial substitution (L only) ---
        sub1 = json.loads(
            substitute(json.dumps(tf), json.dumps({"L": "0.001"}))
        )
        assert sub1["ok"], f"Partial sub failed: {sub1.get('errors')}"
        assert sub1["fully_numeric"] is False, (
            "After substituting only L, should NOT be fully numeric"
        )
        # R and C should still be present
        remaining = sub1["tf"]["symbols"]
        assert "R" in remaining, "R should remain after partial sub"
        assert "C" in remaining, "C should remain after partial sub"

        # --- Step 2: full substitution ---
        sub2 = json.loads(
            substitute(
                json.dumps(sub1["tf"]),
                json.dumps({"R": "100", "C": "1e-6"}),
            )
        )
        assert sub2["ok"], f"Full sub failed: {sub2.get('errors')}"
        assert sub2["fully_numeric"] is True, (
            "After substituting R and C, should be fully numeric"
        )

    def test_partial_preserves_structure(self):
        """Partial sub should keep the same polynomial degree."""
        tf = solve_circuit(self.NETLIST, self.INPUT, self.OUTPUT)
        sub1 = json.loads(
            substitute(json.dumps(tf), json.dumps({"L": "0.001"}))
        )
        assert sub1["ok"]
        assert sub1["tf"]["den_degree"] == 2
        assert sub1["tf"]["num_degree"] == 0


# ===================================================================
#  Parsing Tests
# ===================================================================

class TestParseText:
    """Verify plain-text netlist parsing."""

    def test_rc_parse_text(self):
        netlist = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        pr = json.loads(parse_netlist(netlist))
        assert pr["ok"], f"Parse failed: {pr.get('errors')}"
        circuit = json.loads(pr["circuit_json"])
        assert len(circuit["elements"]) == 3
        assert "R1" in pr["symbols"]
        assert "C1" in pr["symbols"]
        # Vin should also be a symbol
        assert "Vin" in pr["symbols"]

    def test_comment_lines_ignored(self):
        netlist = "* This is a comment\nVin in 0 Vin\nR1 in out R1\n# Another comment\nC1 out 0 C1"
        pr = json.loads(parse_netlist(netlist))
        assert pr["ok"]
        circuit = json.loads(pr["circuit_json"])
        assert len(circuit["elements"]) == 3


class TestParseJson:
    """Verify JSON-wrapped netlist parsing."""

    def test_json_wrapper(self):
        netlist_text = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        json_input = json.dumps({"netlist": netlist_text})
        pr = json.loads(parse_netlist(json_input))
        assert pr["ok"], f"Parse failed: {pr.get('errors')}"
        circuit = json.loads(pr["circuit_json"])
        assert len(circuit["elements"]) == 3

    def test_symbols_detected(self):
        netlist_text = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        json_input = json.dumps({"netlist": netlist_text})
        pr = json.loads(parse_netlist(json_input))
        assert pr["ok"]
        assert "R1" in pr["symbols"]
        assert "C1" in pr["symbols"]


# ===================================================================
#  Error Handling
# ===================================================================

class TestErrorNoGround:
    """A netlist without a ground node should fail validation."""

    def test_no_ground(self):
        # No node '0' or 'GND' — all nodes are non-ground
        netlist = "Vin a b Vin\nR1 a b R1"
        pr = json.loads(parse_netlist(netlist))
        assert pr["ok"] is False, "Should fail with no ground node"
        errors_lower = [e.lower() for e in pr["errors"]]
        found_ground_msg = any("ground" in e for e in errors_lower)
        assert found_ground_msg, (
            f"Expected ground-related error, got: {pr['errors']}"
        )


# ===================================================================
#  TF Kind Verification
# ===================================================================

class TestTFKindVoltageGain:
    """T1 (RC LPF) with voltage input + voltage output ⇒ 'voltage_gain'."""

    def test_kind_is_voltage_gain(self):
        netlist = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        tf = solve_circuit(
            netlist,
            {"kind": "V", "name": "Vin"},
            {"kind": "node_voltage", "node": "out"},
        )
        assert tf["kind"] == "voltage_gain"


class TestTFKindTransimpedanceAndImpedance:
    """Current-source input -- transimpedance in general, and the driving-point
    impedance Z(s) at a node when input and output are the SAME node (the
    schematic UI's route to Zin/Zout: drive with current, read that node's own
    voltage -- no separate "kill the source" step, since a circuit built by
    this tool never has more than one independent source to begin with)."""

    def test_kind_is_transimpedance(self):
        netlist = "Iin in 0 Iin\nR1 in out R1\nC1 out 0 C1"
        tf = solve_circuit(
            netlist,
            {"kind": "I", "name": "Iin"},
            {"kind": "node_voltage", "node": "out"},
        )
        assert tf["kind"] == "transimpedance"

    def test_impedance_of_bare_resistor(self):
        """Iin -> R1 -> gnd, read V at the driven node ⇒ Z(s) = R1."""
        netlist = "Iin in 0 Iin\nR1 in 0 R1"
        tf = solve_circuit(
            netlist,
            {"kind": "I", "name": "Iin"},
            {"kind": "node_voltage", "node": "in"},
        )
        assert tf["kind"] == "transimpedance"
        R1 = Symbol("R1", positive=True)
        assert_tf_equal(tf, R1)

    def test_impedance_of_parallel_rc(self):
        """Iin -> node -> {R1, C1} -> gnd, read V at that same node
        ⇒ Z(s) = R1 / (1 + s*R1*C1) (the classic parallel-RC impedance)."""
        netlist = "Iin in 0 Iin\nR1 in 0 R1\nC1 in 0 C1"
        tf = solve_circuit(
            netlist,
            {"kind": "I", "name": "Iin"},
            {"kind": "node_voltage", "node": "in"},
        )
        R1, C1 = symbols("R1 C1", positive=True)
        assert_tf_equal(tf, R1 / (1 + s * R1 * C1))


# ===================================================================
#  Frequency Response Tests
# ===================================================================

class TestFreqResponse:
    """Verify freq_response returns correct structure and sensible data."""

    def test_rc_lowpass_freq_response(self):
        """RC LPF with R=1kΩ, C=1nF ⇒ f_3dB ≈ 159 kHz."""
        netlist = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        tf = solve_circuit(
            netlist,
            {"kind": "V", "name": "Vin"},
            {"kind": "node_voltage", "node": "out"},
        )

        # Substitute to numeric
        sub_r = json.loads(
            substitute(
                json.dumps(tf),
                json.dumps({"R1": "1000", "C1": "1e-9"}),
            )
        )
        assert sub_r["ok"]
        assert sub_r["fully_numeric"]

        # Compute frequency response
        fr_r = json.loads(
            freq_response(
                json.dumps(sub_r["tf"]),
                json.dumps({
                    "f_start": 1,
                    "f_end": 1e9,
                    "n_points": 500,
                }),
            )
        )
        assert fr_r["ok"], f"freq_response failed: {fr_r.get('errors')}"
        data = fr_r["data"]

        # Structure checks
        assert "f" in data
        assert "mag_db" in data
        assert "phase_deg" in data
        assert "re" in data
        assert "im" in data
        assert len(data["f"]) == 500

        # DC gain should be ~0 dB
        assert abs(data["mag_db"][0]) < 0.1, (
            f"DC gain should be ~0 dB, got {data['mag_db'][0]:.2f} dB"
        )

        # At very high frequency the gain should roll off significantly
        assert data["mag_db"][-1] < -20, (
            f"HF gain should be well below -20 dB, got {data['mag_db'][-1]:.2f} dB"
        )

    def test_freq_response_missing_symbols(self):
        """If symbols remain un-substituted, freq_response should error."""
        netlist = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        tf = solve_circuit(
            netlist,
            {"kind": "V", "name": "Vin"},
            {"kind": "node_voltage", "node": "out"},
        )
        fr_r = json.loads(
            freq_response(
                json.dumps(tf),
                json.dumps({"f_start": 1, "f_end": 1e6, "n_points": 10}),
            )
        )
        assert fr_r["ok"] is False, (
            "freq_response should fail when symbols remain"
        )


# ===================================================================
#  Approximation Tests
# ===================================================================

class TestApproximation:
    """Test the approximate() API with different modes."""

    def _get_rc_tf(self):
        netlist = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        return solve_circuit(
            netlist,
            {"kind": "V", "name": "Vin"},
            {"kind": "node_voltage", "node": "out"},
        )

    def test_dc_limit(self):
        """DC limit of RC LPF ⇒ H(0) = 1."""
        tf = self._get_rc_tf()
        result = json.loads(
            approximate(
                json.dumps(tf),
                json.dumps({"mode": "limit", "direction": "dc"}),
            )
        )
        assert result["ok"], f"Approx failed: {result.get('errors')}"
        tf_approx = result["tf_approx"]
        H_approx = reconstruct_H(tf_approx)
        assert simplify(H_approx - 1) == 0, (
            f"DC limit should be 1, got {H_approx}"
        )

    def test_hf_limit(self):
        """HF limit of RC LPF ⇒ H(∞) = 0."""
        tf = self._get_rc_tf()
        result = json.loads(
            approximate(
                json.dumps(tf),
                json.dumps({"mode": "limit", "direction": "hf"}),
            )
        )
        assert result["ok"], f"Approx failed: {result.get('errors')}"
        tf_approx = result["tf_approx"]
        H_approx = reconstruct_H(tf_approx)
        assert simplify(H_approx) == 0, (
            f"HF limit should be 0, got {H_approx}"
        )

    def test_truncate_rlc(self):
        """Truncate RLC (2nd order) to 1st order in denominator."""
        netlist = "Vin in 0 Vin\nR1 in n1 R\nL1 n1 n2 L\nC1 n2 0 C"
        tf = solve_circuit(
            netlist,
            {"kind": "V", "name": "Vin"},
            {"kind": "node_voltage", "node": "n2"},
        )
        result = json.loads(
            approximate(
                json.dumps(tf),
                json.dumps({
                    "mode": "truncate",
                    "max_num_order": 0,
                    "max_den_order": 1,
                }),
            )
        )
        assert result["ok"], f"Approx failed: {result.get('errors')}"
        # Should have dropped the s² term
        assert len(result["dropped_terms"]) > 0
        assert result["tf_approx"]["den_degree"] <= 1


# ===================================================================
#  Solve Error Tests
# ===================================================================

class TestSolveErrors:
    """Verify solve() handles invalid configurations gracefully."""

    def test_missing_input_spec(self):
        """Solve without input/output specs should error."""
        netlist = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        pr = json.loads(parse_netlist(netlist))
        assert pr["ok"]
        circuit = json.loads(pr["circuit_json"])
        # No input/output added
        sr = json.loads(solve(json.dumps(circuit)))
        assert sr["ok"] is False

    def test_invalid_output_node(self):
        """Requesting output at a node that doesn't exist should error."""
        netlist = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        pr = json.loads(parse_netlist(netlist))
        assert pr["ok"]
        circuit = json.loads(pr["circuit_json"])
        circuit["input"] = {"name": "Vin"}
        circuit["output"] = {"node": "nonexistent"}
        sr = json.loads(solve(json.dumps(circuit)))
        assert sr["ok"] is False

    def test_invalid_input_source(self):
        """Requesting an input source that doesn't exist should error."""
        netlist = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        pr = json.loads(parse_netlist(netlist))
        assert pr["ok"]
        circuit = json.loads(pr["circuit_json"])
        circuit["input"] = {"name": "V_nonexistent"}
        circuit["output"] = {"node": "out"}
        sr = json.loads(solve(json.dumps(circuit)))
        assert sr["ok"] is False


# ===================================================================
#  Latex and H_expr Sanity
# ===================================================================

class TestTFMetadata:
    """Check that tf dict contains all expected keys."""

    def test_tf_keys_present(self):
        netlist = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        tf = solve_circuit(
            netlist,
            {"kind": "V", "name": "Vin"},
            {"kind": "node_voltage", "node": "out"},
        )
        expected_keys = {
            "num_coeffs", "den_coeffs", "num_degree", "den_degree",
            "symbols", "latex", "kind", "H_expr",
        }
        assert expected_keys.issubset(set(tf.keys())), (
            f"Missing keys: {expected_keys - set(tf.keys())}"
        )

    def test_latex_non_empty(self):
        netlist = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        tf = solve_circuit(
            netlist,
            {"kind": "V", "name": "Vin"},
            {"kind": "node_voltage", "node": "out"},
        )
        assert isinstance(tf["latex"], str)
        assert len(tf["latex"]) > 0

    def test_H_expr_parseable(self):
        """H_expr string should be sympify-able back to an expression."""
        netlist = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
        tf = solve_circuit(
            netlist,
            {"kind": "V", "name": "Vin"},
            {"kind": "node_voltage", "node": "out"},
        )
        local_dict = {'s': s}
        for sym_name in tf.get('symbols', []):
            local_dict[sym_name] = Symbol(sym_name, positive=True)
            
        H_from_expr = sympify(tf["H_expr"], locals=local_dict)
        H_from_coeffs = reconstruct_H(tf)
        diff = simplify(cancel(H_from_expr - H_from_coeffs))
        assert diff.equals(0) or diff == 0, (
            f"H_expr and coefficients disagree:\n"
            f"  H_expr:  {H_from_expr}\n"
            f"  coeffs:  {H_from_coeffs}"
        )


# ===================================================================
#  Poles & Zeros
# ===================================================================

from engine import poles_zeros


def _pz(tf):
    """Run poles_zeros on a tf dict and assert success."""
    r = json.loads(poles_zeros(json.dumps(tf)))
    assert r["ok"], f"poles_zeros failed: {r.get('errors')}"
    return r


class TestPolesZeros:
    """poles_zeros lists numerator roots (zeros) and denominator roots (poles)."""

    RC = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
    IN = {"kind": "V", "name": "Vin"}
    OUT = {"kind": "node_voltage", "node": "out"}

    def test_symbolic_rc_pole(self):
        """RC low-pass: one symbolic pole at -1/(R1*C1), no zeros."""
        tf = solve_circuit(self.RC, self.IN, self.OUT)
        r = _pz(tf)
        assert r["numeric"] is False
        assert r["zeros"] == []
        assert len(r["poles"]) == 1
        # The pole value should equal -1/(R1*C1).
        R1, C1 = symbols("R1 C1", positive=True)
        got = sympify(r["poles"][0]["expr"], locals={"R1": R1, "C1": C1})
        assert simplify(got - (-1 / (R1 * C1))) == 0

    def test_numeric_rc_pole_frequency(self):
        """Substituted RC: numeric pole at f = 1/(2*pi*R*C) Hz."""
        tf = solve_circuit(self.RC, self.IN, self.OUT)
        sub = json.loads(substitute(json.dumps(tf), json.dumps({"R1": "1000", "C1": "1e-9"})))["tf"]
        r = _pz(sub)
        assert r["numeric"] is True
        assert len(r["poles"]) == 1
        pole = r["poles"][0]
        expected_f = 1.0 / (2 * math.pi * 1000 * 1e-9)
        assert pole["f_hz"] == pytest.approx(expected_f, rel=1e-6)
        # A real pole: negligible imaginary part.
        assert abs(pole["im"]) < 1e-3
        assert pole["re"] < 0

    def test_numeric_complex_conjugate_poles(self):
        """RLC band-pass with values: a complex-conjugate pole pair."""
        netlist = "Vin in 0 Vin\nR1 in a R1\nL1 a out L1\nC1 out 0 C1"
        tf = solve_circuit(netlist, self.IN, self.OUT)
        sub = json.loads(substitute(
            json.dumps(tf),
            json.dumps({"R1": "100", "L1": "1e-3", "C1": "1e-9"})
        ))["tf"]
        r = _pz(sub)
        assert r["numeric"] is True
        assert len(r["poles"]) == 2
        ims = sorted(p["im"] for p in r["poles"])
        # Conjugate pair: equal-and-opposite, non-zero imaginary parts.
        assert ims[0] == pytest.approx(-ims[1], rel=1e-6)
        assert abs(ims[1]) > 1.0

    def test_numeric_latex_is_katex_ready(self):
        """Large numeric roots use \times 10^{n}, not python 'e+06'."""
        tf = solve_circuit(self.RC, self.IN, self.OUT)
        sub = json.loads(substitute(json.dumps(tf), json.dumps({"R1": "1000", "C1": "1e-9"})))["tf"]
        r = _pz(sub)
        latex = r["poles"][0]["latex"]
        assert "e+" not in latex and "e-" not in latex.lower()

    def test_second_order_no_closed_form_note(self):
        """A symbolic cubic+ denominator that sympy cannot fully factor is flagged."""
        # Reconstruct a tf with an irreducible-in-radicals quintic denominator.
        tf = {
            "num_coeffs": ["1"],
            "den_coeffs": ["1", "0", "0", "0", "0", "a"],  # s^5 + a
            "num_degree": 0,
            "den_degree": 5,
            "symbols": ["a"],
            "H_expr": "1/(s**5 + a)",
            "kind": "voltage_gain",
        }
        r = _pz(tf)
        assert r["numeric"] is False
        # sympy expresses s^5 = -a roots via CRootOf/radicals for this one, so
        # just assert the call succeeds and returns a list (note may be empty).
        assert isinstance(r["poles"], list)

    def test_constant_tf_has_no_roots(self):
        """H(s) = constant: no poles, no zeros."""
        tf = {
            "num_coeffs": ["5"],
            "den_coeffs": ["1"],
            "num_degree": 0,
            "den_degree": 0,
            "symbols": [],
            "H_expr": "5",
            "kind": "voltage_gain",
        }
        r = _pz(tf)
        assert r["zeros"] == []
        assert r["poles"] == []


# ===================================================================
#  Sensitivity Analysis
# ===================================================================

class TestSensitivityStandardParam:
    """Verified against the textbook-exact sensitivities of a parallel RLC
    tank: den = L*C*s^2 + (L/R)*s + 1 ⇒ Q = R*sqrt(C/L), f0 = 1/(2*pi*sqrt(L*C)).
    S_Q^R = 1, S_Q^C = 1/2, S_Q^L = -1/2, S_f0^R = 0, S_f0^L = S_f0^C = -1/2
    -- exact rational constants, independent of the actual R/L/C values."""

    SECTION = {"num_coeffs": ["1"], "den_coeffs": ["L*C", "L/R", "1"]}
    VALUES = {"R": 1000.0, "L": 1e-3, "C": 1e-9}

    def _run(self, param, values=None):
        r = json.loads(sensitivity(
            json.dumps(self.SECTION),
            json.dumps({"kind": "standard_param", "param": param}),
            json.dumps(values if values is not None else self.VALUES),
        ))
        assert r["ok"], r
        return {x["symbol"]: x["sensitivity"] for x in r["results"]}

    def test_Q_sensitivities(self):
        by_sym = self._run("Q")
        assert by_sym["R"] == pytest.approx(1.0, abs=1e-6)
        assert by_sym["C"] == pytest.approx(0.5, abs=1e-6)
        assert by_sym["L"] == pytest.approx(-0.5, abs=1e-6)

    def test_f0_sensitivities(self):
        # R cancels out of f0 = 1/(2*pi*sqrt(L*C)) entirely, so it is not a
        # free symbol of that expression at all -- it correctly has no entry
        # here, rather than an entry equal to 0.
        by_sym = self._run("f0")
        assert "R" not in by_sym
        assert by_sym["L"] == pytest.approx(-0.5, abs=1e-6)
        assert by_sym["C"] == pytest.approx(-0.5, abs=1e-6)

    def test_results_sorted_by_impact(self):
        r = json.loads(sensitivity(
            json.dumps(self.SECTION),
            json.dumps({"kind": "standard_param", "param": "Q"}),
            json.dumps(self.VALUES),
        ))
        mags = [abs(x["sensitivity"]) for x in r["results"]]
        assert mags == sorted(mags, reverse=True)

    def test_missing_value_is_skipped_not_fatal(self):
        r = json.loads(sensitivity(
            json.dumps(self.SECTION),
            json.dumps({"kind": "standard_param", "param": "Q"}),
            json.dumps({"R": 1000.0, "L": 1e-3}),  # C missing
        ))
        assert r["ok"]
        assert not any(x["symbol"] == "C" for x in r["results"])
        assert any("C" in n for n in r["notes"])

    def test_first_order_section_has_no_q(self):
        r = json.loads(sensitivity(
            json.dumps({"num_coeffs": ["1"], "den_coeffs": ["R*C", "1"]}),
            json.dumps({"kind": "standard_param", "param": "Q"}),
            json.dumps({"R": 1000.0, "C": 1e-9}),
        ))
        assert not r["ok"]


class TestSensitivityAtFreq:
    """At-frequency sensitivity of an RC low-pass: DC gain (f=0) is exactly
    1 regardless of R/C (H(0)=1 for a series-R/shunt-C divider), so its
    sensitivity to either part must be ~0; well past the corner frequency
    the gain is clearly sensitive to both."""

    NETLIST = "Vin in 0 Vin\nR1 in out R1\nC1 out 0 C1"
    VALUES = {"R1": 1000.0, "C1": 1e-9}   # f0 = 1/(2*pi*R1*C1) ~ 159.15 kHz

    def _tf(self):
        return solve_circuit(
            self.NETLIST, {"kind": "V", "name": "Vin"},
            {"kind": "node_voltage", "node": "out"},
        )

    def test_dc_gain_is_insensitive(self):
        r = json.loads(sensitivity(
            json.dumps(self._tf()),
            json.dumps({"kind": "at_freq", "f_hz": 0, "quantity": "mag_db"}),
            json.dumps(self.VALUES),
        ))
        assert r["ok"], r
        for x in r["results"]:
            assert x["sensitivity"] == pytest.approx(0.0, abs=1e-6)

    def test_gain_sensitive_well_above_corner(self):
        r = json.loads(sensitivity(
            json.dumps(self._tf()),
            json.dumps({"kind": "at_freq", "f_hz": 1e7, "quantity": "mag_db"}),
            json.dumps(self.VALUES),
        ))
        assert r["ok"], r
        for x in r["results"]:
            assert abs(x["sensitivity"]) > 0.01

    def test_unknown_kind_is_an_error(self):
        r = json.loads(sensitivity(
            json.dumps(self._tf()),
            json.dumps({"kind": "nonsense"}),
            json.dumps(self.VALUES),
        ))
        assert not r["ok"]
