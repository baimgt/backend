const TransferHistory = require('../models/TransferHistory');
const User = require('../models/User');

// Get Transfer History for a user
exports.getTransferHistory = async (req, res) => {
  try {
    const { username } = req.params;
    const { type = 'all', limit = 50 } = req.query;

    if (!username) {
      return res.status(400).json({ error: 'Username diperlukan' });
    }

    let query = {};
    if (type === 'sent') {
      query = { fromUsername: username };
    } else if (type === 'received') {
      query = { toUsername: username };
    } else {
      query = {
        $or: [{ fromUsername: username }, { toUsername: username }]
      };
    }

    const items = await TransferHistory.find(query)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit, 10) || 50);

    // Calculate overall stats for this user
    const allUserTransfers = await TransferHistory.find({
      $or: [{ fromUsername: username }, { toUsername: username }]
    });

    let totalSent = 0;
    let totalReceived = 0;

    allUserTransfers.forEach(t => {
      if (t.fromUsername === username) {
        totalSent += t.amount || 0;
      }
      if (t.toUsername === username) {
        totalReceived += t.amount || 0;
      }
    });

    res.json({
      history: items,
      stats: {
        totalSent,
        totalReceived,
        totalCount: allUserTransfers.length
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
