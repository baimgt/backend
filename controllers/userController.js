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

// Generate unique 8-digit Player ID
async function generateUniqueUserId() {
  let unique = false;
  let newId = '';
  let attempts = 0;
  while (!unique && attempts < 100) {
    attempts++;
    newId = String(Math.floor(10000000 + Math.random() * 90000000));
    const existing = await User.findOne({ userId: newId });
    if (!existing) unique = true;
  }
  return newId || String(Date.now()).slice(-8);
}

// Get profile by username or userId
exports.getProfile = async (req, res) => {
  try {
    const { username } = req.params;
    const cleanUser = String(username || '').trim();
    let user = await User.findOne({
      $or: [
        { username: cleanUser },
        { userId: cleanUser },
        { username: new RegExp('^' + cleanUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
      ]
    });
    
    // Jika belum ada di MongoDB Atlas (misal akun dari sesi lokal/baru): auto-buatkan agar pemain langsung terdaftar
    if (!user && cleanUser) {
      const generatedId = await generateUniqueUserId();
      user = new User({
        username: cleanUser,
        userId: generatedId,
        coins: 10000,
        rp: 0,
        score: 50,
        vipLevel: 0,
        nameChangeCount: 0
      });
      await user.save();
      console.log(`[USER AUTO-CREATED ON GET PROFILE] ${cleanUser} | ID: ${user.userId}`);
    }

    if (!user) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    // Auto-generate userId if not present
    if (!user.userId) {
      user.userId = await generateUniqueUserId();
      await user.save();
    }
    
    // Check if bonus coins expired
    await checkAndCleanExpiredBonus(user);

    const now = new Date();
    const isToday = isSameDay(user.lastSentDate, now);
    const sentToday = isToday ? (user.dailySentCoins || 0) : 0;
    const vipLevel = user.vipLevel || 0;

    // PRE-RELEASE MODE: Kirim koin dibuka untuk semua pemain tanpa syarat VIP
    let dailyLimit = -1; // Unlimited sending for testing
    const remainingDailySend = -1;

    const profileData = user.toObject();
    profileData.userId = user.userId;
    profileData.id = user.userId;
    profileData.dailySentCoinsToday = sentToday;
    profileData.dailySendLimit = dailyLimit;
    profileData.remainingDailySend = remainingDailySend;
    profileData.customFrame = user.customFrame || 'crown';
    if (!profileData.avatar || profileData.avatar === '/bg.png') {
      profileData.avatar = '🐸';
    }
    const nameChangeCount = user.nameChangeCount || 0;
    profileData.nameChangeCount = nameChangeCount;
    profileData.isFreeNameChange = nameChangeCount === 0;
    profileData.nameChangeCost = nameChangeCount === 0 ? 0 : 50000;

    res.json(profileData);
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil data profil' });
  }
};

// Get top 3 leaderboard
exports.getLeaderboard = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    const users = await User.find({}, 'username userId avatar coins vipLevel')
      .sort({ coins: -1, _id: 1 })
      .limit(limit)
      .lean();
    const list = users.map((u, i) => ({
      rank: i + 1,
      username: u.username,
      userId: u.userId || '',
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
        const user = await User.findOne({ username }, 'username userId avatar coins vipLevel').lean();
        if (user) {
          const ahead = await User.countDocuments({ coins: { $gt: user.coins || 0 } });
          me = {
            rank: ahead + 1,
            username: user.username,
            userId: user.userId || '',
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

// Create user
exports.createUser = async (req, res) => {
  try {
    const payload = { ...req.body };
    if (!payload.username || typeof payload.username !== 'string') {
      return res.status(400).json({ error: 'Username wajib diisi!' });
    }
    payload.username = payload.username.trim();

    // Validasi panjang username: 3 - 16 karakter
    if (payload.username.length < 3 || payload.username.length > 16) {
      return res.status(400).json({ error: 'Username harus terdiri dari 3 hingga 16 karakter!' });
    }

    // Cek apakah username sudah ada yang sama (case-insensitive)
    const existing = await User.findOne({
      username: new RegExp('^' + payload.username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
    });
    if (existing) {
      return res.status(400).json({ error: `Username "${payload.username}" sudah digunakan pemain lain. Silakan pilih nama lain.` });
    }

    if (!payload.userId) {
      payload.userId = await generateUniqueUserId();
    }
    if (payload.nameChangeCount === undefined) {
      payload.nameChangeCount = 0; // Pengguna baru mendapatkan 1x ganti nama gratis
    }

    const newUser = new User(payload);
    await newUser.save();
    res.status(201).json({ message: 'Pemain berhasil dibuat!', user: newUser, userId: newUser.userId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
};

// Get list of all users (for Recommendations & Search)
exports.getUsersList = async (req, res) => {
  try {
    const { exclude, q, id } = req.query;
    const searchTerm = (id || q || '').trim();

    let filter = { username: { $ne: exclude } };
    if (searchTerm) {
      filter.$or = [
        { userId: searchTerm },
        { userId: { $regex: searchTerm, $options: 'i' } },
        { username: { $regex: searchTerm, $options: 'i' } }
      ];
    }

    const users = await User.find(filter, 'username userId avatar coins vipLevel customFrame friends friendRequests');

    // Ensure all returned users have an active userId
    for (const u of users) {
      if (!u.userId) {
        u.userId = await generateUniqueUserId();
        await u.save();
      }
    }
    res.json(users);
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil daftar pemain' });
  }
};

// Send Friend Request (Supports searching/adding by 8-digit userId or username)
exports.sendFriendRequest = async (req, res) => {
  try {
    const { username, friendUsername, friendId } = req.body;
    const target = String(friendId || friendUsername || '').trim();
    const sender = await User.findOne({ username });

    if (!sender) {
      return res.status(404).json({ error: 'Akun pengirim tidak ditemukan' });
    }

    // Prioritize search by userId first, then fallback to username
    let receiver = null;
    if (friendId) {
      receiver = await User.findOne({ userId: String(friendId).trim() });
    }
    if (!receiver && target) {
      receiver = await User.findOne({
        $or: [{ userId: target }, { username: target }]
      });
    }

    if (!receiver) {
      return res.status(404).json({ error: `Pemain dengan ID "${target}" tidak ditemukan` });
    }

    const actualReceiverUsername = receiver.username;
    if (sender.username === actualReceiverUsername) {
      return res.status(400).json({ error: 'Tidak bisa menambahkan diri sendiri' });
    }

    if (sender.friends.includes(actualReceiverUsername)) {
      return res.status(400).json({ error: `Sudah berteman dengan ${actualReceiverUsername} (ID: ${receiver.userId || '-'})` });
    }

    if (receiver.friendRequests.includes(username)) {
      return res.status(400).json({ error: 'Permintaan pertemanan sudah dikirim sebelumnya' });
    }

    // Add to receiver's friendRequests
    receiver.friendRequests.push(username);
    await receiver.save();

    res.json({
      message: `Permintaan pertemanan terkirim ke ${actualReceiverUsername} (ID: ${receiver.userId})!`,
      friendUsername: actualReceiverUsername,
      friendId: receiver.userId
    });
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
    const receiver = await User.findOne({
      $or: [{ username: toUsername }, { userId: toUsername }]
    });

    if (!sender) return res.status(404).json({ error: 'Pengirim tidak ditemukan' });
    if (!receiver) return res.status(404).json({ error: 'Penerima tidak ditemukan' });

    const actualToUsername = receiver.username;
    if (fromUsername === actualToUsername) {
      return res.status(400).json({ error: 'Tidak bisa mengirim koin ke diri sendiri' });
    }

    // Check sender coins excluding slot-only bonus coins
    const usableCoins = Math.max(0, sender.coins - (sender.bonusCoins || 0));
    if (usableCoins < transferAmount) {
      if (sender.bonusCoins > 0 && sender.coins >= transferAmount) {
        return res.status(400).json({
          error: 'Koin dari klaim bonus harian hanya dapat digunakan untuk bermain Slot dan tidak dapat ditransfer!'
        });
      }
      return res.status(400).json({ error: 'Koin tidak mencukupi untuk transfer' });
    }

    const vipLevel = sender.vipLevel || 0;
    const now = new Date();

    // SEMENTARA WAKTU (Pre-release): Kirim koin tidak dibatasi VIP!
    // Catat histori transfer
    sender.dailySentCoins = (sender.dailySentCoins || 0) + transferAmount;
    sender.lastSentDate = now;

    // Deduct and add
    sender.coins -= transferAmount;
    receiver.coins += transferAmount;

    await sender.save();
    await receiver.save();

    // Create TransferHistory record
    const trxId = 'TRX-' + Date.now().toString(36).toUpperCase() + '-' + Math.floor(1000 + Math.random() * 9000);
    await TransferHistory.create({
      transactionId: trxId,
      fromUsername: fromUsername,
      toUsername: actualToUsername,
      amount: transferAmount,
      senderVip: vipLevel,
      senderBalanceAfter: sender.coins,
      receiverBalanceAfter: receiver.coins,
      status: 'success',
      note: req.body.note || 'Transfer Koin VIP'
    }).catch(err => console.error('Gagal mencatat riwayat transfer:', err));

    // Inbox notification for receiver
    await InboxMessage.create({
      toUsername: actualToUsername,
      fromUsername: fromUsername,
      type: 'gift',
      title: '🎁 Kiriman Koin Diterima!',
      body: `${fromUsername} (VIP ${vipLevel}) telah mengirimkan +${transferAmount.toLocaleString('id-ID')} koin untuk Anda!`,
      icon: '🎁',
      isRead: false
    }).catch(() => {});

    res.json({
      message: `Berhasil mengirim ${transferAmount.toLocaleString('id-ID')} koin ke ${actualToUsername}!`,
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
    const { username, amount, gameType } = req.body;
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
      const deduct = Math.abs(updateAmount);
      const isSlot = gameType === 'slot';

      if (!isSlot) {
        // Non-slot games (Domino, QiuQiu, Billiard, By One) CANNOT use daily bonus coins!
        const generalCoins = Math.max(0, user.coins - (user.bonusCoins || 0));
        if (generalCoins < deduct) {
          if (user.bonusCoins > 0 && user.coins >= deduct) {
            return res.status(400).json({
              error: 'Koin dari klaim bonus harian hanya dapat digunakan untuk game SLOT! Koin umum Anda tidak mencukupi.'
            });
          }
          return res.status(400).json({ error: 'Koin tidak mencukupi' });
        }
        // Deduct from total coins without consuming slot bonusCoins
        user.coins = Math.max(0, user.coins - deduct);
      } else {
        // Slot games: consume bonusCoins first
        spendUserCoins(user, deduct);
        user.coins = Math.max(0, user.coins - deduct);
      }
    } else {
      user.coins = Math.max(0, user.coins + updateAmount);
    }
    await user.save();

    res.json({
      message: 'Koin berhasil diperbarui',
      coins: user.coins
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// Update Avatar & Frame endpoint (supporting username, userId, and customFrame)
exports.updateAvatar = async (req, res) => {
  try {
    const { username, userId, avatar, frame } = req.body;
    if ((!username && !userId) || !avatar) {
      return res.status(400).json({ error: 'Username atau userId dan avatar diperlukan' });
    }

    let user = null;
    if (userId) {
      user = await User.findOne({ userId: String(userId) });
    }
    if (!user && username) {
      user = await User.findOne({
        $or: [
          { username: username },
          { userId: username },
          { username: new RegExp('^' + username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
        ]
      });
    }

    if (!user) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    user.avatar = avatar;
    if (frame) {
      user.customFrame = frame;
    }
    await user.save();

    console.log(`[AVATAR UPDATED] ${user.username} (ID: ${user.userId}) -> ${avatar.slice(0, 30)} (frame: ${user.customFrame || 'default'})`);

    res.json({
      message: 'Avatar berhasil diperbarui',
      avatar: user.avatar,
      customFrame: user.customFrame || frame || 'crown',
      username: user.username,
      userId: user.userId
    });
  } catch (error) {
    console.error('Update avatar error:', error);
    res.status(500).json({ error: error.message });
  }
};

// Change Username Endpoint (1x Free for New Users, 50.000 Coins for subsequent changes)
exports.changeUsername = async (req, res) => {
  try {
    const { currentUsername, newUsername, userId } = req.body;

    if (!newUsername || typeof newUsername !== 'string') {
      return res.status(400).json({ error: 'Nama pengguna baru wajib diisi!' });
    }

    const trimmedNew = newUsername.trim();

    // Validasi panjang nama: 3 - 16 karakter
    if (trimmedNew.length < 3 || trimmedNew.length > 16) {
      return res.status(400).json({ error: 'Nama baru harus terdiri dari 3 hingga 16 karakter!' });
    }

    // Validasi karakter yang diizinkan (alfanumerik, underscore, dan spasi tunggal)
    const validRegex = /^[a-zA-Z0-9_ ]+$/;
    if (!validRegex.test(trimmedNew)) {
      return res.status(400).json({ error: 'Nama hanya boleh berisi huruf, angka, garis bawah (_), dan spasi!' });
    }

    let user = null;
    const cleanUserId = userId ? String(userId).trim() : '';
    const cleanCurrent = currentUsername ? String(currentUsername).trim() : '';

    if (cleanUserId) {
      user = await User.findOne({ userId: cleanUserId });
    }
    if (!user && cleanCurrent) {
      user = await User.findOne({
        $or: [
          { username: cleanCurrent },
          { userId: cleanCurrent },
          { username: new RegExp('^' + cleanCurrent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') }
        ]
      });
    }

    const COST = 50000; // Biaya perubahan ke-2x dan seterusnya: 50.000 Koin

    // Jika akun belum ada di database MongoDB (misal user dari sesi lokal sebelum pindah ke Atlas)
    if (!user) {
      // Periksa apakah nama baru sudah dipakai orang lain
      const existing = await User.findOne({
        username: new RegExp('^' + trimmedNew.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
      });
      if (existing) {
        return res.status(400).json({ error: `Nama "${trimmedNew}" sudah digunakan oleh pemain lain. Silakan pilih nama lain.` });
      }

      const newUserId = cleanUserId || await generateUniqueUserId();
      user = new User({
        username: trimmedNew,
        userId: newUserId,
        coins: 100000,
        vipLevel: 0,
        nameChangeCount: 1 // 1x ganti nama pertama sudah terpakai
      });
      await user.save();
      console.log(`[USER AUTO-REGISTERED ON NAME CHANGE] ${trimmedNew} | ID: ${user.userId}`);
      return res.json({
        message: `Selamat! Nama akun Anda berhasil diubah menjadi "${trimmedNew}"!`,
        newUsername: trimmedNew,
        oldUsername: cleanCurrent || 'Tamu',
        userId: user.userId,
        coins: user.coins,
        nameChangeCount: 1,
        isFree: false,
        nextCost: COST
      });
    }

    // Periksa jika nama baru sama dengan nama lama
    if (user.username.toLowerCase() === trimmedNew.toLowerCase()) {
      return res.status(400).json({ error: 'Nama baru tidak boleh sama dengan nama saat ini!' });
    }

    // Periksa apakah nama baru sudah dipakai orang lain
    const existing = await User.findOne({
      username: new RegExp('^' + trimmedNew.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'),
      _id: { $ne: user._id }
    });

    if (existing) {
      return res.status(400).json({ error: `Nama "${trimmedNew}" sudah digunakan oleh pemain lain. Silakan pilih nama lain.` });
    }

    const currentCount = user.nameChangeCount || 0;
    const isFree = currentCount === 0;

    // Bersihkan koin expired terlebih dahulu
    await checkAndCleanExpiredBonus(user);

    if (!isFree) {
      if ((user.coins || 0) < COST) {
        return res.status(400).json({
          error: `Koin tidak mencukupi! Perubahan nama ke-2 dan seterusnya memerlukan ${COST.toLocaleString('id-ID')} koin. Saldo Anda saat ini: ${(user.coins || 0).toLocaleString('id-ID')} koin.`
        });
      }
      spendUserCoins(user, COST);
      user.coins -= COST;
    }

    const oldUsername = user.username;
    user.username = trimmedNew;
    user.nameChangeCount = currentCount + 1;
    await user.save();

    console.log(`[USERNAME CHANGED] ${oldUsername} -> ${trimmedNew} | Count: ${user.nameChangeCount} | Cost: ${isFree ? 'FREE (0)' : COST}`);

    // Sinkronkan relasi pertemanan, pesan inbox, dan riwayat transfer
    try {
      await User.updateMany({ friends: oldUsername }, { $set: { "friends.$": trimmedNew } });
      await User.updateMany({ friendRequests: oldUsername }, { $set: { "friendRequests.$": trimmedNew } });
      await InboxMessage.updateMany({ toUsername: oldUsername }, { toUsername: trimmedNew });
      await InboxMessage.updateMany({ fromUsername: oldUsername }, { fromUsername: trimmedNew });
      await TransferHistory.updateMany({ toUsername: oldUsername }, { toUsername: trimmedNew });
      await TransferHistory.updateMany({ fromUsername: oldUsername }, { fromUsername: trimmedNew });
    } catch (relErr) {
      console.warn('Peringatan pembaruan relasi:', relErr.message);
    }

    // Kirim pesan Inbox konfirmasi
    try {
      await InboxMessage.create({
        toUsername: trimmedNew,
        fromUsername: 'SISTEM',
        type: 'system',
        title: '✏️ Nama Akun Berhasil Diubah!',
        body: isFree
          ? `Selamat! Anda telah menggunakan 1x ganti nama GRATIS Anda. Nama akun Anda sekarang adalah "${trimmedNew}". Untuk perubahan berikutnya dikenakan biaya ${COST.toLocaleString('id-ID')} koin.`
          : `Perubahan nama berhasil! Nama akun Anda kini diubah menjadi "${trimmedNew}". Biaya sebesar ${COST.toLocaleString('id-ID')} koin telah dipotong dari saldo akun Anda.`,
        icon: '✏️',
        isRead: false
      });
    } catch (_) {}

    res.json({
      message: isFree
        ? `Selamat! Nama akun Anda berhasil diubah secara GRATIS menjadi "${trimmedNew}"!`
        : `Nama akun berhasil diubah menjadi "${trimmedNew}" (Biaya: ${COST.toLocaleString('id-ID')} koin)!`,
      newUsername: trimmedNew,
      oldUsername: oldUsername,
      userId: user.userId,
      coins: user.coins,
      nameChangeCount: user.nameChangeCount,
      isFree: false, // Perubahan berikutnya berbayar
      nextCost: COST
    });
  } catch (error) {
    console.error('Change username error:', error);
    res.status(500).json({ error: error.message || 'Gagal mengubah nama pemain' });
  }
};

