// netlist.js
// Netlist extraction algorithm for SymTF

// 素子値として通る形。engine.py の _parse_value を写したもの。あちらは
//   1. sp.Rational(token)      が通れば数値
//   2. _PREFIX_RE (SI接頭辞)   が通れば数値
//   3. それ以外は Symbol(token, positive=True)
// の順に解釈する。3 に落ちた値は「その文字列を名前とする記号」になるだけで
// エラーにならないため、"2*R" は積ではなく '2*R' という名前の記号になる。
// 掛け算として解釈されることは無いので、ここで弾く。
//
// ★ この2つの正規表現は engine.py と一対一で対応させること。ずれると
//   正当な値("-10" や "1T")を弾いたり、記号になるだけの値("1g")を
//   数値として通したりする。
const VALUE_NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const VALUE_SI_RE = /^[+-]?\d+\.?\d*(?:[eE][+-]?\d+)?\s*[TGMkmuμnpf]$/;
const VALUE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isAcceptableValue(v) {
    return VALUE_NUMERIC_RE.test(v) || VALUE_SI_RE.test(v) || VALUE_IDENT_RE.test(v);
}

// True when the value is a number the engine will bake into the coefficients
// (as opposed to a symbol that appears in the substitution table). The UI uses
// this to list schematic-fixed values alongside the symbols, so a part like
// "R2 = 1k" doesn't silently vanish from the Values panel.
function isNumericValue(v) {
    return VALUE_NUMERIC_RE.test(v) || VALUE_SI_RE.test(v);
}

