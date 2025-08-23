// server.js (simplified version)

import express from "express";
import http from "http";
import { Server } from "socket.io";
import cors from "cors";
import compression from "compression";
import { customAlphabet } from "nanoid";

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "production";

const ORIGINS = (process.env.FRONTEND_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (ORIGINS.length === 0) {
  if (NODE_ENV === "production") {
    ORIGINS.push("https://ric-pac-soe.onrender.com");
  } else {
    ORIGINS.push("http://localhost:3000", "http://localhost:5173");
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["websocket"],
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(compression());
app.use(express.json({ limit: "256kb" }));
app.use(cors());

app.get("/", (_req, res) => res.type("text").send("Ric Pac Soe server is running."));

/* -------------------------
   Game Constants
-------------------------- */
const BOARD_SIZE = 8;
const COLORS = ["#4f46e5", "#ef4444", "#10b981", "#f59e0b"];
const SYMBOLS = { R: "◯", P: "■", S: "✕" };
const WEAK_TO = { S: "R", P: "S", R: "P" };

const ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const nanoid = customAlphabet(ROOM_ID_ALPHABET, 6);

function createEmptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => null)
  );
}

function inBounds(r, c) {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE;
}
function sameOwnerSym(board, r, c, ref) {
  const v = board[r][c];
  return v && !v.type && v.player === ref.player && v.sym === ref.sym;
}
function randomEmptyCell(board) {
  const empties = [];
  for (let r = 0; r < BOARD_SIZE; r++)
    for (let c = 0; c < BOARD_SIZE; c++)
      if (board[r][c] === null) empties.push({ r, c });
  if (empties.length === 0) return null;
  return empties[Math.floor(Math.random() * empties.length)];
}
function placeRandomBlockers(board, count) {
  let placed = 0;
  while (placed < count) {
    const pos = randomEmptyCell(board);
    if (!pos) break;
    board[pos.r][pos.c] = { type: "BLOCKER" };
    placed++;
  }
}
function boardFull(board) {
  for (let r = 0; r < BOARD_SIZE; r++)
    for (let c = 0; c < BOARD_SIZE; c++) if (board[r][c] === null) return false;
  return true;
}
function evaluateWinners(scores) {
  const max = Math.max(...scores);
  const winners = [];
  for (let i = 0; i < scores.length; i++)
    if (scores[i] === max) winners.push({ index: i, score: scores[i] });
  return winners;
}

/* -------------------------
   Elimination Logic
-------------------------- */
function tryEliminate(board, r, c, attSym, attPlayer) {
  if (!inBounds(r, c)) return 0;
  const v = board[r][c];
  if (!v || v.type === "BLOCKER") return 0;
  if (v.player === attPlayer) return 0;
  if (WEAK_TO[v.sym] === attSym) {
    board[r][c] = null;
    return 1;
  }
  return 0;
}

function resolveEliminationsFrom(board, r, c) {
  const placed = board[r][c];
  if (!placed || placed.type === "BLOCKER") return 0;
  const deltas = [[0, 1],[1, 0],[1, 1],[1, -1]];
  let removed = 0;
  for (const [dr, dc] of deltas) {
    const line = [{ r, c }];
    let br = r - dr, bc = c - dc;
    while (inBounds(br, bc) && sameOwnerSym(board, br, bc, placed)) {
      line.unshift({ r: br, c: bc });
      br -= dr; bc -= dc;
    }
    let fr = r + dr, fc = c + dc;
    while (inBounds(fr, fc) && sameOwnerSym(board, fr, fc, placed)) {
      line.push({ r: fr, c: fc });
      fr += dr; fc += dc;
    }
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      const includesNew = (a.r === r && a.c === c) || (b.r === r && b.c === c);
      if (!includesNew) continue;
      const before = { r: a.r - dr, c: a.c - dc };
      const after = { r: b.r + dr, c: b.c + dc };
      removed += tryEliminate(board, before.r, before.c, placed.sym, placed.player);
      removed += tryEliminate(board, after.r, after.c, placed.sym, placed.player);
    }
  }
  return removed;
}

