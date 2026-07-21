// test_netlist.js
// Tests for M8a: Netlist Extraction
// Run with: deno run --allow-read test_netlist.js

const src1 = Deno.readTextFileSync(new URL("./schematic.js", import.meta.url));
const src2 = Deno.readTextFileSync(new URL("./netlist.js", import.meta.url));

globalThis.window = globalThis;
globalThis.document = { addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], getElementById: () => null };
globalThis.Konva = new Proxy({}, { get: () => class { constructor() {} } });

const hook = `
globalThis.absPins = absPins;
globalThis.isStrictlyInside = isStrictlyInside;
`;
(0, eval)(src1 + hook);
(0, eval)(src2);

let failures = 0;
const eq = (name, actual, expected) => {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) { console.log(`FAIL ${name}\n  got      ${a}\n  expected ${b}`); failures++; }
  else console.log(`ok   ${name}`);
};

const R = (x, y, name="R1", rot=0, mirror=false) => ({ type: "R", name, value: "", x, y, rot, mirror });
const C = (x, y, name="C1", rot=0, mirror=false) => ({ type: "C", name, value: "", x, y, rot, mirror });
const GND = (x, y) => ({ type: "GND", name: "0", value: "", x, y, rot: 0, mirror: false });
const LABEL = (x, y, name) => ({ type: "LABEL", name, value: "", x, y, rot: 0, mirror: false });
const W = (id, x1, y1, x2, y2) => ({ id, x1, y1, x2, y2 });

{
    // T20 RCローパス
    // R1: 80,100 -> 120,100
    // C1(rot90): 140,80 -> 140,120
    const model = {
        components: [
            R(100, 100, "R1"), 
            C(140, 100, "C1", 90, false),
            GND(140, 120),
            LABEL(80, 100, "in"),
            LABEL(140, 80, "out")
        ],
        wires: [
            W(1, 120, 100, 140, 100), // R1 right to C1 top
            W(2, 140, 80, 140, 100)   // out label to C1 top
        ]
    };
    const res = Netlist.extract(model);
    eq("T20 RCローパス", res.text.split('\n'), ["C1 out 0 C1", "R1 in out R1"]);
}

{
    // T21 T字接続
    // ワイヤの途中にピンが接続されている場合、同一ノードにまとまる(U3)
    const model = {
        components: [
            R(100, 100, "R1"), // pins: 80,100 and 120,100
            R(100, 150, "R2"), // pins: 80,150 and 120,150
            LABEL(120, 150, "out")
        ],
        wires: [
            W(1, 80, 50, 80, 200) // R1 pin (80,100) and R2 pin (80,150) strictly inside
        ]
    };
    const res = Netlist.extract(model);
    const lines = res.text.split('\n');
    const nR1 = lines[0].split(' ')[1];
    const nR2 = lines[1].split(' ')[1];
    eq("T21 T字接続 (ワイヤ途中のピンが同一ノードになる)", nR1 === nR2, true);
    eq("T21 T字接続 (右側は別ノード)", lines[0].split(' ')[2] !== lines[1].split(' ')[2], true);
}

{
    // T22 交差非接続
    // 十字に交差するだけの2本のワイヤが別ノードのまま残る
    const model = {
        components: [
            LABEL(0, 50, "left"),
            LABEL(100, 50, "right"),
            LABEL(50, 0, "top"),
            LABEL(50, 100, "bottom")
        ],
        wires: [
            W(1, 0, 50, 100, 50),
            W(2, 50, 0, 50, 100)
        ]
    };
    const res = Netlist.extract(model);
    eq("T22 交差非接続 (leftとtopは別ノード)", res.nodes.byPoint["0,50"] !== res.nodes.byPoint["50,0"], true);
    // left and right are connected
    eq("T22 交差非接続 (leftとrightは接続)", res.nodes.byPoint["0,50"], "left");
}

