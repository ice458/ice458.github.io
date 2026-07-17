"""
engine.py — Symbolic Circuit Analysis Engine
=============================================

A pure Python + SymPy module implementing Modified Nodal Analysis (MNA)
for symbolic transfer-function derivation.

Public API (all accept / return JSON strings):
    parse_netlist(text_or_json)  — parse a SPICE-like netlist
    solve(circuit_json)          — build MNA, solve via Cramer's rule
    substitute(tf_json, subs)    — numeric / partial substitution
    approximate(tf_json, spec)   — DC/HF limit, truncation, assumptions
    freq_response(tf_json, rng)  — magnitude / phase over frequency
"""

from __future__ import annotations

import json
import math
import re
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple

import sympy as sp
from sympy import (
    Abs,
    Matrix,
    Poly,
    Rational,
    Symbol,
    cancel,
    fraction,
    oo,
    simplify,
    symbols,
    zeros,
)

# ---------------------------------------------------------------------------
# Laplace variable
# ---------------------------------------------------------------------------
s = Symbol("s")

# ---------------------------------------------------------------------------
# SI-prefix table
# ---------------------------------------------------------------------------
_SI_PREFIXES: Dict[str, float] = {
    "T": 1e12,
    "G": 1e9,
    "M": 1e6,
    "k": 1e3,
    "m": 1e-3,
    "u": 1e-6,
    "μ": 1e-6,
    "n": 1e-9,
    "p": 1e-12,
    "f": 1e-15,
}

_PREFIX_RE = re.compile(
    r"^([+-]?\d+\.?\d*(?:[eE][+-]?\d+)?)\s*([TGMkmuμnpf])$"
)

# Performance limits
_WARN_SIZE = 12
_MAX_SIZE = 20


# ===================================================================
#  Helpers
# ===================================================================

def _parse_value(token: str) -> Any:
    """Return a SymPy expression for *token*.

    * Pure numeric (with optional SI prefix) → ``sympy.Rational`` or float.
    * Otherwise → ``Symbol(token, positive=True)``.
    """
    # Try plain float first
    try:
        return sp.Rational(token)
    except (ValueError, TypeError):
        pass

    # SI prefix: e.g. "10k", "4.7u". Kept EXACT (Rational * 10^n), not Float:
    # a float coefficient defeats sympy's cancel(), leaving un-cancelled common
    # factors in H(s) -- a baked "1k" produced A0^2 terms in a first-order
    # op-amp circuit where the plain "1000" (already Rational) stayed clean.
    m = _PREFIX_RE.match(token)
    if m:
        num_part, prefix = m.groups()
        exponent = round(math.log10(_SI_PREFIXES[prefix]))
        return sp.Rational(num_part) * sp.Integer(10) ** exponent

    # Fall back to symbolic
    return Symbol(token, positive=True)


def _node_key(name: str) -> str:
    """Normalise ground aliases to '0'."""
    return "0" if name.upper() in ("0", "GND") else name


def _is_comment(line: str) -> bool:
    stripped = line.strip()
    return stripped == "" or stripped.startswith("*") or stripped.startswith("//") or stripped.startswith("#")


def _collect_symbols(expr: sp.Expr) -> List[str]:
    """Return sorted list of free symbol names (excluding *s*)."""
    return sorted(str(sym) for sym in expr.free_symbols if sym != s)


_DISPLAY_SIG_FIGS = 4


def _display_latex(expr: sp.Expr) -> str:
    """LaTeX for on-screen display: numbers to a few significant figures and
    ``\\times`` for multiplication.

    A solved transfer function can carry coefficients like ``1000000.0`` or long
    substituted decimals that make the formula unreadable. Rounding is applied
    only to this display string -- the coefficients used for plotting keep full
    precision. ``mul_symbol='times'`` renders ``a*b`` as ``a \\times b`` instead
    of the hard-to-see centre dot.
    """
    # Round the numeric ATOMS only, right at the display boundary -- the
    # expression itself stays exact all the way here. This is what lets pi stay
    # pi: evalf(4) on the whole expression numerised it to 6.283, but pi is a
    # NumberSymbol, not a Number atom, so atom-wise rounding never touches it.
    # Small integers (exponents like s**2, coefficients like 2) stay exact; only
    # numbers too long to read get rounded.
    threshold = 10 ** _DISPLAY_SIG_FIGS

    def _round_atom(x):
        if isinstance(x, sp.Float):
            return sp.Float(x, _DISPLAY_SIG_FIGS)
        if isinstance(x, sp.Integer):
            return sp.Float(x, _DISPLAY_SIG_FIGS) if abs(x) >= threshold else x
        if isinstance(x, sp.Rational):
            if abs(x.p) >= threshold or x.q >= threshold:
                return sp.Float(x, _DISPLAY_SIG_FIGS)
            return x
        return x

    try:
        replacements = {}
        for atom in expr.atoms(sp.Number):
            r = _round_atom(atom)
            if r is not atom:
                replacements[atom] = r
        rounded = expr.xreplace(replacements) if replacements else expr
    except Exception:
        rounded = expr
    latex = sp.latex(rounded, mul_symbol="times")
    # Integer-valued floats read better without the ".0": 20.0 -> 20, 2.0 -> 2.
    latex = re.sub(r"(?<!\d)(\d+)\.0(?!\d)", r"\1", latex)
    # A unit coefficient is noise: "1 \times s^{2}" -> "s^{2}", and
    # "1 \times 10^{9}" -> "10^{9}".
    latex = re.sub(r"(^|[^0-9.])1\s*\\times\s*", r"\1", latex)
    return latex


def _ok(payload: dict) -> str:
    payload["ok"] = True
    return json.dumps(payload, default=str)


def _err(messages: List[str]) -> str:
    return json.dumps({"ok": False, "errors": messages}, default=str)


# ===================================================================
#  Netlist Parser
# ===================================================================

# Element type → (node_count, has_value, has_control_nodes)
_ELEM_SPEC = {
    "R": (2, True, False),
    "L": (2, True, False),
    "C": (2, True, False),
    "V": (2, True, False),
    "I": (2, True, False),
    "G": (2, True, True),   # VCCS — 4 nodes + value
    "E": (2, True, True),   # VCVS — 4 nodes + value
    "O": (3, False, False),  # Ideal Op-Amp — 3 nodes, no value
}


