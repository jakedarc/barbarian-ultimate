const express = require('express');
const path = require('path');
const fetch = require('node-fetch');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

const METADATA_FILE = path.join(__dirname, 'video-metadata.json');

// Emote mapping storage
let firstPartyEmotes = {};
let thirdPartyEmotes = {};

app.use(express.static('public'));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Load emote mappings on startup
async function loadEmoteMappings() {
  try {
    console.log('Loading emote mappings...');
    
    const [firstPartyResponse, thirdPartyResponse, cheersResponse] = await Promise.all([
      fetch('https://barbarian.men/macaw45/first_party_emotes.json'),
      fetch('https://barbarian.men/macaw45/third_party_emotes.json'),
      fetch('https://barbarian.men/macaw45/cheers.json')
    ]);
    
    if (firstPartyResponse.ok) {
      firstPartyEmotes = await firstPartyResponse.json();
      console.log(`Loaded ${Object.keys(firstPartyEmotes).length} first-party emotes`);
    }
    
    if (thirdPartyResponse.ok) {
      thirdPartyEmotes = await thirdPartyResponse.json();
      console.log(`Loaded ${Object.keys(thirdPartyEmotes).length} third-party emotes`);
    }
    
    if (cheersResponse.ok) {
      const cheers = await cheersResponse.json();
      // Store cheers data in the global variable for the server endpoints
      global.cheersData = cheers;
      console.log(`Loaded ${Object.keys(cheers).length} cheer providers`);
    }
  } catch (error) {
    console.error('Failed to load emote mappings:', error);
  }
}

async function loadMetadata() {
  try {
    const data = await fs.readFile(METADATA_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.log('No existing metadata file, starting fresh');
    return {};
  }
}

async function saveMetadata(metadata) {
  await fs.writeFile(METADATA_FILE, JSON.stringify(metadata, null, 2));
}

async function getVideoDuration(videoId) {
  try {
    console.log(`Fetching duration for video ${videoId}...`);
    const m3u8Response = await fetch(`https://barbarian.men/macaw45/videos/v${videoId}.m3u8`);
    
    if (!m3u8Response.ok) {
      console.error(`Failed to fetch M3U8 for ${videoId}: HTTP ${m3u8Response.status}`);
      return null;
    }
    
    const m3u8Content = await m3u8Response.text();
    
    let totalDuration = 0;
    const lines = m3u8Content.split('\n');
    
    for (const line of lines) {
      if (line.startsWith('#EXTINF:')) {
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

async function syncMetadata() {
  try {
    console.log('Syncing video metadata...');
    const localMetadata = await loadMetadata();
    
    const response = await fetch('https://barbarian.men/macaw45/videos.json');
    const remoteVideos = await response.json();
    
    console.log(`Remote videos structure:`, Object.keys(remoteVideos).slice(0, 3));
    console.log(`Sample remote video:`, Object.entries(remoteVideos)[0]);
    
    let updated = false;
    let newVideoCount = 0;
    
    for (const [indexKey, videoData] of Object.entries(remoteVideos)) {
      const actualVodId = videoData.vodid || indexKey;
      
      if (!localMetadata[indexKey]) {
        console.log(`New video found: Index ${indexKey}, VOD ID ${actualVodId} - ${videoData.title}`);
        
        const duration = await getVideoDuration(actualVodId);
        
        localMetadata[indexKey] = {
          vodid: actualVodId,
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
      console.log(`Metadata updated: ${newVideoCount} new videos added`);
    } else {
      console.log('No new videos found');
    }
    
    console.log(`Local metadata now has ${Object.keys(localMetadata).length} videos`);
    return localMetadata;
  } catch (error) {
    console.error('Error syncing metadata:', error);
    return await loadMetadata();
  }
}

app.get('/api/videos', async (req, res) => {
  try {
    const metadata = await loadMetadata();
    const videosArray = Object.values(metadata);
    
    console.log(`Serving ${videosArray.length} videos from local metadata`);
    res.set('Cache-Control', 'public, max-age=3600');
    res.json(videosArray);
  } catch (error) {
    console.error('Error serving videos:', error);
    res.status(500).json({ error: 'Failed to load videos' });
  }
});

app.get('/api/thumbnail/:size/:videoId', async (req, res) => {
  try {
    const { size, videoId } = req.params;
    const url = `https://barbarian.men/macaw45/tn/${size}/${videoId}.webp`;
    
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(404).send('Thumbnail not found');
    }
    
    res.set('Content-Type', 'image/webp');
    res.set('Cache-Control', 'public, max-age=86400');
    
    response.body.pipe(res);
  } catch (error) {
    console.error('Error fetching thumbnail:', error);
    res.status(500).send('Error fetching thumbnail');
  }
});

app.get('/api/video/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    
    let cleanVideoId = videoId;
    if (cleanVideoId.startsWith('v')) {
      cleanVideoId = cleanVideoId.substring(1);
    }
    if (cleanVideoId.endsWith('.mp4')) {
      cleanVideoId = cleanVideoId.replace('.mp4', '');
    }
    
    const url = `https://barbarian.men/macaw45/videos/v${cleanVideoId}.m3u8`;
    
    console.log(`Loading video playlist: ${cleanVideoId}`);
    const response = await fetch(url);
    
    if (!response.ok) {
      console.error(`Video fetch failed: HTTP ${response.status} for ${url}`);
      return res.status(404).send('Video not found');
    }
    
    const m3u8Content = await response.text();
    
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
    
    res.set('Content-Type', 'application/x-mpegURL');
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Access-Control-Allow-Origin', '*');
    
    res.send(modifiedContent);
  } catch (error) {
    console.error('Error fetching video:', error);
    res.status(500).send('Error fetching video');
  }
});

app.get('/api/mp4/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const url = `https://barbarian.men/macaw45/videos/${filename}`;
    
    const isFirstRequest = !req.headers.range || req.headers.range === 'bytes=0-';
    if (isFirstRequest) {
      console.log(`Starting MP4 stream: ${filename}`);
    }
    
    const headers = {};
    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }
    
    const response = await fetch(url, { headers });
    
    if (!response.ok) {
      console.error(`MP4 fetch failed: HTTP ${response.status} for ${filename}`);
      return res.status(404).send('MP4 not found');
    }
    
    if (response.headers.get('content-range')) {
      res.set('Content-Range', response.headers.get('content-range'));
    }
    if (response.headers.get('accept-ranges')) {
      res.set('Accept-Ranges', response.headers.get('accept-ranges'));
    }
    
    res.set('Content-Type', 'video/mp4');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'public, max-age=3600');
    
    res.status(response.status);
    
    response.body.pipe(res);
  } catch (error) {
    console.error('Error fetching MP4:', error);
    res.status(500).send('Error fetching MP4');
  }
});

