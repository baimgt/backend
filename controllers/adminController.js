const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Auto-load .env if not loaded yet
try {
  const envPath = path.join(__dirname, '../.env');
  if (fs.existsSync(envPath)) {
    const envLines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
    for (const line of envLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx !== -1) {
        const key = trimmed.substring(0, idx).trim();
        const val = trimmed.substring(idx + 1).trim();
        if (key && !process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  }
} catch (e) {}
const User = require('../models/User');
const CoinLog = require('../models/CoinLog');
const InboxMessage = require('../models/InboxMessage');
const { recordCoinLog } = require('../helpers/coinLogger');

// Rate limiting & lockout tracking: IP -> { attempts: number, lockedUntil: number }
const loginAttempts = new Map();

// Active sessions: token -> { ip: string, createdAt: number, expiresAt: number }
const adminSessions = new Map();

const MAX_ATTEMPTS = 3;
const LOCKOUT_DURATION_MS = 60 * 60 * 1000; // 1 jam = 3,600,000 ms
const SESSION_DURATION_MS = 24 * 60 * 60 * 1000; // 24 jam

const dashboardHtmlPath = path.join(__dirname, 'adminDashboard.html');
let cachedDashboardHtml = null;

function normalizeIp(ip) {
  if (!ip) return '127.0.0.1';
  let clean = String(ip).trim();
  if (clean.startsWith('::ffff:')) {
    clean = clean.substring(7);
  }
  if (clean === '::1') {
    clean = '127.0.0.1';
  }
  return clean;
}

function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) return normalizeIp(cfIp);
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return normalizeIp(forwarded.split(',')[0]);
  const realIp = req.headers['x-real-ip'];
  if (realIp) return normalizeIp(realIp);
  return normalizeIp(req.socket ? req.socket.remoteAddress : req.ip);
}

function parseCookies(req) {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return {};
  const cookies = {};
  cookieHeader.split(';').forEach(c => {
    const parts = c.trim().split('=');
    if (parts[0]) cookies[parts[0]] = decodeURIComponent(parts.slice(1).join('='));
  });
  return cookies;
}

function getIpLockState(ip) {
  const now = Date.now();
  const state = loginAttempts.get(ip);
  if (!state) {
    return { attempts: 0, locked: false, remainingLockSeconds: 0 };
  }
  if (state.lockedUntil && state.lockedUntil > now) {
    return {
      attempts: state.attempts || MAX_ATTEMPTS,
      locked: true,
      remainingLockSeconds: Math.ceil((state.lockedUntil - now) / 1000)
    };
  }
  if (state.lockedUntil && state.lockedUntil <= now) {
    loginAttempts.delete(ip);
    return { attempts: 0, locked: false, remainingLockSeconds: 0 };
  }
  return {
    attempts: state.attempts || 0,
    locked: false,
    remainingLockSeconds: 0
  };
}

function formatLockDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m > 0) return `${m} menit ${s} detik`;
  return `${s} detik`;
}

// Clean up expired sessions & locks periodically (every 30 mins)
setInterval(() => {
  const now = Date.now();
  for (const [token, sess] of adminSessions.entries()) {
    if (sess.expiresAt < now) {
      adminSessions.delete(token);
    }
  }
  for (const [ip, state] of loginAttempts.entries()) {
    if (state.lockedUntil && state.lockedUntil < now) {
      loginAttempts.delete(ip);
    }
  }
}, 30 * 60 * 1000);

