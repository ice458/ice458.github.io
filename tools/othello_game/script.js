// JavaScriptコードをここに記述します

const boardElement = document.getElementById('board');
const messageElement = document.getElementById('message');
const scoreElement = document.getElementById('score');
const boardSize = 8;
let board = []; // ゲーム盤の状態を保持する2次元配列
let currentPlayer = 'black'; // 現在のプレイヤー（'black' または 'white'）
let gameOver = false;

const CPU_PLAYER = 'white';
const HUMAN_PLAYER = 'black';
const DEFAULT_SEARCH_DEPTH = 6; // 通常の探索深度
let currentSearchDepth = DEFAULT_SEARCH_DEPTH; // 現在の探索深度
let isThinking = false; // CPU思考中フラグ

const SPECIAL_SQUARES = [[1, 1], [1, 6], [6, 1], [6, 6]]; // 連続手番マスの座標

// 各マスの重み (静的評価用)
// 角、辺、X打ち/C打ちなどを考慮
const SQUARE_WEIGHTS = [
    [ 120, -40,  20,   5,   5,  20, -40, 120],
    [ -40, -80,  -5,  -5,  -5,  -5, -80, -40],
    [  20,  -5,  15,   3,   3,  15,  -5,  20],
    [   5,  -5,   3,   3,   3,   3,  -5,   5],
    [   5,  -5,   3,   3,   3,   3,  -5,   5],
    [  20,  -5,  15,   3,   3,  15,  -5,  20],
    [ -40, -80,  -5,  -5,  -5,  -5, -80, -40],
    [ 120, -40,  20,   5,   5,  20, -40, 120]
];

// 方向ベクトル (8方向)
const directions = [
    [-1, -1], [-1, 0], [-1, 1],
    [ 0, -1],          [ 0, 1],
    [ 1, -1], [ 1, 0], [ 1, 1]
];

let gameMode = 'normal'; // ゲームモード (normal, sontaku, lose)

// --- DOM要素取得 ---
const modeSelectionDiv = document.getElementById('mode-selection');
const gameAreaDiv = document.getElementById('game-area');
const startButton = document.getElementById('start-button');
const resetButton = document.getElementById('reset-button');
const modeRadios = document.querySelectorAll('input[name="mode"]');

// --- イベントリスナー ---
startButton.addEventListener('click', startGame);
resetButton.addEventListener('click', resetGame);

// --- ゲーム制御関数 ---
function startGame() {
    // 選択されたモードを取得
    modeRadios.forEach(radio => {
        if (radio.checked) {
            gameMode = radio.value;
        }
    });

    // UI切り替え
    document.body.classList.add('game-started');
    modeSelectionDiv.style.display = 'none'; // CSSクラスでも制御するが念のため
    gameAreaDiv.style.display = 'flex';

    // ゲーム初期化
    initializeBoard();
}

function resetGame() {
    // UI切り替え
    document.body.classList.remove('game-started');
    modeSelectionDiv.style.display = 'block';
    gameAreaDiv.style.display = 'none';
    gameOver = true; // 進行中のゲームを停止状態にする
}

// ヘルパー関数: 指定された座標が特殊マスか判定
function isSpecialSquare(r, c) {
    return SPECIAL_SQUARES.some(sq => sq[0] === r && sq[1] === c);
}

// ゲーム盤の初期化 (ゲーム開始時に呼ばれる)
function initializeBoard() {
    board = Array(boardSize).fill(null).map(() => Array(boardSize).fill(null));
    // 初期配置
    board[3][3] = 'white';
    board[3][4] = 'black';
    board[4][3] = 'black';
    board[4][4] = 'white';
    currentPlayer = HUMAN_PLAYER; // 常に人間から開始
    gameOver = false;
    isThinking = false;

    // モードに応じて探索深度を設定
    if (gameMode === 'sontaku') {
        currentSearchDepth = 1; // 忖度モードは浅く探索
        console.log("忖度モード: 探索深度 =", currentSearchDepth);
    } else {
        currentSearchDepth = DEFAULT_SEARCH_DEPTH; // それ以外はデフォルト深度
        console.log("モード:", gameMode, "探索深度 =", currentSearchDepth);
    }

    renderBoard();
    updateMessage();
    updateScore();
}

