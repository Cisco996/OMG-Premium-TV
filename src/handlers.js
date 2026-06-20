const config = require('./config');
const EPGManager = require('./epg-manager');
const logger = require('./logger');
const StreamProxyManager = require('./stream-proxy-manager')(config);
const ResolverStreamManager = require('./resolver-stream-manager')(config);
const { I18N } = require('../views/views-i18n');
const { isLogoReachable } = require('./logo-checker');

// simple helper to map user-configured language names to i18n codes
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

function getLanguageFromConfig(userConfig) {
    return userConfig.language || config.defaultLanguage || 'Italiana';
}

function normalizeId(id) {
    const beforeAt = (typeof id === 'string' && id.includes('@')) ? id.split('@')[0] : id;
    return beforeAt?.toLowerCase().replace(/[^\w.]/g, '').trim() || '';
}

function cleanNameForImage(name) {
    // Prima rimuoviamo la data e l'ora se presente (pattern: dd/dd/dd - dd:dd (CET))
    let cleaned = name.replace(/\d{2}\/\d{2}\/\d{2}\s*-\s*\d{2}:\d{2}\s*\(CET\)/g, '').trim();

    // Rimuoviamo l'anno se inizia con esso
    cleaned = cleaned.replace(/^20\d{2}\s+/, '');

    // Rimuoviamo caratteri speciali mantenendo spazi e trattini
    cleaned = cleaned.replace(/[^a-zA-Z0-9\s-]/g, '');

    // Rimuoviamo spazi multipli
    cleaned = cleaned.replace(/\s+/g, ' ').trim();

    // Prendiamo solo la parte principale del nome
    let parts = cleaned.split(' - ');
    if (parts.length > 1) {
        cleaned = parts[0].trim();
    }

    // Se ancora troppo lungo, tronchiamo preservando parole intere
    if (cleaned.length > 30) {
        let words = cleaned.split(' ');
        let result = '';
        for (let word of words) {
            if ((result + ' ' + word).length <= 27) {
                result += (result ? ' ' : '') + word;
            } else {
                break;
            }
        }
        cleaned = result + '...';
    }

    return cleaned || 'No Name';
}

// ─── Placeholder placehold.co (canali senza logo) — stessa identità visiva di meta-handler.js ──
const PH_BG   = '1a1a2e'; // sfondo blu scuro
const PH_FG   = 'cc5500'; // testo arancione scuro
const PH_FONT = 'montserrat';

function buildPlaceholderUrl(channelName, size, baseUrl = null) {
    const label = cleanNameForImage(channelName || 'LIVE TV').substring(0, 40).trim();
    if (baseUrl) {
        const [w, h] = size.split('x');
        return `${baseUrl}/ph-image?name=${encodeURIComponent(label)}&w=${w}&h=${h}`;
    }
    // Fallback esterno se baseUrl non disponibile
    const [w] = size.split('x');
    const fontSize = Math.min(120, Math.max(60, Math.round(parseInt(w, 10) * 0.12)));
    const text = encodeURIComponent(label);
    return `https://placehold.co/${size}/${PH_BG}/${PH_FG}.png?font=${PH_FONT}&text=${text}&fontSize=${fontSize}`;
}

/**
 * Wrappa un logo tramite weserv con resize+contain E un fallback &default=
 * che weserv usa automaticamente se l'URL originale è rotto/irraggiungibile
 * (link morti sono molto comuni nelle playlist IPTV — senza questo, weserv
 * mostra un riquadro vuoto invece del placeholder col nome canale).
 *
 * transparent=true → nessun riempimento dello sfondo (cbg), il canvas resta
 * vuoto/trasparente attorno al logo. Usato per poster (2:3) e logo (3:2): in
 * entrambi i casi Stremio può mostrare l'immagine sovrapposta ad altri sfondi
 * (card, pagina dettaglio), quindi un riempimento pieno risulterebbe visibile
 * come un riquadro colorato. Il "background" (1280x720) mantiene invece cbg,
 * essendo pensato per riempire per intero lo sfondo della pagina dettaglio.
 */