def _parse_netlist_text(text: str) -> Tuple[List[dict], List[str], List[str]]:
    """Parse raw netlist text into element dicts.

    Returns (elements, symbol_names, errors).
    """
    elements: List[dict] = []
    all_symbols: set = set()
    errors: List[str] = []
    seen_names: set = set()

    for lineno, raw_line in enumerate(text.splitlines(), start=1):
        if _is_comment(raw_line):
            continue
        tokens = raw_line.split()
        if not tokens:
            continue

        name = tokens[0]
        etype = name[0].upper()

        if etype not in _ELEM_SPEC:
            errors.append(f"Line {lineno}: unknown element type '{etype}' in '{name}'")
            continue

        n_nodes, has_value, has_ctrl = _ELEM_SPEC[etype]

        if has_ctrl:
            # G / E: name n+ n- nc+ nc- value
            expected = 1 + 4 + (1 if has_value else 0)
        elif etype == "O":
            # O: name n+ n- nout            (ideal)
            #    name n+ n- nout A0 GBW     (finite-gain)
            expected = 1 + 3
        else:
            # R/L/C/V/I: name n1 n2 value
            expected = 1 + n_nodes + (1 if has_value else 0)

        if len(tokens) < expected:
            errors.append(f"Line {lineno}: '{name}' expects {expected} tokens, got {len(tokens)}")
            continue

        if name in seen_names:
            errors.append(f"Line {lineno}: duplicate element name '{name}'")
            continue
        seen_names.add(name)

        elem: dict = {"name": name, "type": etype}

        if has_ctrl:
            # 4-terminal controlled source
            elem["np"] = _node_key(tokens[1])
            elem["nn"] = _node_key(tokens[2])
            elem["ncp"] = _node_key(tokens[3])
            elem["ncn"] = _node_key(tokens[4])
            val = _parse_value(tokens[5])
            elem["value"] = str(val)
            if isinstance(val, Symbol):
                all_symbols.add(str(val))
        elif etype == "O":
            elem["np"] = _node_key(tokens[1])
            elem["nn"] = _node_key(tokens[2])
            elem["nout"] = _node_key(tokens[3])
            # Optional finite-gain parameters: A0 (DC gain) and GBW (gain-
            # bandwidth product, Hz). Both present -> non-ideal; absent -> ideal.
            if len(tokens) >= 6:
                a0 = _parse_value(tokens[4])
                gbw = _parse_value(tokens[5])
                elem["a0"] = str(a0)
                elem["gbw"] = str(gbw)
                for v in (a0, gbw):
                    if isinstance(v, Symbol):
                        all_symbols.add(str(v))
        else:
            elem["n1"] = _node_key(tokens[1])
            elem["n2"] = _node_key(tokens[2])
            if has_value:
                val = _parse_value(tokens[3])
                elem["value"] = str(val)
                if isinstance(val, Symbol):
                    all_symbols.add(str(val))

        elements.append(elem)

    return elements, sorted(all_symbols), errors


def _validate_circuit(elements: List[dict]) -> List[str]:
    """Return a list of validation error strings (empty = valid)."""
    errors: List[str] = []
    nodes: set = set()

    for el in elements:
        for key in ("n1", "n2", "np", "nn", "ncp", "ncn", "nout"):
            if key in el:
                nodes.add(el[key])

    if "0" not in nodes:
        errors.append("No ground node ('0' or 'GND') found in the circuit")

    # Floating-node check: every non-ground node must appear in at least 2 elements
    node_counts: Dict[str, int] = {}
    for el in elements:
        el_nodes = set()
        for key in ("n1", "n2", "np", "nn", "ncp", "ncn", "nout"):
            if key in el and el[key] != "0":
                el_nodes.add(el[key])
        for nd in el_nodes:
            node_counts[nd] = node_counts.get(nd, 0) + 1

    for nd, cnt in node_counts.items():
        if cnt < 2:
            errors.append(f"Node '{nd}' appears in only one element (floating node)")

    return errors


def parse_netlist(text_or_json: str) -> str:
    """Parse a netlist from plain text or a JSON-wrapped string.

    Returns JSON: ``{ok, circuit_json, symbols, errors}``.
    """
    try:
        # Try JSON wrapper first: {"netlist": "..."}
        try:
            obj = json.loads(text_or_json)
            if isinstance(obj, dict) and "netlist" in obj:
                text = obj["netlist"]
            else:
                text = text_or_json
        except json.JSONDecodeError:
            text = text_or_json

        elements, sym_names, parse_errors = _parse_netlist_text(text)

        if parse_errors:
            return _err(parse_errors)

        val_errors = _validate_circuit(elements)
        if val_errors:
            return _err(val_errors)

        circuit = {"elements": elements}
        return _ok({
            "circuit_json": json.dumps(circuit, default=str),
            "symbols": sym_names,
            "errors": [],
        })
    except Exception as exc:
        return _err([f"parse_netlist failed: {exc}"])


# ===================================================================
#  MNA Builder + Solver
# ===================================================================