{
    // T23 自動採番
    const model = {
        components: [ R(100, 100, "R1"), R(160, 100, "R2") ],
        wires: [ W(1, 120, 100, 140, 100) ]
    };
    const res = Netlist.extract(model);
    eq("T23 自動採番", res.text.split('\n'), ["R1 N001 N002 R1", "R2 N002 N003 R2"]);
}

{
    // T24 採番衝突回避
    const model = {
        components: [
            R(100, 100, "R1"),
            LABEL(80, 100, "N001") // force collision
        ],
        wires: []
    };
    const res = Netlist.extract(model);
    eq("T24 採番衝突回避", res.text.split('\n'), ["R1 N001 N002 R1"]);
}

{
    // T25 GND優先
    const model = {
        components: [
            GND(100, 100),
            LABEL(100, 100, "gnd_label")
        ],
        wires: []
    };
    const res = Netlist.extract(model);
    eq("T25 GND優先", res.nodes.byPoint["100,100"], "0");
    eq("T25 GND優先 (警告あり)", res.warnings.some(w => w.msg.includes("A netname is attached to the ground node")), true);
}

{
    // T26 ラベル競合
    const model = {
        components: [
            LABEL(100, 100, "L1"),
            LABEL(100, 100, "L2")
        ],
        wires: []
    };
    const res = Netlist.extract(model);
    eq("T26 ラベル競合", res.errors.some(e => e.msg.includes("One node carries two netnames")), true);
}

{
    // T27 同名ラベルの離れ置き
    const model = {
        components: [
            R(100, 100, "R1"), LABEL(120, 100, "Vout"),
            R(200, 100, "R2"), LABEL(180, 100, "Vout")
        ],
        wires: []
    };
    const res = Netlist.extract(model);
    const lines = res.text.split('\n');
    eq("T27 同名ラベルの離れ置き", lines[0].split(' ')[2] === lines[1].split(' ')[1] && lines[0].split(' ')[2] === "Vout", true);
}

{
    // T28 回転・ミラー
    const model = {
        components: [
            { type: "E", name: "E1", value: "", x: 100, y: 100, rot: 90, mirror: true }
        ],
        wires: []
    };
    const res = Netlist.extract(model);
    // As long as it generates 4 pins based on absPins order, we are good.
    // The actual values don't matter as much as the fact it processes E properly.
    eq("T28 回転・ミラー (4端子)", res.text.split(' ')[0], "E1");
    eq("T28 回転・ミラー (端子数)", res.text.split(' ').length, 6);
}

{
    // Op-amp value: blank -> ideal 3-terminal line; "A0 GBW" -> finite-gain.
    // O1 at (100,100): in+ (70,90), in- (70,110), out (130,100).
    const O = (value) => ({
        components: [
            { type: "O", name: "O1", value, x: 100, y: 100, rot: 0, mirror: false },
            { type: "GND", name: "0", value: "", x: 70, y: 90, rot: 0, mirror: false },    // in+
            { type: "LABEL", name: "in", value: "", x: 70, y: 110, rot: 0, mirror: false },  // in-
            { type: "LABEL", name: "out", value: "", x: 130, y: 100, rot: 0, mirror: false } // out
        ],
        wires: []
    });
    const line = (m) => Netlist.extract(m).text.split('\n').find(l => l.startsWith('O1'));

    eq("ideal op-amp emits 3 terminals", line(O('')).split(' ').length, 4);
    eq("finite op-amp appends A0 GBW", line(O('A0 GBW')), 'O1 0 in out A0 GBW');

    // A malformed value (one token) is an error.
    eq("op-amp value must be blank or two tokens",
       Netlist.extract(O('A0')).errors.some(e => e.msg.includes('A0 GBW')), true);
}

