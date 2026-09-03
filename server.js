const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());

const TMDB_API_KEY = "bc2f6b6e59025240f97d2c70de61d88a";

// --- 1. ROBUST BROWSER ENGINE ---
let globalBrowser = null;

async function getBrowser() {
    if (!globalBrowser || !globalBrowser.isConnected()) {
        console.log("[Engine] Launching Singleton Chromium Instance...");
        globalBrowser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium', // CRITICAL FIX: Points to Docker's Chrome
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--single-process',
                '--disable-web-security',
                '--blink-settings=imagesEnabled=false'
            ]
        });
    }
    return globalBrowser;
}

getBrowser().catch(err => console.error("[Engine] Browser launch error:", err));

// --- 2. MANIFEST ROUTE ---
function createManifest(config) {
    const addonName = config.name || "VidUpPlay";
    return {
        id: "org.vidup.sniper",
        version: "3.0.0",
        name: addonName,
        description: "Professional multi-quality scraper with header injection.",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    };
}

app.get('/', (req, res) => res.redirect('/manifest.json'));

app.get(['/manifest.json', '/:config/manifest.json'], (req, res) => {
    let config = { name: "VidUpPlay" };
    if (req.params.config) {
        try {
            const decoded = Buffer.from(req.params.config, 'base64').toString('utf8');
            config = JSON.parse(decoded);
        } catch(e) {}
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'max-age=86400, public');
    return res.json(createManifest(config));
});

// --- 3. TMDB CONVERTER ---
async function resolveTmdbId(id, type) {
    if (!id.startsWith('tt')) return id.replace('tmdb:', '');
    try {
        const url = `https://api.themoviedb.org/3/find/${id}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
        const res = await fetch(url);
        const data = await res.json();
        if (type === 'movie' && data.movie_results?.length > 0) return data.movie_results[0].id;
        if (type === 'series' && data.tv_results?.length > 0) return data.tv_results[0].id;
    } catch (e) {
        console.error("[TMDB] Resolution Failed:", e.message);
    }
    return null;
}

// --- 4. MASTER PLAYLIST PARSER ---
async function parseMasterPlaylist(masterUrl) {
    if (!masterUrl.includes('.m3u8')) {
        return [{ quality: 'HD', url: masterUrl }];
    }
    try {
        const res = await fetch(masterUrl, {
            headers: {
                'Referer': 'https://vidup.to/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const text = await res.text();
        const streams = [];
        const lines = text.split('\n');
        let currentQuality = null;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('#EXT-X-STREAM-INF')) {
                const resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
                if (resMatch) currentQuality = resMatch[1] + 'p';
            } else if (line && !line.startsWith('#') && currentQuality) {
                let streamUrl = line;
                if (!streamUrl.startsWith('http')) {
                    const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
                    streamUrl = baseUrl + line;
                }
                streams.push({ quality: currentQuality, url: streamUrl });
                currentQuality = null;
            }
        }
        return streams.length > 0 ? streams : [{ quality: 'Auto', url: masterUrl }];
    } catch (e) {
        console.error("[Parser] Failed to parse master playlist:", e);
        return [{ quality: 'Auto', url: masterUrl }];
    }
}

// --- 5. STREAM EXTRACTION (SNIPER) ---
async function scrapeVidup(targetUrl) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    let streamUrl = null;

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Referer': 'https://vidup.to/', 'Origin': 'https://vidup.to' });
        await page.setRequestInterception(true);

        const linkPromise = new Promise((resolve) => {
            page.on('request', (req) => {
                const u = req.url();
                const type = req.resourceType();
                if (['image', 'font', 'stylesheet', 'media'].includes(type)) {
                    req.abort();
                } else {
                    if ((u.includes('.m3u8') || u.includes('.mp4')) && !u.includes('.vtt') && !u.includes('blank') && !u.includes('ad')) {
                        console.log("[Sniper] Caught Target Stream:", u);
                        resolve(u);
                    }
                    req.continue();
                }
            });
        });

        page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 7000 }).catch(() => {});

        page.evaluateOnNewDocument(() => {
            document.addEventListener("DOMContentLoaded", () => {
                const timer = setInterval(() => {
                    const btn = document.querySelector('.play-button, .jw-icon-display, .vjs-big-play-button, #player, button');
                    if (btn) btn.click();
                    const v = document.querySelector('video');
                    if (v) v.play().catch(() => {});
                }, 250);
                setTimeout(() => clearInterval(timer), 4000);
            });
        });

        streamUrl = await Promise.race([
            linkPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5500))
        ]);
    } catch (err) {
        console.log("[Sniper] Extraction ended:", err.message);
    } finally {
        await page.close().catch(() => {});
    }
    return streamUrl;
}

// --- 6. STREAM ROUTE & HEADER INJECTION ---
app.get(['/stream/:type/:id.json', '/:config/stream/:type/:id.json'], async (req, res) => {
    let config = { nameTemplate: "VidUpPlay", descTemplate: "{stream.resolution} • HLS • PeakStorm", emojis: true };

    if (req.params.config) {
        try {
            const decoded = Buffer.from(req.params.config, 'base64').toString('utf8');
            config = { ...config, ...JSON.parse(decoded) };
        } catch(e) {}
    }

    const { type, id } = req.params;
    let rawId = id, season = 1, episode = 1;

    if (type === 'series') {
        const parts = id.split(':');
        rawId = parts[0]; season = parts[1] || 1; episode = parts[2] || 1;
    }

    const tmdbId = await resolveTmdbId(rawId, type);
    if (!tmdbId) return res.json({ streams: [] });

    const targetUrl = type === 'movie' 
        ? `https://vidup.to/movie/${tmdbId}`
        : `https://vidup.to/tv/${tmdbId}/${season}/${episode}`;

    console.log(`[Request] Scraping ${type} ${tmdbId} -> ${targetUrl}`);
    const rawStreamUrl = await scrapeVidup(targetUrl);

    if (rawStreamUrl) {
        const parsedStreams = await parseMasterPlaylist(rawStreamUrl);
        
        const stremioStreams = parsedStreams.map(stream => {
            const resTag = stream.quality;
            let streamName = config.nameTemplate || "VidUpPlay";
            let streamDesc = config.descTemplate || "{stream.resolution} • HLS • PeakStorm";

            if (config.emojis) {
                const emojiMap = { "2160p": "❄️ 4K", "1080p": "🧊 1080p", "720p": "🍿 720p", "480p": "📺 480p" };
                streamName = (emojiMap[resTag] || `🍿 ${resTag}`) + " | " + streamName;
            }

            streamDesc = streamDesc
                .replace('{stream.resolution}', resTag)
                .replace('{addon.name}', config.nameTemplate || "VidUpPlay");

            return {
                name: streamName,
                title: streamDesc,
                url: stream.url,
                // INJECT HEADERS DIRECTLY INTO THE STREMIO PLAYER
                behaviorHints: {
                    notWebReady: true,
                    proxyHeaders: {
                        request: {
                            "Referer": "https://vidup.to/",
                            "Origin": "https://moon.peakstorm.top",
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

// --- 7. SELF-PING MECHANISM ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Live on port ${PORT}`);
    setInterval(() => {
        const renderUrl = process.env.RENDER_EXTERNAL_URL;
        if (renderUrl) fetch(`${renderUrl}/manifest.json`).catch(() => {});
    }, 10 * 60 * 1000);
});