def _build_mna(elements: List[dict]) -> Tuple[
    sp.Matrix, sp.Matrix, List[str], List[str], List[str]
]:
    """Build the MNA system ``A·x = z``.

    Returns ``(A, z, node_list, var_names, errors)``.
    ``node_list`` excludes ground; ``var_names`` = node voltages + branch currents.
    """
    errors: List[str] = []

    # Collect non-ground nodes
    node_set: set = set()
    for el in elements:
        for key in ("n1", "n2", "np", "nn", "ncp", "ncn", "nout"):
            v = el.get(key)
            if v and v != "0":
                node_set.add(v)
    node_list = sorted(node_set)
    node_idx = {nd: i for i, nd in enumerate(node_list)}
    n_nodes = len(node_list)

    # Count group-2 (branch-current) variables: V, E, O
    group2: List[str] = []
    for el in elements:
        if el["type"] in ("V", "E", "O"):
            group2.append(el["name"])
    n_branch = len(group2)
    n_total = n_nodes + n_branch

    # Performance guard
    if n_total > _MAX_SIZE:
        errors.append(f"System size {n_total} exceeds maximum ({_MAX_SIZE})")
        return zeros(1), zeros(1, 1), [], [], errors
    if n_total > _WARN_SIZE:
        errors.append(f"WARNING: system size {n_total} may be slow (>{_WARN_SIZE})")

    branch_idx = {name: n_nodes + i for i, name in enumerate(group2)}

    var_names = [f"V({nd})" for nd in node_list] + [f"I({nm})" for nm in group2]

    A = zeros(n_total)
    z = zeros(n_total, 1)

    def ni(node: str) -> Optional[int]:
        """Return matrix index for a node, or None if ground."""
        if node == "0":
            return None
        return node_idx[node]

    def stamp_admittance(n1: str, n2: str, Y: sp.Expr) -> None:
        """Stamp admittance Y between nodes n1 and n2.

        KCL convention: current leaving node = Y * (V_n1 - V_n2).
        """
        i1 = ni(n1)
        i2 = ni(n2)
        if i1 is not None:
            A[i1, i1] += Y
        if i2 is not None:
            A[i2, i2] += Y
        if i1 is not None and i2 is not None:
            A[i1, i2] -= Y
            A[i2, i1] -= Y

    for el in elements:
        etype = el["type"]

        if etype == "R":
            # ---- Resistor -------------------------------------------------
            # Y = 1/R
            R_sym = sp.sympify(el["value"])
            Y = 1 / R_sym
            stamp_admittance(el["n1"], el["n2"], Y)

        elif etype == "C":
            # ---- Capacitor ------------------------------------------------
            # Y = s * C
            C_sym = sp.sympify(el["value"])
            Y = s * C_sym
            stamp_admittance(el["n1"], el["n2"], Y)

        elif etype == "L":
            # ---- Inductor -------------------------------------------------
            # Y = 1 / (s * L)
            L_sym = sp.sympify(el["value"])
            Y = 1 / (s * L_sym)
            stamp_admittance(el["n1"], el["n2"], Y)

        elif etype == "V":
            # ---- Independent Voltage Source --------------------------------
            # Adds branch current I_V.
            # A[n+][I_col] += 1   — branch current leaves n+
            # A[n-][I_col] -= 1   — branch current enters n-
            # A[I_row][n+] += 1   — constraint: V(n+) coefficient
            # A[I_row][n-] -= 1   — constraint: V(n-) coefficient
            # z[I_row] = Vs       — V(n+) - V(n-) = Vs
            Vs = sp.sympify(el["value"])
            np_i = ni(el["n1"])
            nn_i = ni(el["n2"])
            i_col = branch_idx[el["name"]]
            i_row = i_col  # same index

            if np_i is not None:
                A[np_i, i_col] += 1
                A[i_row, np_i] += 1
            if nn_i is not None:
                A[nn_i, i_col] -= 1
                A[i_row, nn_i] -= 1
            z[i_row] = Vs

        elif etype == "I":
            # ---- Independent Current Source --------------------------------
            # No branch variable. Current enters n+.
            # z[n+] += Is  — current enters n+
            # z[n-] -= Is  — current leaves n-
            Is = sp.sympify(el["value"])
            np_i = ni(el["n1"])
            nn_i = ni(el["n2"])
            if np_i is not None:
                z[np_i] += Is
            if nn_i is not None:
                z[nn_i] -= Is

        elif etype == "G":
            # ---- VCCS (G) -------------------------------------------------
            # I = gm * V(nc+, nc-) flows from n- to n+ through the element
            # (current leaves n+, enters n-)
            # A[n+][nc+] += gm;  A[n+][nc-] -= gm
            # A[n-][nc+] -= gm;  A[n-][nc-] += gm
            gm = sp.sympify(el["value"])
            np_i = ni(el["np"])
            nn_i = ni(el["nn"])
            ncp_i = ni(el["ncp"])
            ncn_i = ni(el["ncn"])

            if np_i is not None:
                if ncp_i is not None:
                    A[np_i, ncp_i] += gm
                if ncn_i is not None:
                    A[np_i, ncn_i] -= gm
            if nn_i is not None:
                if ncp_i is not None:
                    A[nn_i, ncp_i] -= gm
                if ncn_i is not None:
                    A[nn_i, ncn_i] += gm

        elif etype == "E":
            # ---- VCVS (E) -------------------------------------------------
            # Adds branch current I_E.
            # A[n+][I_col] += 1;  A[n-][I_col] -= 1    — KCL
            # A[I_row][n+] += 1;  A[I_row][n-] -= 1    — V(n+)-V(n-)
            # A[I_row][nc+] -= Av; A[I_row][nc-] += Av  — -Av*(V(nc+)-V(nc-))
            Av = sp.sympify(el["value"])
            np_i = ni(el["np"])
            nn_i = ni(el["nn"])
            ncp_i = ni(el["ncp"])
            ncn_i = ni(el["ncn"])
            i_col = branch_idx[el["name"]]
            i_row = i_col

            # KCL stamps
            if np_i is not None:
                A[np_i, i_col] += 1
            if nn_i is not None:
                A[nn_i, i_col] -= 1

            # Constraint row: V(n+) - V(n-) - Av*(V(nc+) - V(nc-)) = 0
            if np_i is not None:
                A[i_row, np_i] += 1
            if nn_i is not None:
                A[i_row, nn_i] -= 1
            if ncp_i is not None:
                A[i_row, ncp_i] -= Av
            if ncn_i is not None:
                A[i_row, ncn_i] += Av

        elif etype == "O":
            # ---- Op-Amp ---------------------------------------------------
            # Adds a branch current I_O for the output, and one constraint row.
            #   A[nout][I_col] += 1                     — output current at nout
            # Ideal (nullor): constraint V(n+) = V(n-)
            #   A[I_row][n+] += 1;  A[I_row][n-] -= 1
            # Finite-gain: V(nout) = A(s)*(V(n+) - V(n-)), with
            #   A(s) = A0 / (1 + s/wp),  wp = 2*pi*GBW/A0   (GBW in Hz)
            # so the constraint row is
            #   V(nout) - A(s)*V(n+) + A(s)*V(n-) = 0
            # No current flows into the op-amp inputs either way.
            np_i = ni(el["np"])
            nn_i = ni(el["nn"])
            nout_i = ni(el["nout"])
            i_col = branch_idx[el["name"]]
            i_row = i_col

            if nout_i is not None:
                A[nout_i, i_col] += 1

            if "a0" in el and "gbw" in el:
                A0 = sp.sympify(el["a0"])
                GBW = sp.sympify(el["gbw"])
                A_s = A0 / (1 + s * A0 / (2 * sp.pi * GBW))
                if nout_i is not None:
                    A[i_row, nout_i] += 1
                if np_i is not None:
                    A[i_row, np_i] -= A_s
                if nn_i is not None:
                    A[i_row, nn_i] += A_s
            else:
                if np_i is not None:
                    A[i_row, np_i] += 1
                if nn_i is not None:
                    A[i_row, nn_i] -= 1

        else:
            errors.append(f"Unsupported element type '{etype}' for '{el['name']}'")

    return A, z, node_list, var_names, errors


