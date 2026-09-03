const express = require('express');
const cors = require('cors');

// --- PROFESSIONAL ANTI-BOT STEALTH ---
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const app = express();
app.use(cors());

const TMDB_API_KEY = "bc2f6b6e59025240f97d2c70de61d88a";

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
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--window-size=1280,720'
            ]
        });
    }
    return globalBrowser;
}

getBrowser().catch(err => console.error("[Engine] Browser launch error:", err));

// --- MANIFEST ROUTE ---
function createManifest(config) {
    const addonName = config.name || "VidUpPlay";
    return {
        id: "org.vidup.sniper",
        version: "5.0.0",
        name: addonName,
        description: "Stealth multi-quality scraper with Cloudflare bypass.",
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

// --- TMDB CONVERTER ---
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

// --- MASTER PLAYLIST PARSER ---
async function parseMasterPlaylist(masterUrl) {
    if (!masterUrl.includes('.m3u8')) return [{ quality: 'Auto', url: masterUrl, size: '' }];
    
    try {
        const res = await fetch(masterUrl, {
            headers: {
                'Referer': 'https://vidup.to/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            }
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
                
                if (resMatch) {
                    currentQuality = resMatch[1] + 'p';
                    if (currentQuality === '2160p') currentQuality = '4K';
                }
                if (bwMatch) currentBandwidth = parseInt(bwMatch[1]);
                
            } else if (line && !line.startsWith('#') && currentQuality) {
                let streamUrl = line;
                if (!streamUrl.startsWith('http')) {
                    const baseUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1);
                    streamUrl = baseUrl + line;
                }
                
                let sizeStr = "";
                if (currentBandwidth) {
                    const sizeMB = (currentBandwidth * 7200) / 8388608; 
                    if (sizeMB > 1000) sizeStr = `${(sizeMB/1024).toFixed(2)} GB`;
                    else sizeStr = `${sizeMB.toFixed(0)} MB`;
                }

                streams.push({ quality: currentQuality, url: streamUrl, size: sizeStr });
                currentQuality = null;
                currentBandwidth = null;
            }
        }
        return streams.length > 0 ? streams : [{ quality: 'Auto', url: masterUrl, size: '' }];
    } catch (e) {
        return [{ quality: 'Auto', url: masterUrl, size: '' }];
    }
}

// --- LIVE SCRAPER (STEALTH SNIPER) ---
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
                    console.log("[Sniper] SUCCESS! Caught Stream:", u);
                    resolve(u);
                }
                req.continue();
            });
        });

        // Load page and let Stealth plugin handle Cloudflare
        page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 0 }).catch(() => {});

        // Smart Auto-clicker: Waits for Cloudflare to vanish before clicking
        page.evaluateOnNewDocument(() => {
            document.addEventListener("DOMContentLoaded", () => {
                const timer = setInterval(() => {
                    // Check if CF challenge is blocking the page
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

        // Race condition extended to 8.5s to allow CF challenge to pass
        streamUrl = await Promise.race([
            linkPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8500))
        ]);
    } catch (err) {
        console.log("[Sniper] Extraction failed:", err.message);
    } finally {
        await page.close().catch(() => {});
    }
    return streamUrl;
}

// --- STREAM ROUTE ---
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
    
    // SNIPE THE FRESH LINK
    const rawStreamUrl = await scrapeVidup(targetUrl);

    if (rawStreamUrl) {
        const parsedStreams = await parseMasterPlaylist(rawStreamUrl);
        
        const stremioStreams = parsedStreams.map(stream => {
            const resTag = stream.quality;
            const sizeStr = stream.size ? `\n💾 ${stream.size}` : "";
            
            let streamName = config.nameTemplate || "VidUpPlay";
            let streamDesc = config.descTemplate || "{stream.resolution} • HLS • PeakStorm";

            if (config.emojis) {
                const emojiMap = { "4K": "❄️ 4K", "1080p": "🧊 1080p", "720p": "🍿 720p", "480p": "📺 480p" };
                streamName = (emojiMap[resTag] || `🍿 ${resTag}`) + " | " + streamName;
            }

            streamDesc = streamDesc
                .replace('{stream.resolution}', resTag)
                .replace('{addon.name}', config.nameTemplate || "VidUpPlay") + sizeStr;

            return {
                name: streamName,
                title: streamDesc,
                url: stream.url,
                // INJECTS PENGU-STYLE HEADERS
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
app.listen(PORT, () => console.log(`[Server] Live on port ${PORT}`));