// Emote mapping endpoints
app.get('/api/emotes/first-party', async (req, res) => {
  try {
    const response = await fetch('https://barbarian.men/macaw45/first_party_emotes.json');
    if (!response.ok) {
      return res.status(404).json({ error: 'First-party emotes not found' });
    }
    
    const emotes = await response.json();
    res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.json(emotes);
  } catch (error) {
    console.error('Error fetching first-party emotes:', error);
    res.status(500).json({ error: 'Failed to fetch first-party emotes' });
  }
});

app.get('/api/emotes/third-party', async (req, res) => {
  try {
    const response = await fetch('https://barbarian.men/macaw45/third_party_emotes.json');
    if (!response.ok) {
      return res.status(404).json({ error: 'Third-party emotes not found' });
    }
    
    const emotes = await response.json();
    res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.json(emotes);
  } catch (error) {
    console.error('Error fetching third-party emotes:', error);
    res.status(500).json({ error: 'Failed to fetch third-party emotes' });
  }
});

app.get('/api/emotes/cheers', async (req, res) => {
  try {
    const cheers = global.cheersData || {};
    res.set('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.json(cheers);
  } catch (error) {
    console.error('Error serving cheers:', error);
    res.status(500).json({ error: 'Failed to serve cheers' });
  }
});

// Chat API endpoints - proxy to original site's chat data
app.get('/api/chat/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    
    // First check if chat timecodes exist for this video
    const timecodesUrl = `https://barbarian.men/macaw45/comments/${videoId}/timecodes.json`;
    const timecodesResponse = await fetch(timecodesUrl);
    
    if (!timecodesResponse.ok) {
      return res.status(404).json({ error: 'No chat data available' });
    }
    
    const timecodes = await timecodesResponse.json();
    res.json(timecodes);
  } catch (error) {
    console.error('Error fetching chat timecodes:', error);
    res.status(500).json({ error: 'Failed to fetch chat timecodes' });
  }
});