// POST /api/admin/login
exports.login = async (req, res) => {
  try {
    const ip = getClientIp(req);
    const lockState = getIpLockState(ip);

    if (lockState.locked) {
      return res.status(429).json({
        success: false,
        locked: true,
        remainingLockSeconds: lockState.remainingLockSeconds,
        error: `Akses ditolak! Terlalu banyak percobaan salah (3x). Silakan coba lagi dalam ${formatLockDuration(lockState.remainingLockSeconds)}.`
      });
    }

    const { password } = req.body;
    let adminPassword = (process.env.ADMIN_PASSWORD || '88889999').trim();
    adminPassword = adminPassword.replace(/^["']|["']$/g, '').trim();

    if (!password || String(password).trim() !== adminPassword) {
      const state = loginAttempts.get(ip) || { attempts: 0 };
      state.attempts = (state.attempts || 0) + 1;

      if (state.attempts >= MAX_ATTEMPTS) {
        state.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
        loginAttempts.set(ip, state);
        return res.status(429).json({
          success: false,
          locked: true,
          remainingLockSeconds: 3600,
          error: 'Password salah 3 kali! Akses ke halaman admin dikunci selama 1 jam.'
        });
      } else {
        loginAttempts.set(ip, state);
        const attemptsLeft = MAX_ATTEMPTS - state.attempts;
        return res.status(401).json({
          success: false,
          locked: false,
          attemptsLeft,
          error: `Password salah! Sisa percobaan: ${attemptsLeft} dari ${MAX_ATTEMPTS}.`
        });
      }
    }

    // Password valid! Clear failed attempts
    loginAttempts.delete(ip);

    // Generate token
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, {
      ip,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_DURATION_MS
    });

    // Set cookie
    res.setHeader('Set-Cookie', `admin_token=${token}; Path=/; SameSite=Lax; Max-Age=86400`);

    return res.json({
      success: true,
      message: 'Login admin berhasil',
      token
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Terjadi kesalahan sistem saat login' });
  }
};

// GET /api/admin/auth-status
exports.getAuthStatus = async (req, res) => {
  try {
    const ip = getClientIp(req);
    const lockState = getIpLockState(ip);

    if (lockState.locked) {
      return res.json({
        authenticated: false,
        locked: true,
        remainingLockSeconds: lockState.remainingLockSeconds,
        attemptsLeft: 0
      });
    }

    // Check token from header or cookie
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.headers['x-admin-token']) {
      token = req.headers['x-admin-token'];
    } else {
      const cookies = parseCookies(req);
      if (cookies.admin_token) token = cookies.admin_token;
    }

    let authenticated = false;
    if (token) {
      const session = adminSessions.get(token);
      if (session && session.expiresAt > Date.now()) {
        authenticated = true;
      } else if (session) {
        adminSessions.delete(token);
      }
    }

    const attemptsLeft = MAX_ATTEMPTS - lockState.attempts;

    return res.json({
      authenticated,
      locked: false,
      remainingLockSeconds: 0,
      attemptsLeft: Math.max(0, attemptsLeft)
    });
  } catch (err) {
    console.error('Admin auth status error:', err);
    res.status(500).json({ error: 'Gagal mengecek status auth' });
  }
};

// POST /api/admin/logout
exports.logout = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let token = null;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.headers['x-admin-token']) {
      token = req.headers['x-admin-token'];
    } else {
      const cookies = parseCookies(req);
      if (cookies.admin_token) token = cookies.admin_token;
    }

    if (token) {
      adminSessions.delete(token);
    }

    res.setHeader('Set-Cookie', 'admin_token=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
    res.json({ success: true, message: 'Logout admin berhasil' });
  } catch (err) {
    console.error('Admin logout error:', err);
    res.status(500).json({ error: 'Gagal logout' });
  }
};

// Middleware: requireAdminAuth
exports.requireAdminAuth = (req, res, next) => {
  const ip = getClientIp(req);
  const lockState = getIpLockState(ip);
  if (lockState.locked) {
    return res.status(429).json({
      success: false,
      locked: true,
      remainingLockSeconds: lockState.remainingLockSeconds,
      error: `Akses ditolak! Terlalu banyak percobaan salah (3x). Silakan coba lagi dalam ${formatLockDuration(lockState.remainingLockSeconds)}.`
    });
  }

  const authHeader = req.headers.authorization;
  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.headers['x-admin-token']) {
    token = req.headers['x-admin-token'];
  } else {
    const cookies = parseCookies(req);
    if (cookies.admin_token) token = cookies.admin_token;
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Akses ditolak: Autentikasi admin diperlukan. Silakan login terlebih dahulu.'
    });
  }

  const session = adminSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (session) adminSessions.delete(token);
    return res.status(401).json({
      success: false,
      error: 'Sesi admin telah kedaluwarsa atau tidak valid. Silakan login kembali.'
    });
  }

  next();
};

