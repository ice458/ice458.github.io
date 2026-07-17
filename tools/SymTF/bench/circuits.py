"""Benchmark circuit generators for SymTF.

Each generator returns ``(netlist_text, input_name, output_node)`` so the
benchmark runner and the consistency tests can drive engine.solve directly.

Two structural families matter for the speedup work (see plans/speedup-plan.md):

  * **rc_ladder** — the answer itself is large (its denominator has one term per
    spanning tree), so no algorithm can beat the output size. Stresses the
    poly/expand path.
  * **mfb_chain / sallen_key_chain / state_variable_chain** — cascaded active
    stages whose closed-form answer stays small (product structure). These are
    the realistic active-filter case the speedup targets; sympy's stock det
    strategies blow up on them well before the answer does.
"""

from __future__ import annotations

from typing import List, Tuple

Circuit = Tuple[str, str, str]   # (netlist, input_name, output_node)


def rc_ladder(n: int) -> Circuit:
    """n-stage series-R / shunt-C ladder, all symbolic. System size = n+1."""
    lines = ["V1 in 0 Vs"]
    prev = "in"
    for i in range(1, n + 1):
        node = f"n{i}"
        lines.append(f"R{i} {prev} {node} R{i}")
        lines.append(f"C{i} {node} 0 C{i}")
        prev = node
    return "\n".join(lines), "V1", prev


def mfb_chain(n: int) -> Circuit:
    """n cascaded multiple-feedback 2nd-order low-pass stages (ideal op-amp).

    Each stage: 3 R + 2 C + 1 ideal op-amp. The closed-form gain per stage is
    a compact biquad, so the cascade's answer stays small while the MNA grows.
    """
    lines = ["V1 in 0 Vs"]
    prev = "in"
    for i in range(1, n + 1):
        a, b, o = f"a{i}", f"b{i}", f"o{i}"
        lines += [
            f"R{i}a {prev} {a} R{i}a",
            f"C{i}a {a} 0 C{i}a",
            f"R{i}b {a} {b} R{i}b",
            f"C{i}b {b} {o} C{i}b",
            f"R{i}c {a} {o} R{i}c",
            f"O{i} 0 {b} {o}",
        ]
        prev = o
    return "\n".join(lines), "V1", prev


def sallen_key_chain(n: int) -> Circuit:
    """n cascaded unity-gain Sallen-Key 2nd-order low-pass stages.

    Each stage: 2 R + 2 C + 1 ideal op-amp (5 elements). A 10-stage chain is
    ~51 elements including the source -- the "50-element active filter" target.
    """
    lines = ["V1 in 0 Vs"]
    prev = "in"
    for i in range(1, n + 1):
        a, b, o = f"a{i}", f"b{i}", f"o{i}"
        lines += [
            f"R{i}a {prev} {a} R{i}a",
            f"R{i}b {a} {b} R{i}b",
            f"C{i}a {a} {o} C{i}a",
            f"C{i}b {b} 0 C{i}b",
            f"O{i} {b} {o} {o}",
        ]
        prev = o
    return "\n".join(lines), "V1", prev


def state_variable_chain(n: int) -> Circuit:
    """n cascaded Tow-Thomas biquads (3 op-amps each: 1 summer + 2 integrators).

    Dense op-amp feedback per stage; exercises the branch-current (group-2)
    growth path of MNA harder than the single-op-amp stages.
    """
    lines = ["V1 in 0 Vs"]
    prev = "in"
    for i in range(1, n + 1):
        # summing integrator -> lp output (o1), then integrator -> bp (o2)
        s1, s2, o1, o2 = f"s{i}", f"t{i}", f"o{i}", f"p{i}"
        lines += [
            # Stage 1: inverting integrator with input R and feedback R+C
            f"R{i}in {prev} {s1} R{i}in",
            f"R{i}fb {o2} {s1} R{i}fb",     # damping / feedback from bp
            f"R{i}q {o1} {s1} R{i}q",       # Q-setting feedback
            f"C{i}1 {s1} {o1} C{i}1",
            f"O{i}1 0 {s1} {o1}",
            # Stage 2: inverting integrator o1 -> o2
            f"R{i}2 {o1} {s2} R{i}2",
            f"C{i}2 {s2} {o2} C{i}2",
            f"O{i}2 0 {s2} {o2}",
        ]
        prev = o2
    return "\n".join(lines), "V1", prev


# Named benchmark instances the runner and tests iterate over. The tuple is
# (family_fn, stages). Sizes chosen to bracket the current engine's limit and
# reach into the range only the new core should handle.
BENCH_SUITE = {
    "rc4": (rc_ladder, 4),
    "rc6": (rc_ladder, 6),
    "rc8": (rc_ladder, 8),
    "rc12": (rc_ladder, 12),
    "mfb1": (mfb_chain, 1),
    "mfb2": (mfb_chain, 2),
    "mfb3": (mfb_chain, 3),
    "mfb4": (mfb_chain, 4),
    "mfb6": (mfb_chain, 6),
    "mfb8": (mfb_chain, 8),
    "sk2": (sallen_key_chain, 2),
    "sk4": (sallen_key_chain, 4),
    "sk6": (sallen_key_chain, 6),
    "sk10": (sallen_key_chain, 10),   # ~51 elements: the 50-element target
    "svf1": (state_variable_chain, 1),
    "svf2": (state_variable_chain, 2),
    "svf4": (state_variable_chain, 4),
}

# Small instances used for the exact new-vs-old consistency tests: each must be
# solvable by the *current* engine quickly, since it is the oracle. (mfb2/sk2
# are correct but already tens of seconds on the legacy path, so they stay out
# of the fast consistency set and are exercised by the benchmark instead.)
CONSISTENCY_CASES = ["rc4", "mfb1", "svf1"]


def get(name: str) -> Circuit:
    fn, k = BENCH_SUITE[name]
    return fn(k)


def system_size(netlist: str) -> int:
    """Nodes (excluding ground) + group-2 branch variables (V/E/O)."""
    nodes = set()
    branches = 0
    for raw in netlist.splitlines():
        toks = raw.split()
        if not toks or toks[0].startswith(("*", "#", "//")):
            continue
        etype = toks[0][0].upper()
        if etype in ("R", "L", "C", "V", "I"):
            node_toks = toks[1:3]
        elif etype in ("G", "E"):
            node_toks = toks[1:5]
        elif etype == "O":
            node_toks = toks[1:4]
        else:
            node_toks = []
        for nd in node_toks:
            if nd not in ("0", "GND", "gnd"):
                nodes.add(nd)
        if etype in ("V", "E", "O"):
            branches += 1
    return len(nodes) + branches
