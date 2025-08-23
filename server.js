// server.js (ESM)
// Deps: npm i express socket.io cors compression nanoid

import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'
import compression from 'compression'
import { customAlphabet } from 'nanoid'

/* -------------------------
   Config / Env
-------------------------- */
const PORT = process.env.PORT || 3000
const NODE_ENV = process.env.NODE_ENV || 'production'

/**
 * FRONTEND_ORIGINS: comma-separated list of allowed origins for CORS/WebSockets
 * e.g. "https://yourapp.vercel.app, http://localhost:5173"
 */
const ORIGINS = (process.env.FRONTEND_ORIGINS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

// Fallback: during local dev, allow localhost if no env set
if (ORIGINS.length === 0) {
  if (NODE_ENV === 'production') {
    // Add your Render app URL here
    ORIGINS.push('https://ric-pac-soe.onrender.com')
  } else {
    ORIGINS.push(
      'http://localhost:3000',
      'http://localhost:5173',
      'http://127.0.0.1:5173'
    )
  }
}

/* -------------------------
   Server & Middleware
-------------------------- */
const app = express()
const server = http.createServer(app)

const io = new Server(server, {
  transports: ['websocket'],
  upgrade: false,
  cors: {
    origin: '*', // Or restrict to your Netlify frontend URL
    methods: ['GET', 'POST'],
  },
})

app.set('trust proxy', true)
app.use(compression())
app.use(express.json({ limit: '256kb' }))
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true)
      const ok = ORIGINS.some((o) => origin === o)
      return ok ? cb(null, true) : cb(new Error('Not allowed by CORS'))
    },
    credentials: true,
  })
)

/* -------------------------
   Health / Diagnostics
-------------------------- */
app.get('/', (_req, res) =>
  res.type('text').send('Ric Pac Soe server is running.')
)
app.get('/healthz', (_req, res) => res.json({ ok: true }))
app.get('/readyz', (_req, res) => res.json({ ready: true, rooms: rooms.size }))

/* -------------------------
   Game Constants & Helpers
-------------------------- */
const BOARD_SIZE = 8
const COLORS = ['#4f46e5', '#ef4444', '#10b981', '#f59e0b']
const SYMBOLS = { R: '◯', P: '■', S: '✕' }
const WEAK_TO = { S: 'R', P: 'S', R: 'P' } // defender.sym => attacker.sym beating it
const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const nanoid = customAlphabet(ROOM_ID_ALPHABET, 6)

function createEmptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => null)
  )
}
function inBounds(r, c) {
  return r >= 0 && r < BOARD_SIZE && c >= 0 && c < BOARD_SIZE
}
function sameOwnerSym(board, r, c, ref) {
  const v = board[r][c]
  return v && !v.type && v.player === ref.player && v.sym === ref.sym
}
function randomEmptyCell(board) {
  const empties = []
  for (let r = 0; r < BOARD_SIZE; r++)
    for (let c = 0; c < BOARD_SIZE; c++)
      if (board[r][c] === null) empties.push({ r, c })
  if (empties.length === 0) return null
  return empties[Math.floor(Math.random() * empties.length)]
}
function placeRandomBlockers(board, count) {
  let placed = 0
  while (placed < count) {
    const pos = randomEmptyCell(board)
    if (!pos) break
    board[pos.r][pos.c] = { type: 'BLOCKER' }
    placed++
  }
}
function boardFull(board) {
  for (let r = 0; r < BOARD_SIZE; r++)
    for (let c = 0; c < BOARD_SIZE; c++) if (board[r][c] === null) return false
  return true
}
function evaluateWinners(scores) {
  const max = Math.max(...scores)
  const winners = []
  for (let i = 0; i < scores.length; i++)
    if (scores[i] === max)
      winners.push({ index: i, label: `P${i + 1}`, score: scores[i] })
  return winners
}

/* -------------------------
   Scoring & Elimination
-------------------------- */