// ゲーム盤の描画
function renderBoard() {
    boardElement.innerHTML = ''; // ボードをクリア
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            const cell = document.createElement('div');
            cell.classList.add('cell');
            cell.dataset.row = r;
            cell.dataset.col = c;
            cell.addEventListener('click', handleCellClick);

            // 特殊マスにクラスを追加
            if (isSpecialSquare(r, c)) {
                cell.classList.add('special-cell');
            }

            const disc = board[r][c];
            if (disc) {
                const discElement = document.createElement('div');
                discElement.classList.add('disc', disc);
                cell.appendChild(discElement);
            }
            boardElement.appendChild(cell);
        }
    }
}

// セルがクリックされたときの処理
function handleCellClick(event) {
    // ゲーム終了後、CPUのターン中、または思考中はクリック無効
    if (gameOver || currentPlayer === CPU_PLAYER || isThinking) return;

    // セル要素から座標を取得 (data属性がない場合は親要素から取得)
    let targetCell = event.target;
    if (!targetCell.classList.contains('cell')) {
        targetCell = targetCell.closest('.cell');
    }
    if (!targetCell || !targetCell.dataset.row || !targetCell.dataset.col) return; // クリック位置が無効なら何もしない

    const row = parseInt(targetCell.dataset.row);
    const col = parseInt(targetCell.dataset.col);

    if (board[row][col] !== null) {
        console.log("既に石が置かれています。");
        return; // 既に石があれば置けない
    }

    const flips = getFlipsFromBoard(row, col, currentPlayer, board);

    if (flips.length === 0) {
        console.log("ここには置けません。");
        return; // ひっくり返せる石がなければ置けない
    }

    // 石を置く & ひっくり返す
    placeDisc(row, col, currentPlayer, flips);
    renderBoard();
    updateScore();

    // ★連続手番チェック★
    if (isSpecialSquare(row, col)) {
        updateMessage('連続手番！続けて打ってください。');
        // プレイヤー交代せずに、再度プレイヤーのターン
        // 有効手があるかチェック (念のため)
        if (!hasValidMoves(currentPlayer)) {
             // 本来ここには来ないはずだが、万が一置けなくなったら相手に渡す
             console.log("連続手番ですが、置ける場所がありません。");
             switchPlayer();
        }
        // 何もしなければ、再度プレイヤーがクリックするのを待つ状態になる
    } else {
        // 通常通りプレイヤー交代
        switchPlayer();
    }
}

// 石を置いてひっくり返す処理を共通化
function placeDisc(row, col, player, flips) {
    board[row][col] = player;
    flips.forEach(([r, c]) => {
        board[r][c] = player;
    });
}

// 指定した場所に石を置いた場合にひっくり返る石のリストを取得 (盤面データを引数に追加)
function getFlipsFromBoard(row, col, player, boardData) {
    const opponent = player === 'black' ? 'white' : 'black';
    const flips = [];

    for (const [dr, dc] of directions) {
        let r = row + dr;
        let c = col + dc;
        const potentialFlips = [];

        while (r >= 0 && r < boardSize && c >= 0 && c < boardSize) {
            if (boardData[r][c] === opponent) {
                potentialFlips.push([r, c]);
            } else if (boardData[r][c] === player) {
                flips.push(...potentialFlips);
                break; // 自分の石が見つかったら、この方向の探索を終了
            } else {
                break; // 空白または盤外なら終了
            }
            r += dr;
            c += dc;
        }
    }
    return flips;
}

// プレイヤーを交代する
function switchPlayer() {
    currentPlayer = (currentPlayer === HUMAN_PLAYER) ? CPU_PLAYER : HUMAN_PLAYER;

    // 次のプレイヤーが置ける場所があるかチェック
    if (!hasValidMoves(currentPlayer)) {
        const opponent = (currentPlayer === HUMAN_PLAYER) ? CPU_PLAYER : HUMAN_PLAYER;
        // 相手も置けないかチェック
        if (!hasValidMoves(opponent)) {
            gameOver = true;
            declareWinner();
            return; // ゲーム終了
        }
        // パスの場合
        updateMessage(`${currentPlayer === HUMAN_PLAYER ? 'あなた' : 'CPU'} (${currentPlayer}) はパスします。`);
        currentPlayer = opponent; // 再度交代
    }

    updateMessage(); // プレイヤー表示更新
    updateScore();

    // CPUのターンの場合
    if (!gameOver && currentPlayer === CPU_PLAYER) {
        isThinking = true;
        updateMessage(`CPU (${CPU_PLAYER}) が思考中...`);
        // 少し遅延させて思考を開始（描画更新のため）
        setTimeout(makeComputerMove, 500);
    }
}

