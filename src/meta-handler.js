const config = require('./config');
const logger = require('./logger');
const { I18N } = require('../views/views-i18n');
const { isLogoReachable } = require('./logo-checker');

// ─── Costanti placehold.co (canali senza logo) ───────────────────────────────
const PH_BG   = '1a1a2e'; // sfondo blu scuro
const PH_FG   = 'cc5500'; // testo arancione scuro
const PH_FONT = 'montserrat';

// ─── Helpers immagini ────────────────────────────────────────────────────────

/**
 * Costruisce un URL weserv con fit=contain e sfondo trasparente (nessun blur).
 * shape: 'poster' (2:3) | 'landscape' (3:2) | 'square' (1:1)
 * Per poster e landscape: contain puro senza bg=blur → logo visibile intero, sfondo trasparente.
 * Per 'background' usa l'endpoint interno /bg-image che rimpicciolisce
 * il logo al 40% su canvas 1280x720 con sfondo sfocato (come tvvoo).
 */
function buildPosterUrl(imageUrl, shape = 'poster', baseUrl = null, channelName = '') {
    if (!imageUrl) return null;
    const base = 'https://images.weserv.nl/?url=' + encodeURIComponent(imageUrl);
    if (shape === 'landscape') {
        // 3:2 — logo al 60% (360x240) centrato su canvas 600x400 con sfondo scuro: margini visibili
        const fb = encodeURIComponent(buildPlaceholderUrl(channelName, 600, 400, baseUrl));
        return `${base}&w=360&h=240&fit=contain&cbg=1a1a2e&canvas=600,400&default=${fb}`;
    }
    if (shape === 'square') {
        const fb = encodeURIComponent(buildPlaceholderUrl(channelName, 400, 400, baseUrl));
        return `${base}&w=240&h=240&fit=contain&cbg=1a1a2e&canvas=400,400&default=${fb}`;
    }
    if (shape === 'background') {
        // Usa endpoint interno se disponibile (logo rimpicciolito centrato);
        // passiamo il nome canale così l'endpoint può generare un fallback
        // col nome se il link del logo è rotto/irraggiungibile.
        if (baseUrl) return `${baseUrl}/bg-image/${encodeURIComponent(imageUrl)}?name=${encodeURIComponent(channelName || '')}`;
        // Fallback weserv se baseUrl non disponibile
        const fb = encodeURIComponent(buildPlaceholderUrl(channelName, 1280, 720, baseUrl));
        return `${base}&w=1280&h=720&fit=contain&bg=blur&default=${fb}`;
    }
    // default: poster 2:3 — logo al 60% (240x360) centrato su canvas 400x600 con sfondo scuro: margini visibili
    const fb = encodeURIComponent(buildPlaceholderUrl(channelName, 400, 600, baseUrl));
    return `${base}&w=240&h=360&fit=contain&cbg=1a1a2e&canvas=400,600&default=${fb}`;
}

/**
 * Costruisce un URL placeholder per canali senza logo.
 * Se baseUrl è disponibile usa l'endpoint interno /ph-image (SVG con word-wrap,
 * font size grande calibrato sulla dimensione) — testo sempre leggibile su TV.
 * Fallback a placehold.co se baseUrl è assente.
 */
function buildPlaceholderUrl(channelName, w, h, baseUrl = null) {
    const label = (channelName || 'LIVE TV').substring(0, 40).trim();
    if (baseUrl) {
        return `${baseUrl}/ph-image?name=${encodeURIComponent(label)}&w=${w}&h=${h}`;
    }
    // Fallback esterno: fontSize proporzionale alla larghezza, min 60
    const fontSize = Math.min(120, Math.max(60, Math.round(w * 0.12)));
    const text = encodeURIComponent(label);
    return `https://placehold.co/${w}x${h}/${PH_BG}/${PH_FG}.png?font=${PH_FONT}&text=${text}&fontSize=${fontSize}`;
}

// ─── i18n ────────────────────────────────────────────────────────────────────

function getLangCode(userConfig) {
    const lang = (userConfig.language || config.defaultLanguage || '').toString().toLowerCase();
    if (lang.startsWith('it')) return 'it';
    if (lang.startsWith('es')) return 'es';
    if (lang.startsWith('fr')) return 'fr';
    return 'en';
}