// GET /api/admin/users
exports.getUsers = async (req, res) => {
  try {
    const { q, page = 1, limit = 50 } = req.query;
    const query = {};
    if (q && q.trim()) {
      const regex = new RegExp(q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ username: regex }, { userId: regex }];
    }

    const p = Math.max(1, parseInt(page) || 1);
    const l = Math.min(100, Math.max(1, parseInt(limit) || 50));
    const skip = (p - 1) * l;

    const [users, total] = await Promise.all([
      User.find(query, 'username userId avatar coins bonusCoins vipLevel role isAdmin slotAlwaysLose createdAt')
        .sort({ coins: -1 })
        .skip(skip)
        .limit(l)
        .lean(),
      User.countDocuments(query)
    ]);

    const totalAdmins = await User.countDocuments({ $or: [{ role: 'admin' }, { isAdmin: true }] });
    const totalSlotLocked = await User.countDocuments({ slotAlwaysLose: true });

    res.json({
      success: true,
      users,
      total,
      totalAdmins,
      totalSlotLocked,
      page: p,
      totalPages: Math.ceil(total / l)
    });
  } catch (err) {
    console.error('Admin getUsers error:', err);
    res.status(500).json({ error: 'Gagal mengambil data pengguna' });
  }
};

// POST /api/admin/set-role
exports.setRole = async (req, res) => {
  try {
    const { username, userId, role } = req.body;
    if (!username && !userId) {
      return res.status(400).json({ error: 'Username atau userId wajib diisi' });
    }
    const targetRole = role === 'admin' ? 'admin' : 'user';
    const isAdmin = targetRole === 'admin';

    const filter = username ? { username } : { userId };
    const user = await User.findOne(filter);
    if (!user) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    user.role = targetRole;
    user.isAdmin = isAdmin;
    await user.save();

    res.json({
      success: true,
      message: `Berhasil mengubah role akun ${user.username} menjadi ${targetRole.toUpperCase()}${isAdmin ? ' (Otomatis disembunyikan dari Leaderboard)' : ' (Akan tampil normal di Leaderboard)'}`,
      user: {
        username: user.username,
        userId: user.userId,
        role: user.role,
        isAdmin: user.isAdmin,
        coins: user.coins
      }
    });
  } catch (err) {
    console.error('Admin setRole error:', err);
    res.status(500).json({ error: 'Gagal memperbarui role' });
  }
};

// POST /api/admin/toggle-slot-lock
exports.toggleSlotLock = async (req, res) => {
  try {
    const { username, userId, slotAlwaysLose } = req.body;
    if (!username && !userId) {
      return res.status(400).json({ error: 'Username atau userId wajib diisi' });
    }

    const filter = username ? { username } : { userId };
    const user = await User.findOne(filter);
    if (!user) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    user.slotAlwaysLose = typeof slotAlwaysLose === 'boolean' ? slotAlwaysLose : !user.slotAlwaysLose;
    await user.save();

    res.json({
      success: true,
      message: user.slotAlwaysLose
        ? `⚠️ AKUN ${user.username} DIKUNCI! Pemain ini TIDAK AKAN PERNAH BISA MENANG di semua game slot (RTP 0% / Selalu Rungkad).`
        : `✅ Kunci slot akun ${user.username} DIBUKA! Permainan slot kembali normal.`,
      slotAlwaysLose: user.slotAlwaysLose,
      username: user.username,
      userId: user.userId
    });
  } catch (err) {
    console.error('Admin toggleSlotLock error:', err);
    res.status(500).json({ error: 'Gagal mengubah status kunci slot' });
  }
};

// POST /api/admin/adjust-coins
exports.adjustCoins = async (req, res) => {
  try {
    const { username, userId, coins } = req.body;
    if ((!username && !userId) || coins === undefined) {
      return res.status(400).json({ error: 'Parameter tidak lengkap' });
    }
    const filter = username ? { username } : { userId };
    const user = await User.findOne(filter);
    if (!user) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    const oldCoins = user.coins || 0;
    const newCoins = Math.max(0, Number(coins) || 0);
    const diff = newCoins - oldCoins;

    user.coins = newCoins;
    await user.save();

    if (diff !== 0) {
      recordCoinLog({
        username: user.username,
        userId: user.userId,
        source: 'admin_adjust',
        gameName: 'Admin Panel',
        type: diff > 0 ? 'gain' : 'spend',
        amount: Math.abs(diff),
        balanceBefore: oldCoins,
        balanceAfter: user.coins,
        description: `Admin mengatur saldo koin dari ${oldCoins.toLocaleString('id-ID')} menjadi ${newCoins.toLocaleString('id-ID')}`
      });
    }

    res.json({
      success: true,
      message: `Saldo koin ${user.username} berhasil diatur menjadi ${user.coins.toLocaleString('id-ID')}`,
      coins: user.coins
    });
  } catch (err) {
    console.error('Admin adjustCoins error:', err);
    res.status(500).json({ error: 'Gagal mengubah koin' });
  }
};

