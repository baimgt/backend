const CoinLog = require('../models/CoinLog');

/**
 * Record a coin transaction / audit log.
 * Runs asynchronously without blocking request/socket handlers.
 */
async function recordCoinLog({
  username,
  userId,
  source,
  gameName,
  type = 'gain',
  amount,
  balanceBefore,
  balanceAfter,
  description = '',
  meta = {}
}) {
  try {
    if (!username || !amount || amount <= 0) return;
    await CoinLog.create({
      username,
      userId: userId ? String(userId) : undefined,
      source,
      gameName: gameName || source,
      type,
      amount: Math.round(amount),
      balanceBefore: Math.round(balanceBefore || 0),
      balanceAfter: Math.round(balanceAfter || 0),
      description,
      meta
    });
  } catch (err) {
    console.error('[CoinLogger] Error saving coin log:', err.message);
  }
}

module.exports = {
  recordCoinLog
};
