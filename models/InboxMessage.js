const mongoose = require('mongoose');

const inboxMessageSchema = new mongoose.Schema({
  toUsername: { type: String, required: true, index: true },
  fromUsername: { type: String, default: 'SISTEM' },
  type: { 
    type: String, 
    enum: ['system', 'friend_request', 'gift', 'achievement', 'transfer'],
    default: 'system'
  },
  title: { type: String, required: true },
  body: { type: String, required: true },
  icon: { type: String, default: '📬' },
  isRead: { type: Boolean, default: false },
  data: { type: mongoose.Schema.Types.Mixed, default: null }, // extra payload
}, { timestamps: true });

module.exports = mongoose.model('InboxMessage', inboxMessageSchema);
