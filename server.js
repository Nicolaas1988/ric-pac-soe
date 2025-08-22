const express = require('express')
const http = require('http')
const { Server } = require('socket.io')

const app = express()
const server = http.createServer(app)
const io = new Server(server)

app.use(express.static(__dirname))

const BOARD_SIZE = 8
let gameState = {
  board: Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null)),
  players: [],
  currentPlayerIndex: 0,
  scores: {},
}

function checkRowWinner(row) {
  if (!row[0]) return null
  const first = row[0]
  if (row.every((cell) => cell === first)) return first
  return null
}

function updateScores() {
  // Reset scores
  gameState.scores = {}
  for (const player of gameState.players) {
    gameState.scores[player] = 0
  }

  // Check each row for a winner
  gameState.board.forEach((row) => {
    const winnerSymbol = checkRowWinner(row)
    if (winnerSymbol) {
      // Find player who uses this symbol
      const player = gameState.players.find((p) => p.symbol === winnerSymbol)
      if (player) gameState.scores[player.name]++
    }
  })
}

io.on('connection', (socket) => {
  console.log('a user connected')

  // Send current state to new user
  socket.emit('gameState', gameState)

  socket.on('joinGame', (playerName) => {
    if (!gameState.players.some((p) => p.name === playerName)) {
      const symbol = ['O', '■', 'X'][gameState.players.length % 3]
      gameState.players.push({ name: playerName, symbol })
    }
    io.emit('gameState', gameState)
  })

  socket.on('makeMove', ({ player, row, col, symbol }) => {
    if (gameState.board[row][col] === null) {
      gameState.board[row][col] = symbol
      gameState.currentPlayerIndex =
        (gameState.currentPlayerIndex + 1) % gameState.players.length
      updateScores()
      io.emit('gameState', gameState)
    }
  })

  socket.on('resetGame', () => {
    gameState.board = Array.from({ length: BOARD_SIZE }, () =>
      Array(BOARD_SIZE).fill(null)
    )
    gameState.scores = {}
    io.emit('gameState', gameState)
  })

  socket.on('disconnect', () => {
    console.log('user disconnected')
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => console.log(`Server running on port ${PORT}`))