function t(key, userConfig) {
    const code = getLangCode(userConfig);
    return (I18N[code] && I18N[code][key]) || I18N.en[key] || key;
}

function normalizeId(id) {
    const beforeAt = (typeof id === 'string' && id.includes('@')) ? id.split('@')[0] : id;
    return beforeAt?.toLowerCase().replace(/[^\w.]/g, '').trim() || '';
}

// ─── EPG enrichment ──────────────────────────────────────────────────────────

function enrichWithDetailedEPG(meta, channelId, userConfig, epgManager) {
    const epg = epgManager || require('./epg-manager');
    if (userConfig.epg_enabled !== 'true' || !channelId) return meta;

    const currentProgram   = epg.getCurrentProgram(channelId);
    const upcomingPrograms = epg.getUpcomingPrograms(channelId);

    if (currentProgram) {
        let description = [];
        description.push(t('epg_on_air', userConfig), currentProgram.title);
        if (currentProgram.description) description.push('', currentProgram.description);
        description.push('', `${t('epg_time_slot_icon', userConfig)} ${currentProgram.start} - ${currentProgram.stop}`);
        if (currentProgram.category) description.push(`🏷️ ${currentProgram.category}`);

        if (upcomingPrograms?.length > 0) {
            description.push('', t('epg_upcoming', userConfig));
            upcomingPrograms.forEach(program => {
                description.push('', `• ${program.start} - ${program.title}`);
                if (program.description) description.push(`  ${program.description}`);
                if (program.category)    description.push(`  🏷️ ${program.category}`);
            });
        }

        meta.description = description.join('\n');
        meta.releaseInfo = `${currentProgram.title} (${currentProgram.start})`;
    }

    return meta;
}

// ─── Pseudo-canali (Settings) ────────────────────────────────────────────────

const PSEUDO_CHANNEL_IDS = ['rigeneraplaylistpython', 'refreshm3u', 'refreshepg'];
const PSEUDO_META = {
    refreshm3u:             { name: 'refresh_m3u_name',       description: 'desc_refresh_m3u' },
    refreshepg:             { name: 'refresh_epg_name',       description: 'desc_refresh_epg' },
    rigeneraplaylistpython: { name: 'regenerate_python_name', description: 'desc_regenerate_python' }
};
const SETTINGS_LOGO = 'https://raw.githubusercontent.com/mccoy88f/OMG-TV-Stremio-Addon/refs/heads/main/tv.png';

// ─── Handler principale ──────────────────────────────────────────────────────

