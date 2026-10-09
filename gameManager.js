// =====================================================
// GAME MANAGER — Server-side game state & matchmaking
// =====================================================
const User = require('./models/User');

// Active waiting rooms: Map<roomKey, WaitingRoom>
const waitingRooms = new Map();

// Active games: Map<gameId, GameState>
const activeGames = new Map();

// Bot name pool
const BOT_NAMES = [
  'MasterGrog 🐸', 'SlowNinja 🐢', 'GexFly 🦎', 'DragonBoss 🐉',
  'FrogKing 🐸', 'TurtleX 🐢', 'LizardPro 🦎', 'SnakeEye 🐍',
  'CrocHunter 🐊', 'GeckoStar 🦎', 'ToadMaster 🐸', 'IguanaPro 🦎'
];

// Generate all 28 domino tiles
function generateTiles() {
  const tiles = [];
  for (let i = 0; i <= 6; i++) {
    for (let j = i; j <= 6; j++) {
      tiles.push([i, j]);
    }
  }
  return tiles;
}

// Fisher-Yates shuffle
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Generate unique game ID
function generateGameId() {
  return 'game_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
}

// Get random bot names (avoid duplicates)
function getRandomBotNames(count) {
  const shuffled = shuffleArray(BOT_NAMES);
  return shuffled.slice(0, count);
}

// =====================================================
// WAITING ROOM
// =====================================================
class WaitingRoom {
  constructor(roomConfig, io) {
    this.roomConfig = roomConfig; // { id, name, entryFee, entryLabel, coinsRange }
    this.roomKey = roomConfig.id;
    this.io = io;
    this.players = []; // { socketId, username, isBot }
    this.countdown = 20;
    this.timer = null;
    this.gameStarted = false;
  }

  async addPlayer(socket, username) {
    // Check if already in or pending (synchronous check before any await!)
    if (this.players.some(p => p.username === username || p.socketId === socket.id)) return false;
    
    // Reserve slot synchronously to prevent async race conditions
    const tempPlayer = { socketId: socket.id, username, isBot: false, pending: true };
    this.players.push(tempPlayer);

    // Server-side coin check before entering room
    const fee = this.roomConfig.entryFee || 1000;
    const requiredBuyIn = this.roomConfig.buyIn || (fee * 10);

    try {
      const user = await User.findOne({ username });
      if (!user || user.coins < requiredBuyIn) {
        this.players = this.players.filter(p => p !== tempPlayer);
        socket.emit('error-msg', `⚠️ KOIN TIDAK CUKUP! Membutuhkan minimal ${requiredBuyIn.toLocaleString()} koin untuk taruhan.`);
        return false;
      }
    } catch (e) {
      console.error('Error checking user coins for room:', e);
    }
    
    delete tempPlayer.pending;

    socket.join(this.roomKey);

    // Broadcast updated waiting state
    this.broadcastWaiting();

    // Start countdown on first player
    if (this.players.length === 1) {
      this.startCountdown();
    }

    // If 4 players, start immediately
    if (this.players.length >= 4) {
      this.startGame();
    }

    return true;
  }

  removePlayer(socketId) {
    this.players = this.players.filter(p => p.socketId !== socketId);
    
    if (this.players.length === 0) {
      this.cleanup();
      return;
    }

    this.broadcastWaiting();
  }

  startCountdown() {
    this.countdown = 20;
    this.timer = setInterval(() => {
      this.countdown--;
      this.broadcastWaiting();

      if (this.countdown <= 0) {
        this.startGame();
      }
    }, 1000);
  }

  broadcastWaiting() {
    const validPlayers = this.players.filter(p => !p.pending);
    // Deduplicate by username for broadcast safety
    const uniqueMap = new Map();
    validPlayers.forEach(p => uniqueMap.set(p.username, p));
    const uniquePlayers = Array.from(uniqueMap.values());

    this.io.to(this.roomKey).emit('waiting-update', {
      roomKey: this.roomKey,
      roomConfig: this.roomConfig,
      players: uniquePlayers.map(p => ({ username: p.username, isBot: p.isBot })),
      countdown: this.countdown,
      needed: 4 - uniquePlayers.length
    });
  }

  startGame() {
    if (this.gameStarted) return;
    this.gameStarted = true;
    clearInterval(this.timer);

    // Fill remaining seats with bots
    const botsNeeded = 4 - this.players.length;
    if (botsNeeded > 0) {
      const botNames = getRandomBotNames(botsNeeded);
      for (let i = 0; i < botsNeeded; i++) {
        this.players.push({
          socketId: null,
          username: botNames[i],
          isBot: true
        });
      }
    }

    // Create game
    const gameId = generateGameId();
    const game = new GameState(gameId, this.players, this.roomConfig, this.io);
    activeGames.set(gameId, game);

    // Clean up waiting room entry so future games start fresh
    waitingRooms.delete(this.roomKey);

    // Notify all players
    this.io.to(this.roomKey).emit('game-starting', { gameId });

    // Start dealing after short delay
    setTimeout(() => {
      game.deal();
    }, 500);

    // Cleanup waiting room
    waitingRooms.delete(this.roomKey);
  }

  cleanup() {
    clearInterval(this.timer);
    waitingRooms.delete(this.roomKey);
  }
}

// =====================================================
// GAME STATE
// =====================================================
class GameState {
  constructor(gameId, players, roomConfig, io) {
    this.gameId = gameId;
    this.io = io;
    this.roomConfig = roomConfig;
    this.players = players.map((p, idx) => ({
      ...p,
      seatIndex: idx,
      hand: [],
      connected: !p.isBot
    }));
    this.board = [];
    this.leftEnd = null;
    this.rightEnd = null;
    this.turnIndex = 0;
    this.passCount = 0;
    this.lastPlayerIdx = null; // who played the last tile (for payment when can't play)
    this.consecutivePassCount = 0; // how many consecutive passes (for dead-end detection)
    this.status = 'dealing'; // dealing | playing | ended
    this.winner = null;
    this.winType = null;
    this.coinChanges = {}; // { username: coinChange } for end result display
    this.logs = [];
    this.botTimer = null;
  }

  // Deal cards (Kamar Biasa rules with Buy-In Table Stack system)
  async deal() {
    const numPlayers = this.players.length;
    const tiles = shuffleArray(generateTiles());

    const fee = this.roomConfig.entryFee || 1000;
    const buyIn = this.roomConfig.buyIn || (fee * 10);
    this.buyIn = buyIn;

    // Check Wild Mode, Partner Mode, & 5 Kartu Mode
    const isWildMode = this.roomConfig?.id?.includes('wild') || this.roomConfig?.name?.includes('Wild') || this.roomConfig?.category === 'Wild';
    const isPartnerMode = this.roomConfig?.id?.includes('partner') || this.roomConfig?.name?.includes('Partner') || this.roomConfig?.category === 'Domino Partner';
    const is5KartuMode = this.roomConfig?.id?.includes('5kartu') || this.roomConfig?.id?.includes('card5') || this.roomConfig?.name?.includes('5 Kartu') || this.roomConfig?.category === '5 Kartu';
    
    this.isWildMode = isWildMode;
    this.isPartnerMode = isPartnerMode;
    this.is5KartuMode = is5KartuMode;

    const cardsPerPlayer = is5KartuMode ? 5 : 7;
    for (let i = 0; i < numPlayers; i++) {
      const p = this.players[i];
      p.hand = tiles.slice(i * cardsPerPlayer, (i + 1) * cardsPerPlayer);
      p.tableStack = buyIn; // In-game table stack (Chips/Saldo Meja)
      p.isBankrupt = false;

      if (!p.isBot) {
        try {
          const user = await User.findOne({ username: p.username });
          if (user) {
            user.coins = Math.max(0, user.coins - buyIn);
            await user.save();
          }
        } catch (err) {
          console.error('Error deducting buy-in for', p.username, err);
        }
      }
    }

    if (is5KartuMode) {
      this.drawPile = tiles.slice(numPlayers * cardsPerPlayer);
    } else {
      this.drawPile = [];
    }

    this.board = [];
    this.leftEnd = null;
    this.rightEnd = null;
    this.passCount = 0;
    this.consecutivePassCount = 0;
    this.lastPlayerIdx = null;
    this.winner = null;
    this.coinChanges = {};

    this.players.forEach(p => {
      this.coinChanges[p.username] = 0;
    });

    if (isWildMode) {
      const allTiles = generateTiles();
      this.wildTile = allTiles[Math.floor(Math.random() * allTiles.length)];
      this.logs = [
        `Uang pasang ${buyIn.toLocaleString()} koin dipasang di meja.`,
        `🃏 KAMAR WILD: Kartu Wild ronde ini adalah [${this.wildTile[0]},${this.wildTile[1]}]!`
      ];
    } else if (isPartnerMode) {
      this.wildTile = null;
      this.logs = [`Uang pasang ${buyIn.toLocaleString()} koin dipasang di meja (Mode Tim 2 vs 2).`];
    } else if (is5KartuMode) {
      this.wildTile = null;
      this.logs = [`Uang pasang ${buyIn.toLocaleString()} koin dipasang di meja. Mode 5 Kartu (Sisa bumbung: ${this.drawPile.length}).`];
    } else {
      this.wildTile = null;
      this.logs = [`Uang pasang ${buyIn.toLocaleString()} koin dipasang di meja. Sistem menentukan pemain pertama secara acak.`];
    }

    // RULE: In Partner Mode, player holding [6,6] MUST start first
    let starter = Math.floor(Math.random() * numPlayers);
    if (isPartnerMode) {
      let balak6Holder = -1;
      this.players.forEach((p, idx) => {
        if (p.hand.some(t => t[0] === 6 && t[1] === 6)) {
          balak6Holder = idx;
        }
      });
      if (balak6Holder !== -1) {
        starter = balak6Holder;
        this.logs.push(`👥 PARTNER: ${this.players[starter].username} memegang Balak [6,6] dan wajib memulai permainan terlebih dahulu!`);
      } else {
        this.logs.push(`${this.players[starter].username} akan memulai terlebih dahulu!`);
      }
    } else {
      this.logs.push(`${this.players[starter].username} akan memulai terlebih dahulu!`);
    }

    this.status = 'playing';
    this.turnIndex = starter;
    this.lastPlayerIdx = null;

    this.broadcastState();
    this.checkBotTurn();
  }

  // Helper for turn advancement (Counter-clockwise for Partner Mode)
  getNextTurnIndex(currentIdx) {
    const numPlayers = this.players.length;
    if (this.isPartnerMode) {
      let nextTurn = (currentIdx - 1 + numPlayers) % numPlayers;
      while (this.players[nextTurn].isBankrupt && nextTurn !== currentIdx) {
        nextTurn = (nextTurn - 1 + numPlayers) % numPlayers;
      }
      return nextTurn;
    } else {
      let nextTurn = (currentIdx + 1) % numPlayers;
      while (this.players[nextTurn].isBankrupt && nextTurn !== currentIdx) {
        nextTurn = (nextTurn + 1) % numPlayers;
      }
      return nextTurn;
    }
  }

  // Broadcast game state to all real players
  broadcastState() {
    for (const player of this.players) {
      if (player.isBot) continue;

      const pipSums = {};
      this.players.forEach(p => {
        pipSums[p.username] = p.hand.reduce((s, t) => s + t[0] + t[1], 0);
      });

      const state = {
        gameId: this.gameId,
        roomConfig: this.roomConfig,
        buyIn: this.buyIn,
        status: this.status,
        board: this.board,
        leftEnd: this.leftEnd,
        rightEnd: this.rightEnd,
        isWildMode: !!this.isWildMode,
        wildTile: this.wildTile || null,
        isPartnerMode: !!this.isPartnerMode,
        teams: {
          teamA: [0, 2],
          teamB: [1, 3]
        },
        turnIndex: this.turnIndex,
        passCount: this.passCount,
        consecutivePassCount: this.consecutivePassCount,
        lastPlayerIdx: this.lastPlayerIdx,
        winner: this.winner,
        winType: this.winType,
        winCategory: this.winCategory || null,
        winMultiplier: this.winMultiplier || 1,
        coinChanges: this.coinChanges, // Net gain/loss relative to buyIn
        pipSums,
        mySeatIndex: player.seatIndex,
        players: this.players.map((p, idx) => ({
          seatIndex: idx,
          username: p.username,
          isBot: p.isBot,
          team: idx % 2 === 0 ? 'A' : 'B',
          cardCount: p.hand.length,
          pipSum: p.hand.reduce((s, t) => s + t[0] + t[1], 0),
          tableStack: p.tableStack ?? 0,
          isBankrupt: !!p.isBankrupt,
          hand: idx === player.seatIndex ? p.hand : undefined
        }))
      };

      this.io.to(player.socketId).emit('game-state', state);
    }
  }