window.Netlist = {
    isNumericValue,
    // extract(model, opts)
    //   opts.virtualInput : ネット名。指定すると、そのノードと接地の間に
    //                       仮想電圧源 V_in を「回路の一部として」加える。
    //                       検証もテキスト生成もこれを含んだ状態で行う。
    extract: function(model, opts = {}) {
        const errors = [];
        const warnings = [];

        // --------------------------------------------------------------------
        // 1. 連結成分の分解 (Union-Find)
        // --------------------------------------------------------------------
        const parent = new Map();
        
        function find(i) {
            if (parent.get(i) === i) return i;
            const root = find(parent.get(i));
            parent.set(i, root);
            return root;
        }

        function union(i, j) {
            const rootI = find(i);
            const rootJ = find(j);
            if (rootI !== rootJ) {
                parent.set(rootI, rootJ);
            }
        }

        // 座標の一致は不変条件(1)により完全一致(===)で判定可能なので、
        // "x,y" 文字列をキーとする。
        const points = new Set();
        const addPoint = (x, y) => {
            const key = `${x},${y}`;
            if (!points.has(key)) {
                points.add(key);
                parent.set(key, key);
            }
            return key;
        };

        // U1: 同一座標にある点どうし (ピンとピン、ピンとワイヤ端点、ワイヤ端点どうし)
        // まず全「点」を登録。
        model.components.forEach(comp => {
            absPins(comp).forEach(p => addPoint(p.x, p.y));
        });

        model.wires.forEach(w => {
            const p1 = addPoint(w.x1, w.y1);
            const p2 = addPoint(w.x2, w.y2);
            // U2: 各ワイヤの始点と終点
            union(p1, p2);
        });

        // U3: ある点 p がワイヤ w の「内部」に厳密に乗っている場合、p と w の端点
        // 交差しているだけのワイヤを接続しない理由は、交点は「点」の集合に入っていないため
        // このループで処理されず、自動的に無視されるからである。
        for (const pKey of points) {
            const [pxStr, pyStr] = pKey.split(',');
            const px = parseInt(pxStr, 10);
            const py = parseInt(pyStr, 10);

            model.wires.forEach(w => {
                if (isStrictlyInside(px, py, w)) {
                    const wKey = `${w.x1},${w.y1}`; // ワイヤの一端でよい
                    union(pKey, wKey);
                }
            });
        }

        // グループ分け
        const groups = new Map();
        for (const pKey of points) {
            const root = find(pKey);
            if (!groups.has(root)) groups.set(root, []);
            groups.get(root).push(pKey);
        }

        // --------------------------------------------------------------------
        // 2. ノード名の割り当て
        // --------------------------------------------------------------------
        // 決定性を保証するため、各グループをそのグループ内の座標辞書順(x -> y)最小の点で整列
        function parsePt(pStr) {
            const [x, y] = pStr.split(',').map(Number);
            return {x, y};
        }
        function cmpPt(p1, p2) {
            if (p1.x !== p2.x) return p1.x - p2.x;
            return p1.y - p2.y;
        }

        const sortedRoots = Array.from(groups.keys()).sort((a, b) => {
            const ptsA = groups.get(a).map(parsePt).sort(cmpPt);
            const ptsB = groups.get(b).map(parsePt).sort(cmpPt);
            return cmpPt(ptsA[0], ptsB[0]);
        });

        const nodeNamesByRoot = new Map();
        let nextAutoId = 1;

        const labelsByRoot = new Map();
        const hasGND = new Map();
        
        for (const root of sortedRoots) {
            labelsByRoot.set(root, new Set());
            hasGND.set(root, false);
        }

        model.components.forEach(comp => {
            const pins = absPins(comp);
            if (pins.length > 0) {
                // GNDとLABELは1ピン
                const root = find(`${pins[0].x},${pins[0].y}`);
                if (comp.type === 'GND') {
                    hasGND.set(root, true);
                } else if (comp.type === 'LABEL') {
                    labelsByRoot.get(root).add(comp.name);
                }
            }
        });

        const usedNames = new Set();
        const availableLabels = new Set();
        model.components.filter(c => c.type === 'LABEL').forEach(c => {
            usedNames.add(c.name);
            availableLabels.add(c.name);
        });

        for (const root of sortedRoots) {
            const lbls = Array.from(labelsByRoot.get(root)).sort();
            
            if (hasGND.get(root)) {
                // N1: GND優先
                nodeNamesByRoot.set(root, "0");
                if (lbls.length > 0) {
                    warnings.push({msg: `A netname is attached to the ground node`});
                }
            } else if (lbls.length > 0) {
                // N2: LABEL優先
                if (lbls.length > 1) {
                    errors.push({msg: `One node carries two netnames: '${lbls[0]}' and '${lbls[1]}'`});
                }
                const lname = lbls[0];
                if (lname === "0" || lname === "GND") {
                    nodeNamesByRoot.set(root, "0");
                } else {
                    nodeNamesByRoot.set(root, lname);
                }
            } else {
                // N3: 自動採番
                // N001形式にする理由は、LTspice互換性を保つためと、
                // ユーザーが意図せず "1" などのラベルを使用した場合の衝突を防ぐため。
                let name;
                do {
                    name = `N${nextAutoId.toString().padStart(3, '0')}`;
                    nextAutoId++;
                } while (usedNames.has(name));
                nodeNamesByRoot.set(root, name);
                usedNames.add(name);
            }
        }

        const byPoint = {};
        for (const pKey of points) {
            byPoint[pKey] = nodeNamesByRoot.get(find(pKey));
        }
        const allNodeNames = Array.from(new Set(Object.values(byPoint))).sort();

        // --------------------------------------------------------------------
        // 4. 素子行の生成と検証
        // --------------------------------------------------------------------
        const elements = model.components.filter(c => c.type !== 'GND' && c.type !== 'LABEL');
        elements.sort((a, b) => a.name.localeCompare(b.name));

        // 各素子が触れているノード名。以降の検証はすべてこれを見る。
        // ★ GND と LABEL はネットリストの素子ではないので必ず除外する。
        //   engine.py の _validate_circuit は elements しか見ないため、
        //   ここで数え方を変えると M8 が ok を返した回路を engine が弾く。
        //   その時のメッセージは部品を特定できず、ユーザーが直せない。
        const elemNodes = elements.map(c => ({
            comp: c,
            nodes: absPins(c).map(p => byPoint[`${p.x},${p.y}`])
        }));

        // 仮想電源。ここで作るのは、これが「後から足すテキスト」ではなく
        // 解析対象の回路そのものの一部だからである。
        // ★ 浮遊ノード検査(E2)より前に足さなければならない。入力ノードは
        //   ふつう素子1つ(と入力ラベル)しか触れておらず、V_in が2つ目の
        //   素子になって初めて検査を通る。順序を逆にすると、教科書どおりの
        //   RCローパスすら「浮遊ノード」で弾かれる。
        let virtualSource = null;
        let virtualLine = null;
        if (opts.virtualInput) {
            const lbl = model.components.find(
                c => c.type === 'LABEL' && c.name === opts.virtualInput);
            if (!lbl) {
                errors.push({ msg: `Input node '${opts.virtualInput}' does not exist in the schematic` });
            } else {
                const p = absPins(lbl)[0];
                const node = byPoint[`${p.x},${p.y}`];
                if (node === "0") {
                    // V_in が短絡される。名前ではなく解決後のノードで判定する
                    // こと -- ラベル 'in' が接地ネットに乗っている場合がある。
                    errors.push({
                        msg: `Input '${opts.virtualInput}' is on the ground net and cannot be the input`,
                        componentId: lbl.id, x: lbl.x, y: lbl.y
                    });
                } else {
                    const taken = new Set(model.components.map(c => c.name));
                    virtualSource = 'V_in';
                    for (let i = 1; taken.has(virtualSource); i++) virtualSource = `V_in${i}`;
                    virtualLine = `${virtualSource} ${node} 0 ${virtualSource}`;
                    elemNodes.push({
                        comp: { id: null, name: virtualSource, type: 'V' },
                        nodes: [node, "0"]
                    });
                }
            }
        }

        const nodesInElements = new Set(elemNodes.flatMap(e => e.nodes));

        // E1: 接地。engine.py はノード "0" が「素子に現れるか」を見る。
        // GNDシンボルが置いてあるだけでは通らない(配線が届いていない等)。
        const gnds = model.components.filter(c => c.type === 'GND');
        if (gnds.length === 0) {
            errors.push({ msg: "No ground (GND) in the circuit" });
        } else if (!nodesInElements.has("0")) {
            gnds.forEach(g => errors.push({
                msg: "Ground (GND) is not connected to any element",
                componentId: g.id, x: g.x, y: g.y
            }));
        }

        // E3: 素子名の重複
        const nameCount = new Map();
        model.components.forEach(c => {
            if (c.type !== 'GND' && c.type !== 'LABEL') {
                nameCount.set(c.name, (nameCount.get(c.name) || 0) + 1);
            }
        });
        for (const [name, count] of nameCount.entries()) {
            if (count > 1) {
                const comp = model.components.find(c => c.name === name);
                errors.push({msg: `Duplicate element name '${name}'`, componentId: comp.id, x: comp.x, y: comp.y});
            }
        }

        const lines = [];

        // E2 のための出現カウント。engine.py の _validate_circuit と同じ規則:
        //   ・数えるのは素子のみ(GND/LABEL は素子ではない)
        //   ・1つの素子が同じノードに複数のピンで触れていても 1 と数える
        //   ・ノード "0" は対象外(接地は1素子しか触れていなくてよい)
        // ここが engine.py とずれると、片方だけが通る回路ができてしまう。
        const nodeOccurrences = new Map();
        elemNodes.forEach(({ nodes }) => {
            new Set(nodes.filter(n => n !== "0")).forEach(n => {
                nodeOccurrences.set(n, (nodeOccurrences.get(n) || 0) + 1);
            });
        });

        elements.forEach(comp => {
            const pins = absPins(comp);
            const nodes = pins.map(p => byPoint[`${p.x},${p.y}`]);
            
            const val = comp.value || comp.name;

            // E4: 素子名の頭文字が型と一致しない
            if (comp.name[0].toUpperCase() !== comp.type) {
                errors.push({msg: `'${comp.name}' is a ${comp.type} but its name does not start with '${comp.type}'`, componentId: comp.id, x: comp.x, y: comp.y});
            }

            // E5: 素子値が数値でも識別子でもない
            if (comp.type !== 'O' && !isAcceptableValue(val)) {
                errors.push({msg: `'${comp.name}' value '${val}' must be a number or a symbol name`, componentId: comp.id, x: comp.x, y: comp.y});
            }

            // 2.4節 ピンの配列順と端子順の対応を厳守
            if (['R', 'C', 'L'].includes(comp.type)) {
                lines.push(`${comp.name} ${nodes[0]} ${nodes[1]} ${val}`);
            } else if (['E', 'G'].includes(comp.type)) {
                // flip swaps the two output terminals (out+ <-> out-), which is
                // how the drawn polarity flip becomes an actual sign inversion.
                const oPlus = comp.flip ? nodes[1] : nodes[0];
                const oMinus = comp.flip ? nodes[0] : nodes[1];
                lines.push(`${comp.name} ${oPlus} ${oMinus} ${nodes[2]} ${nodes[3]} ${val}`);
            } else if (comp.type === 'O') {
                // Blank value -> ideal op-amp (3 terminals). A set value is the
                // finite-gain model "A0 GBW": exactly two acceptable tokens.
                const raw = (comp.value || '').trim();
                let line = `${comp.name} ${nodes[0]} ${nodes[1]} ${nodes[2]}`;
                if (raw) {
                    const toks = raw.split(/\s+/);
                    if (toks.length !== 2 || !toks.every(isAcceptableValue)) {
                        errors.push({ msg: `'${comp.name}' value must be blank (ideal) or the two tokens "A0 GBW"`, componentId: comp.id, x: comp.x, y: comp.y });
                    } else {
                        line += ` ${toks[0]} ${toks[1]}`;
                    }
                }
                lines.push(line);
            }
        });

        // 生成物なので、部品由来の行を並べ終えた後に置く。
        if (virtualLine) lines.push(virtualLine);

        // E2: 浮遊ノード。engine.py も同じ検査をするが、あちらは素子を特定
        // できない("Node 'x' appears in only one element")。どのピンかまで
        // 言えるのが M8 側で先に見る価値である。
        // 同じノードに複数のピンが乗っていても報告は1ノードにつき1回にする。
        const reportedFloating = new Set();
        elemNodes.forEach(({ comp, nodes }) => {
            nodes.forEach((node, i) => {
                if (nodeOccurrences.get(node) !== 1) return;
                const key = `${comp.id}:${node}`;
                if (reportedFloating.has(key)) return;
                reportedFloating.add(key);
                errors.push({
                    msg: `${comp.name} terminal ${pinName(comp.type, i)} (node ${node}) is not connected to any other element`,
                    componentId: comp.id, x: comp.x, y: comp.y
                });
            });
        });

        // E7: ラベル名が不正
        model.components.filter(c => c.type === 'LABEL').forEach(c => {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(c.name) && c.name !== '0') {
                errors.push({msg: `Netname '${c.name}' is not a valid name`, componentId: c.id, x: c.x, y: c.y});
            }
        });

        // W2: どの素子にも接続されていないラベル
        model.components.filter(c => c.type === 'LABEL').forEach(c => {
            const p = absPins(c)[0];
            const root = find(`${p.x},${p.y}`);
            let connectedToOther = false;
            model.components.forEach(comp => {
                if (comp.type !== 'LABEL') {
                    absPins(comp).forEach(cp => {
                        if (find(`${cp.x},${cp.y}`) === root) connectedToOther = true;
                    });
                }
            });
            if (!connectedToOther) {
                warnings.push({msg: `Netname '${c.name}' is not attached to any element`, componentId: c.id, x: c.x, y: c.y});
            }
        });

        // そのノードに素子が1つでも触れているか。ラベルもGNDも素子ではない
        // ので、ここには数えない。
        const rootHasElement = (root) => elemNodes.some(({ comp }) =>
            absPins(comp).some(p => find(`${p.x},${p.y}`) === root));

        // W3: どの素子にも届いていない配線。
        // ★ 素子が乗っていないグループには、浮いた配線だけでなく「どこにも
        //   繋いでいないラベル」も含まれる。後者を「配線があります」と報告
        //   するのは嘘であり、しかも W2 と二重に出る。配線が実在する場合に
        //   限って報告すること。
        for (const root of sortedRoots) {
            if (rootHasElement(root)) continue;
            const hasWire = model.wires.some(w =>
                find(`${w.x1},${w.y1}`) === root || find(`${w.x2},${w.y2}`) === root);
            if (!hasWire) continue;   // ラベルだけのグループは W2 の担当
            const pt = groups.get(root).map(parsePt).sort(cmpPt)[0];
            warnings.push({ msg: `A wire is not connected to any element`, x: pt.x, y: pt.y });
        }

        // Input / Output のドロップダウンに出すラベル。
        // ★ 解決後のノードが "0" のものは除く。GNDと同じネットに置かれた
        //   ラベルを入力に選ぶと、engine は "V_in <名前> 0 V_in" を受け取るが
        //   そのノードはどの素子にも存在しない(そのグループは "0" になった)。
        //   名前で "0"/"GND" を弾くだけでは足りない。
        // ★ どの素子にも届いていないラベルも除く。ポートとして選べてしまうと
        //   V_in だけが繋がったノードができ、ユーザーが置いた覚えのない素子
        //   についてのエラーが出る。名前を付ける相手がいないラベルは端子では
        //   ない。
        const labels = Array.from(new Set(
            model.components
                .filter(c => c.type === 'LABEL')
                .filter(c => {
                    const p = absPins(c)[0];
                    const key = `${p.x},${p.y}`;
                    return byPoint[key] !== "0" && rootHasElement(find(key));
                })
                .map(c => c.name)
        ));

        return {
            ok: errors.length === 0,
            text: lines.join('\n'),
            nodes: { byPoint, names: allNodeNames },
            labels,
            virtualSource,   // 注入した電源の素子名。solve の input.name に渡す
            errors,
            warnings
        };
    }
};