// 指定されたプレイヤーが置ける場所があるかチェック
function hasValidMoves(player) {
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (board[r][c] === null && getFlipsFromBoard(r, c, player, board).length > 0) {
                return true; // 置ける場所が1つでもあればtrue
            }
        }
    }
    return false; // 置ける場所がなければfalse
}

// 指定されたプレイヤーの有効な手をすべて取得 (盤面データを引数に追加)
function getValidMoves(player, boardData) {
    const validMoves = [];
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (boardData[r][c] === null) {
                const flips = getFlipsFromBoard(r, c, player, boardData);
                if (flips.length > 0) {
                    validMoves.push({ row: r, col: c, flips: flips });
                }
            }
        }
    }
    return validMoves;
}

// メッセージ表示を更新
function updateMessage(message = '') {
    if (gameOver) return; // 終了メッセージは declareWinner で表示
    if (message) {
        messageElement.textContent = message;
    } else if (isThinking) {
         messageElement.textContent = `CPU (${CPU_PLAYER}) が思考中...`;
    }
     else {
        const playerText = currentPlayer === HUMAN_PLAYER ? 'あなた' : 'CPU';
        messageElement.textContent = `現在のプレイヤー: ${playerText} (${currentPlayer})`;
    }
}

// スコア表示を更新
function updateScore() {
    let blackScore = 0;
    let whiteScore = 0;
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (board[r][c] === 'black') {
                blackScore++;
            } else if (board[r][c] === 'white') {
                whiteScore++;
            }
        }
    }
    scoreElement.textContent = `黒: ${blackScore} - 白: ${whiteScore}`;
    return { blackScore, whiteScore };
}

// 勝者を宣言
function declareWinner() {
    const { blackScore, whiteScore } = calculateScore();
    let winnerMessage = '';
    if (blackScore > whiteScore) {
        winnerMessage = `黒の勝ち！ (${blackScore} - ${whiteScore})`;
    } else if (whiteScore > blackScore) {
        winnerMessage = `白の勝ち！ (${blackScore} - ${whiteScore})`;
    } else {
        winnerMessage = `引き分け！ (${blackScore} - ${whiteScore})`;
    }
    messageElement.textContent = `ゲーム終了！ ${winnerMessage}`;
}

// スコア計算 (updateScoreと同じだが、終了時用に別関数としておく)
function calculateScore() {
    let blackScore = 0;
    let whiteScore = 0;
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (board[r][c] === 'black') {
                blackScore++;
            } else if (board[r][c] === 'white') {
                whiteScore++;
            }
        }
    }
    return { blackScore, whiteScore };
}

// スコア計算（盤面データから）
function calculateScoreFromBoard(boardData) {
    let blackScore = 0;
    let whiteScore = 0;
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (boardData[r][c] === 'black') blackScore++;
            else if (boardData[r][c] === 'white') whiteScore++;
        }
    }
    return { blackScore, whiteScore };
}

// --- CPU思考ロジック --- 

// 盤面評価関数
function evaluateBoard(currentBoard, player) {
    const opponent = player === 'black' ? 'white' : 'black';
    let totalScore = 0;

    let emptySquares = 0;
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (currentBoard[r][c] === null) {
                emptySquares++;
            }
        }
    }
    const gamePhaseFactor = (boardSize * boardSize - emptySquares) / (boardSize * boardSize); // ゲーム進行度 (0 -> 1)

    // 1. 確定石の評価
    let playerStableDiscs = countStableDiscs(currentBoard, player);
    let opponentStableDiscs = countStableDiscs(currentBoard, opponent);
    totalScore += (playerStableDiscs - opponentStableDiscs) * 200; // 確定石は非常に重要

    // 2. マスの位置による評価 (静的重み)
    let playerSquareScore = 0;
    let opponentSquareScore = 0;
    for (let r = 0; r < boardSize; r++) {
        for (let c = 0; c < boardSize; c++) {
            if (currentBoard[r][c] === player) {
                playerSquareScore += SQUARE_WEIGHTS[r][c];
            } else if (currentBoard[r][c] === opponent) {
                opponentSquareScore += SQUARE_WEIGHTS[r][c];
            }
        }
    }
    // 序盤・中盤は位置評価を重視、終盤は少し下げる
    totalScore += (playerSquareScore - opponentSquareScore) * (1.5 - gamePhaseFactor);

    // 3. 置ける場所の数（機動力）の評価
    let playerMoves = getValidMoves(player, currentBoard).length;
    let opponentMoves = getValidMoves(opponent, currentBoard).length;
    // 序盤・中盤は機動力を重視
    totalScore += (playerMoves - opponentMoves) * 15 * (1 - gamePhaseFactor);

    // 4. 石数の評価 (終盤に重要度が増す)
    let { blackScore, whiteScore } = calculateScoreFromBoard(currentBoard);
    let discDiff = (player === 'black' ? blackScore - whiteScore : whiteScore - blackScore);
    // 終盤ほど石数評価の重みを上げる
    totalScore += discDiff * (1 + gamePhaseFactor * 2);

    return totalScore;
}

