const User = require('../models/User');
const InboxMessage = require('../models/InboxMessage');

// Store catalog definitions
const COIN_PACKAGES = [
  { id: 'coin_1m', name: '1.000.000 KOIN', coins: 1000000, priceRp: 'Rp 10.000', tag: 'Populer', icon: '🪙' },
  { id: 'coin_5m', name: '5.000.000 KOIN', coins: 5000000, priceRp: 'Rp 45.000', tag: 'HEMAT 10%', icon: '💰' },
  { id: 'coin_15m', name: '15.000.000 KOIN', coins: 15000000, priceRp: 'Rp 100.000', tag: 'BEST SELLER 🔥', icon: '💎' },
  { id: 'coin_50m', name: '50.000.000 KOIN', coins: 50000000, priceRp: 'Rp 300.000', tag: 'SUPER HEMAT 40%', icon: '👑' },
  { id: 'coin_150m', name: '150.000.000 KOIN', coins: 150000000, priceRp: 'Rp 750.000', tag: 'SULTAN PACK 🚀', icon: '🏆' },
  { id: 'coin_500m', name: '500.000.000 KOIN', coins: 500000000, priceRp: 'Rp 2.000.000', tag: 'MEGA JACKPOT 🌟', icon: '⚜️' },
];

const AVATAR_ITEMS = [
  { id: 'av_lion', emoji: '🦁', name: 'Singa Emas', priceCoins: 500000, priceRp: 0, tag: 'Eksklusif' },
  { id: 'av_dragon', emoji: '🐉', name: 'Naga Hoki', priceCoins: 1000000, priceRp: 0, tag: 'Langka' },
  { id: 'av_sultan', emoji: '👑', name: 'Mahkota Sultan', priceCoins: 2500000, priceRp: 0, tag: 'VIP' },
  { id: 'av_robot', emoji: '🤖', name: 'Cyber Bot', priceCoins: 500000, priceRp: 0, tag: 'Modern' },
  { id: 'av_tiger', emoji: '🐯', name: 'Harimau Raja', priceCoins: 1500000, priceRp: 0, tag: 'Eksklusif' },
  { id: 'av_phoenix', emoji: '🦅', name: 'Garuda Emas', priceCoins: 3000000, priceRp: 0, tag: 'SULTAN' },
];

const VIP_PACKAGES = [
  { id: 'vip_1', level: 1, name: 'VIP 1 (BRONZE)', priceRp: 'Rp 20.000', coinsBonus: 2000000, desc: '⭐️ Bisa kirim s/d 100.000 (100K) koin/hari, Frame Bronze, Badge VIP 1' },
  { id: 'vip_2', level: 2, name: 'VIP 2 (SILVER SULTAN)', priceRp: 'Rp 50.000', coinsBonus: 6000000, desc: '🚀 Kirim KOIN TANPA BATASAN (UNLIMITED!), Frame Silver, Badge VIP 2' },
  { id: 'vip_3', level: 3, name: 'VIP 3 (GOLD SULTAN)', priceRp: 'Rp 150.000', coinsBonus: 20000000, desc: '👑 Kirim KOIN TANPA BATASAN (UNLIMITED!), Frame Gold Glowing, Status Sultan' },
];

// GET /api/shop/catalog
exports.getCatalog = async (req, res) => {
  res.json({
    coinPackages: COIN_PACKAGES,
    avatarItems: AVATAR_ITEMS,
    vipPackages: VIP_PACKAGES,
    rpRate: { rpCost: 10, coinsReward: 50000 } // 10 RP = 50.000 Coins
  });
};

