#!/usr/bin/env bash
# All suites. Requires deno and python.
set -u
fail=0
for t in test_schematic.js test_netlist.js test_samples.js test_dom.js; do
    printf '%-22s ' "$t"
    if out=$(deno run --allow-read "$t" 2>&1); then
        echo "$(grep -c '^ok' <<<"$out") ok"
    else
        echo "FAILED"; echo "$out" | grep -A2 FAIL; fail=1
    fi
done
printf '%-22s ' "pytest (engine+speedup)"
if out=$(python -m pytest test_engine.py test_speedup.py -q 2>&1); then tail -1 <<<"$out"; else echo "FAILED"; echo "$out" | tail -20; fail=1; fi
exit $fail
