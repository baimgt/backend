const InboxMessage = require('../models/InboxMessage');
const User = require('../models/User');

// GET /api/inbox/:username — ambil semua pesan
exports.getInbox = async (req, res) => {
  try {
    const { username } = req.params;
    const messages = await InboxMessage.find({ toUsername: username })
      .sort({ createdAt: -1 })
      .limit(50);
    const unreadCount = await InboxMessage.countDocuments({ toUsername: username, isRead: false });
    res.json({ messages, unreadCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/inbox/read/:id — tandai 1 pesan sebagai dibaca
exports.markRead = async (req, res) => {
  try {
    await InboxMessage.findByIdAndUpdate(req.params.id, { isRead: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/inbox/read-all — tandai semua sebagai dibaca
exports.markAllRead = async (req, res) => {
  try {
    const { username } = req.body;
    await InboxMessage.updateMany({ toUsername: username, isRead: false }, { isRead: true });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// DELETE /api/inbox/:id — hapus 1 pesan
exports.deleteMessage = async (req, res) => {
  try {
    await InboxMessage.findByIdAndDelete(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// DELETE /api/inbox/clear/:username — hapus semua pesan user
exports.clearInbox = async (req, res) => {
  try {
    await InboxMessage.deleteMany({ toUsername: req.params.username });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/inbox/send — kirim pesan (internal/sistem)
exports.sendMessage = async (req, res) => {
  try {
    const { toUsername, fromUsername, type, title, body, icon, data } = req.body;
    const msg = new InboxMessage({ toUsername, fromUsername, type, title, body, icon, data });
    await msg.save();
    res.status(201).json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

// POST /api/inbox/seed-welcome/:username — kirim pesan selamat datang jika belum ada
exports.seedWelcome = async (req, res) => {
  try {
    const { username } = req.params;
    const exists = await InboxMessage.findOne({ toUsername: username, type: 'system' });
    if (!exists) {
      const welcomeMessages = [
        {
          toUsername: username, fromUsername: 'DOMINO', type: 'system',
          title: '🎉 Selamat Datang!',
          body: `Halo ${username}! Selamat bergabung di DOMINO — Game Kasino Online #1. Nikmati berbagai game seru dan menangkan jutaan koin!`,
          icon: '🎉',
        },
        {
          toUsername: username, fromUsername: 'DOMINO', type: 'gift',
          title: '🎁 Bonus Login Pertama',
          body: 'Anda mendapatkan 10.000 koin bonus sebagai hadiah pembuatan akun baru. Selamat bermain!',
          icon: '🎁',
        },
        {
          toUsername: username, fromUsername: 'SISTEM', type: 'achievement',
          title: '🏆 Prestasi: Pemain Baru',
          body: 'Anda membuka prestasi "Pemain Baru". Terus bermain untuk membuka lebih banyak prestasi!',
          icon: '🏆',
        },
      ];
      await InboxMessage.insertMany(welcomeMessages);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
