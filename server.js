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

                // 1. Audio/Subtitle Playlists: Route through OUR Render server to rewrite them too
                if (trimmed.startsWith('#EXT-X-MEDIA') && trimmed.includes('URI="')) {
                    return trimmed.replace(/URI="([^"]+)"/, (match, uri) => {
                        const fullUrl = uri.startsWith('http') ? uri : baseUrl + uri;
                        return `URI="${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(fullUrl)}"`;
                    });
                }
                
                if (trimmed.startsWith('#')) return line;
                
                const fullUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
                
                // 2. Video Playlists (.m3u8): Route through OUR Render server to parse qualities
                if (fullUrl.includes('.m3u8')) {
                    return `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(fullUrl)}`;
                } else {
                    // 3. ACTUAL CHUNKS (.ts / .mp4): Route through STREMIO's LOCAL PROXY!
                    // This is how Pengu achieves 0 lag and proper AAC audio.
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

// --- 3. MASTER PLAYLIST PARSER & SIZE CALCULATOR ---
async function parseMasterPlaylist(masterUrl, isMovie, proxyHostUrl) {
    if (!masterUrl.includes('.m3u8')) return [{ quality: 'HD', url: `${proxyHostUrl}/proxy?url=${encodeURIComponent(masterUrl)}`, size: '' }];
    
    try {
        const res = await fetch(masterUrl, { headers: { 'Referer': 'https://vidup.to/', 'User-Agent': 'Mozilla/5.0' } });
        const text = await res.text();
        const streams = [];
        const lines = text.split('\n');
        
        let currentQuality = null, currentBandwidth = null;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('#EXT-X-STREAM-INF')) {
                const resMatch = line.match(/RESOLUTION=\d+x(\d+)/);
                const bwMatch = line.match(/BANDWIDTH=(\d+)/);
                if (resMatch) currentQuality = (resMatch[1] === '2160' ? '4K' : resMatch[1] + 'p');
                if (bwMatch) currentBandwidth = parseInt(bwMatch[1]);
            } else if (line && !line.startsWith('#') && currentQuality) {
                let streamUrl = line.startsWith('http') ? line : masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1) + line;
                
                let sizeStr = "";
                if (currentBandwidth) {
                    const durationSec = isMovie ? 7200 : 2700; 
                    const sizeMB = (currentBandwidth * durationSec) / 8388608; 
                    sizeStr = sizeMB > 1000 ? `${(sizeMB/1024).toFixed(2)} GB` : `${sizeMB.toFixed(0)} MB`;
                }

                // Give Stremio the URL to OUR Render Proxy, which will then rewrite it
                const proxiedUrl = `${proxyHostUrl}/proxy?url=${encodeURIComponent(streamUrl)}`;
                streams.push({ quality: currentQuality, url: proxiedUrl, size: sizeStr, bitrate: `${(currentBandwidth/1000000).toFixed(1)} Mbps` });
                currentQuality = null; currentBandwidth = null;
            }
        }
        return streams.length > 0 ? streams : [{ quality: 'Auto', url: `${proxyHostUrl}/proxy?url=${encodeURIComponent(masterUrl)}`, size: '' }];
    } catch (e) {
        return [{ quality: 'Auto', url: `${proxyHostUrl}/proxy?url=${encodeURIComponent(masterUrl)}`, size: '' }];
    }
}

// --- 4. ULTIMATE LIVE STEALTH SCRAPER (THE SNIPER) ---
async function scrapeVidup(targetUrl) {
    const browser = await getBrowser();
    const page = await browser.newPage();
    let streamUrl = null;
    let isResolved = false; 

    try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        
        await page.setRequestInterception(true);
        const linkPromise = new Promise((resolve) => {
            page.on('request', (req) => {
                const u = req.url();
                const type = req.resourceType();
                
                // 1. Abort heavy resources to speed up page load and reduce timeout risk
                if (['image', 'font', 'stylesheet'].includes(type)) {
                    req.abort();
                    return;
                }

                if ((u.includes('.m3u8') || u.includes('.mp4')) && !u.includes('.vtt') && !u.includes('blank') && !u.includes('ad')) {
                    console.log("[Sniper SUCCESS] Live link captured:", u);
                    isResolved = true;
                    resolve(u);
                }
                req.continue();
            });
        });

        // Load the page
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

        // 2. Native Puppeteer Interaction Routine
        const interactWithPage = async () => {
            await new Promise(r => setTimeout(r, 1500)); // Wait for initial "Getting things ready..." loader
            
            for (let i = 0; i < 8; i++) { // Poll continuously until the link is found or timeout hits
                if (isResolved || page.isClosed()) break;
                
                try {
                    // Send a trusted hardware-level click to the center of the viewport
                    const viewport = page.viewport();
                    if (viewport) {
                        await page.mouse.click(viewport.width / 2, viewport.height / 2);
                    }

                    // 3. Iterate through all frames to catch nested players or Turnstile
                    for (const frame of page.frames()) {
                        
                        // Defeat Turnstile natively
                        if (frame.url().includes('cloudflare') || frame.url().includes('turnstile')) {
                            const cfIframe = await page.$('iframe[src*="cloudflare"], iframe[src*="turnstile"]');
                            if (cfIframe) {
                                const box = await cfIframe.boundingBox();
                                if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
                            }
                        }

                        // Fallback: Try to trigger video play via JS in each isolated frame context
                        try {
                            await frame.evaluate(() => {
                                const v = document.querySelector('video');
                                if (v) v.play().catch(() => {});
                            });
                        } catch (e) {} 
                    }
                } catch (e) {}
                
                await new Promise(r => setTimeout(r, 2500)); // Wait between interaction attempts
            }
        };

        // Run interaction asynchronously alongside the listener
        interactWithPage();

        // 25-second limit to grab the link
        streamUrl = await Promise.race([
            linkPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 25000))
        ]);

    } catch (err) {
        console.log("[Sniper Timeout]", err.message);
    } finally {
        isResolved = true;
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
    
    // LIVE SCRAPING ONLY - NO HARDCODED LINKS
    const rawStreamUrl = await scrapeVidup(targetUrl);
    
    if (rawStreamUrl) {
        const proxyHostUrl = req.protocol + '://' + req.get('host');
        const parsedStreams = await parseMasterPlaylist(rawStreamUrl, type === 'movie', proxyHostUrl);
        
        const stremioStreams = parsedStreams.map(stream => {
            const resTag = stream.quality;
            const sizeStr = stream.size ? `\n💾 ${stream.size} • ${stream.bitrate || 'HLS'}` : "";
            let streamName = config.nameTemplate || "VidUpPlay";

            if (config.emojis) {
                const emojiMap = { "4K": "❄️ 4K", "1080p": "🧊 1080p", "720p": "🍿 720p", "480p": "📺 480p" };
                streamName = (emojiMap[resTag] || `🍿 ${resTag}`) + " | " + streamName;
            } else streamName = `${resTag} | ${streamName}`;

            return {
                name: streamName,
                title: `${resTag} • Pengu.uk Method\n🌐 Source: PeakStorm (Live)` + sizeStr,
                url: stream.url
            };
        });

        return res.json({ streams: stremioStreams });
    }

    return res.json({ streams: [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Live on port ${PORT}`));
