const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const userController = require('./controllers/userController');
const inboxController = require('./controllers/inboxController');
const bonusController = require('./controllers/bonusController');
const shopController = require('./controllers/shopController');
const transferController = require('./controllers/transferController');
const { initSocketIO } = require('./gameManager');

const app = express();
const PORT = process.env.PORT || 8080;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://gamerstore:P1CwEUjy84OiTfAM@gamerstore.yy5ekdc.mongodb.net/domino_db?retryWrites=true&w=majority';

// Create HTTP server for both Express + Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Security Middlewares
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false
}));

// Rate limiter: mencegah serangan DDoS, spamming, dan brute-force API
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 menit
  max: 300, // Maksimal 300 request per menit per IP
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Terlalu banyak permintaan dari IP ini. Silakan coba lagi beberapa saat lagi.' }
});
app.use('/api/', apiLimiter);

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve Standalone APK Download Landing Page
app.use('/download', express.static(path.join(__dirname, '../landing-page')));

// Database Connection
console.log('Menghubungkan ke database MongoDB...');
mongoose.connect(MONGO_URI)
  .then(() => {
    console.log('Berhasil terhubung ke MongoDB!');
  })
  .catch((err) => {
    console.error('Gagal menghubungkan ke MongoDB:', err.message);
    process.exit(1);
  });

// Health Check & Root Info
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'Backend Kings Billiard & Domino Server is Running!',
    time: new Date().toISOString()
  });
});

// Routes
app.get('/api/profile/:username', userController.getProfile);
app.get('/api/leaderboard', userController.getLeaderboard);
app.post('/api/users', userController.createUser);
app.get('/api/users', userController.getUsersList);
app.post('/api/friends/add', userController.sendFriendRequest);
app.post('/api/friends/accept', userController.acceptFriendRequest);
app.post('/api/friends/decline', userController.declineFriendRequest);
app.post('/api/friends/remove', userController.removeFriend);
app.post('/api/transfer', userController.transferCoins);
app.post('/api/users/transfer', userController.transferCoins);
app.get('/api/transfers/:username', transferController.getTransferHistory);
app.post('/api/users/update-coins', userController.updateCoins);
app.post('/api/users/avatar', userController.updateAvatar);
app.post('/api/users/change-username', userController.changeUsername);

// Inbox routes
app.get('/api/inbox/:username',           inboxController.getInbox);
app.post('/api/inbox/send',               inboxController.sendMessage);
app.post('/api/inbox/read/:id',           inboxController.markRead);
app.post('/api/inbox/read-all',           inboxController.markAllRead);
app.delete('/api/inbox/:id',              inboxController.deleteMessage);
app.delete('/api/inbox/clear/:username',  inboxController.clearInbox);
app.post('/api/inbox/seed-welcome/:username', inboxController.seedWelcome);

// Daily Bonus routes
app.get('/api/bonus/status/:username',    bonusController.getDailyBonusStatus);
app.post('/api/bonus/claim',              bonusController.claimDailyBonus);

// Shop routes
app.get('/api/shop/catalog',                      shopController.getCatalog);
app.post('/api/shop/buy-coins',                   shopController.buyCoins);
app.post('/api/shop/buy-avatar',                  shopController.buyAvatar);
app.post('/api/shop/buy-vip',                     shopController.buyVip);
app.post('/api/shop/convert-rp',                  shopController.convertRp);
app.post('/api/shop/verify-playstore-purchase',    shopController.verifyPlayStorePurchase);

// Initialize Socket.IO game events
initSocketIO(io);

// Start Server
server.listen(PORT, () => {
  console.log(`Server Node.js + Socket.IO berjalan di http://localhost:${PORT}`);
});
