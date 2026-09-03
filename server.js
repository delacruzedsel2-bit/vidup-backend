const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());

// Your specific TMDB API key
const TMDB_API_KEY = "bc2f6b6e59025240f97d2c70de61d88a";

// Base manifest template
const getManifest = (configParams) => {
    return {
        id: "org.vidup.sniper",
        version: "2.0.0",
        name: configParams.name || "VidUpPlay",
        description: "High-speed headless scraper with custom formatting.",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    };
};

// 1. Handle Configuration Route (Used by your Frontend Settings page)
app.get(['/:config/manifest.json', '/manifest.json'], (req, res) => {
    try {
        if (req.params.config) {
            const configStr = Buffer.from(req.params.config, 'base64').toString('utf8');
            return res.json(getManifest(JSON.parse(configStr)));
        }
    } catch(e) {}
    res.json(getManifest({ name: "VidUpPlay" }));
});

// Helper: Convert IMDb to TMDB
async function getTmdbId(imdbId, type) {
    if (!imdbId.startsWith('tt')) return imdbId.replace('tmdb:', ''); 
    try {
        const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (type === 'movie' && data.movie_results.length > 0) return data.movie_results[0].id;
        if (type === 'series' && data.tv_results.length > 0) return data.tv_results[0].id;
    } catch (e) { console.error("TMDB error:", e); }
    return null;
}

// 2. Handle Streams
app.get(['/stream/:type/:id.json', '/:config/stream/:type/:id.json'], async (req, res) => {
    // Extract User Preferences
    let configParams = { name: "VidUpPlay", emojis: true };
    try {
        if (req.params.config) {
            const configStr = Buffer.from(req.params.config, 'base64').toString('utf8');
            configParams = JSON.parse(configStr);
        }
    } catch(e) {}

    const { type, id } = req.params;
    let imdbId = id, season, episode;
    
    if (type === 'series') {
        const parts = id.split(':');
        imdbId = parts[0]; season = parts[1]; episode = parts[2];
    }

    const tmdbId = await getTmdbId(imdbId, type);
    if (!tmdbId) return res.json({ streams: [] });

    const targetUrl = type === 'movie' 
        ? `https://vidup.to/movie/${tmdbId}` 
        : `https://vidup.to/tv/${tmdbId}/${season}/${episode}`;

    try {
        // Run the Sniper!
        const extractedUrl = await snipeVideo(targetUrl);
        
        if (extractedUrl) {
            // APPLY CUSTOM FORMATTING BASED ON URL (e.g. seg-1-s2160p-v1.mp4)
            let resolution = "HD";
            if (extractedUrl.includes('2160p') || extractedUrl.includes('4k')) resolution = "4K";
            else if (extractedUrl.includes('1080p')) resolution = "1080p";
            else if (extractedUrl.includes('720p')) resolution = "720p";
            else if (extractedUrl.includes('480p')) resolution = "480p";

            let streamName = configParams.name || "VidUpPlay";
            let titleStr = "";
            
            // Emoji Parsing
            if (configParams.emojis) {
                if (resolution === "4K") titleStr = "❄️ 4K | " + streamName;
                else if (resolution === "1080p") titleStr = "🧊 1080p | " + streamName;
                else titleStr = "🍿 " + resolution + " | " + streamName;
            } else {
                titleStr = resolution + " | " + streamName;
            }

            const finalUrl = extractedUrl + (extractedUrl.includes("?") ? "&" : "?") + "sh_provider=vidup";
            
            return res.json({
                streams: [{
                    name: streamName,
                    title: titleStr,
                    url: finalUrl
                }]
            });
        }
    } catch (e) { console.log(e); }
    res.json({ streams: [] });
});

// 3. The "SNIPER" Scraper Logic (Optimized for Speed)
async function snipeVideo(url) {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--blink-settings=imagesEnabled=false' // CRITICAL: Blocks heavy images for instant loading
        ]
    });
    
    const page = await browser.newPage();
    await page.setRequestInterception(true);

    // Create a promise that triggers the exact millisecond the video link is spotted
    const streamPromise = new Promise((resolve) => {
        page.on('request', (req) => {
            const reqUrl = req.url();
            // Block all CSS, Tracking, and Fonts to prevent Stremio Timeouts
            if (['image', 'stylesheet', 'font'].includes(req.resourceType())) {
                req.abort();
            } else {
                // Snipe the link!
                if ((reqUrl.includes('.m3u8') || reqUrl.includes('.mp4')) && 
                    !reqUrl.includes('.vtt') && !reqUrl.includes('ad') && !reqUrl.includes('blank')) {
                    resolve(reqUrl);
                }
                req.continue();
            }
        });
    });

    try {
        // Only wait for DOM, not the whole network
        page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
        
        // Aggressively inject the clicker right as the page starts
        page.evaluateOnNewDocument(() => {
            document.addEventListener("DOMContentLoaded", () => {
                const interval = setInterval(() => {
                    const v = document.querySelector('video'); if(v) v.play().catch(()=>{});
                    const b = document.querySelector('.play-button, .jw-icon-display, .vjs-big-play-button, #player');
                    if(b) b.click();
                }, 300);
                setTimeout(() => clearInterval(interval), 5000);
            });
        });

        // Race Condition: Snatch the link before a 7 second timeout occurs
        const finalUrl = await Promise.race([
            streamPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 7000))
        ]);
        
        await browser.close();
        return finalUrl;
        
    } catch (err) {
        await browser.close();
        return null;
    }
                     }
