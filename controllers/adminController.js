const User = require('../models/User');

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
      User.find(query, 'username userId avatar coins bonusCoins vipLevel role isAdmin createdAt')
        .sort({ coins: -1 })
        .skip(skip)
        .limit(l)
        .lean(),
      User.countDocuments(query)
    ]);

    const totalAdmins = await User.countDocuments({ $or: [{ role: 'admin' }, { isAdmin: true }] });

    res.json({
      success: true,
      users,
      total,
      totalAdmins,
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

    user.coins = Math.max(0, Number(coins) || 0);
    await user.save();

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

// GET /admin - Interactive HTML Dashboard
exports.renderDashboard = async (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard — Kings Domino & Billiard</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;700;800;900&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: rgba(20, 27, 45, 0.75);
      --border: rgba(255, 215, 0, 0.25);
      --gold: #ffd700;
      --gold-dark: #b8860b;
      --green: #10b981;
      --red: #ef4444;
      --text: #f8fafc;
      --text-dim: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Outfit', sans-serif;
      background: radial-gradient(circle at 50% 0%, #1e1b4b 0%, var(--bg) 70%);
      color: var(--text);
      min-height: 100vh;
      padding: 24px;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
      padding-bottom: 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      flex-wrap: wrap;
      gap: 16px;
    }
    .header h1 {
      font-size: 26px;
      font-weight: 900;
      background: linear-gradient(135deg, #fff, var(--gold));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 18px 20px;
      box-shadow: 0 8px 20px rgba(0,0,0,0.3);
    }
    .stat-label {
      font-size: 13px;
      color: var(--text-dim);
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .stat-val {
      font-size: 28px;
      font-weight: 900;
      color: var(--gold);
      margin-top: 6px;
    }
    .controls {
      display: flex;
      gap: 12px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .search-input {
      flex: 1;
      min-width: 260px;
      padding: 12px 18px;
      background: rgba(15, 23, 42, 0.8);
      border: 1px solid var(--border);
      border-radius: 10px;
      color: #fff;
      font-size: 15px;
      outline: none;
      transition: border-color 0.2s;
    }
    .search-input:focus {
      border-color: var(--gold);
    }
    .btn {
      padding: 10px 18px;
      border-radius: 10px;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      border: none;
      transition: transform 0.1s, filter 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }
    .btn:active { transform: scale(0.96); }
    .btn-gold {
      background: linear-gradient(135deg, #ffd700, #ff8f00);
      color: #000;
    }
    .btn-admin {
      background: linear-gradient(135deg, #10b981, #059669);
      color: #fff;
    }
    .btn-revoke {
      background: linear-gradient(135deg, #ef4444, #b91c1c);
      color: #fff;
    }
    .btn-coin {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
    }
    .btn-coin:hover { background: rgba(255, 255, 255, 0.2); }
    .table-card {
      background: var(--card-bg);
      backdrop-filter: blur(12px);
      border: 1px solid var(--border);
      border-radius: 14px;
      overflow-x: auto;
      box-shadow: 0 10px 30px rgba(0,0,0,0.4);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th {
      background: rgba(15, 23, 42, 0.7);
      padding: 14px 18px;
      font-size: 13px;
      font-weight: 700;
      color: var(--text-dim);
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    td {
      padding: 14px 18px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      font-size: 14px;
      vertical-align: middle;
    }
    tr:hover td {
      background: rgba(255, 255, 255, 0.02);
    }
    .user-cell {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .user-avatar {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: #111;
      border: 2px solid var(--gold);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.02em;
    }
    .badge-admin {
      background: rgba(16, 185, 129, 0.2);
      color: #34d399;
      border: 1px solid #10b981;
    }
    .badge-user {
      background: rgba(148, 163, 184, 0.15);
      color: #cbd5e1;
      border: 1px solid rgba(255, 255, 255, 0.15);
    }
    .badge-hidden {
      font-size: 10px;
      color: #fbbf24;
      background: rgba(245, 158, 11, 0.15);
      padding: 2px 6px;
      border-radius: 6px;
      margin-left: 6px;
    }
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #1e293b;
      border: 1px solid var(--gold);
      color: #fff;
      padding: 14px 20px;
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.5);
      z-index: 100;
      display: none;
      animation: slideIn 0.3s ease;
      font-weight: 600;
    }
    @keyframes slideIn { from { transform: translateY(20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
  </style>
</head>
<body>
  <div class="header">
    <h1>👑 Kings Domino & Slot — Admin Dashboard</h1>
    <div>
      <span style="color: var(--text-dim); font-size: 14px;">Kelola Role Admin & Pengecualian Leaderboard</span>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Total Akun Admin</div>
      <div class="stat-val" id="statAdmins">0</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Pemain Terdaftar</div>
      <div class="stat-val" id="statTotal">0</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Aturan Leaderboard</div>
      <div class="stat-val" style="font-size: 16px; color: #34d399; margin-top: 10px;">
        🛡️ Akun Admin 100% Otomatis Disembunyikan
      </div>
    </div>
  </div>

  <div class="controls">
    <input type="text" id="searchInput" class="search-input" placeholder="🔍 Cari username atau 8-digit Player ID..." onkeyup="handleSearch(event)">
    <button class="btn btn-gold" onclick="loadUsers()">🔄 Segarkan Data</button>
  </div>

  <div class="table-card">
    <table>
      <thead>
        <tr>
          <th>Pemain</th>
          <th>ID Pemain</th>
          <th>Status Role</th>
          <th>Saldo Koin</th>
          <th>VIP</th>
          <th style="text-align: right;">Aksi Role & Koin</th>
        </tr>
      </thead>
      <tbody id="userTableBody">
        <tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 40px;">Memuat data pemain...</td></tr>
      </tbody>
    </table>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    let searchTimeout;

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(() => { t.style.display = 'none'; }, 3500);
    }

    async function loadUsers(query = '') {
      try {
        const res = await fetch('/api/admin/users?q=' + encodeURIComponent(query));
        const data = await res.json();
        if (!data.success) return;

        document.getElementById('statTotal').innerText = data.total.toLocaleString('id-ID');
        document.getElementById('statAdmins').innerText = data.totalAdmins.toLocaleString('id-ID');

        const tbody = document.getElementById('userTableBody');
        if (data.users.length === 0) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-dim); padding: 40px;">Tidak ada pemain ditemukan.</td></tr>';
          return;
        }

        tbody.innerHTML = data.users.map(u => {
          const isAdmin = u.role === 'admin' || u.isAdmin;
          return \`
            <tr>
              <td>
                <div class="user-cell">
                  <div class="user-avatar">\${u.avatar || '🐸'}</div>
                  <div>
                    <div style="font-weight: 700; color: #fff;">\${u.username}</div>
                  </div>
                </div>
              </td>
              <td style="font-family: monospace; color: var(--gold); font-weight: 700;">\${u.userId || '-'}</td>
              <td>
                \${isAdmin 
                  ? '<span class="badge badge-admin">⭐ ADMIN</span><span class="badge-hidden">🚫 Tidak Masuk Leaderboard</span>' 
                  : '<span class="badge badge-user">USER</span>'}
              </td>
              <td style="font-weight: 800; color: #ffd700;">🪙 \${(u.coins || 0).toLocaleString('id-ID')}</td>
              <td><span style="color: #ffd54f; font-weight: 700;">VIP \${u.vipLevel || 0}</span></td>
              <td style="text-align: right;">
                <div style="display: inline-flex; gap: 8px;">
                  \${isAdmin ? \`
                    <button class="btn btn-revoke" onclick="toggleRole('\${u.username}', 'user')">❌ Cabut Admin</button>
                  \` : \`
                    <button class="btn btn-admin" onclick="toggleRole('\${u.username}', 'admin')">⭐ Jadikan Admin</button>
                  \`}
                  <button class="btn btn-coin" onclick="editCoins('\${u.username}', \${u.coins || 0})">✏️ Ubah Koin</button>
                </div>
              </td>
            </tr>
          \`;
        }).join('');
      } catch (err) {
        console.error(err);
      }
    }

    async function toggleRole(username, newRole) {
      const actionText = newRole === 'admin' ? 'menjadi ADMIN (disembunyikan dari leaderboard)?' : 'menjadi USER biasa (akan muncul di leaderboard jika koin tinggi)?';
      if (!confirm('Apakah Anda yakin ingin mengubah akun ' + username + ' ' + actionText)) return;

      try {
        const res = await fetch('/api/admin/set-role', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, role: newRole })
        });
        const d = await res.json();
        if (d.success) {
          showToast(d.message);
          loadUsers(document.getElementById('searchInput').value);
        } else {
          alert(d.error || 'Gagal mengubah role');
        }
      } catch (e) {
        alert('Gagal menghubungi server');
      }
    }

    async function editCoins(username, current) {
      const input = prompt('Masukkan jumlah saldo Koin baru untuk ' + username + ':', current);
      if (input === null) return;
      const num = parseInt(input.replace(/[^0-9]/g, ''), 10);
      if (isNaN(num)) {
        alert('Jumlah koin harus berupa angka!');
        return;
      }
      try {
        const res = await fetch('/api/admin/adjust-coins', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username, coins: num })
        });
        const d = await res.json();
        if (d.success) {
          showToast(d.message);
          loadUsers(document.getElementById('searchInput').value);
        } else {
          alert(d.error || 'Gagal mengubah koin');
        }
      } catch (e) {
        alert('Gagal menghubungi server');
      }
    }

    function handleSearch(e) {
      clearTimeout(searchTimeout);
      searchTimeout = setTimeout(() => {
        loadUsers(e.target.value);
      }, 300);
    }

    window.onload = () => loadUsers();
  </script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.send(html);
};
