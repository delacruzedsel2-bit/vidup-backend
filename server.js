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
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-web-security']
        });
    }
    return globalBrowser;
}
getBrowser().catch(err => console.error(err));

app.get(['/', '/manifest.json', '/:config/manifest.json'], (req, res) => {
    let config = { name: "VidUpPlay" };
    if (req.params.config) {
        try { config = JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8')); } catch(e) {}
    }
    res.setHeader('Content-Type', 'application/json');
    res.json({
        id: "org.vidup.proproxy",
        version: "10.0.0",
        name: config.name || "VidUpPlay",
        description: "Ultimate Pengu-Style Stremio Proxy & Live Scraper (1080p Only).",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    });
});

// --- 2. THE PENGU LOCAL PROXY REWRITER ---
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL provided");

    try {
        const response = await fetch(targetUrl, {
            headers: {
                "Referer": "https://vidup.to/",
                "Origin": "https://vidup.to",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
        });

        res.setHeader('Content-Type', response.headers.get('content-type') || 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (targetUrl.includes('.m3u8')) {
            const text = await response.text();
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
            
            const rewritten = text.split('\n').map(line => {
                let trimmed = line.trim();
                if (trimmed === '') return line;

                if (trimmed.startsWith('#EXT-X-MEDIA') && trimmed.includes('URI="')) {
                    return trimmed.replace(/URI="([^"]+)"/, (match, uri) => {
                        const fullUrl = uri.startsWith('http') ? uri : baseUrl + uri;
                        return `URI="${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(fullUrl)}"`;
                    });
                }
                
                if (trimmed.startsWith('#')) return line;
                
                const fullUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
                
                if (fullUrl.includes('.m3u8')) {
                    return `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(fullUrl)}`;
                } else {
                    try {
                        const chunkUrl = new URL(fullUrl);
                        const d = encodeURIComponent(chunkUrl.origin);
                        const hRef = encodeURIComponent("Referer:https://vidup.to/");
                        const hOrg = encodeURIComponent("Origin:https://vidup.to");
                        const hUA = encodeURIComponent("User-Agent:Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
                        return `http://127.0.0.1:11470/proxy/d=${d}&h=${hRef}&h=${hOrg}&h=${hUA}${chunkUrl.pathname}${chunkUrl.search}`;
                    } catch(e) { return fullUrl; }
                }
            }).join('\n');
            
            return res.send(rewritten);
        } else {
            const arrayBuf = await response.arrayBuffer();
            return res.send(Buffer.from(arrayBuf));
        }
    } catch (e) {
        console.error("[Proxy Error]", e);
        res.status(500).send("Proxy error");
    }
});

// --- 3. EXTRACT 1080P FROM MASTER PLAYLIST ---
async function extract1080p(masterUrl, proxyHostUrl) {
    // If the sniper already caught the direct 1080p link, just proxy it
    if (masterUrl.includes('1080p')) {
        return `${proxyHostUrl}/proxy?url=${encodeURIComponent(masterUrl)}`;
    }

    // Otherwise, fetch the master playlist and find the 1080p variant
    try {
        const res = await fetch(masterUrl, { headers: { 'Referer': 'https://vidup.to/', 'User-Agent': 'Mozilla/5.0' } });
        const text = await res.text();
        const lines = text.split('\n');
        
        let found1080p = false;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.includes('RESOLUTION=1920x1080') || line.includes('1080p')) {
                found1080p = true;
            } else if (found1080p && line && !line.startsWith('#')) {
                let streamUrl = line.startsWith('http') ? line : masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1) + line;
                console.log("[Extraction SUCCESS] Found 1080p inside master:", streamUrl);
                return `${proxyHostUrl}/proxy?url=${encodeURIComponent(streamUrl)}`;
            }
        }
        
        // Fallback: If no 1080p found, just return the proxied master
        return `${proxyHostUrl}/proxy?url=${encodeURIComponent(masterUrl)}`;
    } catch (e) {
        return `${proxyHostUrl}/proxy?url=${encodeURIComponent(masterUrl)}`;
    }
}

// --- 4. ULTIMATE LIVE STEALTH SCRAPER (1080P HUNTER) ---
async function scrapeVidup(targetUrl) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    let streamUrl = null;

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await page.setRequestInterception(true);
        
        const linkPromise = new Promise((resolve) => {
            let fallbackMaster = null;
            
            page.on('request', (req) => {
                const u = req.url();
                const type = req.resourceType();
                
                // Save RAM on Render by blocking visuals
                if (['image', 'stylesheet', 'font'].includes(type)) {
                    req.abort();
                    return;
                }

                if (u.includes('.m3u8') && !u.includes('.vtt') && !u.includes('blank') && !u.includes('ad')) {
                    if (u.includes('1080p')) {
                        console.log("[Sniper SUCCESS] 1080p directly captured:", u);
                        resolve(u); // Instantly resolve with 1080p link
                    } else if (!fallbackMaster) {
                        fallbackMaster = u; // Save master playlist just in case
                        // Wait 3 seconds to see if a direct 1080p request follows, otherwise resolve with master
                        setTimeout(() => resolve(fallbackMaster), 3000); 
                    }
                }
                req.continue();
            });
        });

        console.log(`[Sniper] Navigating to ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

        // Get viewport size for center-clicking
        const { width, height } = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
        
        // Brute-Force Hardware Clicker: Clicks the center of the screen every 1.5 seconds.
        // This is necessary to bypass the "Getting things ready" screen and initiate the player network requests.
        const clickInterval = setInterval(async () => {
            try { await page.mouse.click(width / 2, height / 2); } catch(e) {}
        }, 1500);

        streamUrl = await Promise.race([
            linkPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 25000))
        ]);

        clearInterval(clickInterval); // Clean up the interval

    } catch (err) {
        console.log("[Sniper Error]", err.message);
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
    
    const rawStreamUrl = await scrapeVidup(targetUrl);
    
    if (rawStreamUrl) {
        const proxyHostUrl = req.protocol + '://' + req.get('host');
        
        // This function guarantees we extract the 1080p URL, or proxy the direct 1080p URL
        const final1080pUrl = await extract1080p(rawStreamUrl, proxyHostUrl);
        
        let streamName = config.nameTemplate || "VidUpPlay";
        streamName = config.emojis ? `🧊 1080p | ${streamName}` : `1080p | ${streamName}`;

        // Return ONLY ONE stream array item: the 1080p stream
        return res.json({ 
            streams: [{
                name: streamName,
                title: `1080p • Pengu.uk Method\n🌐 Source: PeakStorm (Live)`,
                url: final1080pUrl
            }]
        });
    }

    return res.json({ streams: [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Live on port ${PORT}`));
