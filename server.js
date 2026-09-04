const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

// --- 1. MANIFEST ROUTE ---
app.get(['/', '/manifest.json', '/:config/manifest.json'], (req, res) => {
    let config = { nameTemplate: "VidUpPlay" };
    if (req.params.config) {
        try { 
            config = JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8')); 
        } catch(e) {
            console.error("Config parsing error:", e.message);
        }
    }
    
    res.setHeader('Content-Type', 'application/json');
    res.json({
        id: "org.vidup.proproxy",
        version: "10.0.0",
        name: config.nameTemplate || "VidUpPlay",
        description: "Lightning Fast Multi-Host Stream Resolver (1080p Focus).",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    });
});

// --- 2. STREAM GENERATION ROUTE ---
app.get(['/stream/:type/:id.json', '/:config/stream/:type/:id.json'], async (req, res) => {
    let config = { nameTemplate: "VidUpPlay", emojis: true };
    if (req.params.config) {
        try { 
            config = { ...config, ...JSON.parse(Buffer.from(req.params.config, 'base64').toString('utf8')) }; 
        } catch(e) {
            console.error("Stream config parsing error:", e.message);
        }
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

    const isMovie = type === 'movie';
    
    // Community aggregator embed players that bypass hoster security rules
    const serverAlphaUrl = isMovie 
        ? `https://vidsrc.to{rawId}` 
        : `https://vidsrc.to{rawId}/${season}/${episode}`;

    const serverBetaUrl = isMovie 
        ? `https://vidsrc.xyz{rawId}` 
        : `https://vidsrc.xyz{rawId}/${season}/${episode}`;

    // Return the stream response securely to the Stremio App interface
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

// --- 3. START SERVER ---
const port = process.env.PORT || 7000;
app.listen(port, () => console.log(`Server listening natively on port ${port}`));
