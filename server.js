const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());

const TMDB_API_KEY = "bc2f6b6e59025240f97d2c70de61d88a";

// Your verified troubleshooting link
const TEST_STREAM_BASE = "https://moon.peakstorm.top/vd/cng4NGhGMUdadUNjVTV3VS1RWW45QTpUNGFkVGpaS3dlai1GYVU0endjS01WaGJQZGt2bk9mV01rb1F3dF9OdElV/sd/19/";

// --- 1. ROBUST STEALTH BROWSER ENGINE ---
let globalBrowser = null;

async function getBrowser() {
    if (!globalBrowser || !globalBrowser.isConnected()) {
        console.log("[Engine] Launching Stealth Chromium Instance...");
        globalBrowser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-dev-shm-usage',
                '--disable-gpu'
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
        version: "5.1.0",
        name: addonName,
        description: "Troubleshooting mode: Guaranteed 4K/1080p fallback streams.",
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

// --- 4. LIVE SCRAPER (STEALTH SNIPER) ---
async function scrapeVidup(targetUrl) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    let streamUrl = null;

    try {
        await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'Referer': 'https://vidup.to/', 'Origin': 'https://vidup.to' });
        await page.setRequestInterception(true);

        const linkPromise = new Promise((resolve) => {
            page.on('request', (req) => {
                const u = req.url();
                if ((u.includes('.m3u8') || u.includes('.mp4')) && !u.includes('.vtt') && !u.includes('blank') && !u.includes('ad')) {
                    resolve(u);
                }
                req.continue();
            });
        });

        page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 0 }).catch(() => {});

        page.evaluateOnNewDocument(() => {
            document.addEventListener("DOMContentLoaded", () => {
                const timer = setInterval(() => {
                    if (!document.body.innerHTML.includes('challenge-running')) {
                        const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
                        if (el) el.click();
                        const v = document.querySelector('video');
                        if (v) v.play().catch(() => {});
                    }
                }, 500);
                setTimeout(() => clearInterval(timer), 8000);
            });
        });

        streamUrl = await Promise.race([
            linkPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8500))
        ]);
    } catch (err) {
        console.log("[Sniper] Extraction failed or Cloudflare blocked:", err.message);
    } finally {
        await page.close().catch(() => {});
    }
    return streamUrl;
}

// --- 5. STREAM ROUTE & HEADER INJECTION ---
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
    let rawStreamUrl = null;

    if (tmdbId) {
        const targetUrl = type === 'movie' 
            ? `https://vidup.to/movie/${tmdbId}`
            : `https://vidup.to/tv/${tmdbId}/${season}/${episode}`;
        console.log(`[Request] Scraping ${type} ${tmdbId} -> ${targetUrl}`);
        rawStreamUrl = await scrapeVidup(targetUrl);
    }

    // ==========================================
    // GUARANTEED TROUBLESHOOTING FALLBACK
    // ==========================================
    // If the scraper succeeds, we use the scraped base URL. If Cloudflare blocks it, we use the TEST URL.
    const finalBaseUrl = rawStreamUrl 
        ? rawStreamUrl.substring(0, rawStreamUrl.lastIndexOf('/') + 1) 
        : TEST_STREAM_BASE;
        
    if (!rawStreamUrl) console.log("[Fallback] Injecting Troubleshoot Links...");
    
    // Sniping exactly the 4 required qualities
    const qualities = [
        { res: "4K", file: "index-s2160p-v1-a1.m3u8", size: "9.17 GB", emoji: "❄️" },
        { res: "1080p", file: "index-s1080p-v1-a1.m3u8", size: "3.49 GB", emoji: "🧊" },
        { res: "720p", file: "index-s720p-v1-a1.m3u8", size: "1.77 GB", emoji: "🍿" },
        { res: "480p", file: "index-s480p-v1-a1.m3u8", size: "769 MB", emoji: "📺" }
    ];

    const stremioStreams = qualities.map(q => {
        let streamName = config.nameTemplate || "VidUpPlay";
        if (config.emojis) streamName = `${q.emoji} ${q.res} | ${streamName}`;
        else streamName = `${q.res} | ${streamName}`;

        return {
            name: streamName,
            title: `${q.res} • HLS • PeakStorm\n💾 ${q.size}\n🌐 Source: VidUp.to`,
            url: finalBaseUrl + q.file,
            
            // PROFESSIONAL HEADER INJECTION: Forces Stremio to spoof the headers natively
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
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Live on port ${PORT}`));
