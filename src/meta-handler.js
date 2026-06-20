const config = require('./config');
const logger = require('./logger');
const { I18N } = require('../views/views-i18n');

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

function enrichWithDetailedEPG(meta, channelId, userConfig, epgManager) {
    const epg = epgManager || require('./epg-manager');
    if (userConfig.epg_enabled !== 'true' || !channelId) {
        return meta;
    }
    // Passa channelId così getLookupIds in epg-manager può provare sia "canale5.it" sia "canale5"
    const currentProgram = epg.getCurrentProgram(channelId);
    const upcomingPrograms = epg.getUpcomingPrograms(channelId);

    if (currentProgram) {
        let description = [];

        description.push(t('epg_on_air', userConfig), currentProgram.title);

        if (currentProgram.description) {
            description.push('', currentProgram.description);
        }

        description.push('', `${t('epg_time_slot_icon', userConfig)} ${currentProgram.start} - ${currentProgram.stop}`);

        if (currentProgram.category) {
            description.push(`🏷️ ${currentProgram.category}`);
        }

        if (upcomingPrograms?.length > 0) {
            description.push('', t('epg_upcoming', userConfig));
            upcomingPrograms.forEach(program => {
                description.push(
                    '',
                    `• ${program.start} - ${program.title}`
                );
                if (program.description) {
                    description.push(`  ${program.description}`);
                }
                if (program.category) {
                    description.push(`  🏷️ ${program.category}`);
                }
            });
        }

        meta.description = description.join('\n');
        meta.releaseInfo = `${currentProgram.title} (${currentProgram.start})`;
    } else {
    }

    return meta;
}

const PSEUDO_CHANNEL_IDS = ['rigeneraplaylistpython', 'refreshm3u', 'refreshepg'];
const PSEUDO_META = {
    refreshm3u: { name: 'refresh_m3u_name', description: 'desc_refresh_m3u' },
    refreshepg: { name: 'refresh_epg_name', description: 'desc_refresh_epg' },
    rigeneraplaylistpython: { name: 'regenerate_python_name', description: 'desc_regenerate_python' }
};
const SETTINGS_LOGO = 'https://raw.githubusercontent.com/mccoy88f/OMG-TV-Stremio-Addon/refs/heads/main/tv.png';

/**
 * Build a weserv URL that keeps the logo fully visible regardless of carousel shape.
 *
 * - poster  (2:3, 400×600): tall card → contain with dark background
 * - landscape (3:2, 600×400): wide card → contain with dark background
 * - square (1:1, 400×400): square card → contain with dark background
 *
 * `cbg` sets the canvas background color (hex without #).
 */
function buildPosterUrl(imageUrl, shape = 'poster') {
    if (!imageUrl) return null;
    const base = 'https://images.weserv.nl/?url=' + encodeURIComponent(imageUrl);
    if (shape === 'landscape') {
        return `${base}&w=600&h=400&fit=contain&bg=blur`;
    }
    if (shape === 'square') {
        return `${base}&w=400&h=400&fit=contain&bg=blur`;
    }
    if (shape === 'background') {
        return `${base}&w=1280&h=720&fit=contain&bg=blur`;
    }
    // default: 'poster' → 2:3 tall
    return `${base}&w=400&h=600&fit=contain&bg=blur`;
}

async function metaHandler({ type, id, config: userConfig, cacheManager: cm, epgManager: em }) {
    const cacheManager = cm || global.CacheManager;
    const epgManager = em || require('./epg-manager');
    try {
        const channelId = (typeof id === 'string' && id.includes('|')) ? id.split('|')[1] : (id || '');

        if (PSEUDO_CHANNEL_IDS.includes(channelId)) {
            const info = PSEUDO_META[channelId] || { name: channelId, description: '' };
            const fullId = id && id.includes('|') ? id : `tv|${channelId}`;
            return {
                meta: {
                    id: fullId,
                    type: 'tv',
                    name: t(info.name, userConfig),
                    poster: buildPosterUrl(SETTINGS_LOGO, 'poster'),
                    background: buildPosterUrl(SETTINGS_LOGO, 'background'),
                    logo: buildPosterUrl(SETTINGS_LOGO, 'landscape'),
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

        // Usa direttamente getChannel dalla cache, che ora gestisce correttamente i suffissi
        const channel = cacheManager.getChannel(channelId);

        if (!channel) {
            return { meta: null };
        }



        const meta = {
            id: channel.id,
            type: 'tv',
            name: channel.streamInfo?.tvg?.chno
                ? `${channel.streamInfo.tvg.chno}. ${channel.name}`
                : channel.name,
            // poster  → 2:3 (carosello verticale): logo contenuto su sfondo scuro
            poster: buildPosterUrl(channel.poster || channel.logo, 'poster'),
            // background → scheda dettaglio: 16:9 con logo contenuto (evita lo zoom eccessivo)
            background: buildPosterUrl(channel.background || channel.logo, 'background'),
            // logo → 3:2 (carosello orizzontale / landscape): logo contenuto su sfondo scuro
            // Stremio mostra `logo` nei caroselli landscape; usare weserv garantisce
            // che il logo sia sempre leggibile e non venga ritagliato.
            logo: buildPosterUrl(channel.logo, 'landscape'),
            description: '',
            releaseInfo: 'LIVE',
            genre: channel.genre,
            posterShape: 'poster',
            language: 'ita',
            country: 'ITA',
            isFree: true,
            behaviorHints: {
                isLive: true,
                defaultVideoId: channel.id
            }
        };

        if ((!meta.poster || !meta.background || !meta.logo) && channel.streamInfo?.tvg?.id) {
            const epgIcon = epgManager.getChannelIcon(normalizeId(channel.streamInfo.tvg.id));
            if (epgIcon) {
                meta.poster = meta.poster || buildPosterUrl(epgIcon, 'poster');
                meta.background = meta.background || buildPosterUrl(epgIcon, 'background');
                meta.logo = meta.logo || buildPosterUrl(epgIcon, 'landscape');
            } else {
            }
        }

        let baseDescription = [];

        if (channel.streamInfo?.tvg?.chno) {
            baseDescription.push(`📺 Channel ${channel.streamInfo.tvg.chno}`);
        }

        if (channel.description) {
            baseDescription.push('', channel.description);
        } else {
            baseDescription.push('', `Channel ID: ${channel.streamInfo?.tvg?.id}`);
        }

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
