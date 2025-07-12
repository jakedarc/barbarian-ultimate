# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

- `npm start` or `npm run dev` - Start the development server on port 3000
- `node server.js` - Direct server execution

## Project Overview

This is a Node.js/Express VOD (Video on Demand) archive application for Macaw45 Twitch streams. The application serves as a proxy and cache for video content hosted at barbarian.men.

### Architecture

**Backend (server.js)**
- Express server with CORS enabled
- Fetches and caches video metadata from remote JSON API
- Proxies video streams (M3U8/HLS) and thumbnails
- Manages chat replay data and emote mappings
- Hourly sync process for metadata and emote updates
- Video duration calculation from M3U8 playlists

**Frontend (public/)**
- Single-page application with Video.js player
- Real-time chat replay synchronized with video playback
- Advanced filtering and pagination system
- Video position saving/resuming functionality
- Responsive design with mobile support

**Key Components:**
- Video streaming via HLS (HTTP Live Streaming)
- Twitch chat replay with emote support (first-party, third-party, cheers/bits)
- Thumbnail proxy with WebP format
- Local video metadata caching in JSON file
- URL-based video sharing with timestamps

### API Endpoints

- `/api/videos` - Video metadata listing
- `/api/video/:videoId` - HLS stream proxy
- `/api/thumbnail/:size/:videoId` - Thumbnail proxy
- `/api/chat/:videoId` - Chat timecodes
- `/api/chat/:videoId/:startTime/:endTime` - Chat messages for time range
- `/api/emotes/*` - Emote and badge proxying
- `/api/sync` - Manual metadata/emote sync trigger

### Data Sources

The application proxies content from barbarian.men/macaw45/:
- Video streams and playlists
- Thumbnails and metadata
- Chat data and emote mappings
- Twitch badges and cheers/bits data

### File Structure

- `server.js` - Main Express application
- `public/index.html` - Single page application shell
- `public/player.js` - Frontend JavaScript application (VODArchive class)
- `public/player.css` - Styling and responsive design
- `video-metadata.json` - Cached video metadata (auto-generated)
- `package.json` - Dependencies: express, node-fetch

### Development Notes

- No build process required - runs directly with Node.js
- Uses Video.js library for HLS video playback
- localStorage for video position persistence
- Responsive breakpoints for mobile/desktop layouts