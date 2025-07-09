const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

const METADATA_FILE = path.join(__dirname, 'video-metadata.json');

// Serve static files from public directory
app.use(express.static('public'));

// CORS headers for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Load existing metadata
async function loadMetadata() {
  try {
    const data = await fs.readFile(METADATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.log('No existing metadata file, starting fresh');
    return {};
  }
}

// Save metadata
async function saveMetadata(metadata) {
  await fs.writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2));
}

// Function to parse M3U8 duration
async function getVideoDuration(videoId) {
  try {
    console.log(`Fetching duration for video ${videoId}...`);
    const m3u8Response = await fetch(`https://barbarian.men/macaw45/videos/v${videoId}.m3u8`);
    
    if (!m3u8Response.ok) {
      console.error(`Failed to fetch M3U8 for ${videoId}: HTTP ${m3u8Response.status}`);
      return null;
    }
    
    const m3u8Content = await m3u8Response.text();
    
    // Parse total duration from M3U8
    let totalDuration = 0;
    const lines = m3u8Content.split('\n');
    
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
        // Extract duration from #EXTINF:duration,
        const match = line.match(/#EXTINF:([0-9.]+),/);
        if (match) {
          const duration = parseFloat(match[1]);
          totalDuration += duration;
        }
      }
    }
    
    const roundedDuration = Math.round(totalDuration);
    console.log(`Duration for ${videoId}: ${roundedDuration}s (${Math.floor(roundedDuration/3600)}:${Math.floor((roundedDuration%3600)/60).toString().padStart(2,'0')}:${(roundedDuration%60).toString().padStart(2,'0')})`);
    return roundedDuration;
  } catch (error) {
    console.error(`Failed to get duration for ${videoId}:`, error);
    return null;
  }
}

// Sync with remote and update local metadata
async function syncMetadata() {
  try {
    console.log('🔄 Syncing video metadata...');
    const localMetadata = await loadMetadata();
    
    // Fetch remote video list
    const response = await fetch('https://barbarian.men/macaw45/videos.json');
    const remoteVideos = await response.json();
    
    console.log(`Remote videos structure:`, Object.keys(remoteVideos).slice(0, 3));
    console.log(`Sample remote video:`, Object.entries(remoteVideos)[0]);
    
    let updated = false;
    let newVideoCount = 0;
    
    for (const [indexKey, videoData] of Object.entries(remoteVideos)) {
      // Use the actual vodid from the video data, not the index key
      const actualVodId = videoData.vodid || indexKey;
      
      if (!localMetadata[indexKey]) {
        console.log(`📹 New video found: Index ${indexKey}, VOD ID ${actualVodId} - ${videoData.title}`);
        
        // Get duration for new video using the actual VOD ID
        const duration = await getVideoDuration(actualVodId);
        
        localMetadata[indexKey] = {
          vodid: actualVodId, // Use the actual Twitch VOD ID
          title: videoData.title,
          description: videoData.description,
          date: videoData.date,
          duration,
          lastUpdated: new Date().toISOString()
        };
        
        updated = true;
        newVideoCount++;
      }
    }
    
    if (updated) {
      await saveMetadata(localMetadata);
      console.log(`✅ Metadata updated: ${newVideoCount} new videos added`);
    } else {
      console.log('ℹ️ No new videos found');
    }
    
    console.log(`Local metadata now has ${Object.keys(localMetadata).length} videos`);
    return localMetadata;
  } catch (error) {
    console.error('❌ Error syncing metadata:', error);
    return await loadMetadata(); // Fall back to existing data
  }
}

// Serve from local metadata (convert to array format for frontend)
app.get('/api/videos', async (req, res) => {
  try {
    const metadata = await loadMetadata();
    
    // Convert object to array format that frontend expects
    const videosArray = Object.values(metadata);
    
    console.log(`📤 Serving ${videosArray.length} videos from local metadata`);
    res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.json(videosArray);
  } catch (error) {
    console.error('❌ Error serving videos:', error);
    res.status(500).json({ error: 'Failed to load videos' });
  }
});

