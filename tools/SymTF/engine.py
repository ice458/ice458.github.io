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

# Performance limits. The old hard cap (_MAX_SIZE) existed because the legacy
# Cramer/berkowitz path could hang the browser on a large symbolic system. The
# fast solver replaces that with a term-count guard (_MAX_TERMS) which fires on
# the actual blow-up (an intermediate fraction exploding), not a proxy for it,
# so there is no fixed size ceiling any more. _WARN_SIZE still flags systems
# large enough that a fully-symbolic solve may be slow.
_WARN_SIZE = 14
# Per-entry monomial-count guard for the fast solver. Empirically the answer
# (and every intermediate fraction) of a genuinely useful symbolic solve stays
# small -- a fully-symbolic 4-stage active filter peaks around 260 monomials --
# while a structure whose flat symbolic form explodes (a long RC ladder, a deep
# op-amp cascade) grows past this within a step or two. It is checked on the
# OPERANDS of each fraction op, not just results, because one gcd reduction on
# two large multivariate fractions runs uninterruptibly for tens of seconds --
# so a large operand must be caught before it is used, not after. Tripping the
# guard means "this circuit's symbolic answer is huge; solve it numerically."
_MAX_TERMS = 500

# Effort presets for the fast solver, selected by options.effort.
#
#   quick — the default, tuned for the interactive loop (auto re-analysis on
#           every edit): a small entry cap aborts hopeless circuits in well
#           under a second.
#   long  — user-invoked "spend real time on it": a much larger entry cap
#           admits bigger intermediates (an 8-stage RC ladder passes through
#           ~8600-term entries on its way to a 29s solve), and a *product* cap
#           bounds the cost of each individual fraction op instead. The product
#           cap is what actually keeps a runaway op in check: gcd-heavy systems
#           (a 4-stage MFB cascade) have single reductions that run for minutes
#           uninterruptibly, and they reach large×large operand products long
#           before the entry cap trips -- while the ladder's big entries only
#           ever multiply small partners (~large×20), far under the cap.
# max_vars (bounding the number of ring generators) used to refuse a long solve
# up front once too many symbols were left free -- the argument being that
# multivariate gcd is exponential in the variable count and a single gcd is
# uninterruptible, so a 20-symbol system could burn minutes on one op with no
# way to stop it. That argument no longer holds: Cancel terminates the whole
# Web Worker (SymPy cannot be interrupted in-process on GitHub Pages, so cancel
# has always meant terminate + respawn), which kills even a mid-flight gcd. So
# there is no element/symbol-count ceiling any more -- if the user asks for a
# large fully-symbolic solve, we attempt it and let them press Cancel when they
# decide it is taking too long. This is the same call made when the wall-clock
# budget was removed: the UI never freezes, so the user, not a structural count,
# owns the stop. The remaining term/product caps are cheap explosion predictors
# (they fire in well under a second and route the interactive 'quick' path to
# numeric mode fast); they are size guards, not a limit on how big a circuit may
# be. max_vars is kept as None so the field stays explicit at every call site.
_EFFORT_LIMITS = {
    "quick": {"max_terms": _MAX_TERMS, "max_product": None, "max_vars": None},
    "long": {"max_terms": 12000, "max_product": 1_000_000, "max_vars": None},
}


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


# A small LRU of parsed transfer functions, keyed by the exact H_expr string.
# substitute() / freq_response() run on every value keystroke, and each re-parses
# the same (possibly multi-kByte) H_expr from scratch -- sympify is 7-23% of a
# substitute. The worker is long-lived, so caching the parse across calls turns
# those repeats into a dict lookup. Keyed by the literal string, so it is
# assumption-agnostic and never returns a stale expression for a changed H.
_SYMPIFY_CACHE: "OrderedDict[str, sp.Expr]" = OrderedDict()
_SYMPIFY_CACHE_MAX = 8


def _cached_sympify(expr_str: str) -> sp.Expr:
    """``sp.sympify(expr_str)`` with an LRU cache (plain, no ``locals``)."""
    hit = _SYMPIFY_CACHE.get(expr_str)
    if hit is not None:
        _SYMPIFY_CACHE.move_to_end(expr_str)
        return hit
    expr = sp.sympify(expr_str)
    _SYMPIFY_CACHE[expr_str] = expr
    while len(_SYMPIFY_CACHE) > _SYMPIFY_CACHE_MAX:
        _SYMPIFY_CACHE.popitem(last=False)
    return expr


# A small LRU of eliminated solution vectors, keyed by everything that fixes the
# elimination -- the elements, the input source, any substituted values, and the
# effort preset -- but NOT the output port. The Gaussian elimination solves for
# every node voltage and branch current at once, so switching the output (or
# round-tripping ports, or undo/redo landing on a prior circuit) only needs a
# different component selected from the same vector. Caching it turns those
# re-solves into a lookup. Small (a couple of entries) because each holds a full
# symbolic solution; cleared with the worker on Cancel.
_ELIM_CACHE: "OrderedDict[str, tuple]" = OrderedDict()
_ELIM_CACHE_MAX = 3


def _ok(payload: dict) -> str:
    payload["ok"] = True
    return json.dumps(payload, default=str)


def _err(messages: List[str], **extra) -> str:
    payload = {"ok": False, "errors": messages}
    payload.update(extra)
    return json.dumps(payload, default=str)


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

    # No hard size cap: the fast solver's term-count guard handles blow-up.
    # A large system may still be slow to solve fully symbolically, so warn.
    if n_total > _WARN_SIZE:
        errors.append(
            f"WARNING: system size {n_total} is large; a fully-symbolic solve "
            f"may be slow. Enter component values to solve numerically instead.")

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


# ===================================================================
#  Fast sparse solver (fraction field + Markowitz elimination)
# ===================================================================
#
# The legacy path builds H(s) with Cramer's rule and berkowitz determinants,
# then cancel()s the result. On anything past a handful of elements the
# cancel/expand step blows up (see plans/speedup-plan.md): the determinant's
# unexpanded product-of-sums form hides massive term duplication that only
# surfaces when it is normalised.
#
# This solver instead solves A·x = z once, directly over the field of
# fractions of ZZ[s, R1, ...], keeping every entry reduced (numerator and
# denominator coprime) at all times. Standard Gaussian elimination -- NOT
# fraction-free -- so a row with a zero in the pivot column is left untouched
# and MNA sparsity survives, which is what makes cascaded active filters
# tractable. Markowitz pivoting minimises fill-in.
#
# The transfer function is a single component of x (or a difference of two for
# a differential output), so no extra eliminations are needed regardless of
# output kind.