// Remove adjacent enemy pieces that are beaten by the placed symbol.
// Returns {removed, highlights[]} where highlights are arrays of {r,c}.
function resolveEliminationsFrom(board, r, c) {
  const placed = board[r][c]
  if (!placed || placed.type === 'BLOCKER') return { removed: 0, highlights: [] }

  let removed = 0
  const highlights = []

  const deltas = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ]

  // For elimination we look only immediately adjacent at the ends of the same-owner line
  for (const [dr, dc] of deltas) {
    const line = [{ r, c }]

    // backward
    let br = r - dr,
      bc = c - dc
    while (inBounds(br, bc) && sameOwnerSym(board, br, bc, placed)) {
      line.unshift({ r: br, c: bc })
      br -= dr
      bc -= dc
    }
    // forward
    let fr = r + dr,
      fc = c + dc
    while (inBounds(fr, fc) && sameOwnerSym(board, fr, fc, placed)) {
      line.push({ r: fr, c: fc })
      fr += dr
      fc += dc
    }

    // try to eliminate just outside the contiguous segment that includes (r,c)
    const tryEliminate = (rr, cc) => {
      if (!inBounds(rr, cc)) return 0
      const v = board[rr][cc]
      if (!v || v.type === 'BLOCKER') return 0
      if (v.player === placed.player) return 0
      if (WEAK_TO[v.sym] === placed.sym) {
        board[rr][cc] = null
        highlights.push([{ r: rr, c: cc }]) // single-cell elimination flash
        return 1
      }
      return 0
    }

    // find the pair that includes the placed tile
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i],
        b = line[i + 1]
      const includesNew = (a.r === r && a.c === c) || (b.r === r && b.c === c)
      if (!includesNew) continue
      removed += tryEliminate(a.r - dr, a.c - dc)
      removed += tryEliminate(b.r + dr, b.c + dc)
      break
    }
  }
  return { removed, highlights }
}

// +1 to current player for any 3+ contiguous of same symbol/same owner formed.
// Returns {points, highlights[]} with one highlight triple per direction (max 4).
function scoreThreeInRow(board, r, c) {
  const v = board[r][c]
  if (!v || v.type === 'BLOCKER') return { points: 0, highlights: [] }
  const { player, sym } = v

  const deltas = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ]

  let points = 0
  const highlights = []

  for (const [dr, dc] of deltas) {
    // collect contiguous segment including (r,c)
    const seg = [{ r, c }]
    let br = r - dr,
      bc = c - dc
    while (inBounds(br, bc) && board[br][bc] && !board[br][bc].type) {
      const t = board[br][bc]
      if (t.player === player && t.sym === sym) {
        seg.unshift({ r: br, c: bc })
        br -= dr
        bc -= dc
      } else break
    }
    let fr = r + dr,
      fc = c + dc
    while (inBounds(fr, fc) && board[fr][fc] && !board[fr][fc].type) {
      const t = board[fr][fc]
      if (t.player === player && t.sym === sym) {
        seg.push({ r: fr, c: fc })
        fr += dr
        fc += dc
      } else break
    }

    if (seg.length >= 3) {
      // award 1 point for this direction, highlight a centered triple (or first triple if long)
      points += 1
      // choose a triple window that includes the placed cell
      // find index of placed cell in seg
      const idx = seg.findIndex((p) => p.r === r && p.c === c)
      let start = Math.max(0, Math.min(idx - 1, seg.length - 3))
      const triple = [seg[start], seg[start + 1], seg[start + 2]]
      highlights.push(triple)
    }
  }

  return { points, highlights }
}

// Misplacement: if placement creates a contiguous length-3 window that includes (r,c)
// with exactly two tiles owned by the SAME opponent, both being the stronger symbol
// against the placed symbol, then that opponent gains +1 (max 1 per direction).
// Mixed ownership of those two tiles => no score.
function scoreMisplacement(board, r, c) {
  const placed = board[r][c]
  if (!placed || placed.type === 'BLOCKER') return { awarded: [], highlights: [] }
  const { player: pPlayer, sym: pSym } = placed
  const opponentStrongSym = WEAK_TO[pSym] // symbol that beats placed

  const deltas = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ]

  const awarded = [] // {player, points}
  const highlights = []

  for (const [dr, dc] of deltas) {
    // Build a line of exactly 3 contiguous cells centered on placed OR with placed at an end
    // We’ll examine three windows along the axis that include (r,c):
    // window A: (r-2*dr,c-2*dc) .. (r-dr,c-dc) .. (r,c)
    // window B: (r-dr,c-dc) .. (r,c) .. (r+dr,c+dc)
    // window C: (r,c) .. (r+dr,c+dc) .. (r+2*dr,c+2*dc)
    const windows = [
      [
        { r: r - 2 * dr, c: c - 2 * dc },
        { r: r - 1 * dr, c: c - 1 * dc },
        { r: r, c: c },
      ],
      [
        { r: r - 1 * dr, c: c - 1 * dc },
        { r: r, c: c },
        { r: r + 1 * dr, c: c + 1 * dc },
      ],
      [
        { r: r, c: c },
        { r: r + 1 * dr, c: c + 1 * dc },
        { r: r + 2 * dr, c: c + 2 * dc },
      ],
    ]

    let directionAwarded = false

    for (const win of windows) {
      if (directionAwarded) break
      // all in bounds and occupied by pieces (no blockers/empty)
      const tiles = []
      let ok = true
      for (const pos of win) {
        if (!inBounds(pos.r, pos.c)) {
          ok = false
          break
        }
        const t = board[pos.r][pos.c]
        if (!t || t.type === 'BLOCKER') {
          ok = false
          break
        }
        tiles.push({ ...pos, ...t })
      }
      if (!ok) continue

      // must include the placed position
      if (!tiles.some((t) => t.r === r && t.c === c)) continue

      // placed tile must be the weaker one in this triple
      // the other two must be the stronger symbol, owned by the SAME opponent
      const others = tiles.filter((t) => !(t.r === r && t.c === c))
      if (others.length !== 2) continue

      const bothStronger =
        others.every((t) => t.sym === opponentStrongSym) &&
        others.every((t) => t.player !== pPlayer)

      const sameOpponentOwner =
        bothStronger && others[0].player === others[1].player

      if (bothStronger && sameOpponentOwner) {
        // Mixed ownership is excluded by sameOpponentOwner check.
        const opp = others[0].player
        awarded.push({ player: opp, points: 1 })
        highlights.push(win.map((w) => ({ r: w.r, c: w.c })))
        directionAwarded = true // only 1 per direction
      }
    }
  }

  return { awarded, highlights }
}