// 確定石の数を数える (簡易版: 角からの連続のみ)
function countStableDiscs(boardData, player) {
    let stableCount = 0;
    const corners = [[0, 0], [0, 7], [7, 0], [7, 7]];
    const stableFlags = Array(boardSize).fill(0).map(() => Array(boardSize).fill(false));

    for (const [cr, cc] of corners) {
        if (boardData[cr][cc] === player && !stableFlags[cr][cc]) {
            // 角が自分の石なら、そこから探索して確定石をカウント
            const stack = [[cr, cc]];
            stableFlags[cr][cc] = true;
            stableCount++;

            while (stack.length > 0) {
                const [r, c] = stack.pop();

                // 隣接する自分の石をチェック (4方向)
                const neighbors = [[r-1, c], [r+1, c], [r, c-1], [r, c+1]];
                for (const [nr, nc] of neighbors) {
                    if (nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize &&
                        boardData[nr][nc] === player && !stableFlags[nr][nc]) {
                        // 確定石かどうかを簡易的に判定 (ここでは角からの連続性のみ)
                        // 本来はもっと厳密な判定が必要
                        if (isPotentiallyStable(boardData, nr, nc, player, stableFlags)) {
                             stableFlags[nr][nc] = true;
                             stableCount++;
                             stack.push([nr, nc]);
                        }
                    }
                }
            }
        }
    }
    return stableCount;
}

// 簡易的な確定石判定 (角からの連続性)
// より正確には、縦横斜めのライン全てが自分の石で埋まっているかなどをチェックする必要がある
function isPotentiallyStable(boardData, r, c, player, stableFlags) {
    // 角は確定石
    if ((r === 0 || r === 7) && (c === 0 || c === 7)) return true;
    // 隣接する確定石があるか (簡易判定)
    const checkDirs = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]];
    let stableNeighborCount = 0;
     for(const [dr, dc] of checkDirs) {
         const nr = r + dr;
         const nc = c + dc;
         if (nr >= 0 && nr < boardSize && nc >= 0 && nc < boardSize && stableFlags[nr][nc]) {
            // 簡易的に、隣に確定フラグがあればOKとする
            // 本来はラインが埋まっているかなどのチェックが必要
            return true; 
         }
     }
    return false; // 厳密な判定ではない
}

// アルファベータ探索 (getValidMoves, getFlipsFromBoard を使うように変更)
function alphaBeta(currentBoard, depth, alpha, beta, maximizingPlayer, player) {
    const opponent = player === 'black' ? 'white' : 'black';
    const currentPlayerForTurn = maximizingPlayer ? player : opponent;
    const validMoves = getValidMoves(currentPlayerForTurn, currentBoard);

    // 深さ限界またはゲーム終了状態
    if (depth === 0 || (validMoves.length === 0 && getValidMoves(maximizingPlayer ? opponent : player, currentBoard).length === 0)) {
        return evaluateBoard(currentBoard, player); // 静的評価値を返す
    }

    // パスの処理
    if (validMoves.length === 0) {
        return alphaBeta(currentBoard, depth -1, alpha, beta, !maximizingPlayer, player);
    }

    if (maximizingPlayer) { // 最大化ノード (CPUの番)
        let maxEval = -Infinity;
        for (const move of validMoves) {
            const nextBoard = simulateMove(currentBoard, move.row, move.col, currentPlayerForTurn, move.flips);
            const evalScore = alphaBeta(nextBoard, depth - 1, alpha, beta, false, player);
            maxEval = Math.max(maxEval, evalScore);
            alpha = Math.max(alpha, evalScore);
            if (beta <= alpha) {
                break; // ベータカット
            }
        }
        return maxEval;
    } else { // 最小化ノード (相手の番)
        let minEval = Infinity;
        for (const move of validMoves) {
            const nextBoard = simulateMove(currentBoard, move.row, move.col, currentPlayerForTurn, move.flips);
            const evalScore = alphaBeta(nextBoard, depth - 1, alpha, beta, true, player);
            minEval = Math.min(minEval, evalScore);
            beta = Math.min(beta, evalScore);
            if (beta <= alpha) {
                break; // アルファカット
            }
        }
        return minEval;
    }
}

