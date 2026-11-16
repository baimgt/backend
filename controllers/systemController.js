const SystemConfig = require('../models/SystemConfig');

const DEFAULT_VERSION_CONFIG = {
  webVersion: '2.80',
  minWebVersion: '2.80',
  appVersion: '2.80',
  minAppVersion: '2.80',
  appVersionCode: 280,
  forceUpdateWeb: true,
  forceUpdateApp: true,
  downloadUrl: '/download',
  updateTitle: 'Pembaruan Wajib Tersedia',
  updateMessage: 'Pembaruan sistem terbaru telah dirilis untuk perbaikan performa, keamanan, dan fitur permainan. Anda wajib memperbarui game untuk dapat melanjutkan bermain.'
};

let cachedConfig = null;
let lastFetchTime = 0;
const CACHE_TTL_MS = 60 * 1000; // 1 menit

async function getSystemVersionConfig() {
  const now = Date.now();
  if (cachedConfig && (now - lastFetchTime) < CACHE_TTL_MS) {
    return cachedConfig;
  }

  try {
    let doc = await SystemConfig.findOne({ key: 'version_config' });
    if (!doc) {
      doc = await SystemConfig.create({
        key: 'version_config',
        value: DEFAULT_VERSION_CONFIG
      });
    }
    cachedConfig = { ...DEFAULT_VERSION_CONFIG, ...(doc.value || {}) };
    lastFetchTime = now;
    return cachedConfig;
  } catch (err) {
    console.error('Error fetching version_config from DB:', err.message);
    return cachedConfig || DEFAULT_VERSION_CONFIG;
  }
}

// GET /api/system/version (Public)
exports.getVersion = async (req, res) => {
  try {
    const config = await getSystemVersionConfig();
    res.json({
      success: true,
      ...config,
      serverTime: new Date().toISOString()
    });
  } catch (err) {
    console.error('systemController getVersion error:', err);
    res.status(500).json({ 
      success: false, 
      error: 'Gagal mengambil data versi sistem',
      ...DEFAULT_VERSION_CONFIG
    });
  }
};

// POST /api/admin/system/version (Admin Only)
exports.updateVersion = async (req, res) => {
  try {
    const body = req.body || {};
    const current = await getSystemVersionConfig();

    const updatedValue = {
      webVersion: (body.webVersion || current.webVersion || '2.80').trim(),
      minWebVersion: (body.minWebVersion || current.minWebVersion || '2.80').trim(),
      appVersion: (body.appVersion || current.appVersion || '2.80').trim(),
      minAppVersion: (body.minAppVersion || current.minAppVersion || '2.80').trim(),
      appVersionCode: parseInt(body.appVersionCode, 10) || current.appVersionCode || 280,
      forceUpdateWeb: body.forceUpdateWeb !== undefined ? Boolean(body.forceUpdateWeb) : current.forceUpdateWeb,
      forceUpdateApp: body.forceUpdateApp !== undefined ? Boolean(body.forceUpdateApp) : current.forceUpdateApp,
      downloadUrl: (body.downloadUrl || current.downloadUrl || '/download').trim(),
      updateTitle: (body.updateTitle || current.updateTitle || 'Pembaruan Wajib Tersedia').trim(),
      updateMessage: (body.updateMessage || current.updateMessage || DEFAULT_VERSION_CONFIG.updateMessage).trim()
    };

    const doc = await SystemConfig.findOneAndUpdate(
      { key: 'version_config' },
      { $set: { value: updatedValue } },
      { new: true, upsert: true }
    );

    cachedConfig = { ...DEFAULT_VERSION_CONFIG, ...(doc.value || updatedValue) };
    lastFetchTime = Date.now();

    // Broadcast via Socket.IO jika tersedia
    try {
      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('system:version_update', cachedConfig);
        console.log('[VERSION UPDATE BROADCASTED]', cachedConfig);
      }
    } catch (sockErr) {
      console.warn('Gagal broadcast socket version_update:', sockErr.message);
    }

    res.json({
      success: true,
      message: 'Pengaturan versi & force update berhasil disimpan!',
      config: cachedConfig
    });
  } catch (err) {
    console.error('systemController updateVersion error:', err);
    res.status(500).json({ error: 'Gagal menyimpan pengaturan versi: ' + err.message });
  }
};

exports.getSystemVersionConfig = getSystemVersionConfig;
