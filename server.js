const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { pipeline } = require('stream');
const { Readable } = require('stream');

puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());

const TMDB_API_KEY = "bc2f6b6e59025240f97d2c70de61d88a";
const TEST_LINK = "https://moon.peakstorm.top/vd/cng4NGhGMUdadUNjVTV3VS1RWW45QTpUNGFkVGpaS3dlai1GYVU0endjS01WaGJQZGt2bk9mV01rb1F3dF9OdElV/sd/19/index-s1080p-v1-a1.m3u8";

// --- 1. ROBUST BROWSER ENGINE ---
let globalBrowser = null;
async function getBrowser() {
    if (!globalBrowser || !globalBrowser.isConnected()) {
        console.log("[Engine] Launching Stealth Chromium...");
        globalBrowser = await puppeteer.launch({
            headless: "new",
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
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
        id: "org.vidup.proxy",
        version: "6.0.0",
        name: config.name || "VidUpPlay",
        description: "Professional Proxy Scraper (Bypasses Header Blocks)",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    });
});

// --- 3. THE PROFESSIONAL M3U8 PROXY (Like Pengu) ---
// This guarantees the video plays because Render injects the Referer for every chunk!
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL");

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
            
            // Rewrite all sub-playlists and .ts chunks to run through THIS proxy
            const rewritten = text.split('\n').map(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('#') || trimmed === '') return line;
                const fullUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
                return `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(fullUrl)}`;
            }).join('\n');
            
            return res.send(rewritten);
        } else {
            // It is a video chunk (.ts / .mp4), stream it directly to Stremio
            if (response.body) {
                pipeline(Readable.fromWeb(response.body), res, (err) => { if (err) console.error(err); });
            } else {
                res.end();
            }
        }
    } catch (e) {
        res.status(500).send(e.message);
    }
});

// --- 4. DYNAMIC SIZE CALCULATOR ---
async function parseMasterPlaylist(masterUrl, isMovie, proxyHostUrl) {
    // If it's a direct .mp4, wrap it in proxy and skip size calc
    if (!masterUrl.includes('.m3u8')) return [{ quality: 'Auto', url: `${proxyHostUrl}/proxy?url=${encodeURIComponent(masterUrl)}`, size: '' }];
    
    try {
        const res = await fetch(masterUrl, { headers: { 'Referer': 'https://vidup.to/', 'User-Agent': 'Mozilla/5.0' } });
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
                let streamUrl = line.startsWith('http') ? line : masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1) + line;
                
                // Real Size Calculation based on Bandwidth (like 1DM does)
                let sizeStr = "";
                if (currentBandwidth) {
                    const durationSec = isMovie ? 7200 : 2700; // Est 120m for movie, 45m for series
                    const sizeMB = (currentBandwidth * durationSec) / 8388608; 
                    sizeStr = sizeMB > 1000 ? `${(sizeMB/1024).toFixed(2)} GB` : `${sizeMB.toFixed(0)} MB`;
                }

                // Wrap URL in the proxy so it bypasses header blocks
                const proxiedUrl = `${proxyHostUrl}/proxy?url=${encodeURIComponent(streamUrl)}`;
                streams.push({ quality: currentQuality, url: proxiedUrl, size: sizeStr });
                currentQuality = null; currentBandwidth = null;
            }
        }
        return streams.length > 0 ? streams : [{ quality: 'Auto', url: `${proxyHostUrl}/proxy?url=${encodeURIComponent(masterUrl)}`, size: '' }];
    } catch (e) {
        return [{ quality: 'Auto', url: `${proxyHostUrl}/proxy?url=${encodeURIComponent(masterUrl)}`, size: '' }];
    }
}

// --- 5. LIVE STEALTH SCRAPER ---
async function scrapeVidup(targetUrl) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    let streamUrl = null;

    try {
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

        // Massive timeout increase so Render's free CPU can process Cloudflare Turnstile
        page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

        page.evaluateOnNewDocument(() => {
            document.addEventListener("DOMContentLoaded", () => {
                const timer = setInterval(() => {
                    const btn = document.querySelector('.play-button, .jw-icon-display, .vjs-big-play-button');
                    if (btn) btn.click();
                    const v = document.querySelector('video');
                    if (v) v.play().catch(() => {});
                }, 1000);
            });
        });

        // 25-Second scrape allowance
        streamUrl = await Promise.race([
            linkPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 25000))
        ]);
    } catch (err) {
        console.log("[Sniper Failed]", err.message);
    } finally {
        await page.close().catch(() => {});
    }
    return streamUrl;
}

// --- 6. STREAM GENERATION ROUTE ---
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

    // Convert TMDB
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
    
    // Scrape with 25s window. If it fails, fallback to your test link.
    const rawStreamUrl = await scrapeVidup(targetUrl) || TEST_LINK;
    
    const proxyHostUrl = req.protocol + '://' + req.get('host');
    const parsedStreams = await parseMasterPlaylist(rawStreamUrl, type === 'movie', proxyHostUrl);
    
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
            title: `${resTag} • Proxied Stream\n🌐 PeakStorm Engine` + sizeStr,
            url: stream.url
        };
    });

    return res.json({ streams: stremioStreams });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Live on port ${PORT}`));
