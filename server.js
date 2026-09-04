const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(cors());

// --- 1. STREMIO MANIFEST ROUTE ---
app.get('/:conf?/manifest.json', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.json({
        id: "org.vidup.proproxy",
        version: "1.0.0",
        name: "VidUp Play Sniper",
        description: "Background Sniper for VidUp.to resolving direct HLS streams.",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    });
});

// --- 2. THE BACKGROUND SNIPER (Equivalent to your Java WebViewClient) ---
async function snipeVidupSource(type, tmdbId, season, episode) {
    const targetUrl = type === 'movie' 
        ? `https://vidup.to/movie/${tmdbId}`
        : `https://vidup.to/tv/${tmdbId}/${season}/${episode}`;

    console.log(`[Sniper] Target Acquired: ${targetUrl}`);
    let browser = null;

    try {
        // Launch headless browser optimized for Serverless / Render.com
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
        
        // Optimize load speed (Equivalent to ws.setBlockNetworkImage(true))
        await page.setRequestInterception(true);

        return await new Promise((resolve) => {
            // Failsafe timeout (15 Seconds)
            const timeout = setTimeout(async () => {
                console.log('[Sniper] Timeout reached. Source not found.');
                if (browser) await browser.close();
                resolve(null);
            }, 15000);

            // Network Sniffer (Your exact 1DM Logic from Java)
            page.on('request', async (request) => {
                const reqUrl = request.url();
                const resourceType = request.resourceType();

                // Block heavy files to speed up the scraping
                if (['image', 'stylesheet', 'font'].includes(resourceType)) {
                    request.abort();
                    return;
                }

                // Strictly filter for the raw video source
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

            // Auto-clicker injection (Equivalent to your onPageFinished Java execution)
            page.on('load', async () => {
                try {
                    await page.evaluate(() => {
                        const clickInterval = setInterval(() => {
                            const v = document.querySelector('video');
                            if (v) v.play();
                            const b = document.querySelector('.play-button, .jw-icon-display, .vjs-big-play-button, #player, .btn-play');
                            if (b) b.click();
                        }, 1000);
                        setTimeout(() => clearInterval(clickInterval), 13000);
                    });
                } catch (err) {}
            });

            // Set Referer & User-Agent
            page.setExtraHTTPHeaders({ 'Referer': 'https://vidup.to/' });
            page.setUserAgent('Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36');

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

// --- 3. STREMIO STREAM GENERATION ROUTE ---
app.get('/:conf?/stream/:type/:id.json', async (req, res) => {
    try {
        const type = req.params.type; 
        const idParam = req.params.id; 

        let tmdbId, season, episode;

        if (type === 'series') {
            const parts = idParam.split(':');
            tmdbId = parts[1] || parts[0]; 
            season = parts[2];
            episode = parts[3];
        } else {
            tmdbId = idParam.replace('tmdb:', '');
        }

        console.log(`[Addon] Fetching stream for ${type} - TMDB: ${tmdbId}`);

        // Trigger the background sniper
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
                            // This guarantees Stremio attaches the Referer you requested!
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