function buildPosterUrl(imageUrl, w, h, channelName, baseUrl = null, transparent = false) {
    const fallback = buildPlaceholderUrl(channelName, `${w}x${h}`, baseUrl);
    if (!imageUrl) return fallback;
    const defaultParam = encodeURIComponent(fallback);
    const bgParam = transparent ? '' : '&cbg=1a1a2e';
    return `https://images.weserv.nl/?url=${encodeURIComponent(imageUrl)}&w=${w}&h=${h}&fit=contain${bgParam}&default=${defaultParam}`;
}

async function catalogHandler({ type, id, extra, config: userConfig, cacheManager: cm, epgManager: em, pythonResolver, pythonRunner, baseUrl }) {
    const cacheManager = cm || global.CacheManager;
    const epgManager = em || require('./epg-manager');
    try {
        if (!userConfig.m3u) {
            logger.log(cacheManager?.sessionKey ?? '_', 'M3U URL missing in configuration');
            return { metas: [], genres: [] };
        }

        // Aggiorna sempre la configurazione
        await cacheManager.updateConfig(userConfig);

        const cacheEmpty = !cacheManager.cache?.stremioData?.channels?.length;
        if (cacheEmpty && userConfig.m3u && cacheManager.cache.m3uUrl !== userConfig.m3u) {
            logger.log(cacheManager?.sessionKey ?? '_', 'Catalog: cache empty, rebuilding playlist from M3U...');
            await cacheManager.rebuildCache(userConfig.m3u, userConfig);
        }

        // Se l'EPG è abilitato, inizializzalo con l'epgManager della sessione (non quello default)
        if (userConfig.epg_enabled === 'true') {
            const epgToUse = userConfig.epg ||
                (cacheManager.cache.epgUrls &&
                    cacheManager.cache.epgUrls.length > 0
                    ? cacheManager.cache.epgUrls.join(',')
                    : null);

            if (epgToUse) {
                await epgManager.initializeEPG(epgToUse);
            }
        }

        let { search, genre, skip = 0 } = extra || {};

        if (genre && genre.includes('&skip')) {
            const parts = genre.split('&skip');
            genre = parts[0];
            if (parts[1] && parts[1].startsWith('=')) {
                skip = parseInt(parts[1].substring(1)) || 0;
            }
        }

        // Se riceviamo un nuovo filtro (search o genre), lo salviamo
        if (search) {
            cacheManager.setLastFilter('search', search);
        } else if (genre) {
            cacheManager.setLastFilter('genre', genre);
        } else if (!skip) {
            // Se non c'è skip, significa che è una nuova richiesta senza filtri
            cacheManager.clearLastFilter();
        }

        skip = parseInt(skip) || 0;
        const ITEMS_PER_PAGE = 100;

        // Otteniamo i canali già filtrati
        let filteredChannels = cacheManager.getFilteredChannels();
        const cachedData = cacheManager.getCachedData();

        const paginatedChannels = filteredChannels.slice(skip, skip + ITEMS_PER_PAGE);

        const metas = await Promise.all(paginatedChannels.map(async channel => {
            const language = getLanguageFromConfig(userConfig);
            const languageAbbr = language.substring(0, 3).toUpperCase();
            const rawIconCandidate = channel.poster || channel.logo || channel.background;
            // Verifica che il link del logo funzioni davvero: se è rotto/irraggiungibile
            // lo trattiamo come canale senza logo (placeholder col nome canale), invece
            // di affidarci solo al fallback &default di weserv (non sempre affidabile).
            const rawIconOk = rawIconCandidate ? await isLogoReachable(rawIconCandidate) : false;
            const rawIcon   = rawIconOk ? rawIconCandidate : null;
            const logoUrl   = rawIconOk ? channel.logo : null;

            const meta = {
                id: channel.id,
                type: 'tv',
                name: `${channel.name} [${languageAbbr}]`,
                // poster → 2:3 con sfondo scuro (cbg=1a1a2e): logo ridotto nel canvas come vecchia versione
                poster: buildPosterUrl(rawIcon, 400, 600, channel.name, baseUrl),
                background: rawIcon ? buildPosterUrl(channel.background || channel.logo, 1280, 720, channel.name, baseUrl) : null,
                // logo → 3:2 con sfondo scuro (cbg=1a1a2e): comportamento identico al poster 2:3
                logo: buildPosterUrl(logoUrl, 600, 400, channel.name, baseUrl),
                description: channel.description || `Channel: ${channel.name} - ID: ${channel.streamInfo?.tvg?.id}`,
                genre: channel.genre,
                posterShape: channel.posterShape || 'poster',
                releaseInfo: 'LIVE',
                behaviorHints: {
                    isLive: true,
                    ...channel.behaviorHints
                },
                streamInfo: channel.streamInfo
            };

            if (channel.streamInfo?.tvg?.chno) {
                meta.name = `${channel.streamInfo.tvg.chno}. ${channel.name} [${languageAbbr}]`;
            }

            if (!rawIcon && channel.streamInfo?.tvg?.id) {
                const epgIcon   = epgManager.getChannelIcon(channel.streamInfo.tvg.id);
                const epgIconOk = epgIcon ? await isLogoReachable(epgIcon) : false;
                if (epgIcon && epgIconOk) {
                    meta.poster = buildPosterUrl(epgIcon, 400, 600, channel.name, baseUrl);
                    meta.background = buildPosterUrl(epgIcon, 1280, 720, channel.name, baseUrl);
                    meta.logo = buildPosterUrl(epgIcon, 600, 400, channel.name, baseUrl);
                }
            }

            return enrichWithEPG(meta, channel.streamInfo?.tvg?.id, userConfig, epgManager);
        }));

        const SETTINGS_GENRE = '⚙️';
        const settingsLogo = 'https://raw.githubusercontent.com/mccoy88f/OMG-TV-Stremio-Addon/refs/heads/main/tv.png';
        const languageAbbr = (getLanguageFromConfig(userConfig).substring(0, 3)).toUpperCase();
        const pseudoChannels = [
            { id: 'tv|refreshm3u', name: 'Refresh M3U playlist' },
            { id: 'tv|refreshepg', name: 'Refresh EPG' }
        ];
        const settingsMetas = pseudoChannels.map(ch => ({
            id: ch.id,
            type: 'tv',
            name: `${ch.name} [${languageAbbr}]`,
            poster: settingsLogo,
            background: settingsLogo,
            logo: settingsLogo,
            description: `Channel: ${ch.name}`,
            genre: [SETTINGS_GENRE],
            posterShape: 'poster',
            releaseInfo: 'LIVE',
            behaviorHints: { isLive: true },
            streamInfo: { tvg: { id: ch.id.replace('tv|', '') }, urls: [] }
        }));
        const rawGenres = cachedData.genres || [];
        const normalizedGenres = rawGenres.map(g => (g === '~SETTINGS~' || g === 'Settings' ? SETTINGS_GENRE : g));
        const genres = [...new Set([...normalizedGenres, SETTINGS_GENRE])];

        if (genre === SETTINGS_GENRE) {
            const settingsChannels = cacheManager.getChannelsByGenre(SETTINGS_GENRE);
            const settingsChannelsMetas = settingsChannels.map(channel => {
                const fallbackLogo = buildPlaceholderUrl(channel.name, '500x500', baseUrl);
                const meta = {
                    id: channel.id,
                    type: 'tv',
                    name: `${channel.name} [${languageAbbr}]`,
                    poster: channel.poster || fallbackLogo,
                    background: channel.background || fallbackLogo,
                    logo: channel.logo || fallbackLogo,
                    description: channel.description || `Channel: ${channel.name}`,
                    genre: channel.genre,
                    posterShape: channel.posterShape || 'poster',
                    releaseInfo: 'LIVE',
                    behaviorHints: { isLive: true, ...channel.behaviorHints },
                    streamInfo: channel.streamInfo
                };
                return meta;
            });
            const allSettingsMetas = [...settingsChannelsMetas, ...settingsMetas];
            const settingsPaginated = allSettingsMetas.slice(skip, skip + ITEMS_PER_PAGE);
            return { metas: settingsPaginated, genres };
        }
        return { metas, genres };

    } catch (error) {
        logger.error(cacheManager?.sessionKey ?? '_', 'Catalog handler error:', error);
        return { metas: [], genres: [] };
    }
}

