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

function parseVersion(v) {
  if (!v) return [0, 0, 0];
  const cleaned = String(v).replace(/^v/i, '').trim();
  const parts = cleaned.split('.').map(p => parseInt(p, 10) || 0);
  while (parts.length < 3) parts.push(0);
  return parts;
}

function compareVersions(v1, v2) {
  const p1 = parseVersion(v1);
  const p2 = parseVersion(v2);
  for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

function isVersionOutdated(clientVer, minVer) {
  if (!minVer) return false;
  if (!clientVer) return true; // Tidak ada versi = APK / web versi lama
  return compareVersions(clientVer, minVer) < 0;
}

/**
 * Validasi apakah koneksi socket berasal dari klien lama yang belum diupdate
 */
async function checkSocketIsOutdated(socket) {
  try {
    const config = await getSystemVersionConfig();
    const platform = socket.platform || 
      socket.handshake?.auth?.platform || 
      socket.handshake?.query?.platform ||
      (socket.handshake?.headers?.origin?.includes('localhost') ? 'android' : 'web');
    
    const clientVersion = socket.clientVersion || 
      socket.handshake?.auth?.clientVersion || 
      socket.handshake?.query?.clientVersion || 
      null;

    const isApp = platform === 'android' || platform === 'ios' || platform === 'app';

    if (isApp) {
      if (config.forceUpdateApp && isVersionOutdated(clientVersion, config.minAppVersion || config.appVersion)) {
        return {
          outdated: true,
          platform: 'app',
          clientVersion,
          minVersion: config.minAppVersion || config.appVersion,
          downloadUrl: config.downloadUrl || '/download',
          message: config.updateMessage || 'Aplikasi Anda versi lama! Silakan download update APK terbaru untuk melanjutkan bermain.'
        };
      }
    } else {
      if (config.forceUpdateWeb && isVersionOutdated(clientVersion, config.minWebVersion || config.webVersion)) {
        return {
          outdated: true,
          platform: 'web',
          clientVersion,
          minVersion: config.minWebVersion || config.webVersion,
          downloadUrl: '/',
          message: config.updateMessage || 'Halaman game versi lama! Silakan refresh browser Anda untuk melanjutkan bermain.'
        };
      }
    }

    return { outdated: false };
  } catch (err) {
    console.error('Error in checkSocketIsOutdated:', err.message);
    return { outdated: false };
  }
}

/**
 * Helper untuk verifikasi versi pada handler socket game (slot/domino/billiard/dll).
 * Mengembalikan false jika klien kadaluarsa (dan otomatis mengirim emit error ke klien).
 */
async function assertClientVersion(socket, errorEventName) {
  const check = await checkSocketIsOutdated(socket);
  if (check.outdated) {
    if (errorEventName) {
      socket.emit(errorEventName, {
        error: check.message,
        message: check.message,
        updateRequired: true,
        minVersion: check.minVersion,
        downloadUrl: check.downloadUrl
      });
    }
    return false;
  }
  return true;
}

/**
 * Middleware Express untuk memblokir request API dari klien aplikasi/web versi lama
 */
async function requireClientVersion(req, res, next) {
  try {
    const config = await getSystemVersionConfig();
    const clientVersion = req.headers['x-client-version'] || req.query.clientVersion || null;
    const clientPlatform = req.headers['x-client-platform'] || req.query.platform || null;
    
    const origin = req.headers['origin'] || req.headers['referer'] || '';
    const userAgent = req.headers['user-agent'] || '';
    const isApp = clientPlatform === 'android' || 
                  clientPlatform === 'ios' || 
                  origin.includes('localhost') || 
                  origin.includes('capacitor://') ||
                  /android|wv|okhttp/i.test(userAgent);

    if (isApp) {
      if (config.forceUpdateApp && isVersionOutdated(clientVersion, config.minAppVersion || config.appVersion)) {
        return res.status(426).json({
          success: false,
          error: config.updateMessage || 'Aplikasi Anda versi lama! Silakan download APK terbaru untuk melanjutkan bermain.',
          updateRequired: true,
          platform: 'app',
          minVersion: config.minAppVersion || config.appVersion,
          downloadUrl: config.downloadUrl || '/download'
        });
      }
    } else {
      if (config.forceUpdateWeb && isVersionOutdated(clientVersion, config.minWebVersion || config.webVersion)) {
        return res.status(426).json({
          success: false,
          error: config.updateMessage || 'Halaman game versi lama! Silakan refresh browser Anda untuk melanjutkan bermain.',
          updateRequired: true,
          platform: 'web',
          minVersion: config.minWebVersion || config.webVersion,
          downloadUrl: '/'
        });
      }
    }
  } catch (err) {
    console.error('requireClientVersion middleware error:', err);
  }
  next();
}

exports.parseVersion = parseVersion;
exports.compareVersions = compareVersions;
exports.isVersionOutdated = isVersionOutdated;
exports.checkSocketIsOutdated = checkSocketIsOutdated;
exports.assertClientVersion = assertClientVersion;
exports.requireClientVersion = requireClientVersion;