def _determine_tf_kind(
    input_elem: dict, output_type: str
) -> str:
    """Determine the transfer-function kind from input/output types."""
    in_type = input_elem["type"]
    if in_type == "V" and output_type == "voltage":
        return "voltage_gain"
    elif in_type == "V" and output_type == "current":
        return "transimpedance"  # actually I/V = admittance, but spec says transimpedance
    elif in_type == "I" and output_type == "voltage":
        return "transimpedance"
    elif in_type == "I" and output_type == "current":
        return "current_gain"
    return "voltage_gain"


def _extract_coeffs(poly: sp.Poly) -> List[str]:
    """Return polynomial coefficients as strings, highest degree first."""
    return [str(c) for c in poly.all_coeffs()]


def solve(circuit_json: str) -> str:
    """Solve the circuit for transfer function(s).

    Input JSON::

        {
            "elements": [...],
            "input": {"name": "V1"},            # source element name
            "output": {"node": "out"}            # voltage at node
              -or-   {"from": "n1", "to": "n2"}  # voltage across nodes
              -or-   {"branch": "V1"}             # current through V source
        }

    Returns JSON: ``{ok, tf, errors}``.
    """
    try:
        circuit = json.loads(circuit_json)
        elements = circuit["elements"]

        input_spec = circuit.get("input")
        output_spec = circuit.get("output")

        if not input_spec or not output_spec:
            return _err(["'input' and 'output' must be specified in circuit JSON"])

        # Find input element
        input_name = input_spec.get("name")
        input_elem = None
        for el in elements:
            if el["name"] == input_name:
                input_elem = el
                break
        if input_elem is None:
            return _err([f"Input source '{input_name}' not found in circuit"])

        if input_elem["type"] not in ("V", "I"):
            return _err([f"Input source '{input_name}' must be a V or I source"])

        # Build MNA
        A, z, node_list, var_names, build_errors = _build_mna(elements)

        # Filter out warnings, keep real errors
        warnings = [e for e in build_errors if e.startswith("WARNING")]
        real_errors = [e for e in build_errors if not e.startswith("WARNING")]
        if real_errors:
            return _err(real_errors)

        n_total = A.rows
        node_idx = {nd: i for i, nd in enumerate(node_list)}

        # ----- Determine output variable index -----
        output_type = "voltage"
        output_idx: Optional[int] = None
        output_idx2: Optional[int] = None  # for differential output

        if "node" in output_spec:
            nd = _node_key(output_spec["node"])
            if nd == "0":
                return _err(["Output node cannot be ground"])
            if nd not in node_idx:
                return _err([f"Output node '{nd}' not found in circuit"])
            output_idx = node_idx[nd]
            output_type = "voltage"

        elif "from" in output_spec and "to" in output_spec:
            nd_from = _node_key(output_spec["from"])
            nd_to = _node_key(output_spec["to"])
            # V_from - V_to
            if nd_from != "0":
                if nd_from not in node_idx:
                    return _err([f"Output node '{nd_from}' not found"])
                output_idx = node_idx[nd_from]
            if nd_to != "0":
                if nd_to not in node_idx:
                    return _err([f"Output node '{nd_to}' not found"])
                output_idx2 = node_idx[nd_to]
            output_type = "voltage"

        elif "branch" in output_spec:
            br_name = output_spec["branch"]
            # Find branch current index
            group2 = [el["name"] for el in elements if el["type"] in ("V", "E", "O")]
            n_nodes = len(node_list)
            branch_map = {name: n_nodes + i for i, name in enumerate(group2)}
            if br_name not in branch_map:
                return _err([f"Branch '{br_name}' not found (only V/E/O have branch currents)"])
            output_idx = branch_map[br_name]
            output_type = "current"
        else:
            return _err(["Invalid output specification"])

        # ----- Build z_tf: z vector with ONLY the input source, value = 1 -----
        z_tf = zeros(n_total, 1)

        if input_elem["type"] == "V":
            # For voltage source: same stamp as original but Vs = 1
            group2 = [el["name"] for el in elements if el["type"] in ("V", "E", "O")]
            n_nodes = len(node_list)
            branch_map = {name: n_nodes + i for i, name in enumerate(group2)}
            i_row = branch_map[input_name]
            z_tf[i_row] = sp.Integer(1)

        elif input_elem["type"] == "I":
            # For current source: Is = 1
            n1 = input_elem.get("n1") or input_elem.get("np")
            n2 = input_elem.get("n2") or input_elem.get("nn")
            n1 = _node_key(n1)
            n2 = _node_key(n2)

            def ni_solve(node: str) -> Optional[int]:
                if node == "0":
                    return None
                return node_idx.get(node)

            np_i = ni_solve(n1)
            nn_i = ni_solve(n2)
            if np_i is not None:
                z_tf[np_i] += 1
            if nn_i is not None:
                z_tf[nn_i] -= 1

        # ----- Cramer's Rule -----
        # det(A) via berkowitz
        det_A = A.berkowitz_det()

        if det_A == 0:
            return _err(["Singular MNA matrix — circuit may have errors"])

        # For single-node output
        if output_idx is not None and output_idx2 is None:
            # Replace column output_idx with z_tf
            A_k = A.copy()
            for row in range(n_total):
                A_k[row, output_idx] = z_tf[row]
            det_Ak = A_k.berkowitz_det()
            H_raw = det_Ak / det_A

        elif output_idx is not None and output_idx2 is not None:
            # Differential: H = H_from - H_to
            A_k1 = A.copy()
            for row in range(n_total):
                A_k1[row, output_idx] = z_tf[row]
            det_Ak1 = A_k1.berkowitz_det()

            A_k2 = A.copy()
            for row in range(n_total):
                A_k2[row, output_idx2] = z_tf[row]
            det_Ak2 = A_k2.berkowitz_det()

            H_raw = (det_Ak1 - det_Ak2) / det_A

        elif output_idx is None and output_idx2 is not None:
            # output_from is ground: H = 0 - H_to = -H_to
            A_k2 = A.copy()
            for row in range(n_total):
                A_k2[row, output_idx2] = z_tf[row]
            det_Ak2 = A_k2.berkowitz_det()
            H_raw = -det_Ak2 / det_A
        else:
            return _err(["Could not determine output variable index"])

        # Simplify
        H_simplified = cancel(H_raw)
        num_expr, den_expr = fraction(H_simplified)

        # Build polynomials in s
        try:
            num_poly = Poly(sp.expand(num_expr), s)
        except sp.PolynomialError:
            num_poly = Poly(num_expr, s, domain="EX")

        try:
            den_poly = Poly(sp.expand(den_expr), s)
        except sp.PolynomialError:
            den_poly = Poly(den_expr, s, domain="EX")

        # Normalize: divide all by leading coefficient of denominator
        den_lc = den_poly.LC()
        if den_lc != 0 and den_lc != 1:
            num_expr_norm = sp.cancel(num_expr / den_lc)
            den_expr_norm = sp.cancel(den_expr / den_lc)
            try:
                num_poly = Poly(sp.expand(num_expr_norm), s)
            except sp.PolynomialError:
                num_poly = Poly(num_expr_norm, s, domain="EX")
            try:
                den_poly = Poly(sp.expand(den_expr_norm), s)
            except sp.PolynomialError:
                den_poly = Poly(den_expr_norm, s, domain="EX")
            H_simplified = sp.cancel(num_expr_norm / den_expr_norm)

        num_coeffs = _extract_coeffs(num_poly)
        den_coeffs = _extract_coeffs(den_poly)

        # Determine transfer-function kind
        kind = _determine_tf_kind(input_elem, output_type)

        # Collect all symbols
        all_syms = set()
        for c in num_poly.all_coeffs() + den_poly.all_coeffs():
            all_syms.update(str(sym) for sym in sp.sympify(c).free_symbols if sym != s)

        tf = {
            "num_coeffs": num_coeffs,
            "den_coeffs": den_coeffs,
            "num_degree": num_poly.degree(),
            "den_degree": den_poly.degree(),
            "symbols": sorted(all_syms),
            "latex": _display_latex(H_simplified),
            "kind": kind,
            "H_expr": str(H_simplified),
        }

        result: Dict[str, Any] = {"tf": tf, "errors": warnings}
        return _ok(result)

    except Exception as exc:
        return _err([f"solve failed: {exc}"])


