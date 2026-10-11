const User = require('../models/User');
const InboxMessage = require('../models/InboxMessage');
const TransferHistory = require('../models/TransferHistory');
const { checkAndCleanExpiredBonus, spendUserCoins } = require('../helpers/bonusHelper');

function isSameDay(d1, d2) {
  if (!d1 || !d2) return false;
  const date1 = new Date(d1);
  const date2 = new Date(d2);
  return date1.getFullYear() === date2.getFullYear() &&
         date1.getMonth()    === date2.getMonth()    &&
         date1.getDate()     === date2.getDate();
}

// Get profile by username
exports.getProfile = async (req, res) => {
  try {
    const { username } = req.params;
    const user = await User.findOne({ username });
    
    if (!user) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }
    
    // Check if bonus coins expired
    await checkAndCleanExpiredBonus(user);

    const now = new Date();
    const isToday = isSameDay(user.lastSentDate, now);
    const sentToday = isToday ? (user.dailySentCoins || 0) : 0;
    const vipLevel = user.vipLevel || 0;

    // vipLevel 0 = 0 limit (blocked), 1 = 100k, 2+ = -1 (unlimited)
    let dailyLimit = 0;
    if (vipLevel === 1) dailyLimit = 100000;
    else if (vipLevel >= 2) dailyLimit = -1;

    const remainingDailySend = dailyLimit === -1 ? -1 : Math.max(0, dailyLimit - sentToday);

    const profileData = user.toObject();
    profileData.dailySentCoinsToday = sentToday;
    profileData.dailySendLimit = dailyLimit;
    profileData.remainingDailySend = remainingDailySend;

    res.json(profileData);
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil data profil' });
  }
};

// Get top 3 leaderboard
exports.getLeaderboard = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const users = await User.find({}, 'username avatar coins vipLevel')
      .sort({ coins: -1, _id: 1 })
      .limit(limit)
      .lean();
    const list = users.map((u, i) => ({
      rank: i + 1,
      username: u.username,
      avatar: u.avatar,
      coins: u.coins || 0,
      vipLevel: u.vipLevel || 0
    }));

    // Peringkat pemain yang sedang melihat (jika di luar top N)
    let me = null;
    const { username } = req.query;
    if (username) {
      const mine = list.find(u => u.username === username);
      if (mine) {
        me = mine;
      } else {
        const user = await User.findOne({ username }, 'username avatar coins vipLevel').lean();
        if (user) {
          const ahead = await User.countDocuments({ coins: { $gt: user.coins || 0 } });
          me = {
            rank: ahead + 1,
            username: user.username,
            avatar: user.avatar,
            coins: user.coins || 0,
            vipLevel: user.vipLevel || 0
          };
        }
      }
    }
    res.json({ leaderboard: list, me });
  } catch (error) {
    res.status(500).json({ error: 'Gagal memproses data peringkat' });
  }
};