# A placeholder symbol for pi, so finite-gain op-amp entries (which carry a
# literal pi) embed in the polynomial ring; mapped back to sp.pi on the way out.
_PI_SYM = sp.Symbol("_pi_")


class _SolverFallback(Exception):
    """The fast solver cannot handle this system; use the legacy path."""


class _SolverTooLarge(Exception):
    """An intermediate expression exceeded the term-count guard."""


def _markowitz_choose(rows, live_rows, live_cols):
    """Pick the (row, col) pivot minimising Markowitz fill cost.

    cost = (row_nnz - 1) * (col_nnz - 1), tie-broken by smaller numerator.
    Returns (row, col) or (None, None) if no nonzero live entry remains.
    """
    col_count: Dict[int, int] = {}
    for i in live_rows:
        for c in rows[i]:
            if c in live_cols:
                col_count[c] = col_count.get(c, 0) + 1
    best_key = None
    best = (None, None)
    for i in live_rows:
        r_nnz = sum(1 for c in rows[i] if c in live_cols)
        for c, v in rows[i].items():
            if c not in live_cols:
                continue
            key = ((r_nnz - 1) * (col_count[c] - 1), len(v.numer) + len(v.denom))
            if best_key is None or key < best_key:
                best_key = key
                best = (i, c)
    return best


def _frac_eliminate(
    A: sp.Matrix,
    z_tf: sp.Matrix,
    max_terms: int = 50000,
    max_product: Optional[int] = None,
    max_vars: Optional[int] = None,
):
    """Solve A·x = z_tf over the fraction field, returning ``(x, F, has_pi)``.

    ``x`` is the full solution vector as a ``{col_index: FracElement}`` dict over
    the field ``F`` (fractions of ``ZZ[s, R1, ...]``); ``has_pi`` records whether
    ``sp.pi`` was mapped to the placeholder generator on the way in.

    The elimination does not depend on which output is asked for -- every node
    voltage and branch current ends up in ``x`` -- so a caller that changes only
    the output port can reuse this result and just select a different component
    (see the elimination cache in :func:`solve`).

    Raises :class:`_SolverFallback` if the entries cannot be embedded in a
    polynomial ring; :class:`_SolverTooLarge` if the operand guards
    (*max_terms* monomials, *max_product* op cost, *max_vars* generators) trip.
    All guards are structural and fire fast -- there is no wall-clock limit;
    a long solve is bounded by the user pressing Cancel, not by a timer.
    """
    from sympy.polys.fields import field
    from sympy import ZZ
    from sympy.polys.polyerrors import CoercionFailed, GeneratorsError, PolynomialError

    _EMBED_ERRORS = (CoercionFailed, GeneratorsError, PolynomialError, ValueError, TypeError)

    n = A.rows

    # pi -> placeholder so the ring embedding sees only Symbols.
    has_pi = any(A[i, j].has(sp.pi) for i in range(n) for j in range(n)) or \
        any(z_tf[i].has(sp.pi) for i in range(n))
    A_ent = A
    z_ent = z_tf
    if has_pi:
        A_ent = A.applyfunc(lambda e: e.subs(sp.pi, _PI_SYM))
        z_ent = z_tf.applyfunc(lambda e: e.subs(sp.pi, _PI_SYM))

    syms = set()
    for i in range(n):
        for j in range(n):
            syms |= A_ent[i, j].free_symbols
        syms |= z_ent[i].free_symbols
    names = sorted(str(x) for x in syms)
    if not names:
        names = ["s"]   # a fully-numeric system still needs a ring variable

    # Optional up-front refusal when there are too many ring variables. No preset
    # sets this any more (Cancel terminates the worker, so even an uninterruptible
    # multivariate gcd can be stopped), but the guard is kept for a caller that
    # wants to cap generators before elimination starts rather than during it.
    if max_vars is not None and len(names) > max_vars:
        n_free = len([x for x in syms if x != s and x != _PI_SYM])
        raise _SolverTooLarge(f"{n_free} symbols still free")

    try:
        F = field(",".join(names), ZZ)[0]
        # sparse augmented rows: row -> {col: FracElement}, rhs at column n.
        rows: Dict[int, Dict[int, Any]] = {}
        for i in range(n):
            r: Dict[int, Any] = {}
            for j in range(n):
                e = A_ent[i, j]
                if e != 0:
                    r[j] = F.from_expr(e)
            zi = z_ent[i]
            if zi != 0:
                r[n] = F.from_expr(zi)
            rows[i] = r
    except _EMBED_ERRORS as exc:
        raise _SolverFallback(str(exc))

    def _sz(e) -> int:
        return len(e.numer) + len(e.denom)

    def _guard(e):
        """Abort on any entry whose monomial count crosses the term guard.

        Checked on operands BEFORE they feed another fraction op, not just on
        results: a single gcd reduction on two large multivariate fractions can
        run for tens of seconds uninterruptibly, so the size has to be caught
        before the expensive operation starts, not after it returns.
        """
        if _sz(e) > max_terms:
            raise _SolverTooLarge(f"~{_sz(e)} terms")
        return e

    def _op_guard(a, b):
        """Abort before a fraction op whose operand-size product is too big.

        The cost of a FracElement multiply/divide is governed by the product of
        the operand sizes (the gcd runs over that many term pairs), and it is
        uninterruptible once started. Under the large-entry 'long' preset this
        is the guard that keeps wall time honest: a ladder's big intermediates
        only ever meet small partners (cheap), while a gcd-heavy cascade
        reaches large×large products -- and minutes-long single ops -- well
        before its entries trip the term cap.
        """
        if max_product is not None and _sz(a) * _sz(b) > max_product:
            raise _SolverTooLarge(f"op cost ~{_sz(a) * _sz(b)}")

    live_rows = set(range(n))
    live_cols = set(range(n))
    pivots: List[Tuple[int, int]] = []

    for _ in range(n):
        pi, pc = _markowitz_choose(rows, live_rows, live_cols)
        if pi is None:
            # No nonzero pivot in the remaining block: singular system.
            raise _SolverFallback("singular (fast path)")
        piv = _guard(rows[pi][pc])
        for i in list(live_rows):
            if i == pi:
                continue
            f = rows[i].get(pc)
            if f is None:
                continue   # zero in pivot column: row untouched, sparsity kept
            _op_guard(f, piv)
            factor = _guard(f / piv)
            row_i = rows[i]
            for c, v in rows[pi].items():
                if c == pc:
                    continue
                _op_guard(factor, v)
                sub = factor * v
                cur = row_i.get(c)
                nv = (cur - sub) if cur is not None else (-sub)
                if nv != 0:
                    row_i[c] = _guard(nv)
                elif c in row_i:
                    del row_i[c]
            del row_i[pc]
        pivots.append((pi, pc))
        live_rows.discard(pi)
        live_cols.discard(pc)

    # Back-substitution in reverse pivot order: when a pivot is processed every
    # other column left in its row has already been solved (see plan notes).
    # The solved components accumulate the full answer, so this phase is where a
    # dense result actually gets built -- it carries the same guards as forward
    # elimination.
    x: Dict[int, Any] = {}
    for pi, pc in reversed(pivots):
        r = rows[pi]
        acc = r.get(n, F.zero)
        for c, v in r.items():
            if c == pc or c == n:
                continue
            _op_guard(v, _guard(x[c]))
            acc = _guard(acc - v * x[c])
        _op_guard(acc, r[pc])
        x[pc] = _guard(acc / r[pc])

    return x, F, has_pi


