// samples.js - ready-made circuits for the schematic editor
//
// A first-time visitor lands on the canvas, so it must not be empty: the
// default sample is what tells them what this tool does.
//
// Coordinates are hand-laid and easy to get subtly wrong, so every sample is
// checked in test_samples.js by extracting it and comparing the netlist against
// the expected one. Two traps to know about when editing these:
//
//   * A wire that covers both terminals of a part is a short, and the editor
//     cuts it out (cutWiresThroughBodies). A wire dropped straight down past
//     an op-amp's two inputs silently loses the half you meant to keep.
//   * Two collinear wires that overlap are merged into one. Routing a ground
//     lead along the same x as a feedback lead joins the two nets together.
//
// Both are why the leads below take the routes they do.

window.Samples = {
    rc_lpf: {
        title: 'RC Lowpass',
        model: {
            components: [
                { type: 'LABEL', name: 'in', value: '', x: 180, y: 200, rot: 0, mirror: false },
                { type: 'R', name: 'R1', value: '', x: 200, y: 200, rot: 0, mirror: false },
                { type: 'LABEL', name: 'out', value: '', x: 260, y: 200, rot: 0, mirror: false },
                { type: 'C', name: 'C1', value: '', x: 300, y: 220, rot: 90, mirror: false },
                { type: 'GND', name: '0', value: '', x: 300, y: 240, rot: 0, mirror: false }
            ],
            wires: [
                { x1: 220, y1: 200, x2: 300, y2: 200 }
            ]
        }
    },

    rlc_series: {
        title: 'RLC Series',
        model: {
            components: [
                { type: 'LABEL', name: 'in', value: '', x: 100, y: 200, rot: 0, mirror: false },
                { type: 'R', name: 'R1', value: 'R', x: 120, y: 200, rot: 0, mirror: false },
                { type: 'L', name: 'L1', value: 'L', x: 200, y: 200, rot: 0, mirror: false },
                { type: 'LABEL', name: 'out', value: '', x: 260, y: 200, rot: 0, mirror: false },
                { type: 'C', name: 'C1', value: 'C', x: 300, y: 220, rot: 90, mirror: false },
                { type: 'GND', name: '0', value: '', x: 300, y: 240, rot: 0, mirror: false }
            ],
            wires: [
                { x1: 140, y1: 200, x2: 180, y2: 200 },
                { x1: 220, y1: 200, x2: 300, y2: 200 }
            ]
        }
    },

    inverting_amp: {
        title: 'Inverting Amplifier',
        model: {
            components: [
                { type: 'LABEL', name: 'in', value: '', x: 260, y: 210, rot: 0, mirror: false },
                { type: 'R', name: 'R1', value: '', x: 280, y: 210, rot: 0, mirror: false },
                { type: 'R', name: 'R2', value: '', x: 400, y: 120, rot: 0, mirror: false },
                { type: 'O', name: 'O1', value: '', x: 400, y: 200, rot: 0, mirror: false },
                // The + input's ground goes left before it goes down: dropping it
                // straight past the op-amp would cover both inputs and be cut.
                { type: 'GND', name: '0', value: '', x: 330, y: 190, rot: 0, mirror: false },
                { type: 'LABEL', name: 'out', value: '', x: 450, y: 200, rot: 0, mirror: false }
            ],
            wires: [
                { x1: 300, y1: 210, x2: 370, y2: 210 },   // R1 -> inverting input
                { x1: 320, y1: 210, x2: 320, y2: 120 },   // feedback tap, T-joins the lead above
                { x1: 320, y1: 120, x2: 380, y2: 120 },   // -> R2
                { x1: 420, y1: 120, x2: 460, y2: 120 },   // R2 ->
                { x1: 460, y1: 120, x2: 460, y2: 200 },
                { x1: 430, y1: 200, x2: 460, y2: 200 },   // -> op-amp output
                { x1: 330, y1: 190, x2: 370, y2: 190 }    // + input -> ground
            ]
        }
    },

    // Common-source amplifier. The transistor is the small-signal model: a VCCS
    // (gm) from drain to source, controlled by the gate, in parallel with the
    // output resistance ro; RL is the load. H = -gm*(RL || ro).
    cs_amp: {
        title: 'CS Amplifier (gm, ro)',
        model: {
            components: [
                // G1 at (300,200): out+ (320,180)=drain, out- (320,220)=source,
                // ctrl+ (280,180)=gate, ctrl- (280,220)=source.
                { type: 'G', name: 'G1', value: 'gm', x: 300, y: 200, rot: 0, mirror: false },
                { type: 'LABEL', name: 'in', value: '', x: 280, y: 180, rot: 0, mirror: false },
                { type: 'LABEL', name: 'out', value: '', x: 320, y: 160, rot: 0, mirror: false },
                { type: 'R', name: 'ro', value: 'ro', x: 400, y: 200, rot: 90, mirror: false },
                { type: 'R', name: 'RL', value: 'RL', x: 460, y: 200, rot: 90, mirror: false },
                { type: 'GND', name: '0', value: '', x: 360, y: 220, rot: 0, mirror: false }
            ],
            wires: [
                { x1: 320, y1: 180, x2: 320, y2: 160 },   // drain -> out label
                { x1: 320, y1: 180, x2: 460, y2: 180 },   // drain rail: drain, ro, RL tops
                { x1: 280, y1: 220, x2: 460, y2: 220 }    // ground rail: source, ro, RL bottoms, GND
            ]
        }
    },

    // Cascode: a common-source stage (M1) stacked under a common-gate stage
    // (M2), each a gm/ro model. M2's gate is AC-grounded. Exact gain (pinned in
    // test_engine): -gm1*ro1*(1+gm2*ro2)*RL / (RL + ro1 + ro2 + gm2*ro1*ro2).
    // Layout contributed by the user: G2's ctrl- reaches mid via a dog-leg
    // below the body, and G1's ctrl- gets its own ground -- routes that stay
    // clear of the symbols.
    cascode: {
        title: 'Cascode Amplifier',
        model: {
            components: [
                { type: 'LABEL', name: 'in', value: '', x: 180, y: 260, rot: 0, mirror: false },
                // M1 (CS) at (200,280): drain (220,260)=mid, source (220,300)=0,
                // gate (180,260)=in, ctrl- (180,300)=0 via its own ground.
                { type: 'G', name: 'G1', value: 'gm1', x: 200, y: 280, rot: 0, mirror: false },
                { type: 'R', name: 'ro1', value: 'ro1', x: 260, y: 280, rot: 90, mirror: false },
                // M2 (CG) at (200,180): drain (220,160)=out, source (220,200)=mid,
                // gate (180,160)=0 (AC ground), ctrl- (180,200)=mid via dog-leg.
                { type: 'G', name: 'G2', value: 'gm2', x: 200, y: 180, rot: 0, mirror: false },
                { type: 'R', name: 'ro2', value: 'ro2', x: 260, y: 180, rot: 90, mirror: false },
                { type: 'R', name: 'RL', value: 'RL', x: 340, y: 180, rot: 90, mirror: false },
                { type: 'LABEL', name: 'out', value: '', x: 220, y: 140, rot: 0, mirror: false },
                { type: 'GND', name: '0', value: '', x: 300, y: 300, rot: 0, mirror: false },
                { type: 'GND', name: '0', value: '', x: 140, y: 160, rot: 0, mirror: false },
                { type: 'GND', name: '0', value: '', x: 180, y: 300, rot: 0, mirror: false }
            ],
            wires: [
                { x1: 220, y1: 260, x2: 260, y2: 260 },   // mid rail: M1 drain, ro1 top
                { x1: 220, y1: 200, x2: 260, y2: 200 },   // M2 source -> ro2 bottom
                { x1: 220, y1: 300, x2: 340, y2: 300 },   // ground rail
                { x1: 140, y1: 160, x2: 180, y2: 160 },   // M2 gate -> AC ground
                { x1: 220, y1: 160, x2: 340, y2: 160 },   // out rail: M2 drain, ro2, RL tops
                { x1: 180, y1: 220, x2: 220, y2: 220 },   // ctrl- dog-leg, horizontal run
                { x1: 220, y1: 140, x2: 220, y2: 160 },   // out label
                { x1: 220, y1: 200, x2: 220, y2: 260 },   // mid: M2 source down to M1 drain
                { x1: 340, y1: 200, x2: 340, y2: 300 },   // RL bottom -> ground
                { x1: 180, y1: 200, x2: 180, y2: 220 }    // M2 ctrl- down into the dog-leg
            ]
        }
    }
};