async function metaHandler({ type, id, config: userConfig, cacheManager: cm, epgManager: em, baseUrl }) {
    const cacheManager = cm || global.CacheManager;
    const epgManager   = em || require('./epg-manager');
    try {
        const channelId = (typeof id === 'string' && id.includes('|')) ? id.split('|')[1] : (id || '');

        // Pseudo-canali (Settings, Refresh, ecc.)
        if (PSEUDO_CHANNEL_IDS.includes(channelId)) {
            const info   = PSEUDO_META[channelId] || { name: channelId, description: '' };
            const fullId = id && id.includes('|') ? id : `tv|${channelId}`;
            return {
                meta: {
                    id:          fullId,
                    type:        'tv',
                    name:        t(info.name, userConfig),
                    poster:      buildPosterUrl(SETTINGS_LOGO, 'poster'),
                    background:  buildPosterUrl(SETTINGS_LOGO, 'background', baseUrl),
                    logo:        buildPosterUrl(SETTINGS_LOGO, 'landscape'),
                    description: t(info.description, userConfig),
                    releaseInfo: 'LIVE',
                    posterShape: 'poster',
                    behaviorHints: { isLive: true, defaultVideoId: fullId }
                }
            };
        }

        if (!userConfig.m3u) {
            logger.log(cacheManager?.sessionKey ?? '_', 'M3U URL missing');
            return { meta: null };
        }

        cacheManager.ensureCacheLoaded();
        if (cacheManager.cache.m3uUrl !== userConfig.m3u) {
            logger.log(cacheManager?.sessionKey ?? '_', 'M3U cache outdated, rebuilding...');
            await cacheManager.rebuildCache(userConfig.m3u, userConfig);
        }

        const channel = cacheManager.getChannel(channelId);
        if (!channel) return { meta: null };

        const channelDisplayName = channel.name || 'LIVE TV';

        // Verifica se il link del logo funziona davvero (molti M3U hanno tvg-logo rotti).
        // Se non raggiungibile, lo trattiamo come canale senza logo e usiamo subito
        // il nostro placeholder col nome (niente affidamento sul fallback di weserv).
        const rawLogoUrl = channel.logo || channel.poster || channel.background;
        const logoOk     = rawLogoUrl ? await isLogoReachable(rawLogoUrl) : false;

        const effectivePoster     = logoOk ? (channel.poster || channel.logo) : null;
        const effectiveBackground = logoOk ? (channel.background || channel.logo) : null;
        const effectiveLogo       = logoOk ? channel.logo : null;

        // Placeholder interno /ph-image — sempre pre-calcolati come fallback finale
        const phPoster     = buildPlaceholderUrl(channelDisplayName, 400, 600, baseUrl);
        const phLandscape  = buildPlaceholderUrl(channelDisplayName, 600, 400, baseUrl);
        const phBackground = buildPlaceholderUrl(channelDisplayName, 1280, 720, baseUrl);

        const meta = {
            id:   channel.id,
            type: 'tv',
            name: channel.streamInfo?.tvg?.chno
                ? `${channel.streamInfo.tvg.chno}. ${channel.name}`
                : channel.name,
            // poster  → 2:3, weserv contain, sfondo trasparente
            poster:      buildPosterUrl(effectivePoster, 'poster', baseUrl, channelDisplayName)           || phPoster,
            // background → endpoint /bg-image: logo 40% centrato su canvas 1280x720 con sfondo sfocato
            background:  buildPosterUrl(effectiveBackground, 'background', baseUrl, channelDisplayName) || phBackground,
            // logo → 3:2, weserv contain, sfondo trasparente (come il poster 2:3)
            logo:        buildPosterUrl(effectiveLogo, 'landscape', baseUrl, channelDisplayName)                          || phLandscape,
            description: '',
            releaseInfo: 'LIVE',
            genre:       channel.genre,
            posterShape: 'poster',
            language:    'ita',
            country:     'ITA',
            isFree:      true,
            behaviorHints: { isLive: true, defaultVideoId: channel.id }
        };

        // Fallback EPG: se manca qualcosa, prova con l'icona EPG (solo se raggiungibile)
        if ((!meta.poster || !meta.background || !meta.logo) && channel.streamInfo?.tvg?.id) {
            const epgIcon   = epgManager.getChannelIcon(normalizeId(channel.streamInfo.tvg.id));
            const epgIconOk = epgIcon ? await isLogoReachable(epgIcon) : false;
            if (epgIcon && epgIconOk) {
                meta.poster     = meta.poster     || buildPosterUrl(epgIcon, 'poster', baseUrl, channelDisplayName);
                meta.background = meta.background || buildPosterUrl(epgIcon, 'background', baseUrl, channelDisplayName);
                meta.logo       = meta.logo       || buildPosterUrl(epgIcon, 'landscape', baseUrl, channelDisplayName);
            }
        }

        // Ultimo fallback: placeholder placehold.co con nome canale
        meta.poster     = meta.poster     || phPoster;
        meta.background = meta.background || phBackground;
        meta.logo       = meta.logo       || phLandscape;

        // Descrizione base
        let baseDescription = [];
        if (channel.streamInfo?.tvg?.chno) baseDescription.push(`📺 Channel ${channel.streamInfo.tvg.chno}`);
        baseDescription.push('', channel.description || `Channel ID: ${channel.streamInfo?.tvg?.id}`);
        meta.description = baseDescription.join('\n');

        const enrichedMeta = enrichWithDetailedEPG(meta, channel.streamInfo?.tvg?.id, userConfig, epgManager);
        logger.log(cacheManager?.sessionKey ?? '_', 'Meta handler completed');
        return { meta: enrichedMeta };

    } catch (error) {
        logger.error(cacheManager?.sessionKey ?? '_', 'MetaHandler error:', error.message);
        return { meta: null };
    }
}

module.exports = metaHandler;
