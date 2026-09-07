const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true
  },
  avatar: {
    type: String,
    default: '/bg.png'
  },
  coins: {
    type: Number,
    default: 0
  },
  rp: {
    type: Number,
    default: 0
  },
  score: {
    type: Number,
    default: 0
  },
  friends: {
    type: [String],
    default: []
  },
  friendRequests: {
    type: [String],
    default: []
  },
  lastDailyBonus: {
    type: Date,
    default: null
  },
  dailyStreak: {
    type: Number,
    default: 0
  },
  bonusCoins: {
    type: Number,
    default: 0
  },
  bonusCoinsExpireAt: {
    type: Date,
    default: null
  },
  unlockedAvatars: {
    type: [String],
    default: ['🐸', '🦊', '🐶', '🐱']
  },
  vipLevel: {
    type: Number,
    default: 0
  },
  dailySentCoins: {
    type: Number,
    default: 0
  },
  lastSentDate: {
    type: Date,
    default: null
  }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
