const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// --- 1. MANIFEST ROUTE ---
app.get(['/', '/manifest.json', '/:config/manifest.json'], (req, res) => {
    let config = { name: "VidUpPlay" };
    if (req.params.config) {
        try { config = JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8')); } catch(e) {}
    }
    res.setHeader('Content-Type', 'application/json');
    res.json({
        id: "org.vidup.proxy",
        version: "9.0.0",
        name: config.name || "VidUpPlay",
        description: "Professional HLS Proxy Mode for PeakStorm Streams.",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    });
});

// --- 2. THE PROFESSIONAL HLS PROXY ---
// This is the "Pengu Method". It forces every .ts chunk request to include the Referer header.
app.get('/proxy', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).send("No URL provided");

    try {
        const response = await fetch(targetUrl, {
            headers: {
                "Referer": "https://vidup.to/",
                "Origin": "https://moon.peakstorm.top",
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            }
        });

        // Pass along the correct content type (m3u8 or ts)
        const contentType = response.headers.get('content-type') || 'application/vnd.apple.mpegurl';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Access-Control-Allow-Origin', '*');

        if (targetUrl.includes('.m3u8')) {
            // Rewrite the playlist so Stremio requests chunks through this proxy
            const text = await response.text();
            const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
            
            const rewritten = text.split('\n').map(line => {
                const trimmed = line.trim();
                if (trimmed.startsWith('#') || trimmed === '') return line;
                const fullUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
                return `${req.protocol}://${req.get('host')}/proxy?url=${encodeURIComponent(fullUrl)}`;
            }).join('\n');
            
            return res.send(rewritten);
        } else {
            // Stream the actual .ts video chunk
            const arrayBuffer = await response.arrayBuffer();
            return res.send(Buffer.from(arrayBuffer));
        }
    } catch (e) {
        console.error("[Proxy Error]", e);
        res.status(500).send("Proxy error");
    }
});

// --- 3. STREAM ROUTE ---
app.get(['/stream/:type/:id.json', '/:config/stream/:type/:id.json'], async (req, res) => {
    let config = { nameTemplate: "VidUpPlay", emojis: true };
    if (req.params.config) {
        try { config = { ...config, ...JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8')) }; } catch(e) {}
    }

    console.log(`[Test Mode] Pushing Proxied Streams...`);

    const rawBaseUrl = "https://moon.peakstorm.top/vd/cng4NGhGMUdadUNjVTV3VS1RWW45QTpUNGFkVGpaS3dlai1GYVU0endjS01WaGJQZGt2bk9mV01rb1F3dF9OdElV/sd/19/";
    
    // We proxy the URL so Stremio routes it through our Express server above
    const proxyHost = `${req.protocol}://${req.get('host')}/proxy?url=`;

    const qualities = [
        { res: "1080p", file: "index-s1080p-v1-a1.m3u8", size: "3.49 GB", emoji: "🧊", bitrate: "6.2 Mbps" },
        { res: "720p", file: "index-s720p-v1-a1.m3u8", size: "1.77 GB", emoji: "🍿", bitrate: "3.1 Mbps" },
        { res: "480p", file: "index-s480p-v1-a1.m3u8", size: "769 MB", emoji: "📺", bitrate: "1.2 Mbps" }
    ];

    const stremioStreams = qualities.map(q => {
        let streamName = config.nameTemplate || "VidUpPlay";
        streamName = config.emojis ? `${q.emoji} ${q.res} | ${streamName}` : `${q.res} | ${streamName}`;

        const rawM3u8Url = rawBaseUrl + q.file;
        const proxiedUrl = proxyHost + encodeURIComponent(rawM3u8Url);

        return {
            name: streamName,
            title: `${q.res} • HLS Proxied\n💾 ${q.size} • ${q.bitrate}\n🌐 Source: PeakStorm`,
            url: proxiedUrl // Send Stremio the Proxied URL, not the raw one
        };
    });

    return res.json({ streams: stremioStreams });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] HLS Proxy Live on port ${PORT}`));