app.get('/api/chat/:videoId/:startTime/:endTime', async (req, res) => {
  try {
    const { videoId, startTime, endTime } = req.params;
    const start = parseInt(startTime);
    const end = parseInt(endTime);
    
    const allMessages = [];
    
    // Fetch chat messages for each second in the range
    for (let t = start; t <= end; t++) {
      try {
        const chatUrl = `https://barbarian.men/macaw45/comments/${videoId}/${t}.json`;
        const response = await fetch(chatUrl);
        
        if (response.ok) {
          const messages = await response.json();
          // Add timestamp to each message for sorting
          messages.forEach(msg => {
            msg.video_timestamp = t;
          });
          allMessages.push(...messages);
        }
      } catch (err) {
        // Skip failed requests for individual seconds
        continue;
      }
    }
    
    // Sort messages by timestamp
    allMessages.sort((a, b) => {
      if (a.video_timestamp !== b.video_timestamp) {
        return a.video_timestamp - b.video_timestamp;
      }
      // If same video timestamp, sort by message timestamp
      return (a.timestamp || 0) - (b.timestamp || 0);
    });
    
    res.json(allMessages);
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    res.status(500).json({ error: 'Failed to fetch chat messages' });
  }
});

// Proxy endpoint for emotes and badges
app.get('/api/emote/:path(*)', async (req, res) => {
  try {
    const emotePath = req.params.path;
    const emoteUrl = `https://barbarian.men/macaw45/emotes/${emotePath}`;
    
    const response = await fetch(emoteUrl);
    if (!response.ok) {
      return res.status(404).send('Emote not found');
    }
    
    const contentType = response.headers.get('content-type');
    if (contentType) {
      res.set('Content-Type', contentType);
    }
    
    res.set('Cache-Control', 'public, max-age=86400');
    response.body.pipe(res);
  } catch (error) {
    console.error('Error proxying emote:', error);
    res.status(500).send('Error fetching emote');
  }
});

// New endpoint for emote name lookups (for text-based emotes like "FeelsDankMan")
app.get('/api/emote/lookup/:emoteName', async (req, res) => {
  try {
    const { emoteName } = req.params;
    
    // Check if it's a third-party emote first (most custom emotes)
    if (thirdPartyEmotes[emoteName]) {
      const emoteId = thirdPartyEmotes[emoteName];
      const emoteUrl = `https://barbarian.men/macaw45/emotes/thirdParty/${emoteId}`;
      const response = await fetch(emoteUrl);
      
      if (response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType) {
          res.set('Content-Type', contentType);
        }
        res.set('Cache-Control', 'public, max-age=86400');
        return response.body.pipe(res);
      }
    }
    
    // Check if it's a first-party emote
    if (firstPartyEmotes[emoteName]) {
      const emoteId = firstPartyEmotes[emoteName];
      const emoteUrl = `https://barbarian.men/macaw45/emotes/firstParty/${emoteId}`;
      const response = await fetch(emoteUrl);
      
      if (response.ok) {
        const contentType = response.headers.get('content-type');
        if (contentType) {
          res.set('Content-Type', contentType);
        }
        res.set('Cache-Control', 'public, max-age=86400');
        return response.body.pipe(res);
      }
    }
    
    return res.status(404).send('Emote not found');
  } catch (error) {
    console.error('Error looking up emote:', error);
    res.status(500).send('Error fetching emote');
  }
});

app.get('/api/sync', async (req, res) => {
  try {
    console.log('Manual sync triggered');
    await syncMetadata();
    await loadEmoteMappings(); // Also refresh emote mappings
    res.json({ message: 'Sync completed - updated metadata and emote mappings' });
  } catch (error) {
    console.error('Manual sync failed:', error);
    res.status(500).json({ error: 'Sync failed' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

async function startup() {
  console.log('Starting VOD Archive server...');
  
  await syncMetadata();
  await loadEmoteMappings(); // Load emote mappings
  
  // Schedule both metadata and emote syncing every hour
  setInterval(async () => {
    await syncMetadata();
    await loadEmoteMappings();
  }, 60 * 60 * 1000);
  console.log('Scheduled hourly metadata and emote sync');
  
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startup().catch(console.error);