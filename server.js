// server.js
import express from 'express'
import http from 'http'
import { Server } from 'socket.io'

const app = express()
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
})

const PORT = process.env.PORT || 3000

// Initialize game state
let gameState = {
  board: Array(8)
    .fill(null)
    .map(() => Array(8).fill(null)), // 8x8 grid
  players: [], // array of player names
  scores: {}, // player scores
  currentPlayerIndex: 0, // who's turn
}

// Utility: reset game
function resetGame() {
  gameState.board = Array(8)
    .fill(null)
    .map(() => Array(8).fill(null))
  gameState.scores = {}
  gameState.currentPlayerIndex = 0
  gameState.players = []
}

// Check if a player wins a row
function checkRows(player) {
  const symbols = ['O', 'X', '■']
  gameState.board.forEach((row) => {
    symbols.forEach((symbol) => {
      let count = 0
      row.forEach((cell) => {
        if (cell === symbol) count++
      })
      if (count === 3) {
        if (!gameState.scores[player]) gameState.scores[player] = 0
        gameState.scores[player] += 1
      }
    })
  })
}

// Socket.IO handling
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`)

  // Send current game state to the new player
  socket.emit('gameState', gameState)

  // Player joins the game
  socket.on('joinGame', (playerName) => {
    if (!gameState.players.includes(playerName)) {
      gameState.players.push(playerName)
      gameState.scores[playerName] = 0
    }
    io.emit('gameState', gameState)
  })

  // Player makes a move
  socket.on('makeMove', ({ player, row, col, symbol }) => {
    if (
      gameState.board[row][col] === null &&
      gameState.players[gameState.currentPlayerIndex] === player
    ) {
      gameState.board[row][col] = symbol

      // Check for row wins
      checkRows(player)

      // Next player
      gameState.currentPlayerIndex =
        (gameState.currentPlayerIndex + 1) % gameState.players.length

      io.emit('gameState', gameState)
    }
  })

  // Reset the game
  socket.on('resetGame', () => {
    resetGame()
    io.emit('gameState', gameState)
  })

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`)
  })
})

// Serve static files (optional if front-end is in same project)
app.use(express.static('public'))

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})