/* -------------------------
   Rooms & State
-------------------------- */
const rooms = new Map();

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      settings: { tilesPerSymbol: 10, blockers: 8, pointsToWin: 7 },
      players: [],
      turn: 0,
      scores: [],
      stock: [],
      board: createEmptyBoard(),
      gameOver: false,
      message: "",
      started: false,
      updatedAt: Date.now(),
    });
  }
  return rooms.get(roomId);
}

function publicState(room) {
  return {
    id: room.id,
    players: room.players.map((p, i) => ({
      name: p.name || `P${i + 1}`,
      color: COLORS[i % COLORS.length],
    })),
    turn: room.turn,
    scores: room.scores,
    stock: room.stock,
    board: room.board,
    gameOver: room.gameOver,
    message: room.message,
    started: room.started,
  };
}

/* -------------------------
   Socket.IO
-------------------------- */
io.on("connection", (socket) => {
  let joinedRoomId = null;

  socket.on("createRoom", () => {
    const id = nanoid();
    ensureRoom(id);
    socket.emit("roomCreated", { id });
  });

  socket.on("joinRoom", ({ roomId, name }) => {
    const room = ensureRoom(roomId);
    socket.join(roomId);
    joinedRoomId = roomId;

    if (room.players.length < 4) {
      const myIndex = room.players.length;
      room.players.push({ socketId: socket.id, name: (name || `P${myIndex+1}`).slice(0,24) });
      if (!room.started) {
        room.scores = Array.from({ length: room.players.length }, () => 0);
        room.stock = Array.from({ length: room.players.length }, () => ({
          R: room.settings.tilesPerSymbol,
          P: room.settings.tilesPerSymbol,
          S: room.settings.tilesPerSymbol,
        }));
      }
      socket.emit("you", { role: "player", index: myIndex, roomId });
    }

    io.to(roomId).emit("state", publicState(room));
  });

  socket.on("newGame", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.turn = 0;
    room.scores = Array.from({ length: room.players.length }, () => 0);
    room.stock = Array.from({ length: room.players.length }, () => ({
      R: room.settings.tilesPerSymbol,
      P: room.settings.tilesPerSymbol,
      S: room.settings.tilesPerSymbol,
    }));
    room.board = createEmptyBoard();
    room.gameOver = false;
    room.message = "Game started.";
    room.started = true;
    placeRandomBlockers(room.board, room.settings.blockers);
    io.to(roomId).emit("state", publicState(room));
  });

  socket.on("leaveGame", ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.players = room.players.filter((p) => p.socketId !== socket.id);
    io.to(roomId).emit("state", publicState(room));
  });

  socket.on("placePiece", ({ roomId, r, c, sym }) => {
    const room = rooms.get(roomId);
    if (!room || room.gameOver) return;
    const playerIdx = room.players.findIndex((p) => p.socketId === socket.id);
    if (playerIdx === -1) return;
    if (playerIdx !== room.turn) return;
    if (!["R", "P", "S"].includes(sym)) return;
    if (!inBounds(r, c)) return;
    if (room.board[r][c] !== null) return;
    if ((room.stock[playerIdx]?.[sym] ?? 0) <= 0) return;

    room.board[r][c] = { player: playerIdx, sym };
    room.stock[playerIdx][sym]--;

    const gained = resolveEliminationsFrom(room.board, r, c);
    if (gained > 0) room.scores[playerIdx] += gained;

    if ((room.scores[playerIdx] ?? 0) >= room.settings.pointsToWin) {
      room.gameOver = true;
      room.message = `${room.players[playerIdx].name} wins!`;
      io.to(roomId).emit("state", publicState(room));
      return;
    }

    if (boardFull(room.board)) {
      room.gameOver = true;
      const winners = evaluateWinners(room.scores);
      room.message =
        winners.length === 1
          ? `${room.players[winners[0].index].name} wins!`
          : `Tie game.`;
      io.to(roomId).emit("state", publicState(room));
      return;
    }

    room.turn = (room.turn + 1) % room.players.length;
    io.to(roomId).emit("state", publicState(room));
  });

  socket.on("disconnect", () => {
    if (!joinedRoomId) return;
    const room = rooms.get(joinedRoomId);
    if (!room) return;
    room.players = room.players.filter((p) => p.socketId !== socket.id);
    io.to(joinedRoomId).emit("state", publicState(room));
  });
});

server.listen(PORT, () => console.log(`[ric-pac-soe] Running on :${PORT}`));