# ===================================================================
#  Substitution
# ===================================================================

def substitute(tf_json: str, subs_map_json: str) -> str:
    """Substitute numeric or symbolic values into the transfer function.

    ``subs_map_json``: ``{"R1": "1000", "C1": "1e-9", ...}``

    Returns JSON: ``{ok, tf, fully_numeric}``.
    """
    try:
        tf_data = json.loads(tf_json)
        subs_map = json.loads(subs_map_json)

        H_expr = sp.sympify(tf_data["H_expr"])

        # Build substitution dict — match symbols by name from the expression
        # so that assumptions (positive=True vs. default) don't cause mismatches.
        expr_syms = {str(sym): sym for sym in H_expr.free_symbols}
        sub_dict: Dict[Symbol, sp.Expr] = {}
        for name, val in subs_map.items():
            if name in expr_syms:
                sub_dict[expr_syms[name]] = sp.sympify(str(val))
            else:
                # Symbol not in expression — try both with and without assumptions
                sub_dict[Symbol(name)] = sp.sympify(str(val))
                sub_dict[Symbol(name, positive=True)] = sp.sympify(str(val))

        H_sub = H_expr.subs(sub_dict)
        H_sub = cancel(H_sub)
        num_expr, den_expr = fraction(H_sub)

        try:
            num_poly = Poly(sp.expand(num_expr), s)
        except sp.PolynomialError:
            num_poly = Poly(num_expr, s, domain="EX")

        try:
            den_poly = Poly(sp.expand(den_expr), s)
        except sp.PolynomialError:
            den_poly = Poly(den_expr, s, domain="EX")

        # Normalize
        den_lc = den_poly.LC()
        if den_lc != 0 and den_lc != 1:
            num_expr = sp.cancel(num_expr / den_lc)
            den_expr = sp.cancel(den_expr / den_lc)
            try:
                num_poly = Poly(sp.expand(num_expr), s)
            except sp.PolynomialError:
                num_poly = Poly(num_expr, s, domain="EX")
            try:
                den_poly = Poly(sp.expand(den_expr), s)
            except sp.PolynomialError:
                den_poly = Poly(den_expr, s, domain="EX")
            H_sub = sp.cancel(num_expr / den_expr)

        num_coeffs = _extract_coeffs(num_poly)
        den_coeffs = _extract_coeffs(den_poly)

        # Check if fully numeric
        remaining_syms = set()
        for c in num_poly.all_coeffs() + den_poly.all_coeffs():
            remaining_syms.update(
                str(sym) for sym in sp.sympify(c).free_symbols if sym != s
            )
        fully_numeric = len(remaining_syms) == 0

        tf_out = {
            "num_coeffs": num_coeffs,
            "den_coeffs": den_coeffs,
            "num_degree": num_poly.degree(),
            "den_degree": den_poly.degree(),
            "symbols": sorted(remaining_syms),
            "latex": _display_latex(H_sub),
            "kind": tf_data.get("kind", "voltage_gain"),
            "H_expr": str(H_sub),
        }

        return _ok({"tf": tf_out, "fully_numeric": fully_numeric})

    except Exception as exc:
        return _err([f"substitute failed: {exc}"])


# ===================================================================
#  Poles & Zeros
# ===================================================================

def _num_latex(x: float) -> str:
    """LaTeX for a real number at 4 significant figures.

    ``%g`` gives compact output but writes large/small values as ``1e+06``,
    which KaTeX shows verbatim; rewrite the exponent as ``\\times 10^{6}`` so it
    typesets like the rest of the math.
    """
    if x == 0:
        return "0"
    text = f"{x:.4g}"
    m = re.fullmatch(r"(-?\d+(?:\.\d+)?)[eE]([+-]?\d+)", text)
    if not m:
        return text
    mant, exp = m.group(1), int(m.group(2))
    if mant == "1":
        return f"10^{{{exp}}}"
    if mant == "-1":
        return f"-10^{{{exp}}}"
    return f"{mant} \\times 10^{{{exp}}}"


def _numeric_root_entry(r: complex) -> Dict[str, Any]:
    """Describe one complex root: its s-plane value, and the frequency it maps to.

    A root at s = -a (rad/s) is a corner at f = |s| / 2*pi Hz -- the same axis
    the Bode plot uses -- so poles/zeros can be read against the curve.
    """
    re_v = float(r.real)
    im_v = float(r.imag)
    # numpy hands back a whisker of imaginary part on real roots; clean it so a
    # real pole reads as real, not "-1000 + 3e-13 i".
    scale = max(abs(re_v), abs(im_v), 1.0)
    if abs(im_v) < 1e-9 * scale:
        im_v = 0.0

    if im_v == 0.0:
        latex = _num_latex(re_v)
    else:
        sign = "+" if im_v >= 0 else "-"
        latex = f"{_num_latex(re_v)} {sign} {_num_latex(abs(im_v))}i"

    f_hz = math.hypot(re_v, im_v) / (2.0 * math.pi)
    return {
        "latex": latex,
        "re": re_v,
        "im": im_v,
        "f_hz": f_hz,
        "numeric": True,
    }


