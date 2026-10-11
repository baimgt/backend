const mongoose = require('mongoose');

const transferHistorySchema = new mongoose.Schema({
  transactionId: { 
    type: String, 
    required: true, 
    unique: true,
    index: true 
  },
  fromUsername: { 
    type: String, 
    required: true, 
    index: true 
  },
  toUsername: { 
    type: String, 
    required: true, 
    index: true 
  },
  amount: { 
    type: Number, 
    required: true 
  },
  senderVip: { 
    type: Number, 
    default: 0 
  },
  senderBalanceAfter: { 
    type: Number, 
    default: 0 
  },
  receiverBalanceAfter: { 
    type: Number, 
    default: 0 
  },
  status: { 
    type: String, 
    enum: ['success', 'failed', 'pending'], 
    default: 'success' 
  },
  note: { 
    type: String, 
    default: 'Transfer Koin' 
  }
}, { timestamps: true });

module.exports = mongoose.model('TransferHistory', transferHistorySchema);