def _select_component(x, F, out_idx: Optional[int], out_idx2: Optional[int]):
    """Pick the transfer function out of a solved vector ``x``.

    H = x[out_idx]                          (single-ended output)
      = x[out_idx] - x[out_idx2]            (differential; a None index is ground)
    """
    def component(idx: Optional[int]):
        return x[idx] if idx is not None else F.zero

    H_field = component(out_idx)
    if out_idx2 is not None:
        H_field = H_field - component(out_idx2)
    return H_field


def _frac_solve_field(
    A: sp.Matrix,
    z_tf: sp.Matrix,
    out_idx: Optional[int],
    out_idx2: Optional[int],
    max_terms: int = 50000,
    max_product: Optional[int] = None,
    max_vars: Optional[int] = None,
):
    """Eliminate and select in one call, returning ``(H_field, F, has_pi)``.

    Convenience wrapper over :func:`_frac_eliminate` + :func:`_select_component`
    for callers that do not cache the eliminated vector.
    """
    x, F, has_pi = _frac_eliminate(
        A, z_tf, max_terms=max_terms, max_product=max_product, max_vars=max_vars)
    return _select_component(x, F, out_idx, out_idx2), F, has_pi


def _frac_solve_H(
    A: sp.Matrix,
    z_tf: sp.Matrix,
    out_idx: Optional[int],
    out_idx2: Optional[int],
    max_terms: int = 50000,
    max_product: Optional[int] = None,
    max_vars: Optional[int] = None,
) -> sp.Expr:
    """Solve A·x = z_tf and return the raw H(s) as a SymPy ``Expr``.

    Thin wrapper over :func:`_frac_solve_field` for callers (and the legacy
    fallback / tests) that want an expression rather than a field element.
    """
    H_field, _F, has_pi = _frac_solve_field(
        A, z_tf, out_idx, out_idx2,
        max_terms=max_terms, max_product=max_product, max_vars=max_vars,
    )
    H_expr = H_field.as_expr()
    if has_pi:
        H_expr = H_expr.subs(_PI_SYM, sp.pi)
    return H_expr


def _field_poly_to_s_coeffs(pe, s_idx: Optional[int], gen_exprs) -> List[sp.Expr]:
    """Coefficient list (highest s-power first) of a ``PolyElement`` in s.

    ``pe`` is a numerator or denominator drawn from a :class:`FracElement`; it
    is already a canonical, fully-expanded sparse polynomial over the ring
    generators, so its coefficient of each power of s can be read straight from
    the monomial dictionary -- no ``expand`` and no ``Poly`` construction. Each
    s-coefficient is assembled as a SymPy ``Expr`` in the *other* generators
    (``gen_exprs`` maps generator index -> its Expr, with the pi placeholder
    already mapped back to ``sp.pi``).

    ``s_idx`` is the index of the ``s`` generator, or ``None`` when the ring has
    no ``s`` at all (a purely resistive circuit whose H is frequency-independent)
    -- then every monomial sits at s-power 0 and the result is a single constant
    coefficient, mirroring ``Poly(expr, s)`` of a degree-0 expression.
    """
    from collections import defaultdict
    by_s: Dict[int, List[sp.Expr]] = defaultdict(list)
    for mono, coeff in pe.terms():
        term = sp.Integer(int(coeff))
        for gi, e in enumerate(mono):
            if gi == s_idx or e == 0:
                continue
            term *= gen_exprs[gi] ** int(e)
        s_exp = mono[s_idx] if s_idx is not None else 0
        by_s[s_exp].append(term)
    if not by_s:
        return [sp.Integer(0)]
    deg = max(by_s)
    return [sp.Add(*by_s[d]) if d in by_s else sp.Integer(0)
            for d in range(deg, -1, -1)]


def _tf_fields_from_field(H_field, F, has_pi: bool) -> Dict[str, Any]:
    """Build every tf field directly from a solved ``FracElement``.

    This is the fast post-processing path: it replaces the old
    ``cancel`` -> ``fraction`` -> ``expand`` -> ``Poly`` -> LC-normalise ->
    re-``expand`` chain (which re-canonicalised an answer the fraction field had
    already reduced) with a direct read of the numerator/denominator monomials.

    Returns a dict with ``num_coeffs``/``den_coeffs`` (strings, denominator made
    monic, highest degree first), ``num_degree``/``den_degree``, ``symbols``,
    ``latex``, ``H_expr`` (the un-normalised reduced fraction, matching the
    legacy path), and ``den_terms`` (diagnostic monomial count).
    """
    gens = F.symbols   # tuple of SymPy Symbols; 's' may be absent (see below)
    s_idx = next((i for i, g in enumerate(gens) if str(g) == "s"), None)
    # Map each generator to the Expr it stands for -- the pi placeholder back to
    # the real pi, everything else to itself.
    gen_exprs = [sp.pi if (has_pi and g == _PI_SYM) else g for g in gens]

    num_pe = H_field.numer
    den_pe = H_field.denom
    num_raw = _field_poly_to_s_coeffs(num_pe, s_idx, gen_exprs)
    den_raw = _field_poly_to_s_coeffs(den_pe, s_idx, gen_exprs)

    num_degree = len(num_raw) - 1
    den_degree = len(den_raw) - 1

    # Un-normalised reduced fraction: the field element is already coprime, so
    # num/den needs no further cancel. This is what the legacy path exposed as
    # H_expr and rendered to latex.
    num_expr = sp.Add(*[c * s ** (num_degree - i) for i, c in enumerate(num_raw)])
    den_expr = sp.Add(*[c * s ** (den_degree - i) for i, c in enumerate(den_raw)])
    H_display = num_expr / den_expr

    # Display coefficients: divide through by the denominator's leading
    # coefficient so the denominator is monic (matches the legacy output). With
    # a symbolic LC this turns polynomial coefficients into rational ones -- the
    # same forms the old Poly/cancel path produced.
    den_lc = den_raw[0]
    if den_lc != 0 and den_lc != 1:
        num_norm = [sp.cancel(c / den_lc) for c in num_raw]
        den_norm = [sp.cancel(c / den_lc) for c in den_raw]
    else:
        num_norm = num_raw
        den_norm = den_raw

    all_syms = set()
    for c in num_norm + den_norm:
        all_syms.update(str(sym) for sym in c.free_symbols if sym != s)

    den_terms = sum(len(sp.Add.make_args(c)) for c in den_raw)

    return {
        "num_coeffs": [str(c) for c in num_norm],
        "den_coeffs": [str(c) for c in den_norm],
        "num_degree": num_degree,
        "den_degree": den_degree,
        "symbols": sorted(all_syms),
        "latex": _display_latex(H_display),
        "H_expr": str(H_display),
        "den_terms": den_terms,
    }


