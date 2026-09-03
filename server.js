const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());

// Your specific TMDB API key from your Android App
const TMDB_API_KEY = "bc2f6b6e59025240f97d2c70de61d88a"; 

// 1. Serve the Stremio Manifest
app.get('/manifest.json', (req, res) => {
    res.json({
        id: "org.vidup.puppeteer",
        version: "1.0.1",
        name: "VidUpPlay",
        description: "Scrapes VidUp using a hidden browser interceptor.",
        resources: ["stream"],
        types: ["movie", "series"],
        idPrefixes: ["tt", "tmdb:"],
        catalogs: []
    });
});

// Helper Function: Convert Stremio's IMDb ID into VidUp's required TMDB ID
async function getTmdbId(imdbId, type) {
    // If it's already a TMDB ID, just return it
    if (!imdbId.startsWith('tt')) return imdbId.replace('tmdb:', ''); 
    
    try {
        const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
        const response = await fetch(url);
        const data = await response.json();
        
        if (type === 'movie' && data.movie_results && data.movie_results.length > 0) {
            return data.movie_results[0].id;
        } else if (type === 'series' && data.tv_results && data.tv_results.length > 0) {
            return data.tv_results[0].id;
        }
    } catch (e) {
        console.error("TMDB Conversion failed:", e);
    }
    return null;
}

// 2. Handle Stream Requests from Stremio
app.get('/stream/:type/:id.json', async (req, res) => {
    const { type, id } = req.params;
    
    let imdbId, season, episode;
    if (type === 'movie') {
        imdbId = id;
    } else {
        // Handle TV Show formats like "tt1234567:1:1"
        const parts = id.split(':');
        imdbId = parts[0];
        season = parts[1];
        episode = parts[2];
    }

    // Step 1: Convert the ID!
    const tmdbId = await getTmdbId(imdbId, type);
    
    // If TMDB conversion fails, exit early
    if (!tmdbId) {
        return res.json({ streams: [] });
    }

    // Step 2: Build the correct VidUp URL
    const targetUrl = type === 'movie' 
        ? `https://vidup.to/movie/${tmdbId}` 
        : `https://vidup.to/tv/${tmdbId}/${season}/${episode}`;

    try {
        // Step 3: Run the scraper
        const streams = await scrapeVideo(targetUrl);
        res.json({ streams: streams });
    } catch (error) {
        console.log("Scrape error:", error);
        res.json({ streams: [] });
    }
});

// 3. The Puppeteer Interceptor (Works exactly like your Android WebView)
async function scrapeVideo(url) {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    let extractedUrl = null;

    // Enable network sniffing
    await page.setRequestInterception(true);

    page.on('request', (request) => {
        const reqUrl = request.url();
        // Catch the .m3u8 video stream but ignore text/subtitle/ad tracks
        if ((reqUrl.includes('.m3u8') || reqUrl.includes('.mp4')) && 
            !reqUrl.includes('.vtt') && 
            !reqUrl.includes('ad') && 
            !reqUrl.includes('blank')) {
            extractedUrl = reqUrl;
        }
        request.continue();
    });

    // Go to the VidUp page
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 15000 });
    
    // CRITICAL: Inject a JavaScript auto-clicker to force the video to load and reveal the link!
    await page.evaluate(() => {
        const clickInterval = setInterval(function() {
            const v = document.querySelector('video'); 
            if(v) v.play();
            const b = document.querySelector('.play-button, .jw-icon-display, .vjs-big-play-button, #player, .btn-play');
            if(b) b.click();
        }, 1000);
        setTimeout(() => clearInterval(clickInterval), 7000);
    });

    // Wait 7 seconds for the page to decrypt and the network to catch the m3u8
    await new Promise(r => setTimeout(r, 7000)); 
    
    await browser.close();

    if (extractedUrl) {
        // Add your sh_provider tag for native player compatibility
        const finalUrl = extractedUrl + (extractedUrl.includes("?") ? "&" : "?") + "sh_provider=vidup";
        return [{
            name: "VidUpPlay",
            title: "1080p • Auto Extracted",
            url: finalUrl
        }];
    }
    
    return [];
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
