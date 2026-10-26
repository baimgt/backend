const InboxMessage = require('../models/InboxMessage');

/**
 * Checks if user's bonus coins have expired.
 * If expired, resets bonusCoins to 0 and sends an Inbox alert (does NOT deduct regular coins).
 */
async function checkAndCleanExpiredBonus(user) {
  if (!user) return false;
  const now = new Date();
  
  if (user.bonusCoins > 0 && user.bonusCoinsExpireAt && now > new Date(user.bonusCoinsExpireAt)) {
    const expiredAmount = user.bonusCoins;
    
    // Only reset bonusCoins (do NOT deduct regular coins, since bonusCoins is separate)
    user.bonusCoins = 0;
    user.bonusCoinsExpireAt = null;
    
    await user.save();

    // Send inbox notification about expired bonus coins
    await InboxMessage.create({
      toUsername: user.username,
      fromUsername: 'SISTEM',
      type: 'system',
      title: '⏰ Bonus Koin Slot Hangus!',
      body: `Bonus koin slot sebanyak ${expiredAmount.toLocaleString('id-ID')} koin telah HANGUS karena tidak digunakan dalam 24 jam. Klaim bonus harian baru hari ini & putar di game slot untuk mengubahnya menjadi koin universal!`,
      icon: '⏰',
      isRead: false
    }).catch(() => {});

    return true;
  }
  return false;
}

/**
 * When user spends coins on slot games:
 * Deducts from bonusCoins first. If bonusCoins is insufficient, deducts remainder from regular coins.
 */
function spendSlotCoins(user, amountSpent) {
  if (!user || amountSpent <= 0) return;

  const bonus = user.bonusCoins || 0;
  if (bonus >= amountSpent) {
    user.bonusCoins -= amountSpent;
  } else {
    const remainder = amountSpent - bonus;
    user.bonusCoins = 0;
    user.bonusCoinsExpireAt = null;
    user.coins = Math.max(0, (user.coins || 0) - remainder);
  }

  if (user.bonusCoins === 0) {
    user.bonusCoinsExpireAt = null;
  }
}

// Alias for backwards compatibility
function spendUserCoins(user, amountSpent) {
  return spendSlotCoins(user, amountSpent);
}

module.exports = {
  checkAndCleanExpiredBonus,
  spendSlotCoins,
  spendUserCoins
};