/* -------------------------
   Rooms & State
-------------------------- */
const rooms = new Map() // roomId -> GameRoom

function ensureRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      settings: { tilesPerSymbol: 10, blockers: 8, pointsToWin: 7 },
      players: [], // { socketId, name }
      spectators: [], // { socketId, name }
      turn: 0,
      lastPlayed: {},
      scores: [],
      stock: [],
      board: createEmptyBoard(),
      gameOver: false,
      message: '',
      started: false,
      updatedAt: Date.now(),
      chat: [], // { name, text, time }
      highlights: [], // array of [{r,c}] groups to flash
    })
  }
  return rooms.get(roomId)
}

function publicState(room) {
  return {
    id: room.id,
    settings: room.settings,
    players: room.players.map((p, i) => ({
      name: p.name || `P${i + 1}`,
      color: COLORS[i % COLORS.length],
    })),
    spectators: room.spectators.map((s) => ({ name: s.name || 'Spectator' })),
    turn: room.turn,
    lastPlayed: room.lastPlayed,
    scores: room.scores,
    stock: room.stock,
    board: room.board,
    gameOver: room.gameOver,
    message: room.message,
    started: room.started,
    chat: room.chat.slice(-200),
    highlights: room.highlights || [],
  }
}

function lobbySummary() {
  const list = []
  for (const [id, r] of rooms.entries()) {
    list.push({
      id,
      players: r.players.length,
      spectators: r.spectators.length,
      started: r.started,
      updatedAt: r.updatedAt,
    })
  }
  list.sort((a, b) => b.updatedAt - a.updatedAt)
  return list
}

