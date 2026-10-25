const fs = require('fs');
const content = fs.readFileSync('gameManager.js', 'utf8');
const insertBefore = '  });\n}\n\nmodule.exports = { initSocketIO };';
const idx = content.lastIndexOf(insertBefore);
if (idx === -1) { console.error('Pattern not found'); process.exit(1); }

const gatokacaHandler = `
    // =====================================================
    // GATES OF GATOKACA - 6x5 COUNT-BASED + TUMBLE + MULTIPLIER ORBS
    // =====================================================
    socket.on('spin_gatokaca', async ({ username, betAmount, isFreeSpins, anteMode, clientBalance }) => {
      try {
        let user = await User.findOne({ username });
        let isGuestMode = false;
        let guestBalance = clientBalance || 100000;

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
`;

const newContent = content.slice(0, idx) + gatokacaHandler + '\n' + insertBefore;
fs.writeFileSync('gameManager.js', newContent, 'utf8');
console.log('Done! Lines:', newContent.split('\n').length);
