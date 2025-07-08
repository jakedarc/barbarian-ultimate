const express = require('express');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from public directory
app.use(express.static('public'));

// CORS headers for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Proxy endpoint for videos.json
app.get('/api/videos', async (req, res) => {
  try {
    console.log('Fetching videos from barbarian.men...');
    const response = await fetch('https://barbarian.men/macaw45/videos.json');
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }
    
    const data = await response.json();
    console.log(`Successfully fetched ${Object.keys(data).length} videos`);
    
    // Add cache headers
    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.json(data);
  } catch (error) {
    console.error('Error fetching videos:', error);
    res.status(500).json({ 
      error: 'Failed to fetch videos',
      message: error.message 
    });
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

// Proxy endpoint for video files (in case of CORS issues)
app.get('/api/video/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    console.log(`Raw videoId parameter: "${videoId}"`);
    
    // Clean the videoId - remove any 'v' prefix and '.mp4' suffix
    let cleanVideoId = videoId;
    if (cleanVideoId.startsWith('v')) {
      cleanVideoId = cleanVideoId.substring(1);
    }
    if (cleanVideoId.endsWith('.mp4')) {
      cleanVideoId = cleanVideoId.replace('.mp4', '');
    }
    
    const url = `https://barbarian.men/macaw45/videos/v${cleanVideoId}.m3u8`;
    
    console.log(`Cleaned videoId: "${cleanVideoId}"`);
    console.log(`Fetching video: ${url}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error(`Video fetch failed: HTTP ${response.status} for ${url}`);
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
    
    console.log(`Successfully fetched and modified M3U8 for video: ${cleanVideoId}`);
    
    // Set appropriate headers for M3U8
    res.set('Content-Type', 'application/x-mpegURL');
    res.set('Cache-Control', 'public, max-age=300'); // 5 minutes
    res.set('Access-Control-Allow-Origin', '*');
    
    res.send(modifiedContent);
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).send('Error fetching video');
  }
});

// Proxy endpoint for MP4 files (for byte-range requests)
app.get('/api/mp4/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const url = `https://barbarian.men/macaw45/videos/${filename}`;
    
    console.log(`Fetching MP4: ${url}`);
    console.log(`Range header: ${req.headers.range || 'none'}`);
    
    const headers = {};
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      console.error(`MP4 fetch failed: HTTP ${response.status} for ${url}`);
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
    console.error('Error fetching MP4:', error);
    res.status(500).send('Error fetching MP4');
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

// Start server
app.listen(PORT, () => {
  console.log(`🎮 Macaw45 VOD Archive running on http://localhost:${PORT}`);
  console.log(`📁 Serving static files from ./public/`);
  console.log(`🔗 API endpoint: http://localhost:${PORT}/api/videos`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  process.exit(0);
});