// GET /api/admin/coin-logs
exports.getCoinLogs = async (req, res) => {
  try {
    const { username, userId, source, type, page = 1, limit = 50 } = req.query;
    const query = {};
    if (username && username.trim()) query.username = username.trim();
    if (userId && userId.trim()) query.userId = userId.trim();
    if (source && source.trim()) query.source = source.trim();
    if (type && type.trim()) query.type = type.trim();

    const p = Math.max(1, parseInt(page) || 1);
    const l = Math.min(200, Math.max(1, parseInt(limit) || 50));
    const skip = (p - 1) * l;

    const [logs, total] = await Promise.all([
      CoinLog.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(l)
        .lean(),
      CoinLog.countDocuments(query)
    ]);

    // Aggregate source breakdown (dari game/sumber mana saja koin diperoleh)
    const breakdownMatch = {};
    if (query.username) breakdownMatch.username = query.username;
    if (query.userId) breakdownMatch.userId = query.userId;

    const [breakdownByGame, totals] = await Promise.all([
      CoinLog.aggregate([
        { $match: breakdownMatch },
        {
          $group: {
            _id: '$gameName',
            source: { $first: '$source' },
            totalGained: {
              $sum: { $cond: [{ $eq: ['$type', 'gain'] }, '$amount', 0] }
            },
            totalSpent: {
              $sum: { $cond: [{ $eq: ['$type', 'spend'] }, '$amount', 0] }
            },
            winCount: {
              $sum: { $cond: [{ $eq: ['$type', 'gain'] }, 1, 0] }
            },
            loseCount: {
              $sum: { $cond: [{ $eq: ['$type', 'spend'] }, 1, 0] }
            },
            count: { $sum: 1 },
            latestAt: { $max: '$createdAt' }
          }
        },
        { $sort: { totalGained: -1, totalSpent: -1 } }
      ]),
      CoinLog.aggregate([
        { $match: breakdownMatch },
        {
          $group: {
            _id: '$type',
            total: { $sum: '$amount' },
            count: { $sum: 1 }
          }
        }
      ])
    ]);

    let totalGained = 0;
    let totalSpent = 0;
    totals.forEach(t => {
      if (t._id === 'gain') totalGained = t.total;
      if (t._id === 'spend') totalSpent = t.total;
    });

    res.json({
      success: true,
      logs,
      total,
      page: p,
      totalPages: Math.ceil(total / l),
      stats: {
        totalGained,
        totalSpent,
        netChange: totalGained - totalSpent,
        breakdownByGame
      }
    });
  } catch (err) {
    console.error('Admin getCoinLogs error:', err);
    res.status(500).json({ error: 'Gagal mengambil data log koin' });
  }
};

// POST /api/admin/delete-user
exports.deleteUser = async (req, res) => {
  try {
    const { username, userId } = req.body;
    if (!username && !userId) {
      return res.status(400).json({ error: 'Username atau userId wajib diisi' });
    }

    const filter = username ? { username } : { userId };
    const user = await User.findOne(filter);
    if (!user) {
      return res.status(404).json({ error: 'Pemain tidak ditemukan' });
    }

    const targetUsername = user.username;
    const targetUserId = user.userId || '-';

    // Bersihkan user dan semua data terkait
    await Promise.all([
      User.deleteOne({ _id: user._id }),
      User.updateMany({ friends: targetUsername }, { $pull: { friends: targetUsername } }),
      User.updateMany({ friendRequests: targetUsername }, { $pull: { friendRequests: targetUsername } }),
      InboxMessage.deleteMany({ $or: [{ toUsername: targetUsername }, { fromUsername: targetUsername }] }),
      CoinLog.deleteMany({ username: targetUsername })
    ]);

    res.json({
      success: true,
      message: `Akun "${targetUsername}" (ID: ${targetUserId}) berhasil dihapus permanen beserta semua datanya.`
    });
  } catch (err) {
    console.error('Admin deleteUser error:', err);
    res.status(500).json({ error: 'Gagal menghapus akun: ' + err.message });
  }
};

// GET /admin - Interactive HTML Dashboard
exports.renderDashboard = async (req, res) => {
  try {
    if (!cachedDashboardHtml || process.env.NODE_ENV !== 'production') {
      cachedDashboardHtml = fs.readFileSync(dashboardHtmlPath, 'utf8');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(cachedDashboardHtml);
  } catch (err) {
    console.error('Error rendering admin dashboard:', err);
    res.status(500).send('Gagal memuat dashboard admin');
  }
};
