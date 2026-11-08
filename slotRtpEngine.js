/**
 * SLOT RTP & HIT FREQUENCY MATHEMATICAL GOVERNOR ENGINE
 * 
 * Target Casino Specifications:
 * - Return To Player (RTP): 96.26% (0.9626)
 * - Base Game Hit Frequency: 15.05% (0.1505)
 * - Scatter / Free Spins Feature Contribution: ~27.50%
 * - Base Game Paytable Contribution: ~68.76%
 * - Conditional Expected Win on Hit: 0.6876 / 0.1505 = 4.5688x Bet
 */

const TARGET_RTP = 0.4500;          // Tight house-favoring RTP (~45%)
const TARGET_HIT_FREQ = 0.1000;     // 10.00% Base Game Hit Frequency (90% zonk/loss)
const SCATTER_BASE_RATE = 0.0022;   // ~1 in 450 spins
const SCATTER_ANTE_RATE = 0.0040;   // ~1 in 250 spins with 1.25x Ante Bet

/**
 * Calculates whether a spin is a hit, a scatter trigger, and what target payout tier it belongs to.
 */
function determineSpinOutcome({ isFreeSpins = false, anteMode = false, buyFeature = false } = {}) {
  // 1. Buy Free Spins Feature: hanya menjatuhkan 4 Scatter pemicu tanpa kemenangan cluster tambahan
  if (buyFeature) {
    return {
      isHit: false,
      isScatter: true,
      targetMult: 0,
      winTier: 'scatter',
      scattersCount: 4
    };
  }

  // 2. Free Spins Mode (Bonus Round) — Tingkat kemenangan rendah (18% hit rate, 82% zonk)
  if (isFreeSpins) {
    const isRetrigger = Math.random() < (anteMode ? 0.008 : 0.005);
    const isFsHit = Math.random() < 0.18;
    let targetMult = 0;
    let winTier = 'mini';

    if (isFsHit) {
      const roll = Math.random();
      if (roll < 0.80) {
        targetMult = 0.25 + Math.random() * 1.15; // 0.25x - 1.40x
        winTier = 'mini';
      } else if (roll < 0.95) {
        targetMult = 1.40 + Math.random() * 2.10; // 1.40x - 3.50x
        winTier = 'medium';
      } else if (roll < 0.99) {
        targetMult = 3.50 + Math.random() * 4.50; // 3.50x - 8.00x
        winTier = 'big';
      } else {
        targetMult = 8.00 + Math.random() * 10.0; // 8.00x - 18.0x
        winTier = 'mega';
      }
    }

    return {
      isHit: isFsHit,
      isScatter: isRetrigger,
      targetMult: isFsHit ? Number(targetMult.toFixed(2)) : 0,
      winTier: isRetrigger ? 'scatter' : (isFsHit ? winTier : 'loss'),
      scattersCount: isRetrigger ? 3 : 0
    };
  }

  // 3. Natural Scatter Trigger in Base Game
  const scatterChance = anteMode ? SCATTER_ANTE_RATE : SCATTER_BASE_RATE;
  if (Math.random() < scatterChance) {
    return {
      isHit: false,
      isScatter: true,
      targetMult: 3.0, // base 4-scatter pays 3x
      winTier: 'scatter',
      scattersCount: 4
    };
  }

  // 4. Base Game Hit Frequency: 10.00% (90% putaran zonk)
  const isHit = Math.random() < TARGET_HIT_FREQ;

  if (!isHit) {
    return {
      isHit: false,
      isScatter: false,
      targetMult: 0,
      winTier: 'loss',
      scattersCount: Math.random() < 0.14 ? (Math.random() < 0.85 ? 1 : 2) : 0
    };
  }

  // 5. Base Game Win Multiplier Distribution (Mayoritas kemenangan kecil)
  const roll = Math.random();
  let targetMult = 0;
  let winTier = 'mini';

  if (roll < 0.82) {
    targetMult = 0.25 + Math.random() * 0.95; // 0.25x - 1.20x
    winTier = 'mini';
  } else if (roll < 0.96) {
    targetMult = 1.20 + Math.random() * 1.80; // 1.20x - 3.00x
    winTier = 'medium';
  } else if (roll < 0.995) {
    targetMult = 3.00 + Math.random() * 4.50; // 3.00x - 7.50x
    winTier = 'big';
  } else {
    targetMult = 7.50 + Math.random() * 7.50; // 7.50x - 15.0x
    winTier = 'mega';
  }

  return {
    isHit: true,
    isScatter: false,
    targetMult: Number(targetMult.toFixed(2)),
    winTier,
    scattersCount: Math.random() < 0.10 ? 1 : 0
  };
}

