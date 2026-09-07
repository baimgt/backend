const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const userController = require('./controllers/userController');
const inboxController = require('./controllers/inboxController');
const bonusController = require('./controllers/bonusController');
const shopController = require('./controllers/shopController');
const { initSocketIO } = require('./gameManager');

const app = express();
const PORT = 8080;

// Create HTTP server for both Express + Socket.IO
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Database Connection
console.log('Menghubungkan ke database MongoDB...');
mongoose.connect('mongodb://localhost:27017/domino_db')
  .then(() => {
    console.log('Berhasil terhubung ke MongoDB!');
  })
  .catch((err) => {
    console.error('Gagal menghubungkan ke MongoDB:', err.message);
    process.exit(1);
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
app.post('/api/users/update-coins', userController.updateCoins);

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
app.get('/api/shop/catalog',              shopController.getCatalog);
app.post('/api/shop/buy-coins',           shopController.buyCoins);
app.post('/api/shop/buy-avatar',          shopController.buyAvatar);
app.post('/api/shop/buy-vip',             shopController.buyVip);
app.post('/api/shop/convert-rp',          shopController.convertRp);

// Initialize Socket.IO game events
initSocketIO(io);

// Start Server
server.listen(PORT, () => {
  console.log(`Server Node.js + Socket.IO berjalan di http://localhost:${PORT}`);
});