/* -------------------------
   Socket.IO
-------------------------- */
io.on('connection', (socket) => {
  let joinedRoomId = null

  // Lobby
  socket.emit('lobby', lobbySummary())
  socket.on('requestLobby', () => socket.emit('lobby', lobbySummary()))

  socket.on('createRoom', () => {
    const id = nanoid()
    ensureRoom(id)
    io.emit('lobby', lobbySummary())
    socket.emit('roomCreated', { id })
  })

  socket.on('joinRoom', ({ roomId, name, asSpectator }) => {
    const room = ensureRoom(roomId)
    socket.join(roomId)
    joinedRoomId = roomId

    if (!asSpectator && room.players.length < 4) {
      const myIndex = room.players.length
      room.players.push({
        socketId: socket.id,
        name: (name || `P${myIndex + 1}`).slice(0, 24),
      })
      if (!room.started) {
        room.scores = Array.from({ length: room.players.length }, () => 0)
        room.stock = Array.from({ length: room.players.length }, () => ({
          R: room.settings.tilesPerSymbol,
          P: room.settings.tilesPerSymbol,
          S: room.settings.tilesPerSymbol,
        }))
      }
      socket.emit('you', { role: 'player', index: myIndex, roomId })
    } else {
      room.spectators.push({
        socketId: socket.id,
        name: (name || 'Spectator').slice(0, 24),
      })
      socket.emit('you', { role: 'spectator', index: null, roomId })
    }

    room.updatedAt = Date.now()
    io.to(roomId).emit('state', publicState(room))
    io.emit('lobby', lobbySummary())
  })

  // Leave room explicitly
  socket.on('leaveRoom', ({ roomId }) => {
    const room = rooms.get(roomId)
    if (!room) return
    socket.leave(roomId)

    // remove spectator
    const sIdx = room.spectators.findIndex((s) => s.socketId === socket.id)
    if (sIdx >= 0) {
      room.spectators.splice(sIdx, 1)
    }

    // remove player (free seat)
    const pIdx = room.players.findIndex((p) => p.socketId === socket.id)
    if (pIdx >= 0) {
      room.players.splice(pIdx, 1)
      // Adjust turn if needed
      if (room.turn >= room.players.length) room.turn = 0
      // shrink scores/stock
      room.scores.splice(pIdx, 1)
      room.stock.splice(pIdx, 1)
      // reassign player indices implicitly by order
      // (existing placed pieces keep their numeric player index; optional: remap board - skipping to keep it simple)
    }

    room.started = false
    room.gameOver = false
    room.message = 'You left the room.'
    room.updatedAt = Date.now()
    io.to(roomId).emit('state', publicState(room))
    io.emit('lobby', lobbySummary())
    if (joinedRoomId === roomId) joinedRoomId = null
  })

  socket.on('newGame', ({ roomId, tilesPerSymbol, blockers, pointsToWin }) => {
    const room = rooms.get(roomId)
    if (!room) return

    const member =
      room.players.some((p) => p.socketId === socket.id) ||
      room.spectators.some((s) => s.socketId === socket.id)
    if (!member) return

    room.settings.tilesPerSymbol = Math.max(
      1,
      Math.min(99, parseInt(tilesPerSymbol ?? 10, 10))
    )
    room.settings.blockers = Math.max(
      0,
      Math.min(BOARD_SIZE * BOARD_SIZE, parseInt(blockers ?? 8, 10))
    )
    room.settings.pointsToWin = Math.max(
      1,
      Math.min(999, parseInt(pointsToWin ?? 7, 10))
    )

    room.turn = 0
    room.lastPlayed = {}
    room.scores = Array.from({ length: room.players.length }, () => 0)
    room.stock = Array.from({ length: room.players.length }, () => ({
      R: room.settings.tilesPerSymbol,
      P: room.settings.tilesPerSymbol,
      S: room.settings.tilesPerSymbol,
    }))
    room.board = createEmptyBoard()
    room.gameOver = false
    room.message = 'New game started.'
    room.started = true
    room.highlights = []

    if (room.settings.blockers > 0)
      placeRandomBlockers(room.board, room.settings.blockers)

    room.updatedAt = Date.now()
    io.to(roomId).emit('state', publicState(room))
    io.emit('lobby', lobbySummary())
  })

  socket.on('placePiece', ({ roomId, r, c, sym }) => {
    const room = rooms.get(roomId)
    if (!room || room.gameOver) return
    const playerIdx = room.players.findIndex((p) => p.socketId === socket.id)
    if (playerIdx === -1) return // spectators can't act
    if (playerIdx !== room.turn) return
    if (!['R', 'P', 'S'].includes(sym)) return
    if (!inBounds(r, c)) return
    if (room.board[r][c] !== null) return
    if ((room.stock[playerIdx]?.[sym] ?? 0) <= 0) return

    // place
    room.board[r][c] = { player: playerIdx, sym }
    room.stock[playerIdx][sym]--
    room.lastPlayed[playerIdx] = sym

    // reset highlights for this move
    room.highlights = []

    // Misplacement score first (opponent gains if applicable)
    const mis = scoreMisplacement(room.board, r, c)
    for (const a of mis.awarded) {
      room.scores[a.player] = (room.scores[a.player] ?? 0) + a.points
    }
    room.highlights.push(...mis.highlights)

    // eliminations -> current player score
    const elim = resolveEliminationsFrom(room.board, r, c)
    if (elim.removed > 0) {
      room.scores[playerIdx] += elim.removed
      room.highlights.push(...elim.highlights)
    }

    // 3-in-a-row bonus for current player
    const tri = scoreThreeInRow(room.board, r, c)
    if (tri.points > 0) {
      room.scores[playerIdx] += tri.points
      room.highlights.push(...tri.highlights)
    }

    // win by points
    if ((room.scores[playerIdx] ?? 0) >= room.settings.pointsToWin) {
      room.gameOver = true
      const name = room.players[playerIdx].name || `P${playerIdx + 1}`
      room.message = `${name} wins by reaching ${room.settings.pointsToWin} points!`
      room.updatedAt = Date.now()
      io.to(roomId).emit('state', publicState(room))
      io.emit('lobby', lobbySummary())
      return
    }

    // end conditions
    for (let i = 0; i < room.players.length; i++) {
      const st = room.stock[i] || { R: 0, P: 0, S: 0 }
      if (st.R + st.P + st.S === 0) {
        room.gameOver = true
        const winners = evaluateWinners(room.scores)
        if (winners.length === 1) {
          room.message = `Game over — ${
            room.players[i].name || `P${i + 1}`
          } used all tiles. ${winners[0].label} wins with ${
            winners[0].score
          } points!`
        } else {
          room.message = `Game over — ${
            room.players[i].name || `P${i + 1}`
          } used all tiles. Tie between ${winners
            .map((w) => w.label)
            .join(', ')} (score ${winners[0].score}).`
        }
        room.updatedAt = Date.now()
        io.to(roomId).emit('state', publicState(room))
        io.emit('lobby', lobbySummary())
        return
      }
    }
    if (boardFull(room.board)) {
      room.gameOver = true
      const winners = evaluateWinners(room.scores)
      room.message =
        winners.length === 1
          ? `${winners[0].label} wins with ${winners[0].score} points (board full).`
          : `Board full. Tie between ${winners.map((w) => w.label).join(', ')} (score ${
              winners[0].score
            }).`
      room.updatedAt = Date.now()
      io.to(roomId).emit('state', publicState(room))
      io.emit('lobby', lobbySummary())
      return
    }

    // next turn
    room.turn = (room.turn + 1) % room.players.length
    room.updatedAt = Date.now()
    io.to(roomId).emit('state', publicState(room))
  })

  socket.on('moveBlocker', ({ roomId, from, to }) => {
    const room = rooms.get(roomId)
    if (!room || room.gameOver) return
    const playerIdx = room.players.findIndex((p) => p.socketId === socket.id)
    if (playerIdx === -1) return // spectators
    if (playerIdx !== room.turn) return

    if (!inBounds(from?.r, from?.c) || !inBounds(to?.r, to?.c)) return
    const v = room.board[from.r][from.c]
    if (!v || v.type !== 'BLOCKER') return
    if (room.board[to.r][to.c] !== null) return

    const dr = Math.abs(from.r - to.r),
      dc = Math.abs(from.c - to.c)
    if ((dr === 0 && dc === 0) || dr > 1 || dc > 1) return // exactly one step

    room.board[to.r][to.c] = { type: 'BLOCKER' }
    room.board[from.r][from.c] = null
    room.highlights = [] // no highlight for blocker move

    room.turn = (room.turn + 1) % room.players.length
    room.updatedAt = Date.now()
    io.to(roomId).emit('state', publicState(room))
  })

  // Chat (basic sanitization on client)
  socket.on('chat', ({ roomId, name, text }) => {
    const room = rooms.get(roomId)
    if (!room) return
    const msg = {
      name: (name || 'Anon').slice(0, 24),
      text: (text || '').slice(0, 300),
      time: Date.now(),
    }
    room.chat.push(msg)
    room.updatedAt = Date.now()
    io.to(roomId).emit('chat', msg)
  })

  socket.on('requestState', ({ roomId }) => {
    const room = rooms.get(roomId)
    if (room) socket.emit('state', publicState(room))
  })

  socket.on('disconnect', () => {
    if (!joinedRoomId) return
    const room = rooms.get(joinedRoomId)
    if (!room) return

    // players: keep seat & name (so reconnect can “reclaim”) — but mark socketId null
    const pIdx = room.players.findIndex((p) => p.socketId === socket.id)
    if (pIdx >= 0) {
      const name = room.players[pIdx].name
      room.players[pIdx] = { socketId: null, name }
    }
    // spectators: remove
    const sIdx = room.spectators.findIndex((s) => s.socketId === socket.id)
    if (sIdx >= 0) room.spectators.splice(sIdx, 1)

    room.updatedAt = Date.now()
    io.to(joinedRoomId).emit('state', publicState(room))
    io.emit('lobby', lobbySummary())
  })
})

/* -------------------------
   Start / Shutdown
-------------------------- */
server.listen(PORT, () => {
  console.log(`[ric-pac-soe] Server listening on :${PORT}`)
  console.log(
    `[ric-pac-soe] Allowed origins:`,
    ORIGINS.length ? ORIGINS : '(all during dev)'
  )
})

// Graceful shutdown (Render/Heroku send SIGTERM)
function shutdown(sig) {
  console.log(`[ric-pac-soe] ${sig} received, shutting down...`)
  io.close(() => {
    server.close(() => {
      console.log('[ric-pac-soe] HTTP closed.')
      process.exit(0)
    })
  })
  // Fallback timeout
  setTimeout(() => process.exit(0), 5000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