function enrichWithEPG(meta, channelId, userConfig, epgManager) {
    const epg = epgManager || require('./epg-manager');
    if (!userConfig.epg_enabled || !channelId) {
        meta.description = `${t('live_channel', userConfig)} ${meta.name}`;
        meta.releaseInfo = 'LIVE';
        return meta;
    }

    const currentProgram = epg.getCurrentProgram(normalizeId(channelId));
    const upcomingPrograms = epg.getUpcomingPrograms(normalizeId(channelId));

    if (currentProgram) {
        meta.description = `${t('now_on_air', userConfig)}\n${currentProgram.title}`;

        if (currentProgram.description) {
            meta.description += `\n${currentProgram.description}`;
        }

        meta.description += `\n${t('time_slot', userConfig)} ${currentProgram.start} - ${currentProgram.stop}`;

        if (currentProgram.category) {
            meta.description += `\n${t('category', userConfig)} ${currentProgram.category}`;
        }

        if (upcomingPrograms && upcomingPrograms.length > 0) {
            meta.description += '\n\n' + t('next_program', userConfig);
            upcomingPrograms.forEach(program => {
                meta.description += `\n${program.start} - ${program.title}`;
            });
        }

        meta.releaseInfo = `${t('currently_airing', userConfig)} ${currentProgram.title}`;
    }

    return meta;
}

