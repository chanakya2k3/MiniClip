// Simulates: two players mid-game, one "edits the UI" (page reload).
// Asserts the seat, symbol, board and turn all survive.
const { io } = require("socket.io-client");
const { randomUUID } = require("crypto");

const URL = "http://localhost:3001";
const results = [];
function check(name, cond, extra = "") {
  results.push({ name, ok: Boolean(cond), extra });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
}

const next = (sock, ev) =>
  new Promise((res) => sock.once(ev, res));

// State broadcasts can be in flight when we start listening, so wait for
// one that actually matches the condition under test instead of "the next".
function stateWhere(sock, pred, label) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      sock.off("room:state", h);
      rej(new Error(`timed out waiting for state: ${label}`));
    }, 3000);
    const h = (s) => {
      if (!pred(s)) return;
      clearTimeout(t);
      sock.off("room:state", h);
      res(s);
    };
    sock.on("room:state", h);
  });
}

function connect() {
  const s = io(URL, { forceNew: true, transports: ["websocket"] });
  return new Promise((res) => s.on("connect", () => res(s)));
}

(async () => {
  const roomId = "test-" + randomUUID().slice(0, 8);
  const idA = randomUUID();
  const idB = randomUUID();

  const a = await connect();
  const b = await connect();

  const joinedA = next(a, "room:joined");
  a.emit("room:join", { roomId, name: "A", playerId: idA });
  const { symbol: symA } = await joinedA;

  const joinedB = next(b, "room:joined");
  const stateAfterB = stateWhere(a, (s) => s.players.length === 2, "2 players");
  b.emit("room:join", { roomId, name: "B", playerId: idB });
  const { symbol: symB } = await joinedB;
  let state = await stateAfterB;

  check("A is X, B is O", symA === "X" && symB === "O", `${symA}/${symB}`);
  check("game starts when 2 players present", state.status === "IN_PROGRESS", state.status);

  // X plays 0, O plays 4, X plays 1 -> board has 3 marks, turn is O.
  let moves = 0;
  for (const [sock, cell] of [[a, 0], [b, 4], [a, 1]]) {
    moves++;
    const want = moves;
    const st = stateWhere(a, (s) => s.board.filter(Boolean).length === want, `${want} marks`);
    sock.emit("game:action", { cellIndex: cell });
    state = await st;
  }
  check("3 moves applied", state.board.filter(Boolean).length === 3, JSON.stringify(state.board));
  check("turn is O after 3 moves", state.turn === "O", state.turn);
  const snapshot = JSON.stringify(state.board);

  // --- The refresh: A's page reloads after a UI edit ------------------
  const stateOnB = stateWhere(
    b,
    (s) => s.players.some((p) => p.symbol === "X" && !p.connected),
    "X disconnected"
  );
  a.disconnect();
  const duringOutage = await stateOnB;

  check("game stays IN_PROGRESS while A is away", duringOutage.status === "IN_PROGRESS", duringOutage.status);
  check("board untouched by disconnect", JSON.stringify(duringOutage.board) === snapshot);
  check("turn untouched by disconnect", duringOutage.turn === "O", duringOutage.turn);
  check(
    "A shown as disconnected, seat held",
    duringOutage.players.length === 2 && duringOutage.players.some((p) => p.symbol === "X" && !p.connected)
  );

  // A comes back with the SAME playerId (what sessionStorage gives us).
  const a2 = await connect();
  const rejoined = next(a2, "room:joined");
  const stateA2 = stateWhere(a2, (s) => s.players.every((p) => p.connected), "both back");
  a2.emit("room:join", { roomId, name: "A", playerId: idA });
  const j = await rejoined;
  const resumedState = await stateA2;

  check("rejoin recognised as resume", j.resumed === true);
  check("same symbol after reload", j.symbol === symA, j.symbol);
  check("board identical after reload", JSON.stringify(resumedState.board) === snapshot, JSON.stringify(resumedState.board));
  check("turn preserved after reload", resumedState.turn === "O", resumedState.turn);
  check("status still IN_PROGRESS", resumedState.status === "IN_PROGRESS", resumedState.status);
  check("both players connected again", resumedState.players.every((p) => p.connected));

  // And the resumed socket can still play: O moves, then X (us) moves.
  let st = stateWhere(a2, (s) => s.board[5] === "O", "O played 5");
  b.emit("game:action", { cellIndex: 5 });
  await st;
  st = stateWhere(a2, (s) => s.board[2] === "X", "X played 2");
  a2.emit("game:action", { cellIndex: 2 });
  const finalState = await st;
  check("resumed player can still move", finalState.board[2] === "X", JSON.stringify(finalState.board));
  check("X wins on 0,1,2", finalState.status === "FINISHED" && finalState.winner === "X", finalState.winner);

  // A stranger must not be able to steal a held seat.
  const c = await connect();
  const err = next(c, "error");
  c.emit("room:join", { roomId, name: "C", playerId: randomUUID() });
  const e = await Promise.race([err, new Promise((r) => setTimeout(() => r(null), 500))]);
  check("third player rejected", e && e.message === "Room is full", e ? e.message : "no error");

  a2.disconnect(); b.disconnect(); c.disconnect();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