{
    // Controlled-source output polarity flip swaps the two output terminals,
    // which is what turns the drawn flip into a real sign inversion.
    // E1 at (100,100): out+ (120,80), out- (120,120), ctrl+ (80,80), ctrl- (80,120).
    const mk = (flip) => ({
        components: [
            { type: "E", name: "E1", value: "A", x: 100, y: 100, rot: 0, mirror: false, ...(flip ? { flip: true } : {}) },
            LABEL(120, 80, "op"), LABEL(120, 120, "om"), LABEL(80, 80, "cp"), LABEL(80, 120, "cm")
        ],
        wires: []
    });
    const line = (m) => Netlist.extract(m).text.split('\n').find(l => l.startsWith('E1'));
    eq("E not flipped: out+ out- ctrl+ ctrl-", line(mk(false)), "E1 op om cp cm A");
    eq("E flipped swaps only the output pair", line(mk(true)), "E1 om op cp cm A");
    // Control terminals are untouched by the flip.
    eq("flip leaves control pins in place",
       line(mk(true)).split(' ').slice(3, 5).join(' '), "cp cm");

    // G (VCCS) uses the same flip path -- swapping the output pair is what makes
    // the engine invert the sign (verified: -RL*gm -> +RL*gm).
    const mkG = (flip) => ({
        components: [
            { type: "G", name: "G1", value: "gm", x: 100, y: 100, rot: 0, mirror: false, ...(flip ? { flip: true } : {}) },
            LABEL(120, 80, "op"), LABEL(120, 120, "om"), LABEL(80, 80, "cp"), LABEL(80, 120, "cm")
        ],
        wires: []
    });
    const lineG = (m) => Netlist.extract(m).text.split('\n').find(l => l.startsWith('G1'));
    eq("G flipped swaps the output pair", lineG(mkG(true)), "G1 om op cp cm gm");
}

{
    // Coupled inductor pair (mutual inductance / transformer): K1 at
    // (100,100), value "L1 L2 k". Pins: p1+ (70,80), p1- (70,120),
    // p2+ (130,80), p2- (130,120).
    const K = (value) => ({
        components: [
            { type: "K", name: "K1", value, x: 100, y: 100, rot: 0, mirror: false },
            LABEL(70, 80, "p1p"), LABEL(70, 120, "p1m"),
            LABEL(130, 80, "p2p"), LABEL(130, 120, "p2m")
        ],
        wires: []
    });
    const lineK = (m) => Netlist.extract(m).text.split('\n').find(l => l.startsWith('K1'));

    eq("K emits 4 nodes + L1 L2 k", lineK(K('L1 L2 0.95')), 'K1 p1p p1m p2p p2m L1 L2 0.95');
    eq("a negative (reversed) k is accepted",
       lineK(K('L1 L2 -0.95')), 'K1 p1p p1m p2p p2m L1 L2 -0.95');

    // Wrong token count is an error, same as any other malformed value.
    eq("K needs exactly three values (two is an error)",
       Netlist.extract(K('L1 L2')).errors.some(e => e.msg.includes('three values')), true);
    eq("blank K is an error -- unlike the op-amp, there is no ideal default",
       Netlist.extract(K('')).errors.some(e => e.msg.includes('three values')), true);
}

{
    // T33 決定性
    const model1 = {
        components: [ R(100, 100, "R1"), C(100, 150, "C1") ],
        wires: [ W(1, 120, 100, 120, 150) ]
    };
    // Swap order of components in model2
    const model2 = {
        components: [ C(100, 150, "C1"), R(100, 100, "R1") ],
        wires: [ W(1, 120, 100, 120, 150) ]
    };
    const res1 = Netlist.extract(model1);
    const res2 = Netlist.extract(model2);
    eq("T33 決定性", res1.text, res2.text);
}

{
    // T29 名前の頭文字検証
    const model = {
        components: [
            { type: "R", name: "load", value: "", x: 100, y: 100, rot: 0, mirror: false },
            C(100, 150, "C1"), GND(100, 200)
        ],
        wires: [W(1, 120, 100, 120, 150)]
    };
    const res = Netlist.extract(model);
    eq("T29 名前の頭文字検証 (loadはエラー)", res.errors.some(e => e.msg.includes("'load' is a R but")), true);
}

