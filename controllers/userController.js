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
    profileData.authProvider = user.authProvider || (user.googleEmail || user.googleId || (user.username && user.username.startsWith('Google_')) ? 'google' : 'guest');
    profileData.googleEmail = user.googleEmail || null;

    res.json(profileData);
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil data profil' });
  }
};

// Get top 3 leaderboard
exports.getLeaderboard = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 100);
    // Filter: kecualikan akun dengan role 'admin' atau isAdmin: true agar tidak pernah muncul di leaderboard
    const nonAdminFilter = {
      role: { $ne: 'admin' },
      isAdmin: { $ne: true }
    };

    const users = await User.find(nonAdminFilter, 'username userId avatar coins vipLevel')
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
        const user = await User.findOne({ username }, 'username userId avatar coins vipLevel role isAdmin').lean();
        if (user) {
          // Jika akun adalah admin, jangan berikan ranking pemain biasa
          if (user.role === 'admin' || user.isAdmin === true) {
            me = {
              rank: '-',
              username: user.username,
              userId: user.userId || '',
              avatar: user.avatar,
              coins: user.coins || 0,
              vipLevel: user.vipLevel || 0,
              isAdmin: true
            };
          } else {
            const ahead = await User.countDocuments({
              ...nonAdminFilter,
              coins: { $gt: user.coins || 0 }
            });
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
    const rawSearch = (id || q || '').trim();
    const cleanSearch = rawSearch.replace(/^#/, '').trim();

    let filter = { username: { $ne: exclude } };
    if (rawSearch) {
      const orList = [
        { userId: cleanSearch },
        { userId: rawTargetSearchSafe(cleanSearch) },
        { userId: rawSearch }
      ];
      const numSearch = Number(cleanSearch);
      if (!isNaN(numSearch) && cleanSearch.length > 0) {
        orList.push({ userId: numSearch });
      }
      try {
        const escClean = cleanSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const escRaw = rawSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        orList.push({ userId: { $regex: escClean, $options: 'i' } });
        orList.push({ username: { $regex: escRaw, $options: 'i' } });
      } catch (_) {}
      filter.$or = orList;
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

function rawTargetSearchSafe(val) {
  return String(val || '').trim();
}

// Send Friend Request (Supports searching/adding by 8-digit userId or username)
exports.sendFriendRequest = async (req, res) => {
  try {
    const { username, friendUsername, friendId } = req.body;
    const rawTarget = String(friendId || friendUsername || '').trim();
    if (!rawTarget) {
      return res.status(400).json({ error: 'ID atau Username pemain diperlukan' });
    }

    const cleanId = rawTarget.replace(/^#/, '').trim();
    const sender = await User.findOne({ username });

    if (!sender) {
      return res.status(404).json({ error: 'Akun pengirim tidak ditemukan' });
    }

    // Prioritize search by userId (clean numeric/string, with or without #) then username (case-insensitive)
    const orConditions = [
      { userId: cleanId },
      { userId: rawTarget },
      { username: rawTarget }
    ];
    const numId = Number(cleanId);
    if (!isNaN(numId) && cleanId.length > 0) {
      orConditions.push({ userId: numId });
    }
    try {
      const escapedRaw = rawTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escapedClean = cleanId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orConditions.push({ username: new RegExp(`^${escapedRaw}$`, 'i') });
      orConditions.push({ username: new RegExp(`^${escapedClean}$`, 'i') });
    } catch (_) {}

    const receiver = await User.findOne({ $or: orConditions });

    if (!receiver) {
      return res.status(404).json({ error: `Pemain dengan ID atau Username "${rawTarget}" tidak ditemukan` });
    }

    const actualReceiverUsername = receiver.username;
    if (sender.username.toLowerCase() === actualReceiverUsername.toLowerCase()) {
      return res.status(400).json({ error: 'Tidak bisa menambahkan diri sendiri' });
    }

    if (sender.friends && sender.friends.some(f => f.toLowerCase() === actualReceiverUsername.toLowerCase())) {
      return res.status(400).json({ error: `Sudah berteman dengan ${actualReceiverUsername} (ID: #${receiver.userId || '-'})` });
    }

    if (receiver.friendRequests && receiver.friendRequests.some(r => r.toLowerCase() === username.toLowerCase())) {
      return res.status(400).json({ error: 'Permintaan pertemanan sudah dikirim sebelumnya' });
    }

    // Add to receiver's friendRequests
    if (!receiver.friendRequests) receiver.friendRequests = [];
    receiver.friendRequests.push(sender.username);
    await receiver.save();

    res.json({
      message: `Permintaan pertemanan terkirim ke ${actualReceiverUsername} (ID: #${receiver.userId})!`,
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

// Lookup single user by exact userId or username (for Transfer Preview Card)
exports.lookupUser = async (req, res) => {
  try {
    const rawQuery = String(req.query.q || req.query.id || req.query.username || '').trim();
    if (!rawQuery) {
      return res.status(400).json({ error: 'Parameter q atau id diperlukan' });
    }
    const cleanId = rawQuery.replace(/^#/, '').trim();
    const numId = Number(cleanId);

    const orConditions = [
      { userId: cleanId },
      { userId: rawQuery },
      { username: rawQuery }
    ];
    if (!isNaN(numId) && cleanId.length > 0) {
      orConditions.push({ userId: numId });
    }
    try {
      const escRaw = rawQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const escClean = cleanId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      orConditions.push({ username: new RegExp(`^${escRaw}$`, 'i') });
      orConditions.push({ username: new RegExp(`^${escClean}$`, 'i') });
    } catch (_) {}

    const user = await User.findOne({ $or: orConditions }, 'username userId avatar coins vipLevel customFrame').lean();
    if (!user) {
      return res.status(404).json({ error: 'Akun pemain tidak ditemukan' });
    }
    const payload = {
      username: user.username,
      userId: user.userId || '',
      avatar: user.avatar || '🐸',
      coins: user.coins || 0,
      vipLevel: user.vipLevel || 0,
      customFrame: user.customFrame || 'crown'
    };
    res.json({
      found: true,
      user: payload,
      ...payload
    });
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

    const rawTo = String(toUsername || '').trim();
    const cleanTo = rawTo.replace(/^#/, '').trim();
    const numTo = Number(cleanTo);

    const orConditions = [
      { username: rawTo },
      { username: cleanTo },
      { userId: cleanTo },
      { userId: rawTo }
    ];
    if (!isNaN(numTo) && cleanTo.length > 0) {
      orConditions.push({ userId: numTo });
    }
    try {
      orConditions.push({ username: new RegExp(`^${rawTo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
      orConditions.push({ username: new RegExp(`^${cleanTo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    } catch (_) {}

    const sender = await User.findOne({ username: fromUsername });
    const receiver = await User.findOne({ $or: orConditions });

    if (!sender) return res.status(404).json({ error: 'Pengirim tidak ditemukan' });
    if (!receiver) return res.status(404).json({ error: 'Penerima tidak ditemukan' });

    const actualToUsername = receiver.username;
    if (sender.username.toLowerCase() === actualToUsername.toLowerCase()) {
      return res.status(400).json({ error: 'Tidak bisa mengirim koin ke diri sendiri' });
    }

    // Check sender regular coins (bonusCoins is strictly for slot and cannot be transferred)
    if (sender.coins < transferAmount) {
      if (sender.bonusCoins > 0 && (sender.coins + sender.bonusCoins) >= transferAmount) {
        return res.status(400).json({
          error: 'Koin dari klaim bonus harian hanya dapat digunakan untuk bermain Slot dan tidak dapat ditransfer ke pemain lain!'
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
      const isSlot = gameType === 'slot' || req.body.isSlot === true || (typeof gameType === 'string' && gameType.toLowerCase().includes('slot'));

      if (!isSlot) {
        // Non-slot games (Domino, QiuQiu, Billiard, By One) CANNOT use daily bonus coins!
        if (user.coins < deduct) {
          if (user.bonusCoins > 0 && (user.coins + user.bonusCoins) >= deduct) {
            return res.status(400).json({
              error: 'Koin dari klaim bonus harian hanya dapat digunakan untuk game SLOT! Koin umum Anda tidak mencukupi.'
            });
          }
          return res.status(400).json({ error: 'Koin tidak mencukupi' });
        }
        // Deduct from regular coins
        user.coins = Math.max(0, user.coins - deduct);
      } else {
        // Slot games: consume bonusCoins first, then remainder from coins
        const totalAvail = (user.coins || 0) + (user.bonusCoins || 0);
        if (totalAvail < deduct) {
          return res.status(400).json({ error: 'Koin tidak mencukupi' });
        }
        spendUserCoins(user, deduct);
      }
    } else {
      user.coins = Math.max(0, user.coins + updateAmount);
    }
    await user.save();

    res.json({
      message: 'Koin berhasil diperbarui',
      coins: user.coins,
      bonusCoins: user.bonusCoins || 0,
      totalCoins: (user.coins || 0) + (user.bonusCoins || 0)
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

// Link Guest Account to Google Account
exports.linkGoogleAccount = async (req, res) => {
  try {
    const { currentUsername, userId, googleId, googleEmail, googleName, googleAvatar } = req.body;

    const cleanUserId = userId ? String(userId).trim() : '';
    const cleanCurrent = currentUsername ? String(currentUsername).trim() : '';
    const cleanEmail = googleEmail ? String(googleEmail).trim().toLowerCase() : '';
    const cleanGoogleId = googleId ? String(googleId).trim() : '';

    if (!cleanUserId && !cleanCurrent) {
      return res.status(400).json({ error: 'Identitas akun Tamu tidak ditemukan!' });
    }

    let user = null;
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

    if (!user) {
      return res.status(404).json({ error: 'Akun Tamu tidak ditemukan di server!' });
    }

    // Jika akun ini sudah dikaitkan sebelumnya
    if (user.authProvider === 'google' && (user.googleEmail || user.googleId)) {
      return res.status(400).json({
        error: `Akun ini sudah dikaitkan dengan akun Google${user.googleEmail ? ` (${user.googleEmail})` : ''}!`
      });
    }

    // Cek apakah akun Google tersebut sudah terhubung ke akun lain
    const conflictConditions = [];
    if (cleanGoogleId) conflictConditions.push({ googleId: cleanGoogleId });
    if (cleanEmail) conflictConditions.push({ googleEmail: cleanEmail });

    // Buat kandidat nama Google jika diberikan
    const rawName = String(googleName || '').replace(/^Google_/i, '').replace(/[^a-zA-Z0-9_]/g, '');
    const candidateGoogleUsername = rawName ? `Google_${rawName}`.slice(0, 16) : '';
    if (!cleanGoogleId && !cleanEmail && candidateGoogleUsername) {
      conflictConditions.push({
        username: new RegExp('^' + candidateGoogleUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
      });
    }

    if (conflictConditions.length > 0) {
      const conflictUser = await User.findOne({
        _id: { $ne: user._id },
        $or: conflictConditions
      });
      if (conflictUser) {
        return res.status(400).json({
          error: `Akun Google tersebut sudah terhubung ke akun lain (${conflictUser.username} • ID: #${conflictUser.userId || '-'}). Silakan pilih akun Google yang lain.`
        });
      }
    }

    const oldUsername = user.username;
    let finalUsername = user.username;

    // Jika username saat ini masih berformat Guest_xxxx dan ada nama Google, perbarui otomatis ke nama Google
    if (/^Guest_/i.test(user.username) && candidateGoogleUsername.length >= 3) {
      let targetName = candidateGoogleUsername;
      const existingSameName = await User.findOne({
        _id: { $ne: user._id },
        username: new RegExp('^' + targetName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
      });
      if (existingSameName) {
        const suffix = Math.floor(100 + Math.random() * 900);
        targetName = `${candidateGoogleUsername.slice(0, 12)}_${suffix}`;
      }
      finalUsername = targetName;
      user.username = finalUsername;
    }

    user.authProvider = 'google';
    if (cleanEmail) user.googleEmail = cleanEmail;
    if (cleanGoogleId) user.googleId = cleanGoogleId;

    // Jika avatar masih bawaan (🐸 atau /bg.png) dan ada foto profil Google, gunakan foto Google
    if (googleAvatar && (!user.avatar || user.avatar === '🐸' || user.avatar === '/bg.png')) {
      user.avatar = googleAvatar;
    }

    if (!user.userId) {
      user.userId = await generateUniqueUserId();
    }

    await user.save();

    // Jika username berubah dari Guest_xxxx ke Google_xxxx, sinkronkan relasi pertemanan & inbox
    if (oldUsername !== finalUsername) {
      try {
        await User.updateMany({ friends: oldUsername }, { $set: { "friends.$": finalUsername } });
        await User.updateMany({ friendRequests: oldUsername }, { $set: { "friendRequests.$": finalUsername } });
        await InboxMessage.updateMany({ toUsername: oldUsername }, { toUsername: finalUsername });
        await InboxMessage.updateMany({ fromUsername: oldUsername }, { fromUsername: finalUsername });
        await TransferHistory.updateMany({ toUsername: oldUsername }, { toUsername: finalUsername });
        await TransferHistory.updateMany({ fromUsername: oldUsername }, { fromUsername: finalUsername });
      } catch (relErr) {
        console.warn('Peringatan sinkronisasi relasi saat link Google:', relErr.message);
      }
    }

    // Kirim notifikasi Inbox bahwa akun telah aman dikaitkan
    try {
      await InboxMessage.create({
        toUsername: finalUsername,
        fromUsername: 'SISTEM',
        type: 'system',
        title: '🔗 Akun Berhasil Dikaitkan ke Google!',
        body: `Selamat! Akun Anda (ID: #${user.userId}) kini telah resmi dikaitkan dengan akun Google${cleanEmail ? ` (${cleanEmail})` : ''}. Koin (${(user.coins || 0).toLocaleString('id-ID')}), daftar teman, dan seluruh progres permainan Anda kini tersimpan permanen!`,
        icon: '🛡️',
        isRead: false
      });
    } catch (_) {}

    console.log(`[GOOGLE ACCOUNT LINKED] ${oldUsername} -> ${finalUsername} | ID: ${user.userId} | Email: ${cleanEmail || '-'}`);

    res.json({
      message: `Selamat! Akun Anda berhasil dikaitkan dengan Google${cleanEmail ? ` (${cleanEmail})` : ''}!`,
      username: finalUsername,
      oldUsername,
      userId: user.userId,
      coins: user.coins,
      avatar: user.avatar,
      authProvider: 'google',
      googleEmail: user.googleEmail || cleanEmail || null
    });
  } catch (error) {
    console.error('Link Google account error:', error);
    res.status(500).json({ error: error.message || 'Gagal mengaitkan akun Google' });
  }
};

// Google Login / Register (Supports accounts previously linked from Guest)
exports.googleLogin = async (req, res) => {
  try {
    const { googleId, googleEmail, googleName, googleAvatar } = req.body;
    const cleanEmail = googleEmail ? String(googleEmail).trim().toLowerCase() : '';
    const cleanGoogleId = googleId ? String(googleId).trim() : '';
    const rawName = String(googleName || '').replace(/^Google_/i, '').replace(/[^a-zA-Z0-9_]/g, '');
    const sanitizedUsername = (rawName ? `Google_${rawName}` : `Google_${Math.floor(1000 + Math.random() * 9000)}`).slice(0, 16);

    let user = null;

    // 1. Cari berdasarkan googleId atau googleEmail terlebih dahulu (menangkap akun Tamu yang sudah dikaitkan sekalipun namanya sudah diganti)
    if (cleanGoogleId) {
      user = await User.findOne({ googleId: cleanGoogleId });
    }
    if (!user && cleanEmail) {
      user = await User.findOne({ googleEmail: cleanEmail });
    }
    // 2. Fallback cari berdasarkan username Google
    if (!user && sanitizedUsername) {
      user = await User.findOne({
        username: new RegExp('^' + sanitizedUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
      });
    }

    if (user) {
      let modified = false;
      if (user.authProvider !== 'google') {
        user.authProvider = 'google';
        modified = true;
      }
      if (cleanGoogleId && !user.googleId) {
        user.googleId = cleanGoogleId;
        modified = true;
      }
      if (cleanEmail && !user.googleEmail) {
        user.googleEmail = cleanEmail;
        modified = true;
      }
      if (!user.userId) {
        user.userId = await generateUniqueUserId();
        modified = true;
      }
      if (googleAvatar && (!user.avatar || user.avatar === '/bg.png')) {
        user.avatar = googleAvatar;
        modified = true;
      }
      if (modified) await user.save();

      return res.json({
        message: 'Berhasil masuk dengan Google!',
        isNew: false,
        username: user.username,
        userId: user.userId,
        coins: user.coins,
        avatar: user.avatar || '🐸',
        customFrame: user.customFrame || 'crown',
        authProvider: 'google',
        googleEmail: user.googleEmail || cleanEmail || null
      });
    }

    // 3. Jika belum terdaftar, buat akun Google baru
    let targetUsername = sanitizedUsername;
    const existingName = await User.findOne({
      username: new RegExp('^' + targetUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
    });
    if (existingName) {
      targetUsername = `${sanitizedUsername.slice(0, 12)}_${Math.floor(100 + Math.random() * 900)}`;
    }

    const newUserId = await generateUniqueUserId();
    const initialAvatar = googleAvatar || '🐸';
    const newUser = new User({
      username: targetUsername,
      userId: newUserId,
      coins: 100000,
      rp: 0,
      score: 50,
      avatar: initialAvatar,
      authProvider: 'google',
      googleId: cleanGoogleId || null,
      googleEmail: cleanEmail || null,
      nameChangeCount: 0
    });
    await newUser.save();

    res.status(201).json({
      message: 'Akun Google berhasil didaftarkan!',
      isNew: true,
      username: newUser.username,
      userId: newUser.userId,
      coins: newUser.coins,
      avatar: newUser.avatar,
      customFrame: newUser.customFrame || 'crown',
      authProvider: 'google',
      googleEmail: newUser.googleEmail
    });
  } catch (error) {
    console.error('Google login error:', error);
    res.status(500).json({ error: error.message || 'Gagal masuk dengan Google' });
  }
};