  // Check and process current turn (Auto-pass when no playable cards)
  checkBotTurn() {
    if (this.status !== 'playing') return;

    const current = this.players[this.turnIndex];
    if (!current || current.isBankrupt) {
      let nextTurn = (this.turnIndex + 1) % this.players.length;
      this.turnIndex = nextTurn;
      this.broadcastState();
      this.checkBotTurn();
      return;
    }

    // Check if current player has ANY playable tile
    const hasPlayable = this.leftEnd === null || current.hand.some(t => this.isPlayable(t));

    // If player has NO playable tile, server automatically executes doPass after 1s!
    if (!hasPlayable) {
      clearTimeout(this.botTimer);
      this.botTimer = setTimeout(() => {
        if (this.status === 'playing' && this.turnIndex === current.seatIndex) {
          this.doPass(current.seatIndex);
        }
      }, 1000);
      return;
    }

    // If bot's turn, run botPlay
    if (current.isBot) {
      const delay = 1200 + Math.random() * 1000;
      clearTimeout(this.botTimer);
      this.botTimer = setTimeout(() => {
        this.botPlay();
      }, delay);
    }
  }

  // Bot AI play logic (Kamar Biasa rules)
  botPlay() {
    if (this.status !== 'playing') return;
    const bot = this.players[this.turnIndex];
    if (!bot || bot.isBankrupt) {
      this.turnIndex = (this.turnIndex + 1) % this.players.length;
      this.broadcastState();
      this.checkBotTurn();
      return;
    }
    
    // If board is empty (first move), bot must play ANY tile
    if (this.leftEnd === null) {
      if (this.isPartnerMode) {
        const balak6 = bot.hand.find(t => t[0] === 6 && t[1] === 6);
        if (balak6) {
          this.doPlay(this.turnIndex, balak6, 'right');
          return;
        }
      }
      // Play a double if available (strategy), otherwise random
      const doubles = bot.hand.filter(t => t[0] === t[1]);
      const tile = doubles.length > 0 ? doubles[Math.floor(Math.random() * doubles.length)] : bot.hand[Math.floor(Math.random() * bot.hand.length)];
      this.doPlay(this.turnIndex, tile, 'right');
      return;
    }
    
    const playable = bot.hand.filter(t => this.isPlayable(t));

    if (playable.length === 0) {
      // RULE: Must pay previous player when can't play
      this.doPass(this.turnIndex);
      return;
    }

    // Strategy: prefer doubles, then lowest remaining pip sum (to win sooner)
    playable.sort((a, b) => {
      const dA = a[0] === a[1] ? 1 : 0;
      const dB = b[0] === b[1] ? 1 : 0;
      if (dA !== dB) return dB - dA;
      return (b[0] + b[1]) - (a[0] + a[1]);
    });

    const tile = playable[0];
    
    // Decide side
    const matchLeft = (tile[0] === this.leftEnd || tile[1] === this.leftEnd);
    const matchRight = (tile[0] === this.rightEnd || tile[1] === this.rightEnd);
    let side = 'right';
    if (matchLeft && matchRight) {
      side = Math.random() > 0.5 ? 'left' : 'right';
    } else if (matchLeft) {
      side = 'left';
    }

    this.doPlay(this.turnIndex, tile, side);
  }

  // Check if tile can be placed
  isPlayable(tile) {
    if (!tile || tile.length < 2) return false;
    if (this.leftEnd === null) return true;

    // Wild Tile check: matches ANY board end!
    if (this.isWildMode && this.wildTile) {
      const isWild = (tile[0] === this.wildTile[0] && tile[1] === this.wildTile[1]) ||
                     (tile[0] === this.wildTile[1] && tile[1] === this.wildTile[0]);
      if (isWild) return true;
    }

    const [a, b] = tile;
    return a === this.leftEnd || b === this.leftEnd || a === this.rightEnd || b === this.rightEnd;
  }

  // Execute a play
  doPlay(playerIdx, tile, side) {
    if (this.status !== 'playing') return;
    if (playerIdx !== this.turnIndex) return;

    const numPlayers = this.players.length;
    const player = this.players[playerIdx];
    if (player.isBankrupt) return;

    const tileIdx = player.hand.findIndex(t => t[0] === tile[0] && t[1] === tile[1]);
    if (tileIdx === -1) return;
    if (!this.isPlayable(tile)) return;

    // Remove from hand
    player.hand.splice(tileIdx, 1);

    // Check match options before placing tile
    const prevLeft = this.leftEnd;
    const prevRight = this.rightEnd;
    const [a, b] = tile;
    const matchesLeft = prevLeft !== null && (a === prevLeft || b === prevLeft);
    const matchesRight = prevRight !== null && (a === prevRight || b === prevRight);
    const matchesBothEnds = prevLeft !== null && prevRight !== null && matchesLeft && matchesRight;
    const isDoubleTile = a === b;

    // Place on board
    if (this.leftEnd === null || this.rightEnd === null) {
      // First tile played on empty board!
      this.board.push({ left: a, right: b });
      this.leftEnd = a;
      this.rightEnd = b;
    } else if (side === 'left') {
      if (b === this.leftEnd) {
        this.board.unshift({ left: a, right: b });
        this.leftEnd = a;
      } else {
        this.board.unshift({ left: b, right: a });
        this.leftEnd = b;
      }
    } else {
      if (a === this.rightEnd) {
        this.board.push({ left: a, right: b });
        this.rightEnd = b;
      } else {
        this.board.push({ left: b, right: a });
        this.rightEnd = a;
      }
    }

    this.consecutivePassCount = 0; // Reset consecutive pass count on successful play
    this.passCount = 0;
    this.lastPlayerIdx = playerIdx; // Remember who last played
    this.logs.push(`${player.username} melempar [${a},${b}] ke ${side === 'left' ? 'Kiri' : 'Kanan'}`);

    // Check win: player who empties their hand first wins
    if (player.hand.length === 0) {
      let winCategory = 'Double';
      let multiplier = 2;

      if (this.isPartnerMode) {
        // Collect all remaining cards in all other players' hands
        const otherHands = this.players
          .filter((_, idx) => idx !== playerIdx)
          .flatMap(p => p.hand);

        const endAExists = otherHands.some(t => t[0] === a || t[1] === a);
        const endBExists = otherHands.some(t => t[0] === b || t[1] === b);
        const anyEndExists = endAExists || endBExists;

        if (matchesBothEnds) {
          if (isDoubleTile) {
            if (!anyEndExists) {
              winCategory = 'Domi Ceki Palang';
              multiplier = 4;
            } else {
              winCategory = 'Domi Ceki Balak';
              multiplier = 3;
            }
          } else {
            if (!anyEndExists) {
              winCategory = 'Domi Ceki Habis';
              multiplier = 3;
            } else {
              winCategory = 'Domi Ceki Biasa';
              multiplier = 2;
            }
          }
        } else {
          if (isDoubleTile) {
            winCategory = 'Domi Balak';
            multiplier = 2;
          } else {
            winCategory = 'Domi Biasa';
            multiplier = 1;
          }
        }
      } else {
        if (isDoubleTile && matchesBothEnds) {
          winCategory = 'Quintet';
          multiplier = 5;
        } else if (!isDoubleTile && matchesBothEnds) {
          winCategory = 'Quartet';
          multiplier = 4;
        } else if (isDoubleTile && !matchesBothEnds) {
          winCategory = 'Triple';
          multiplier = 3;
        } else {
          winCategory = 'Double';
          multiplier = 2;
        }
      }

      this.endGame(playerIdx, 'normal', { winCategory, multiplier, tile });
      return;
    }

    // Next turn (skip bankrupt, counter-clockwise for Partner Mode)
    this.turnIndex = this.getNextTurnIndex(this.turnIndex);
    this.broadcastState();
    this.checkBotTurn();
  }

  // Execute a pass (pay previous player from tableStack)
  doPass(playerIdx) {
    if (this.status !== 'playing') return;
    if (playerIdx !== this.turnIndex) return;

    const numPlayers = this.players.length;
    const currentPlayer = this.players[playerIdx];
    
    if (currentPlayer.isBankrupt) {
      this.turnIndex = this.getNextTurnIndex(this.turnIndex);
      this.broadcastState();
      this.checkBotTurn();
      return;
    }

    // Rule: In 5 Kartu Mode, if player has no playable card, MUST draw from bumbung first!
    if (this.is5KartuMode && this.drawPile && this.drawPile.length > 0) {
      let drawnAny = false;
      while (this.drawPile.length > 0 && !currentPlayer.hand.some(t => this.isPlayable(t))) {
        const drawnTile = this.drawPile.shift();
        currentPlayer.hand.push(drawnTile);
        drawnAny = true;
        this.logs.push(`${currentPlayer.username} mengambil 1 kartu dari bumbung [Sisa bumbung: ${this.drawPile.length}].`);
      }

      if (drawnAny) {
        this.broadcastState();
        if (currentPlayer.hand.some(t => this.isPlayable(t))) {
          if (currentPlayer.isBot) {
            this.checkBotTurn();
          }
          return;
        }
      }
    }

    const fee = this.roomConfig.entryFee || 1000;
    const buyIn = this.buyIn || (fee * 10);

    let actualPay = 0;
    if (this.isPartnerMode) {
      // RULE: Partner Mode pass pay = Bet * 0.1
      const passFee = Math.floor(fee * 0.1);
      actualPay = Math.min(passFee, currentPlayer.tableStack);
    } else if (this.is5KartuMode) {
      // RULE: 5 Kartu Mode pass pay = 1x Bet
      actualPay = Math.min(fee, currentPlayer.tableStack);
    } else {
      const pipSum = currentPlayer.hand.reduce((s, t) => s + t[0] + t[1], 0);
      const calculatedPay = Math.max(fee, Math.floor(pipSum * fee / 10));
      actualPay = Math.min(calculatedPay, currentPlayer.tableStack);
    }

    if (this.lastPlayerIdx !== null && this.lastPlayerIdx !== playerIdx) {
      // Pay the previous player
      const prevPlayer = this.players[this.lastPlayerIdx];
      
      currentPlayer.tableStack -= actualPay;
      prevPlayer.tableStack += actualPay;

      this.logs.push(`${currentPlayer.username} tidak bisa main → bayar ${actualPay.toLocaleString()} koin (1x Bet Lewat) ke ${prevPlayer.username}`);

      if (currentPlayer.tableStack <= 0) {
        currentPlayer.tableStack = 0;
        currentPlayer.isBankrupt = true;
        this.logs.push(`💥 ${currentPlayer.username} BANGKRUT! Saldo meja habis.`);
      }
    } else {
      // First turn or no previous player — just pass
      this.logs.push(`${currentPlayer.username} lewat (tidak bisa jalan).`);
    }

    // Track net changes relative to buyIn
    this.players.forEach(p => {
      this.coinChanges[p.username] = p.tableStack - buyIn;
    });

    this.passCount++;
    this.consecutivePassCount++;

    // Check if only 1 active player remains
    const activePlayers = this.players.filter(p => !p.isBankrupt);
    if (activePlayers.length <= 1) {
      const winnerIdx = this.players.findIndex(p => !p.isBankrupt);
      this.endGame(winnerIdx >= 0 ? winnerIdx : 0, 'bankruptcy');
      return;
    }

    // RULE: Dead-End — if ALL active players consecutively cannot play, game ends
    if (this.consecutivePassCount >= numPlayers) {
      this.endGame(null, 'block');
      return;
    }

    // Next turn (skip bankrupt)
    this.turnIndex = this.getNextTurnIndex(this.turnIndex);
    this.broadcastState();
    this.checkBotTurn();
  }