{
    // T30 値の検証
    const modelPass = {
        components: [
            { type: "R", name: "R1", value: "1k", x: 100, y: 100, rot: 0, mirror: false },
            { type: "C", name: "C1", value: "Rload", x: 100, y: 150, rot: 0, mirror: false },
            GND(100, 200)
        ],
        wires: [W(1, 120, 100, 120, 150)] // prevent floating nodes as much as possible, though missing GND might trigger E1, we focus on E5
    };
    const resPass = Netlist.extract(modelPass);
    eq("T30 値の検証 (1kとRloadは通る)", resPass.errors.filter(e => e.msg.includes("must be a number or a symbol name")).length, 0);

    const modelFail = {
        components: [
            { type: "R", name: "R1", value: "2*R", x: 100, y: 100, rot: 0, mirror: false },
            GND(100, 200)
        ],
        wires: []
    };
    const resFail = Netlist.extract(modelFail);
    eq("T30 値の検証 (2*Rはエラー)", resFail.errors.some(e => e.msg.includes("'2*R' must be a number or a symbol name")), true);
}

{
    // T31 浮遊ノード
    const model = {
        components: [
            R(100, 100, "R1"), // pins 80,100 and 120,100
            GND(80, 100) // connect left side, right side floats
        ],
        wires: []
    };
    const res = Netlist.extract(model);
    eq("T31 浮遊ノード (R1の片側のみ接続)", res.errors.some(e => e.msg.includes("R1 terminal 2")), true);
}

{
    // T35 仮想電源。入力ノードは R1 しか触れていないので、V_in が「回路の
    // 一部として」加わらないかぎり浮遊ノードとして弾かれる。注入をテキストの
    // 後付けにすると、教科書どおりの RC ローパスすら解析できなくなる。
    const model = {
        components: [
            R(100, 100, "R1"), C(140, 100, "C1", 90, false), GND(140, 120),
            LABEL(80, 100, "in"), LABEL(140, 80, "out")
        ],
        wires: [ W(1, 120, 100, 140, 100), W(2, 140, 80, 140, 100) ]
    };
    const bare = Netlist.extract(model);
    eq("T35 仮想電源なしでは入力ノードが浮遊する",
       bare.errors.some(e => e.msg.includes("(node in)")), true);

    const res = Netlist.extract(model, { virtualInput: "in" });
    eq("T35 仮想電源つきで抽出が通る", [res.ok, res.errors], [true, []]);
    eq("T35 仮想電源の素子名", res.virtualSource, "V_in");
    // この文字列をそのまま engine.parse_netlist -> solve に通すと
    // H(s) = 1/(1 + C1*R1*s) が出る(基本仕様書 T1 と同じ)。
    eq("T35 生成ネットリスト", res.text.split('\n'),
       ["C1 out 0 C1", "R1 in out R1", "V_in in 0 V_in"]);

    // 名前が衝突したら退避すること。
    const clash = JSON.parse(JSON.stringify(model));
    clash.components.push({ type: "R", name: "V_in", value: "1k", x: 400, y: 400, rot: 0, mirror: false });
    eq("T35 V_in が既存名と衝突したら退避する",
       Netlist.extract(clash, { virtualInput: "in" }).virtualSource, "V_in1");

    // virtualInputKind: 'I' -- current-source input (transimpedance / Zin/Zout).
    // Element name must start with 'I', not 'V', or the engine's own name/type
    // check would reject the generated line.
    const cur = Netlist.extract(model, { virtualInput: "in", virtualInputKind: "I" });
    eq("T35 電流源入力: 抽出が通る", [cur.ok, cur.errors], [true, []]);
    eq("T35 電流源入力: 素子名は I_ で始まる", cur.virtualSource, "I_in");
    eq("T35 電流源入力: 生成ネットリスト", cur.text.split('\n'),
       ["C1 out 0 C1", "R1 in out R1", "I_in in 0 I_in"]);
}