def _tf_fields_from_expr(H_raw: sp.Expr) -> Dict[str, Any]:
    """Build the tf fields from a raw ``Expr`` transfer function.

    The legacy post-processing path (cancel -> fraction -> expand -> Poly ->
    LC-normalise), used by the berkowitz fallback and ``method='legacy'``. The
    fast path uses :func:`_tf_fields_from_field` instead, which skips this
    Expr-level re-canonicalisation entirely.
    """
    H_simplified = cancel(H_raw)
    num_expr, den_expr = fraction(H_simplified)

    try:
        num_poly = Poly(sp.expand(num_expr), s)
    except sp.PolynomialError:
        num_poly = Poly(num_expr, s, domain="EX")
    try:
        den_poly = Poly(sp.expand(den_expr), s)
    except sp.PolynomialError:
        den_poly = Poly(den_expr, s, domain="EX")

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

    all_syms = set()
    for c in num_poly.all_coeffs() + den_poly.all_coeffs():
        all_syms.update(str(sym) for sym in sp.sympify(c).free_symbols if sym != s)

    den_terms = sum(
        len(sp.Add.make_args(sp.expand(c))) for c in den_poly.all_coeffs())

    return {
        "num_coeffs": _extract_coeffs(num_poly),
        "den_coeffs": _extract_coeffs(den_poly),
        "num_degree": num_poly.degree(),
        "den_degree": den_poly.degree(),
        "symbols": sorted(all_syms),
        "latex": _display_latex(H_simplified),
        "H_expr": str(H_simplified),
        "den_terms": den_terms,
    }


# ===================================================================
#  Block decomposition (cascade tearing at op-amp / VCVS outputs)
# ===================================================================
#
# An ideal or finite-gain op-amp output node -- and a grounded-output VCVS node
# -- is driven by a (controlled) voltage source with zero output impedance, so
# whatever a downstream stage draws from it cannot change its voltage. Cutting
# the circuit there tears a cascade into independent blocks whose transfer
# functions MULTIPLY: H = H1(in->c1) * H2(c1->c2) * ...  The flat (expanded)
# H(s) of a deep cascade is exponentially large (mfb_n has ~5^n denominator
# terms), but each block is tiny, so composing block-by-block keeps a 50-element
# filter solvable in tens of milliseconds where the flat solve overflows.
#
# Global feedback (a downstream node wired back into an upstream input, as in a
# state-variable filter) makes the block graph cyclic; those blocks are merged
# into one strongly-connected component and solved together, so correctness is
# preserved -- the tear only ever happens where it is truly one-directional.
#
# The whole attempt is wrapped by its caller in a try/except that falls back to
# the flat solver, so a decomposition that mis-analyses a circuit can only be
# slower, never wrong.

# Product of per-block denominator term counts above which the flattened cascade
# is not worth forming. Set so the block path only ever *accelerates* cascades
# whose flat H(s) is already what the tool shows (mfb3 ~ 125, sk4 ~ 256), never
# introducing a new, wall-of-text flat H for a deeper filter: mfb4 ~ 5^4 = 625
# and up fall through to the flat solver unchanged (they stay a numeric-mode
# prompt until the factored-form UI lands). Below the cap the full flat tf is
# built and the existing UI works on it verbatim.
_FLATTEN_TERM_CAP = 300


def _block_terminals(el: dict):
    """Return (current-carrying terminals, all terminals) of an element."""
    t = el["type"]
    if t in ("R", "L", "C", "V", "I"):
        return [el["n1"], el["n2"]], [el["n1"], el["n2"]]
    if t in ("G", "E"):
        return [el["np"], el["nn"]], [el["np"], el["nn"], el["ncp"], el["ncn"]]
    if t == "O":
        return [el["np"], el["nn"]], [el["np"], el["nn"], el["nout"]]
    return [], []


def _cut_nodes(elements: List[dict]) -> set:
    """Nodes driven by a zero-output-impedance source: op-amp outputs and
    grounded-output VCVS outputs. These are where a cascade can be torn."""
    C = set()
    for el in elements:
        if el["type"] == "O":
            C.add(el["nout"])
        elif el["type"] == "E" and el.get("nn") == "0":
            C.add(el["np"])
    C.discard("0")
    return C


def _block_components(elements: List[dict], C: set) -> Dict[str, str]:
    """Union-find on non-ground, non-cut nodes: two nodes share a block core if
    an element's real terminals connect them (an op-amp's two inputs, a passive's
    two nodes, a controlled source's output+sense nodes)."""
    parent: Dict[str, str] = {}

    def find(x):
        parent.setdefault(x, x)
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    def real(n):
        return n != "0" and n not in C

    for el in elements:
        reals = [n for n in _block_terminals(el)[1] if real(n)]
        for n in reals[1:]:
            union(reals[0], n)
    for el in elements:
        for n in _block_terminals(el)[1]:
            if real(n):
                find(n)
    return {n: find(n) for n in parent}


def _driver_of(elements: List[dict], C: set, comp_of: Dict[str, str]) -> Dict[str, str]:
    """Map each cut node to the component id of the block that drives it."""
    drv: Dict[str, str] = {}
    for el in elements:
        if el["type"] == "O":
            ins = [n for n in (el["np"], el["nn"]) if n != "0" and n not in C]
            drv[el["nout"]] = comp_of[ins[0]] if ins else None
        elif el["type"] == "E" and el.get("nn") == "0":
            ins = [n for n in (el["ncp"], el["ncn"]) if n != "0" and n not in C]
            drv[el["np"]] = comp_of[ins[0]] if ins else None
    return drv


