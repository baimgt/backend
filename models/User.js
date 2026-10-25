const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true
  },
  userId: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  avatar: {
    type: String,
    default: '🐸'
  },
  customFrame: {
    type: String,
    default: 'crown'
  },
  coins: {
    type: Number,
    default: 10000
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
  },
  nameChangeCount: {
    type: Number,
    default: 0
  }
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);