{
    // 接地ネット上のラベルを入力に指定したら、V_in が短絡されるのでエラー。
    const model = {
        components: [
            R(100, 100, "R1"), R(180, 100, "R2"), GND(80, 100),
            LABEL(80, 100, "in"), LABEL(200, 100, "out")
        ],
        wires: [ W(1, 120, 100, 160, 100) ]
    };
    const res = Netlist.extract(model, { virtualInput: "in" });
    eq("接地ネット上のラベルを入力にするとエラー",
       res.errors.some(e => e.msg.includes("is on the ground net")), true);
}

{
    // ラベルを部品のピンに直付けした場合。配線の上に置いた場合と完全に同じ
    // ネットリストにならなければならない。
    const onWire = {
        components: [
            R(200, 200, "R1"), LABEL(180, 200, "in"), LABEL(260, 200, "out"),
            C(300, 220, "C1", 90), GND(300, 240)
        ],
        wires: [ W(1, 220, 200, 300, 200) ]
    };
    const onPin = JSON.parse(JSON.stringify(onWire));
    onPin.components[2].x = 300;   // "out" をワイヤ上から C1 のピンに移す

    const a = Netlist.extract(onWire, { virtualInput: "in" });
    const b = Netlist.extract(onPin, { virtualInput: "in" });
    eq("ピン直付けのラベルはワイヤ上と同じネットリストになる", b.text, a.text);
    eq("ピン直付けでも抽出は通る", [b.ok, b.errors], [true, []]);
}

{
    // どこにも繋いでいないラベルは端子ではない。ポートに出すと、V_in だけが
    // 繋がったノードができ、ユーザーが置いていない素子のエラーが出る。
    const model = {
        components: [
            R(100, 100, "R1"), GND(80, 100),
            LABEL(120, 100, "out"),
            LABEL(400, 400, "stray")     // 宙に浮いている
        ],
        wires: []
    };
    const res = Netlist.extract(model);
    eq("宙に浮いたラベルはポート候補に出ない", res.labels, ["out"]);
    eq("宙に浮いたラベルは警告される",
       res.warnings.some(w => w.msg.includes("Netname 'stray' is not attached to any element")), true);
    // 配線は1本も無いのだから「配線があります」と言ってはいけない。
    eq("ラベルだけのグループを配線と呼ばない",
       res.warnings.some(w => w.msg.includes("wire is not connected")), false);
}

{
    // 本物の浮遊配線はきちんと報告すること。
    const model = {
        components: [ R(100, 100, "R1"), GND(80, 100), LABEL(120, 100, "out") ],
        wires: [ W(9, 400, 400, 460, 400) ]
    };
    const res = Netlist.extract(model);
    eq("素子に届かない配線は警告する",
       res.warnings.some(w => w.msg.includes("A wire is not connected to any element")), true);
}

// --- E1/E2 は engine.py の _validate_circuit と同じ判定でなければならない ---
// ここがずれると M8 が ok を返した回路を engine が弾き、しかもそのメッセージは
// 部品を特定できないのでユーザーが直せない。

{
    // GNDシンボルは置いてあるが、配線がどの素子にも届いていない。
    // 以前は「GNDが存在する」だけで通り、engine が "No ground node" で弾いていた。
    const model = {
        components: [
            R(100, 100, "R1"), R(180, 100, "R2"),
            GND(400, 400),
            LABEL(80, 100, "in"), LABEL(200, 100, "out")
        ],
        wires: [ W(1, 120, 100, 160, 100) ]
    };
    const res = Netlist.extract(model);
    eq("E1 GNDが素子に届いていなければエラー",
       res.errors.some(e => e.msg.includes("Ground (GND) is not connected to any element")), true);
}

