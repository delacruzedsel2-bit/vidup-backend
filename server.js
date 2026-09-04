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
        id: "org.vidup.tester",
        version: "8.0.0",
        name: config.name || "VidUpPlay",
        description: "Troubleshooting Mode: Hardcoded PeakStorm Links.",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    });
});

// --- 2. TROUBLESHOOTING STREAM ROUTE ---
app.get(['/stream/:type/:id.json', '/:config/stream/:type/:id.json'], async (req, res) => {
    let config = { nameTemplate: "VidUpPlay", descTemplate: "{stream.resolution} • HLS • PeakStorm", emojis: true };
    if (req.params.config) {
        try { config = { ...config, ...JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8')) }; } catch(e) {}
    }

    console.log(`[Test Mode] Pushing hardcoded streams for Stremio to test...`);

    // The exact base URL you provided
    const baseUrl = "https://moon.peakstorm.top/vd/cng4NGhGMUdadUNjVTV3VS1RWW45QTpUNGFkVGpaS3dlai1GYVU0endjS01WaGJQZGt2bk9mV01rb1F3dF9OdElV/sd/19/";

    // 1DM-style qualities and file sizes
    const qualities = [
        { res: "1080p", file: "index-s1080p-v1-a1.m3u8", size: "3.49 GB", emoji: "🧊", bitrate: "6.2 Mbps" },
        { res: "720p", file: "index-s720p-v1-a1.m3u8", size: "1.77 GB", emoji: "🍿", bitrate: "3.1 Mbps" },
        { res: "480p", file: "index-s480p-v1-a1.m3u8", size: "769 MB", emoji: "📺", bitrate: "1.2 Mbps" }
    ];

    const stremioStreams = qualities.map(q => {
        let streamName = config.nameTemplate || "VidUpPlay";
        let streamDesc = config.descTemplate || "{stream.resolution} • HLS • PeakStorm";

        if (config.emojis) {
            streamName = `${q.emoji} ${q.res} | ${streamName}`;
        } else {
            streamName = `${q.res} | ${streamName}`;
        }

        streamDesc = streamDesc
            .replace('{stream.resolution}', q.res)
            .replace('{addon.name}', config.nameTemplate || "VidUpPlay") + `\n💾 ${q.size} • ${q.bitrate}`;

        return {
            name: streamName,
            title: streamDesc,
            url: baseUrl + q.file,
            // THE MOST IMPORTANT PART: STREMIO PROXY HEADERS
            // This forces Stremio's internal player to bypass the 403 block natively
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
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[Server] Test Mode Live on port ${PORT}`));