// Create dummy user
exports.createUser = async (req, res) => {
  try {
    const newUser = new User(req.body);
    await newUser.save();
    res.status(201).json({ message: 'Pemain berhasil dibuat!' });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Get list of all users (for Recommendations & Search)
exports.getUsersList = async (req, res) => {
  try {
    const { exclude } = req.query;
    // Find all users except the current one
    const users = await User.find({ username: { $ne: exclude } });
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil daftar pemain' });
  }
};

// Send Friend Request
exports.sendFriendRequest = async (req, res) => {
  try {
    const { username, friendUsername } = req.body;
    const sender = await User.findOne({ username });
    const receiver = await User.findOne({ username: friendUsername });

    if (!sender || !receiver) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    if (sender.friends.includes(friendUsername)) {
      return res.status(400).json({ error: 'Sudah berteman dengan pemain ini' });
    }

    if (receiver.friendRequests.includes(username)) {
      return res.status(400).json({ error: 'Permintaan pertemanan sudah dikirim sebelumnya' });
    }

    // Add to receiver's friendRequests
    receiver.friendRequests.push(username);
    await receiver.save();

    res.json({ message: 'Permintaan pertemanan terkirim!' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Accept Friend Request
exports.acceptFriendRequest = async (req, res) => {
  try {
    const { username, requesterUsername } = req.body;
    const user = await User.findOne({ username });
    const requester = await User.findOne({ username: requesterUsername });

    if (!user || !requester) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    // Remove from requests list
    user.friendRequests = user.friendRequests.filter(r => r !== requesterUsername);

    // Add to both friends lists (mutual)
    if (!user.friends.includes(requesterUsername)) {
      user.friends.push(requesterUsername);
    }
    if (!requester.friends.includes(username)) {
      requester.friends.push(username);
    }

    await user.save();
    await requester.save();

    res.json({ message: 'Permintaan pertemanan diterima!', friends: user.friends });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Decline Friend Request
exports.declineFriendRequest = async (req, res) => {
  try {
    const { username, requesterUsername } = req.body;
    const user = await User.findOne({ username });

    if (!user) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    user.friendRequests = user.friendRequests.filter(r => r !== requesterUsername);
    await user.save();

    res.json({ message: 'Permintaan pertemanan ditolak' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Remove friend (mutual)
exports.removeFriend = async (req, res) => {
  try {
    const { username, friendUsername } = req.body;
    const user = await User.findOne({ username });
    const friend = await User.findOne({ username: friendUsername });

    if (!user) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    user.friends = user.friends.filter(f => f !== friendUsername);
    await user.save();

    if (friend) {
      friend.friends = friend.friends.filter(f => f !== username);
      await friend.save();
    }

    res.json({ message: 'Pertemanan dihapus', friends: user.friends });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Transfer Coins / Send Money
exports.transferCoins = async (req, res) => {
  try {
    const { fromUsername, toUsername, amount } = req.body;
    const transferAmount = parseInt(amount, 10);

    if (isNaN(transferAmount) || transferAmount <= 0) {
      return res.status(400).json({ error: 'Jumlah koin tidak valid' });
    }

    if (fromUsername === toUsername) {
      return res.status(400).json({ error: 'Tidak bisa mengirim koin ke diri sendiri' });
    }

    const sender = await User.findOne({ username: fromUsername });
    const receiver = await User.findOne({ username: toUsername });

    if (!sender) return res.status(404).json({ error: 'Pengirim tidak ditemukan' });
    if (!receiver) return res.status(404).json({ error: 'Penerima tidak ditemukan' });

    if (sender.coins < transferAmount) {
      return res.status(400).json({ error: 'Koin tidak mencukupi untuk transfer' });
    }

    const vipLevel = sender.vipLevel || 0;
    const now = new Date();

    // Enforce VIP level restrictions
    if (vipLevel < 1) {
      return res.status(403).json({
        error: 'Fitur kirim koin membutuhkan akun VIP! Upgrade ke VIP 1 di Toko untuk kirim s/d 100K/hari, atau VIP 2+ untuk UNLIMITED.'
      });
    }

    const isToday = isSameDay(sender.lastSentDate, now);
    let sentToday = isToday ? (sender.dailySentCoins || 0) : 0;

    if (vipLevel === 1) {
      const MAX_VIP1_DAILY = 100000; // 100K per day
      const remaining = Math.max(0, MAX_VIP1_DAILY - sentToday);

      if (transferAmount > remaining) {
        return res.status(400).json({
          error: `Batas kirim koin VIP 1 adalah 100.000 (100K) koin/hari. Sisa kuota Anda hari ini: ${remaining.toLocaleString('id-ID')} koin. Upgrade ke VIP 2 untuk TANPA BATASAN!`
        });
      }

      sender.dailySentCoins = sentToday + transferAmount;
      sender.lastSentDate = now;
    } else {
      // VIP 2+: Unlimited sending!
      sender.dailySentCoins = sentToday + transferAmount;
      sender.lastSentDate = now;
    }

    // Deduct and add
    spendUserCoins(sender, transferAmount);
    sender.coins -= transferAmount;
    receiver.coins += transferAmount;

    await sender.save();
    await receiver.save();

    // Create TransferHistory record
    const trxId = 'TRX-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(1000 + Math.random() * 9000);
    await TransferHistory.create({
      transactionId: trxId,
      fromUsername: fromUsername,
      toUsername: toUsername,
      amount: transferAmount,
      senderVip: vipLevel,
      senderBalanceAfter: sender.coins,
      receiverBalanceAfter: receiver.coins,
      status: 'success',
      note: req.body.note || 'Transfer Koin VIP'
    }).catch(err => console.error('Gagal mencatat riwayat transfer:', err));

    // Inbox notification for receiver
    await InboxMessage.create({
      toUsername: toUsername,
      fromUsername: fromUsername,
      type: 'gift',
      title: '🎁 Kiriman Koin Diterima!',
      body: `${fromUsername} (VIP ${vipLevel}) telah mengirimkan +${transferAmount.toLocaleString('id-ID')} koin untuk Anda!`,
      icon: '🎁',
      isRead: false
    }).catch(() => {});

    res.json({
      message: `Berhasil mengirim ${transferAmount.toLocaleString('id-ID')} koin ke ${toUsername}!`,
      transactionId: trxId,
      senderCoins: sender.coins,
      dailySentCoinsToday: sender.dailySentCoins,
      vipLevel: vipLevel
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Update Coins directly (payout / entry fee)
exports.updateCoins = async (req, res) => {
  try {
    const { username, amount } = req.body;
    const updateAmount = parseInt(amount, 10);
    
    if (isNaN(updateAmount)) {
      return res.status(400).json({ error: 'Jumlah koin tidak valid' });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    // Check expiration first
    await checkAndCleanExpiredBonus(user);

    // Apply change
    if (updateAmount < 0) {
      spendUserCoins(user, Math.abs(updateAmount));
    }
    user.coins = Math.max(0, user.coins + updateAmount);
    await user.save();

    res.json({
      message: 'Koin berhasil diperbarui',
      coins: user.coins
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

