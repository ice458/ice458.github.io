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