  // End game (Kamar Biasa & Kamar Bet & Partner rules)
  async endGame(winnerIdx, winType, winDetails = {}) {
    if (this.status === 'ended') return; // Prevent double end
    this.status = 'ended';
    this.winType = winType;

    const fee = this.roomConfig.entryFee || 1000;
    const buyIn = this.buyIn || (fee * 10);
    const numPlayers = this.players.length;

    let winCategory = 'Single';
    let multiplier = 1;

    const getPipSum = (p) => p.hand.reduce((s, t) => s + t[0] + t[1], 0);

    if (winType === 'bankruptcy') {
      this.logs.push(`💥 Semua lawan BANGKRUT! ${this.players[winnerIdx]?.username || 'Pemenang'} menyapu bersih meja!`);
      winCategory = 'Single';
      multiplier = 1;
    } else if (winType === 'block') {
      if (this.isPartnerMode) {
        // Domi Kandang (Dead-End in Partner Mode)
        const pengunciIdx = this.lastPlayerIdx !== null ? this.lastPlayerIdx : 0;
        const pengunciPipSum = getPipSum(this.players[pengunciIdx]);

        const opponents = this.players.filter(p => !p.isBankrupt && (p.seatIndex % 2 !== pengunciIdx % 2));
        const opponentPipSums = opponents.map(p => getPipSum(p));
        const minOpponentPipSum = opponentPipSums.length > 0 ? Math.min(...opponentPipSums) : Infinity;

        if (pengunciPipSum < minOpponentPipSum) {
          // Pengunci wins! Bet * 2
          winnerIdx = pengunciIdx;
          winCategory = 'Domi Kandang (Pengunci Menang)';
          multiplier = 2;
        } else if (opponentPipSums.some(s => s === pengunciPipSum)) {
          // Seri -> Lawan menang! Bet * 1
          const winningOpponent = opponents.find(p => getPipSum(p) === pengunciPipSum) || opponents[0];
          winnerIdx = winningOpponent.seatIndex;
          winCategory = 'Domi Kandang (Seri - Lawan Menang)';
          multiplier = 1;
        } else {
          // Lawan menang! Bet * 3
          const winningOpponent = opponents.reduce((prev, curr) => getPipSum(curr) < getPipSum(prev) ? curr : prev, opponents[0]);
          winnerIdx = winningOpponent.seatIndex;
          winCategory = 'Domi Kandang (Lawan Menang)';
          multiplier = 3;
        }
        this.logs.push(`🔴 Domi Kandang! ${winCategory} [${multiplier}x Bet]`);
      } else {
        // Standard Dead-End & 5 Kartu Dead-End
        const active = this.players.filter(p => !p.isBankrupt);
        active.sort((a, b) => {
          const sumA = getPipSum(a);
          const sumB = getPipSum(b);
          if (sumA !== sumB) return sumA - sumB;
          if (a.hand.length !== b.hand.length) return a.hand.length - b.hand.length;
          const getTopPip = p => p.hand.length > 0 ? Math.max(...p.hand.flatMap(t => [t[0], t[1]])) : 0;
          return getTopPip(a) - getTopPip(b);
        });

        const winnerP = active[0] || this.players[0];
        winnerIdx = this.players.indexOf(winnerP);
        winCategory = 'Single';
        multiplier = 1;
        this.logs.push(`🔴 Dead-End! Pemenang (titik terkecil = ${getPipSum(winnerP)}): ${winnerP.username}`);
      }
    } else {
      winCategory = winDetails.winCategory || 'Double';
      multiplier = winDetails.multiplier || 2;
      this.logs.push(`🏆 ${this.players[winnerIdx].username} menang! [${winCategory.toUpperCase()} ${multiplier}x Bet]`);
    }

    this.winCategory = winCategory;
    this.winMultiplier = multiplier;
    this.winner = winnerIdx;

    // Calculate payouts
    const betAmount = fee;
    const totalWinPerLoser = betAmount * multiplier;

    if (this.isPartnerMode) {
      // Partner Mode Team Payout: Losing team members each pay Bet * multiplier, winning team splits total equally
      const winningTeam = (winnerIdx % 2 === 0 ? 'A' : 'B');
      const winnerSeats = winningTeam === 'A' ? [0, 2] : [1, 3];
      const loserSeats = winningTeam === 'A' ? [1, 3] : [0, 2];

      let totalPotCollected = 0;

      loserSeats.forEach(seatIdx => {
        const loser = this.players[seatIdx];
        if (loser) {
          const payment = Math.min(totalWinPerLoser, loser.tableStack);
          loser.tableStack -= payment;
          totalPotCollected += payment;
          this.logs.push(`${loser.username} (Tim Kalah) bayar ${payment.toLocaleString()} koin [${winCategory} ${multiplier}x]`);
        }
      });

      const share = Math.floor(totalPotCollected / winnerSeats.length);
      winnerSeats.forEach(seatIdx => {
        const winnerP = this.players[seatIdx];
        if (winnerP) {
          winnerP.tableStack += share;
          this.logs.push(`${winnerP.username} (Tim Menang Tim ${winningTeam}) menerima ${share.toLocaleString()} koin`);
        }
      });
    } else if (this.is5KartuMode) {
      // 5 Kartu Mode Payout: Bet * Multiplier * Loser Pip Sum
      for (let i = 0; i < numPlayers; i++) {
        if (i === winnerIdx || this.players[i].isBankrupt) continue;
        const loserPipSum = getPipSum(this.players[i]);
        const calculatedPayment = betAmount * multiplier * Math.max(1, loserPipSum);
        const payment = Math.min(calculatedPayment, this.players[i].tableStack);
        this.players[i].tableStack -= payment;
        this.players[winnerIdx].tableStack += payment;
        this.logs.push(`${this.players[i].username} bayar ${payment.toLocaleString()} koin [Bet ${betAmount.toLocaleString()} x ${winCategory} (${multiplier}x) x ${loserPipSum} pip] ke ${this.players[winnerIdx].username}`);
      }
    } else {
      // Standard Payout
      for (let i = 0; i < numPlayers; i++) {
        if (i === winnerIdx || this.players[i].isBankrupt) continue;
        const payment = Math.min(totalWinPerLoser, this.players[i].tableStack);
        this.players[i].tableStack -= payment;
        this.players[winnerIdx].tableStack += payment;
        this.logs.push(`${this.players[i].username} bayar ${payment.toLocaleString()} koin [${winCategory} ${multiplier}x] ke ${this.players[winnerIdx].username}`);
      }
    }

    // Save final table stacks back to database
    for (const p of this.players) {
      this.coinChanges[p.username] = p.tableStack - buyIn;
      if (!p.isBot) {
        try {
          const user = await User.findOne({ username: p.username });
          if (user) {
            user.coins = user.coins + p.tableStack;
            await user.save();
          }
        } catch (err) {
          console.error('Error updating final coins for', p.username, err);
        }
      }
    }

    this.broadcastState();

    // Cleanup after 45 seconds
    setTimeout(() => {
      activeGames.delete(this.gameId);
    }, 45000);
  }

  // Handle player leaving active game (forfeits buy-in / hangus!)
  handlePlayerLeave(socketId, isExplicit = false) {
    const player = this.players.find(p => p.socketId === socketId);
    if (!player) return;

    player.explicitlyLeft = true;

    if (this.status === 'playing' && !player.isBankrupt) {
      const forfeitedStack = player.tableStack;
      player.tableStack = 0;
      player.isBankrupt = true;
      player.connected = false;
      player.isBot = true;

      this.logs.push(`⚠️ ${player.username} KELUAR GAME! Uang pasang (${forfeitedStack.toLocaleString()} koin) HANGUS!`);

      // Distribute forfeitedStack evenly among remaining active non-bankrupt players
      const activePlayers = this.players.filter(p => !p.isBankrupt && p.seatIndex !== player.seatIndex);
      if (activePlayers.length > 0) {
        const share = Math.floor(forfeitedStack / activePlayers.length);
        activePlayers.forEach(p => {
          p.tableStack += share;
        });
      }

      // Track net changes relative to buyIn
      const buyIn = this.buyIn || 10000;
      this.players.forEach(p => {
        this.coinChanges[p.username] = p.tableStack - buyIn;
      });

      // If only 1 player remains active, end game immediately
      if (activePlayers.length <= 1) {
        const winnerIdx = this.players.findIndex(p => !p.isBankrupt);
        this.endGame(winnerIdx >= 0 ? winnerIdx : 0, 'bankruptcy');
        return;
      }

      // If it was their turn, skip to next turn
      if (this.turnIndex === player.seatIndex) {
        let nextTurn = (this.turnIndex + 1) % this.players.length;
        while (this.players[nextTurn].isBankrupt && nextTurn !== this.turnIndex) {
          nextTurn = (nextTurn + 1) % this.players.length;
        }
        this.turnIndex = nextTurn;
        this.checkBotTurn();
      }

      this.broadcastState();
    }
  }

  // Handle player disconnect
  handleDisconnect(socketId) {
    this.handlePlayerLeave(socketId, false);
  }

  // Handle reconnect (ONLY for active ongoing playing games where player didn't explicitly leave)
  handleReconnect(socket, username) {
    if (this.status !== 'playing') return false;

    const player = this.players.find(p => p.username === username);
    if (!player) return false;
    if (player.isBankrupt || player.explicitlyLeft) return false;

    player.socketId = socket.id;
    player.isBot = false;
    player.connected = true;
    socket.join(this.gameId);
    this.logs.push(`${username} kembali terhubung.`);
    this.broadcastState();
    return true;
  }

  cleanup() {
    clearTimeout(this.botTimer);
    activeGames.delete(this.gameId);
  }
}

// Active Team Code Lobbies: Map<code, { code, hostUsername, partnerUsername }>
const activeTeamCodes = new Map();

// Active Team Partner pairs: Map<username, partnerUsername>
const activeTeamsMap = new Map();

function generate6DigitCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// User socket registry
const userSockets = new Map();

