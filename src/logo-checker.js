const config = require('./config');
const logger = require('./logger');

// ─── Verifica raggiungibilità link logo (cache 24h, evita ricontrolli) ───────
// Molti M3U hanno tvg-logo con URL morti (host offline, 404, redirect rotti...).
// images.weserv.nl in teoria gestisce questo con &default=, ma in pratica non
// è affidabile al 100% (timeout, risposte non-immagine con status 200, ecc.).
// Per questo verifichiamo noi stessi lato server, una volta, e teniamo il
// risultato in cache: se il link non funziona, lo trattiamo come "nessun logo"
// e usiamo direttamente il nostro placeholder (testo canale) invece di passare
// per weserv.

const cache = new Map(); // url -> { ok: boolean, ts: number }
const TTL_MS = 24 * 60 * 60 * 1000; // 24h
const TIMEOUT_MS = 3000;

function isImageContentType(ct) {
    if (!ct) return true; // alcuni server non impostano content-type: non blocchiamo
    return ct.toLowerCase().startsWith('image');
}

async function probe(url, method) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetch(url, {
            method,
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'User-Agent': config.defaultUserAgent,
                ...(method === 'GET' ? { Range: 'bytes=0-2048' } : {})
            }
        });
        if (!res.ok) return false;
        return isImageContentType(res.headers.get('content-type'));
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Verifica se l'URL di un logo è raggiungibile e restituisce un'immagine valida.
 * Risultato cachato 24h per evitare di ricontrollare lo stesso link in continuazione.
 */
async function isLogoReachable(url) {
    if (!url || typeof url !== 'string') return false;

    const cached = cache.get(url);
    if (cached && (Date.now() - cached.ts) < TTL_MS) return cached.ok;

    let ok = false;
    try {
        ok = await probe(url, 'HEAD');
    } catch (e) {
        ok = false;
    }
    // Alcuni server non supportano HEAD (405/501) o lo bloccano: ritenta con GET parziale
    if (!ok) {
        try {
            ok = await probe(url, 'GET');
        } catch (e) {
            ok = false;
        }
    }

    cache.set(url, { ok, ts: Date.now() });
    if (cache.size > 5000) {
        const now = Date.now();
        for (const [k, v] of cache) {
            if (now - v.ts > TTL_MS) cache.delete(k);
        }
    }
    return ok;
}

module.exports = { isLogoReachable };
