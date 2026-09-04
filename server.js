const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const TMDB_API_KEY = "bc2f6b6e59025240f97d2c70de61d88a";

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
        description: "Lightning Fast VidUp Proxy & Live Scraper (1080p Focus).",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    });
});

// --- 1. THE PENGU LOCAL PROXY REWRITER ---
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

                // Audio/Subtitle Playlists
                if (trimmed.startsWith('#EXT-X-MEDIA') && trimmed.includes('URI="')) {
                    return trimmed.replace(/URI="([^"]+)"/, (match, uri) => {
                        const fullUrl = uri.startsWith('http') ? uri : baseUrl + uri;
                        return `URI="${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(fullUrl)}"`;
                    });
                }
                
                if (trimmed.startsWith('#')) return line;
                
                const fullUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
                
                // Sub-Playlists (.m3u8)
                if (fullUrl.includes('.m3u8')) {
                    return `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(fullUrl)}`;
                } else {
                    // ACTUAL CHUNKS (.ts / .mp4): Route through STREMIO's LOCAL PROXY
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

// --- 2. FAST HTML REGEX SCRAPER (NO PUPPETEER) ---
async function scrapeVidupFast(targetUrl) {
    try {
        console.log(`[Fast Scraper] Fetching HTML for ${targetUrl}`);
        
        const response = await fetch(targetUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
                "Referer": "https://vidup.to/"
            },
            // 15 second timeout for standard fetch
            signal: AbortSignal.timeout(15000) 
        });

        const html = await response.text();

        // Regex looks for the CDN m3u8 link directly embedded in the source code
        const linkRegex = /(https:\/\/[^\s"'<>]+\.m3u8)/i;
        const match = html.match(linkRegex);

        if (match && match[1]) {
            let masterUrl = match[1];
            console.log("[Fast Scraper SUCCESS] Found Master URL:", masterUrl);
            
            // Force it to 1080p if it's pointing to the master playlist
            if (masterUrl.includes('master.m3u8')) {
                masterUrl = masterUrl.replace('master.m3u8', 'index-s1080p-v1-a1.m3u8');
            } else if (!masterUrl.includes('1080p')) {
                // If it's a different index file, manually append the 1080p naming convention
                masterUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1) + 'index-s1080p-v1-a1.m3u8';
            }
            
            console.log("[Fast Scraper] Converted 1080p URL:", masterUrl);
            return masterUrl;
        } else {
            console.log("[Fast Scraper Failed] No .m3u8 link found in HTML.");
        }
    } catch (e) {
        console.error("[Fast Scraper Error]", e.message);
    }
    return null;
}

// --- 3. STREAM GENERATION ROUTE ---
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
    
    // Call the new lightning-fast regex scraper
    const rawStreamUrl = await scrapeVidupFast(targetUrl);
    
    if (rawStreamUrl) {
        const proxyHostUrl = req.protocol + '://' + req.get('host');
        
        // Pass the forced 1080p playlist to the proxy
        const proxiedUrl = `${proxyHostUrl}/proxy?url=${encodeURIComponent(rawStreamUrl)}`;
        
        let streamName = config.nameTemplate || "VidUpPlay";
        streamName = config.emojis ? `🧊 1080p | ${streamName}` : `1080p | ${streamName}`;

        return res.json({ 
            streams: [{
                name: streamName,
                title: `1080p • Pengu.uk Method\n🌐 Source: PeakStorm (Fast Scrape)`,
                url: proxiedUrl
            }] 
        });
    }

    return res.json({ streams: [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Live on port ${PORT}`));