def _roots_of(coeffs: List[str], numeric: bool) -> Tuple[List[Dict[str, Any]], str]:
    """Roots of a polynomial given as highest-degree-first coefficient strings.

    Returns ``(entries, note)``. Numeric coefficients are rooted with numpy (any
    degree); symbolic ones with ``sympy.roots`` (closed form up to quartics, and
    whatever else factors). ``note`` flags roots that have no closed form.
    """
    exprs = [sp.sympify(c) for c in coeffs]
    # Defensive: a leading-zero coefficient would make numpy miscount the degree.
    while exprs and exprs[0] == 0:
        exprs = exprs[1:]
    degree = len(exprs) - 1
    if degree < 1:
        return [], ""

    if numeric:
        import numpy as np
        fc = [complex(e) for e in exprs]
        rts = np.roots(fc)
        out = [_numeric_root_entry(complex(r)) for r in rts]
        # Lowest corner first -- reads like the Bode axis, left to right.
        out.sort(key=lambda d: d["f_hz"])
        return out, ""

    expr = sum(c * s ** (degree - i) for i, c in enumerate(exprs))
    poly = Poly(expr, s)
    try:
        rdict = sp.roots(poly)
    except Exception:
        rdict = {}
    total = sum(rdict.values()) if rdict else 0
    out: List[Dict[str, Any]] = []
    for r, mult in rdict.items():
        for _ in range(mult):
            out.append({
                "latex": _display_latex(r),
                "expr": str(r),
                "f_hz": None,
                "numeric": False,
            })
    note = ""
    if total < degree:
        missing = degree - total
        note = (f"{missing} root{'s' if missing > 1 else ''} have no closed form "
                f"(degree {degree}); substitute values to get them numerically")
    return out, note


def poles_zeros(tf_json: str) -> str:
    """List the zeros (numerator roots) and poles (denominator roots) of H(s).

    Input is a ``tf`` dict (as produced by :func:`solve` / :func:`substitute` /
    :func:`approximate`). Fully numeric transfer functions yield numeric roots
    with their corner frequencies; symbolic ones yield closed-form roots where
    they exist.

    Returns JSON: ``{ok, zeros, poles, numeric, notes}``.
    """
    try:
        tf_data = json.loads(tf_json)
        num_coeffs = tf_data.get("num_coeffs", [])
        den_coeffs = tf_data.get("den_coeffs", [])

        def _all_numeric(coeffs: List[str]) -> bool:
            return all(not sp.sympify(c).free_symbols for c in coeffs)

        numeric = _all_numeric(num_coeffs) and _all_numeric(den_coeffs)

        zeros_out, z_note = _roots_of(num_coeffs, numeric)
        poles_out, p_note = _roots_of(den_coeffs, numeric)

        notes: List[str] = []
        if z_note:
            notes.append("Zeros: " + z_note)
        if p_note:
            notes.append("Poles: " + p_note)

        return _ok({
            "zeros": zeros_out,
            "poles": poles_out,
            "numeric": numeric,
            "notes": notes,
        })
    except Exception as exc:
        return _err([f"poles_zeros failed: {exc}"])


# ===================================================================
#  Approximation
# ===================================================================

def _approx_limit(H_expr: sp.Expr, direction: str) -> sp.Expr:
    """DC (s→0) or HF (s→∞) limit."""
    if direction == "dc":
        return sp.limit(H_expr, s, 0)
    elif direction == "hf":
        return sp.limit(H_expr, s, oo)
    else:
        raise ValueError(f"Unknown limit direction '{direction}'")


def _approx_truncate(
    H_expr: sp.Expr, max_num_order: int, max_den_order: int
) -> Tuple[sp.Expr, List[str]]:
    """Truncate numerator/denominator to specified polynomial orders in s."""
    num_expr, den_expr = fraction(cancel(H_expr))
    dropped: List[str] = []

    def truncate_poly(expr: sp.Expr, max_order: int, label: str) -> sp.Expr:
        poly = Poly(sp.expand(expr), s)
        coeffs = poly.all_coeffs()  # highest degree first
        degree = poly.degree()
        new_expr = sp.Integer(0)
        for i, c in enumerate(coeffs):
            power = degree - i
            if power <= max_order:
                new_expr += c * s**power
            elif c != 0:
                dropped.append(f"{label}: dropped s^{power} term ({c}*s^{power})")
        return new_expr

    num_trunc = truncate_poly(num_expr, max_num_order, "numerator")
    den_trunc = truncate_poly(den_expr, max_den_order, "denominator")

    return cancel(num_trunc / den_trunc), dropped


