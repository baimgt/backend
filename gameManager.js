  // =====================================================
// GAME MANAGER — Server-side game state & matchmaking
// =====================================================
const User = require('./models/User');
const { spendUserCoins, spendSlotCoins, checkAndCleanExpiredBonus } = require('./helpers/bonusHelper');
const { TARGET_RTP, TARGET_HIT_FREQ, determineSpinOutcome, sanitizeClusterGrid } = require('./slotRtpEngine');

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

// Weighted multiplier generator (Low Payout / Hard Mode):
// Mayoritas bola pengali yang turun bernilai kecil (2x - 3x ~82%, 4x - 5x ~13.5%, 6x+ sangat langka)
function pickAuthenticMultiplier(maxTier = 500) {
  const roll = Math.random();
  if (roll < 0.58) return 2;
  if (roll < 0.82) return 3;
  if (roll < 0.91) return 4;
  if (roll < 0.955) return 5;
  if (roll < 0.975) return 6;
  if (roll < 0.988) return 8;
  if (roll < 0.994) return 10;
  if (roll < 0.997) return 12;
  if (roll < 0.999) return 15;
  if (roll < 0.9996) return 20;
  if (roll < 0.9999) return 25;
  return 50;
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
    const requiredBuyIn = this.roomConfig.buyIn || fee;

    try {
      const user = await User.findOne({ username });
      if (user) {
        const regularCoins = user.coins || 0;
        if (regularCoins < requiredBuyIn) {
          this.players = this.players.filter(p => p !== tempPlayer);
          if (user.bonusCoins > 0 && (regularCoins + user.bonusCoins) >= requiredBuyIn) {
            socket.emit('error-msg', `⚠️ Koin klaim bonus harian (${(user.bonusCoins || 0).toLocaleString('id-ID')} koin) hanya bisa digunakan untuk game SLOT!\n\nKoin umum Domino Anda: ${regularCoins.toLocaleString('id-ID')} koin (Butuh: ${requiredBuyIn.toLocaleString('id-ID')} koin). Putar di game slot untuk mengubah bonus menjadi koin universal!`);
          } else {
            socket.emit('error-msg', `⚠️ KOIN TIDAK CUKUP! Membutuhkan minimal ${requiredBuyIn.toLocaleString('id-ID')} koin untuk taruhan.`);
          }
          return false;
        }
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
    const buyIn = this.roomConfig.buyIn || (fee * 2);
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
        wildNumber: this.wildTile ? this.wildTile[1] : null,
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
        logs: this.logs,
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

    // If player has NO playable tile, server automatically executes doPass!
    // Human skips quickly (~0.9s), while bots pause naturally (2.0s - 3.4s) like a real player checking their hand.
    if (!hasPlayable) {
      const passDelay = current.isBot ? (2000 + Math.floor(Math.random() * 1400)) : 900;
      clearTimeout(this.botTimer);
      this.botTimer = setTimeout(() => {
        if (this.status === 'playing' && this.turnIndex === current.seatIndex) {
          this.doPass(current.seatIndex);
        }
      }, passDelay);
      return;
    }

    // If bot's turn, run botPlay with a natural human thinking delay (2.2s - 4.0s)
    if (current.isBot) {
      const delay = 2200 + Math.floor(Math.random() * 1800);
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

    const tileIdx = player.hand.findIndex(t =>
      (t[0] === tile[0] && t[1] === tile[1]) || (t[0] === tile[1] && t[1] === tile[0])
    );
    if (tileIdx === -1) return;
    const actualTile = player.hand[tileIdx];
    if (!this.isPlayable(actualTile)) return;

    // Remove from hand
    player.hand.splice(tileIdx, 1);

    // Check match options before placing tile
    const prevLeft = this.leftEnd;
    const prevRight = this.rightEnd;
    const [a, b] = actualTile;
    const isWild = !!(this.isWildMode && this.wildTile && (
      (a === this.wildTile[0] && b === this.wildTile[1]) ||
      (a === this.wildTile[1] && b === this.wildTile[0])
    ));
    const matchesLeft = prevLeft !== null && (a === prevLeft || b === prevLeft || isWild);
    const matchesRight = prevRight !== null && (a === prevRight || b === prevRight || isWild);
    const matchesBothEnds = prevLeft !== null && prevRight !== null && matchesLeft && matchesRight;
    const isDoubleTile = a === b;

    // Honor requested side if valid; fallback to the other side if only one side matches
    let effectiveSide = side === 'left' ? 'left' : 'right';
    if (effectiveSide === 'left' && !matchesLeft && matchesRight) effectiveSide = 'right';
    if (effectiveSide === 'right' && !matchesRight && matchesLeft) effectiveSide = 'left';

    // Place on board
    if (this.leftEnd === null || this.rightEnd === null) {
      // First tile played on empty board!
      this.board.push({ left: a, right: b });
      this.leftEnd = a;
      this.rightEnd = b;
    } else if (effectiveSide === 'left') {
      if (b === this.leftEnd) {
        this.board.unshift({ left: a, right: b });
        this.leftEnd = a;
      } else if (a === this.leftEnd) {
        this.board.unshift({ left: b, right: a });
        this.leftEnd = b;
      } else {
        this.board.unshift({ left: a, right: b });
        this.leftEnd = a;
      }
    } else {
      if (a === this.rightEnd) {
        this.board.push({ left: a, right: b });
        this.rightEnd = b;
      } else if (b === this.rightEnd) {
        this.board.push({ left: b, right: a });
        this.rightEnd = a;
      } else {
        this.board.push({ left: a, right: b });
        this.rightEnd = b;
      }
    }

    this.consecutivePassCount = 0; // Reset consecutive pass count on successful play
    this.passCount = 0;
    this.lastPlayerIdx = playerIdx; // Remember who last played
    this.logs.push(`${player.username} melempar [${a},${b}] ke ${effectiveSide === 'left' ? 'Kiri' : 'Kanan'}`);

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

// By One (1v1) Matchmaking & Active Matches
const byoneQueues = new Map();
const byoneMatches = new Map();
const byoneRooms = new Map();

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

        const hostCoins = hostUser ? (hostUser.coins || 0) : 0;
        if (!hostUser || hostCoins < requiredBuyIn) {
          const msg = hostUser && hostUser.bonusCoins > 0 && (hostCoins + hostUser.bonusCoins) >= requiredBuyIn
            ? `⚠️ KOIN ANDA TIDAK CUKUP UNTUK DOMINO!\n\nKoin bonus harian hanya untuk bermain Slot. Koin umum Domino Anda: ${hostCoins.toLocaleString('id-ID')} koin (Butuh: ${requiredBuyIn.toLocaleString('id-ID')} koin). Putar di game slot untuk mengubah bonus menjadi koin universal!`
            : `⚠️ KOIN ANDA TIDAK CUKUP!\n\nAnda membutuhkan minimal ${requiredBuyIn.toLocaleString('id-ID')} koin untuk masuk kamar ${roomConfig.name}.`;
          socket.emit('team-join-error', { message: msg });
          return;
        }

        const partnerCoins = partnerUser ? (partnerUser.coins || 0) : 0;
        if (!partnerUser || partnerCoins < requiredBuyIn) {
          const partnerCoinsStr = partnerCoins.toLocaleString('id-ID');
          socket.emit('team-join-error', {
            message: `⚠️ KOIN TEMAN SETIM TIDAK CUKUP!\n\nTeman setim Anda (${partnerUsername}) hanya memiliki ${partnerCoinsStr} koin umum Domino, tetapi kamar ${roomConfig.name} membutuhkan minimal ${requiredBuyIn.toLocaleString('id-ID')} koin.`
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

    // Force start waiting room immediately (Mulai Sekarang button)
    socket.on('force-start-room', ({ roomKey }) => {
      if (!roomKey) return;
      const room = waitingRooms.get(roomKey);
      if (room && !room.gameStarted && room.players.length > 0) {
        room.startGame();
      }
    });

    // Player action: play a card
    socket.on('play-card', ({ gameId, tile, side, username }) => {
      const game = activeGames.get(gameId);
      if (!game) return;

      const player = game.players.find(p =>
        p.socketId === socket.id ||
        (username && p.username === username) ||
        (socket.username && p.username === socket.username) ||
        !p.isBot
      );
      if (!player) return;
      player.socketId = socket.id;

      game.doPlay(player.seatIndex, tile, side);
    });

    // Player action: pass turn
    socket.on('pass-turn', ({ gameId, username }) => {
      const game = activeGames.get(gameId);
      if (!game) return;

      const player = game.players.find(p =>
        p.socketId === socket.id ||
        (username && p.username === username) ||
        (socket.username && p.username === socket.username) ||
        !p.isBot
      );
      if (!player) return;
      player.socketId = socket.id;

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

      // Cleanup By One queues
      for (const [key, q] of byoneQueues) {
        if (q.socketId === socket.id) {
          byoneQueues.delete(key);
        }
      }

      // Cleanup By One active matches on disconnect (surrender / award pot to remaining player)
      for (const [matchId, match] of byoneMatches) {
        const allPlayers = match.players || [match.player1, match.player2].filter(Boolean);
        const leaver = allPlayers.find(p => p && p.socketId === socket.id);
        if (leaver && !match.finished) {
          match.finished = true;
          const remainingList = allPlayers.filter(p => p && p.socketId !== socket.id && p.username !== leaver.username);
          const remaining = remainingList[0] || (match.player1?.socketId === socket.id ? match.player2 : match.player1);
          const pot = match.pot || 0;

          if (remaining) {
            User.findOne({ username: remaining.username }).then(async (u) => {
              if (u && pot > 0) {
                u.coins += pot;
                await u.save();
              }
              const payload = {
                winner: remaining.username,
                leaver: leaver.username,
                pot,
                byFold: true,
                byDisconnect: true,
                byOpponentLeft: true,
                isMeWinner: true,
                newCoins: u ? u.coins : undefined,
                message: `🏳️ ${leaver.username} keluar dari pertandingan! Anda otomatis MENANG!`
              };
              const targetSock = userSockets.get(remaining.username) || remaining.socketId;
              if (targetSock) io.to(targetSock).emit('byone_match_ended', payload);
              if (remaining.socketId && remaining.socketId !== targetSock) {
                io.to(remaining.socketId).emit('byone_match_ended', payload);
              }
            }).catch(console.error);
          }

          byoneMatches.delete(matchId);
        }
      }

      // Cleanup By One custom rooms if player disconnects
      for (const [code, r] of byoneRooms) {
        if (r.players && Array.isArray(r.players)) {
          const pIdx = r.players.findIndex(p => p.socketId === socket.id);
          if (pIdx !== -1) {
            const removed = r.players.splice(pIdx, 1)[0];
            if (removed.isHost || r.players.length === 0) {
              byoneRooms.delete(code);
              io.to(`byone_room_${code}`).emit('byone_room_closed', { message: 'Pembuat kamar telah keluar.' });
            } else {
              r.pot = r.betAmount * r.players.length;
              io.to(`byone_room_${code}`).emit('byone_room_updated', { code, room: r });
            }
          }
        }
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
        const bet = Number(betAmount);
        if (!Number.isFinite(bet) || bet < 500 || bet > 100000) {
          socket.emit('spin_error', { message: 'Taruhan harus antara 500 sampai 100.000 koin' });
          return;
        }

        const user = await User.findOne({ username });
        if (!user) {
          socket.emit('spin_error', { message: 'User not found' });
          return;
        }

        await checkAndCleanExpiredBonus(user);

        const totalAvailable = (user.coins || 0) + (user.bonusCoins || 0);
        if (totalAvailable < bet) {
          socket.emit('spin_error', { message: 'Koin tidak cukup!' });
          return;
        }

        // Deduct bet (consume daily bonusCoins first if playing slot)
        spendSlotCoins(user, bet);

        // RTP 96.26% & Hit Frequency 15.05% Mathematical Model
        const rtpOutcome = determineSpinOutcome({ isFreeSpins: false, anteMode: false });

        // 3. Generate Slot Grid (3 rows x 5 columns)
        // 0: 9, 1: 10, 2: J, 3: Q, 4: K, 5: A
        // 6: Coin, 7: Turtle, 8: Ship, 9: Gold Bowl, 10: Wild
        const numCols = 5;
        const numRows = 3;
        let grid = [];
        
        // Weighted distribution
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

        if (rtpOutcome.isHit) {
          // Guaranteed win! Stamp matching symbols on consecutive columns
          const targetCols = rtpOutcome.winTier === 'mega' ? 5 : (rtpOutcome.winTier === 'big' ? 4 : 3);
          const chosenSym = (rtpOutcome.winTier === 'mega' || rtpOutcome.winTier === 'big')
            ? (6 + Math.floor(Math.random() * 4))
            : Math.floor(Math.random() * 6);
          grid = Array.from({ length: numRows }, () => Array.from({ length: numCols }, () => pickSymbol()));
          const forcedRow = 1;
          for (let c = 0; c < targetCols; c++) {
            grid[forcedRow][c] = chosenSym;
          }
        } else {
          // Guaranteed loss (84.95% of spins)! Ensure no 3 consecutive columns match
          for (let r = 0; r < numRows; r++) {
            const row = [];
            for (let c = 0; c < numCols; c++) {
              row.push(pickSymbol());
            }
            grid.push(row);
          }
          // Break any accidental 3-column match
          for (let r = 0; r < numRows; r++) {
            const symCol0 = grid[r][0];
            if (grid[r][1] === symCol0 || grid[r][1] === 10) {
              grid[r][1] = (symCol0 + 2) % 10;
            }
            if (grid[r][2] === symCol0 || grid[r][2] === 10) {
              grid[r][2] = (symCol0 + 4) % 10;
            }
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
        const _lm = applyLineMultiplier(socket, 'duofu', false, winAmount);
        winAmount = winAmount * _lm.mult;

        let winType = 'normal';
        if (totalWinMult >= 200) winType = 'mega_win';
        else if (totalWinMult >= 80) winType = 'big_win';
        else if (totalWinMult >= 30) winType = 'win';

        user.coins += winAmount;
        await user.save();

        // 7. Send result
        socket.emit('spin_result', {
          multiplier: _lm.info,
          grid,
          winAmount,
          totalWinMult,
          winningSymbols,
          newBalance: (user.coins || 0) + (user.bonusCoins || 0),
          coins: user.coins,
          bonusCoins: user.bonusCoins || 0,
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
    socket.on('spin_zeus', async ({ username, betAmount, actualBet, anteBet, isFreeSpins, freeSpinMult, clientBalance, buyFeature }) => {
      try {
        const bet = Number(betAmount);
        if (!Number.isFinite(bet) || bet < 500 || bet > 100000) {
          socket.emit('zeus_error', { message: 'Taruhan harus antara 500 sampai 100.000 koin' });
          return;
        }

        let user = await User.findOne({ username });
        let betDeduction = buyFeature
          ? (bet * 100)
          : (actualBet || (anteBet ? Math.floor(bet * 1.25) : bet));
        
        // Guest / not-registered fallback: use client-provided balance
        let isGuestMode = false;
        let guestBalance = clientBalance || 100000;
        if (!user) {
          isGuestMode = true;
          if (!isFreeSpins && guestBalance < betDeduction) {
            socket.emit('zeus_error', { message: 'Koin tidak cukup!' }); return;
          }
          if (!isFreeSpins) guestBalance -= betDeduction;
        } else {
          await checkAndCleanExpiredBonus(user);
          const totalAvailable = (user.coins || 0) + (user.bonusCoins || 0);
          if (!isFreeSpins && totalAvailable < betDeduction) {
            socket.emit('zeus_error', { message: 'Koin tidak cukup!' });
            return;
          }
          if (!isFreeSpins) {
            spendSlotCoins(user, betDeduction);
          }
        }

        const ROWS = 5, COLS = 6;
        const _ms = slotMS(socket.id, 'zeus');
        if (!isFreeSpins) _ms.freeMult = 0;

        // AUTHENTIC PRAGMATIC PLAY REEL DISTRIBUTION:
        // 9 regular paying symbols (0..8) spread to give authentic ~26% hit frequency.
        // Symbols: 0 (Crown: 8), 1 (Hourglass: 9), 2 (Ring: 10), 3 (Goblet: 11),
        //          4 (Red: 12), 5 (Purple: 13), 6 (Yellow: 14), 7 (Green: 15), 8 (Blue: 16)
        // Scatter (9): 2.5 on regular (~1 in 150 spins), 3.5 on Ante Bet (~1 in 80 spins)
        const symbolWeights = [
          { sym: 0, weight: 8 },  // Mahkota Emas (Crown - Simbol Termahal)
          { sym: 1, weight: 9 },  // Jam Pasir (Hourglass)
          { sym: 2, weight: 10 }, // Cincin Ruby (Ring)
          { sym: 3, weight: 11 }, // Cawan Emas (Goblet)
          { sym: 4, weight: 12 }, // Permata Merah (Red Gem)
          { sym: 5, weight: 13 }, // Permata Ungu (Purple Gem)
          { sym: 6, weight: 14 }, // Permata Kuning (Yellow Gem)
          { sym: 7, weight: 15 }, // Permata Hijau (Green Gem)
          { sym: 8, weight: 16 }, // Permata Biru (Blue Gem)
          { sym: 9, weight: anteBet ? 3.5 : 2.5 }, // Zeus Scatter
        ];
        const totalW = symbolWeights.reduce((a, v) => a + v.weight, 0);
        const pickSym = () => {
          let r = Math.random() * totalW;
          for (const w of symbolWeights) { if (r < w.weight) return w.sym; r -= w.weight; }
          return 8;
        };

        // TABEL PEMBAYARAN RESMI GATES OF OLYMPUS (PRAGMATIC PLAY):
        // Sistem Scatter Pays (8+ simbol sejenis di mana saja di layar 6x5):
        // Tiers: 8-9 simbol, 10-11 simbol, 12-30 simbol (pengali terhadap total bet)
        const PT = {
          0: { 8: 10,   10: 25,   12: 50 },  // Mahkota Emas
          1: { 8: 2.5,  10: 10,   12: 25 },  // Jam Pasir
          2: { 8: 2,    10: 5,    12: 15 },  // Cincin Ruby
          3: { 8: 1.5,  10: 2,    12: 12 },  // Cawan Emas
          4: { 8: 1,    10: 1.5,  12: 10 },  // Permata Merah
          5: { 8: 0.8,  10: 1.2,  12: 8  },  // Permata Ungu
          6: { 8: 0.5,  10: 1,    12: 5  },  // Permata Kuning
          7: { 8: 0.4,  10: 0.9,  12: 4  },  // Permata Hijau
          8: { 8: 0.25, 10: 0.75, 12: 2  },  // Permata Biru
        };
        // Pembayaran Tunai Scatter (4: 3x, 5: 5x, 6+: 100x taruhan)
        const SP = { 4: 3, 5: 5, 6: 100 };

        const getClusterMultiplier = (sym, count) => {
          if (!PT[sym]) return 0;
          if (count >= 12) return PT[sym][12];
          if (count >= 10) return PT[sym][10];
          if (count >= 8) return PT[sym][8];
          return 0;
        };

        // RTP 96.26% & Hit Frequency 15.05% Mathematical Model
        const rtpOutcome = determineSpinOutcome({ isFreeSpins, anteMode: anteBet, buyFeature });

        // Generate initial grid
        let grid = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, pickSym));
        let multGrid = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 0));

        // Enforce exact 15.05% Hit Frequency and 96.26% RTP
        sanitizeClusterGrid(grid, ROWS, COLS, rtpOutcome, pickSym, 9, 10);

        // Multiplier Orbs (Zeus Petir Sambaran - Peluang diturunkan agar sulit menang besar)
        const zeusMultChance = buyFeature ? 0 : (isFreeSpins ? 0.12 : (anteBet ? 0.08 : 0.05));
        if (Math.random() < zeusMultChance) {
          const r = Math.floor(Math.random() * ROWS);
          const c = Math.floor(Math.random() * COLS);
          if (grid[r][c] !== 9) {
            grid[r][c] = 10;
            multGrid[r][c] = pickAuthenticMultiplier(500);
          }
        }

        // Check cluster wins function
        const checkClusterWins = (g) => {
          const symCounts = {};
          const symPositions = {};
          const scatterPos = [];
          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              const s = g[r][c];
              if (s === null || s === undefined) continue;
              if (s === 9) { scatterPos.push([r, c]); continue; }
              if (s === 10) continue; // Multiplier orb stays on board
              if (!symCounts[s]) { symCounts[s] = 0; symPositions[s] = []; }
              symCounts[s]++;
              symPositions[s].push([r, c]);
            }
          }
          const wins = [];
          for (let sym = 0; sym <= 8; sym++) {
            const count = symCounts[sym] || 0;
            if (count >= 8) {
              const mult = getClusterMultiplier(sym, count);
              if (mult > 0) {
                wins.push({
                  sym,
                  count,
                  mult,
                  positions: [...(symPositions[sym] || [])]
                });
              }
            }
          }
          return { wins, scatterCount: scatterPos.length, scatterPos };
        };

        let baseTumbleWin = 0;
        let tumbleCount = 0;
        let allWinPositions = [];
        let clusterWins = [];
        let gridHistory = [JSON.parse(JSON.stringify(grid))];
        let currentGrid = JSON.parse(JSON.stringify(grid));
        let scatterCount = 0;

        // Check initial scatter count
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            if (currentGrid[r][c] === 9) scatterCount++;
          }
        }

        for (let t = 0; t < 10; t++) {
          const { wins } = checkClusterWins(currentGrid);
          if (wins.length === 0) break;

          const winningPositions = new Set();
          wins.forEach(w => {
            const winVal = Math.floor(bet * w.mult);
            baseTumbleWin += winVal;
            clusterWins.push({ sym: w.sym, count: w.count, winAmount: winVal, tumble: t });
            w.positions.forEach(([r, c]) => {
              winningPositions.add(`${r},${c}`);
              allWinPositions.push([r, c, w.sym, t]);
            });
          });

          if (winningPositions.size === 0) break;
          tumbleCount++;

          // Winning symbols vanish (set to null)
          winningPositions.forEach(key => {
            const [r, c] = key.split(',').map(Number);
            currentGrid[r][c] = null;
          });

          // Empty / exploded grid for frontend
          gridHistory.push(JSON.parse(JSON.stringify(currentGrid)));

          // Gravity drop
          for (let c = 0; c < COLS; c++) {
            const existingSyms = [];
            const existingMults = [];
            for (let r = ROWS - 1; r >= 0; r--) {
              if (currentGrid[r][c] !== null && currentGrid[r][c] !== undefined) {
                existingSyms.push(currentGrid[r][c]);
                existingMults.push(multGrid[r][c] || 0);
              }
            }
            while (existingSyms.length < ROWS) {
              let newS = pickSym();
              if (newS === 9) newS = 5 + Math.floor(Math.random() * 4); // avoid duplicate scatter cluster in cascade
              let newM = 0;
              if (t === 0 && Math.random() < (isFreeSpins ? 0.008 : 0.003)) {
                newS = 10;
                newM = pickAuthenticMultiplier(500);
              }
              existingSyms.push(newS);
              existingMults.push(newM);
            }
            for (let r = 0; r < ROWS; r++) {
              currentGrid[r][c] = existingSyms[ROWS - 1 - r];
              multGrid[r][c] = existingMults[ROWS - 1 - r];
            }
          }

          // Batasi rantai runtuhan (tumble) maksimal 1-2 kali agar tidak pecah beruntun terus-menerus
          if (t >= 1 || Math.random() < 0.75) {
            sanitizeClusterGrid(currentGrid, ROWS, COLS, { isHit: false, isScatter: false }, pickSym, 9, 10);
          }

          // Post-gravity grid for frontend
          gridHistory.push(JSON.parse(JSON.stringify(currentGrid)));
        }

        // Sum all multiplier orbs visible on the board at the end of tumbles
        let spinOrbsSum = 0;
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            if (currentGrid[r][c] === 10 && multGrid[r][c] > 0) {
              spinOrbsSum += multGrid[r][c];
            }
          }
        }

        // Calculate Multiplier & Total Win (Authentic Pragmatic Play Gates of Olympus Rules):
        // - Saat Free Spins: Total Pengali (_ms.freeMult) HANYA bertambah dan HANYA mengalikan kemenangan
        //   jika pada putaran ini ADA bola pengali turun (spinOrbsSum > 0) DAN ADA pecahan menang (baseTumbleWin > 0).
        // - Jika ada pecahan menang (baseTumbleWin > 0) TANPA ada bola pengali turun (spinOrbsSum === 0),
        //   maka kemenangan putaran ini TIDAK dikalikan dengan Total Pengali (finalMultiplier = 1).
        // - Jika ada bola pengali turun tetapi TIDAK ada pecahan menang (baseTumbleWin === 0),
        //   maka bola pengali tidak aktif dan tidak ditambahkan ke Total Pengali.
        let finalMultiplier = 1;
        let totalWin = 0;

        if (baseTumbleWin > 0) {
          if (isFreeSpins) {
            if (spinOrbsSum > 0) {
              _ms.freeMult = (_ms.freeMult || 0) + spinOrbsSum;
              finalMultiplier = Math.max(1, _ms.freeMult);
              totalWin = baseTumbleWin * finalMultiplier;
            } else {
              finalMultiplier = 1;
              totalWin = baseTumbleWin;
            }
          } else {
            if (spinOrbsSum > 0) {
              finalMultiplier = spinOrbsSum;
              totalWin = baseTumbleWin * finalMultiplier;
            } else {
              finalMultiplier = 1;
              totalWin = baseTumbleWin;
            }
          }
        } else {
          finalMultiplier = 1;
          totalWin = 0;
        }

        // Scatter cash payout:
        // 4 Scatters: 3x bet
        // 5 Scatters: 5x bet
        // 6+ Scatters: 100x bet
        if (scatterCount >= 4) {
          const spm = SP[Math.min(scatterCount, 6)] || 3;
          totalWin += Math.floor(bet * spm);
        }

        // Free Spins Trigger / Retrigger:
        // Base Game: 4+ Scatters awards 15 Free Spins
        // Free Spins: 3+ Scatters awards +5 Free Spins (Retrigger!)
        const triggerFreeSpins = isFreeSpins ? (scatterCount >= 3) : (scatterCount >= 4);
        const freeSpinsAwarded = isFreeSpins ? (scatterCount >= 3 ? 5 : 0) : (scatterCount >= 4 ? 15 : 0);

        // Max Win Cap for Gates of Olympus (5,000x bet)
        const maxWinCap = bet * 5000;
        if (totalWin > maxWinCap) totalWin = maxWinCap;

        // Persist User Balance
        if (user) user.coins += Math.floor(totalWin);
        if (!isGuestMode && user) await user.save();
        const newBalance = isGuestMode
          ? guestBalance + Math.floor(totalWin)
          : (user.coins || 0) + (user.bonusCoins || 0);

        // Win Type Classification (Big Win >= 5x, Mega Win >= 12x, Super Win >= 30x)
        const winRatio = totalWin / bet;
        const winType = winRatio >= 30 ? 'super_win' : winRatio >= 12 ? 'mega_win' : winRatio >= 5 ? 'big_win' : totalWin > 0 ? 'win' : 'normal';

        socket.emit('zeus_result', {
          freeMult: isFreeSpins ? (_ms.freeMult || 0) : 0,
          appliedMultiplier: finalMultiplier,
          roundOrbsSum: spinOrbsSum,
          grid: gridHistory[0],
          finalGrid: currentGrid,
          gridHistory,
          multGrid,
          baseTumbleWin,
          totalWinAmount: Math.floor(totalWin),
          clusterWins,
          tumbleCount,
          allWinPositions,
          newBalance,
          coins: user ? user.coins : newBalance,
          bonusCoins: user ? (user.bonusCoins || 0) : 0,
          triggerFreeSpins,
          freeSpinsAwarded,
          scatterCount,
          randomMult: (baseTumbleWin > 0 && spinOrbsSum > 0) ? spinOrbsSum : null,
          winType
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
        const bet = Number(betAmount);
        if (!Number.isFinite(bet) || bet < 500 || bet > 100000) {
          return socket.emit('fafafa_error', { message: 'Taruhan harus antara 500 sampai 100.000 koin' });
        }

        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 100000;

        if (!user) {
          isGuestMode = true;
          if (guestBalance < bet && !isFreeSpins) {
            return socket.emit('fafafa_error', { message: 'Koin tidak cukup' });
          }
          if (!isFreeSpins) guestBalance -= bet;
        } else {
          await checkAndCleanExpiredBonus(user);
          const totalAvailable = (user.coins || 0) + (user.bonusCoins || 0);
          if (totalAvailable < bet && !isFreeSpins) {
            return socket.emit('fafafa_error', { message: 'Koin tidak cukup' });
          }
          if (!isFreeSpins) {
            spendSlotCoins(user, bet);
          }
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
        // RTP 96.26% & Hit Frequency 15.05% Mathematical Model
        const rtpOutcome = determineSpinOutcome({ isFreeSpins });

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

        if (!rtpOutcome.isHit && !rtpOutcome.isScatter) {
          // Break line matches on reels 0-2 (including during Free Spins) to guarantee clean loss
          const col0Pool = [3, 4, 5];
          const col1Pool = [6, 7, 8];
          const col2Pool = [9, 10, 9];
          for (let r = 0; r < ROWS; r++) {
            grid[r][0] = col0Pool[r % col0Pool.length];
            grid[r][1] = col1Pool[r % col1Pool.length];
            grid[r][2] = col2Pool[r % col2Pool.length];
          }
        } else if (rtpOutcome.isHit) {
          // Break accidental multi-line matches first, then plant 1 controlled line hit
          const col0Pool = [3, 4, 5];
          const col1Pool = [6, 7, 8];
          const col2Pool = [9, 10, 9];
          for (let r = 0; r < ROWS; r++) {
            grid[r][0] = col0Pool[r % col0Pool.length];
            grid[r][1] = col1Pool[r % col1Pool.length];
            grid[r][2] = col2Pool[r % col2Pool.length];
          }
          const hitSym = rtpOutcome.winTier === 'mega' ? 4 : (rtpOutcome.winTier === 'big' ? 6 : (Math.floor(Math.random() * 3) + 8));
          const targetCols = rtpOutcome.winTier === 'mega' ? 4 : 3;
          const lineIdx = Math.floor(Math.random() * 3);
          const targetLine = LINES[lineIdx];
          for (let c = 0; c < targetCols; c++) {
            grid[targetLine[c]][c] = hitSym;
          }
          if (targetCols < COLS) {
            for (let r = 0; r < ROWS; r++) {
              if (grid[r][targetCols] === hitSym || grid[r][targetCols] === 0 || grid[r][targetCols] === 1) {
                grid[r][targetCols] = 10;
              }
            }
          }
        }
        // Strict scatter control
        scatterCount = 0;
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            if (grid[r][c] === 2) grid[r][c] = 10;
          }
        }
        if (rtpOutcome.isScatter && !isFreeSpins) {
          grid[Math.floor(Math.random() * ROWS)][0] = 2;
          grid[Math.floor(Math.random() * ROWS)][2] = 2;
          grid[Math.floor(Math.random() * ROWS)][4] = 2;
          scatterCount = 3;
        }

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

        const _lm = applyLineMultiplier(socket, 'fafafa', isFreeSpins, totalWinAmount);
        if (_lm.mult > 1) {
          totalWinAmount = totalWinAmount * _lm.mult;
          winningLines.forEach(w => { w.win = w.win * _lm.mult; });
        }
        user && (user.coins += Math.floor(totalWinAmount));
        if (!isGuestMode && user) await user.save();
        
        const newBalance = isGuestMode ? guestBalance + Math.floor(totalWinAmount) : (user.coins || 0) + (user.bonusCoins || 0);

        socket.emit('fafafa_result', {
          multiplier: _lm.info,
          grid,
          totalWinAmount: Math.floor(totalWinAmount),
          winningLines,
          isFullBoard,
          fbSym,
          triggerFreeSpins: freeSpinsAwarded > 0,
          freeSpinsAwarded,
          scatterCount,
          newBalance,
          coins: user ? user.coins : newBalance,
          bonusCoins: user ? (user.bonusCoins || 0) : 0
        });

      } catch (err) {
        console.error('Fafafa error:', err);
        socket.emit('fafafa_error', { message: 'Terjadi kesalahan server' });
      }
    });

    // =====================================================
    // 5 LIONS MEGAWAYS (五獅 MEGAWAYS) SLOT LOGIC
    // =====================================================
    socket.on('spin_fivelions', async ({ username, betAmount, actualBet, anteBet, isFreeSpins, clientBalance }) => {
      try {
        const bet = Number(betAmount);
        if (!Number.isFinite(bet) || bet < 500 || bet > 100000) {
          return socket.emit('fivelions_error', { message: 'Taruhan harus antara 500 sampai 100.000 koin' });
        }

        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 100000;
        const isAnte = Boolean(anteBet);
        const betDeduction = actualBet || (isAnte ? Math.floor(bet * 1.25) : bet);

        if (!user) {
          isGuestMode = true;
          if (guestBalance < betDeduction && !isFreeSpins) {
            return socket.emit('fivelions_error', { message: 'Koin tidak cukup' });
          }
          if (!isFreeSpins) guestBalance -= betDeduction;
        } else {
          await checkAndCleanExpiredBonus(user);
          const totalAvailable = (user.coins || 0) + (user.bonusCoins || 0);
          if (totalAvailable < betDeduction && !isFreeSpins) {
            return socket.emit('fivelions_error', { message: 'Koin tidak cukup' });
          }
          if (!isFreeSpins) {
            spendSlotCoins(user, betDeduction);
          }
        }

        // Low RTP & Hit Frequency Mathematical Model
        const rtpOutcome = determineSpinOutcome({ isFreeSpins, anteMode: isAnte });

        // Generate 6x3 grid
        const grid = [];
        let scatterCount = 0;
        for (let r = 0; r < 3; r++) {
          const row = [];
          for (let c = 0; c < 6; c++) {
            let sym = Math.floor(Math.random() * 12);
            // Wild (5) only on middle reels (cols 1-4) and only on winning spins with low chance
            if (sym === 5 && (c === 0 || c === 5 || !rtpOutcome.isHit || Math.random() > 0.15)) {
              sym = 7 + (r + c) % 5;
            }
            if (sym === 6) sym = 8; // Clear random scatters first
            row.push(sym);
          }
          grid.push(row);
        }

        if (rtpOutcome.isScatter) {
          grid[0][0] = 6;
          grid[1][2] = 6;
          grid[2][4] = 6;
          scatterCount = 3;
        }

        // Calculate win amount (low hit frequency & low payout)
        const isWin = rtpOutcome.isHit;
        let totalWinAmount = isWin ? Math.max(1, Math.floor(betAmount * (rtpOutcome.targetMult || 0.45))) : 0;

        // Authentic 5 Lions Megaways Wild Multiplier (rare & low multiplier):
        let hasWildInWin = false;
        if (isWin && Math.random() < (isFreeSpins ? 0.18 : 0.10)) {
          hasWildInWin = true;
          grid[1][2] = 5;
        }

        let wildMultiplier = 1;
        if (hasWildInWin) {
          const multOptions = isFreeSpins 
            ? [2, 3, 5, 8] 
            : [2, 3, 5];
          wildMultiplier = multOptions[Math.floor(Math.random() * multOptions.length)];
          totalWinAmount = Math.floor(totalWinAmount * wildMultiplier);
        }

        if (user) user.coins += totalWinAmount;
        if (!isGuestMode && user) await user.save();

        const newBalance = isGuestMode ? guestBalance + totalWinAmount : (user.coins || 0) + (user.bonusCoins || 0);

        socket.emit('fivelions_result', {
          wildMultiplier,
          hasWildInWin,
          grid,
          totalWinAmount,
          triggerFreeSpins: scatterCount >= 3,
          scatterCount,
          newBalance,
          coins: user ? user.coins : newBalance,
          bonusCoins: user ? (user.bonusCoins || 0) : 0
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
        const bet = Number(betAmount);
        if (!Number.isFinite(bet) || bet < 500 || bet > 100000) {
          return socket.emit('jinji_error', { message: 'Taruhan harus antara 500 sampai 100.000 koin' });
        }

        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 100000;

        if (!user) {
          isGuestMode = true;
          if (guestBalance < bet && !isFreeSpins) {
            return socket.emit('jinji_error', { message: 'Koin tidak cukup' });
          }
          if (!isFreeSpins) guestBalance -= bet;
        } else {
          await checkAndCleanExpiredBonus(user);
          const totalAvailable = (user.coins || 0) + (user.bonusCoins || 0);
          if (totalAvailable < bet && !isFreeSpins) {
            return socket.emit('jinji_error', { message: 'Koin tidak cukup' });
          }
          if (!isFreeSpins) {
            spendSlotCoins(user, bet);
          }
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
        // RTP 96.26% & Hit Frequency 15.05% Mathematical Model
        const rtpOutcome = determineSpinOutcome({ isFreeSpins });

        const grid = [];
        for (let r = 0; r < ROWS; r++) {
          const row = [];
          for (let c = 0; c < COLS; c++) {
            row.push(pickSym());
          }
          grid.push(row);
        }

        if (!rtpOutcome.isHit && !rtpOutcome.isScatter) {
          // Break line/ways matches on reels 0-2 (even during Free Spins) to guarantee clean loss
          const col0Pool = [0, 1, 2];
          const col1Pool = [3, 4, 5];
          const col2Pool = [6, 7, 6];
          for (let r = 0; r < ROWS; r++) {
            grid[r][0] = col0Pool[r % col0Pool.length];
            grid[r][1] = col1Pool[r % col1Pool.length];
            grid[r][2] = col2Pool[r % col2Pool.length];
          }
        } else if (rtpOutcome.isHit) {
          const col0Pool = [0, 1, 2];
          const col1Pool = [3, 4, 5];
          const col2Pool = [6, 7, 6];
          for (let r = 0; r < ROWS; r++) {
            grid[r][0] = col0Pool[r % col0Pool.length];
            grid[r][1] = col1Pool[r % col1Pool.length];
            grid[r][2] = col2Pool[r % col2Pool.length];
          }
          const hitSym = rtpOutcome.winTier === 'mega' ? 2 : (rtpOutcome.winTier === 'big' ? 4 : Math.floor(Math.random() * 3) + 5);
          const targetCols = rtpOutcome.winTier === 'mega' ? 4 : 3;
          const forcedRow = 1;
          for (let c = 0; c < targetCols; c++) {
            grid[forcedRow][c] = hitSym;
          }
          if (targetCols < COLS) {
            for (let r = 0; r < ROWS; r++) {
              if (grid[r][targetCols] === hitSym) grid[r][targetCols] = (hitSym + 1) % 8;
            }
          }
        }

        let multGrid = Array.from({ length: ROWS }, () => Array.from({ length: COLS }, () => 0));
        let jjOrbSum = 0;
        const jjMultChance = isFreeSpins ? 0.10 : 0.04;
        if (Math.random() < jjMultChance) {
          const r = Math.floor(Math.random() * ROWS);
          const c = 3 + Math.floor(Math.random() * 2); // Letakkan di reel 4-5 agar tidak merusak 3-reel ways
          const v = pickAuthenticMultiplier(50);
          grid[r][c] = 12;
          multGrid[r][c] = v;
          jjOrbSum += v;
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

        const _jjMs = slotMS(socket.id, 'jinji');
        if (!isFreeSpins) _jjMs.freeMult = 0;

        // Hanya kalikan kemenangan apabila ADA simbol menang (totalWinAmount > 0) DAN ADA pengali turun (jjOrbSum > 0)!
        // Jika ada kemenangan tetapi TIDAK ada pengali turun (jjOrbSum === 0), kemenangan tidak dikalikan!
        let jjAppliedMult = 1;
        if (totalWinAmount > 0 && jjOrbSum > 0) {
          if (isFreeSpins) {
            _jjMs.freeMult = (_jjMs.freeMult || 0) + jjOrbSum;
            jjAppliedMult = Math.max(1, _jjMs.freeMult);
          } else {
            jjAppliedMult = jjOrbSum;
          }
          totalWinAmount = Math.floor(totalWinAmount * jjAppliedMult);
        }

        // Jackpot trigger chance (very rare 0.04% chance)
        let triggerJackpot = false;
        let jackpotType = 'MINI';
        let jackpotWinAmount = 0;

        if (Math.random() < 0.0004) {
          triggerJackpot = true;
          const jpRand = Math.random();
          if (jpRand < 0.02) { jackpotType = 'GRAND'; jackpotWinAmount = betAmount * 250; }
          else if (jpRand < 0.10) { jackpotType = 'MAJOR'; jackpotWinAmount = betAmount * 80; }
          else if (jpRand < 0.35) { jackpotType = 'MINOR'; jackpotWinAmount = betAmount * 30; }
          else { jackpotType = 'MINI'; jackpotWinAmount = betAmount * 12; }
          totalWinAmount += jackpotWinAmount;
        }

        // Free Spins Trigger controlled by rtpOutcome
        let triggerFreeSpins = !isFreeSpins && rtpOutcome.isScatter;
        let freeSpinsAwarded = triggerFreeSpins ? 8 : 0;

        user && (user.coins += Math.floor(totalWinAmount));
        if (!isGuestMode && user) await user.save();

        const newBalance = isGuestMode ? guestBalance + Math.floor(totalWinAmount) : (user.coins || 0) + (user.bonusCoins || 0);

        socket.emit('jinji_result', {
          multGrid,
          multiplier: {
            steps: SLOT_LADDER,
            idx: 0,
            applied: jjAppliedMult,
            isFree: !!isFreeSpins,
            freeMult: isFreeSpins ? (_jjMs.freeMult || 0) : 0
          },
          roundOrbsSum: jjOrbSum,
          grid,
          winAmount: Math.floor(totalWinAmount),
          winningSymbols,
          triggerJackpot,
          jackpotType,
          jackpotWinAmount,
          triggerFreeSpins,
          freeSpinsAwarded,
          newBalance,
          coins: user ? user.coins : newBalance,
          bonusCoins: user ? (user.bonusCoins || 0) : 0,
          winType: totalWinAmount > bet * 100 ? 'mega_win' : totalWinAmount > bet * 30 ? 'big_win' : totalWinAmount > 0 ? 'win' : 'normal'
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
        const bet = Number(betAmount);
        if (!Number.isFinite(bet) || bet < 500 || bet > 100000) {
          return socket.emit('mahjong_error', { message: 'Taruhan harus antara 500 sampai 100.000 koin' });
        }

        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 100000;

        if (!user) {
          isGuestMode = true;
          if (guestBalance < bet && !isFreeSpins) {
            return socket.emit('mahjong_error', { message: 'Koin tidak cukup' });
          }
          if (!isFreeSpins) guestBalance -= bet;
        } else {
          await checkAndCleanExpiredBonus(user);
          const totalAvailable = (user.coins || 0) + (user.bonusCoins || 0);
          if (totalAvailable < bet && !isFreeSpins) {
            return socket.emit('mahjong_error', { message: 'Koin tidak cukup' });
          }
          if (!isFreeSpins) {
            spendSlotCoins(user, bet);
          }
        }

        // Weighted symbol picker for Mahjong 2 (Authentic PG Soft odds)
        const weights = [
          { sym: 0, weight: 6 },  // Green Dragon
          { sym: 1, weight: 7 },  // Red Dragon
          { sym: 2, weight: 8 },  // Blue Dragon
          { sym: 3, weight: 12 }, // 8 Bam
          { sym: 4, weight: 14 }, // 8 Dot
          { sym: 5, weight: 15 }, // 8 Wan
          { sym: 6, weight: 18 }, // 5 Bam
          { sym: 7, weight: 20 }, // 5 Dot
          { sym: 8, weight: 5 },  // Wild Ingot
          { sym: 9, weight: 1.2 } // Scatter Ingot (Authentic ~0.6% trigger rate across 20 tiles)
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
        const rtpOutcome = determineSpinOutcome({ isFreeSpins });
        let currentGrid = [];
        let currentGoldGrid = [];
        let scatterCount = 0;

        for (let r = 0; r < ROWS; r++) {
          const row = [];
          const gRow = [];
          for (let c = 0; c < COLS; c++) {
            let sym = pickSym();
            if (sym === 9) sym = 6; // Clear random scatters first
            if (sym === 8 && (!rtpOutcome.isHit || Math.random() > 0.20)) sym = 7;
            row.push(sym);
            // Low chance for regular symbol on col 1,2,3 to be gold-plated
            gRow.push(sym < 8 && c >= 1 && c <= 3 && rtpOutcome.isHit && Math.random() < 0.12);
          }
          currentGrid.push(row);
          currentGoldGrid.push(gRow);
        }

        if (!rtpOutcome.isHit && !rtpOutcome.isScatter) {
          // Break any 3-reel ways matches on cols 0, 1, 2
          const col0Pool = [0, 1, 2];
          const col1Pool = [3, 4, 5];
          const col2Pool = [6, 7, 6];
          for (let r = 0; r < ROWS; r++) {
            currentGrid[r][0] = col0Pool[r % col0Pool.length];
            currentGrid[r][1] = col1Pool[r % col1Pool.length];
            currentGrid[r][2] = col2Pool[r % col2Pool.length];
            currentGoldGrid[r][1] = false;
            currentGoldGrid[r][2] = false;
          }
        } else if (rtpOutcome.isHit) {
          const col0Pool = [0, 1, 2];
          const col1Pool = [3, 4, 5];
          const col2Pool = [6, 7, 6];
          for (let r = 0; r < ROWS; r++) {
            currentGrid[r][0] = col0Pool[r % col0Pool.length];
            currentGrid[r][1] = col1Pool[r % col1Pool.length];
            currentGrid[r][2] = col2Pool[r % col2Pool.length];
          }
          const hitSym = rtpOutcome.winTier === 'mega' ? 2 : (rtpOutcome.winTier === 'big' ? 4 : (5 + Math.floor(Math.random() * 3)));
          const targetCols = rtpOutcome.winTier === 'mega' ? 4 : 3;
          for (let c = 0; c < targetCols; c++) {
            currentGrid[1][c] = hitSym;
          }
          if (targetCols < COLS) {
            for (let r = 0; r < ROWS; r++) {
              if (currentGrid[r][targetCols] === hitSym || currentGrid[r][targetCols] === 8) {
                currentGrid[r][targetCols] = (hitSym + 1) % 8;
              }
            }
          }
        }

        if (rtpOutcome.isScatter) {
          currentGrid[0][0] = 9;
          currentGrid[1][2] = 9;
          currentGrid[2][4] = 9;
          scatterCount = 3;
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

        const _ms = slotMS(socket.id, 'mahjong');
        if (!isFreeSpins) _ms.freeMult = 1;
        let totalWinAmount = 0;
        let lastLadderIdx = 0;
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
          const ladder = SLOT_LADDER[Math.min(step, SLOT_LADDER.length - 1)];
          const stepMult = isFreeSpins ? (_ms.freeMult + ladder - 1) : ladder;
          lastLadderIdx = Math.min(step, SLOT_LADDER.length - 1);
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
            if (isFreeSpins) _ms.freeMult += 1;
            gridHistory.push({
              grid: currentGrid.map(r => [...r]),
              goldGrid: currentGoldGrid.map(r => [...r]),
              winPositions,
              stepWin,
              ladderIdx: lastLadderIdx,
              multiplierValue: stepMult
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

        const newBalance = isGuestMode ? guestBalance + Math.floor(totalWinAmount) : (user.coins || 0) + (user.bonusCoins || 0);

        socket.emit('mahjong_result', {
          freeMult: isFreeSpins ? _ms.freeMult : 0,
          lastLadderIdx,
          initialGrid,
          initialGoldGrid,
          gridHistory,
          totalWinAmount: Math.floor(totalWinAmount),
          triggerFreeSpins,
          freeSpinsAwarded,
          newBalance,
          coins: user ? user.coins : newBalance,
          bonusCoins: user ? (user.bonusCoins || 0) : 0,
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
        const bet = Number(betAmount);
        if (!Number.isFinite(bet) || bet < 500 || bet > 100000) return socket.emit('wildwest_error', { message: 'Taruhan harus antara 500 sampai 100.000 koin' });

        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 100000;

        if (!user) {
          isGuestMode = true;
          if (guestBalance < bet && !isFreeSpins) return socket.emit('wildwest_error', { message: 'Koin tidak cukup' });
          if (!isFreeSpins) guestBalance -= bet;
        } else {
          await checkAndCleanExpiredBonus(user);
          const totalAvailable = (user.coins || 0) + (user.bonusCoins || 0);
          if (totalAvailable < bet && !isFreeSpins) return socket.emit('wildwest_error', { message: 'Koin tidak cukup' });
          if (!isFreeSpins) {
            spendSlotCoins(user, bet);
          }
        }

        const ROWS = 4, COLS = 5;
        const betUnit = Math.max(1, Math.floor(betAmount / 40));

        // sym 0=sheriff 1=outlaw 2=cowgirl 3=lady 4=gold 5=holster 6=A 7=K 8=Q 9=J 10=10 11=scatter 12=wild
        const WTS = [2, 3, 4, 5, 6, 7, 12, 13, 14, 15, 16, 1, 1];
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
          return 8;
        };

        const MULT_VALS = [2, 2, 2, 3, 3, 5];
        const randMult = () => MULT_VALS[Math.floor(Math.random() * MULT_VALS.length)];

        // Generate 5x4 grid
        let initialGrid = [];
        let initialWildMultGrid = [];
        let scatterCount = 0;
        let currentStickyMap = new Map();
        if (isFreeSpins && Array.isArray(stickyWilds)) {
          stickyWilds.forEach(w => currentStickyMap.set(`${w.r}-${w.c}`, w.mult));
        }

        // Low RTP & Hit Frequency Mathematical Model
        const rtpOutcome = determineSpinOutcome({ isFreeSpins });

        for (let r = 0; r < ROWS; r++) {
          const row = [], mRow = [];
          for (let c = 0; c < COLS; c++) {
            const key = `${r}-${c}`;
            if (isFreeSpins && currentStickyMap.has(key)) {
              row.push(12);
              mRow.push(currentStickyMap.get(key));
            } else {
              let s = pick(c);
              if (s === 11) s = 9; // Clear random scatters first
              // Batasi kemunculan Sticky Wild baru saat Free Spins (maksimal 2 di papan dan peluang kecil)
              if (s === 12 && (isFreeSpins ? (currentStickyMap.size >= 2 || Math.random() > 0.15) : (!rtpOutcome.isHit || Math.random() > 0.25))) {
                s = 8 + (r + c) % 3;
              }
              row.push(s);
              mRow.push(s === 12 ? randMult() : 0);
            }
          }
          initialGrid.push(row);
          initialWildMultGrid.push(mRow);
        }

        if (!rtpOutcome.isHit && !rtpOutcome.isScatter) {
          // Break line matches across reels 0, 1, 2 (even during Free Spins with Sticky Wilds!)
          // Reel 0 uses [6, 7], while non-sticky cells on Reels 1 & 2 use [8, 9, 10] so 3-of-a-kind cannot form
          const col0Pool = [6, 7, 6, 7];
          const col12Pool = [8, 9, 10, 8];
          for (let r = 0; r < ROWS; r++) {
            initialGrid[r][0] = col0Pool[r % col0Pool.length];
            initialWildMultGrid[r][0] = 0;
            if (!currentStickyMap.has(`${r}-1`)) {
              initialGrid[r][1] = col12Pool[r % col12Pool.length];
              initialWildMultGrid[r][1] = 0;
            }
            if (!currentStickyMap.has(`${r}-2`)) {
              initialGrid[r][2] = col12Pool[(r + 1) % col12Pool.length];
              initialWildMultGrid[r][2] = 0;
            }
          }
        } else if (rtpOutcome.isHit) {
          // Break accidental matches first, then plant 1 controlled low-value payline
          const col0Pool = [6, 7, 6, 7];
          const col12Pool = [8, 9, 10, 8];
          for (let r = 0; r < ROWS; r++) {
            initialGrid[r][0] = col0Pool[r % col0Pool.length];
            if (!currentStickyMap.has(`${r}-1`)) initialGrid[r][1] = col12Pool[r % col12Pool.length];
            if (!currentStickyMap.has(`${r}-2`)) initialGrid[r][2] = col12Pool[(r + 1) % col12Pool.length];
          }
          const hitSym = rtpOutcome.winTier === 'mega' ? 2 : (rtpOutcome.winTier === 'big' ? 4 : (6 + Math.floor(Math.random() * 5)));
          const targetCols = rtpOutcome.winTier === 'mega' ? 4 : 3;
          const payline = PAYLINES[Math.floor(Math.random() * 4)];
          for (let c = 0; c < targetCols; c++) {
            const rr = payline[c];
            if (!currentStickyMap.has(`${rr}-${c}`)) {
              initialGrid[rr][c] = hitSym;
              initialWildMultGrid[rr][c] = 0;
            }
          }
          if (targetCols < COLS) {
            for (let r = 0; r < ROWS; r++) {
              if (!currentStickyMap.has(`${r}-${targetCols}`) && (initialGrid[r][targetCols] === hitSym || initialGrid[r][targetCols] === 12)) {
                initialGrid[r][targetCols] = (hitSym + 1) % 11;
                initialWildMultGrid[r][targetCols] = 0;
              }
            }
          }
        }
        if (rtpOutcome.isScatter && !isFreeSpins) {
          // Stamp 3 scatters on reels 0, 2, 4
          initialGrid[Math.floor(Math.random() * ROWS)][0] = 11;
          initialGrid[Math.floor(Math.random() * ROWS)][2] = 11;
          initialGrid[Math.floor(Math.random() * ROWS)][4] = 11;
          scatterCount = 3;
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

        // Di Wild West Gold: pengali sudah dihitung per garis kemenangan yang melewati Wild (lineMult).
        // Jangan mengalikan ulang secara otomatis di setiap putaran Free Spins bila tidak kena Wild!
        const triggerFreeSpins = isFreeSpins ? (scatterCount >= 2) : (scatterCount >= 3);
        const freeSpinsAwarded = isFreeSpins ? (scatterCount >= 3 ? 8 : scatterCount === 2 ? 4 : 0) : (scatterCount >= 3 ? 8 : 0);

        if (user) user.coins += Math.floor(totalWinAmount);
        if (!isGuestMode && user) await user.save();
        const newBalance = isGuestMode ? guestBalance + Math.floor(totalWinAmount) : (user.coins || 0) + (user.bonusCoins || 0);

        socket.emit('wildwest_result', {
          multiplier: { steps: SLOT_LADDER, idx: 0, applied: 1, isFree: !!isFreeSpins, freeMult: 0 },
          initialGrid,
          initialWildMultGrid,
          winningCells: Array.from(winningCells),
          totalWinAmount: Math.floor(totalWinAmount),
          triggerFreeSpins,
          freeSpinsAwarded,
          newStickyWilds,
          newBalance,
          coins: user ? user.coins : newBalance,
          bonusCoins: user ? (user.bonusCoins || 0) : 0,
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
    socket.on('spin_candy', async ({ username, betAmount, actualBet, isFreeSpins, anteMode, clientBalance }) => {
      try {
        const bet = Number(betAmount);
        if (!Number.isFinite(bet) || bet < 500 || bet > 100000) return socket.emit('candy_error', { message: 'Taruhan harus antara 500 sampai 100.000 koin' });

        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 100000;
        const isAnte = Boolean(anteMode);
        const betDeduction = actualBet || (isAnte ? Math.floor(bet * 1.25) : bet);

        if (!user) {
          isGuestMode = true;
          if (guestBalance < betDeduction && !isFreeSpins) return socket.emit('candy_error', { message: 'Koin tidak cukup' });
          if (!isFreeSpins) guestBalance -= betDeduction;
        } else {
          await checkAndCleanExpiredBonus(user);
          const totalAvailable = (user.coins || 0) + (user.bonusCoins || 0);
          if (totalAvailable < betDeduction && !isFreeSpins) return socket.emit('candy_error', { message: 'Koin tidak cukup' });
          if (!isFreeSpins) {
            spendSlotCoins(user, betDeduction);
          }
        }

        const ROWS = 5, COLS = 6;
        const betUnit = Math.max(1, Math.floor(betAmount / 100));
        // sym 0=lollipop 1=cane 2=gummy 3=gold 4=pink 5=green 6=blue 7=purple 8=red 9=scatter 10=bomb
        const _ms = slotMS(socket.id, 'candy');
        if (!isFreeSpins) _ms.freeMult = 0;
        // WTS with scatter (sym 9) weight boosted from 3 to 7 when anteMode is true (double+ scatter rate)
        const WTS = [1, 2, 3, 5, 6, 7, 8, 9, 10, isAnte ? 7 : 3, 2];
        const TWS = WTS.reduce((a, b) => a + b, 0);
        const pick = () => {
          let r = Math.random() * TWS;
          for (let i = 0; i < WTS.length; i++) {
            r -= WTS[i];
            if (r <= 0) return i;
          }
          return 4;
        };
        // Paytable 8+ simbol sejenis (Sweet Bonanza / Candy Rush Authentic Scatter Pays - minimal 8 simbol!)
        const PT = {
          0: { 8: 10,  10: 25,  12: 50 },
          1: { 8: 5,   10: 15,  12: 25 },
          2: { 8: 3,   10: 10,  12: 15 },
          3: { 8: 2,   10: 5,   12: 12 },
          4: { 8: 1.5, 10: 3,   12: 10 },
          5: { 8: 1,   10: 2,   12: 8  },
          6: { 8: 0.8, 10: 1.5, 12: 5  },
          7: { 8: 0.5, 10: 1,   12: 4  },
          8: { 8: 0.25,10: 0.75,12: 2  },
        };
        const SP = { 4: 3, 5: 5, 6: 100 };
        const gcp = (s, cnt) => {
          if (!PT[s]) return 0; let p = 0;
          for (const t of Object.keys(PT[s]).map(Number).sort((a, b) => a - b)) if (cnt >= t) p = PT[s][t];
          return p;
        };
        const rm = () => pickAuthenticMultiplier(500);

        // Low RTP & Hit Frequency Mathematical Model
        const rtpOutcome = determineSpinOutcome({ isFreeSpins, anteMode });

        let cg = [], cmg = [], scatterCount = 0;
        for (let r = 0; r < ROWS; r++) {
          const row = [], mr = [];
          for (let c = 0; c < COLS; c++) {
            row.push(pick());
            mr.push(0);
          }
          cg.push(row);
          cmg.push(mr);
        }

        // Enforce low Hit Frequency and RTP
        sanitizeClusterGrid(cg, ROWS, COLS, rtpOutcome, pick, 9, 10);
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            if (cg[r][c] === 9) scatterCount++;
          }
        }

        // Drop multiplier bombs (peluang kecil agar jarang kali besar)
        const candyMultChance = isFreeSpins ? 0.12 : (anteMode ? 0.08 : 0.05);
        if (Math.random() < candyMultChance) {
          const br = Math.floor(Math.random() * ROWS);
          const bc = Math.floor(Math.random() * COLS);
          if (cg[br][bc] !== 9) {
            cg[br][bc] = 10;
            cmg[br][bc] = rm();
          }
        }

        const ig = cg.map(r => [...r]), imr = cmg.map(r => [...r]);
        let baseTumbleWin = 0;
        const tumbleSteps = [];

        for (let t = 0; t < 10; t++) {
          const sc2 = {}, sp2 = {};
          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              const s = cg[r][c];
              if (s !== 9 && s !== 10) {
                sc2[s] = (sc2[s] || 0) + 1;
                if (!sp2[s]) sp2[s] = [];
                sp2[s].push(r + '-' + c);
              }
            }
          }
          let sw = 0; const wp = new Set();
          for (const [ss, cnt] of Object.entries(sc2)) {
            const pm = gcp(parseInt(ss), cnt);
            if (pm > 0) { sw += Math.floor(pm * betAmount); sp2[ss].forEach(p => wp.add(p)); }
          }
          if (sw <= 0) break;
          baseTumbleWin += sw;
          // Hanya simbol permen pemenang (wp) yang pecah; bom pengali (10) tetap di papan sampai akhir tumble!
          const ar = new Set([...wp]);
          const ng = cg.map(r => [...r]), nm = cmg.map(r => [...r]);
          for (let c = 0; c < COLS; c++) {
            let wr = ROWS - 1;
            for (let r = ROWS - 1; r >= 0; r--) if (!ar.has(r + '-' + c)) { ng[wr][c] = cg[r][c]; nm[wr][c] = cmg[r][c]; wr--; }
            while (wr >= 0) {
              let ns = pick();
              if (ns === 9) ns = 5 + Math.floor(Math.random() * 4);
              let nmVal = 0;
              if (ns === 10) {
                if (t === 0 && Math.random() < (isFreeSpins ? 0.008 : 0.003)) {
                  nmVal = rm();
                } else {
                  ns = 5 + Math.floor(Math.random() * 4);
                }
              }
              ng[wr][c] = ns;
              nm[wr][c] = nmVal;
              wr--;
            }
          }
          // Batasi rantai runtuhan (tumble) maksimal 1-2 kali
          if (t >= 1 || Math.random() < 0.75) {
            sanitizeClusterGrid(ng, ROWS, COLS, { isHit: false, isScatter: false }, pick, 9, 10);
          }
          tumbleSteps.push({ winPositions: Array.from(ar), stepWin: sw, multiplierValue: 1, ladderIdx: Math.min(t, 3), newGrid: ng.map(r => [...r]), newMultGrid: nm.map(r => [...r]) });
          cg = ng; cmg = nm;
        }

        // Hitung jumlah seluruh bom pengali yang ada di layar pada akhir runtuhan putaran ini
        let spinOrbsSum = 0;
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            if (cg[r][c] === 10 && cmg[r][c] > 0) {
              spinOrbsSum += cmg[r][c];
            }
          }
        }

        // Aturan Resmi Pragmatic Play:
        // Saat Free Spins, kemenangan HANYA dikalikan dengan Total Pengali apabila pada putaran tersebut
        // ADA bom pengali yang turun (spinOrbsSum > 0) DAN ADA pecahan menang (baseTumbleWin > 0)!
        let finalMultiplier = 1;
        let totalWin = 0;
        if (baseTumbleWin > 0) {
          if (isFreeSpins) {
            if (spinOrbsSum > 0) {
              _ms.freeMult = (_ms.freeMult || 0) + spinOrbsSum;
              finalMultiplier = Math.max(1, _ms.freeMult);
              totalWin = baseTumbleWin * finalMultiplier;
            } else {
              finalMultiplier = 1;
              totalWin = baseTumbleWin;
            }
          } else {
            if (spinOrbsSum > 0) {
              finalMultiplier = spinOrbsSum;
              totalWin = baseTumbleWin * finalMultiplier;
            } else {
              finalMultiplier = 1;
              totalWin = baseTumbleWin;
            }
          }
        } else {
          finalMultiplier = 1;
          totalWin = 0;
        }

        const spm = SP[Math.min(scatterCount, 6)] || 0;
        if (spm > 0) totalWin += betAmount * spm;
        const tf = isFreeSpins ? (scatterCount >= 3) : (scatterCount >= 4);
        const fa = isFreeSpins ? (scatterCount >= 3 ? 5 : 0) : (scatterCount >= 4 ? 10 : 0);
        if (user) user.coins += Math.floor(totalWin);
        if (!isGuestMode && user) await user.save();
        const nb = isGuestMode ? guestBalance + Math.floor(totalWin) : (user.coins || 0) + (user.bonusCoins || 0);
        socket.emit('candy_result', {
          freeMult: isFreeSpins ? (_ms.freeMult || 0) : 0,
          appliedMultiplier: finalMultiplier,
          roundOrbsSum: spinOrbsSum,
          baseTumbleWin,
          initialGrid: ig, initialMultGrid: imr, tumbleSteps, scatterCount,
          totalWinAmount: Math.floor(totalWin), triggerFreeSpins: tf, freeSpinsAwarded: fa, newBalance: nb,
          coins: user ? user.coins : nb,
          bonusCoins: user ? (user.bonusCoins || 0) : 0,
          winType: totalWin > betAmount * 100 ? 'mega_win' : totalWin > betAmount * 20 ? 'big_win' : totalWin > 0 ? 'win' : 'normal'
        });
      } catch (err) {
        console.error('Candy Rush error:', err);
        socket.emit('candy_error', { message: 'Server error' });
      }
    });

    // =====================================================
    // GLOBAL CHAT
    // =====================================================
    socket.on('join_global_chat', () => {
      // Chat rooms can just be a global broadcast, no need to join a specific room for now
      // Or we can join 'global_chat' room
      socket.join('global_chat');
    });

    socket.on('send_global_msg', async (data) => {
      // data: { username, message }
      if (!data.username || !data.message) return;
      
      try {
        const user = await User.findOne({ username: data.username });
        const avatar = user ? user.avatar : '/bg.png';
        const vipLevel = user ? user.vipLevel : 0;
        
        io.to('global_chat').emit('receive_global_msg', {
          id: Date.now().toString() + Math.random().toString(36).substr(2, 5),
          username: data.username,
          avatar: avatar,
          vipLevel: vipLevel,
          message: data.message,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error('Error sending global msg:', err);
      }
    });

    // =====================================================
    // BY ONE ADU TARUHAN HANDLERS (MULTI-CAPACITY & REAL PLAYERS)
    // Billiard: 2 players | Domino: 4 players | QiuQiu: 6 players
    // =====================================================
    const getCapacityForMode = (mode) => {
      if (mode === 'billiard') return 2;
      if (mode === 'domino') return 4;
      if (mode === 'qiuqiu') return 6;
      return 2;
    };

    socket.on('byone_create_custom_room', async ({ username, mode, betAmount }) => {
      try {
        const rawBet = parseInt(betAmount, 10);
        const bet = Number.isFinite(rawBet) ? Math.min(500000, Math.max(5000, rawBet)) : 20000;
        const user = await User.findOne({ username });
        if (user) await checkAndCleanExpiredBonus(user);
        const regularCoins = user ? (user.coins || 0) : 0;
        if (!user || regularCoins < bet) {
          const msg = user && user.bonusCoins > 0 && (regularCoins + user.bonusCoins) >= bet
            ? `⚠️ Koin klaim bonus harian (${(user.bonusCoins || 0).toLocaleString('id-ID')} koin) hanya untuk game SLOT! Koin By One Anda: ${regularCoins.toLocaleString('id-ID')} koin (Butuh: ${bet.toLocaleString('id-ID')} koin). Putar di game slot untuk mengubah bonus menjadi koin universal!`
            : `Koin tidak cukup! Butuh minimal ${bet.toLocaleString('id-ID')} koin.`;
          socket.emit('byone_room_error', { message: msg });
          return;
        }

        let code = Math.floor(100000 + Math.random() * 900000).toString();
        while (byoneRooms.has(code)) {
          code = Math.floor(100000 + Math.random() * 900000).toString();
        }

        const gameMode = mode || 'domino';
        const maxPlayers = getCapacityForMode(gameMode);

        const roomData = {
          code,
          hostUsername: username,
          hostSocketId: socket.id,
          mode: gameMode,
          maxPlayers,
          betAmount: bet,
          pot: bet,
          createdAt: Date.now(),
          players: [
            {
              username,
              socketId: socket.id,
              avatar: user.avatar || '👑',
              vipLevel: user.vipLevel || 0,
              coins: user.coins,
              isHost: true,
            }
          ]
        };

        byoneRooms.set(code, roomData);
        socket.join(`byone_room_${code}`);
        socket.emit('byone_custom_room_created', { code, room: roomData });
      } catch (err) {
        console.error('byone_create_custom_room error:', err);
        socket.emit('byone_room_error', { message: 'Gagal membuat room By One.' });
      }
    });

    socket.on('byone_join_custom_room', async ({ username, code }) => {
      try {
        const cleanCode = String(code || '').replace(/[^0-9a-zA-Z]/g, '').trim();
        const roomData = byoneRooms.get(cleanCode);
        if (!roomData) {
          socket.emit('byone_room_error', { message: `Kode Kamar #${cleanCode || code} tidak ditemukan atau sudah ditutup.` });
          return;
        }

        const existingIdx = roomData.players.findIndex(p => p.username === username);
        if (existingIdx !== -1) {
          roomData.players[existingIdx].socketId = socket.id;
          socket.join(`byone_room_${cleanCode}`);
          socket.emit('byone_custom_room_created', { code: cleanCode, room: roomData });
          io.to(`byone_room_${cleanCode}`).emit('byone_room_updated', {
            code: cleanCode,
            room: roomData
          });
          return;
        }

        if (roomData.players.length >= roomData.maxPlayers) {
          socket.emit('byone_room_error', { message: `Kamar #${cleanCode} sudah penuh (${roomData.players.length}/${roomData.maxPlayers}).` });
          return;
        }

        const joiningUser = await User.findOne({ username });
        if (joiningUser) await checkAndCleanExpiredBonus(joiningUser);
        const regularCoins = joiningUser ? (joiningUser.coins || 0) : 0;
        if (!joiningUser || regularCoins < roomData.betAmount) {
          const msg = joiningUser && joiningUser.bonusCoins > 0 && (regularCoins + joiningUser.bonusCoins) >= roomData.betAmount
            ? `⚠️ Koin klaim bonus harian (${(joiningUser.bonusCoins || 0).toLocaleString('id-ID')} koin) hanya untuk game SLOT! Koin By One Anda: ${regularCoins.toLocaleString('id-ID')} koin (Butuh: ${roomData.betAmount.toLocaleString('id-ID')} koin). Putar di game slot untuk mengubah bonus menjadi koin universal!`
            : `Koin Anda tidak cukup! Butuh minimal ${roomData.betAmount.toLocaleString('id-ID')} koin.`;
          socket.emit('byone_room_error', { message: msg });
          return;
        }

        const newPlayer = {
          username: joiningUser.username,
          socketId: socket.id,
          avatar: joiningUser.avatar || '🐸',
          vipLevel: joiningUser.vipLevel || 0,
          coins: joiningUser.coins,
          isHost: false,
        };

        roomData.players.push(newPlayer);
        roomData.pot = roomData.betAmount * roomData.players.length;

        socket.join(`byone_room_${cleanCode}`);

        // Transition joining player into the waiting room view immediately
        socket.emit('byone_custom_room_created', { code: cleanCode, room: roomData });

        // Notify all sockets in this room of the newly joined player
        io.to(`byone_room_${cleanCode}`).emit('byone_room_player_joined', {
          code: cleanCode,
          room: roomData,
          newPlayer
        });
        io.to(`byone_room_${cleanCode}`).emit('byone_room_updated', {
          code: cleanCode,
          room: roomData
        });
      } catch (err) {
        console.error('byone_join_custom_room error:', err);
        socket.emit('byone_room_error', { message: 'Gagal bergabung ke kamar.' });
      }
    });

    socket.on('byone_start_custom_room', async ({ code, username }) => {
      try {
        const cleanCode = String(code || '').replace(/[^0-9a-zA-Z]/g, '').trim();
        const roomData = byoneRooms.get(cleanCode);
        if (!roomData) {
          socket.emit('byone_room_error', { message: 'Kamar tidak ditemukan.' });
          return;
        }
        if (roomData.hostUsername !== username) {
          socket.emit('byone_room_error', { message: 'Hanya pembuat kamar yang dapat memulai permainan.' });
          return;
        }
        if (roomData.players.length < 2) {
          socket.emit('byone_room_error', { message: 'Minimal butuh 2 pemain untuk memulai permainan!' });
          return;
        }

        // Deduct bet coins from all active players
        for (const p of roomData.players) {
          try {
            const u = await User.findOne({ username: p.username });
            if (u) {
              u.coins = Math.max(0, u.coins - roomData.betAmount);
              await u.save();
              p.coins = u.coins;
            }
          } catch (e) {
            console.error('Deducting coins error:', e);
          }
        }

        const pot = roomData.betAmount * roomData.players.length;
        roomData.pot = pot;

        // Register in byoneMatches so byone_move, double bet, and match finish work in Domino ByOneScreen
        const matchId = `byone_${cleanCode}`;
        byoneMatches.set(matchId, {
          matchId,
          tierId: 'custom',
          betAmount: roomData.betAmount,
          pot,
          mode: roomData.mode || 'domino',
          player1: roomData.players[0],
          player2: roomData.players[1],
          players: roomData.players,
          currentTurn: roomData.players[0].username,
          startedAt: Date.now()
        });

        // Broadcast duel start to all players in the room with the actual players list
        io.to(`byone_room_${cleanCode}`).emit('byone_room_duel_start', {
          code: cleanCode,
          mode: roomData.mode,
          betAmount: roomData.betAmount,
          pot,
          players: roomData.players,
          player1: roomData.players[0],
          player2: roomData.players[1]
        });

        byoneRooms.delete(cleanCode);
      } catch (err) {
        console.error('byone_start_custom_room error:', err);
        socket.emit('byone_room_error', { message: 'Gagal memulai duel.' });
      }
    });

    socket.on('byone_leave_custom_room', ({ code, username }) => {
      const cleanCode = String(code || '').replace(/[^0-9a-zA-Z]/g, '').trim();
      const roomData = byoneRooms.get(cleanCode);
      if (!roomData) return;

      const pIdx = roomData.players.findIndex(p => p.username === username);
      if (pIdx !== -1) {
        const removed = roomData.players.splice(pIdx, 1)[0];
        socket.leave(`byone_room_${cleanCode}`);
        if (removed.isHost || roomData.players.length === 0) {
          byoneRooms.delete(cleanCode);
          io.to(`byone_room_${cleanCode}`).emit('byone_room_closed', { message: 'Pembuat kamar telah menutup room.' });
        } else {
          roomData.pot = roomData.betAmount * roomData.players.length;
          io.to(`byone_room_${cleanCode}`).emit('byone_room_updated', { code: cleanCode, room: roomData });
        }
      }
    });

    socket.on('byone_cancel_custom_room', ({ code }) => {
      const cleanCode = String(code || '').replace(/[^0-9a-zA-Z]/g, '').trim();
      if (cleanCode) {
        byoneRooms.delete(cleanCode);
        io.to(`byone_room_${cleanCode}`).emit('byone_room_closed', { message: 'Kamar telah dibatalkan.' });
      }
    });

    // Billiard Real-time Shot Synchronization
    socket.on('billiard_join_room', ({ roomCode }) => {
      if (roomCode) socket.join(`billiard_room_${roomCode}`);
    });

    socket.on('billiard_shot', ({ roomCode, angle, power, spin, cueX, cueY }) => {
      if (roomCode) {
        socket.to(`billiard_room_${roomCode}`).emit('billiard_opponent_shot', { angle, power, spin, cueX, cueY });
      }
    });

    socket.on('join_byone_queue', async ({ username, tierId, betAmount, mode, customCode }) => {
      try {
        const bet = parseInt(betAmount, 10) || 50000;
        const user = await User.findOne({ username });
        const regularCoins = user ? (user.coins || 0) : 0;
        if (!user || regularCoins < bet) {
          const msg = user && user.bonusCoins > 0 && (regularCoins + user.bonusCoins) >= bet
            ? `⚠️ Koin klaim bonus harian (${(user.bonusCoins || 0).toLocaleString('id-ID')} koin) hanya untuk game SLOT! Koin duel Anda: ${regularCoins.toLocaleString('id-ID')} koin (Butuh: ${bet.toLocaleString('id-ID')} koin). Putar di game slot untuk mengubah bonus menjadi koin universal!`
            : `Koin tidak cukup! Butuh minimal ${bet.toLocaleString('id-ID')} koin.`;
          socket.emit('byone_error', { message: msg });
          return;
        }

        const queueKey = customCode ? `code_${customCode}` : `tier_${tierId}_${mode || 'gaple'}`;
        
        // Check if there is an opponent already waiting in this queue
        let opponent = null;
        for (const [qKey, qItem] of byoneQueues) {
          if (qKey === queueKey && qItem.username !== username && userSockets.get(qItem.username)) {
            opponent = qItem;
            byoneQueues.delete(qKey);
            break;
          }
        }

        if (opponent) {
          // Found opponent! Create live 1v1 match!
          const matchId = `byone_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
          const opponentUser = await User.findOne({ username: opponent.username });
          
          if (!opponentUser || opponentUser.coins < bet) {
            byoneQueues.set(queueKey, { socketId: socket.id, username, tierId, betAmount: bet, mode, customCode });
            socket.emit('byone_waiting', { queueKey });
            return;
          }

          // Deduct initial bet from both players
          user.coins = Math.max(0, user.coins - bet);
          await user.save();
          opponentUser.coins = Math.max(0, opponentUser.coins - bet);
          await opponentUser.save();

          const pot = bet * 2;
          const matchData = {
            matchId,
            tierId,
            betAmount: bet,
            pot,
            mode: mode || 'gaple',
            player1: { username, socketId: socket.id, avatar: user.avatar, vipLevel: user.vipLevel, coins: user.coins },
            player2: { username: opponent.username, socketId: opponent.socketId, avatar: opponentUser.avatar, vipLevel: opponentUser.vipLevel, coins: opponentUser.coins },
            currentTurn: Math.random() > 0.5 ? username : opponent.username,
            startedAt: Date.now()
          };

          byoneMatches.set(matchId, matchData);

          // Notify both players
          socket.emit('byone_matched', {
            matchId,
            isHost: true,
            myRole: 'player1',
            me: matchData.player1,
            opponent: matchData.player2,
            pot,
            betAmount: bet,
            currentTurn: matchData.currentTurn,
            mode: matchData.mode
          });

          const oppSocket = io.sockets.sockets.get(opponent.socketId);
          if (oppSocket) {
            oppSocket.emit('byone_matched', {
              matchId,
              isHost: false,
              myRole: 'player2',
              me: matchData.player2,
              opponent: matchData.player1,
              pot,
              betAmount: bet,
              currentTurn: matchData.currentTurn,
              mode: matchData.mode
            });
          }
        } else {
          // Put in waiting queue
          byoneQueues.set(queueKey, { socketId: socket.id, username, tierId, betAmount: bet, mode, customCode });
          socket.emit('byone_waiting', { queueKey, timeoutSec: 4 });
        }
      } catch (err) {
        console.error('join_byone_queue error:', err);
        socket.emit('byone_error', { message: 'Gagal mencari lawan by one.' });
      }
    });

    socket.on('cancel_byone_queue', ({ username }) => {
      for (const [key, item] of byoneQueues) {
        if (item.username === username || item.socketId === socket.id) {
          byoneQueues.delete(key);
        }
      }
      socket.emit('byone_cancelled');
    });

    socket.on('byone_move', ({ matchId, moveData, nextTurn, newBoard }) => {
      const match = byoneMatches.get(matchId);
      if (!match) return;

      match.currentTurn = nextTurn;
      const targetSocketId = socket.id === match.player1.socketId ? match.player2.socketId : match.player1.socketId;
      if (targetSocketId) {
        io.to(targetSocketId).emit('byone_opponent_moved', { moveData, nextTurn, newBoard });
      }
    });

    socket.on('byone_propose_double', ({ matchId, fromUsername, proposedPot }) => {
      const match = byoneMatches.get(matchId);
      if (!match) return;

      const targetSocketId = socket.id === match.player1.socketId ? match.player2.socketId : match.player1.socketId;
      if (targetSocketId) {
        io.to(targetSocketId).emit('byone_double_bet_offered', { fromUsername, proposedPot });
      }
    });

    socket.on('byone_respond_double', async ({ matchId, fromUsername, accepted, proposedPot }) => {
      const match = byoneMatches.get(matchId);
      if (!match) return;

      const targetSocketId = socket.id === match.player1.socketId ? match.player2.socketId : match.player1.socketId;

      if (accepted) {
        const addBet = Math.floor((proposedPot - match.pot) / 2);
        try {
          const [u1, u2] = await Promise.all([
            User.findOne({ username: match.player1.username }),
            User.findOne({ username: match.player2.username })
          ]);
          if (u1 && u2 && u1.coins >= addBet && u2.coins >= addBet) {
            u1.coins -= addBet; await u1.save();
            u2.coins -= addBet; await u2.save();
            match.pot = proposedPot;
            io.to(match.player1.socketId).emit('byone_pot_updated', { pot: proposedPot, myCoins: u1.coins });
            io.to(match.player2.socketId).emit('byone_pot_updated', { pot: proposedPot, myCoins: u2.coins });
          }
        } catch (e) {
          console.error('Error updating double bet:', e);
        }
      } else {
        const winnerUsername = socket.id === match.player1.socketId ? match.player2.username : match.player1.username;
        const winnerSocketId = targetSocketId;
        const pot = match.pot;

        try {
          const winnerUser = await User.findOne({ username: winnerUsername });
          if (winnerUser) {
            winnerUser.coins += pot;
            await winnerUser.save();
          }
          io.to(socket.id).emit('byone_match_ended', { winner: winnerUsername, pot, byFold: true, isMeWinner: false });
          if (winnerSocketId) {
            io.to(winnerSocketId).emit('byone_match_ended', { winner: winnerUsername, pot, byFold: true, isMeWinner: true, newCoins: winnerUser ? winnerUser.coins : undefined });
          }
          byoneMatches.delete(matchId);
        } catch (e) {
          console.error('Error folding byone match:', e);
        }
      }
    });

    socket.on('byone_match_finish', async ({ matchId, winnerUsername, potAmount }) => {
      const match = byoneMatches.get(matchId);
      if (!match) return;
      if (match.finished) return;
      match.finished = true;

      const pot = match.pot || potAmount || 0;

      try {
        const winnerUser = await User.findOne({ username: winnerUsername });
        if (winnerUser && pot > 0) {
          winnerUser.coins += pot;
          await winnerUser.save();
        }

        const p1Sock = userSockets.get(match.player1.username) || match.player1.socketId;
        const p2Sock = userSockets.get(match.player2.username) || match.player2.socketId;

        if (p1Sock) {
          io.to(p1Sock).emit('byone_match_ended', {
            winner: winnerUsername,
            pot,
            isMeWinner: match.player1.username === winnerUsername,
            newCoins: match.player1.username === winnerUsername && winnerUser ? winnerUser.coins : undefined
          });
        }
        if (p2Sock) {
          io.to(p2Sock).emit('byone_match_ended', {
            winner: winnerUsername,
            pot,
            isMeWinner: match.player2.username === winnerUsername,
            newCoins: match.player2.username === winnerUsername && winnerUser ? winnerUser.coins : undefined
          });
        }
        byoneMatches.delete(matchId);
      } catch (err) {
        console.error('byone_match_finish error:', err);
      }
    });

    // When a player exits / forfeits an active By One duel (Domino, Billiard, or QiuQiu), opponent auto-wins!
    socket.on('byone_forfeit', async ({ matchId, roomCode, username }) => {
      try {
        const cleanCode = roomCode ? String(roomCode).replace(/[^0-9a-zA-Z]/g, '').trim() : '';
        const targetMatchId = matchId || (cleanCode ? `byone_${cleanCode}` : '');
        let match = targetMatchId ? byoneMatches.get(targetMatchId) : null;
        let foundKey = targetMatchId;

        if (!match) {
          for (const [mKey, mVal] of byoneMatches) {
            const plist = mVal.players || [mVal.player1, mVal.player2].filter(Boolean);
            if (plist.some(p => p && (p.socketId === socket.id || (username && p.username === username)))) {
              match = mVal;
              foundKey = mKey;
              break;
            }
          }
        }

        const leaverName = username || socket.username || 'Lawan';

        if (match && !match.finished) {
          match.finished = true;
          const allPlayers = match.players || [match.player1, match.player2].filter(Boolean);
          const remainingList = allPlayers.filter(p => p && p.username !== leaverName && p.socketId !== socket.id);
          const winnerObj = remainingList[0] || (match.player1?.username === leaverName ? match.player2 : match.player1);
          const pot = match.pot || 0;

          if (winnerObj) {
            const winnerUser = await User.findOne({ username: winnerObj.username });
            if (winnerUser && pot > 0) {
              winnerUser.coins += pot;
              await winnerUser.save();
            }

            const payload = {
              winner: winnerObj.username,
              leaver: leaverName,
              pot,
              byFold: true,
              byOpponentLeft: true,
              isMeWinner: true,
              newCoins: winnerUser ? winnerUser.coins : undefined,
              message: `🏳️ ${leaverName} keluar dari pertandingan! Anda otomatis MENANG!`
            };

            const winnerSock = userSockets.get(winnerObj.username) || winnerObj.socketId;
            if (winnerSock) io.to(winnerSock).emit('byone_match_ended', payload);
            if (winnerObj.socketId && winnerObj.socketId !== winnerSock) {
              io.to(winnerObj.socketId).emit('byone_match_ended', payload);
            }
          }

          byoneMatches.delete(foundKey);
        }

        // Also notify billiard room if applicable
        if (cleanCode) {
          socket.to(`billiard_room_${cleanCode}`).emit('billiard_opponent_left', {
            leaver: leaverName,
            message: `🏳️ ${leaverName} keluar dari pertandingan! Anda otomatis MENANG!`
          });
        }
      } catch (err) {
        console.error('byone_forfeit error:', err);
      }
    });

    socket.on('byone_taunt', ({ matchId, toUsername, emote, text }) => {
      const targetSocketId = userSockets.get(toUsername);
      if (targetSocketId) {
        io.to(targetSocketId).emit('byone_taunt_received', { fromUsername: socket.username, emote, text });
      }
    });

    socket.on('byone_invite_player', ({ fromUsername, toUsername, betAmount, tierName, mode }) => {
      const targetSocketId = userSockets.get(toUsername);
      if (targetSocketId) {
        io.to(targetSocketId).emit('byone_challenge_received', {
          fromUsername,
          toUsername,
          betAmount,
          tierName: tierName || 'Meja Duel',
          mode: mode || 'gaple'
        });
        socket.emit('byone_challenge_sent', { toUsername });
      } else {
        socket.emit('byone_error', { message: `Pemain ${toUsername} sedang tidak online.` });
      }
    });

    socket.on('byone_respond_challenge', ({ fromUsername, toUsername, accepted, betAmount, mode, tierName }) => {
      const senderSocketId = userSockets.get(fromUsername);
      if (senderSocketId) {
        io.to(senderSocketId).emit('byone_challenge_responded', {
          fromUsername,
          toUsername,
          accepted,
          betAmount,
          mode,
          tierName
        });
      }
    });

    // =====================================================
    // GATES OF GATOKACA - 6x5 COUNT-BASED + TUMBLE + MULTIPLIER ORBS
    // =====================================================
    socket.on('spin_gatokaca', async ({ username, betAmount, actualBet, isFreeSpins, anteMode, clientBalance }) => {
      try {
        const bet = Number(betAmount);
        if (!Number.isFinite(bet) || bet < 500 || bet > 100000) return socket.emit('gatokaca_error', { message: 'Taruhan harus antara 500 sampai 100.000 koin' });

        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 100000;
        const isAnte = Boolean(anteMode);
        const betDeduction = actualBet || (isAnte ? Math.floor(bet * 1.25) : bet);

        if (!user) {
          isGuestMode = true;
          if (guestBalance < betDeduction && !isFreeSpins) {
            return socket.emit('gatokaca_error', { message: 'Koin tidak cukup' });
          }
          if (!isFreeSpins) guestBalance -= betDeduction;
        } else {
          await checkAndCleanExpiredBonus(user);
          const totalAvailable = (user.coins || 0) + (user.bonusCoins || 0);
          if (totalAvailable < betDeduction && !isFreeSpins) {
            return socket.emit('gatokaca_error', { message: 'Koin tidak cukup' });
          }
          if (!isFreeSpins) {
            spendSlotCoins(user, betDeduction);
          }
        }

        const ROWS = 5, COLS = 6;
        const _ms = slotMS(socket.id, 'gatokaca');
        if (!isFreeSpins) _ms.freeMult = 0;
        // AUTHENTIC PRAGMATIC PLAY REEL DISTRIBUTION:
        // 9 regular paying symbols (0..8) spread to give authentic ~26% hit frequency.
        // Symbols: 0 (Ring: 8), 1 (Lion: 9), 2 (Potion: 10), 3 (Pendant: 11),
        //          4 (Red: 12), 5 (Purple: 13), 6 (Yellow: 14), 7 (Green: 15), 8 (Blue: 16)
        // Scatter: 2.5 on regular (~0.6% / 1 in 165 spins), 3.2 on Ante Mode (~1.3% / 1 in 75 spins)
        const WTS = [8, 9, 10, 11, 12, 13, 14, 15, 16, isAnte ? 3.2 : 2.5];
        const TWS = WTS.reduce((a, b) => a + b, 0);

        const pick = () => {
          let r = Math.random() * TWS;
          for (let i = 0; i < WTS.length; i++) {
            r -= WTS[i];
            if (r <= 0) return i;
          }
          return 4;
        };

        // TABEL PEMBAYARAN RESMI GATES OF GATOTKACA 1000 (PRAGMATIC PLAY):
        // Sistem Scatter Pays (8+ simbol sejenis di mana saja di layar 6x5):
        // Tiers: 8-9 simbol, 10-11 simbol, 12-30 simbol (pengali terhadap total bet)
        const PT = {
          0: { 8: 10,   10: 25,   12: 50 },  // Cincin Ruby
          1: { 8: 2.5,  10: 10,   12: 25 },  // Singa Emas
          2: { 8: 2,    10: 5,    12: 15 },  // Ramuan Hijau
          3: { 8: 1.5,  10: 2,    12: 12 },  // Liontin Biru
          4: { 8: 1,    10: 1.5,  12: 10 },  // Permata Merah
          5: { 8: 0.8,  10: 1.2,  12: 8  },  // Permata Ungu
          6: { 8: 0.5,  10: 1,    12: 5  },  // Permata Kuning
          7: { 8: 0.4,  10: 0.9,  12: 4  },  // Permata Hijau
          8: { 8: 0.25, 10: 0.75, 12: 2  },  // Permata Biru
        };
        // Pembayaran Scatter (4: 3x, 5: 5x, 6+: 100x taruhan)
        const SP = { 4: 3, 5: 5, 6: 100 };

        const gcp = (s, cnt) => {
          if (!PT[s]) return 0;
          if (cnt >= 12) return PT[s][12];
          if (cnt >= 10) return PT[s][10];
          if (cnt >= 8) return PT[s][8];
          return 0;
        };

        // Bobot nilai pengali otentik Gates of Gatot Kaca 1000 (2x hingga 1.000x):
        // 2x-5x ~70%, 6x-12x ~20%, 15x-25x ~7.5%, 50x ~1.7%, 100x+ ~0.8% (Ultra rare)
        const pickMultVal = () => pickAuthenticMultiplier(1000);

        // RTP 96.26% & Hit Frequency 15.05% Mathematical Model
        const rtpOutcome = determineSpinOutcome({ isFreeSpins, anteMode });

        let cg = [], cmg = [], scatterCount = 0;
        for (let r = 0; r < ROWS; r++) {
          const row = [], mr = [];
          for (let c = 0; c < COLS; c++) {
            row.push(pick());
            mr.push(0);
          }
          cg.push(row);
          cmg.push(mr);
        }

        // Enforce low Hit Frequency and RTP
        sanitizeClusterGrid(cg, ROWS, COLS, rtpOutcome, pick, 9, 10);
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            if (cg[r][c] === 9) scatterCount++;
          }
        }

        // KAPAN BOLA PENGALI TURUN (Peluang diturunkan agar sulit menang besar):
        const gatoMultChance = isFreeSpins ? 0.12 : (anteMode ? 0.08 : 0.05);
        if (Math.random() < gatoMultChance) {
          const or = Math.floor(Math.random() * ROWS);
          const oc = Math.floor(Math.random() * COLS);
          if (cg[or][oc] !== 9) {
            cg[or][oc] = 10;
            cmg[or][oc] = pickMultVal();
          }
        }

        const ig = cg.map(r => [...r]);
        const imr = cmg.map(r => [...r]);
        let baseTumbleWin = 0;
        const tumbleSteps = [];

        // All multiplier orbs collected across the spin
        const collectedOrbs = new Set();
        const recordOrbs = (grid, mgrid) => {
          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              if (grid[r][c] === 10 && mgrid[r][c] > 0) {
                collectedOrbs.add(`${r}-${c}-${mgrid[r][c]}`);
              }
            }
          }
        };
        recordOrbs(ig, imr);

        for (let t = 0; t < 10; t++) {
          const sc2 = {}, sp2 = {};

          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              const s = cg[r][c];
              if (s !== 9 && s !== 10) {
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
            if (pm > 0) {
              sw += Math.floor(pm * betAmount);
              sp2[ss].forEach(p => wp.add(p));
            }
          }

          if (sw <= 0) break;
          baseTumbleWin += sw;

          // Only winning paying symbols explode; multiplier orbs stay on grid and drop down!
          const ar = new Set([...wp]);
          const ng = cg.map(r => [...r]);
          const nm = cmg.map(r => [...r]);
          for (let c = 0; c < COLS; c++) {
            let wr = ROWS - 1;
            for (let r = ROWS - 1; r >= 0; r--) {
              if (!ar.has(r + '-' + c)) { ng[wr][c] = cg[r][c]; nm[wr][c] = cmg[r][c]; wr--; }
            }
            while (wr >= 0) {
              let ns = pick();
              if (ns === 9) ns = 5 + Math.floor(Math.random() * 4); // Hindari penumpukan scatter saat tumble baru
              let nmVal = 0;
              if (t === 0 && Math.random() < (isFreeSpins ? 0.008 : 0.003)) {
                ns = 10;
                nmVal = pickMultVal();
              }
              ng[wr][c] = ns;
              nm[wr][c] = nmVal;
              wr--;
            }
          }
          // Batasi rantai runtuhan (tumble) maksimal 1-2 kali agar tidak pecah beruntun terus-menerus
          if (t >= 1 || Math.random() < 0.75) {
            sanitizeClusterGrid(ng, ROWS, COLS, { isHit: false, isScatter: false }, pick, 9, 10);
          }
          recordOrbs(ng, nm);
          tumbleSteps.push({
            winPositions: Array.from(ar), stepWin: sw,
            newGrid: ng.map(r => [...r]), newMultGrid: nm.map(r => [...r])
          });
          cg = ng; cmg = nm;
        }

        // Hitung total penjumlahan bola pengali di layar sesuai rumus:
        // M_total = M1 + M2 + ... + Mn
        let spinOrbsSum = 0;
        for (let r = 0; r < ROWS; r++) {
          for (let c = 0; c < COLS; c++) {
            if (cg[r][c] === 10 && cmg[r][c] > 0) {
              spinOrbsSum += cmg[r][c];
            }
          }
        }

        // SISTEM PERHITUNGAN PENGALI (GATES OF GATOTKACA 1000 - PRAGMATIC PLAY):
        // 1. Base Game: Jika terdapat kemenangan tumble dan terdapat bola pengali (spinOrbsSum > 0),
        //    maka total kemenangan tumble dikalikan jumlah seluruh pengali di layar (M_total).
        // 2. Free Spins: HANYA jika terdapat kemenangan tumble (baseTumbleWin > 0) DAN ada bola pengali
        //    yang turun di putaran ini (spinOrbsSum > 0), nilai pengali ditambahkan ke akumulasi TOTAL PENGALI (_ms.freeMult)
        //    dan kemenangan putaran ini dikalikan TOTAL PENGALI tersebut.
        //    Jika ada kemenangan tumble tetapi TIDAK ada bola pengali turun (spinOrbsSum === 0),
        //    maka kemenangan putaran ini TIDAK dikalikan dengan TOTAL PENGALI (finalMultiplier = 1)!
        let finalMultiplier = 1;
        let totalWin = 0;

        if (baseTumbleWin > 0) {
          if (isFreeSpins) {
            if (spinOrbsSum > 0) {
              _ms.freeMult = (_ms.freeMult || 0) + spinOrbsSum;
              finalMultiplier = Math.max(1, _ms.freeMult);
              totalWin = baseTumbleWin * finalMultiplier;
            } else {
              finalMultiplier = 1;
              totalWin = baseTumbleWin;
            }
          } else {
            if (spinOrbsSum > 0) {
              finalMultiplier = spinOrbsSum;
              totalWin = baseTumbleWin * finalMultiplier;
            } else {
              finalMultiplier = 1;
              totalWin = baseTumbleWin;
            }
          }
        } else {
          // Tidak ada kemenangan pecahan tumble: bola pengali tidak melipatgandakan dan tidak ditambahkan ke bank
          finalMultiplier = 1;
          totalWin = 0;
        }

        // Pembayaran Tunai Scatter (4: 3x, 5: 5x, 6+: 100x taruhan)
        if (scatterCount >= 4) {
          const spm = SP[Math.min(scatterCount, 6)] || 3;
          totalWin += Math.floor(betAmount * spm);
        }

        // ATURAN PEMICU & RETRIGGER PUTARAN GRATIS:
        // Base Game: 4 atau lebih Scatter memicu 15 Putaran Gratis.
        // Free Spins: 3 atau lebih Scatter memberikan +5 Putaran Gratis Tambahan!
        const tf = isFreeSpins ? (scatterCount >= 3) : (scatterCount >= 4);
        const fa = isFreeSpins ? (scatterCount >= 3 ? 5 : 0) : (scatterCount >= 4 ? 15 : 0);

        // BATAS MAKSIMUM KEMENANGAN (MAX WIN GATOTKACA 1000 = 15.000x BET)
        const maxWinCap = betAmount * 15000;
        if (totalWin > maxWinCap) totalWin = maxWinCap;

        if (user) user.coins += Math.floor(totalWin);
        if (!isGuestMode && user) await user.save();
        const nb = isGuestMode ? guestBalance + Math.floor(totalWin) : (user.coins || 0) + (user.bonusCoins || 0);

        socket.emit('gatokaca_result', {
          appliedMultiplier: finalMultiplier,
          roundOrbsSum: spinOrbsSum,
          freeMult: isFreeSpins ? (_ms.freeMult || 0) : 0,
          baseTumbleWin,
          totalWinAmount: Math.floor(totalWin),
          initialGrid: ig, initialMultGrid: imr, tumbleSteps, scatterCount,
          triggerFreeSpins: tf,
          freeSpinsAwarded: fa,
          newBalance: nb,
          coins: user ? user.coins : nb,
          bonusCoins: user ? (user.bonusCoins || 0) : 0,
          winType: totalWin > betAmount * 100 ? 'mega_win' : totalWin > betAmount * 20 ? 'big_win' : totalWin > 0 ? 'win' : 'normal'
        });

      } catch (err) {
        console.error('Gates of Gatotkaca error:', err);
        socket.emit('gatokaca_error', { message: 'Server error' });
      }
    });

  });
}

// =====================================================
// SLOT MULTIPLIER SYSTEM (kali 2, kali 3, ... ala slot asli)
//  - Base game  : tangga pengali x1 > x2 > x3 > x5 (tumble = per kemenangan beruntun,
//                 game garis = per putaran menang beruntun). Reset saat tidak menang.
//  - Free spins : pengali menumpuk & TIDAK reset sampai free spin habis
//                 (scatter dulu terpakai baru pengali bertambah).
// =====================================================
const SLOT_LADDER = [1, 2, 3, 5];
const slotMultStates = new Map();
function slotMS(socketId, game) {
  const k = socketId + ':' + game;
  if (!slotMultStates.has(k)) {
    if (slotMultStates.size > 3000) slotMultStates.delete(slotMultStates.keys().next().value);
    slotMultStates.set(k, { streak: 0, freeMult: 0 });
  }
  return slotMultStates.get(k);
}
function applyLineMultiplier(socket, game, isFreeSpins, baseWin, orbs = 0) {
  const st = slotMS(socket.id, game);
  let mult = 1, idx = 0;
  if (!isFreeSpins) st.freeMult = 0;
  if (baseWin > 0) {
    if (isFreeSpins) {
      if (orbs > 0) {
        st.freeMult = (st.freeMult || 0) + orbs;
        mult = Math.max(1, st.freeMult);
      } else {
        mult = 1;
      }
    } else {
      mult = orbs > 0 ? orbs : 1;
    }
  } else {
    if (!isFreeSpins) st.streak = 0;
    mult = 1;
  }
  return {
    mult,
    info: { steps: SLOT_LADDER, idx, applied: mult, isFree: !!isFreeSpins, freeMult: isFreeSpins ? (st.freeMult || 0) : 0 }
  };
}
function tumbleStepMult(st, isFreeSpins, t, orbs) {
  if (isFreeSpins) {
    if (orbs > 0) {
      st.freeMult = (st.freeMult || 0) + orbs;
      return Math.max(1, st.freeMult);
    }
    return 1;
  }
  return orbs > 0 ? orbs : 1;
}

module.exports = { initSocketIO };