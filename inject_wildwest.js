const fs = require('fs');
const content = fs.readFileSync('gameManager.js', 'utf8');
const insertBefore = '    // =====================================================\n    // CANDY RUSH';
const idx = content.indexOf(insertBefore);
if (idx === -1) { console.error('Pattern not found'); process.exit(1); }

const wildwestHandler = `
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

        // sym 0=sheriff 1=cowgirl 2=bandit 3=gold 4=gun 5=A 6=K 7=Q 8=J 9=scatter 10=wild
        const WTS = [2, 3, 4, 6, 7, 10, 12, 14, 15, 4, 4];
        const TWS = WTS.reduce((a, b) => a + b, 0);

        const pick = (col) => {
          let r = Math.random() * TWS;
          for (let i = 0; i < WTS.length; i++) {
            // Wild only on cols 1,2,3 (reels 2,3,4)
            if (i === 10 && (col === 0 || col === 4)) continue;
            // Scatter only on cols 0,2,4 (reels 1,3,5)
            if (i === 9 && (col === 1 || col === 3)) continue;
            r -= WTS[i];
            if (r <= 0) return i;
          }
          return 5;
        };

        const MULT_VALS = [2, 3, 5];
        const randMult = () => MULT_VALS[Math.floor(Math.random() * MULT_VALS.length)];

        // Generate 5x4 grid
        let initialGrid = [];
        let initialWildMultGrid = [];
        let scatterCount = 0;
        let currentStickyMap = new Map();
        if (isFreeSpins && Array.isArray(stickyWilds)) {
          stickyWilds.forEach(w => currentStickyMap.set(\`\${w.r}-\${w.c}\`, w.mult));
        }

        for (let r = 0; r < ROWS; r++) {
          const row = [], mRow = [];
          for (let c = 0; c < COLS; c++) {
            const key = \`\${r}-\${c}\`;
            if (isFreeSpins && currentStickyMap.has(key)) {
              row.push(10);
              mRow.push(currentStickyMap.get(key));
            } else {
              const s = pick(c);
              if (s === 9) scatterCount++;
              row.push(s);
              mRow.push(s === 10 ? randMult() : 0);
            }
          }
          initialGrid.push(row);
          initialWildMultGrid.push(mRow);
        }

        // 40 Paylines payouts for 3, 4, 5 of a kind
        const PAYTABLE = {
          0: { 3: 5, 4: 20, 5: 50 },  // Sheriff
          1: { 3: 3, 4: 12, 5: 30 },  // Cowgirl
          2: { 3: 2, 4: 8,  5: 20 },  // Bandit
          3: { 3: 2, 4: 5,  5: 15 },  // Gold
          4: { 3: 1, 4: 3,  5: 10 },  // Gun
          5: { 3: 1, 4: 2,  5: 5  },  // A
          6: { 3: 1, 4: 2,  5: 4  },  // K
          7: { 3: 1, 4: 1,  5: 3  },  // Q
          8: { 3: 1, 4: 1,  5: 2  },  // J
        };

        // Standard 40 payline definitions
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

            if (sym === 10) {
              // Wild substitute
              matchCount++;
              const mult = initialWildMultGrid[r][c] || 1;
              lineMult *= mult;
            } else if (sym !== 9) {
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
              winningCells.add(\`\${line[c]}-\${c}\`);
            }
          }
        }

        // Collect sticky wilds if in free spins or new wild landed during free spins
        if (isFreeSpins || scatterCount >= 3) {
          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              if (initialGrid[r][c] === 10) {
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

`;

const newContent = content.slice(0, idx) + wildwestHandler + content.slice(idx);
fs.writeFileSync('gameManager.js', newContent, 'utf8');
console.log('Done! Lines:', newContent.split('\n').length);