def _monomial_content(term: sp.Expr, base: sp.Expr) -> int:
    """How many whole copies of monomial *base* divide *term*, symbol-wise.

    content(gm**2 * ro**2 * RL, gm*ro) == 2;  content(RL, gm*ro) == 0.
    Numeric factors are ignored -- "2*gm >> 1" weighs terms by gm alone.
    """
    k: Optional[int] = None
    for x, p in base.as_powers_dict().items():
        if x.is_number:
            continue
        d = sp.degree(term, x) if x in term.free_symbols else 0
        c = int(d // p)
        k = c if k is None else min(k, c)
    return 0 if k is None else k


def _approx_assumption(
    H_expr: sp.Expr, large_expr: sp.Expr, small_expr: sp.Expr
) -> Tuple[sp.Expr, List[str]]:
    """Apply 'A >> B' where A and B are monomials (products of symbols).

    Every additive term of each s^k coefficient is ranked by
        order(T) = content(T, A) - content(T, B)
    and only the maximum-order terms are kept: more copies of the large
    quantity beat fewer, copies of the small quantity count against. With A
    and B single symbols this reduces exactly to degree(A) - degree(B), the
    behaviour the single-symbol implementation had; with B = 1 it keeps the
    highest A-content, which is what "A >> 1" means. Supporting monomials is
    what the base spec's T8 form "gm*R >> 1" requires -- the old parser only
    accepted bare names and rejected it.
    """
    num_expr, den_expr = fraction(cancel(H_expr))
    dropped: List[str] = []

    def process_poly(expr: sp.Expr, label: str) -> sp.Expr:
        poly = Poly(sp.expand(expr), s)
        coeffs = poly.all_coeffs()
        degree = poly.degree()
        new_expr = sp.Integer(0)

        for i, c in enumerate(coeffs):
            power = degree - i
            terms = sp.Add.make_args(sp.expand(c))
            if len(terms) <= 1:
                new_expr += c * s**power
                continue

            orders = [
                _monomial_content(t, large_expr) - _monomial_content(t, small_expr)
                for t in terms
            ]
            max_order = max(orders)
            kept = sp.Integer(0)
            for term, order in zip(terms, orders):
                if order == max_order:
                    kept += term
                else:
                    dropped.append(
                        f"{label} s^{power}: dropped {term} (order {order} < {max_order})"
                    )
            new_expr += kept * s**power

        return new_expr

    num_approx = process_poly(num_expr, "num")
    den_approx = process_poly(den_expr, "den")

    return cancel(num_approx / den_approx), dropped


def _approx_numerical(
    H_expr: sp.Expr, typical_values: Dict[str, float], threshold: float
) -> Tuple[sp.Expr, List[str]]:
    """Drop terms whose numerical contribution is below *threshold* (relative)."""
    num_expr, den_expr = fraction(cancel(H_expr))
    dropped: List[str] = []

    # Build substitution dict for numerical evaluation — match by name
    all_syms = {}
    for sym_obj in H_expr.free_symbols:
        all_syms[str(sym_obj)] = sym_obj
    sub_dict = {}
    for k, v in typical_values.items():
        if k in all_syms:
            sub_dict[all_syms[k]] = sp.Float(v)
        else:
            sub_dict[Symbol(k)] = sp.Float(v)
            sub_dict[Symbol(k, positive=True)] = sp.Float(v)

    def process_poly(expr: sp.Expr, label: str) -> sp.Expr:
        poly = Poly(sp.expand(expr), s)
        coeffs = poly.all_coeffs()
        degree = poly.degree()
        new_expr = sp.Integer(0)

        for i, c in enumerate(coeffs):
            power = degree - i
            c_expanded = sp.expand(c)
            terms = sp.Add.make_args(c_expanded)

            if len(terms) <= 1:
                new_expr += c * s**power
                continue

            # Evaluate each term numerically
            term_vals = []
            for term in terms:
                try:
                    val = float(abs(sp.sympify(term).subs(sub_dict)))
                except (TypeError, ValueError):
                    val = float("inf")  # keep terms we can't evaluate
                term_vals.append(val)

            max_val = max(term_vals) if term_vals else 1.0
            if max_val == 0:
                new_expr += c * s**power
                continue

            kept = sp.Integer(0)
            for term, val in zip(terms, term_vals):
                if val / max_val >= threshold:
                    kept += term
                else:
                    dropped.append(
                        f"{label} s^{power}: dropped {term} (relative magnitude {val/max_val:.4g} < {threshold})"
                    )

            new_expr += kept * s**power

        return new_expr

    num_approx = process_poly(num_expr, "num")
    den_approx = process_poly(den_expr, "den")

    return cancel(num_approx / den_approx), dropped


def approximate(tf_json: str, spec_json: str) -> str:
    """Apply an approximation to the transfer function.

    Modes:
        - ``limit``: ``{mode:'limit', direction:'dc'|'hf'}``
        - ``truncate``: ``{mode:'truncate', max_num_order:N, max_den_order:N}``
        - ``assumption``: ``{mode:'assumption', assumptions:['ro >> RL', 'A >> 1']}``
        - ``numerical``: ``{mode:'numerical', typical_values:{...}, threshold:0.01}``

    Returns JSON: ``{ok, tf_approx, dropped_terms, latex}``.
    """
    try:
        tf_data = json.loads(tf_json)
        spec = json.loads(spec_json)

        local_dict = {'s': s}
        for sym_name in tf_data.get('symbols', []):
            local_dict[sym_name] = Symbol(sym_name, positive=True)

        H_expr = sp.sympify(tf_data["H_expr"], locals=local_dict)
        mode = spec.get("mode")
        dropped_all: List[str] = []

        if mode == "limit":
            direction = spec.get("direction", "dc")
            H_approx = _approx_limit(H_expr, direction)
            # Limit result may be a constant
            num_expr_out, den_expr_out = fraction(H_approx)

        elif mode == "truncate":
            max_num = spec.get("max_num_order", 1)
            max_den = spec.get("max_den_order", 1)
            H_approx, dropped_all = _approx_truncate(H_expr, max_num, max_den)

        elif mode == "assumption":
            assumptions = spec.get("assumptions", [])
            H_approx = H_expr
            for assumption_str in assumptions:
                assumption_str = assumption_str.strip()
                # "A >> B" with A, B monomials: gm*ro >> 1, ro >> RL, ...
                parts = assumption_str.split(">>")
                if len(parts) != 2:
                    return _err([f"Cannot parse assumption: '{assumption_str}' (expected 'A >> B')"])
                try:
                    large_expr = sp.sympify(parts[0].strip(), locals=local_dict)
                    small_expr = sp.sympify(parts[1].strip(), locals=local_dict)
                except Exception:
                    return _err([f"Cannot parse assumption: '{assumption_str}'"])
                for side, expr in (("left", large_expr), ("right", small_expr)):
                    if expr.is_Add:
                        return _err([
                            f"Assumption '{assumption_str}': the {side} side must be "
                            "a product of symbols (sums are not supported)"])

                H_approx, dropped = _approx_assumption(H_approx, large_expr, small_expr)
                dropped_all.extend(dropped)

        elif mode == "numerical":
            typical_values = spec.get("typical_values", {})
            threshold_val = spec.get("threshold", 0.01)
            H_approx, dropped_all = _approx_numerical(H_expr, typical_values, threshold_val)

        else:
            return _err([f"Unknown approximation mode: '{mode}'"])

        # Build output TF
        H_approx = cancel(H_approx)
        num_expr_out, den_expr_out = fraction(H_approx)

        try:
            num_poly = Poly(sp.expand(num_expr_out), s)
        except sp.PolynomialError:
            num_poly = Poly(num_expr_out, s, domain="EX")

        try:
            den_poly = Poly(sp.expand(den_expr_out), s)
        except sp.PolynomialError:
            den_poly = Poly(den_expr_out, s, domain="EX")

        # Normalize
        den_lc = den_poly.LC()
        if den_lc != 0 and den_lc != 1:
            num_expr_out = sp.cancel(num_expr_out / den_lc)
            den_expr_out = sp.cancel(den_expr_out / den_lc)
            try:
                num_poly = Poly(sp.expand(num_expr_out), s)
            except sp.PolynomialError:
                num_poly = Poly(num_expr_out, s, domain="EX")
            try:
                den_poly = Poly(sp.expand(den_expr_out), s)
            except sp.PolynomialError:
                den_poly = Poly(den_expr_out, s, domain="EX")
            H_approx = sp.cancel(num_expr_out / den_expr_out)

        num_coeffs = _extract_coeffs(num_poly)
        den_coeffs = _extract_coeffs(den_poly)

        all_syms = set()
        for c in num_poly.all_coeffs() + den_poly.all_coeffs():
            all_syms.update(str(sym) for sym in sp.sympify(c).free_symbols if sym != s)

        tf_approx = {
            "num_coeffs": num_coeffs,
            "den_coeffs": den_coeffs,
            "num_degree": num_poly.degree(),
            "den_degree": den_poly.degree(),
            "symbols": sorted(all_syms),
            "latex": _display_latex(H_approx),
            "kind": tf_data.get("kind", "voltage_gain"),
            "H_expr": str(H_approx),
        }

        return _ok({
            "tf_approx": tf_approx,
            "dropped_terms": dropped_all,
            "latex": _display_latex(H_approx),
        })

    except Exception as exc:
        return _err([f"approximate failed: {exc}"])


# ===================================================================
#  Frequency Response
# ===================================================================

def freq_response(tf_json: str, range_json: str) -> str:
    """Compute numerical frequency response.

    ``range_json``::

        {
            "f_start": 1,          # Hz
            "f_end": 1e9,          # Hz
            "n_points": 200,       # number of log-spaced points
            "values": {"R1": 1000} # substitution for all remaining symbols
        }

    Returns JSON: ``{ok, data}`` where data = ``{f, mag_db, phase_deg, re, im}``.
    """
    try:
        import numpy as np

        tf_data = json.loads(tf_json)
        rng = json.loads(range_json)

        H_expr = sp.sympify(tf_data["H_expr"])

        # Substitute all remaining symbolic values
        values = rng.get("values", {})
        expr_syms = {str(sym): sym for sym in H_expr.free_symbols}
        sub_dict = {}
        for k, v in values.items():
            if k in expr_syms:
                sub_dict[expr_syms[k]] = sp.Float(v)
            else:
                sub_dict[Symbol(k)] = sp.Float(v)
                sub_dict[Symbol(k, positive=True)] = sp.Float(v)
        H_sub = H_expr.subs(sub_dict)

        # Check that only s remains
        remaining = H_sub.free_symbols - {s}
        if remaining:
            return _err([
                f"Symbols still present after substitution: {sorted(str(r) for r in remaining)}. "
                "Provide values for all symbols."
            ])

        # Lambdify
        H_func = sp.lambdify(s, H_sub, modules="numpy")

        f_start = float(rng.get("f_start", 1.0))
        f_end = float(rng.get("f_end", 1e9))
        n_points = int(rng.get("n_points", 200))

        f_arr = np.logspace(np.log10(f_start), np.log10(f_end), n_points)
        s_arr = 1j * 2 * np.pi * f_arr  # s = j*omega

        H_arr = H_func(s_arr)

        # Ensure array
        if np.isscalar(H_arr):
            H_arr = np.full_like(f_arr, H_arr, dtype=complex)

        mag = np.abs(H_arr)
        # Avoid log10(0)
        mag_safe = np.where(mag > 0, mag, 1e-300)
        mag_db = 20.0 * np.log10(mag_safe)

        phase_rad = np.angle(H_arr)
        phase_unwrapped = np.unwrap(phase_rad)
        phase_deg = np.degrees(phase_unwrapped)

        data = {
            "f": f_arr.tolist(),
            "mag_db": mag_db.tolist(),
            "phase_deg": phase_deg.tolist(),
            "re": np.real(H_arr).tolist(),
            "im": np.imag(H_arr).tolist(),
        }

        return _ok({"data": data})

    except Exception as exc:
        return _err([f"freq_response failed: {exc}"])


# ===================================================================
#  Quick self-test (only when run directly)
# ===================================================================

if __name__ == "__main__":
    # Simple RC low-pass filter test
    netlist = """
* RC Low-Pass Filter
R1 in out R
C1 out 0 C
V1 in 0 Vs
"""
    print("=== parse_netlist ===")
    parsed = parse_netlist(netlist)
    parsed_obj = json.loads(parsed)
    print(json.dumps(parsed_obj, indent=2))

    if parsed_obj["ok"]:
        circuit = json.loads(parsed_obj["circuit_json"])
        circuit["input"] = {"name": "V1"}
        circuit["output"] = {"node": "out"}
        circuit_json = json.dumps(circuit)

        print("\n=== solve ===")
        result = solve(circuit_json)
        result_obj = json.loads(result)
        print(json.dumps(result_obj, indent=2))

        if result_obj["ok"]:
            tf = result_obj["tf"]
            print(f"\nH(s) = {tf['H_expr']}")
            print(f"LaTeX: {tf['latex']}")

            # Substitution
            print("\n=== substitute R=1k, C=1n ===")
            sub_result = substitute(
                json.dumps(tf),
                json.dumps({"R": "1000", "C": "1e-9"})
            )
            sub_obj = json.loads(sub_result)
            print(json.dumps(sub_obj, indent=2))

            # DC limit approximation
            print("\n=== approximate (DC limit) ===")
            approx_result = approximate(
                json.dumps(tf),
                json.dumps({"mode": "limit", "direction": "dc"})
            )
            print(json.dumps(json.loads(approx_result), indent=2))

            # Frequency response (numeric)
            if sub_obj["ok"]:
                print("\n=== freq_response ===")
                fr_result = freq_response(
                    json.dumps(sub_obj["tf"]),
                    json.dumps({
                        "f_start": 1,
                        "f_end": 1e9,
                        "n_points": 10,
                    })
                )
                fr_obj = json.loads(fr_result)
                if fr_obj["ok"]:
                    data = fr_obj["data"]
                    print(f"  f points: {len(data['f'])}")
                    print(f"  mag_db[0]: {data['mag_db'][0]:.2f} dB")
                    print(f"  phase_deg[0]: {data['phase_deg'][0]:.2f} deg")
                else:
                    print(json.dumps(fr_obj, indent=2))