const PSEUDO_CHANNEL_IDS = ['rigeneraplaylistpython', 'refreshm3u', 'refreshepg'];

async function streamHandler({ id, config: userConfig, cacheManager: cm, epgManager: em, pythonResolver, pythonRunner, baseUrl }) {
    const cacheManager = cm || global.CacheManager;
    const epgManager = em || require('./epg-manager');
    const runner = pythonRunner || require('./python-runner');
    try {
        const channelId = (typeof id === 'string' && id.includes('|')) ? id.split('|')[1] : (id || '');

        await cacheManager.updateConfig(userConfig);

        const isPseudo = PSEUDO_CHANNEL_IDS.includes(channelId);

        if (!isPseudo && !userConfig.m3u) {
            logger.log(cacheManager?.sessionKey ?? '_', 'M3U URL missing');
            return { streams: [] };
        }

        const NO_SIGNAL_URL = 'https://static.vecteezy.com/system/resources/previews/001/803/236/mp4/no-signal-bad-tv-free-video.mp4';
        const PSEUDO_STREAM_HINTS = { notWebReady: false, bingeGroup: 'tv' };
        const PSEUDO_MSG_SUFFIX = `\\n${t('go_back_reopen', userConfig)}`;

        function pseudoStream(success, title, url = NO_SIGNAL_URL) {
            return {
                streams: [{
                    name: success ? t('completed', userConfig) : t('error', userConfig),
                    title: (success ? '✅ ' : '❌ ') + title + PSEUDO_MSG_SUFFIX,
                    url,
                    behaviorHints: PSEUDO_STREAM_HINTS
                }]
            };
        }

        if (channelId === 'rigeneraplaylistpython') {
            const result = await runner.executeScript();
            if (result) {
                await cacheManager.rebuildCache(userConfig.m3u, userConfig);
                return pseudoStream(true, t('playlist_regenerated', userConfig));
            }
            logger.log(cacheManager?.sessionKey ?? '_', 'Python script execution error');
            return pseudoStream(false, runner.lastError || t('unknown_error', userConfig));
        }

        if (channelId === 'refreshm3u') {
            try {
                if (!userConfig.m3u) return pseudoStream(false, t('error_m3u_missing', userConfig));
                await cacheManager.rebuildCache(userConfig.m3u, userConfig);
                return pseudoStream(true, t('m3u_refreshed', userConfig));
            } catch (err) {
                logger.error(cacheManager?.sessionKey ?? '_', 'Refresh M3U error:', err.message);
                return pseudoStream(false, err.message || t('unknown_error', userConfig));
            }
        }

        if (channelId === 'refreshepg') {
            try {
                if (userConfig.epg_enabled !== 'true' || !userConfig.epg) return pseudoStream(false, t('error_epg_not_enabled', userConfig));
                await epgManager.startEPGUpdate(userConfig.epg);
                return pseudoStream(true, t('epg_refreshed', userConfig));
            } catch (err) {
                logger.error(cacheManager?.sessionKey ?? '_', 'Refresh EPG error:', err.message);
                return pseudoStream(false, err.message || t('unknown_error', userConfig));
            }
        }

        // Continua con il normale flusso per gli altri canali
        const channel = cacheManager.getChannel(channelId);

        if (!channel) {
            logger.log(cacheManager?.sessionKey ?? '_', 'Channel not found:', channelId);
            return { streams: [] };
        }

        let streams = [];
        let originalStreamDetails = [];

        // Prepara i dettagli dello stream originale per potenziale risoluzione o proxy
        if (channel.streamInfo.urls) {
            for (const stream of channel.streamInfo.urls) {
                const headers = stream.headers || {};
                if (!headers['User-Agent']) {
                    headers['User-Agent'] = config.defaultUserAgent;
                }

                originalStreamDetails.push({
                    name: channel.name,
                    originalName: stream.name,
                    url: stream.url,
                    headers: headers
                });
            }
        }


        if (userConfig.resolver_enabled === 'true' && userConfig.resolver_script) {
            logger.log(cacheManager?.sessionKey ?? '_', 'Using resolver for', channel.name);

            try {
                const streamDetails = {
                    name: channel.name,
                    originalName: channel.name,
                    streamInfo: {
                        urls: channel.streamInfo.urls
                    }
                };

                const resolvedStreams = await ResolverStreamManager.getResolvedStreams(streamDetails, userConfig, pythonResolver || require('./python-resolver'), cacheManager?.sessionKey);

                if (resolvedStreams && resolvedStreams.length > 0) {
                    logger.log(cacheManager?.sessionKey ?? '_', 'Got', resolvedStreams.length, 'resolved stream(s)');

                    if (userConfig.force_proxy === 'true') {
                        // Se force_proxy è attivo, mostriamo SOLO i flussi passati attraverso il proxy
                        if (userConfig.proxy && userConfig.proxy_pwd) {
                            logger.log(cacheManager?.sessionKey ?? '_', 'Applying proxy to resolved streams (force mode)...');

                            for (const resolvedStream of resolvedStreams) {
                                const proxyStreamDetails = {
                                    name: resolvedStream.name,
                                    originalName: resolvedStream.title,
                                    url: resolvedStream.url,
                                    headers: resolvedStream.headers || {}
                                };

                                const proxiedResolvedStreams = await StreamProxyManager.getProxyStreams(proxyStreamDetails, userConfig, cacheManager?.sessionKey);
                                streams.push(...proxiedResolvedStreams);
                            }

                            if (streams.length === 0) {
                                logger.log(cacheManager?.sessionKey ?? '_', 'No valid proxy for resolved streams and force_proxy is on, no stream available');
                            }
                        } else {
                            logger.log(cacheManager?.sessionKey ?? '_', 'Force proxy on but not configured correctly, using original resolved streams');
                            streams = resolvedStreams;
                        }
                    } else {
                        // Se force_proxy NON è attivo:
                        // 1. Aggiungiamo prima i flussi risolti originali
                        streams = resolvedStreams;

                        // 2. Aggiungiamo anche i flussi risolti tramite proxy, se il proxy è configurato
                        if (userConfig.proxy && userConfig.proxy_pwd) {
                            logger.log(cacheManager?.sessionKey ?? '_', 'Adding proxy streams to resolved streams...');

                            for (const resolvedStream of resolvedStreams) {
                                const proxyStreamDetails = {
                                    name: resolvedStream.name,
                                    originalName: resolvedStream.title,
                                    url: resolvedStream.url,
                                    headers: resolvedStream.headers || {}
                                };

                                const proxiedResolvedStreams = await StreamProxyManager.getProxyStreams(proxyStreamDetails, userConfig, cacheManager?.sessionKey);
                                streams.push(...proxiedResolvedStreams);
                            }
                        }
                    }
                } else {
                    logger.log(cacheManager?.sessionKey ?? '_', 'No resolved stream available, using standard streams');
                    // Riprendi con la logica standard solo se il resolver fallisce
                    streams = await processOriginalStreams(originalStreamDetails, channel, userConfig, cacheManager?.sessionKey);
                }
            } catch (resolverError) {
                logger.error(cacheManager?.sessionKey ?? '_', 'Stream resolution error:', resolverError);
                streams = await processOriginalStreams(originalStreamDetails, channel, userConfig, cacheManager?.sessionKey);
            }
        } else {
            streams = await processOriginalStreams(originalStreamDetails, channel, userConfig, cacheManager?.sessionKey);
        }

        // Aggiungi i metadati a tutti gli stream
        // Verifica raggiungibilità logo (come nel catalogHandler) per evitare loghi rotti
        const rawIconCandidate = channel.poster || channel.logo || channel.background;
        const rawIconOk = rawIconCandidate ? await isLogoReachable(rawIconCandidate) : false;
        const rawIcon   = rawIconOk ? (channel.poster || channel.logo) : null;
        const logoUrl   = rawIconOk ? channel.logo : null;

        const meta = {
            id: channel.id,
            type: 'tv',
            name: channel.name,
            // poster → 2:3 con sfondo scuro (cbg=1a1a2e): logo ridotto nel canvas come vecchia versione
            poster: buildPosterUrl(rawIcon, 400, 600, channel.name, baseUrl),
            background: rawIconOk ? buildPosterUrl(channel.background || channel.logo, 1280, 720, channel.name, baseUrl) : null,
            // logo → 3:2 con sfondo scuro (cbg=1a1a2e): comportamento identico al poster 2:3
            logo: buildPosterUrl(logoUrl, 600, 400, channel.name, baseUrl),
            description: channel.description || `Channel ID: ${channel.streamInfo?.tvg?.id}`,
            genre: channel.genre,
            posterShape: channel.posterShape || 'poster',
            releaseInfo: 'LIVE',
            behaviorHints: {
                isLive: true,
                ...channel.behaviorHints
            },
            streamInfo: channel.streamInfo
        };

        if (!rawIcon && channel.streamInfo?.tvg?.id) {
            const epgIcon   = epgManager.getChannelIcon(channel.streamInfo.tvg.id);
            const epgIconOk = epgIcon ? await isLogoReachable(epgIcon) : false;
            if (epgIcon && epgIconOk) {
                meta.poster     = buildPosterUrl(epgIcon, 400, 600, channel.name, baseUrl);
                meta.background = buildPosterUrl(epgIcon, 1280, 720, channel.name, baseUrl);
                meta.logo       = buildPosterUrl(epgIcon, 600, 400, channel.name, baseUrl);
            }
        }

        streams.forEach(stream => {
            stream.meta = meta;
        });

        return { streams };
    } catch (error) {
        logger.error(cacheManager?.sessionKey ?? '_', 'Stream handler error:', error);
        return { streams: [] };
    }
}