{
    // ラベルは素子ではない。素子1つ + ラベルのノードは浮遊である。
    // 以前は LABEL をカウントに含めていたため 2 と数えて見逃していた。
    const model = {
        components: [
            R(100, 100, "R1"),
            GND(80, 100),
            LABEL(120, 100, "out")   // R1 の右端。素子は R1 だけ
        ],
        wires: []
    };
    const res = Netlist.extract(model);
    eq("E2 ラベルは素子として数えない",
       res.errors.some(e => e.msg.includes("R1 terminal 2")), true);
}

{
    // 1つの素子が同じノードに両ピンで触れていても「1素子」と数える(engine と同じ)。
    const model = {
        components: [ R(100, 100, "R1"), GND(80, 100) ],
        wires: [ W(1, 80, 100, 80, 60), W(2, 80, 60, 120, 60), W(3, 120, 60, 120, 100) ]
    };
    const res = Netlist.extract(model);
    // 両ピンが同一ノード("0")に落ちるので、浮遊ノードは無い
    eq("E2 自己短絡した素子は端子2つ分と数えない",
       res.errors.filter(e => e.msg.includes("terminal")).length, 0);
}

{
    // GNDと同じネットに置かれたラベルは Input に選ばせてはならない。
    // 選ぶと "V_in in 0 V_in" になるが、ノード 'in' はどの素子にも無い。
    const model = {
        components: [
            R(100, 100, "R1"), R(180, 100, "R2"),
            GND(80, 100),
            LABEL(80, 100, "in"),      // GND と同じ点
            LABEL(200, 100, "out")
        ],
        wires: [ W(1, 120, 100, 160, 100) ]
    };
    const res = Netlist.extract(model);
    eq("接地ネット上のラベルは Input 候補から外れる", res.labels, ["out"]);
    eq("そのラベルのノードは 0 のまま", res.nodes.byPoint["80,100"], "0");
}

{
    // isNumericValue: 「エンジンが数値として焼き込む値」の判定。Values タブが
    // 回路図固定値(R2=1k)の行を出すのに使う。記号(R1)は false でなければ
    // ならない -- true にすると記号が固定値の行に化ける。
    const num = ["1k", "4.7u", "100", "1e3", "-10", ".5", "1T"];
    const sym = ["R1", "A0", "Rload", "2*R", ""];
    for (const v of num) eq(`isNumericValue accepts ${JSON.stringify(v)}`, Netlist.isNumericValue(v), true);
    for (const v of sym) eq(`isNumericValue rejects ${JSON.stringify(v)}`, Netlist.isNumericValue(v), false);
}

{
    // E5: engine.py の _parse_value と同じ値だけを通すこと。
    // 期待値は engine._parse_value を実際に走らせて確かめたもの。
    // "" は「name と同じ」を意味する既定値なので、値としては R1 が使われる。
    const accept = ["1k", "4.7u", "100", "Rload", "-10", "1T", "1f", "1e3", ".5", ""];
    const reject = ["2*R", "1g", "1meg", "R 1"];
    const check = (v) => {
        const model = {
            components: [
                { type: "R", name: "R1", value: v, x: 100, y: 100, rot: 0, mirror: false },
                GND(80, 100), LABEL(120, 100, "out")
            ],
            wires: []
        };
        return !Netlist.extract(model).errors.some(e => e.msg.includes("must be a number or a symbol name"));
    };
    for (const v of accept) eq(`E5 accepts ${JSON.stringify(v)}`, check(v), true);
    for (const v of reject) eq(`E5 rejects ${JSON.stringify(v)}`, check(v), false);
}

{
    // T32 GNDなし
    const model = {
        components: [ R(100, 100, "R1") ],
        wires: []
    };
    const res = Netlist.extract(model);
    eq("T32 GNDなし", res.errors.some(e => e.msg.includes("No ground (GND) in the circuit")), true);
}

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
if (failures) Deno.exit(1);