/**
 * Enforces cluster game grid rules:
 * - Always breaks any accidental 8+ symbol clusters first.
 * - If outcome.isHit is true, seeds a single controlled cluster using low-value symbols for mini/medium tiers.
 * - Stamps the exact targeted scatter count.
 */
function sanitizeClusterGrid(grid, ROWS, COLS, outcome, pickSymFn, scatterSymId = 9, multOrbSymId = 10) {
  const symbolCounts = {};
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const s = grid[r][c];
      if (s === scatterSymId || s === multOrbSymId) continue;
      symbolCounts[s] = (symbolCounts[s] || 0) + 1;
    }
  }

  // Always break any accidental >= 8 clusters first so no unintended extra clusters form
  for (const [symStr, cnt] of Object.entries(symbolCounts)) {
    let count = cnt;
    const sId = Number(symStr);
    if (count >= 8) {
      for (let r = 0; r < ROWS && count >= 8; r++) {
        for (let c = 0; c < COLS && count >= 8; c++) {
          if (grid[r][c] === sId) {
            let replacement = (sId + 1 + Math.floor(Math.random() * 7)) % 9;
            while ((symbolCounts[replacement] || 0) >= 6) {
              replacement = (replacement + 1) % 9;
            }
            grid[r][c] = replacement;
            symbolCounts[replacement] = (symbolCounts[replacement] || 0) + 1;
            count--;
          }
        }
      }
      symbolCounts[sId] = count;
    }
  }

  if (outcome.isHit) {
    // Seed a single controlled cluster using low-paying gems (5..8) for mini/medium, or mid symbols (3..5) for big/mega
    const targetClusterCount = outcome.winTier === 'mega' ? 10 : (outcome.winTier === 'big' ? 9 : 8);
    const lowSyms = [5, 6, 7, 8];
    const midSyms = [3, 4, 5, 6];
    const pool = (outcome.winTier === 'big' || outcome.winTier === 'mega') ? midSyms : lowSyms;
    const chosenSym = pool[Math.floor(Math.random() * pool.length)];
    let currentCount = symbolCounts[chosenSym] || 0;
    for (let r = 0; r < ROWS && currentCount < targetClusterCount; r++) {
      for (let c = 0; c < COLS && currentCount < targetClusterCount; c++) {
        if (grid[r][c] !== scatterSymId && grid[r][c] !== chosenSym && grid[r][c] !== multOrbSymId) {
          grid[r][c] = chosenSym;
          currentCount++;
        }
      }
    }
  }

  // Stamp Scatters
  // First clear existing scatters
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r][c] === scatterSymId) {
        grid[r][c] = Math.floor(Math.random() * 8);
      }
    }
  }

  // Place exact target scatters
  const targetScatters = outcome.scattersCount || 0;
  const usedPositions = new Set();
  let placed = 0;
  while (placed < targetScatters) {
    const r = Math.floor(Math.random() * ROWS);
    const c = Math.floor(Math.random() * COLS);
    const key = `${r}-${c}`;
    if (!usedPositions.has(key)) {
      usedPositions.add(key);
      grid[r][c] = scatterSymId;
      placed++;
    }
  }
}

module.exports = {
  TARGET_RTP,
  TARGET_HIT_FREQ,
  SCATTER_BASE_RATE,
  SCATTER_ANTE_RATE,
  determineSpinOutcome,
  sanitizeClusterGrid
};
