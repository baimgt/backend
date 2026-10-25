const mongoose = require('mongoose');

const paymentRecordSchema = new mongoose.Schema({
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  purchaseToken: {
    type: String,
    sparse: true,
    index: true
  },
  username: {
    type: String,
    required: true,
    index: true
  },
  packageId: {
    type: String,
    required: true
  },
  itemType: {
    type: String,
    enum: ['coin', 'vip'],
    default: 'coin'
  },
  amountCoins: {
    type: Number,
    default: 0
  },
  paymentMethod: {
    type: String,
    default: 'Google Play Store'
  },
  status: {
    type: String,
    default: 'COMPLETED'
  }
}, { timestamps: true });

module.exports = mongoose.model('PaymentRecord', paymentRecordSchema);