def _assign_blocks(elements, C, comp_of, drv):
    """Group elements by block, recording each block's driven / consumed cuts."""
    blocks: Dict[str, dict] = {}
    for el in elements:
        reals = [n for n in _block_terminals(el)[1] if n != "0" and n not in C]
        if el["type"] == "O":
            comp = drv[el["nout"]]
        elif el["type"] == "E" and el.get("nn") == "0":
            comp = drv[el["np"]]
        elif reals:
            comp = comp_of[reals[0]]
        else:
            comp = None
        b = blocks.setdefault(comp, {"elements": [], "drives": set(), "consumes": set()})
        b["elements"].append(el)
    for comp, b in blocks.items():
        for el in b["elements"]:
            for n in _block_terminals(el)[1]:
                if n in C:
                    (b["drives"] if drv.get(n) == comp else b["consumes"]).add(n)
    return blocks


def _condense_sccs(blocks, drv):
    """Tarjan SCC of the producer->consumer block graph, in topological order."""
    ids = [c for c in blocks if c is not None]
    consumers: Dict[str, List[str]] = {c: [] for c in ids}
    for c in ids:
        for cut in blocks[c]["consumes"]:
            p = drv.get(cut)
            if p in consumers and p != c:
                consumers[p].append(c)   # p -> c
    index, low, onstack, stack, sccs, ctr = {}, {}, {}, [], [], [0]

    def dfs(v):
        index[v] = low[v] = ctr[0]; ctr[0] += 1
        stack.append(v); onstack[v] = True
        for w in consumers[v]:
            if w not in index:
                dfs(w); low[v] = min(low[v], low[w])
            elif onstack.get(w):
                low[v] = min(low[v], index[w])
        if low[v] == index[v]:
            comp = []
            while True:
                w = stack.pop(); onstack[w] = False; comp.append(w)
                if w == v:
                    break
            sccs.append(comp)

    for v in ids:
        if v not in index:
            dfs(v)
    sccs.reverse()
    return sccs


def _block_solve_tf(block_elements, active_src, zeroed_nodes, output_node, limits):
    """V(output_node) with a unit source at active_src and other input ports
    shorted to ground -- one term of a block's superposition.

    active_src is a node name (a torn input cut) or ``('elem', name)`` naming a
    real source element already inside the block."""
    els = list(block_elements)
    for i, nd in enumerate(zeroed_nodes):
        els.append({"name": f"_Z{i}", "type": "V", "n1": nd, "n2": "0", "value": "0"})
    if isinstance(active_src, tuple):
        input_name = active_src[1]
    else:
        els.append({"name": "_SRC", "type": "V", "n1": active_src, "n2": "0", "value": "1"})
        input_name = "_SRC"

    A, z, node_list, var_names, errs = _build_mna(els)
    if any(not e.startswith("WARNING") for e in errs):
        raise _SolverFallback("block MNA error")
    node_idx = {nd: i for i, nd in enumerate(node_list)}
    if output_node not in node_idx:
        raise _SolverFallback("block output not a node")
    group2 = [el["name"] for el in els if el["type"] in ("V", "E", "O")]
    branch_map = {nm: len(node_list) + i for i, nm in enumerate(group2)}
    z_tf = zeros(A.rows, 1)
    z_tf[branch_map[input_name]] = sp.Integer(1)
    H_field, F, has_pi = _frac_solve_field(
        A, z_tf, node_idx[output_node], None,
        max_terms=limits["max_terms"], max_product=limits["max_product"],
        max_vars=limits["max_vars"])
    H = H_field.as_expr()
    if has_pi:
        H = H.subs(_PI_SYM, sp.pi)
    return H


def _block_compose(elements, input_name, out_nodes, limits):
    """Compose H for a decomposable cascade, tearing at op-amp / VCVS outputs.

    ``out_nodes`` is ``[node]`` for a single-ended output or ``[from, to]`` for a
    differential one (H = T(from) - T(to)). Returns
    ``(H_expr, factors, symbols, is_chain)`` where ``factors`` are the per-block
    transfer functions used along the path (for a flat-size estimate and factored
    display) and ``is_chain`` is True when every block has exactly one input so
    the composition is a clean product H1*H2*... (the case whose factored form is
    a simple readable chain). Returns ``None`` when the circuit is not worth
    tearing (fewer than three blocks, an unsupported output, or a structural
    surprise -- the caller then uses the flat solver)."""
    C = _cut_nodes(elements)
    if not C:
        return None
    comp_of = _block_components(elements, C)
    drv = _driver_of(elements, C, comp_of)
    if any(v is None for v in drv.values()):
        return None   # an op-amp with both inputs grounded: leave to flat solver
    blocks = _assign_blocks(elements, C, comp_of, drv)
    sccs = _condense_sccs(blocks, drv)
    # A genuine cascade is >= 2 blocks. A cascade that stays a chain is returned
    # factored (the preferred form for a filter), which is cheap even at two
    # stages because it never flattens; a single block is not a cascade and is
    # left to the flat solver.
    if len(sccs) < 2:
        return None

    scc_of = {cid: k for k, comp in enumerate(sccs) for cid in comp}

    def consumers_of(c):
        return [cc for cc in blocks if cc is not None and c in blocks[cc]["consumes"]]

    merged = []
    for k, comp in enumerate(sccs):
        els, drives, consumes = [], set(), set()
        for cid in comp:
            els += blocks[cid]["elements"]
            drives |= blocks[cid]["drives"]
            consumes |= blocks[cid]["consumes"]
        boundary_out = {c for c in drives
                        if any(scc_of[cc] != k for cc in consumers_of(c))}
        boundary_in = {c for c in consumes
                       if drv.get(c) is not None and scc_of.get(drv[c]) != k}
        merged.append({"elements": els, "drives": boundary_out, "consumes": boundary_in})

    src_elem = next(el for el in elements if el["name"] == input_name)
    src_node = src_elem["n1"] if src_elem["n1"] != "0" else src_elem["n2"]

    def scc_of_node(nd):
        for k, m in enumerate(merged):
            for el in m["elements"]:
                if nd in _block_terminals(el)[1]:
                    return k
        return None

    src_scc = scc_of_node(src_node)
    factors: List[sp.Expr] = []

    def block_inputs(k):
        ins = []
        if k == src_scc:
            ins.append(("src", ("elem", input_name)))
        for c in sorted(merged[k]["consumes"]):
            ins.append(("cut", c))
        return ins

    T: Dict[str, sp.Expr] = {}
    for k, m in enumerate(merged):
        ins = block_inputs(k)
        for oc in sorted(m["drives"]):
            acc = sp.Integer(0)
            for kind, src in ins:
                zeroed = [c for (kk, c) in ins if kk == "cut" and not (kk == kind and c == src)]
                Hpart = _block_solve_tf(m["elements"], src, zeroed, oc, limits)
                factors.append(Hpart)
                acc += Hpart if kind == "src" else Hpart * T[src]
            T[oc] = acc

    def transfer_to(node):
        if node in T:
            return T[node]
        k = scc_of_node(node)
        if k is None:
            raise _SolverFallback("output node not in any block")
        ins = block_inputs(k)
        acc = sp.Integer(0)
        for kind, src in ins:
            zeroed = [c for (kk, c) in ins if kk == "cut" and not (kk == kind and c == src)]
            Hpart = _block_solve_tf(merged[k]["elements"], src, zeroed, node, limits)
            factors.append(Hpart)
            acc += Hpart if kind == "src" else Hpart * T[src]
        return acc

    H_expr = transfer_to(out_nodes[0])
    if len(out_nodes) == 2:
        H_expr = H_expr - transfer_to(out_nodes[1])

    # A clean chain (every block driven by exactly one input) composes as a
    # simple product H1*H2*..., which is what makes a readable factored form; a
    # single-ended output on such a chain keeps the factors in stage order.
    is_chain = (len(out_nodes) == 1
                and all(len(block_inputs(k)) == 1 for k in range(len(merged))))
    symbols = sorted(str(x) for x in H_expr.free_symbols if x != s)
    return H_expr, factors, symbols, is_chain


