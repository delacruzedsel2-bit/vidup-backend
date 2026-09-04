app.get(['/', '/manifest.json', '/:config/manifest.json'], (req, res) => {
    let config = { name: "VidUpPlay" };
    if (req.params.config) {
        try { config = JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8')); } catch(e) {}
    }
    res.setHeader('Content-Type', 'application/json');
    res.json({
        id: "org.vidup.proproxy",
        version: "10.0.0",
        name: config.nameTemplate || config.name || "VidUpPlay",
        description: "Lightning Fast Multi-Host Stream Resolver (1080p Focus).",
        resources: ["stream"], // <--- FIXED: Cannot be empty
        types: ["movie", "series"], // <--- FIXED: Cannot be empty
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    });
});

// --- 1. LOCAL PROXY REWRITER ---
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL provided");

    try {
        const response = await axios.get(targetUrl, {
            headers: {
                "Referer": "https://vidup.to/",
                "Origin": "https://vidup.to",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            },
            responseType: targetUrl.includes('.m3u8') ? 'text' : 'arraybuffer'
        });

        res.setHeader('Access-Control-Allow-Origin', '*');

        if (targetUrl.includes('.m3u8')) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            const text = response.data;
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
            res.setHeader('Content-Type', response.headers['content-type'] || 'application/octet-stream');
            return res.send(Buffer.from(response.data));
        }
    } catch (e) {
        console.error("[Proxy Error]", e.message);
        res.status(500).send("Proxy error");
    }
});

// --- 2. FAST HTML REGEX SCRAPER ---
async function scrapeVidupFast(targetUrl) {
    try {
        console.log(`[Fast Scraper] Fetching HTML for ${targetUrl}`);
        
        const response = await axios.get(targetUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Referer": "https://vidup.to/"
            },
            timeout: 15000
        });

        let html = response.data;
        let linkRegex = /(https:\/\/[^\s"'<>]+\.m3u8)/i;
        let match = html.match(linkRegex);

        if (!match) {
            console.log("[Fast Scraper] Link hidden. Hunting for player iframe...");
            const iframeRegex = /<iframe[^>]+src="([^"]+)"/i;
            const iframeMatch = html.match(iframeRegex);
            
            if (iframeMatch && iframeMatch[1]) {
                let iframeUrl = iframeMatch[1];
                if (iframeUrl.startsWith('//')) iframeUrl = 'https:' + iframeUrl;
                else if (iframeUrl.startsWith('/')) iframeUrl = 'https://vidup.to' + iframeUrl;
                
                console.log(`[Fast Scraper] Piercing Iframe: ${iframeUrl}`);
                const iframeRes = await axios.get(iframeUrl, {
                    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Referer": targetUrl }
                });
                html = iframeRes.data;
                match = html.match(linkRegex);
            }
        }

        if (match && match[1]) {
            let masterUrl = match[1];
            console.log("[Fast Scraper SUCCESS] Found Master URL:", masterUrl);
            
            if (masterUrl.includes('master.m3u8')) {
                masterUrl = masterUrl.replace('master.m3u8', 'index-s1080p-v1-a1.m3u8');
            } else if (!masterUrl.includes('1080p')) {
                masterUrl = masterUrl.substring(0, masterUrl.lastIndexOf('/') + 1) + 'index-s1080p-v1-a1.m3u8';
            }
            
            return masterUrl;
        } else {
            console.log("[Fast Scraper Failed] No .m3u8 link found in HTML or Iframes.");
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
    let rawId = id.replace('.json', ''); 
    let season = 1; 
    let episode = 1;
    
    // Accurately separate IMDB IDs for series (e.g., tt123456:1:1)
    if (type === 'series') {
        const parts = rawId.split(':');
        rawId = parts[0]; 
        season = parts[1] || 1; 
        episode = parts[2] || 1;
    }

    // Instantly generate the verified community aggregator routes
    const isMovie = type === 'movie';
    const serverAlphaUrl = isMovie 
        ? `https://vidsrc.to{rawId}` 
        : `https://vidsrc.to{rawId}/${season}/${episode}`;

    const serverBetaUrl = isMovie 
        ? `https://vidsrc.xyz{rawId}` 
        : `https://vidsrc.xyz{rawId}&season=${season}&episode=${episode}`;

    // Return the response object to Stremio
    return res.json({
        streams: [
            {
                title: `${config.emojis ? '⚡ ' : ''}${config.nameTemplate}\n[Server Alpha] - Auto 1080p`,
                externalUrl: serverAlphaUrl
            },
            {
                title: `${config.emojis ? '📀 ' : ''}${config.nameTemplate}\n[Server Beta] - Multi-Quality`,
                externalUrl: serverBetaUrl
            }
        ]
    });
});

    // Constructing the targeted vidup page format 
    // Modify this base URL structure to point directly to your preferred video hub provider format
    const searchSlug = encodeURIComponent(title.toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    const targetVidupUrl = type === 'movie' 
        ? `https://vidup.to{searchSlug}.html` 
        : `https://vidup.to{searchSlug}-s${season}e${episode}.html`;

    const m3u8Link = await scrapeVidupFast(targetVidupUrl);

    if (m3u8Link) {
        // Wrap found link inside your own proxy path to attach headers dynamically
        const proxyStreamUrl = `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(m3u8Link)}`;
        
        return res.json({
            streams: [{
                title: `${config.emojis ? '⚡ ' : ''}${config.nameTemplate}\n1080p - Direct Stream`,
                url: proxyStreamUrl
            }]
        });
    }

    return res.json({ streams: [] });
});

const port = process.env.PORT || 7000;
app.listen(port, () => console.log(`Server listening on port ${port}`));
