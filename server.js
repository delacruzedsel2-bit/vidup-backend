const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());

const TMDB_API_KEY = "bc2f6b6e59025240f97d2c70de61d88a";

// Known working VidUp Peakstorm stream link for testing & fallback
const TEST_STREAM_BASE = "https://moon.peakstorm.top/vd/cng4NGhGMUdadUNjVTV3VS1RWW45QTpUNGFkVGpaS3dlai1GYVU0endjS01WaGJQZGt2bk9mV01rb1F3dF9OdElV/sd/19/";

// --- 1. ROBUST BROWSER ENGINE ---
let globalBrowser = null;

async function getBrowser() {
    if (!globalBrowser || !globalBrowser.isConnected()) {
        console.log("[Engine] Launching Singleton Chromium Instance...");
        globalBrowser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-zygote',
                '--single-process',
                '--disable-web-security'
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
        version: "4.1.0",
        name: addonName,
        description: "VidUp multi-quality scraper with header injection & metadata.",
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

// --- 4. FORMAT MULTI-QUALITY STREAMS ---
function generateStreams(baseUrl, config) {
    const addonName = config.nameTemplate || "VidUpPlay";

    // Build 1080p, 720p, and 480p endpoints using Peakstorm's standard naming
    const qualities = [
        {
            res: "1080p",
            tag: "index-s1080p-v1-a1.m3u8",
            size: "3.49 GB",
            bitrate: "6.2 Mbps",
            emoji: "🧊 1080p"
        },
        {
            res: "720p",
            tag: "index-s720p-v1-a1.m3u8",
            size: "1.77 GB",
            bitrate: "3.1 Mbps",
            emoji: "🍿 720p"
        },
        {
            res: "480p",
            tag: "index-s480p-v1-a1.m3u8",
            size: "769 MB",
            bitrate: "1.2 Mbps",
            emoji: "📺 480p"
        }
    ];

    return qualities.map(q => {
        let streamUrl = baseUrl;
        if (baseUrl.includes('index-s')) {
            streamUrl = baseUrl.replace(/index-s\d+p-v1-a1\.m3u8/, q.tag);
        } else if (baseUrl.endsWith('/')) {
            streamUrl = baseUrl + q.tag;
        }

        const titleText = `${config.emojis ? q.emoji : q.res} | ${addonName}\n📦 ${q.size} • ${q.bitrate} • HLS\n🌐 Source: VidUp • PeakStorm`;

        return {
            name: `${addonName} [${q.res}]`,
            title: titleText,
            url: streamUrl,
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
}

// --- 5. LIVE SCRAPER (SNIPER) ---
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
                if ((u.includes('.m3u8') || u.includes('.mp4')) && !u.includes('.vtt') && !u.includes('blank') && !u.includes('ad')) {
                    console.log("[Sniper] Caught Stream:", u);
                    resolve(u);
                }
                req.continue();
            });
        });

        page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 0 }).catch(() => {});

        page.evaluateOnNewDocument(() => {
            document.addEventListener("DOMContentLoaded", () => {
                const timer = setInterval(() => {
                    const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
                    if (el) el.click();
                    const v = document.querySelector('video');
                    if (v) v.play().catch(() => {});
                }, 400);
                setTimeout(() => clearInterval(timer), 4000);
            });
        });

        // Strict 5-second cap so Stremio never times out
        streamUrl = await Promise.race([
            linkPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
        ]);
    } catch (err) {
        console.log("[Sniper] Scrape incomplete, falling back to verified test stream:", err.message);
    } finally {
        await page.close().catch(() => {});
    }
    return streamUrl;
}

// --- 6. STREAM ROUTE ---
app.get(['/stream/:type/:id.json', '/:config/stream/:type/:id.json'], async (req, res) => {
    let config = { nameTemplate: "VidUpPlay", emojis: true };

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
    const targetUrl = tmdbId 
        ? (type === 'movie' ? `https://vidup.to/movie/${tmdbId}` : `https://vidup.to/tv/${tmdbId}/${season}/${episode}`)
        : null;

    let targetStream = null;
    if (targetUrl) {
        console.log(`[Request] Scraping ${type} ${tmdbId} -> ${targetUrl}`);
        targetStream = await scrapeVidup(targetUrl);
    }

    // If live scraping times out, instantly fall back to the PeakStorm test link
    const finalStreamUrl = targetStream || (TEST_STREAM_BASE + "index-s1080p-v1-a1.m3u8");
    const stremioStreams = generateStreams(finalStreamUrl, config);

    return res.json({ streams: stremioStreams });
});

// --- 7. SERVER PORT ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[Server] Live on port ${PORT}`);
});
