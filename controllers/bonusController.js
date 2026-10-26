const User = require('../models/User');
const InboxMessage = require('../models/InboxMessage');

// Simple daily reward: 5000 coins every day
const DAILY_REWARD_COINS = 5000;

function isSameDay(d1, d2) {
  if (!d1 || !d2) return false;
  const date1 = new Date(d1);
  const date2 = new Date(d2);
  return date1.getFullYear() === date2.getFullYear() &&
         date1.getMonth()    === date2.getMonth()    &&
         date1.getDate()     === date2.getDate();
}

const { checkAndCleanExpiredBonus } = require('../helpers/bonusHelper');

// GET /api/bonus/status/:username
exports.getDailyBonusStatus = async (req, res) => {
  try {
    const { username } = req.params;
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    await checkAndCleanExpiredBonus(user);

    const now      = new Date();
    const lastClaim = user.lastDailyBonus;
    const canClaim  = !isSameDay(lastClaim, now);

    res.json({
      canClaim,
      lastDailyBonus: lastClaim,
      dailyReward: DAILY_REWARD_COINS,
      bonusCoins: user.bonusCoins || 0,
      bonusCoinsExpireAt: user.bonusCoinsExpireAt || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// POST /api/bonus/claim
exports.claimDailyBonus = async (req, res) => {
  try {
    const { username } = req.body;
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    await checkAndCleanExpiredBonus(user);

    const now      = new Date();
    const lastClaim = user.lastDailyBonus;

    if (isSameDay(lastClaim, now)) {
      return res.status(400).json({ error: 'Bonus harian hari ini sudah diklaim! Kembalilah besok.' });
    }

    // Give 5K bonus coins (strictly for slot games only)
    const coins = DAILY_REWARD_COINS;
    user.lastDailyBonus = now;

    // Bonus coins expire in 24 hours - ONLY added to bonusCoins, NOT to general coins!
    user.bonusCoins         = (user.bonusCoins || 0) + coins;
    user.bonusCoinsExpireAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    await user.save();

    // Inbox notification
    await InboxMessage.create({
      toUsername:   username,
      fromUsername: 'SISTEM',
      type:         'gift',
      title:        '🎁 Bonus Harian Khusus Slot!',
      body:         `Selamat! Anda telah mengklaim bonus harian +${coins.toLocaleString('id-ID')} bonus koin slot. Bonus ini khusus untuk bermain game slot. Kemenangan dari slot akan menjadi koin biasa yang dapat dipakai di semua game dan bisa dikirim ke teman! Gunakan dalam 24 jam sebelum hangus.`,
      icon:         '🎁',
      isRead:       false
    }).catch(() => {});

    res.json({
      message: `Berhasil mengklaim +${coins.toLocaleString('id-ID')} bonus koin slot!`,
      coins:   user.coins,
      dailyReward: coins,
      lastDailyBonus: user.lastDailyBonus,
      bonusCoins: user.bonusCoins,
      bonusCoinsExpireAt: user.bonusCoinsExpireAt,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
