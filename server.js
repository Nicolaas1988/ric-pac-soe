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
  cors: {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true) // allow same-origin/non-browser
      const ok = ORIGINS.some((o) => origin === o)
      return ok ? cb(null, true) : cb(new Error('Not allowed by CORS'))
    },
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // Optional: tune for your host
  pingInterval: 25000,
  pingTimeout: 20000,
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
   Elimination Logic
-------------------------- */
function tryEliminate(board, r, c, attSym, attPlayer) {
  if (!inBounds(r, c)) return 0
  const v = board[r][c]
  if (!v || v.type === 'BLOCKER') return 0
  if (v.player === attPlayer) return 0
  if (WEAK_TO[v.sym] === attSym) {
    board[r][c] = null
    return 1
  }
  return 0
}
function resolveEliminationsFrom(board, r, c) {
  const placed = board[r][c]
  if (!placed || placed.type === 'BLOCKER') return 0
  const deltas = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ]
  let removed = 0
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
    // check consecutive pair including (r,c)
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i],
        b = line[i + 1]
      const includesNew = (a.r === r && a.c === c) || (b.r === r && b.c === c)
      if (!includesNew) continue
      const before = { r: a.r - dr, c: a.c - dc }
      const after = { r: b.r + dr, c: b.c + dc }
      removed += tryEliminate(
        board,
        before.r,
        before.c,
        placed.sym,
        placed.player
      )
      removed += tryEliminate(
        board,
        after.r,
        after.c,
        placed.sym,
        placed.player
      )
    }
  }
  return removed
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

  socket.on('newGame', ({ roomId, tilesPerSymbol, blockers, pointsToWin }) => {
    const room = rooms.get(roomId)
    if (!room) return

    // Anyone in the room can trigger a reset (simple)
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

    // eliminations -> score
    const gained = resolveEliminationsFrom(room.board, r, c)
    if (gained > 0) room.scores[playerIdx] += gained

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
          : `Board full. Tie between ${winners
              .map((w) => w.label)
              .join(', ')} (score ${winners[0].score}).`
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

    // players: keep seat & name (so reconnect can “reclaim”)
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