// 手をシミュレートした後の盤面を返す（元の盤面は変更しない）
function simulateMove(currentBoard, row, col, player, flips) {
    const newBoard = currentBoard.map(arr => arr.slice()); // ディープコピー
    newBoard[row][col] = player;
    flips.forEach(([r, c]) => {
        newBoard[r][c] = player;
    });
    return newBoard;
}

// CPUの手を実行 (モードに応じて動作変更)
function makeComputerMove() {
    const validMoves = getValidMoves(CPU_PLAYER, board);

    if (validMoves.length === 0) {
        console.log("CPUはパスしました。");
        isThinking = false;
        switchPlayer();
        return;
    }

    let bestScore;
    let bestMove = validMoves[0]; // 初期値
    let alpha = -Infinity;
    let beta = Infinity;

    if (gameMode === 'lose') {
        // --- 全力で負けようとするモード ---
        bestScore = Infinity; // 最小スコアを探すので初期値は無限大
        for (const move of validMoves) {
            const nextBoard = simulateMove(board, move.row, move.col, CPU_PLAYER, move.flips);
            // 評価値を計算 (探索深度は通常通りでOK、評価結果の解釈を変える)
            const score = alphaBeta(nextBoard, currentSearchDepth - 1, alpha, beta, false, CPU_PLAYER);

            if (score < bestScore) { // 評価値が最も低い手を選ぶ
                bestScore = score;
                bestMove = move;
                // αβカットは通常通りで良い（探索効率のため）
                // beta = Math.min(beta, score); // 最小化ノードのカット条件は変わらない
            }
             // 評価値が同じ場合、たまに違う手を選ぶ
            else if (score === bestScore && Math.random() < 0.1) {
                 bestMove = move;
            }
        }
        console.log(`CPU (Lose Mode) chooses: (${bestMove.row}, ${bestMove.col}) with score: ${bestScore}`);

    } else {
        // --- 全力モード または 忖度モード ---
        // (忖度モードは initializeBoard で currentSearchDepth が変更されている)
        bestScore = -Infinity; // 最大スコアを探す
         bestMove = validMoves[Math.floor(Math.random() * validMoves.length)]; // ランダム初期化

        for (const move of validMoves) {
            const nextBoard = simulateMove(board, move.row, move.col, CPU_PLAYER, move.flips);
            // 評価値を計算 (currentSearchDepth を使用)
            const score = alphaBeta(nextBoard, currentSearchDepth - 1, alpha, beta, false, CPU_PLAYER);

            if (score > bestScore) { // 評価値が最も高い手を選ぶ
                bestScore = score;
                bestMove = move;
                alpha = Math.max(alpha, score);
            }
             else if (score === bestScore && Math.random() < 0.1) {
                 bestMove = move;
            }
        }
         console.log(`CPU (${gameMode === 'sontaku' ? 'Sontaku Mode' : 'Normal Mode'}) chooses: (${bestMove.row}, ${bestMove.col}) with score: ${bestScore}`);
    }


    // 最善手 (または最悪手) に石を置く
    placeDisc(bestMove.row, bestMove.col, CPU_PLAYER, bestMove.flips);
    renderBoard();
    updateScore();

    // 連続手番チェック
    if (isSpecialSquare(bestMove.row, bestMove.col)) {
        updateMessage(`CPUが連続手番！(${gameMode}) 続けて思考します...`);
        if (!hasValidMoves(CPU_PLAYER)) {
            console.log("CPU連続手番ですが、置ける場所がありません。");
            isThinking = false;
            switchPlayer();
        } else {
            setTimeout(makeComputerMove, 500);
        }
    } else {
        isThinking = false;
        switchPlayer();
    }
}