def _flatten_estimate(factors: List[sp.Expr]) -> int:
    """Rough upper bound on the flattened denominator's term count: the product
    of each distinct factor's denominator term count. Used to decide whether the
    flat H is small enough to form (see :data:`_FLATTEN_TERM_CAP`)."""
    est = 1
    seen = set()
    for f in factors:
        key = str(f)
        if key in seen:
            continue
        seen.add(key)
        _, den = fraction(f)
        est *= max(1, len(sp.Add.make_args(sp.expand(den))))
        if est > 10 ** 9:
            break
    return est


def _section_standard_form(num_coeffs: List[str], den_coeffs: List[str]) -> Optional[Dict[str, Any]]:
    """Cast one factored section into the analog-filter standard form.

    A first- or second-order section has a canonical description every filter
    text and op-amp cookbook uses: a corner frequency and (for a second-order
    section) a Q, plus which kind of section it is. This reads those straight
    off the section's coefficients -- a well-defined transformation for order <=
    2, which is exactly what the factored form produces -- and returns the
    section type, the standard-form formula (a KaTeX template in omega_0/Q/K),
    and the parameter values as latex (f_0 in Hz, the analog convention, plus
    omega_0 and Q). Returns ``None`` for order > 2 (a monolithic high-order block
    has no unique section form -- see the module notes on the factored form).
    """
    try:
        num = [sp.sympify(c) for c in num_coeffs]
        den = [sp.sympify(c) for c in den_coeffs]
    except Exception:
        return None

    dd = len(den) - 1

    def by_power(coeffs):
        d = len(coeffs) - 1
        return {d - i: c for i, c in enumerate(coeffs)}

    npow, dpow = by_power(num), by_power(den)
    g = lambda pw, table: table.get(pw, sp.Integer(0))
    L = _display_latex

    def clean(e):
        # sqrt(1/x) reads better as 1/sqrt(x); harmless elsewhere.
        try:
            return sp.powdenest(sp.simplify(e), force=True)
        except Exception:
            return sp.simplify(e)

    if dd == 2:
        a2, a1, a0 = g(2, dpow), g(1, dpow), g(0, dpow)
        b2, b1, b0 = g(2, npow), g(1, npow), g(0, npow)
        w0 = clean(sp.sqrt(a0 / a2))
        Q = clean(sp.sqrt(a0 * a2) / a1) if a1 != 0 else None
        params = []
        if b1 == 0 and b2 == 0:
            typ, K = "Low-pass", b0 / a0
            formula = r"\frac{K}{1 + \dfrac{s}{Q\,\omega_0} + \left(\dfrac{s}{\omega_0}\right)^2}"
        elif b1 == 0 and b0 == 0:
            typ, K = "High-pass", b2 / a2
            formula = r"\frac{K\left(\dfrac{s}{\omega_0}\right)^2}{1 + \dfrac{s}{Q\,\omega_0} + \left(\dfrac{s}{\omega_0}\right)^2}"
        elif b2 == 0 and b0 == 0:
            typ, K = "Band-pass", b1 / a1
            formula = r"\frac{K\,\dfrac{s}{Q\,\omega_0}}{1 + \dfrac{s}{Q\,\omega_0} + \left(\dfrac{s}{\omega_0}\right)^2}"
        elif b1 == 0 and b2 != 0 and b0 != 0:
            typ, K = "Notch", b0 / a0
            wz = clean(sp.sqrt(b0 / b2))
            formula = r"K\,\frac{1 + \left(\dfrac{s}{\omega_z}\right)^2}{1 + \dfrac{s}{Q\,\omega_0} + \left(\dfrac{s}{\omega_0}\right)^2}"
            params.append({"sym": r"\omega_z", "latex": L(wz)})
        else:
            typ, K, formula = "2nd-order", None, None
        params = [{"sym": r"\omega_0", "latex": L(w0)},
                  {"sym": "f_0", "latex": L(clean(w0 / (2 * sp.pi)))}] + params
        params.append({"sym": "Q", "latex": (L(Q) if Q is not None else r"\infty")})
        if K is not None:
            params.append({"sym": "K", "latex": L(sp.simplify(K))})
        return {"type": typ, "formula_latex": formula, "params": params}

    if dd == 1:
        a1, a0 = g(1, dpow), g(0, dpow)
        b1, b0 = g(1, npow), g(0, npow)
        wc = clean(a0 / a1)
        if b1 == 0:
            typ, K = "Low-pass (1st order)", b0 / a0
            formula = r"\frac{K}{1 + \dfrac{s}{\omega_c}}"
        elif b0 == 0:
            typ, K = "High-pass (1st order)", b1 / a1
            formula = r"\frac{K\,\dfrac{s}{\omega_c}}{1 + \dfrac{s}{\omega_c}}"
        else:
            typ, K, formula = "1st-order", None, None
        params = [{"sym": r"\omega_c", "latex": L(wc)},
                  {"sym": "f_c", "latex": L(clean(wc / (2 * sp.pi)))}]
        if K is not None:
            params.append({"sym": "K", "latex": L(sp.simplify(K))})
        return {"type": typ, "formula_latex": formula, "params": params}

    if dd == 0:
        K = sp.simplify(g(0, npow) / g(0, dpow))
        return {"type": "Gain", "formula_latex": "K",
                "params": [{"sym": "K", "latex": L(K)}]}

    return None


