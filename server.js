const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors()); // Allows Stremio to connect

// 1. Serve the Stremio Manifest
app.get('/manifest.json', (req, res) => {
    res.json({
        id: "org.vidup.puppeteer",
        version: "1.0.0",
        name: "VidUp Play",
        description: "Scrapes VidUp using a hidden browser interceptor.",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    });
});

// 2. Handle Stream Requests from Stremio
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    
    let tmdbId, season, episode;
    if (type === 'movie') {
        tmdbId = id.replace('tmdb:', '');
    } else {
        const parts = id.replace('tmdb:', '').split(':');
        tmdbId = parts[0];
        season = parts[1];
        episode = parts[2];
    }

    const targetUrl = type === 'movie' 
        ? `https://vidup.to/movie/${tmdbId}` 
        : `https://vidup.to/tv/${tmdbId}/${season}/${episode}`;

    try {
        const streams = await scrapeVideo(targetUrl);
        res.json({ streams: streams });
    } catch (error) {
        console.log(error);
        res.json({ streams: [] });
    }
});

// 3. The Interceptor (Just like Android WebView!)
async function scrapeVideo(url) {
    // Open a hidden browser
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    let extractedUrl = null;

    await page.setRequestInterception(true);

    // Intercept network traffic looking for the video file
    page.on('request', (request) => {
        const reqUrl = request.url();
        if ((reqUrl.includes('.m3u8') || reqUrl.includes('.mp4')) && !reqUrl.includes('ad') && !reqUrl.includes('blank')) {
            extractedUrl = reqUrl;
        }
        request.continue();
    });

    // Go to VidUp and wait for the encrypted JS to do its magic
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(r => setTimeout(r, 5000)); // Wait 5 seconds for the video link to generate
    
    await browser.close();

    if (extractedUrl) {
        // Tag the URL so your Stremio player knows how to handle it
        const finalUrl = extractedUrl + (extractedUrl.includes("?") ? "&" : "?") + "sh_provider=vidup";
        return [{
            name: "VidUp",
            title: "Auto-Scraped Stream",
            url: finalUrl
        }];
    }
    return [];
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
      
