const mongoose = require('mongoose');

const coinLogSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    index: true
  },
  userId: {
    type: String,
    index: true
  },
  source: {
    type: String,
    required: true,
    index: true // e.g. 'slot_zeus', 'slot_mahjong', 'slot_gatokaca', 'billiard', 'qiuqiu', 'domino', 'transfer_in', 'transfer_out', 'daily_bonus', 'shop_topup', 'admin_adjust', 'vip_bonus', 'rp_exchange'
  },
  gameName: {
    type: String,
    default: 'Game'
  },
  type: {
    type: String,
    enum: ['gain', 'spend'],
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true
  },
  balanceBefore: {
    type: Number,
    default: 0
  },
  balanceAfter: {
    type: Number,
    default: 0
  },
  description: {
    type: String,
    default: ''
  },
  meta: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, { timestamps: true });

coinLogSchema.index({ username: 1, createdAt: -1 });
coinLogSchema.index({ source: 1, createdAt: -1 });
coinLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('CoinLog', coinLogSchema);
