const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { addonBuilder } = require('stremio-addon-sdk');
const PlaylistTransformer = require('./src/playlist-transformer');
const { catalogHandler, streamHandler } = require('./src/handlers');
const metaHandler = require('./src/meta-handler');
const EPGManagerModule = require('./src/epg-manager');
const getEPGManager = EPGManagerModule.getEPGManager;
const removeEPGSession = EPGManagerModule.removeEPGSession;
const config = require('./src/config');
const CacheManagerFactory = require('./src/cache-manager');
const { renderConfigPage, renderGatePage } = require('./views/views');
const homeAuth = require('./src/home-auth');
const PythonRunnerModule = require('./src/python-runner');
const PythonRunner = PythonRunnerModule;
const getPythonRunner = PythonRunnerModule.getPythonRunner;
const removeRunnerSession = PythonRunnerModule.removeRunnerSession;
const ResolverStreamManager = require('./src/resolver-stream-manager')();
const PythonResolverModule = require('./src/python-resolver');
const PythonResolver = PythonResolverModule;
const getPythonResolver = PythonResolverModule.getPythonResolver;
const removeResolverSession = PythonResolverModule.removeResolverSession;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const logger = require('./src/logger');
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Chiave cache derivata dalla config (stessa config = stessa cache; nessun session_id scelto dall'utente)
function getSessionKeyFromConfig(userConfig) {
    if (!userConfig || typeof userConfig !== 'object') return '_default';
    const keys = ['m3u', 'epg', 'proxy', 'id_suffix', 'remapper_path', 'update_interval', 'resolver_script', 'python_script_url'];
    const o = {};
    keys.forEach(k => { if (userConfig[k] !== undefined && userConfig[k] !== '') o[k] = String(userConfig[k]); });
    const str = JSON.stringify(o);
    return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

const SETTINGS_GENRE = '⚙️';

function getGenreOptions(cacheManager) {
    const raw = (cacheManager.getCachedData().genres || []);
    const normalized = raw.map(g => (g === '~SETTINGS~' || g === 'Settings' ? SETTINGS_GENRE : g));
    return [...new Set([...normalized, SETTINGS_GENRE])];
}

// Registry cache per sessione (chiave derivata dalla config)
const cacheRegistry = new Map();

// Ultima attività per sessione (solo non-default). Scadenza 24h.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessionLastActivity = new Map();

function touchSession(sessionKey) {
    if (sessionKey && sessionKey !== '_default') {
        sessionLastActivity.set(sessionKey, Date.now());
    }
}

async function getCacheManager(sessionId, userConfig) {
    const key = (sessionId && String(sessionId).trim()) ? String(sessionId).trim() : getSessionKeyFromConfig(userConfig);
    if (!cacheRegistry.has(key)) {
        cacheRegistry.set(key, await CacheManagerFactory(userConfig || {}, key === '_default' ? null : key));
    }
    const cm = cacheRegistry.get(key);
    cm.sessionKey = key;
    if (userConfig && Object.keys(userConfig).length) cm.updateConfig(userConfig);
    touchSession(key);
    return cm;
}

/**
 * Elimina una sessione scaduta (cache, EPG, resolver, runner) e rimuove dai registry.
 * Non usare per _default.
 */
function expireSession(sessionKey) {
    if (sessionKey === '_default') return;
    const cm = cacheRegistry.get(sessionKey);
    if (cm) {
        cm.destroy();
        cacheRegistry.delete(sessionKey);
    }
    removeEPGSession(sessionKey);
    removeResolverSession(sessionKey);
    removeRunnerSession(sessionKey);
    sessionLastActivity.delete(sessionKey);
    logger.log(sessionKey, 'Session expired and removed');
}

/** Controlla sessioni inattive da più di 24h e le rimuove. */
function cleanupExpiredSessions() {
    const now = Date.now();
    const toExpire = new Set();
    for (const [key, last] of sessionLastActivity) {
        if (now - last >= SESSION_TTL_MS) toExpire.add(key);
    }
    // Anche sessioni in cache ma senza lastActivity (es. create prima del touch)
    for (const key of cacheRegistry.keys()) {
        if (key === '_default') continue;
        const last = sessionLastActivity.get(key);
        if (last === undefined || now - last >= SESSION_TTL_MS) toExpire.add(key);
    }
    toExpire.forEach(key => {
        try {
            expireSession(key);
        } catch (e) {
            logger.error(key, 'Session expiry error:', e.message);
        }
    });
}

// API per ottenere l'ID sessione dalla config (per UI e export)
app.post('/api/session-key', (req, res) => {
    try {
        const sessionKey = getSessionKeyFromConfig(req.body || {});
        res.json({ sessionKey });
    } catch (e) {
        res.status(400).json({ error: e.message });
    }
});

// API protezione home (prima del gate per permettere chiamate senza cookie)
app.get('/api/home-auth/status', (req, res) => {
    res.json(homeAuth.getState());
});
app.post('/api/home-auth/set', (req, res) => {
    const { enabled, password, confirm } = req.body || {};
    const result = homeAuth.setProtection(!!enabled, password);
    res.json(result);
});
app.post('/api/home-auth/unlock', (req, res) => {
    const password = (req.body && req.body.password) || '';
    if (!homeAuth.verifyPassword(password)) {
        const returnUrl = (req.body && req.body.returnUrl) || '';
        const safeReturn = returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//') ? returnUrl : '';
        return res.redirect(safeReturn ? `${safeReturn}${safeReturn.includes('?') ? '&' : '?'}error=1` : '/?error=1');
    }
    const value = homeAuth.getUnlockCookieValue();
    if (value) {
        res.cookie(homeAuth.COOKIE_NAME, value, {
            maxAge: homeAuth.COOKIE_MAX_AGE_MS,
            httpOnly: true,
            path: '/',
            sameSite: 'lax'
        });
    }
    const returnUrl = (req.body && req.body.returnUrl) || '';
    const safeReturn = returnUrl && returnUrl.startsWith('/') && !returnUrl.startsWith('//') ? returnUrl : '/';
    res.redirect(safeReturn);
});

// Route principale - supporta sia il vecchio che il nuovo sistema
app.get('/', async (req, res) => {
    const state = homeAuth.getState();
    if (state.enabled && !homeAuth.verifyUnlockCookie(req.cookies[homeAuth.COOKIE_NAME])) {
        return res.send(renderGatePage(config.manifest, req.path));
    }
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const queryWithAuth = { ...req.query, homeAuthEnabled: state.enabled ? 'true' : 'false' };
    res.send(renderConfigPage(protocol, host, queryWithAuth, config.manifest));
});

// Nuova route per la configurazione codificata
app.get('/:config/configure', async (req, res) => {
    const state = homeAuth.getState();
    if (state.enabled && !homeAuth.verifyUnlockCookie(req.cookies[homeAuth.COOKIE_NAME])) {
        return res.send(renderGatePage(config.manifest, req.path));
    }
    try {
        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers['x-forwarded-host'] || req.get('host');
        const configString = Buffer.from(req.params.config, 'base64').toString();
        const decodedConfig = Object.fromEntries(new URLSearchParams(configString));

        // Initialize Python generator from config if configured
        if (decodedConfig.python_script_url) {
            const sessionKey = getSessionKeyFromConfig(decodedConfig);
            const cacheManagerForConfig = await getCacheManager(decodedConfig.session_id, decodedConfig);
            const pythonRunnerForSession = getPythonRunner(sessionKey);
            try {
                await pythonRunnerForSession.downloadScript(decodedConfig.python_script_url);
                if (decodedConfig.python_update_interval) {
                    pythonRunnerForSession.scheduleUpdate(decodedConfig.python_update_interval, cacheManagerForConfig);
                }
                logger.log(sessionKey, 'Python generator initialized from config');
            } catch (pythonError) {
                logger.error(sessionKey, 'Python generator init error:', pythonError.message);
            }
        }

        const queryWithAuth = { ...decodedConfig, homeAuthEnabled: state.enabled ? 'true' : 'false' };
        const sessionKey = getSessionKeyFromConfig(decodedConfig);
        const showSessionChangeWarning = req.query.generated === '1' || req.query.generated === 'true';
        res.send(renderConfigPage(protocol, host, queryWithAuth, config.manifest, sessionKey, showSessionChangeWarning));
    } catch (error) {
        logger.error('_', 'Configure route error:', error.message);
        res.redirect('/');
    }
});

// Route per il manifest - supporta sia il vecchio che il nuovo sistema
app.get('/manifest.json', async (req, res) => {
    try {
        const cacheManager = await getCacheManager(req.query.session_id, req.query);
        const sessionKey = cacheManager.sessionKey;
        const epgManager = await getEPGManager(sessionKey);
        const pythonResolver = getPythonResolver(sessionKey);
        const pythonRunner = getPythonRunner(sessionKey);

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers['x-forwarded-host'] || req.get('host');
        const configUrl = `${protocol}://${host}/?${new URLSearchParams(req.query)}`;
        if (req.query.resolver_update_interval) {
            configUrl += `&resolver_update_interval=${encodeURIComponent(req.query.resolver_update_interval)}`;
        }
        cacheManager.ensureCacheLoaded();
        const cacheEmpty = !cacheManager.cache?.stremioData?.channels?.length;
        if (req.query.m3u && (cacheManager.cache.m3uUrl !== req.query.m3u || cacheEmpty)) {
            await cacheManager.rebuildCache(req.query.m3u, req.query);
        } else if (cacheEmpty && !req.query.m3u) {
            logger.warn(cacheManager?.sessionKey ?? '_', 'Manifest: cache empty and no M3U URL in config — playlists will not load. Configure M3U and reinstall the addon.');
        }

        const genres = getGenreOptions(cacheManager);
        const manifestConfig = {
            ...config.manifest,
            catalogs: [{
                ...config.manifest.catalogs[0],
                extra: [
                    { name: 'genre', isRequired: false, options: genres },
                    { name: 'search', isRequired: false },
                    { name: 'skip', isRequired: false }
                ]
            }],
            behaviorHints: {
                configurable: true,
                configurationURL: configUrl,
                reloadRequired: true
            }
        };
        const builder = new addonBuilder(manifestConfig);

        if (req.query.epg_enabled === 'true') {
            const epgToUse = req.query.epg ||
                (cacheManager.getCachedData().epgUrls && cacheManager.getCachedData().epgUrls.length > 0
                    ? cacheManager.getCachedData().epgUrls.join(',') : null);
            if (epgToUse) await epgManager.initializeEPG(epgToUse);
        }

        builder.defineCatalogHandler(async (args) => catalogHandler({ ...args, config: req.query, cacheManager, epgManager, pythonResolver, pythonRunner, baseUrl: `${req.protocol}://${req.get("host")}` }));
        builder.defineStreamHandler(async (args) => streamHandler({ ...args, config: req.query, cacheManager, epgManager, pythonResolver, pythonRunner, baseUrl: `${req.protocol}://${req.get("host")}` }));
        builder.defineMetaHandler(async (args) => metaHandler({ ...args, config: req.query, cacheManager, epgManager, pythonResolver, pythonRunner, baseUrl: `${req.protocol}://${req.get('host')}` }));
        res.setHeader('Content-Type', 'application/json');
        res.send(builder.getInterface().manifest);
    } catch (error) {
        logger.error(cacheManager?.sessionKey ?? '_', 'Error creating manifest:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Nuova route per il manifest con configurazione codificata
app.get('/:config/manifest.json', async (req, res) => {
    try {
        const configString = Buffer.from(req.params.config, 'base64').toString();
        const decodedConfig = Object.fromEntries(new URLSearchParams(configString));
        const cacheManager = await getCacheManager(decodedConfig.session_id, decodedConfig);

        const protocol = req.headers['x-forwarded-proto'] || req.protocol;
        const host = req.headers['x-forwarded-host'] || req.get('host');

        cacheManager.ensureCacheLoaded();
        const cacheEmpty = !cacheManager.cache?.stremioData?.channels?.length;
        if (decodedConfig.m3u && (cacheManager.cache.m3uUrl !== decodedConfig.m3u || cacheEmpty)) {
            await cacheManager.rebuildCache(decodedConfig.m3u, decodedConfig);
        } else if (cacheEmpty && !decodedConfig.m3u) {
            logger.warn(getSessionKeyFromConfig(decodedConfig), 'Manifest: cache empty and no M3U URL in config — playlists will not load. Configure M3U and reinstall the addon.');
        }
        const sessionKey = cacheManager.sessionKey;
        const epgManager = await getEPGManager(sessionKey);
        const pythonResolver = getPythonResolver(sessionKey);
        const pythonRunner = getPythonRunner(sessionKey);

        if (decodedConfig.resolver_script) {
            try {
                await pythonResolver.downloadScript(decodedConfig.resolver_script);
                if (decodedConfig.resolver_update_interval) {
                    pythonResolver.scheduleUpdate(decodedConfig.resolver_update_interval);
                }
                logger.log(sessionKey, 'Resolver initialized from config');
            } catch (resolverError) {
                logger.error(sessionKey, 'Resolver init error:', resolverError.message);
            }
        }
        if (decodedConfig.python_script_url) {
            try {
                await pythonRunner.downloadScript(decodedConfig.python_script_url);
                if (decodedConfig.python_update_interval) {
                    pythonRunner.scheduleUpdate(decodedConfig.python_update_interval, cacheManager);
                }
                logger.log(sessionKey, 'Python generator initialized from config');
            } catch (pythonError) {
                logger.error(sessionKey, 'Python generator init error:', pythonError.message);
            }
        }

        const genres = getGenreOptions(cacheManager);
        const manifestConfig = {
            ...config.manifest,
            catalogs: [{
                ...config.manifest.catalogs[0],
                extra: [
                    {
                        name: 'genre',
                        isRequired: false,
                        options: genres
                    },
                    {
                        name: 'search',
                        isRequired: false
                    },
                    {
                        name: 'skip',
                        isRequired: false
                    }
                ]
            }],
            behaviorHints: {
                configurable: true,
                configurationURL: `${protocol}://${host}/${req.params.config}/configure`,
                reloadRequired: true
            }
        };

        const builder = new addonBuilder(manifestConfig);

        if (decodedConfig.epg_enabled === 'true') {
            const epgToUse = decodedConfig.epg ||
                (cacheManager.getCachedData().epgUrls && cacheManager.getCachedData().epgUrls.length > 0
                    ? cacheManager.getCachedData().epgUrls.join(',') : null);
            if (epgToUse) await epgManager.initializeEPG(epgToUse);
        }

        builder.defineCatalogHandler(async (args) => catalogHandler({ ...args, config: decodedConfig, cacheManager, epgManager, pythonResolver, pythonRunner, baseUrl: `${req.protocol}://${req.get("host")}` }));
        builder.defineStreamHandler(async (args) => streamHandler({ ...args, config: decodedConfig, cacheManager, epgManager, pythonResolver, pythonRunner, baseUrl: `${req.protocol}://${req.get("host")}` }));
        builder.defineMetaHandler(async (args) => metaHandler({ ...args, config: decodedConfig, cacheManager, epgManager, pythonResolver, pythonRunner, baseUrl: `${req.protocol}://${req.get('host')}` }));

        res.setHeader('Content-Type', 'application/json');
        res.send(builder.getInterface().manifest);
    } catch (error) {
        logger.error(cacheManager?.sessionKey ?? '_', 'Error creating manifest:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Route con config in path DEVONO stare prima della route generica :resource/:type/:id
// altrimenti Stremio che chiama /<base64>/catalog/... matcha la generica e usa req.query vuoto → 0 canali
app.get('/:config/catalog/:type/:id/:extra?.json', async (req, res) => {
    try {
        const configString = Buffer.from(req.params.config, 'base64').toString();
        const decodedConfig = Object.fromEntries(new URLSearchParams(configString));
        const cacheManager = await getCacheManager(decodedConfig.session_id, decodedConfig);
        const sessionKey = cacheManager.sessionKey;
        const epgManager = await getEPGManager(sessionKey);
        const pythonResolver = getPythonResolver(sessionKey);
        const pythonRunner = getPythonRunner(sessionKey);
        const extra = req.params.extra ? safeParseExtra(req.params.extra) : {};

        const result = await catalogHandler({
            type: req.params.type,
            id: req.params.id,
            extra,
            config: decodedConfig,
            cacheManager,
            epgManager,
            pythonResolver,
            pythonRunner,
            baseUrl: `${req.protocol}://${req.get('host')}`
        });

        res.setHeader('Content-Type', 'application/json');
        res.send(result);
    } catch (error) {
        logger.error(cacheManager?.sessionKey ?? '_', 'Error handling catalog request:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/:config/stream/:type/:id.json', async (req, res) => {
    try {
        const configString = Buffer.from(req.params.config, 'base64').toString();
        const decodedConfig = Object.fromEntries(new URLSearchParams(configString));
        const cacheManager = await getCacheManager(decodedConfig.session_id, decodedConfig);
        const sessionKey = cacheManager.sessionKey;
        const epgManager = await getEPGManager(sessionKey);
        const pythonResolver = getPythonResolver(sessionKey);
        const pythonRunner = getPythonRunner(sessionKey);

        const result = await streamHandler({
            type: req.params.type,
            id: req.params.id,
            config: decodedConfig,
            cacheManager,
            epgManager,
            pythonResolver,
            pythonRunner,
            baseUrl: `${req.protocol}://${req.get('host')}`
        });

        res.setHeader('Content-Type', 'application/json');
        res.send(result);
    } catch (error) {
        logger.error(cacheManager?.sessionKey ?? '_', 'Error handling stream request:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/:config/meta/:type/:id.json', async (req, res) => {
    try {
        const configString = Buffer.from(req.params.config, 'base64').toString();
        const decodedConfig = Object.fromEntries(new URLSearchParams(configString));
        const cacheManager = await getCacheManager(decodedConfig.session_id, decodedConfig);
        const sessionKey = cacheManager.sessionKey;
        const epgManager = await getEPGManager(sessionKey);
        const pythonResolver = getPythonResolver(sessionKey);
        const pythonRunner = getPythonRunner(sessionKey);

        const result = await metaHandler({
            type: req.params.type,
            id: req.params.id,
            config: decodedConfig,
            cacheManager,
            epgManager,
            pythonResolver,
            pythonRunner,
            baseUrl: `${req.protocol}://${req.get('host')}`
        });

        res.setHeader('Content-Type', 'application/json');
        res.send(result);
    } catch (error) {
        logger.error(cacheManager?.sessionKey ?? '_', 'Error handling meta request:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Route generica per catalog/stream/meta (solo URL senza config in path, es. ?m3u=...)
app.get('/:resource/:type/:id/:extra?.json', async (req, res, next) => {
    const { resource, type, id } = req.params;
    const extra = req.params.extra
        ? safeParseExtra(req.params.extra)
        : {};

    try {
        const cacheManager = await getCacheManager(req.query.session_id, req.query);
        const sessionKey = cacheManager.sessionKey;
        const epgManager = await getEPGManager(sessionKey);
        const pythonResolver = getPythonResolver(sessionKey);
        const pythonRunner = getPythonRunner(sessionKey);
        let result;
        switch (resource) {
            case 'stream':
                result = await streamHandler({ type, id, config: req.query, cacheManager, epgManager, pythonResolver, pythonRunner, baseUrl: `${req.protocol}://${req.get("host")}` });
                break;
            case 'catalog':
                result = await catalogHandler({ type, id, extra, config: req.query, cacheManager, epgManager, pythonResolver, pythonRunner, baseUrl: `${req.protocol}://${req.get("host")}` });
                break;
            case 'meta':
                result = await metaHandler({ type, id, config: req.query, cacheManager, epgManager, pythonResolver, pythonRunner, baseUrl: `${req.protocol}://${req.get('host')}` });
                break;
            default:
                next();
                return;
        }

        res.setHeader('Content-Type', 'application/json');
        res.send(result);
    } catch (error) {
        logger.error(cacheManager?.sessionKey ?? '_', 'Error handling request:', error.message);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Background image: scarica il logo, lo rimpicciolisce al 40% e lo centra
// su canvas 1280x720 con sfondo sfocato — evita l'effetto zoom di Stremio.
// Usa Jimp (puro JS, zero dipendenze native) — funziona su HF senza modifiche al Dockerfile.
// ─── Normalizza URL GitHub: converte blob?raw → raw.githubusercontent.com ────
// GitHub restituisce HTML invece del file grezzo per URL del tipo:
//   https://github.com/org/repo/blob/main/file.png?raw=true  → HTML
// La forma corretta è:
//   https://raw.githubusercontent.com/org/repo/main/file.png
function normalizeImageUrl(url) {
    try {
        const u = new URL(url);
        // github.com/*/blob/*?raw → raw.githubusercontent.com
        if (u.hostname === 'github.com') {
            const m = u.pathname.match(/^\/([^\/]+)\/([^\/]+)\/blob\/(.+)$/);
            if (m) {
                return `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`;
            }
        }
        return url;
    } catch {
        return url;
    }
}

// ─── Rilevamento "logo vuoto" ─────────────────────────────────────────────────
// Molte playlist IPTV (es. varianti tipo "Sky Sport 251/252/...254") puntano
// tutte allo stesso file logo "segnaposto": un PNG trasparente o un'immagine
// a tinta unita senza contenuto reale. Questo file supera i controlli di
// dimensione/formato (è un'immagine valida), ma visivamente è vuoto.
// Campioniamo i pixel e scartiamo l'immagine se è quasi interamente
// trasparente oppure a colore uniforme: in questi casi usiamo il
// placeholder testuale (/ph-image) invece del logo "vuoto".
function isBlankImage(image) {
    const { width, height, data } = image.bitmap;
    const totalPixels = width * height;
    if (!totalPixels) return true;

    const sampleStep = Math.max(1, Math.floor(totalPixels / 3000)); // max ~3000 campioni
    let transparentCount = 0, opaqueCount = 0;
    let sumR = 0, sumG = 0, sumB = 0, sumR2 = 0, sumG2 = 0, sumB2 = 0;

    for (let p = 0; p < totalPixels; p += sampleStep) {
        const o = p * 4;
        const a = data[o + 3];
        if (a < 10) { transparentCount++; continue; }
        const r = data[o], g = data[o + 1], b = data[o + 2];
        opaqueCount++;
        sumR += r; sumG += g; sumB += b;
        sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
    }

    const sampled = transparentCount + opaqueCount;
    if (!sampled) return true;

    // Quasi interamente trasparente → logo "vuoto"
    if (transparentCount / sampled > 0.97) return true;

    // Quasi interamente opaco e a tinta praticamente uniforme (varianza colore minima)
    // → immagine segnaposto a tinta unita, nessun contenuto visivo reale
    if (opaqueCount / sampled > 0.97) {
        const meanR = sumR / opaqueCount, meanG = sumG / opaqueCount, meanB = sumB / opaqueCount;
        const totalVar = (sumR2 / opaqueCount - meanR * meanR)
                        + (sumG2 / opaqueCount - meanG * meanG)
                        + (sumB2 / opaqueCount - meanB * meanB);
        if (totalVar < 6) return true;
    }

    return false;
}

// Cache bg-image
const bgImageCache = new Map();
const BG_IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// GET /bg-image/:encodedLogoUrl
app.get('/bg-image/:encodedUrl', async (req, res) => {
    const channelName = req.query.name || 'LIVE TV';
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Fallback interno: /ph-image SVG con nome canale (non dipende da servizi esterni)
    const fallbackUrl = `${baseUrl}/ph-image?name=${encodeURIComponent(channelName)}&w=1280&h=720`;

    try {
        const { Jimp } = require('jimp');
        const rawUrl  = decodeURIComponent(req.params.encodedUrl);
        const logoUrl = normalizeImageUrl(rawUrl); // fix GitHub blob URLs

        // Se l'URL è un SVG, fallback diretto al placeholder testo (Stremio non supporta SVG)
        if (/\.svg(\?.*)?$/i.test(logoUrl)) {
            res.setHeader('Cache-Control', 'no-store');
            return res.redirect(302, fallbackUrl);
        }

        // Cache hit
        const cached = bgImageCache.get(logoUrl);
        if (cached && (Date.now() - cached.ts) < BG_IMAGE_CACHE_TTL_MS) {
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(cached.buffer);
        }

        const CANVAS_W   = 1280;
        const CANVAS_H   = 720;
        const LOGO_MAX_W = Math.round(CANVAS_W * 0.25); // 320px — ridotto per non coprire troppo
        const LOGO_MAX_H = Math.round(CANVAS_H * 0.25); // 180px

        // Prova più strategie: prima fetch diretto, poi weserv come fallback.
        // NOTA: weserv risponde 200 con immagine nera/vuota se il logo è irraggiungibile,
        // quindi NON lo usiamo come prima strategia — altrimenti si vede lo sfondo nero.
        let logoBuffer;
        const fetchStrategies = [
            // 1. fetch diretto con User-Agent
            () => fetch(logoUrl, { headers: { 'User-Agent': config.defaultUserAgent } }),
            // 2. fetch diretto con Referer Wikipedia (sblocca alcuni asset Wikimedia)
            () => fetch(logoUrl, { headers: { 'User-Agent': config.defaultUserAgent, 'Referer': 'https://en.wikipedia.org/' } }),
            // 3. weserv con dimensioni esplicite e output PNG (gestisce SVG, redirect, Wikimedia)
            () => fetch(`https://images.weserv.nl/?url=${encodeURIComponent(logoUrl)}&w=512&h=512&fit=inside&output=png`, { headers: { 'User-Agent': config.defaultUserAgent } }),
            // 4. weserv senza parametri di resize (fallback per URL già rasterizzati)
            () => fetch(`https://images.weserv.nl/?url=${encodeURIComponent(logoUrl)}&output=png`, { headers: { 'User-Agent': config.defaultUserAgent } }),
        ];
        let lastErr;
        for (const strategy of fetchStrategies) {
            try {
                const r = await strategy();
                if (!r.ok) { lastErr = new Error(`HTTP Status ${r.status} for url ${logoUrl}`); continue; }
                const buf = Buffer.from(await r.arrayBuffer());
                // Scarta buffer troppo piccoli: weserv restituisce immagini nere/vuote
                // di pochi byte quando il logo originale è irraggiungibile
                if (buf.length < 2000) { lastErr = new Error(`Buffer too small (${buf.length} bytes), likely placeholder`); continue; }
                logoBuffer = buf;
                break;
            } catch (e) { lastErr = e; }
        }
        if (!logoBuffer) throw lastErr || new Error(`All fetch strategies failed for ${logoUrl}`);

        // Verifica che il buffer sia un'immagine riconoscibile prima di passarlo a Jimp
        const magic = logoBuffer.slice(0, 4).toString('hex');
        const magicStr = logoBuffer.slice(0, 5).toString('ascii').toLowerCase();
        const isSvg = magicStr.startsWith('<svg') || magicStr.startsWith('<?xml') || logoBuffer.toString('utf8', 0, 200).toLowerCase().includes('<svg');
        const isRaster = magic.startsWith('89504e47') || // PNG
                         magic.startsWith('ffd8ff')   || // JPEG
                         magic.startsWith('47494638') || // GIF
                         magic.startsWith('52494646');   // WEBP
        if (!isRaster && !isSvg) {
            throw new Error(`Not a valid image buffer (magic: ${magic}) for url ${logoUrl}`);
        }

        // SVG: converti via weserv (Jimp non supporta SVG nativamente)
        let logoBuffer2 = logoBuffer;
        if (isSvg) {
            try {
                const svgRes = await fetch(`https://images.weserv.nl/?url=${encodeURIComponent(logoUrl)}&w=512&h=512&fit=inside&output=png`, { headers: { 'User-Agent': config.defaultUserAgent } });
                if (svgRes.ok) logoBuffer2 = Buffer.from(await svgRes.arrayBuffer());
                else throw new Error(`weserv SVG convert failed: ${svgRes.status}`);
            } catch (svgErr) {
                throw new Error(`SVG conversion failed for ${logoUrl}: ${svgErr.message}`);
            }
        }

        const logo = await Jimp.read(logoBuffer2);

        // Verifica dimensioni reali: weserv restituisce immagini 1x1 o simili
        // quando il logo è irraggiungibile — scarta e usa fallback testo
        if (logo.bitmap.width < 10 || logo.bitmap.height < 10) {
            throw new Error(`Image too small (${logo.bitmap.width}x${logo.bitmap.height}), likely weserv placeholder`);
        }

        // Logo "vuoto" (trasparente o a tinta unita, es. molte varianti Sky Sport
        // condividono lo stesso file segnaposto) — scarta e usa fallback testo
        if (isBlankImage(logo)) {
            throw new Error(`Logo appears blank/empty for ${logoUrl}`);
        }

        // Logo ridimensionato mantenendo le proporzioni (max 25% del canvas)
        const logoResized = logo.clone().scaleToFit({ w: LOGO_MAX_W, h: LOGO_MAX_H });

        // Sfondo: logo sfocato, scurito e scalato a coprire il canvas
        const bg = logo.clone()
            .cover({ w: CANVAS_W, h: CANVAS_H })
            .blur(20)
            .brightness(-0.5);

        // Composizione: sfondo + logo centrato
        const left = Math.round((CANVAS_W - logoResized.bitmap.width)  / 2);
        const top  = Math.round((CANVAS_H - logoResized.bitmap.height) / 2);
        bg.composite(logoResized, left, top);

        const buffer = await bg.getBuffer('image/png');

        bgImageCache.set(logoUrl, { buffer, ts: Date.now() });
        if (bgImageCache.size % 100 === 0) {
            const now = Date.now();
            for (const [k, v] of bgImageCache) {
                if (now - v.ts > BG_IMAGE_CACHE_TTL_MS) bgImageCache.delete(k);
            }
        }

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buffer);
    } catch (e) {
        logger.error('_', 'bg-image error, falling back to placeholder:', e.message);
        // Redirect a /ph-image interno — no-store così il client non cacha il fallback
        res.setHeader('Cache-Control', 'no-store');
        res.redirect(302, fallbackUrl);
    }
});

// GET /logo-image?url=...&w=400&h=600
// Scarica il logo, lo ridimensiona al 60% con sfondo scuro e lo mette su canvas w×h.
// Cache in-memory 24h. Usato da buildPosterUrl per poster (2:3) e logo (3:2)
// al posto di weserv (che non è affidabile per tutti i tipi di URL).
const logoImageCache = new Map();
const LOGO_IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

app.get('/logo-image', async (req, res) => {
    const rawUrl      = req.query.url || '';
    const w           = Math.min(Math.max(parseInt(req.query.w,  10) || 400, 50), 1920);
    const h           = Math.min(Math.max(parseInt(req.query.h,  10) || 600, 50), 1080);
    const channelName = (req.query.name || 'LIVE TV').trim();
    // transparent=1 → nessun sfondo (PNG con alpha), usato per logo 3:2 (landscape)
    const transparent = req.query.transparent === '1';
    const baseUrl     = `${req.protocol}://${req.get('host')}`;
    const fallbackUrl = `${baseUrl}/ph-image?name=${encodeURIComponent(channelName)}&w=${w}&h=${h}`;

    if (!rawUrl) { res.setHeader('Cache-Control', 'no-store'); return res.redirect(302, fallbackUrl); }

    const logoUrl  = normalizeImageUrl(rawUrl);

    // Se l'URL è un SVG, fallback diretto al placeholder testo (Stremio non supporta SVG)
    if (/\.svg(\?.*)?$/i.test(logoUrl)) {
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(302, fallbackUrl);
    }

    const cacheKey = `${transparent ? 'T' : 'S'}:${w}x${h}:${logoUrl}`;

    // Cache hit
    const cached = logoImageCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < LOGO_IMAGE_CACHE_TTL_MS) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(cached.buffer);
    }

    try {
        const { Jimp } = require('jimp');

        // Scarica il logo: prima fetch diretto, poi weserv come fallback.
        // NOTA: weserv risponde 200 con immagine nera/vuota se il logo è irraggiungibile,
        // quindi NON lo usiamo come prima strategia — altrimenti si vede il poster nero.
        let logoBuffer;
        const lw = Math.round(w * 0.6), lh = Math.round(h * 0.6);
        const logoFetchStrategies = [
            // 1. fetch diretto con User-Agent
            () => fetch(logoUrl, { headers: { 'User-Agent': config.defaultUserAgent } }),
            // 2. fetch diretto con Referer Wikipedia (sblocca alcuni asset Wikimedia)
            () => fetch(logoUrl, { headers: { 'User-Agent': config.defaultUserAgent, 'Referer': 'https://en.wikipedia.org/' } }),
            // 3. weserv con dimensioni esplicite (gestisce SVG, redirect)
            () => fetch(`https://images.weserv.nl/?url=${encodeURIComponent(logoUrl)}&w=${lw}&h=${lh}&fit=contain&output=png`, { headers: { 'User-Agent': config.defaultUserAgent } }),
            // 4. weserv senza parametri di resize
            () => fetch(`https://images.weserv.nl/?url=${encodeURIComponent(logoUrl)}&output=png`, { headers: { 'User-Agent': config.defaultUserAgent } }),
        ];
        let lastLogoErr;
        for (const strategy of logoFetchStrategies) {
            try {
                const r = await strategy();
                if (!r.ok) { lastLogoErr = new Error(`HTTP ${r.status} for ${logoUrl}`); continue; }
                const buf = Buffer.from(await r.arrayBuffer());
                // Scarta buffer troppo piccoli: weserv restituisce immagini nere/placeholder
                // di pochi byte quando il logo originale è irraggiungibile
                if (buf.length < 2000) { lastLogoErr = new Error(`Buffer too small (${buf.length} bytes), likely placeholder`); continue; }
                logoBuffer = buf;
                break;
            } catch (e) { lastLogoErr = e; }
        }
        if (!logoBuffer) throw lastLogoErr || new Error(`All fetch strategies failed for ${logoUrl}`);

        // Verifica magic bytes — evita HTML camuffato da immagine
        const magic = logoBuffer.slice(0, 4).toString('hex');
        const magicStr = logoBuffer.slice(0, 5).toString('ascii').toLowerCase();
        const isSvg = magicStr.startsWith('<svg') || magicStr.startsWith('<?xml') || logoBuffer.toString('utf8', 0, 200).toLowerCase().includes('<svg');
        const isRaster = magic.startsWith('89504e47') || // PNG
                         magic.startsWith('ffd8ff')   || // JPEG
                         magic.startsWith('47494638') || // GIF
                         magic.startsWith('52494646');   // WEBP
        if (!isRaster && !isSvg) throw new Error(`Not a valid image (magic: ${magic})`);

        // SVG: converti via weserv (Jimp non supporta SVG nativamente)
        let logoBuffer2 = logoBuffer;
        if (isSvg) {
            try {
                const svgRes = await fetch(`https://images.weserv.nl/?url=${encodeURIComponent(logoUrl)}&w=${Math.round(w * 0.6)}&h=${Math.round(h * 0.6)}&fit=inside&output=png`, { headers: { 'User-Agent': config.defaultUserAgent } });
                if (svgRes.ok) logoBuffer2 = Buffer.from(await svgRes.arrayBuffer());
                else throw new Error(`weserv SVG convert failed: ${svgRes.status}`);
            } catch (svgErr) {
                throw new Error(`SVG conversion failed for ${logoUrl}: ${svgErr.message}`);
            }
        }

        const logo = await Jimp.read(logoBuffer2);

        // Verifica dimensioni reali: weserv restituisce immagini 1x1 o simili
        // quando il logo è irraggiungibile — scarta e usa fallback testo
        if (logo.bitmap.width < 10 || logo.bitmap.height < 10) {
            throw new Error(`Image too small (${logo.bitmap.width}x${logo.bitmap.height}), likely weserv placeholder`);
        }

        // Logo "vuoto" (trasparente o a tinta unita, es. molte varianti Sky Sport
        // condividono lo stesso file segnaposto) — scarta e usa fallback testo
        if (isBlankImage(logo)) {
            throw new Error(`Logo appears blank/empty for ${logoUrl}`);
        }

        // Logo ridotto al 60% del canvas mantenendo le proporzioni
        const maxLogoW = Math.round(w * 0.60);
        const maxLogoH = Math.round(h * 0.60);
        const logoResized = logo.scaleToFit({ w: maxLogoW, h: maxLogoH });

        let outputBuffer;
        if (transparent) {
            // Nessun sfondo: canvas completamente trasparente, solo il logo centrato
            const canvas = new Jimp({ width: w, height: h, color: 0x00000000 });
            const left = Math.round((w - logoResized.bitmap.width)  / 2);
            const top  = Math.round((h - logoResized.bitmap.height) / 2);
            canvas.composite(logoResized, left, top);
            outputBuffer = await canvas.getBuffer('image/png');
        } else {
            // Sfondo scuro #1a1a2e, logo centrato
            const canvas = new Jimp({ width: w, height: h, color: 0x1a1a2eff });
            const left = Math.round((w - logoResized.bitmap.width)  / 2);
            const top  = Math.round((h - logoResized.bitmap.height) / 2);
            canvas.composite(logoResized, left, top);
            outputBuffer = await canvas.getBuffer('image/png');
        }

        logoImageCache.set(cacheKey, { buffer: outputBuffer, ts: Date.now() });
        if (logoImageCache.size % 200 === 0) {
            const now = Date.now();
            for (const [k, v] of logoImageCache) {
                if (now - v.ts > LOGO_IMAGE_CACHE_TTL_MS) logoImageCache.delete(k);
            }
        }

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(outputBuffer);
    } catch (e) {
        logger.error('_', `logo-image error for ${logoUrl}, falling back to placeholder:`, e.message);
        if (!res.headersSent) { res.setHeader('Cache-Control', 'no-store'); res.redirect(302, fallbackUrl); }
    }
});

// GET /ph-image?name=NOME&w=400&h=600
// Genera un PNG con sfondo #1a1a2e e testo arancione #cc5500 via Jimp.
// Font bitmap 5x7 codificata inline — nessuna dipendenza extra, funziona con Stremio.
const phImageCache = new Map();
const PH_IMAGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Font bitmap 5x7: ogni carattere = array di 7 righe, ogni riga = 5 bit (MSB a sinistra)
const FONT5X7 = {
  ' ':  [0b00000,0b00000,0b00000,0b00000,0b00000,0b00000,0b00000],
  'A':  [0b01110,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
  'B':  [0b11110,0b10001,0b10001,0b11110,0b10001,0b10001,0b11110],
  'C':  [0b01110,0b10001,0b10000,0b10000,0b10000,0b10001,0b01110],
  'D':  [0b11110,0b10001,0b10001,0b10001,0b10001,0b10001,0b11110],
  'E':  [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b11111],
  'F':  [0b11111,0b10000,0b10000,0b11110,0b10000,0b10000,0b10000],
  'G':  [0b01110,0b10001,0b10000,0b10111,0b10001,0b10001,0b01111],
  'H':  [0b10001,0b10001,0b10001,0b11111,0b10001,0b10001,0b10001],
  'I':  [0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b11111],
  'J':  [0b11111,0b00010,0b00010,0b00010,0b00010,0b10010,0b01100],
  'K':  [0b10001,0b10010,0b10100,0b11000,0b10100,0b10010,0b10001],
  'L':  [0b10000,0b10000,0b10000,0b10000,0b10000,0b10000,0b11111],
  'M':  [0b10001,0b11011,0b10101,0b10101,0b10001,0b10001,0b10001],
  'N':  [0b10001,0b11001,0b10101,0b10011,0b10001,0b10001,0b10001],
  'O':  [0b01110,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
  'P':  [0b11110,0b10001,0b10001,0b11110,0b10000,0b10000,0b10000],
  'Q':  [0b01110,0b10001,0b10001,0b10001,0b10101,0b10010,0b01101],
  'R':  [0b11110,0b10001,0b10001,0b11110,0b10100,0b10010,0b10001],
  'S':  [0b01111,0b10000,0b10000,0b01110,0b00001,0b00001,0b11110],
  'T':  [0b11111,0b00100,0b00100,0b00100,0b00100,0b00100,0b00100],
  'U':  [0b10001,0b10001,0b10001,0b10001,0b10001,0b10001,0b01110],
  'V':  [0b10001,0b10001,0b10001,0b10001,0b01010,0b01010,0b00100],
  'W':  [0b10001,0b10001,0b10001,0b10101,0b10101,0b11011,0b10001],
  'X':  [0b10001,0b10001,0b01010,0b00100,0b01010,0b10001,0b10001],
  'Y':  [0b10001,0b10001,0b01010,0b00100,0b00100,0b00100,0b00100],
  'Z':  [0b11111,0b00001,0b00010,0b00100,0b01000,0b10000,0b11111],
  '0':  [0b01110,0b10001,0b10011,0b10101,0b11001,0b10001,0b01110],
  '1':  [0b00100,0b01100,0b00100,0b00100,0b00100,0b00100,0b11111],
  '2':  [0b01110,0b10001,0b00001,0b00110,0b01000,0b10000,0b11111],
  '3':  [0b11111,0b00001,0b00010,0b00110,0b00001,0b10001,0b01110],
  '4':  [0b00010,0b00110,0b01010,0b10010,0b11111,0b00010,0b00010],
  '5':  [0b11111,0b10000,0b11110,0b00001,0b00001,0b10001,0b01110],
  '6':  [0b00110,0b01000,0b10000,0b11110,0b10001,0b10001,0b01110],
  '7':  [0b11111,0b00001,0b00010,0b00100,0b01000,0b01000,0b01000],
  '8':  [0b01110,0b10001,0b10001,0b01110,0b10001,0b10001,0b01110],
  '9':  [0b01110,0b10001,0b10001,0b01111,0b00001,0b00010,0b01100],
  '-':  [0b00000,0b00000,0b00000,0b11111,0b00000,0b00000,0b00000],
  '.':  [0b00000,0b00000,0b00000,0b00000,0b00000,0b00110,0b00110],
  ':':  [0b00000,0b00110,0b00110,0b00000,0b00110,0b00110,0b00000],
  '[':  [0b01110,0b01000,0b01000,0b01000,0b01000,0b01000,0b01110],
  ']':  [0b01110,0b00010,0b00010,0b00010,0b00010,0b00010,0b01110],
};

function drawText5x7(img, text, startX, startY, scale, r, g, b) {
    const { rgbaToInt } = require('jimp');
    const charW = 5 * scale, charH = 7 * scale, gap = scale;
    let x = startX;
    for (const ch of text.toUpperCase()) {
        const glyph = FONT5X7[ch] || FONT5X7[' '];
        for (let row = 0; row < 7; row++) {
            for (let col = 0; col < 5; col++) {
                if (glyph[row] & (1 << (4 - col))) {
                    for (let sy = 0; sy < scale; sy++)
                        for (let sx = 0; sx < scale; sx++)
                            img.setPixelColor(
                                rgbaToInt(r, g, b, 255),
                                x + col * scale + sx,
                                startY + row * scale + sy
                            );
                }
            }
        }
        x += charW + gap;
    }
}

app.get('/ph-image', async (req, res) => {
    const name  = (req.query.name  || 'LIVE TV').trim();
    const w     = Math.min(Math.max(parseInt(req.query.w, 10) || 400, 100), 1920);
    const h     = Math.min(Math.max(parseInt(req.query.h, 10) || 600, 100), 1080);
    const cacheKey = `${w}x${h}:${name}`;

    const cached = phImageCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < PH_IMAGE_CACHE_TTL_MS) {
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        return res.send(cached.buffer);
    }

    try {
        const { Jimp, rgbaToInt } = require('jimp');

        // Calcola scala font in base alle dimensioni canvas
        // (denominatore maggiore = testo più piccolo: prima il segnaposto
        // riempiva quasi tutto il canvas, ora occupa una porzione più
        // contenuta, simile alla dimensione di un logo reale)
        const minDim = Math.min(w, h);
        let scale = Math.max(1, Math.floor(minDim / 130));

        // Word-wrap: spezza il nome in righe che stanno nel canvas
        const charW = (5 + 1) * scale;
        const maxChars = Math.floor((w * 0.55) / charW);
        const words = name.toUpperCase().split(' ');
        const lines = [];
        let cur = '';
        for (const word of words) {
            const test = cur ? `${cur} ${word}` : word;
            if (test.length > maxChars && cur) { lines.push(cur); cur = word; }
            else cur = test;
        }
        if (cur) lines.push(cur);

        // Ri-aggiusta scala se troppo alto
        const charH = (7 + 2) * scale;
        const totalTextH = lines.length * charH;
        if (totalTextH > h * 0.45 && scale > 1) scale = Math.max(1, scale - 1);

        // Disegna
        const canvas = new Jimp({ width: w, height: h, color: 0x1a1a2eff }); // #1a1a2e
        const lineH = (7 + 2) * scale;
        const totalH = lines.length * lineH;
        let y = Math.round((h - totalH) / 2);
        for (const line of lines) {
            const lineW = line.length * ((5 + 1) * scale);
            const x = Math.round((w - lineW) / 2);
            drawText5x7(canvas, line, x, y, scale, 0xcc, 0x55, 0x00); // #cc5500
            y += lineH;
        }

        const buffer = await canvas.getBuffer('image/png');
        phImageCache.set(cacheKey, { buffer, ts: Date.now() });

        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        res.send(buffer);
    } catch (e) {
        logger.error('_', 'ph-image error:', e.message);
        // Fallback: sfondo scuro senza testo
        try {
            const { Jimp } = require('jimp');
            const buf = await new Jimp({ width: w, height: h, color: 0x1a1a2eff }).getBuffer('image/png');
            res.setHeader('Content-Type', 'image/png');
            res.setHeader('Cache-Control', 'no-store');
            res.send(buf);
        } catch(e2) { res.status(500).send('error'); }
    }
});

// GET /clear-logo-cache — svuota la cache in-memory di logo-image e bg-image
// Utile dopo aver aggiornato i loghi o dopo fix: il client riceverà immagini fresche
app.get('/clear-logo-cache', (req, res) => {
    const lg = logoImageCache.size;
    const bg = bgImageCache.size;
    const ph = phImageCache.size;
    logoImageCache.clear();
    bgImageCache.clear();
    phImageCache.clear();
    logger.log('_', `Logo cache cleared: logo=${lg}, bg=${bg}, ph=${ph}`);
    res.json({ success: true, cleared: { logoImage: lg, bgImage: bg, phImage: ph } });
});

//route download template
app.get('/api/resolver/download-template', (req, res) => {
    const PythonResolver = require('./src/python-resolver');
    const fs = require('fs');

    try {
        if (fs.existsSync(PythonResolver.scriptPath)) {
            res.setHeader('Content-Type', 'text/plain');
            res.setHeader('Content-Disposition', 'attachment; filename="resolver_script.py"');
            res.sendFile(PythonResolver.scriptPath);
        } else {
            res.status(404).json({ success: false, message: 'Template not found. Create it first with "Create Template".' });
        }
    } catch (error) {
        logger.error('_', 'Template download error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

function cleanupTempFolder() {
    const tempDir = path.join(__dirname, 'temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
        return;
    }
    try {
        const files = fs.readdirSync(tempDir);
        let deletedCount = 0;
        for (const file of files) {
            try {
                const filePath = path.join(tempDir, file);
                if (fs.statSync(filePath).isFile()) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                }
            } catch (fileError) {
                logger.error('_', 'Temp file delete error:', file, fileError.message);
            }
        }
        if (deletedCount > 0) {
            logger.log('_', 'Temp folder cleanup: removed', deletedCount, 'file(s)');
        }
    } catch (error) {
        logger.error('_', 'Temp folder cleanup error:', error.message);
    }
}

function safeParseExtra(extraParam) {
    try {
        if (!extraParam) return {};

        const decodedExtra = decodeURIComponent(extraParam);

        // Supporto per skip con genere
        if (decodedExtra.includes('genre=') && decodedExtra.includes('&skip=')) {
            const parts = decodedExtra.split('&');
            const genre = parts.find(p => p.startsWith('genre=')).split('=')[1];
            const skip = parts.find(p => p.startsWith('skip=')).split('=')[1];

            return {
                genre,
                skip: parseInt(skip, 10) || 0
            };
        }

        if (decodedExtra.startsWith('skip=')) {
            return { skip: parseInt(decodedExtra.split('=')[1], 10) || 0 };
        }

        if (decodedExtra.startsWith('genre=')) {
            return { genre: decodedExtra.split('=')[1] };
        }

        if (decodedExtra.startsWith('search=')) {
            return { search: decodedExtra.split('=')[1] };
        }

        try {
            return JSON.parse(decodedExtra);
        } catch {
            return {};
        }
    } catch (error) {
        logger.error('_', 'Error parsing extra:', error.message);
        return {};
    }
}

// Route per servire il file M3U generato (opzionale session_key in query per sessione)
app.get('/generated-m3u', (req, res) => {
    const sessionKey = req.query.session_key || '_default';
    touchSession(sessionKey);
    const runner = getPythonRunner(sessionKey);
    const m3uContent = runner.getM3UContent();
    if (m3uContent) {
        res.setHeader('Content-Type', 'text/plain');
        res.send(m3uContent);
    } else {
        res.status(404).send('M3U file not found. Run the Python script first.');
    }
});

app.post('/api/resolver', async (req, res) => {
    const { action, url, interval } = req.body;
    const sessionKey = getSessionKeyFromConfig(req.body);
    touchSession(sessionKey);
    const resolver = getPythonResolver(sessionKey);

    try {
        if (action === 'download' && url) {
            const success = await resolver.downloadScript(url);
            if (success) {
                res.json({ success: true, message: 'Resolver script downloaded successfully' });
            } else {
                res.status(500).json({ success: false, message: resolver.getStatus().lastError });
            }
        } else if (action === 'create-template') {
            const success = await resolver.createScriptTemplate();
            if (success) {
                res.json({
                    success: true,
                    message: 'Resolver script template created successfully',
                    scriptPath: resolver.scriptPath
                });
            } else {
                res.status(500).json({ success: false, message: resolver.getStatus().lastError });
            }
        } else if (action === 'check-health') {
            const isHealthy = await resolver.checkScriptHealth();
            res.json({
                success: isHealthy,
                message: isHealthy ? 'Resolver script valid' : resolver.getStatus().lastError
            });
        } else if (action === 'status') {
            res.json(resolver.getStatus());
        } else if (action === 'clear-cache') {
            resolver.clearCache();
            res.json({ success: true, message: 'Resolver cache cleared' });
        } else if (action === 'schedule' && interval) {
            const success = resolver.scheduleUpdate(interval);
            if (success) {
                res.json({
                    success: true,
                    message: `Auto-update set every ${interval}`
                });
            } else {
                res.status(500).json({ success: false, message: resolver.getStatus().lastError });
            }
        } else if (action === 'stopSchedule') {
            const stopped = resolver.stopScheduledUpdates();
            res.json({
                success: true,
                message: stopped ? 'Auto-update stopped' : 'No scheduled update to stop'
            });
        } else {
            res.status(400).json({ success: false, message: 'Azione non valida' });
        }
    } catch (error) {
        logger.error(sessionKey, 'Resolver API error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/rebuild-cache', async (req, res) => {
    try {
        const m3uUrl = req.body.m3u;
        if (!m3uUrl) {
            return res.status(400).json({ success: false, message: 'M3U URL required' });
        }

        const cacheManager = await getCacheManager(req.body.session_id, req.body);
        logger.log(cacheManager.sessionKey, 'Rebuild cache requested');
        await cacheManager.rebuildCache(req.body.m3u, req.body);

        if (req.body.epg_enabled === 'true') {
            const epgManager = await getEPGManager(cacheManager.sessionKey);
            const epgToUse = req.body.epg ||
                (cacheManager.getCachedData().epgUrls && cacheManager.getCachedData().epgUrls.length > 0
                    ? cacheManager.getCachedData().epgUrls.join(',')
                    : null);
            if (epgToUse) {
                await epgManager.initializeEPG(epgToUse);
            }
        }

        res.json({ success: true, message: 'Cache and EPG rebuilt successfully' });

    } catch (error) {
        logger.error(cacheManager?.sessionKey ?? '_', 'Rebuild cache error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Endpoint API per le operazioni sullo script Python (sessione da body)
app.post('/api/python-script', async (req, res) => {
    const { action, url, interval } = req.body;
    const sessionKey = getSessionKeyFromConfig(req.body);
    touchSession(sessionKey);
    const runner = getPythonRunner(sessionKey);
    const cacheManager = await getCacheManager(req.body?.session_id, req.body || {});

    try {
        if (action === 'download' && url) {
            const success = await runner.downloadScript(url);
            if (success) {
                res.json({ success: true, message: 'Script downloaded successfully' });
            } else {
                res.status(500).json({ success: false, message: runner.getStatus().lastError });
            }
        } else if (action === 'execute') {
            const success = await runner.executeScript();
            if (success) {
                const m3uUrl = `${req.protocol}://${req.get('host')}/generated-m3u` + (sessionKey !== '_default' ? `?session_key=${encodeURIComponent(sessionKey)}` : '');
                res.json({
                    success: true,
                    message: 'Script executed successfully',
                    m3uUrl
                });
            } else {
                res.status(500).json({ success: false, message: runner.getStatus().lastError });
            }
        } else if (action === 'status') {
            const status = runner.getStatus();
            if (status.m3uExists) {
                status.m3uUrl = `${req.protocol}://${req.get('host')}/generated-m3u` + (sessionKey !== '_default' ? `?session_key=${encodeURIComponent(sessionKey)}` : '');
            }
            res.json(status);
        } else if (action === 'schedule' && interval) {
            const success = runner.scheduleUpdate(interval, cacheManager);
            if (success) {
                res.json({
                    success: true,
                    message: `Auto-update set every ${interval}`
                });
            } else {
                res.status(500).json({ success: false, message: runner.getStatus().lastError });
            }
        } else if (action === 'stopSchedule') {
            const stopped = runner.stopScheduledUpdates();
            res.json({
                success: true,
                message: stopped ? 'Auto-update stopped' : 'No scheduled update to stop'
            });
        } else {
            res.status(400).json({ success: false, message: 'Azione non valida' });
        }
    } catch (error) {
        logger.error(sessionKey, 'Python script API error:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});
async function startAddon() {
    cleanupTempFolder();

    // Inizializza CacheManager di default (per compatibilità e python-runner)
    global.CacheManager = await getCacheManager(null, config);

    // Timer scadenza sessioni: ogni 15 minuti controlla e rimuove sessioni inattive da 24h
    setInterval(cleanupExpiredSessions, 15 * 60 * 1000);
    logger.log('_', 'Session expiry timer active (24h inactivity, check every 15 min)');

    try {
        const port = process.env.PORT || 10000;
        app.listen(port, () => {
            logger.log('_', 'OMG addon started. Config page: http://localhost:' + port);
        });
    } catch (error) {
        logger.error('_', 'Failed to start addon:', error.message);
        process.exit(1);
    }
}

startAddon();