// Proxy endpoint for thumbnails
app.get('/api/thumbnail/:size/:videoId', async (req, res) => {
  try {
    const { size, videoId } = req.params;
    const url = `https://barbarian.men/macaw45/tn/${size}/${videoId}.webp`;
    
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(404).send('Thumbnail not found');
    }
    
    // Set appropriate headers
    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'public, max-age=86400'); // 24 hours
    
    response.body.pipe(res);
  } catch (error) {
    console.error('Error fetching thumbnail:', error);
    res.status(500).send('Error fetching thumbnail');
  }
});

// Proxy endpoint for video files
app.get('/api/video/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    
    // Clean the videoId - remove any 'v' prefix and '.mp4' suffix
    let cleanVideoId = videoId;
    if (cleanVideoId.startsWith('v')) {
      cleanVideoId = cleanVideoId.substring(1);
    }
    if (cleanVideoId.endsWith('.mp4')) {
      cleanVideoId = cleanVideoId.replace('.mp4', '');
    }
    
    const url = `https://barbarian.men/macaw45/videos/v${cleanVideoId}.m3u8`;
    
    console.log(`📺 Loading video playlist: ${cleanVideoId}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error(`❌ Video fetch failed: HTTP ${response.status} for ${url}`);
      return res.status(404).send('Video not found');
    }
    
    // Get the M3U8 content as text
    const m3u8Content = await response.text();
    
    // Convert relative URLs to absolute URLs, but route MP4s through our proxy
    const modifiedContent = m3u8Content.replace(
      /^(?!https?:\/\/|#)(.+\.ts)$/gm,
      `https://barbarian.men/macaw45/videos/$1`
    ).replace(
      /URI="([^"]+\.mp4)"/g,
      `URI="/api/mp4/$1"`
    ).replace(
      /^(?!https?:\/\/|#)(.+\.mp4)$/gm,
      `/api/mp4/$1`
    );
    
    // Set appropriate headers for M3U8
    res.set('Content-Type', 'application/x-mpegURL');
    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.set('Access-Control-Allow-Origin', '*');
    
    res.send(modifiedContent);
  } catch (error) {
    console.error('❌ Error fetching video:', error);
    res.status(500).send('Error fetching video');
  }
});

// Proxy endpoint for MP4 files (for byte-range requests)
app.get('/api/mp4/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const url = `https://barbarian.men/macaw45/videos/${filename}`;
    
    // Only log errors or first request for each file
    const isFirstRequest = !req.headers.range || req.headers.range === 'bytes=0-';
    if (isFirstRequest) {
      console.log(`🎬 Starting MP4 stream: ${filename}`);
    }
    
    const headers = {};
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      console.error(`❌ MP4 fetch failed: HTTP ${response.status} for ${filename}`);
      return res.status(404).send('MP4 not found');
    }
    
    // Copy relevant headers
    if (response.headers.get('content-range')) {
      res.set('Content-Range', response.headers.get('content-range'));
    }
    if (response.headers.get('accept-ranges')) {
      res.set('Accept-Ranges', response.headers.get('accept-ranges'));
    }
    
    res.set('Content-Type', 'video/mp4');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=3600');
    
    // Set status code
    res.status(response.status);
    
    response.body.pipe(res);
  } catch (error) {
    console.error('❌ Error fetching MP4:', error);
    res.status(500).send('Error fetching MP4');
  }
});

// Manual sync endpoint (for debugging)
app.get('/api/sync', async (req, res) => {
  try {
    console.log('🔄 Manual sync triggered');
    await syncMetadata();
    res.json({ message: 'Sync completed' });
  } catch (error) {
    console.error('❌ Manual sync failed:', error);
    res.status(500).json({ error: 'Sync failed' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Serve the main HTML file for any non-API route
app.get('*', (req, res) => {
  // Skip API routes
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// Initialize metadata on startup
async function startup() {
  console.log('🚀 Starting VOD Archive server...');
  
  // Initial sync
  await syncMetadata();
  
  // Set up periodic sync (every hour)
  setInterval(syncMetadata, 60 * 60 * 1000);
  console.log('⏰ Scheduled hourly metadata sync');
  
  app.listen(PORT, () => {
    console.log(`🌐 Server running on http://localhost:${PORT}`);
  });
}

startup().catch(console.error);