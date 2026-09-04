const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());

const TMDB_API_KEY = "bc2f6b6e59025240f97d2c70de61d88a";

// --- 1. STEALTH BROWSER ENGINE ---
let globalBrowser = null;
async function getBrowser() {
    if (!globalBrowser || !globalBrowser.isConnected()) {
        console.log("[Engine] Launching Stealth Chromium...");
        globalBrowser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage', 
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
                '--window-size=1920,1080' // Larger window ensures the play button is visible
            ]
        });
    }
    return globalBrowser;
}
getBrowser().catch(err => console.error(err));

// --- 2. MANIFEST ROUTE ---
app.get(['/', '/manifest.json', '/:config/manifest.json'], (req, res) => {
    let config = { name: "VidUpPlay" };
    if (req.params.config) {
        try { config = JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8')); } catch(e) {}
    }
    res.setHeader('Content-Type', 'application/json');
    res.json({
        id: "org.vidup.raw",
        version: "7.0.0",
        name: config.name || "VidUpPlay",
        description: "Direct Raw Link Scraper (Full AAC Audio Support)",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    });
});

// --- 3. MASTER PLAYLIST PARSER (NO PROXY, RAW LINKS) ---
async function parseMasterPlaylist(masterUrl, isMovie) {
    if (!masterUrl.includes('.m3u8')) return [{ quality: 'Auto', url: masterUrl, size: '' }];
    
    try {
        const res = await fetch(masterUrl, { 
            headers: { 'Referer': 'https://vidup.to/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } 
        });
        const text = await res.text();
        const streams = [];
        const lines = text.split('\n');
        
        let currentQuality = null;
        let currentBandwidth = null;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('#EXT-X-STREAM-INF')) {
                const resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
                const bwMatch = line.match(/BANDWIDTH=(\d+)/);
                if (resMatch) currentQuality = (resMatch[1] === '2160' ? '4K' : resMatch[1] + 'p');
                if (bwMatch) currentBandwidth = parseInt(bwMatch[1]);
            } else if (line && !line.startsWith('#') && currentQuality) {
                // Keep the RAW url, do not wrap it in a proxy!
                let streamUrl = line.startsWith('http') ? line : masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1) + line;
                
                let sizeStr = "";
                if (currentBandwidth) {
                    const durationSec = isMovie ? 7200 : 2700; 
                    const sizeMB = (currentBandwidth * durationSec) / 8388608; 
                    sizeStr = sizeMB > 1000 ? `${(sizeMB/1024).toFixed(2)} GB` : `${sizeMB.toFixed(0)} MB`;
                }

                streams.push({ quality: currentQuality, url: streamUrl, size: sizeStr });
                currentQuality = null; currentBandwidth = null;
            }
        }
        return streams.length > 0 ? streams : [{ quality: 'Auto', url: masterUrl, size: '' }];
    } catch (e) {
        return [{ quality: 'Auto', url: masterUrl, size: '' }];
    }
}

// --- 4. AGGRESSIVE LIVE SCRAPER ---
async function scrapeVidup(targetUrl) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    let streamUrl = null;

    try {
        await page.setRequestInterception(true);
        const linkPromise = new Promise((resolve) => {
            page.on('request', (req) => {
                const u = req.url();
                // Block tracking, but allow everything else so the player fully loads
                if (u.includes('google-analytics') || u.includes('beacon')) {
                    req.abort();
                } else {
                    if ((u.includes('.m3u8') || u.includes('.mp4')) && !u.includes('.vtt') && !u.includes('blank') && !u.includes('ad')) {
                        console.log("[Sniper SUCCESS] Caught Link:", u);
                        resolve(u);
                    }
                    req.continue();
                }
            });
        });

        page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

        // Aggressive Auto-Clicker
        page.evaluateOnNewDocument(() => {
            document.addEventListener("DOMContentLoaded", () => {
                const timer = setInterval(() => {
                    if (!document.body.innerHTML.includes('challenge-running')) {
                        // 1. Try to click the center of the screen
                        const centerEl = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
                        if (centerEl) centerEl.click();
                        
                        // 2. Try to click any known play button classes
                        const btn = document.querySelector('.play-button, .jw-icon-display, .vjs-big-play-button, .plyr__control--overlaid');
                        if (btn) btn.click();
                        
                        // 3. Force the video tag
                        const v = document.querySelector('video');
                        if (v) v.play().catch(() => {});
                    }
                }, 800);
            });
        });

        streamUrl = await Promise.race([
            linkPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 25000))
        ]);
    } catch (err) {
        console.log("[Sniper Timeout]", err.message);
    } finally {
        await page.close().catch(() => {});
    }
    return streamUrl;
}

// --- 5. STREAM GENERATION ROUTE ---
app.get(['/stream/:type/:id.json', '/:config/stream/:type/:id.json'], async (req, res) => {
    let config = { nameTemplate: "VidUpPlay", emojis: true };
    if (req.params.config) {
        try { config = { ...config, ...JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8')) }; } catch(e) {}
    }

    const { type, id } = req.params;
    let rawId = id, season = 1, episode = 1;
    if (type === 'series') {
        const parts = id.split(':');
        rawId = parts[0]; season = parts[1] || 1; episode = parts[2] || 1;
    }

    let tmdbId = rawId;
    if (rawId.startsWith('tt')) {
        try {
            const url = `https://api.themoviedb.org/3/find/${rawId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
            const r = await fetch(url);
            const data = await r.json();
            if (type === 'movie' && data.movie_results?.length > 0) tmdbId = data.movie_results[0].id;
            else if (type === 'series' && data.tv_results?.length > 0) tmdbId = data.tv_results[0].id;
        } catch(e){}
    }

    const targetUrl = type === 'movie' ? `https://vidup.to/movie/${tmdbId}` : `https://vidup.to/tv/${tmdbId}/${season}/${episode}`;
    console.log(`[Scraping] ${targetUrl}`);
    
    // NO MORE TEST LINK. It either scrapes the real link, or it returns empty.
    const rawStreamUrl = await scrapeVidup(targetUrl);
    
    if (rawStreamUrl) {
        const parsedStreams = await parseMasterPlaylist(rawStreamUrl, type === 'movie');
        
        const stremioStreams = parsedStreams.map(stream => {
            const resTag = stream.quality;
            const sizeStr = stream.size ? `\n💾 ${stream.size}` : "";
            let streamName = config.nameTemplate || "VidUpPlay";

            if (config.emojis) {
                const emojiMap = { "4K": "❄️ 4K", "1080p": "🧊 1080p", "720p": "🍿 720p", "480p": "📺 480p" };
                streamName = (emojiMap[resTag] || `🍿 ${resTag}`) + " | " + streamName;
            } else streamName = `${resTag} | ${streamName}`;

            return {
                name: streamName,
                title: `${resTag} • Direct Stream\n🌐 PeakStorm Engine` + sizeStr,
                url: stream.url,
                // INJECT HEADERS SO STREMIO NATIVELY BYPASSES THE 403 ERROR
                behaviorHints: {
                    notWebReady: true,
                    proxyHeaders: {
                        request: {
                            "Referer": "https://vidup.to/",
                            "Origin": "https://vidup.to",
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                        }
                    }
                }
            };
        });

        return res.json({ streams: stremioStreams });
    }

    return res.json({ streams: [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Live on port ${PORT}`);
    setInterval(() => {
        const renderUrl = process.env.RENDER_EXTERNAL_URL;
        if (renderUrl) fetch(`${renderUrl}/manifest.json`).catch(() => {});
    }, 10 * 60 * 1000);
});