// A 3-stage Sallen-Key low-pass cascade wrapped in OVERALL feedback: a resistor
// Rfb from the final output back to the first stage's summing node. It shows the
// analyzer handling a global feedback loop -- the tearing that factors a plain
// cascade cannot cut a feedback path (loading the fed-back node is no longer
// one-directional), so the three stages collapse into one strongly-connected
// block and the whole thing is solved as a single 6th-order symbolic H(s) in ~13
// free components. (Remove the feedback and the same three stages would factor
// into three independent biquads.)
//
// Generated by tiling one verified stage rather than hand-laying the points:
// stage geometry that extracts to `Ra in A; Rb A B; Ca A O; Cb B 0; O B O O`
// (a unity-gain Sallen-Key section), translated by a fixed pitch, each stage's
// output wired into the next, then Rfb routed from the last output back to N001.
// test_samples.js checks the extracted result structurally (16 elements, 3
// op-amps, the forward chain, and the feedback resistor onto the output).
(function () {
    // One stage, op-amp centred at (OX, 200). Ports: IN=(OX-160,200), O=(OX+30,200).
    function skStage(k, OX, N) {
        const C = [], W = [];
        const A = OX - 120, B = OX - 80;
        const inPlus = [OX - 30, 190], inMinus = [OX - 30, 210];
        const nm = (p) => `${p}${k + 1}`;

        C.push({ type: 'R', name: nm('Ra'), value: nm('Ra'), x: OX - 140, y: 200, rot: 0, mirror: false });
        C.push({ type: 'R', name: nm('Rb'), value: nm('Rb'), x: OX - 100, y: 200, rot: 0, mirror: false });
        C.push({ type: 'C', name: nm('Cb'), value: nm('Cb'), x: B, y: 220, rot: 90, mirror: false });
        C.push({ type: 'GND', name: '0', value: '', x: B, y: 240, rot: 0, mirror: false });
        C.push({ type: 'C', name: nm('Ca'), value: nm('Ca'), x: OX - 20, y: 120, rot: 0, mirror: false });
        C.push({ type: 'O', name: nm('O'), value: '', x: OX, y: 200, rot: 0, mirror: false });

        // B -> op-amp in+ (up-only, so it never covers in-, which would short the
        // inputs and be cut out by the normalizer).
        W.push({ x1: B, y1: 200, x2: inPlus[0], y2: 200 });
        W.push({ x1: inPlus[0], y1: 200, x2: inPlus[0], y2: inPlus[1] });
        // A up-and-over the op-amp to Ca, then down to the output (=O).
        W.push({ x1: A, y1: 200, x2: A, y2: 120 });
        W.push({ x1: A, y1: 120, x2: OX - 40, y2: 120 });
        W.push({ x1: OX, y1: 120, x2: OX + 30, y2: 120 });
        W.push({ x1: OX + 30, y1: 120, x2: OX + 30, y2: 200 });
        // in- -> output (unity-gain feedback), routed below the body.
        W.push({ x1: inMinus[0], y1: inMinus[1], x2: inMinus[0], y2: 240 });
        W.push({ x1: inMinus[0], y1: 240, x2: OX + 30, y2: 240 });
        W.push({ x1: OX + 30, y1: 240, x2: OX + 30, y2: 200 });
        // Hand the output to the next stage's input.
        if (k < N - 1) W.push({ x1: OX + 30, y1: 200, x2: (OX + 260) - 160, y2: 200 });
        return { C, W, IN: [OX - 160, 200], OUT: [OX + 30, 200] };
    }

    function buildCascade(N, feedback) {
        const OX0 = 250, DX = 260;
        let components = [], wires = [], first = null, last = null;
        for (let k = 0; k < N; k++) {
            const st = skStage(k, OX0 + k * DX, N);
            components = components.concat(st.C);
            wires = wires.concat(st.W);
            if (k === 0) first = st.IN;
            last = st.OUT;
        }
        if (feedback) {
            // Rfb: last output -> stage-1's N001 node (between Ra1 and Rb1),
            // routed along the top (y=80), clear of the stage bodies and Ca caps.
            const n001x = 130, outx = last[0], midx = 460;
            components.push({ type: 'R', name: 'Rfb', value: 'Rfb', x: midx, y: 80, rot: 0, mirror: false });
            wires.push({ x1: n001x, y1: 120, x2: n001x, y2: 80 });    // extend N001 up
            wires.push({ x1: n001x, y1: 80, x2: midx - 20, y2: 80 }); // -> Rfb left
            wires.push({ x1: midx + 20, y1: 80, x2: outx, y2: 80 });  // Rfb right ->
            wires.push({ x1: outx, y1: 80, x2: outx, y2: 200 });      // -> out
        }
        components.unshift({ type: 'LABEL', name: 'in', value: '', x: first[0], y: first[1], rot: 0, mirror: false });
        components.push({ type: 'LABEL', name: 'out', value: '', x: last[0], y: last[1], rot: 0, mirror: false });
        return { components, wires };
    }

    // The matched pair differs in one thing only: the overall feedback loop.
    // Both are the same three Sallen-Key stages. The plain cascade tears at the
    // op-amp outputs, so its H(s) comes out as a product of three second-order
    // sections; add the loop and it cannot be torn, so H(s) is one 6th-order
    // fraction. That difference in the result is a consequence of the topology,
    // not a setting on the sample -- so the names say "cascade" vs "+ overall
    // FB", never "factored" (which would read as a mode you picked).
    window.Samples.active_lpf_x3 = {
        title: 'Active LPF ×3 (cascade)',
        model: buildCascade(3, false),
    };
    window.Samples.active_lpf_fb3 = {
        title: 'Active LPF ×3 + Overall FB',
        model: buildCascade(3, true),
    };
})();