// =====================================================
// SOCKET.IO EVENT HANDLER
// =====================================================
function initSocketIO(io) {
  io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    // Register active user socket
    socket.on('register-user', ({ username }) => {
      if (username) {
        socket.username = username;
        userSockets.set(username, socket.id);
        // Broadcast updated online list to all connected clients
        io.emit('online-users-update', { onlineUsers: Array.from(userSockets.keys()) });
      }
    });

    // Request active team status synchronization
    socket.on('get-team-status', ({ username }) => {
      if (username) {
        const partnerUsername = activeTeamsMap.get(username) || null;
        socket.emit('team-status-update', { partnerUsername });
      }
    });

    // Create 6-Digit Team Code
    socket.on('create-team-code', ({ username }) => {
      let code = generate6DigitCode();
      while (activeTeamCodes.has(code)) {
        code = generate6DigitCode();
      }
      activeTeamCodes.set(code, { code, hostUsername: username, partnerUsername: null });
      socket.emit('team-code-created', { code });
    });

    // Join Team Code (Enter 6-digit Team Code)
    socket.on('join-team-code', ({ username, code }) => {
      const teamLobby = activeTeamCodes.get(code);
      if (!teamLobby) {
        socket.emit('team-code-error', { message: `Kode Tim "${code}" tidak ditemukan atau sudah kadaluarsa.` });
        return;
      }
      if (teamLobby.hostUsername === username) {
        socket.emit('team-code-error', { message: 'Anda adalah pembuat Kode Tim ini.' });
        return;
      }
      if (teamLobby.partnerUsername) {
        socket.emit('team-code-error', { message: `Tim dengan Kode "${code}" sudah penuh (2/2).` });
        return;
      }

      teamLobby.partnerUsername = username;
      activeTeamsMap.set(teamLobby.hostUsername, username);
      activeTeamsMap.set(username, teamLobby.hostUsername);

      const hostSocketId = userSockets.get(teamLobby.hostUsername);
      if (hostSocketId) {
        io.to(hostSocketId).emit('team-invite-accepted', { partnerUsername: username, teamCode: code });
      }
      const partnerSocketId = userSockets.get(username);
      if (partnerSocketId) {
        io.to(partnerSocketId).emit('team-invite-accepted', { partnerUsername: teamLobby.hostUsername, teamCode: code });
      }
    });

    // Cancel Team Code
    socket.on('cancel-team-code', ({ code }) => {
      if (code) {
        activeTeamCodes.delete(code);
      }
    });

    // Team Partner invitation events
    socket.on('invite-team-partner', ({ fromUsername, toUsername }) => {
      const targetSocketId = userSockets.get(toUsername);
      if (targetSocketId) {
        io.to(targetSocketId).emit('team-invite-received', { fromUsername });
        socket.emit('team-invite-sent', { toUsername });
      } else {
        socket.emit('team-invite-error', { message: `Pemain ${toUsername} sedang tidak online di lobby.` });
      }
    });

    socket.on('accept-team-partner', ({ fromUsername, toUsername }) => {
      activeTeamsMap.set(fromUsername, toUsername);
      activeTeamsMap.set(toUsername, fromUsername);

      const senderSocketId = userSockets.get(fromUsername);
      if (senderSocketId) {
        io.to(senderSocketId).emit('team-invite-accepted', { partnerUsername: toUsername });
      }
      const receiverSocketId = userSockets.get(toUsername);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('team-invite-accepted', { partnerUsername: fromUsername });
      }
    });

    socket.on('decline-team-partner', ({ fromUsername, toUsername }) => {
      const senderSocketId = userSockets.get(fromUsername);
      if (senderSocketId) {
        io.to(senderSocketId).emit('team-invite-declined', { partnerUsername: toUsername });
      }
    });

    socket.on('leave-team-partner', ({ fromUsername, partnerUsername }) => {
      activeTeamsMap.delete(fromUsername);
      if (partnerUsername) activeTeamsMap.delete(partnerUsername);

      const partnerSocketId = userSockets.get(partnerUsername);
      if (partnerSocketId) {
        io.to(partnerSocketId).emit('team-left', { username: fromUsername });
      }
    });

    // Team leader joins room -> Validate BOTH host and partner coins before entering!
    socket.on('team-join-room', async ({ roomConfig, hostUsername, partnerUsername }) => {
      const fee = roomConfig.entryFee || 1000;
      const requiredBuyIn = roomConfig.buyIn || (fee * 10);

      try {
        const [hostUser, partnerUser] = await Promise.all([
          User.findOne({ username: hostUsername }),
          User.findOne({ username: partnerUsername })
        ]);

        if (!hostUser || hostUser.coins < requiredBuyIn) {
          socket.emit('team-join-error', {
            message: `⚠️ KOIN ANDA TIDAK CUKUP!\n\nAnda membutuhkan minimal ${requiredBuyIn.toLocaleString('id-ID')} koin untuk masuk kamar ${roomConfig.name}.`
          });
          return;
        }

        if (!partnerUser || partnerUser.coins < requiredBuyIn) {
          const partnerCoins = partnerUser ? partnerUser.coins.toLocaleString('id-ID') : '0';
          socket.emit('team-join-error', {
            message: `⚠️ KOIN TEMAN SETIM TIDAK CUKUP!\n\nTeman setim Anda (${partnerUsername}) hanya memiliki ${partnerCoins} koin, tetapi kamar ${roomConfig.name} membutuhkan minimal ${requiredBuyIn.toLocaleString('id-ID')} koin.`
          });
          return;
        }

        // Both host and partner have enough coins! Proceed to enter room!
        socket.emit('team-join-success', { roomConfig });

        const partnerSocketId = userSockets.get(partnerUsername);
        if (partnerSocketId) {
          io.to(partnerSocketId).emit('auto-enter-room', { room: roomConfig });
        }
      } catch (err) {
        console.error('Error validating team coins:', err);
      }
    });

    // Join a waiting room
    socket.on('join-room', async ({ roomConfig, username }) => {
      const roomKey = roomConfig.id;

      // Reconnect ONLY if player is in an active ongoing game they didn't leave
      for (const [gameId, game] of activeGames) {
        if (game.status === 'playing' && game.handleReconnect(socket, username)) {
          socket.emit('game-starting', { gameId });
          return;
        }
      }

      // Get or create waiting room
      let room = waitingRooms.get(roomKey);
      if (!room || room.gameStarted) {
        room = new WaitingRoom(roomConfig, io);
        waitingRooms.set(roomKey, room);
      }

      await room.addPlayer(socket, username);
    });

    // Player action: play a card
    socket.on('play-card', ({ gameId, tile, side }) => {
      const game = activeGames.get(gameId);
      if (!game) return;

      const player = game.players.find(p => p.socketId === socket.id);
      if (!player) return;

      game.doPlay(player.seatIndex, tile, side);
    });

    // Player action: pass turn
    socket.on('pass-turn', ({ gameId }) => {
      const game = activeGames.get(gameId);
      if (!game) return;

      const player = game.players.find(p => p.socketId === socket.id);
      if (!player) return;

      game.doPass(player.seatIndex);
    });

    // Player leaves room or game
    socket.on('leave-room', ({ roomKey, gameId }) => {
      if (roomKey) {
        const room = waitingRooms.get(roomKey);
        if (room) {
          room.removePlayer(socket.id);
          if (room.players.length === 0) {
            waitingRooms.delete(roomKey);
          }
        }
      }

      // Remove from all waiting rooms for cleanup safety
      for (const [key, room] of waitingRooms) {
        room.removePlayer(socket.id);
        if (room.players.length === 0) {
          waitingRooms.delete(key);
        }
      }

      if (gameId) {
        const game = activeGames.get(gameId);
        if (game) {
          game.handlePlayerLeave(socket.id, true);
          if (game.status === 'ended') {
            activeGames.delete(gameId);
          }
        }
      }
    });

    // Disconnect
    socket.on('disconnect', () => {
      console.log('Player disconnected:', socket.id);

      // Remove from online registry
      if (socket.username && userSockets.get(socket.username) === socket.id) {
        userSockets.delete(socket.username);
        io.emit('online-users-update', { onlineUsers: Array.from(userSockets.keys()) });
      }

      // Check waiting rooms
      for (const [key, room] of waitingRooms) {
        room.removePlayer(socket.id);
        if (room.players.length === 0) {
          waitingRooms.delete(key);
        }
      }

      // Check active games
      for (const [gameId, game] of activeGames) {
        game.handlePlayerLeave(socket.id);
      }
    });

    // Get list of online friends
    socket.on('get-online-friends', ({ friendUsernames }) => {
      const onlineList = Array.from(userSockets.keys());
      const onlineFriends = (friendUsernames || []).filter(f => onlineList.includes(f));
      socket.emit('online-friends-result', { onlineFriends, allOnline: onlineList });
    });

    // =====================================================
    // SLOT MACHINE LOGIC (DuoFuDuoCai)
    // =====================================================
    // Track consecutive losses per user for forced-win mechanic
    const userLossStreak = new Map();

    socket.on('spin_slot', async ({ username, betAmount }) => {
      try {
        const user = await User.findOne({ username });
        if (!user) {
          socket.emit('spin_error', { message: 'User not found' });
          return;
        }

        if (user.coins < betAmount) {
          socket.emit('spin_error', { message: 'Koin tidak cukup!' });
          return;
        }

        // 1. Deduct bet
        user.coins -= betAmount;

        // 2. Track loss streak (HDI-style forced win mechanic)
        const streak = userLossStreak.get(username) || 0;
        // Force a win every 3-6 consecutive losses (random)
        const forceWinThreshold = 3 + Math.floor(Math.random() * 4); // 3 to 6
        const forceWin = streak >= forceWinThreshold;

        // 3. Generate Slot Grid (3 rows x 5 columns)
        // 0: 9, 1: 10, 2: J, 3: Q, 4: K, 5: A
        // 6: Coin, 7: Turtle, 8: Ship, 9: Gold Bowl, 10: Wild
        const numCols = 5;
        const numRows = 3;
        let grid = [];
        
        // Weighted distribution (HDI style)
        const symbolWeights = [
          { sym: 0, weight: 22 }, // 9
          { sym: 1, weight: 20 }, // 10
          { sym: 2, weight: 16 }, // J
          { sym: 3, weight: 13 }, // Q
          { sym: 4, weight: 11 }, // K
          { sym: 5, weight: 9 },  // A
          { sym: 6, weight: 6 },  // Coin
          { sym: 7, weight: 4 },  // Turtle
          { sym: 8, weight: 2.5 }, // Ship
          { sym: 9, weight: 1.5 }, // Gold Bowl
        ];
        const totalWeight = symbolWeights.reduce((acc, val) => acc + val.weight, 0);

        const pickSymbol = () => {
          let rand = Math.random() * totalWeight;
          for (let w of symbolWeights) {
            if (rand < w.weight) return w.sym;
            rand -= w.weight;
          }
          return 0;
        };

        if (forceWin) {
          // Force a winning combination — pick a common symbol (0-5) and place it in cols 1-3 at same row
          const forcedSym = Math.floor(Math.random() * 6); // 9 through A
          grid = Array.from({ length: numRows }, () => Array.from({ length: numCols }, () => pickSymbol()));
          // Stamp the forced symbol onto at least 3 consecutive columns in the middle row
          const forcedRow = 1;
          grid[forcedRow][0] = forcedSym;
          grid[forcedRow][1] = forcedSym;
          grid[forcedRow][2] = forcedSym;
          // 40% chance extend to 4 or 5 cols for bigger thrill
          if (Math.random() < 0.40) grid[forcedRow][3] = forcedSym;
          if (Math.random() < 0.20) grid[forcedRow][4] = forcedSym;
          // Reset streak
          userLossStreak.set(username, 0);
        } else {
          // Normal generation
          for (let r = 0; r < numRows; r++) {
            const row = [];
            for (let c = 0; c < numCols; c++) {
              // Wild chance: 6% col1, 15% col2-3, 12% col4, 8% col5 (much higher than before)
              let wildChance = 0.06;
              if (c === 1 || c === 2) wildChance = 0.15;
              else if (c === 3) wildChance = 0.12;
              else if (c === 4) wildChance = 0.08;

              if (Math.random() < wildChance) {
                row.push(10); // Wild
              } else {
                row.push(pickSymbol());
              }
            }
            grid.push(row);
          }
        }

        // 4. Check wins (243 ways system)
        let totalWinMult = 0;
        let winningSymbols = [];

        for (let targetSym = 0; targetSym < 10; targetSym++) {
          let consecutiveCols = 0;
          let ways = 1;

          for (let col = 0; col < numCols; col++) {
            let countInCol = 0;
            for (let row = 0; row < numRows; row++) {
              if (grid[row][col] === targetSym || grid[row][col] === 10) {
                countInCol++;
              }
            }
            if (countInCol > 0) {
              consecutiveCols++;
              ways *= countInCol;
            } else {
              break;
            }
          }

          if (consecutiveCols >= 3) {
            // Improved payout multipliers (more generous, like HDI)
            const payTable = {
              0: [0, 0, 8,  18,  35],  // 9
              1: [0, 0, 8,  18,  35],  // 10
              2: [0, 0, 10, 22,  50],  // J
              3: [0, 0, 10, 22,  50],  // Q
              4: [0, 0, 15, 35,  80],  // K
              5: [0, 0, 15, 35,  80],  // A
              6: [0, 0, 30, 70,  150], // Coin
              7: [0, 0, 50, 100, 300], // Turtle
              8: [0, 0, 75, 150, 600], // Ship
              9: [0, 0, 100,200, 1000] // Gold Bowl
            };

            const mult = payTable[targetSym][consecutiveCols - 1] * ways;
            totalWinMult += mult;
            winningSymbols.push(targetSym);
          }
        }

        // 5. Update loss streak
        if (totalWinMult === 0 && !forceWin) {
          userLossStreak.set(username, streak + 1);
        } else {
          userLossStreak.set(username, 0);
        }

        // 6. Calculate final win
        const baseBet = Math.max(1, Math.floor(betAmount / 50));
        let winAmount = baseBet * totalWinMult;

        let winType = 'normal';
        if (totalWinMult >= 200) winType = 'mega_win';
        else if (totalWinMult >= 80) winType = 'big_win';
        else if (totalWinMult >= 30) winType = 'win';

        user.coins += winAmount;
        await user.save();

        // 7. Send result
        socket.emit('spin_result', {
          grid,
          winAmount,
          totalWinMult,
          winningSymbols,
          newBalance: user.coins,
          winType
        });

      } catch (err) {
        console.error('Slot error:', err);
        socket.emit('spin_error', { message: 'Terjadi kesalahan server' });
      }
    });

    // =====================================================
    // ZEUS SLOT MACHINE (Gates of Olympus Style)
    // =====================================================
    // Symbols: 0=9, 1=10, 2=J, 3=Q, 4=K, 5=A, 6=Diamond, 7=Chalice, 8=Ring, 9=Lightning(Wild+Scatter)
    const zeusUserStreaks = new Map();

    socket.on('spin_zeus', async ({ username, betAmount, actualBet, anteBet, isFreeSpins, freeSpinMult, clientBalance }) => {
      try {
        let user = await User.findOne({ username });
        let betDeduction = actualBet || betAmount;
        
        // Guest / not-registered fallback: use client-provided balance
        let isGuestMode = false;
        let guestBalance = clientBalance || 6000000;
        if (!user) {
          isGuestMode = true;
          if (!isFreeSpins && guestBalance < betDeduction) {
            socket.emit('zeus_error', { message: 'Koin tidak cukup!' }); return;
          }
          if (!isFreeSpins) guestBalance -= betDeduction;
        } else {
          if (!isFreeSpins && user.coins < betDeduction) { socket.emit('zeus_error', { message: 'Koin tidak cukup!' }); return; }
          if (!isFreeSpins) user.coins -= betDeduction;
        }

        const ROWS = 5, COLS = 6;
        const symbolWeights = [
          { sym: 0, weight: 22 }, // Z
          { sym: 1, weight: 20 }, // Sigma
          { sym: 2, weight: 18 }, // Omega
          { sym: 3, weight: 16 }, // Psi
          { sym: 4, weight: 14 }, // A
          { sym: 5, weight: 12 }, // Crown
          { sym: 6, weight: 10 }, // Chalice
          { sym: 7, weight: 8  }, // Eagle
          { sym: 8, weight: 5  }, // Ship
          { sym: 9, weight: anteBet ? 4 : 2  }, // Lightning (Scatter)
        ];
        const totalW = symbolWeights.reduce((a, v) => a + v.weight, 0);
        const pickSym = () => {
          let r = Math.random() * totalW;
          for (const w of symbolWeights) { if (r < w.weight) return w.sym; r -= w.weight; }
          return 0;
        };

        // Force win mechanic (Pity)
        const streak = zeusUserStreaks.get(username) || 0;
        const forceWin = streak >= (20 + Math.floor(Math.random() * 15));

        // Generate initial grid
        let grid = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, pickSym));

        if (forceWin && !isFreeSpins) {
          // Inject 8+ of same common symbol
          const forcedSym = Math.floor(Math.random() * 6);
          const used = new Set();
          let placed = 0;
          while (placed < 8) {
            const r = Math.floor(Math.random() * ROWS);
            const c = Math.floor(Math.random() * COLS);
            const key = r * COLS + c;
            if (!used.has(key)) { used.add(key); grid[r][c] = forcedSym; placed++; }
          }
          zeusUserStreaks.set(username, 0);
        }

        // Cluster win checker (8+ of same symbol anywhere = win)
        const payTable = {
          0: [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.8, 1.2, 1.8, 3  ], // 9
          1: [0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.8, 1.2, 1.8, 3  ], // 10
          2: [0, 0, 0, 0, 0, 0, 0, 0, 0.8, 1.2, 1.8, 2.5, 4  ], // J
          3: [0, 0, 0, 0, 0, 0, 0, 0, 0.8, 1.2, 1.8, 2.5, 4  ], // Q
          4: [0, 0, 0, 0, 0, 0, 0, 0, 1.2, 2,   3,   5,   8  ], // K
          5: [0, 0, 0, 0, 0, 0, 0, 0, 1.2, 2,   3,   5,   8  ], // A
          6: [0, 0, 0, 0, 0, 0, 0, 0, 2.5, 4,   7,   12,  25 ], // Diamond
          7: [0, 0, 0, 0, 0, 0, 0, 0, 4,   7,   12,  20,  40 ], // Chalice
          8: [0, 0, 0, 0, 0, 0, 0, 0, 8,   15,  25,  50,  100], // Ring
        };

        const checkClusterWins = (g) => {
          const symCounts = {};
          const symPositions = {};
          const lightningPos = [];
          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              const s = g[r][c];
              if (s === null || s === undefined) continue;
              if (s === 9) { lightningPos.push([r, c]); continue; } // Lightning counted separately
              if (!symCounts[s]) { symCounts[s] = 0; symPositions[s] = []; }
              symCounts[s]++;
              symPositions[s].push([r, c]);
            }
          }
          const lightningCount = lightningPos.length;
          const wins = [];
          for (let sym = 0; sym <= 8; sym++) {
            const totalCount = symCounts[sym] || 0;
            if (totalCount >= 8) {
              const cap = Math.min(totalCount, 12);
              const mult = payTable[sym][cap] || 0;
              if (mult > 0) {
                wins.push({
                  sym,
                  count: cap,
                  mult,
                  positions: [...(symPositions[sym] || [])]
                });
              }
            }
          }
          // Check scatter (lightning) regardless of wins
          if (lightningCount >= 4) {
            wins.push({ sym: 9, count: lightningCount, mult: 0, positions: lightningPos, isScatter: true });
          }
          return wins;
        };

        let totalWinAmount = 0;
        let tumbleCount = 0;
        let allWinPositions = [];
        let clusterWins = [];
        let gridHistory = [JSON.parse(JSON.stringify(grid))];
        let scatterTriggered = false;
        let scatterCount = 0;
        let currentGrid = JSON.parse(JSON.stringify(grid));

        for (let t = 0; t < 10; t++) {
          const wins = checkClusterWins(currentGrid);
          if (wins.length === 0) break;

          // Process wins
          const winningPositions = new Set();
          wins.forEach(w => {
            if (w.isScatter) { scatterTriggered = true; scatterCount = w.count; return; }
            const multiplier = isFreeSpins ? (freeSpinMult || 1) : 1;
            const baseBet = Math.max(1, Math.floor(betAmount / 20));
            const winVal = Math.floor(baseBet * w.mult * multiplier);
            totalWinAmount += winVal;
            clusterWins.push({ sym: w.sym, count: w.count, winAmount: winVal, tumble: t });
            w.positions.forEach(([r, c]) => {
              winningPositions.add(`${r},${c}`);
              allWinPositions.push([r, c, w.sym, t]);
            });
          });

          if (winningPositions.size === 0) break;
          tumbleCount++;

          // Remove winning symbols (set to null = "empty")
          winningPositions.forEach(key => {
            const [r, c] = key.split(',').map(Number);
            currentGrid[r][c] = null;
          });

          // Push the exploded state so frontend can show empty spaces/explosions
          gridHistory.push(JSON.parse(JSON.stringify(currentGrid)));

          // Gravity: drop symbols down
          for (let c = 0; c < COLS; c++) {
            const existing = [];
            for (let r = ROWS - 1; r >= 0; r--) {
              if (currentGrid[r][c] !== null && currentGrid[r][c] !== undefined) existing.push(currentGrid[r][c]);
            }
            while (existing.length < ROWS) existing.push(pickSym());
            for (let r = 0; r < ROWS; r++) currentGrid[r][c] = existing[ROWS - 1 - r];
          }
          gridHistory.push(JSON.parse(JSON.stringify(currentGrid)));
        }

        // Update streak
        if (totalWinAmount === 0 && !forceWin) zeusUserStreaks.set(username, streak + 1);
        else if (totalWinAmount > 0) zeusUserStreaks.set(username, 0);

        const freeSpinsAwarded = !isFreeSpins && scatterTriggered ? 10 + (scatterCount - 4) * 2 : 0;

        // Random multiplier zeus drops during free spins
        const multOptions = [2, 3, 5, 8, 10, 15, 25, 50, 100, 500];
        const randomMult = (isFreeSpins && Math.random() < 0.4)
          ? multOptions[Math.floor(Math.random() * multOptions.length)]
          : null;

        user && (user.coins += Math.floor(totalWinAmount));
        if (!isGuestMode && user) await user.save();
        const newBalance = isGuestMode
          ? guestBalance + Math.floor(totalWinAmount)
          : user.coins;

        socket.emit('zeus_result', {
          grid: gridHistory[0],
          finalGrid: currentGrid,
          gridHistory,
          totalWinAmount: Math.floor(totalWinAmount),
          clusterWins,
          tumbleCount,
          allWinPositions,
          newBalance,
          triggerFreeSpins: freeSpinsAwarded > 0,
          freeSpinsAwarded,
          scatterCount,
          randomMult,
          winType: totalWinAmount > betAmount * 100 ? 'mega_win' : totalWinAmount > betAmount * 30 ? 'big_win' : totalWinAmount > 0 ? 'win' : 'normal'
        });

      } catch (err) {
        console.error('Zeus error:', err);
        socket.emit('zeus_error', { message: 'Terjadi kesalahan server' });
      }

    });

    // =====================================================
    // FAFAFA 2 SLOT LOGIC
    // =====================================================
    socket.on('spin_fafafa', async ({ username, betAmount, isFreeSpins, clientBalance }) => {
      try {
        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 6000000;

        if (!user) {
          isGuestMode = true;
          if (guestBalance < betAmount && !isFreeSpins) {
            return socket.emit('fafafa_error', { message: 'Koin tidak cukup' });
          }
        } else {
          if (user.coins < betAmount && !isFreeSpins) {
            return socket.emit('fafafa_error', { message: 'Koin tidak cukup' });
          }
        }

        if (!isFreeSpins) {
          if (user) user.coins -= betAmount;
          else guestBalance -= betAmount;
        }

        // Generate 5x3 grid
        // Weights: 0: Wild Red, 1: Wild Blue, 2: Scatter, 3-10: Regular
        const weights = [
          { sym: 0, weight: 1 },   // Wild Red
          { sym: 1, weight: 1 },   // Wild Blue
          { sym: 2, weight: 2 },   // Scatter
          { sym: 3, weight: 4 },   // Red GP
          { sym: 4, weight: 6 },   // Blue GP
          { sym: 5, weight: 8 },   // Boy
          { sym: 6, weight: 10 },  // Girl
          { sym: 7, weight: 15 },  // Drum
          { sym: 8, weight: 20 },  // Jade
          { sym: 9, weight: 25 },  // Firecracker
          { sym: 10, weight: 30 }  // Coin
        ];
        
        const totalWeight = weights.reduce((acc, curr) => acc + curr.weight, 0);
        const pickSym = () => {
          let r = Math.random() * totalWeight;
          for (let w of weights) {
            r -= w.weight;
            if (r <= 0) return w.sym;
          }
          return 10;
        };

        const ROWS = 3, COLS = 5;
        const grid = [];
        let scatterCount = 0;
        for (let r = 0; r < ROWS; r++) {
          const row = [];
          for (let c = 0; c < COLS; c++) {
            const sym = pickSym();
            if (sym === 2) scatterCount++;
            row.push(sym);
          }
          grid.push(row);
        }

        const LINES = [
          [1,1,1,1,1], // 1 (Middle)
          [0,0,0,0,0], // 2 (Top)
          [2,2,2,2,2], // 3 (Bottom)
          [0,1,2,1,0], // 4 (V)
          [2,1,0,1,2], // 5 (Inv V)
          [0,0,1,2,2], // 6
          [2,2,1,0,0], // 7
          [1,2,2,2,1], // 8
          [1,0,0,0,1], // 9
        ];

        const PAYTABLE = {
          0: { 5: 5000, 4: 1000, 3: 200 }, // Wild Red
          1: { 5: 5000, 4: 1000, 3: 200 }, // Wild Blue
          3: { 5: 1000, 4: 200, 3: 50 },
          4: { 5: 400,  4: 80,  3: 20 },
          5: { 5: 200,  4: 40,  3: 15 },
          6: { 5: 160,  4: 30,  3: 10 },
          7: { 5: 100,  4: 20,  3: 7 },
          8: { 5: 60,   4: 15,  3: 5 },
          9: { 5: 40,   4: 10,  3: 3 },
          10: { 5: 20,  4: 5,   3: 2 },
        };

        const FB_MULTS = {
          0: 5000, 1: 5000, 3: 2500, 4: 1000, 5: 500, 6: 400, 7: 250, 8: 150, 9: 100, 10: 50
        };

        // Check full board (Bonus Satu Papan)
        let isFullBoard = false;
        let fbSym = -1;
        let firstNonWild = -1;
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            const s = grid[r][c];
            if (s !== 0 && s !== 1 && s !== 2) {
              firstNonWild = s; break;
            }
          }
          if (firstNonWild !== -1) break;
        }
        
        let allMatch = true;
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            const s = grid[r][c];
            if (s === 2) { allMatch = false; break; } // Scatter ruins FB
            if (firstNonWild !== -1 && s !== 0 && s !== 1 && s !== firstNonWild) { allMatch = false; break; }
          }
          if (!allMatch) break;
        }

        let totalWinAmount = 0;
        let winningLines = [];

        const baseBet = Math.max(1, Math.floor(betAmount / 9)); // Bet per line

        if (allMatch && scatterCount === 0) {
          isFullBoard = true;
          fbSym = firstNonWild !== -1 ? firstNonWild : 0;
          totalWinAmount = betAmount * (FB_MULTS[fbSym] || 0); // Full board multiplier is usually times total bet
          // Add all 9 lines as winning
          for (let i = 0; i < 9; i++) {
             winningLines.push({ lineIdx: i, sym: fbSym, count: 5, win: (FB_MULTS[fbSym] || 0) * baseBet, path: LINES[i] });
          }
        } else {
          // Regular line check
          for (let i = 0; i < LINES.length; i++) {
            const line = LINES[i];
            let matchSym = -1;
            let count = 0;
            for (let c = 0; c < COLS; c++) {
              const r = line[c];
              const s = grid[r][c];
              if (s === 2) break; // Scatter breaks line
              if (matchSym === -1) {
                if (s !== 0 && s !== 1) matchSym = s;
                count++;
              } else {
                if (s === matchSym || s === 0 || s === 1) count++;
                else break;
              }
            }
            if (matchSym === -1 && count > 0) matchSym = 0; // All wilds
            if (count >= 3) {
              const pt = PAYTABLE[matchSym];
              if (pt && pt[count]) {
                const win = baseBet * pt[count];
                totalWinAmount += win;
                winningLines.push({ lineIdx: i, sym: matchSym, count, win, path: line });
              }
            }
          }
        }

        let freeSpinsAwarded = 0;
        if (scatterCount === 5) freeSpinsAwarded = 50;
        else if (scatterCount === 4) freeSpinsAwarded = 20;
        else if (scatterCount === 3) freeSpinsAwarded = 10;

        user && (user.coins += Math.floor(totalWinAmount));
        if (!isGuestMode && user) await user.save();
        
        const newBalance = isGuestMode ? guestBalance + Math.floor(totalWinAmount) : user.coins;

        socket.emit('fafafa_result', {
          grid,
          totalWinAmount: Math.floor(totalWinAmount),
          winningLines,
          isFullBoard,
          fbSym,
          triggerFreeSpins: freeSpinsAwarded > 0,
          freeSpinsAwarded,
          scatterCount,
          newBalance
        });

      } catch (err) {
        console.error('Fafafa error:', err);
        socket.emit('fafafa_error', { message: 'Terjadi kesalahan server' });
      }
    });

    // =====================================================
    // 5 LIONS MEGAWAYS (五獅 MEGAWAYS) SLOT LOGIC
    // =====================================================
    socket.on('spin_fivelions', async ({ username, betAmount, isFreeSpins, clientBalance }) => {
      try {
        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 6000000;

        if (!user) {
          isGuestMode = true;
          if (guestBalance < betAmount && !isFreeSpins) {
            return socket.emit('fivelions_error', { message: 'Koin tidak cukup' });
          }
        } else {
          if (user.coins < betAmount && !isFreeSpins) {
            return socket.emit('fivelions_error', { message: 'Koin tidak cukup' });
          }
        }

        if (!isFreeSpins) {
          if (user) user.coins -= betAmount;
          else guestBalance -= betAmount;
        }

        // Generate 6x3 grid
        const grid = [];
        let scatterCount = 0;
        for (let r = 0; r < 3; r++) {
          const row = [];
          for (let c = 0; c < 6; c++) {
            const sym = Math.floor(Math.random() * 12);
            if (sym === 6) scatterCount++;
            row.push(sym);
          }
          grid.push(row);
        }

        // Calculate win amount
        const isWin = Math.random() > 0.45;
        let totalWinAmount = isWin ? Math.floor(betAmount * (1.5 + Math.random() * 5)) : 0;

        if (user) user.coins += totalWinAmount;
        if (!isGuestMode && user) await user.save();

        const newBalance = isGuestMode ? guestBalance + totalWinAmount : user.coins;

        socket.emit('fivelions_result', {
          grid,
          totalWinAmount,
          triggerFreeSpins: scatterCount >= 3,
          scatterCount,
          newBalance
        });
      } catch (err) {
        console.error('5 Lions error:', err);
        socket.emit('fivelions_error', { message: 'Terjadi kesalahan server' });
      }
    });

    // =====================================================
    // JIN JI BAO XI (金雞報喜) SLOT LOGIC (243 WAYS & JACKPOT)
    // =====================================================
    socket.on('spin_jinji', async ({ username, betAmount, isFreeSpins, clientBalance }) => {
      try {
        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 6000000;

        if (!user) {
          isGuestMode = true;
          if (guestBalance < betAmount && !isFreeSpins) {
            return socket.emit('jinji_error', { message: 'Koin tidak cukup' });
          }
        } else {
          if (user.coins < betAmount && !isFreeSpins) {
            return socket.emit('jinji_error', { message: 'Koin tidak cukup' });
          }
        }

        if (!isFreeSpins) {
          if (user) user.coins -= betAmount;
          else guestBalance -= betAmount;
        }

        // Weighted symbol picker (ONLY symbols 0-7 from user-provided images)
        const weights = [
          { sym: 0, weight: 3 },   // Dragon (Naga)
          { sym: 1, weight: 4 },   // Phoenix (Burung Hong)
          { sym: 2, weight: 5 },   // Tiger (Macan)
          { sym: 3, weight: 6 },   // Turtle (Penyu)
          { sym: 4, weight: 8 },   // Carp (Ikan Emas)
          { sym: 5, weight: 15 },  // A
          { sym: 6, weight: 18 },  // K
          { sym: 7, weight: 20 },  // Q
        ];
        
        const totalWeight = weights.reduce((acc, curr) => acc + curr.weight, 0);
        const pickSym = () => {
          let r = Math.random() * totalWeight;
          for (let w of weights) {
            r -= w.weight;
            if (r <= 0) return w.sym;
          }
          return 5;
        };

        const ROWS = 3, COLS = 5;
        const grid = [];

        for (let r = 0; r < ROWS; r++) {
          const row = [];
          for (let c = 0; c < COLS; c++) {
            row.push(pickSym());
          }
          grid.push(row);
        }

        // 243 WAYS PAYTABLE (multiplier per way)
        const PAYTABLE = {
          0: { 5: 1000, 4: 200, 3: 50 }, // Dragon
          1: { 5: 600,  4: 150, 3: 40 }, // Phoenix
          2: { 5: 400,  4: 100, 3: 30 }, // Tiger
          3: { 5: 200,  4: 50,  3: 20 }, // Turtle
          4: { 5: 100,  4: 30,  3: 10 }, // Carp
          5: { 5: 50,   4: 15,  3: 5 },  // A
          6: { 5: 40,   4: 10,  3: 4 },  // K
          7: { 5: 30,   4: 8,   3: 3 },  // Q
        };

        let totalWinAmount = 0;
        const winningSymbols = [];
        const baseBetUnit = Math.max(1, Math.floor(betAmount / 88));

        // Calculate 243 Ways for each symbol (0 to 7)
        for (let targetSym = 0; targetSym <= 7; targetSym++) {
          let ways = 1;
          let consecutiveCols = 0;

          for (let c = 0; c < COLS; c++) {
            let countInCol = 0;
            for (let r = 0; r < ROWS; r++) {
              const cellSym = grid[r][c];
              if (cellSym === targetSym) {
                countInCol++;
              }
            }

            if (countInCol > 0) {
              ways *= countInCol;
              consecutiveCols++;
            } else {
              break;
            }
          }

          if (consecutiveCols >= 3) {
            const mult = PAYTABLE[targetSym]?.[consecutiveCols] || 0;
            if (mult > 0) {
              const win = ways * mult * baseBetUnit;
              totalWinAmount += win;
              winningSymbols.push(targetSym);
            }
          }
        }

        // Jackpot trigger chance (random 2% chance on spin)
        let triggerJackpot = false;
        let jackpotType = 'MINI';
        let jackpotWinAmount = 0;

        if (Math.random() < 0.02) {
          triggerJackpot = true;
          const jpRand = Math.random();
          if (jpRand < 0.05) { jackpotType = 'GRAND'; jackpotWinAmount = betAmount * 5000; }
          else if (jpRand < 0.2) { jackpotType = 'MAJOR'; jackpotWinAmount = betAmount * 1000; }
          else if (jpRand < 0.5) { jackpotType = 'MINOR'; jackpotWinAmount = betAmount * 300; }
          else { jackpotType = 'MINI'; jackpotWinAmount = betAmount * 100; }
          totalWinAmount += jackpotWinAmount;
        }

        // Free Spins Trigger (random 2.5% chance or big Dragon hit)
        let triggerFreeSpins = Math.random() < 0.025;
        let freeSpinsAwarded = triggerFreeSpins ? 8 : 0;

        user && (user.coins += Math.floor(totalWinAmount));
        if (!isGuestMode && user) await user.save();

        const newBalance = isGuestMode ? guestBalance + Math.floor(totalWinAmount) : user.coins;

        socket.emit('jinji_result', {
          grid,
          winAmount: Math.floor(totalWinAmount),
          winningSymbols,
          triggerJackpot,
          jackpotType,
          jackpotWinAmount,
          triggerFreeSpins,
          freeSpinsAwarded,
          newBalance,
          winType: totalWinAmount > betAmount * 100 ? 'mega_win' : totalWinAmount > betAmount * 30 ? 'big_win' : totalWinAmount > 0 ? 'win' : 'normal'
        });

      } catch (err) {
        console.error('Jin Ji Bao Xi error:', err);
        socket.emit('jinji_error', { message: 'Terjadi kesalahan server' });
      }
    });

    // =====================================================
    // MAHJONG WAYS 2 SLOT LOGIC (CASCADING & GOLD WILDS)
    // =====================================================
    socket.on('spin_mahjong', async ({ username, betAmount, isFreeSpins, clientBalance }) => {
      try {
        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 6000000;

        if (!user) {
          isGuestMode = true;
          if (guestBalance < betAmount && !isFreeSpins) {
            return socket.emit('mahjong_error', { message: 'Koin tidak cukup' });
          }
        } else {
          if (user.coins < betAmount && !isFreeSpins) {
            return socket.emit('mahjong_error', { message: 'Koin tidak cukup' });
          }
        }

        if (!isFreeSpins) {
          if (user) user.coins -= betAmount;
          else guestBalance -= betAmount;
        }

        // Weighted symbol picker for Mahjong 2
        const weights = [
          { sym: 0, weight: 4 },  // Green Dragon
          { sym: 1, weight: 5 },  // Red Dragon
          { sym: 2, weight: 6 },  // Blue Dragon
          { sym: 3, weight: 12 }, // 8 Bam
          { sym: 4, weight: 14 }, // 8 Dot
          { sym: 5, weight: 15 }, // 8 Wan
          { sym: 6, weight: 18 }, // 5 Bam
          { sym: 7, weight: 20 }, // 5 Dot
          { sym: 8, weight: 4 },  // Wild Ingot
          { sym: 9, weight: 5 }   // Scatter Ingot
        ];
        
        const totalWeight = weights.reduce((acc, curr) => acc + curr.weight, 0);
        const pickSym = () => {
          let r = Math.random() * totalWeight;
          for (let w of weights) {
            r -= w.weight;
            if (r <= 0) return w.sym;
          }
          return 3;
        };

        const ROWS = 4, COLS = 5;
        let currentGrid = [];
        let currentGoldGrid = [];
        let scatterCount = 0;

        for (let r = 0; r < ROWS; r++) {
          const row = [];
          const gRow = [];
          for (let c = 0; c < COLS; c++) {
            const sym = pickSym();
            if (sym === 9) scatterCount++;
            row.push(sym);
            // 20% chance for regular symbol on col 1,2,3 to be gold-plated
            gRow.push(sym < 8 && c >= 1 && c <= 3 && Math.random() < 0.25);
          }
          currentGrid.push(row);
          currentGoldGrid.push(gRow);
        }

        const initialGrid = currentGrid.map(r => [...r]);
        const initialGoldGrid = currentGoldGrid.map(r => [...r]);

        // Paytable multipliers
        const PAYTABLE = {
          0: { 5: 500, 4: 100, 3: 30 }, // Green Dragon
          1: { 5: 300, 4: 80,  3: 25 }, // Red Dragon
          2: { 5: 200, 4: 60,  3: 20 }, // Blue Dragon
          3: { 5: 100, 4: 30,  3: 10 }, // 8 Bam
          4: { 5: 100, 4: 30,  3: 10 }, // 8 Dot
          5: { 5: 80,  4: 20,  3: 8 },  // 8 Wan
          6: { 5: 60,  4: 15,  3: 5 },  // 5 Bam
          7: { 5: 40,  4: 10,  3: 3 },  // 5 Dot
        };

        const multSteps = isFreeSpins ? [2, 4, 6, 10] : [1, 2, 3, 5];
        let totalWinAmount = 0;
        const gridHistory = [];

        // Save step 0
        gridHistory.push({
          grid: currentGrid.map(r => [...r]),
          goldGrid: currentGoldGrid.map(r => [...r]),
          winPositions: [],
          stepWin: 0
        });

        const baseBetUnit = Math.max(1, Math.floor(betAmount / 20));

        // Tumble / Cascade Engine Loop
        for (let step = 0; step < 4; step++) {
          const stepMult = multSteps[Math.min(step, multSteps.length - 1)];
          let stepWin = 0;
          const winPositionsSet = new Set();

          for (let targetSym = 0; targetSym <= 7; targetSym++) {
            let ways = 1;
            let consecutiveCols = 0;
            const tempPositionsPerCol = [];

            for (let c = 0; c < COLS; c++) {
              const colPos = [];
              for (let r = 0; r < ROWS; r++) {
                const cellSym = currentGrid[r][c];
                if (cellSym === targetSym || cellSym === 8) { // 8 is Wild
                  colPos.push(`${r}-${c}`);
                }
              }

              if (colPos.length > 0) {
                ways *= colPos.length;
                consecutiveCols++;
                tempPositionsPerCol.push(colPos);
              } else {
                break;
              }
            }

            if (consecutiveCols >= 3) {
              const mult = PAYTABLE[targetSym]?.[consecutiveCols] || 0;
              if (mult > 0) {
                stepWin += ways * mult * baseBetUnit * stepMult;
                tempPositionsPerCol.forEach(colArr => colArr.forEach(pos => winPositionsSet.add(pos)));
              }
            }
          }

          if (stepWin > 0) {
            totalWinAmount += stepWin;
            const winPositions = Array.from(winPositionsSet);

            // Record tumble result
            gridHistory.push({
              grid: currentGrid.map(r => [...r]),
              goldGrid: currentGoldGrid.map(r => [...r]),
              winPositions,
              stepWin
            });

            // Perform Cascade: Remove winning tiles, transform gold tiles to WILD (8)
            const nextGrid = currentGrid.map(r => [...r]);
            const nextGold = currentGoldGrid.map(r => [...r]);

            for (let c = 0; c < COLS; c++) {
              let writeRow = ROWS - 1;
              for (let r = ROWS - 1; r >= 0; r--) {
                const posKey = `${r}-${c}`;
                if (winPositionsSet.has(posKey)) {
                  // Check if this was a gold-plated tile -> transforms to WILD on next tumble
                  if (currentGoldGrid[r][c]) {
                    nextGrid[writeRow][c] = 8; // WILD
                    nextGold[writeRow][c] = false;
                    writeRow--;
                  }
                  // else position is cleared
                } else {
                  nextGrid[writeRow][c] = currentGrid[r][c];
                  nextGold[writeRow][c] = currentGoldGrid[r][c];
                  writeRow--;
                }
              }

              // Fill top empty cells with new symbols
              while (writeRow >= 0) {
                nextGrid[writeRow][c] = pickSym();
                nextGold[writeRow][c] = false;
                writeRow--;
              }
            }

            currentGrid = nextGrid;
            currentGoldGrid = nextGold;
          } else {
            break; // No wins in this tumble step
          }
        }

        // Free Spins Trigger (3+ Scatters)
        let triggerFreeSpins = scatterCount >= 3;
        let freeSpinsAwarded = triggerFreeSpins ? 10 : 0;

        user && (user.coins += Math.floor(totalWinAmount));
        if (!isGuestMode && user) await user.save();

        const newBalance = isGuestMode ? guestBalance + Math.floor(totalWinAmount) : user.coins;

        socket.emit('mahjong_result', {
          initialGrid,
          initialGoldGrid,
          gridHistory,
          totalWinAmount: Math.floor(totalWinAmount),
          triggerFreeSpins,
          freeSpinsAwarded,
          newBalance,
          winType: totalWinAmount > betAmount * 100 ? 'mega_win' : totalWinAmount > betAmount * 30 ? 'big_win' : totalWinAmount > 0 ? 'win' : 'normal'
        });

      } catch (err) {
        console.error('Mahjong Ways 2 error:', err);
        socket.emit('mahjong_error', { message: 'Terjadi kesalahan server' });
      }
    });



    // =====================================================
    // WILD WEST GOLD - 5x4 40 PAYLINES + STICKY WILD MULTIPLIERS
    // =====================================================
    socket.on('spin_wildwest', async ({ username, betAmount, isFreeSpins, stickyWilds = [], clientBalance }) => {
      try {
        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 6000000;

        if (!user) {
          isGuestMode = true;
          if (guestBalance < betAmount && !isFreeSpins) return socket.emit('wildwest_error', { message: 'Koin tidak cukup' });
        } else {
          if (user.coins < betAmount && !isFreeSpins) return socket.emit('wildwest_error', { message: 'Koin tidak cukup' });
        }
        if (!isFreeSpins) { if (user) user.coins -= betAmount; else guestBalance -= betAmount; }

        const ROWS = 4, COLS = 5;
        const betUnit = Math.max(1, Math.floor(betAmount / 40));

        // sym 0=sheriff 1=outlaw 2=cowgirl 3=lady 4=gold 5=holster 6=A 7=K 8=Q 9=J 10=10 11=scatter 12=wild
        const WTS = [2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 4, 4];
        const TWS = WTS.reduce((a, b) => a + b, 0);

        const pick = (col) => {
          let r = Math.random() * TWS;
          for (let i = 0; i < WTS.length; i++) {
            // Wild (12) only on cols 1,2,3 (reels 2,3,4)
            if (i === 12 && (col === 0 || col === 4)) continue;
            // Scatter (11) only on cols 0,2,4 (reels 1,3,5)
            if (i === 11 && (col === 1 || col === 3)) continue;
            r -= WTS[i];
            if (r <= 0) return i;
          }
          return 6;
        };

        const MULT_VALS = [2, 3, 5];
        const randMult = () => MULT_VALS[Math.floor(Math.random() * MULT_VALS.length)];

        // Generate 5x4 grid
        let initialGrid = [];
        let initialWildMultGrid = [];
        let scatterCount = 0;
        let currentStickyMap = new Map();
        if (isFreeSpins && Array.isArray(stickyWilds)) {
          stickyWilds.forEach(w => currentStickyMap.set(`${w.r}-${w.c}`, w.mult));
        }

        for (let r = 0; r < ROWS; r++) {
          const row = [], mRow = [];
          for (let c = 0; c < COLS; c++) {
            const key = `${r}-${c}`;
            if (isFreeSpins && currentStickyMap.has(key)) {
              row.push(12);
              mRow.push(currentStickyMap.get(key));
            } else {
              const s = pick(c);
              if (s === 11) scatterCount++;
              row.push(s);
              mRow.push(s === 12 ? randMult() : 0);
            }
          }
          initialGrid.push(row);
          initialWildMultGrid.push(mRow);
        }

        // 40 Paylines payouts for 3, 4, 5 of a kind matching exact Wild West Gold rules
        const PAYTABLE = {
          0: { 3: 60, 4: 200, 5: 800 },  // Sheriff: 1.5x, 5x, 20x
          1: { 3: 50, 4: 150, 5: 500 },  // Outlaw: 1.25x, 3.75x, 12.5x
          2: { 3: 30, 4: 80,  5: 300 },  // Cowgirl: 0.75x, 2x, 7.5x
          3: { 3: 20, 4: 50,  5: 200 },  // Saloon Lady: 0.5x, 1.25x, 5x
          4: { 3: 14, 4: 30,  5: 150 },  // Gold Sacks: 0.35x, 0.75x, 3.75x
          5: { 3: 10, 4: 20,  5: 100 },  // Gun Holster: 0.25x, 0.5x, 2.5x
          6: { 3: 6,  4: 12,  5: 60  },  // A: 0.15x, 0.3x, 1.5x
          7: { 3: 6,  4: 12,  5: 60  },  // K: 0.15x, 0.3x, 1.5x
          8: { 3: 4,  4: 10,  5: 40  },  // Q: 0.1x, 0.25x, 1x
          9: { 3: 4,  4: 10,  5: 40  },  // J: 0.1x, 0.25x, 1x
          10: { 3: 4, 4: 10,  5: 40  },  // 10: 0.1x, 0.25x, 1x
        };

        const PAYLINES = [
          [1,1,1,1,1], [2,2,2,2,2], [0,0,0,0,0], [3,3,3,3,3],
          [0,1,2,1,0], [3,2,1,2,3], [1,0,0,0,1], [2,3,3,3,2],
          [1,2,3,2,1], [2,1,0,1,2], [0,0,1,2,3], [3,3,2,1,0],
          [1,1,0,1,1], [2,2,3,2,2], [0,1,1,1,0], [3,2,2,2,3],
          [1,0,1,0,1], [2,3,2,3,2], [0,2,0,2,0], [3,1,3,1,3],
          [2,1,2,1,2], [1,2,1,2,1], [1,0,2,0,1], [2,3,1,3,2],
          [0,1,0,1,0], [3,2,3,2,3], [2,0,2,0,2], [1,3,1,3,1],
          [0,3,0,3,0], [3,0,3,0,3], [1,3,2,0,1], [2,0,1,3,2],
          [0,2,3,2,0], [3,1,0,1,3], [0,3,3,3,0], [3,0,0,0,3],
          [1,0,3,0,1], [2,3,0,3,2], [2,0,0,0,2], [1,3,3,3,1]
        ];

        let totalWinAmount = 0;
        const winningCells = new Set();
        const newStickyWilds = [];

        // Check paylines
        for (const line of PAYLINES) {
          let lineSym = null;
          let matchCount = 0;
          let lineMult = 1;

          for (let c = 0; c < COLS; c++) {
            const r = line[c];
            const sym = initialGrid[r][c];

            if (sym === 12) {
              // Wild substitute
              matchCount++;
              const mult = initialWildMultGrid[r][c] || 1;
              lineMult *= mult;
            } else if (sym !== 11) {
              if (lineSym === null) {
                lineSym = sym;
                matchCount++;
              } else if (sym === lineSym) {
                matchCount++;
              } else {
                break;
              }
            } else {
              break;
            }
          }

          if (lineSym !== null && matchCount >= 3 && PAYTABLE[lineSym]?.[matchCount]) {
            const basePay = PAYTABLE[lineSym][matchCount] * betUnit;
            const lineWin = basePay * lineMult;
            totalWinAmount += lineWin;
            for (let c = 0; c < matchCount; c++) {
              winningCells.add(`${line[c]}-${c}`);
            }
          }
        }

        // Collect sticky wilds if in free spins or new wild landed during free spins
        if (isFreeSpins || scatterCount >= 3) {
          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              if (initialGrid[r][c] === 12) {
                newStickyWilds.push({ r, c, mult: initialWildMultGrid[r][c] || 2 });
              }
            }
          }
        }

        const triggerFreeSpins = scatterCount >= 3;
        const freeSpinsAwarded = triggerFreeSpins ? 8 : 0;

        if (user) user.coins += Math.floor(totalWinAmount);
        if (!isGuestMode && user) await user.save();
        const newBalance = isGuestMode ? guestBalance + Math.floor(totalWinAmount) : user.coins;

        socket.emit('wildwest_result', {
          initialGrid,
          initialWildMultGrid,
          winningCells: Array.from(winningCells),
          totalWinAmount: Math.floor(totalWinAmount),
          triggerFreeSpins,
          freeSpinsAwarded,
          newStickyWilds,
          newBalance,
          winType: totalWinAmount > betAmount * 50 ? 'mega_win' : totalWinAmount > betAmount * 15 ? 'big_win' : totalWinAmount > 0 ? 'win' : 'normal'
        });

      } catch (err) {
        console.error('Wild West error:', err);
        socket.emit('wildwest_error', { message: 'Server error' });
      }
    });

    // =====================================================
    // CANDY RUSH - 6x5 COUNT-BASED + TUMBLE + BOMB MULTIPLIER
    // =====================================================
    socket.on('spin_candy', async ({ username, betAmount, isFreeSpins, anteMode, clientBalance }) => {
      try {
        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 6000000;

        if (!user) {
          isGuestMode = true;
          if (guestBalance < betAmount && !isFreeSpins) return socket.emit('candy_error', { message: 'Koin tidak cukup' });
        } else {
          if (user.coins < betAmount && !isFreeSpins) return socket.emit('candy_error', { message: 'Koin tidak cukup' });
        }
        if (!isFreeSpins) { if (user) user.coins -= betAmount; else guestBalance -= betAmount; }

        const ROWS = 5, COLS = 6;
        const betUnit = Math.max(1, Math.floor(betAmount / 100));
        // sym 0=lollipop 1=cane 2=gummy 3=gold 4=pink 5=green 6=blue 7=purple 8=red 9=scatter 10=bomb
        const WTS = [1, 2, 3, 5, 6, 7, 8, 9, 10, 3, 2];
        const TWS = WTS.reduce((a, b) => a + b, 0);
        const pick = (ab) => {
          let r = Math.random() * TWS;
          for (let i = 0; i < WTS.length; i++) {
            let w = WTS[i]; if (ab && i === 9) w *= 2;
            r -= w; if (r <= 0) return i;
          }
          return 4;
        };
        const PT = {
          0: { 5: 1, 8: 10, 12: 50,  20: 250, 30: 500 },
          1: { 5: 1, 8: 5,  12: 25,  20: 100, 30: 250 },
          2: { 5: 1, 8: 3,  12: 15,  20: 60,  30: 150 },
          3: { 5: 1, 8: 2,  12: 10,  20: 40,  30: 100 },
          4: { 5: 1, 8: 2,  12: 8,   20: 25,  30: 80  },
          5: { 5: 1, 8: 2,  12: 5,   20: 20,  30: 50  },
          6: { 5: 1, 8: 1,  12: 3,   20: 15,  30: 30  },
          7: { 5: 1, 8: 1,  12: 2,   20: 12,  30: 20  },
          8: { 5: 1, 8: 1,  12: 1,   20: 8,   30: 10  },
        };
        const SP = { 4: 3, 5: 5, 6: 100 };
        const gcp = (s, cnt) => {
          if (!PT[s]) return 0; let p = 0;
          for (const t of Object.keys(PT[s]).map(Number).sort((a, b) => a - b)) if (cnt >= t) p = PT[s][t];
          return p;
        };
        const MV = [2, 3, 5, 8, 10, 15, 25, 50, 100, 500];
        const rm = () => MV[Math.floor(Math.random() * MV.length)];

        let cg = [], cmg = [], scatterCount = 0;
        for (let r = 0; r < ROWS; r++) {
          const row = [], mr = [];
          for (let c = 0; c < COLS; c++) {
            const s = pick(anteMode);
            if (s === 9) scatterCount++;
            row.push(s); mr.push(s === 10 ? rm() : 0);
          }
          cg.push(row); cmg.push(mr);
        }
        const ig = cg.map(r => [...r]), imr = cmg.map(r => [...r]);
        let totalWin = 0; const tumbleSteps = [];

        for (let t = 0; t < 10; t++) {
          const sc2 = {}, sp2 = {}; let totalMult = 0; const mp = [];
          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              const s = cg[r][c];
              if (s === 10) { totalMult += cmg[r][c]; mp.push(r + '-' + c); }
              else if (s !== 9) { sc2[s] = (sc2[s] || 0) + 1; if (!sp2[s]) sp2[s] = []; sp2[s].push(r + '-' + c); }
            }
          }
          let sw = 0; const wp = new Set();
          for (const [ss, cnt] of Object.entries(sc2)) {
            const pm = gcp(parseInt(ss), cnt);
            if (pm > 0) { sw += pm * betUnit; sp2[ss].forEach(p => wp.add(p)); }
          }
          if (sw <= 0) break;
          const fm = Math.max(1, totalMult); sw *= fm; totalWin += sw;
          const ar = new Set([...wp, ...mp]);
          const ng = cg.map(r => [...r]), nm = cmg.map(r => [...r]);
          for (let c = 0; c < COLS; c++) {
            let wr = ROWS - 1;
            for (let r = ROWS - 1; r >= 0; r--) if (!ar.has(r + '-' + c)) { ng[wr][c] = cg[r][c]; nm[wr][c] = cmg[r][c]; wr--; }
            while (wr >= 0) { const ns = pick(anteMode); ng[wr][c] = ns; nm[wr][c] = ns === 10 ? rm() : 0; wr--; }
          }
          tumbleSteps.push({ winPositions: Array.from(ar), stepWin: sw, multiplierValue: fm, newGrid: ng.map(r => [...r]), newMultGrid: nm.map(r => [...r]) });
          cg = ng; cmg = nm;
        }
        const spm = SP[Math.min(scatterCount, 6)] || 0;
        if (spm > 0) totalWin += betAmount * spm;
        const tf = scatterCount >= 4, fa = tf ? 15 : 0;
        if (user) user.coins += Math.floor(totalWin);
        if (!isGuestMode && user) await user.save();
        const nb = isGuestMode ? guestBalance + Math.floor(totalWin) : user.coins;
        socket.emit('candy_result', {
          initialGrid: ig, initialMultGrid: imr, tumbleSteps, scatterCount,
          totalWinAmount: Math.floor(totalWin), triggerFreeSpins: tf, freeSpinsAwarded: fa, newBalance: nb,
          winType: totalWin > betAmount * 100 ? 'mega_win' : totalWin > betAmount * 20 ? 'big_win' : totalWin > 0 ? 'win' : 'normal'
        });
      } catch (err) {
        console.error('Candy Rush error:', err);
        socket.emit('candy_error', { message: 'Server error' });
      }
    });

    // =====================================================
    // GATES OF GATOKACA - 6x5 COUNT-BASED + TUMBLE + MULTIPLIER ORBS
    // =====================================================
    socket.on('spin_gatokaca', async ({ username, betAmount, isFreeSpins, anteMode, clientBalance }) => {
      try {
        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 6000000;

        if (!user) {
          isGuestMode = true;
          if (guestBalance < betAmount && !isFreeSpins) {
            return socket.emit('gatokaca_error', { message: 'Koin tidak cukup' });
          }
        } else {
          if (user.coins < betAmount && !isFreeSpins) {
            return socket.emit('gatokaca_error', { message: 'Koin tidak cukup' });
          }
        }

        if (!isFreeSpins) {
          if (user) user.coins -= betAmount;
          else guestBalance -= betAmount;
        }

        const ROWS = 5, COLS = 6;
        const betUnit = Math.max(1, Math.floor(betAmount / 100));
        const WTS = [2, 3, 4, 6, 7, 8, 10, 12, 13, 4, 3];
        const TWS = WTS.reduce((a, b) => a + b, 0);

        const pick = (ab) => {
          let r = Math.random() * TWS;
          for (let i = 0; i < WTS.length; i++) {
            let w = WTS[i];
            if (ab && i === 9) w *= 2;
            r -= w;
            if (r <= 0) return i;
          }
          return 4;
        };

        const PT = {
          0: { 8: 10, 12: 50,  20: 250, 30: 500 },
          1: { 8: 5,  12: 25,  20: 100, 30: 250 },
          2: { 8: 3,  12: 15,  20: 60,  30: 150 },
          3: { 8: 2,  12: 12,  20: 40,  30: 120 },
          4: { 8: 2,  12: 10,  20: 30,  30: 100 },
          5: { 8: 2,  12: 8,   20: 25,  30: 80  },
          6: { 8: 1,  12: 5,   20: 20,  30: 50  },
          7: { 8: 1,  12: 4,   20: 18,  30: 40  },
          8: { 8: 1,  12: 2,   20: 14,  30: 20  },
        };
        const SP = { 4: 3, 5: 5, 6: 100 };

        const gcp = (s, cnt) => {
          if (!PT[s]) return 0;
          let p = 0;
          for (const t of Object.keys(PT[s]).map(Number).sort((a, b) => a - b)) {
            if (cnt >= t) p = PT[s][t];
          }
          return p;
        };

        const MV = [2, 3, 5, 8, 10, 15, 25, 50, 100, 500];
        const rm = () => MV[Math.floor(Math.random() * MV.length)];

        let cg = [], cmg = [], scatterCount = 0;
        for (let r = 0; r < ROWS; r++) {
          const row = [], mr = [];
          for (let c = 0; c < COLS; c++) {
            const s = pick(anteMode);
            if (s === 9) scatterCount++;
            row.push(s);
            mr.push(s === 10 ? rm() : 0);
          }
          cg.push(row);
          cmg.push(mr);
        }

        const ig = cg.map(r => [...r]);
        const imr = cmg.map(r => [...r]);
        let totalWin = 0;
        const tumbleSteps = [];

        for (let t = 0; t < 10; t++) {
          const sc2 = {}, sp2 = {};
          let totalMult = 0;
          const mp = [];

          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              const s = cg[r][c];
              if (s === 10) { totalMult += cmg[r][c]; mp.push(r + '-' + c); }
              else if (s !== 9) {
                sc2[s] = (sc2[s] || 0) + 1;
                if (!sp2[s]) sp2[s] = [];
                sp2[s].push(r + '-' + c);
              }
            }
          }

          let sw = 0;
          const wp = new Set();
          for (const [ss, cnt] of Object.entries(sc2)) {
            const pm = gcp(parseInt(ss), cnt);
            if (pm > 0) { sw += pm * betUnit; sp2[ss].forEach(p => wp.add(p)); }
          }

          if (sw <= 0) break;
          const fm = Math.max(1, totalMult);
          sw *= fm;
          totalWin += sw;

          const ar = new Set([...wp, ...mp]);
          const ng = cg.map(r => [...r]);
          const nm = cmg.map(r => [...r]);
          for (let c = 0; c < COLS; c++) {
            let wr = ROWS - 1;
            for (let r = ROWS - 1; r >= 0; r--) {
              if (!ar.has(r + '-' + c)) { ng[wr][c] = cg[r][c]; nm[wr][c] = cmg[r][c]; wr--; }
            }
            while (wr >= 0) {
              const ns = pick(anteMode);
              ng[wr][c] = ns; nm[wr][c] = ns === 10 ? rm() : 0; wr--;
            }
          }
          tumbleSteps.push({
            winPositions: Array.from(ar), stepWin: sw, multiplierValue: fm,
            newGrid: ng.map(r => [...r]), newMultGrid: nm.map(r => [...r])
          });
          cg = ng; cmg = nm;
        }

        const spm = SP[Math.min(scatterCount, 6)] || 0;
        if (spm > 0) totalWin += betAmount * spm;
        const tf = scatterCount >= 4;
        const fa = tf ? 15 : 0;

        if (user) user.coins += Math.floor(totalWin);
        if (!isGuestMode && user) await user.save();
        const nb = isGuestMode ? guestBalance + Math.floor(totalWin) : user.coins;

        socket.emit('gatokaca_result', {
          initialGrid: ig, initialMultGrid: imr, tumbleSteps, scatterCount,
          totalWinAmount: Math.floor(totalWin), triggerFreeSpins: tf,
          freeSpinsAwarded: fa, newBalance: nb,
          winType: totalWin > betAmount * 100 ? 'mega_win' : totalWin > betAmount * 20 ? 'big_win' : totalWin > 0 ? 'win' : 'normal'
        });

      } catch (err) {
        console.error('Gates of Gatokaca error:', err);
        socket.emit('gatokaca_error', { message: 'Server error' });
      }
    });

  });
}

module.exports = { initSocketIO };