def _tf_fields_factored(H_expr: sp.Expr, factors: List[sp.Expr], kind: str,
                        flat_available: bool = False) -> Dict[str, Any]:
    """Build a *factored* tf: H(s) as a product of small per-stage fractions.

    This is the preferred form for a cascade -- the stages are kept as separate
    readable fractions (their product is H(s)), so the result is linear in stage
    count and exposes each stage's poles/zeros, where the flat H(s) is an
    unreadable wall of terms (and exponentially large for a deep chain). Each
    stage carries its own coefficient lists and latex; the flat coefficient lists
    are ``None`` (they are formed on demand by :func:`flatten`). ``flat_available``
    says whether that flat expansion is small enough to be worth offering.
    ``H_expr`` is kept unexpanded so substitution/plotting collapse the product
    numerically through the normal path.

    Distinct factors only, in composition order, dropping any trivial ``1`` (a
    unity stage contributes nothing to display).
    """
    stage_tfs = []
    seen = set()
    num_deg = den_deg = 0
    for f in factors:
        key = str(f)
        if key in seen or f == 1:
            continue
        seen.add(key)
        st = _tf_fields_from_expr(f)
        st.pop("den_terms", None)
        stage_tfs.append({
            "num_coeffs": st["num_coeffs"], "den_coeffs": st["den_coeffs"],
            "num_degree": st["num_degree"], "den_degree": st["den_degree"],
            "latex": st["latex"], "symbols": st["symbols"],
            # Analog standard form (type + f0/Q/K) -- the textbook description.
            "standard": _section_standard_form(st["num_coeffs"], st["den_coeffs"]),
        })
        num_deg += st["num_degree"]
        den_deg += st["den_degree"]

    # Combined display latex: the product of the stage fractions (unexpanded).
    combined_latex = r" \cdot ".join(f"\\left({st['latex']}\\right)"
                                     for st in stage_tfs) or "1"
    symbols = sorted(str(x) for x in H_expr.free_symbols if x != s)
    return {
        "factored": True,
        "flat_available": flat_available,
        "factors": stage_tfs,
        "num_coeffs": None,
        "den_coeffs": None,
        "num_degree": num_deg,
        "den_degree": den_deg,
        "symbols": symbols,
        "latex": combined_latex,
        "kind": kind,
        "H_expr": str(H_expr),
    }


def _value_subs_map(A: sp.Matrix, z_tf: sp.Matrix, values: Dict[str, Any]) -> Dict[sp.Symbol, sp.Expr]:
    """Build an exact substitution dict for the numeric-first solve.

    Matches value names against the symbols actually present in A / z_tf (so a
    ``positive=True`` symbol and a plain one both resolve), and converts each
    value with ``Rational`` -- keeping the coefficients exact rather than
    importing binary floating-point error into the transfer function.
    """
    present = {}
    for i in range(A.rows):
        for j in range(A.cols):
            for sym in A[i, j].free_symbols:
                present[str(sym)] = sym
        for sym in z_tf[i].free_symbols:
            present[str(sym)] = sym
    subs: Dict[sp.Symbol, sp.Expr] = {}
    for name, val in values.items():
        try:
            r = sp.Rational(str(val))
        except (ValueError, TypeError):
            r = sp.sympify(str(val))
        if name in present:
            subs[present[name]] = r
        else:
            subs[Symbol(name)] = r
            subs[Symbol(name, positive=True)] = r
    return subs


def _remaining_symbols(A: sp.Matrix, z_tf: sp.Matrix) -> List[str]:
    """Sorted names of the symbols still present in the system (excluding s).

    Used to tell the UI which values it must collect for the numeric-first
    solve after a symbolic solve overflows the term guard.
    """
    syms = set()
    for i in range(A.rows):
        for j in range(A.cols):
            syms |= A[i, j].free_symbols
        syms |= z_tf[i].free_symbols
    return sorted(str(x) for x in syms if x != s and x != _PI_SYM)


