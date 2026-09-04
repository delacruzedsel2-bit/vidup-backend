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
                '--disable-web-security',
                '--mute-audio' // Required to allow auto-play policies in background
            ]
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
        description: "Ultimate Pengu-Style Stremio Proxy & Live Scraper.",
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

                // 1. Audio/Subtitle Playlists
                if (trimmed.startsWith('#EXT-X-MEDIA') && trimmed.includes('URI="')) {
                    return trimmed.replace(/URI="([^"]+)"/, (match, uri) => {
                        const fullUrl = uri.startsWith('http') ? uri : baseUrl + uri;
                        return `URI="${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(fullUrl)}"`;
                    });
                }
                
                if (trimmed.startsWith('#')) return line;
                
                const fullUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
                
                // 2. Sub-Playlists (.m3u8)
                if (fullUrl.includes('.m3u8')) {
                    return `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(fullUrl)}`;
                } else {
                    // 3. ACTUAL CHUNKS (.ts / .mp4): Route through STREMIO's LOCAL PROXY
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
            // Fallback for direct media
            const arrayBuf = await response.arrayBuffer();
            return res.send(Buffer.from(arrayBuf));
        }
    } catch (e) {
        console.error("[Proxy Error]", e);
        res.status(500).send("Proxy error");
    }
});

// --- 3. PASSIVE BACKGROUND SNIPER (MOBILE 1080p FOCUS) ---
async function scrapeVidup(targetUrl) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    let streamUrl = null;

    try {
        // MATCH THE VIDEO'S MOBILE ENVIRONMENT EXACTLY
        await page.setUserAgent('Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36');
        await page.setViewport({ width: 393, height: 851, isMobile: true, hasTouch: true });
        
        await page.setRequestInterception(true);
        
        const linkPromise = new Promise((resolve) => {
            page.on('request', (req) => {
                const u = req.url();
                
                // We do NOT block images/css anymore so the preloader finishes naturally.
                // We only block obvious ad-tracking to save RAM.
                if (u.includes('doubleclick') || u.includes('googlesyndication') || u.includes('analytics')) {
                    req.abort();
                    return;
                }

                // Passive check: Grab the specific 1080p playlist URL
                if (u.includes('.m3u8') && u.includes('1080p')) {
                    console.log("[Sniper SUCCESS] 1080p Background link captured:", u);
                    resolve(u);
                }
                
                req.continue();
            });
        });

        // INJECT: Auto-trigger the video player natively via DOM (No mouse hardware clicks)
        await page.evaluateOnNewDocument(() => {
            document.addEventListener("DOMContentLoaded", () => {
                const triggerPlayer = setInterval(() => {
                    // Emulate a standard screen tap in the center where the play button lives
                    const centerEl = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
                    if (centerEl && centerEl.click) centerEl.click();
                    
                    // Force any video tags to initialize network requests
                    document.querySelectorAll('video').forEach(v => {
                        v.muted = true;
                        v.play().catch(() => {});
                    });
                }, 1000);
                
                // Stop tapping after 20 seconds
                setTimeout(() => clearInterval(triggerPlayer), 20000);
            });
        });

        console.log(`[Sniper] Navigating mobile view to ${targetUrl}`);
        page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

        // Wait up to 25 seconds for the network to sniff the 1080p link
        streamUrl = await Promise.race([
            linkPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 25000))
        ]);

    } catch (err) {
        console.log("[Sniper Error]", err.message);
    } finally {
        await page.close().catch(() => {});
    }
    
    return streamUrl;
}

// --- 4. STREAM GENERATION ROUTE ---
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
    
    // Live grab only the 1080p target
    const rawStreamUrl = await scrapeVidup(targetUrl);
    
    if (rawStreamUrl) {
        const proxyHostUrl = req.protocol + '://' + req.get('host');
        
        // Pass the exact 1080p playlist straight to the proxy
        const proxiedUrl = `${proxyHostUrl}/proxy?url=${encodeURIComponent(rawStreamUrl)}`;
        
        let streamName = config.nameTemplate || "VidUpPlay";
        streamName = config.emojis ? `🧊 1080p | ${streamName}` : `1080p | ${streamName}`;

        return res.json({ 
            streams: [{
                name: streamName,
                title: `1080p • Pengu.uk Method\n🌐 Source: PeakStorm (Auto-Sniped)`,
                url: proxiedUrl
            }] 
        });
    }

    return res.json({ streams: [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Live on port ${PORT}`));