async function processOriginalStreams(originalStreamDetails, channel, userConfig, sessionKey = null) {
    let streams = [];
    if (userConfig.force_proxy === 'true') {
        if (userConfig.proxy && userConfig.proxy_pwd) {
            for (const streamDetails of originalStreamDetails) {
                const proxyStreams = await StreamProxyManager.getProxyStreams(streamDetails, userConfig, sessionKey);
                streams.push(...proxyStreams);
            }
        }
    } else {
        for (const streamDetails of originalStreamDetails) {
            const language = getLanguageFromConfig(userConfig);
            const streamMeta = {
                name: streamDetails.name,
                title: `📺 ${streamDetails.originalName || streamDetails.name} [${language.substring(0, 3).toUpperCase()}]`,
                url: streamDetails.url,
                headers: streamDetails.headers,
                language: language,
                behaviorHints: {
                    notWebReady: false,
                    bingeGroup: "tv"
                }
            };
            streams.push(streamMeta);
            if (userConfig.proxy && userConfig.proxy_pwd) {
                const proxyStreams = await StreamProxyManager.getProxyStreams(streamDetails, userConfig, sessionKey);
                streams.push(...proxyStreams);
            }
        }
    }
    return streams;
}

module.exports = {
    catalogHandler,
    streamHandler,
    // Esporta anche la nuova funzione ausiliaria per poterla utilizzare in altri moduli se necessario
    processOriginalStreams
};