def _legacy_cramer_H(
    A: sp.Matrix,
    z_tf: sp.Matrix,
    output_idx: Optional[int],
    output_idx2: Optional[int],
    det_A: sp.Expr,
    n_total: int,
) -> sp.Expr:
    """Cramer's rule with berkowitz determinants (the original solve path).

    Retained as the fast solver's fallback and for ``options.method='legacy'``.
    """
    def det_with_col(col: int) -> sp.Expr:
        A_k = A.copy()
        for row in range(n_total):
            A_k[row, col] = z_tf[row]
        return A_k.berkowitz_det()

    if output_idx is not None and output_idx2 is None:
        return det_with_col(output_idx) / det_A
    if output_idx is not None and output_idx2 is not None:
        return (det_with_col(output_idx) - det_with_col(output_idx2)) / det_A
    # output_from is ground: H = -H_to
    return -det_with_col(output_idx2) / det_A


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

        if output_idx is None and output_idx2 is None:
            return _err(["Could not determine output variable index"])

        # ----- Options: numeric-first values, method, and effort -----
        options = circuit.get("options") or {}
        method = options.get("method", "auto")
        values = options.get("values") or {}
        effort = options.get("effort", "quick")
        limits = _EFFORT_LIMITS.get(effort, _EFFORT_LIMITS["quick"])

        # Numeric-first: substitute component values into A and z_tf BEFORE
        # solving, so a large filter collapses to a small numeric polynomial and
        # never has to form its (exponentially large) symbolic transfer function.
        # Rationals, not floats -- exact, no binary round-off in the coefficients.
        if values:
            subs_map = _value_subs_map(A, z_tf, values)
            A = A.subs(subs_map)
            z_tf = z_tf.subs(subs_map)

        # ----- Compute the raw transfer function H_raw -----
        # Fast path: solve A·x = z_tf once over the fraction field. Falls back to
        # the legacy Cramer/berkowitz path if the system cannot be embedded in a
        # polynomial ring (unexpected transcendental) or is structurally singular.
        stats: Dict[str, Any] = {"n": n_total}
        tf_fields = None
        used_method = method

        # Block-cascade decomposition: tear the circuit at op-amp / VCVS outputs
        # and compose H as a product of small per-stage transfer functions.
        #
        # For a clean chain (a plain multi-stage cascade) this is the PREFERRED
        # form, not just a fallback: a product of readable biquads exposes the
        # per-stage poles/zeros a filter designer wants, where the flat symbolic
        # H(s) is an unreadable wall of terms even at two stages. So a symbolic
        # chain of >=2 stages is returned FACTORED by default; the flat form is
        # available on demand (flatten()), and 'flat_available' says whether it
        # is small enough to expand. A fan-in cascade has no clean product, so it
        # is flattened when cheap and otherwise left to the flat solver. All
        # gated to a pure symbolic node-voltage solve; numeric solves and
        # non-decomposable circuits keep the flat form.
        if method != "legacy" and not values and "node" in output_spec:
            try:
                composed = _block_compose(
                    elements, input_name, [_node_key(output_spec["node"])], limits)
            except Exception:
                composed = None   # any surprise -> flat solver owns it
            if composed is not None:
                H_expr_c, factors_c, syms_c, is_chain_c = composed
                est = _flatten_estimate(factors_c)
                if is_chain_c:
                    kind = _determine_tf_kind(input_elem, output_type)
                    tf = _tf_fields_factored(
                        H_expr_c, factors_c, kind, flat_available=(est <= _FLATTEN_TERM_CAP))
                    stats["method"] = "block-factored"
                    return _ok({"tf": tf, "errors": warnings, "stats": stats})
                elif est <= _FLATTEN_TERM_CAP:
                    # Fan-in cascade (no simple product): flatten when cheap.
                    try:
                        tf_fields = _tf_fields_from_expr(H_expr_c)
                        used_method = "block"
                    except Exception:
                        tf_fields = None   # fall through to the flat solver
                # else: fan-in past the cap -> fall through to flat/too_large.

        if tf_fields is None and method != "legacy":
            try:
                # The elimination is independent of the output port, so cache the
                # solved vector keyed by everything else (elements, input, values,
                # effort). Changing only the output -- or an undo/redo/port
                # round-trip landing on this same system -- then skips straight to
                # selecting a different component.
                elim_key = json.dumps(
                    {"elements": elements, "input": input_name,
                     "values": values, "effort": effort},
                    sort_keys=True, default=str)
                cached = _ELIM_CACHE.get(elim_key)
                if cached is not None:
                    _ELIM_CACHE.move_to_end(elim_key)
                    x_vec, F_ring, has_pi = cached
                    stats["elim_cached"] = True
                else:
                    x_vec, F_ring, has_pi = _frac_eliminate(
                        A, z_tf,
                        max_terms=limits["max_terms"],
                        max_product=limits["max_product"],
                        max_vars=limits["max_vars"],
                    )
                    _ELIM_CACHE[elim_key] = (x_vec, F_ring, has_pi)
                    while len(_ELIM_CACHE) > _ELIM_CACHE_MAX:
                        _ELIM_CACHE.popitem(last=False)
                H_field = _select_component(x_vec, F_ring, output_idx, output_idx2)
                # Read the s-coefficients straight from the solved field element
                # -- no cancel/expand/Poly round-trip (see _tf_fields_from_field).
                tf_fields = _tf_fields_from_field(H_field, F_ring, has_pi)
                used_method = "fast"
            except _SolverTooLarge as exc:
                # Report machine-readably so the UI can offer the numeric-first
                # path: reason='too_large' and the list of symbols that need a
                # value. (When we already had values and still overflowed, the
                # circuit is genuinely intractable -- no numeric escape hatch.)
                remaining = _remaining_symbols(A, z_tf)
                return _err(
                    [f"The symbolic transfer function is too large to compute "
                     f"({exc}). Enter component values to solve numerically, or "
                     f"split the circuit into smaller blocks."],
                    reason="too_large",
                    symbols=remaining,
                )
            except _SolverFallback:
                tf_fields = None   # drop to legacy below

        if tf_fields is None:
            det_A = A.berkowitz_det()
            if det_A == 0:
                return _err(["Singular MNA matrix — circuit may have errors"])
            H_raw = _legacy_cramer_H(A, z_tf, output_idx, output_idx2, det_A, n_total)
            tf_fields = _tf_fields_from_expr(H_raw)
            used_method = "legacy"

        stats["method"] = used_method
        stats["den_terms"] = tf_fields.pop("den_terms")

        # Determine transfer-function kind
        kind = _determine_tf_kind(input_elem, output_type)

        tf = {**tf_fields, "kind": kind}

        result: Dict[str, Any] = {"tf": tf, "errors": warnings, "stats": stats}
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

        H_expr = _cached_sympify(tf_data["H_expr"])

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

        # xreplace, not subs: substituting a symbol with a constant is a pure
        # structural replacement, and xreplace does exactly that -- while subs
        # walks the whole rational function re-evaluating as it rebuilds, which
        # on a multi-kByte flat H(s) is ~50x slower for an identical result
        # (cancel() below does the reduction either way).
        H_sub = H_expr.xreplace(sub_dict)
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


def flatten(tf_json: str) -> str:
    """Expand a factored transfer function into its flat form on demand.

    The default view of a cascade is factored (a product of per-stage
    fractions); this forms the single flat rational H(s) -- one numerator and
    denominator polynomial in s -- when the user asks to see it. Only called for
    a factored tf whose ``flat_available`` was true (the flat form is small
    enough), but it re-guards defensively and reports ``too_large`` if the
    expansion would blow up.

    Returns JSON: ``{ok, tf}`` with a normal (non-factored) flat tf.
    """
    try:
        tf_data = json.loads(tf_json)
        if not tf_data.get("factored"):
            # Already flat: hand it straight back.
            return _ok({"tf": tf_data})

        # Estimate the flat size from the stored per-stage denominators (product
        # of their term counts) before committing to the expansion.
        est = 1
        for st in tf_data.get("factors", []):
            terms = 0
            for c in st.get("den_coeffs", []):
                terms += len(sp.Add.make_args(sp.expand(sp.sympify(c))))
            est *= max(1, terms)
        if est > _FLATTEN_TERM_CAP * 8:
            return _err(["The flat transfer function is too large to expand; "
                         "the factored form is the usable one here."],
                        reason="too_large")

        H = _cached_sympify(tf_data["H_expr"])
        fields = _tf_fields_from_expr(H)
        fields.pop("den_terms", None)
        fields["kind"] = tf_data.get("kind", "voltage_gain")
        return _ok({"tf": fields})
    except Exception as exc:
        return _err([f"flatten failed: {exc}"])


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

        H_expr = _cached_sympify(tf_data["H_expr"])

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
        # xreplace: pure symbol->constant replacement (see substitute()).
        H_sub = H_expr.xreplace(sub_dict)

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