// POST /api/shop/buy-coins
exports.buyCoins = async (req, res) => {
  try {
    const { username, packageId } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'Pemain tidak ditemukan' });

    const pkg = COIN_PACKAGES.find(p => p.id === packageId);
    if (!pkg) return res.status(400).json({ error: 'Paket koin tidak ditemukan' });

    user.coins += pkg.coins;
    await user.save();

    // Kirim bukti pembelian ke Inbox
    await InboxMessage.create({
      toUsername: username,
      fromUsername: 'TOKO',
      type: 'gift',
      title: `🛍️ Pembelian ${pkg.name} Berhasil!`,
      body: `Terima kasih! Pembelian ${pkg.name} (${pkg.priceRp}) telah berhasil. Saldo +${pkg.coins.toLocaleString('id-ID')} koin telah ditambahkan.`,
      icon: '🛍️',
      isRead: false
    }).catch(() => {});

    res.json({
      message: `Berhasil membeli ${pkg.name}!`,
      coins: user.coins,
      addedCoins: pkg.coins
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/shop/buy-avatar
exports.buyAvatar = async (req, res) => {
  try {
    const { username, avatarId } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'Pemain tidak ditemukan' });

    const item = AVATAR_ITEMS.find(a => a.id === avatarId);
    if (!item) return res.status(400).json({ error: 'Item avatar tidak ditemukan' });

    if (user.unlockedAvatars && user.unlockedAvatars.includes(item.emoji)) {
      // Already owned, just equip
      user.avatar = item.emoji;
      await user.save();
      return res.json({ message: `Avatar ${item.name} berhasil dipasang!`, avatar: user.avatar, coins: user.coins });
    }

    if (user.coins < item.priceCoins) {
      return res.status(400).json({ error: `Koin tidak cukup! Butuh ${item.priceCoins.toLocaleString('id-ID')} koin.` });
    }

    user.coins -= item.priceCoins;
    if (!user.unlockedAvatars) user.unlockedAvatars = ['🐸', '🦊', '🐶', '🐱'];
    user.unlockedAvatars.push(item.emoji);
    user.avatar = item.emoji;

    await user.save();

    await InboxMessage.create({
      toUsername: username,
      fromUsername: 'TOKO',
      type: 'achievement',
      title: `🎨 Avatar Baru Dikeluarkan!`,
      body: `Selamat! Anda membuka avatar ${item.name} (${item.emoji}). Avatar ini sekarang aktif di profil Anda.`,
      icon: item.emoji,
      isRead: false
    }).catch(() => {});

    res.json({
      message: `Berhasil membeli & memasang avatar ${item.name} (${item.emoji})!`,
      coins: user.coins,
      avatar: user.avatar,
      unlockedAvatars: user.unlockedAvatars
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/shop/buy-vip
exports.buyVip = async (req, res) => {
  try {
    const { username, vipId } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'Pemain tidak ditemukan' });

    const vip = VIP_PACKAGES.find(v => v.id === vipId);
    if (!vip) return res.status(400).json({ error: 'Paket VIP tidak ditemukan' });

    user.vipLevel = Math.max(user.vipLevel || 0, vip.level);
    user.coins += vip.coinsBonus;
    await user.save();

    await InboxMessage.create({
      toUsername: username,
      fromUsername: 'SISTEM',
      type: 'achievement',
      title: `👑 Upgrade STATUS ${vip.name}!`,
      body: `Selamat! Akun Anda telah ditingkatkan menjadi ${vip.name}. Bonus koin instan +${vip.coinsBonus.toLocaleString('id-ID')} telah ditambahkan!`,
      icon: '👑',
      isRead: false
    }).catch(() => {});

    res.json({
      message: `Selamat! Anda berhasil upgrade ke ${vip.name}!`,
      coins: user.coins,
      vipLevel: user.vipLevel
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/shop/convert-rp
exports.convertRp = async (req, res) => {
  try {
    const { username, rpAmount } = req.body;
    const user = await User.findOne({ username });
    if (!user) return res.status(404).json({ error: 'Pemain tidak ditemukan' });

    const rpToConvert = parseInt(rpAmount, 10);
    if (isNaN(rpToConvert) || rpToConvert < 10) {
      return res.status(400).json({ error: 'Minimal penukaran adalah 10 RP' });
    }

    if (user.rp < rpToConvert) {
      return res.status(400).json({ error: `RP tidak mencukupi! Anda hanya memiliki ${user.rp} RP.` });
    }

    // 10 RP = 50.000 Coins
    const coinsGained = Math.floor(rpToConvert / 10) * 50000;
    const rpUsed = Math.floor(rpToConvert / 10) * 10;

    user.rp -= rpUsed;
    user.coins += coinsGained;
    await user.save();

    await InboxMessage.create({
      toUsername: username,
      fromUsername: 'TOKO',
      type: 'gift',
      title: `🔄 Penukaran ${rpUsed} RP Berhasil!`,
      body: `Anda berhasil menukarkan ${rpUsed} RP menjadi +${coinsGained.toLocaleString('id-ID')} Koin!`,
      icon: '🔄',
      isRead: false
    }).catch(() => {});

    res.json({
      message: `Berhasil menukar ${rpUsed} RP menjadi +${coinsGained.toLocaleString('id-ID')} koin!`,
      coins: user.coins,
      rp: user.rp
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
