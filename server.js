const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(cors());

// --- 1. HELPER: CONVERT IMDB TO TMDB IN REAL-TIME ---
async function getTmdbId(id) {
    // If it's already a TMDB ID (numbers only or prefixed), return it
    if (!id.startsWith('tt')) return id.replace('tmdb:', '');
    
    try {
        // Utilizing the TMDB API key extracted from your Java App
        const tmdbKey = 'bc2f6b6e59025240f97d2c70de61d88a';
        const res = await fetch(`https://api.themoviedb.org/3/find/${id}?api_key=${tmdbKey}&external_source=imdb_id`);
        const data = await res.json();
        
        if (data.movie_results && data.movie_results.length > 0) return data.movie_results[0].id;
        if (data.tv_results && data.tv_results.length > 0) return data.tv_results[0].id;
    } catch (e) {
        console.error("[Converter] TMDB Fetch Error:", e);
    }
    return null;
}

// --- 2. STREMIO MANIFEST ROUTE ---
app.get('/:conf?/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json({
        id: "org.vidup.proproxy",
        version: "1.0.1",
        name: "VidUp Play Sniper",
        description: "Background Sniper for VidUp.to resolving direct HLS streams.",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    });
});

// --- 3. THE BACKGROUND SNIPER ---
async function snipeVidupSource(type, tmdbId, season, episode) {
    const targetUrl = type === 'movie' 
        ? `https://vidup.to/movie/${tmdbId}`
        : `https://vidup.to/tv/${tmdbId}/${season}/${episode}`;

    console.log(`[Sniper] Target Acquired: ${targetUrl}`);
    let browser = null;

    try {
        browser = await puppeteer.launch({
            headless: chromium.headless,
            executablePath: await chromium.executablePath(),
            args: [
                ...chromium.args,
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--single-process'
            ],
            defaultViewport: chromium.defaultViewport
        });

        const page = await browser.newPage();
        
        // Block heavy resources to speed up scraping and prevent Render RAM spikes
        await page.setRequestInterception(true);

        return await new Promise((resolve) => {
            // Failsafe timeout (15 Seconds)
            const timeout = setTimeout(async () => {
                console.log('[Sniper] Timeout reached. Source not found.');
                if (browser) await browser.close();
                resolve(null);
            }, 15000);

            // Network Sniffer
            page.on('request', async (request) => {
                const reqUrl = request.url();
                const resourceType = request.resourceType();

                if (['image', 'stylesheet', 'font'].includes(resourceType)) {
                    request.abort();
                    return;
                }

                // Strict Video Link Filter (Includes your Java .mpd/.m3u8 exclusions)
                if (
                    (reqUrl.includes('.m3u8') || reqUrl.includes('.mpd') || (reqUrl.includes('.mp4') && !reqUrl.includes('seg-') && !reqUrl.includes('segment') && !reqUrl.includes('frag'))) &&
                    !reqUrl.includes('.m4s') && !reqUrl.includes('ad') && !reqUrl.includes('tracking') && !reqUrl.includes('blank') && !reqUrl.includes('favicon') && !reqUrl.includes('.vtt') && !reqUrl.includes('/subs/')
                ) {
                    console.log(`[Sniper] SOURCE GRABBED! -> ${reqUrl}`);
                    clearTimeout(timeout);
                    if (browser) await browser.close();
                    resolve(reqUrl);
                    return;
                }
                request.continue();
            });

            // Auto-clicker injection to simulate real user interaction
            page.on('load', async () => {
                try {
                    await page.evaluate(() => {
                        const clickInterval = setInterval(() => {
                            const v = document.querySelector('video');
                            if (v) v.play().catch(() => {});
                            const b = document.querySelector('.play-button, .jw-icon-display, .vjs-big-play-button, #player, .btn-play');
                            if (b) b.click();
                            document.body.click(); // Fallback trigger
                        }, 1000);
                        setTimeout(() => clearInterval(clickInterval), 13000);
                    });
                } catch (err) {}
            });

            // Set Referer & User-Agent
            page.setExtraHTTPHeaders({ 'Referer': 'https://vidup.to/' });
            page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

            page.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(() => {
                clearTimeout(timeout);
                if (browser) browser.close();
                resolve(null);
            });
        });
    } catch (e) {
        console.error("[Sniper] Error initializing browser:", e);
        if (browser) await browser.close();
        return null;
    }
}

// --- 4. STREMIO STREAM GENERATION ROUTE ---
app.get('/:conf?/stream/:type/:id.json', async (req, res) => {
    try {
        const type = req.params.type; 
        const idParam = req.params.id; 

        let rawId, season, episode;

        // FIXED PARAMETER PARSING
        if (type === 'series') {
            const parts = idParam.split(':'); // Stremio format: tt1234567:1:2
            rawId = parts[0]; 
            season = parts[1];
            episode = parts[2];
        } else {
            rawId = idParam;
        }

        // FETCH TMDB ID
        const tmdbId = await getTmdbId(rawId);

        if (!tmdbId) {
            console.log(`[Addon] Failed to resolve TMDB ID for ${rawId}`);
            return res.json({ streams: [] });
        }

        console.log(`[Addon] Fetching stream for ${type} - IMDB: ${rawId} -> TMDB: ${tmdbId}`);

        const streamUrl = await snipeVidupSource(type, tmdbId, season, episode);

        if (streamUrl) {
            return res.json({
                streams: [
                    {
                        name: "VidUp",
                        title: `1080p • Direct Stream\n🚀 PeakStorm CDN`,
                        url: streamUrl,
                        behaviorHints: {
                            notWebReady: true,
                            proxyHeaders: {
                                request: {
                                    "Referer": "https://vidup.to/",
                                    "Origin": "https://vidup.to"
                                }
                            }
                        }
                    }
                ]
            });
        } else {
            return res.json({ streams: [] });
        }

    } catch (error) {
        console.error(error);
        return res.json({ streams: [] });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});
