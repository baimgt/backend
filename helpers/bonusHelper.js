const InboxMessage = require('../models/InboxMessage');

/**
 * Checks if user's bonus coins have expired.
 * If expired, deducts the unspent bonus coins, resets bonusCoins, and sends an Inbox alert.
 */
async function checkAndCleanExpiredBonus(user) {
  if (!user) return false;
  const now = new Date();
  
  if (user.bonusCoins > 0 && user.bonusCoinsExpireAt && now > new Date(user.bonusCoinsExpireAt)) {
    const expiredAmount = user.bonusCoins;
    
    // Deduct expired bonus coins
    user.coins = Math.max(0, user.coins - expiredAmount);
    user.bonusCoins = 0;
    user.bonusCoinsExpireAt = null;
    
    await user.save();

    // Send inbox notification about expired bonus coins
    await InboxMessage.create({
      toUsername: user.username,
      fromUsername: 'SISTEM',
      type: 'system',
      title: '⏰ Bonus Koin Hangus!',
      body: `Bonus koin sebanyak ${expiredAmount.toLocaleString('id-ID')} koin telah HANGUS karena tidak digunakan dalam 24 jam. Klaim bonus harian baru hari ini & gunakan sebelum hangus!`,
      icon: '⏰',
      isRead: false
    }).catch(() => {});

    return true;
  }
  return false;
}

/**
 * When user spends coins (playing slots, billiard, domino, or transfer),
 * deduct from bonusCoins first so bonus coins are saved from expiring!
 */
function spendUserCoins(user, amountSpent) {
  if (!user || amountSpent <= 0) return;

  if (user.bonusCoins > 0) {
    if (user.bonusCoins >= amountSpent) {
      user.bonusCoins -= amountSpent;
    } else {
      user.bonusCoins = 0;
      user.bonusCoinsExpireAt = null;
    }
  }

  if (user.bonusCoins === 0) {
    user.bonusCoinsExpireAt = null;
  }
}

module.exports = {
  checkAndCleanExpiredBonus,
  spendUserCoins
};
