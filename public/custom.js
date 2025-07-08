// Video Position Saving Configuration
const VIDEO_POSITION_CONFIG = {
    saveInterval: 10, // Save position every 10 seconds
    minSaveTime: 30, // Don't save positions for first 30 seconds
    expireDays: 30, // Clear saved positions older than 30 days
    resumeThreshold: 60 // Only resume if more than 60 seconds from start
};

/*
 * Chat System Server Requirements:
 * 
 * The chat functionality expects these API endpoints on the server:
 * 
 * GET /api/chat/:videoId
 * - Returns array of available chat timecodes for the video
 * - Response: [1, 5, 12, 23, ...] (seconds where chat messages exist)
 * 
 * GET /api/chat/:videoId/:startTime/:endTime  
 * - Returns chat messages for the specified time range
 * - Response: [{offset: 123, commenter: {display_name: "User"}, message: {body: "Hello!"}}, ...]
 * 
 * Chat data should be stored as JSON files in a format similar to:
 * comments/{videoId}.json - contains the timecode array
 * comments/{videoId}_messages.json - contains all messages with timestamps
 */

// Clean up old saved positions
function cleanupOldPositions() {
    const now = Date.now();
    const expireTime = VIDEO_POSITION_CONFIG.expireDays * 24 * 60 * 60 * 1000;
    
    Object.keys(localStorage).forEach(key => {
        if (key.startsWith('video_position_')) {
            try {
                const data = JSON.parse(localStorage.getItem(key));
                if (data.timestamp && (now - data.timestamp > expireTime)) {
                    localStorage.removeItem(key);
                }
            } catch (e) {
                localStorage.removeItem(key);
            }
        }
    });
}

// Save video position
function saveVideoPosition(videoId, currentTime, duration) {
    if (currentTime < VIDEO_POSITION_CONFIG.minSaveTime) return;
    if (currentTime > duration - 30) return; // Don't save if near the end
    
    const positionData = {
        time: currentTime,
        duration: duration,
        timestamp: Date.now()
    };
    
    localStorage.setItem(`video_position_${videoId}`, JSON.stringify(positionData));
}

// Get saved video position
function getSavedVideoPosition(videoId) {
    try {
        const data = localStorage.getItem(`video_position_${videoId}`);
        return data ? JSON.parse(data) : null;
    } catch (e) {
        return null;
    }
}

// Clear saved position for a video
function clearVideoPosition(videoId) {
    localStorage.removeItem(`video_position_${videoId}`);
}

// Format time for display
function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// Auto-resume video without prompt
function autoResumeVideo(player, savedTime) {
    console.log(`Setting up auto-resume to ${formatTime(savedTime)}`);
    
    // Wait for user to press play
    const onFirstPlay = () => {
        console.log('User pressed play, now seeking to saved position');
        player.off('play', onFirstPlay);
        
        // Pause immediately to seek
        player.pause();
        
        const onSeeked = () => {
            console.log('Resume seek completed, resuming playback');
            player.isResuming = false;
            player.off('seeked', onSeeked);
            player.play(); // Resume playback after seeking
        };
        
        player.isResuming = true;
        player.on('seeked', onSeeked);
        player.currentTime(savedTime);
    };
    
    player.isResuming = true; // Set flag to prevent other interference
    player.on('play', onFirstPlay);
    console.log('Auto-resume will trigger on first play');
}

class VODArchive {
    constructor() {
        this.videos = [];
        this.filteredVideos = [];
        this.currentPage = 1;
        this.itemsPerPage = 25;
        this.currentVideo = null;
        this.player = null;
        this.saveTimer = null;
        this.hasResumed = false;
        this.shouldResume = false;
        this.startOverBtn = null;
        this.maxCachedItems = 200; // Limit DOM elements in memory
        this.itemAccessTimes = new Map(); // Track when items were last accessed
        
        // Chat-related properties
        this.chatOpen = false;
        this.chatTimecodes = new Set();
        this.lastChatTime = -1;
        this.chatSeekThreshold = 5; // seconds
        
        this.init();
        cleanupOldPositions();
    }

    async init() {
        await this.loadVideos();
        this.setupEventListeners();
        this.filterAndPaginate();
        this.checkURLForVideo();
    }

    async loadVideos() {
        try {
            const response = await fetch('/api/videos');
            const data = await response.json();
            
            console.log('Raw data structure:', Array.isArray(data) ? 'Array' : 'Object');
            console.log('First few items:', data.slice(0, 3));
            
            // The API returns an array, not an object
            this.videos = data.map(video => ({
                id: video.vodid, // Use vodid as the ID
                title: video.title,
                description: video.description,
                date: new Date(video.date)
            })).sort((a, b) => b.date - a.date); // Sort by date, newest first
            
            console.log('Processed videos:', this.videos.slice(0, 3).map(v => ({ id: v.id, title: v.title })));
            
            document.getElementById('loadingState').style.display = 'none';
            document.getElementById('videoGrid').style.display = 'block';
            document.getElementById('bottomPagination').style.display = 'block';
        } catch (error) {
            console.error('Failed to load videos:', error);
            document.getElementById('loadingState').textContent = 'Failed to load videos. Please try again later.';
        }
    }

    setupEventListeners() {
        // Title filter
        document.getElementById('titleFilter').addEventListener('input', () => {
            this.currentPage = 1;
            this.filterAndPaginate();
        });

        // Date filters
        ['fromMonth', 'fromDay', 'fromYear', 'toMonth', 'toDay', 'toYear'].forEach(id => {
            document.getElementById(id).addEventListener('input', () => {
                this.currentPage = 1;
                this.filterAndPaginate();
            });
        });

        // Clear filters
        document.getElementById('clearFilters').addEventListener('click', () => {
            document.getElementById('titleFilter').value = '';
            ['fromMonth', 'fromDay', 'fromYear', 'toMonth', 'toDay', 'toYear'].forEach(id => {
                document.getElementById(id).value = '';
            });
            this.currentPage = 1;
            this.filterAndPaginate();
        });

        // Pagination
        document.getElementById('prevBtn').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.filterAndPaginate();
            }
        });

        document.getElementById('nextBtn').addEventListener('click', () => {
            const totalPages = Math.ceil(this.filteredVideos.length / this.itemsPerPage);
            if (this.currentPage < totalPages) {
                this.currentPage++;
                this.filterAndPaginate();
            }
        });

        document.getElementById('pageInput').addEventListener('change', (e) => {
            const totalPages = Math.ceil(this.filteredVideos.length / this.itemsPerPage);
            const page = Math.max(1, Math.min(totalPages, parseInt(e.target.value) || 1));
            this.currentPage = page;
            this.filterAndPaginate();
        });

        // Items per page
        document.getElementById('itemsPerPage').addEventListener('change', (e) => {
            this.itemsPerPage = parseInt(e.target.value);
            document.getElementById('bottomItemsPerPage').value = e.target.value;
            this.currentPage = 1;
            this.filterAndPaginate();
        });

        document.getElementById('bottomItemsPerPage').addEventListener('change', (e) => {
            this.itemsPerPage = parseInt(e.target.value);
            document.getElementById('itemsPerPage').value = e.target.value;
            this.currentPage = 1;
            this.filterAndPaginate();
            this.scrollToTop();
        });

        // Bottom pagination with scroll to top
        document.getElementById('bottomPrevBtn').addEventListener('click', () => {
            if (this.currentPage > 1) {
                this.currentPage--;
                this.filterAndPaginate();
                this.scrollToTop();
            }
        });

        document.getElementById('bottomNextBtn').addEventListener('click', () => {
            const totalPages = Math.ceil(this.filteredVideos.length / this.itemsPerPage);
            if (this.currentPage < totalPages) {
                this.currentPage++;
                this.filterAndPaginate();
                this.scrollToTop();
            }
        });

        document.getElementById('bottomPageInput').addEventListener('change', (e) => {
            const totalPages = Math.ceil(this.filteredVideos.length / this.itemsPerPage);
            const page = Math.max(1, Math.min(totalPages, parseInt(e.target.value) || 1));
            this.currentPage = page;
            this.filterAndPaginate();
            this.scrollToTop();
        });

        // Chat toggle
        document.getElementById('chatToggle').addEventListener('click', () => {
            this.toggleChat();
        });
        
        // Chat close
        document.getElementById('chatClose').addEventListener('click', () => {
            this.closeChat();
        });
    }

    scrollToTop() {
        document.querySelector('.filters-section').scrollIntoView({ 
            behavior: 'smooth',
            block: 'start'
        });
    }

    filterVideos() {
        const titleFilter = document.getElementById('titleFilter').value.toLowerCase();
        const fromMonth = document.getElementById('fromMonth').value;
        const fromDay = document.getElementById('fromDay').value;
        const fromYear = document.getElementById('fromYear').value;
        const toMonth = document.getElementById('toMonth').value;
        const toDay = document.getElementById('toDay').value;
        const toYear = document.getElementById('toYear').value;

        let fromDate = null;
        let toDate = null;

        if (fromMonth && fromDay && fromYear) {
            fromDate = new Date(fromYear, fromMonth - 1, fromDay);
        }

        if (toMonth && toDay && toYear) {
            toDate = new Date(toYear, toMonth - 1, toDay);
            toDate.setHours(23, 59, 59, 999); // End of day
        }

        this.filteredVideos = this.videos.filter(video => {
            // Title filter
            if (titleFilter && !video.title.toLowerCase().includes(titleFilter)) {
                return false;
            }

            // Date range filter
            if (fromDate && video.date < fromDate) {
                return false;
            }
            if (toDate && video.date > toDate) {
                return false;
            }

            return true;
        });
    }

    filterAndPaginate() {
        this.filterVideos();
        this.updatePagination();
        this.renderVideos();
    }

    updatePagination() {
        const totalPages = Math.ceil(this.filteredVideos.length / this.itemsPerPage);
        
        // Update top pagination
        document.getElementById('pageInput').value = this.currentPage;
        document.getElementById('pageInput').max = totalPages;
        document.getElementById('pageInfo').textContent = `of ${totalPages} (${this.filteredVideos.length} videos)`;
        document.getElementById('prevBtn').disabled = this.currentPage <= 1;
        document.getElementById('nextBtn').disabled = this.currentPage >= totalPages;
        
        // Update bottom pagination
        document.getElementById('bottomPageInput').value = this.currentPage;
        document.getElementById('bottomPageInput').max = totalPages;
        document.getElementById('bottomPageInfo').textContent = `of ${totalPages} (${this.filteredVideos.length} videos)`;
        document.getElementById('bottomPrevBtn').disabled = this.currentPage <= 1;
        document.getElementById('bottomNextBtn').disabled = this.currentPage >= totalPages;
    }

    renderVideos() {
        const grid = document.getElementById('videoGrid');
        const startIndex = (this.currentPage - 1) * this.itemsPerPage;
        const endIndex = startIndex + this.itemsPerPage;
        const videosToShow = this.filteredVideos.slice(startIndex, endIndex);

        // Only rebuild if grid is empty or we have a completely different set of videos
        const existingItems = grid.querySelectorAll('.video-item');
        const shouldRebuild = existingItems.length === 0;

        if (shouldRebuild) {
            console.log('Rebuilding video grid');
            this.buildVideoGrid(grid, videosToShow);
        } else {
            console.log('Updating existing video grid');
            this.updateVideoGrid(grid, videosToShow);
        }
    }

    buildVideoGrid(grid, videosToShow) {
        grid.innerHTML = videosToShow.map(video => {
            const savedPosition = getSavedVideoPosition(video.id);
            const hasResume = savedPosition && savedPosition.time > VIDEO_POSITION_CONFIG.resumeThreshold;
            
            return `
                <div class="video-item" data-video-id="${video.id}" onclick="archive.loadVideo('${video.id}')">
                    <div class="video-thumbnail-container">
                        <img class="video-thumbnail" 
                             src="/api/thumbnail/72/${video.id}" 
                             alt="${video.title}"
                             loading="lazy"
                             onerror="this.style.background='#333'; this.style.color='#666'; this.style.display='flex'; this.style.alignItems='center'; this.style.justifyContent='center'; this.innerHTML='No Image';">
                        ${hasResume ? `<div class="resume-overlay">⏸ ${formatTime(savedPosition.time)}</div>` : ''}
                    </div>
                    <div class="video-info">
                        <div class="video-item-title">${video.title}</div>
                        <div class="video-item-date">${video.date.toLocaleDateString('en-US', { 
                            year: 'numeric', 
                            month: 'long', 
                            day: 'numeric' 
                        })}</div>
                    </div>
                </div>
            `;
        }).join('');
    }

    updateVideoGrid(grid, videosToShow) {
        const existingItems = Array.from(grid.querySelectorAll('.video-item'));
        const now = Date.now();
        
        // Mark currently shown videos as recently accessed
        videosToShow.forEach(video => {
            this.itemAccessTimes.set(video.id, now);
        });
        
        // Clean up excess items if we're over the cache limit
        if (existingItems.length > this.maxCachedItems) {
            // Sort items by last access time (oldest first)
            const itemsWithTimes = existingItems.map(item => ({
                element: item,
                videoId: item.dataset.videoId,
                lastAccess: this.itemAccessTimes.get(item.dataset.videoId) || 0
            })).sort((a, b) => a.lastAccess - b.lastAccess);
            
            const itemsToRemove = itemsWithTimes.slice(0, existingItems.length - this.maxCachedItems);
            itemsToRemove.forEach(({ element, videoId }) => {
                element.remove();
                this.itemAccessTimes.delete(videoId);
            });
        }
        
        const remainingItems = Array.from(grid.querySelectorAll('.video-item'));
        
        // Hide all existing items first
        remainingItems.forEach(item => item.style.display = 'none');
        
        // Show and update items for current page
        videosToShow.forEach((video, index) => {
            let item = remainingItems.find(el => el.dataset.videoId === video.id);
            
            if (!item) {
                // Create new item if it doesn't exist
                const savedPosition = getSavedVideoPosition(video.id);
                const hasResume = savedPosition && savedPosition.time > VIDEO_POSITION_CONFIG.resumeThreshold;
                
                item = document.createElement('div');
                item.className = 'video-item';
                item.dataset.videoId = video.id;
                item.onclick = () => archive.loadVideo(video.id);
                item.innerHTML = `
                    <div class="video-thumbnail-container">
                        <img class="video-thumbnail" 
                             src="/api/thumbnail/72/${video.id}" 
                             alt="${video.title}"
                             loading="lazy"
                             onerror="this.style.background='#333'; this.style.color='#666'; this.style.display='flex'; this.style.alignItems='center'; this.style.justifyContent='center'; this.innerHTML='No Image';">
                        ${hasResume ? `<div class="resume-overlay">⏸ ${formatTime(savedPosition.time)}</div>` : ''}
                    </div>
                    <div class="video-info">
                        <div class="video-item-title">${video.title}</div>
                        <div class="video-item-date">${video.date.toLocaleDateString('en-US', { 
                            year: 'numeric', 
                            month: 'long', 
                            day: 'numeric' 
                        })}</div>
                    </div>
                `;
                grid.appendChild(item);
                this.itemAccessTimes.set(video.id, now);
            } else {
                // Update existing item's resume overlay
                const savedPosition = getSavedVideoPosition(video.id);
                const hasResume = savedPosition && savedPosition.time > VIDEO_POSITION_CONFIG.resumeThreshold;
                const container = item.querySelector('.video-thumbnail-container');
                let overlay = container.querySelector('.resume-overlay');
                
                if (hasResume && !overlay) {
                    overlay = document.createElement('div');
                    overlay.className = 'resume-overlay';
                    overlay.textContent = `⏸ ${formatTime(savedPosition.time)}`;
                    container.appendChild(overlay);
                } else if (hasResume && overlay) {
                    overlay.textContent = `⏸ ${formatTime(savedPosition.time)}`;
                } else if (!hasResume && overlay) {
                    overlay.remove();
                }
                
                // Update access time for existing item
                this.itemAccessTimes.set(video.id, now);
            }
            
            item.style.display = 'flex';
        });
    }

    async loadVideo(videoId) {
        console.log('Loading video with ID:', videoId);
        const video = this.videos.find(v => v.id === videoId);
        console.log('Found video:', video ? { id: video.id, title: video.title } : 'NOT FOUND');
        if (!video) return;

        this.currentVideo = video;
        this.hasResumed = false;
        this.shouldResume = false;

        // Clear existing timer
        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }

        // Update URL
        history.pushState({ videoId }, video.title, `#${videoId}`);
        document.title = `Macaw45 VOD Archive: ${video.title}`;

        // Show video info
        document.getElementById('videoTitle').textContent = video.title;
        document.getElementById('videoSource').innerHTML = `originally from <a href="https://twitch.tv/videos/${videoId}" target="_blank">twitch.tv/videos/${videoId}</a>`;
        document.getElementById('videoDate').textContent = video.date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });
        document.getElementById('videoDesc').textContent = video.description || '(no description)';
        document.getElementById('infoSection').style.display = 'block';

        // Dispose of existing player and cleanup
        if (this.player) {
            this.player.dispose();
            this.player = null;
        }

        // Clean up any existing videojs instances
        const existingPlayer = videojs.getPlayer('videoPlayer');
        if (existingPlayer) {
            existingPlayer.dispose();
        }

        // Remove start over button
        this.removeStartOverButton();

        // Show video container and hide placeholder
        const placeholder = document.getElementById('videoPlaceholder');
        const playerElement = document.getElementById('videoPlayer');
        const chatToggle = document.getElementById('chatToggle');
        const videoContainer = document.getElementById('videoContainer');
        
        if (placeholder) placeholder.style.display = 'none';
        if (chatToggle) chatToggle.style.display = 'none'; // Hidden for now

        // Recreate the video element to ensure clean state
        if (playerElement) {
            playerElement.remove();
        }

        // Create new video element
        const newVideoElement = document.createElement('video');
        newVideoElement.id = 'videoPlayer';
        newVideoElement.className = 'video-js vjs-default-skin';
        newVideoElement.setAttribute('controls', '');
        newVideoElement.setAttribute('preload', 'auto');
        newVideoElement.setAttribute('data-setup', '{}');
        newVideoElement.setAttribute('poster', `/api/thumbnail/720/${videoId}`);

        // Insert the new video element
        videoContainer.appendChild(newVideoElement);

        // Initialize Video.js player
        this.player = videojs('videoPlayer', {
            fluid: true,
            responsive: true,
            aspectRatio: '16:9'
        });

        // Set up position tracking immediately (no async needed for localStorage)
        this.setupVideoPositionTracking(videoId);
        this.setupVideoTimeTracking(this.player, videoId);

        this.player.ready(() => {
            console.log('Player ready, loading video...');
            this.player.src({
                src: `/api/video/${videoId}`,
                type: 'application/x-mpegURL'
            });
        });

        // Load chat timecodes if chat is open
        if (this.chatOpen) {
            this.loadChatTimecodes(videoId);
        }

        // Scroll to video
        document.querySelector('.video-section').scrollIntoView({ behavior: 'smooth' });
        
        // Update the video list to show any new resume indicators
        this.renderVideos();
    }

    setupVideoPositionTracking(videoId) {
        const player = this.player;
        
        // Disable player controls until we're ready
        player.controls(false);
        
        // Check saved position immediately (localStorage is synchronous)
        const savedPosition = getSavedVideoPosition(videoId);
        const shouldAutoResume = savedPosition && savedPosition.time > VIDEO_POSITION_CONFIG.resumeThreshold;
        
        // Create start over button immediately if there's a saved position
        if (shouldAutoResume) {
            const titleElement = document.getElementById('videoTitle');
            if (titleElement && !this.startOverBtn) {
                this.startOverBtn = document.createElement('button');
                this.startOverBtn.textContent = `Start Over (was at ${formatTime(savedPosition.time)})`;
                this.startOverBtn.className = 'start-over-btn';
                
                this.startOverBtn.addEventListener('click', () => {
                    clearVideoPosition(videoId);
                    
                    // Reset resume flags first
                    this.hasResumed = false;
                    this.shouldResume = false;
                    player.isResuming = false;
                    
                    // Remove any existing auto-resume event listeners
                    player.off('play');
                    
                    // Simply seek to beginning - works even if video hasn't been played
                    player.currentTime(0);
                    
                    // Re-setup the normal event listeners (without auto-resume)
                    this.setupNormalEventListeners(player, videoId);
                    
                    this.removeStartOverButton();
                    this.renderVideos(); // Refresh the video list to remove resume indicators
                });
                
                titleElement.appendChild(this.startOverBtn);
            }
            
            // Set resume flags immediately
            this.shouldResume = true;
        }

        // Save position periodically
        const savePosition = () => {
            if (player.isResuming) return;
            
            const currentTime = player.currentTime();
            const duration = player.duration();
            
            if (currentTime && duration && !isNaN(currentTime) && !isNaN(duration)) {
                saveVideoPosition(videoId, currentTime, duration);
            }
        };

        // Start/stop periodic saving
        const startSaving = () => {
            if (this.saveTimer) clearInterval(this.saveTimer);
            this.saveTimer = setInterval(savePosition, VIDEO_POSITION_CONFIG.saveInterval * 1000);
        };

        const stopSaving = () => {
            if (this.saveTimer) {
                clearInterval(this.saveTimer);
                this.saveTimer = null;
            }
        };

        // Auto-resume logic
        const doAutoResume = () => {
            if (this.hasResumed || player.isResuming || !this.shouldResume) return;
            
            this.hasResumed = true;
            autoResumeVideo(player, savedPosition.time);
        };

        // Enable controls and handle auto-resume when metadata loads
        const onMetadataLoaded = () => {
            // Enable controls now that we can properly handle playback
            player.controls(true);
            
            // Do auto-resume if needed
            setTimeout(doAutoResume, 50);
        };

        // Event listeners
        player.on('loadedmetadata', onMetadataLoaded);

        player.on('play', () => {
            // If we should resume but haven't yet, trigger auto-resume immediately
            if (this.shouldResume && !this.hasResumed) {
                player.pause();
                doAutoResume();
                return;
            }
            
            if (!player.isResuming) {
                startSaving();
            }
        });

        player.on('pause', () => {
            if (!player.isResuming) {
                savePosition();
            }
        });

        player.on('seeked', () => {
            if (!player.isResuming) {
                savePosition();
            }
        });

        player.on('ended', () => {
            stopSaving();
            clearVideoPosition(videoId);
            this.removeStartOverButton();
            this.renderVideos(); // Refresh the video list to remove resume indicators
        });

        window.addEventListener('beforeunload', savePosition);

        // Handle case where metadata is already loaded
        if (player.readyState() >= 1) {
            onMetadataLoaded();
        }
    }

    setupNormalEventListeners(player, videoId) {
        // Save position periodically
        const savePosition = () => {
            if (player.isResuming) return;
            
            const currentTime = player.currentTime();
            const duration = player.duration();
            
            if (currentTime && duration && !isNaN(currentTime) && !isNaN(duration)) {
                saveVideoPosition(videoId, currentTime, duration);
            }
        };

        // Start/stop periodic saving
        const startSaving = () => {
            if (this.saveTimer) clearInterval(this.saveTimer);
            this.saveTimer = setInterval(savePosition, VIDEO_POSITION_CONFIG.saveInterval * 1000);
        };

        const stopSaving = () => {
            if (this.saveTimer) {
                clearInterval(this.saveTimer);
                this.saveTimer = null;
            }
        };

        // Normal event listeners (no auto-resume)
        player.on('play', () => {
            if (!player.isResuming) {
                startSaving();
            }
        });

        player.on('pause', () => {
            if (!player.isResuming) {
                savePosition();
            }
        });

        player.on('seeked', () => {
            if (!player.isResuming) {
                savePosition();
            }
        });

        player.on('ended', () => {
            stopSaving();
            clearVideoPosition(videoId);
            this.removeStartOverButton();
            this.renderVideos();
        });

        window.addEventListener('beforeunload', savePosition);
    }

    setupVideoTimeTracking(player, videoId) {
        player.on('timeupdate', () => {
            const currentTime = Math.floor(player.currentTime());
            
            // Update URL hash with current time
            if (currentTime !== this.lastChatTime && currentTime > 0) {
                history.replaceState({}, '', `#${videoId}?t=${currentTime}`);
                
                // Load chat for current time range if chat is open
                if (this.chatOpen && this.chatTimecodes.size > 0) {
                    let startTime = Math.max(currentTime - this.chatSeekThreshold, this.lastChatTime + 1);
                    if (currentTime < this.lastChatTime) {
                        startTime = currentTime - this.chatSeekThreshold;
                    }
                    
                    for (let t = startTime; t <= currentTime + this.chatSeekThreshold; t++) {
                        if (this.chatTimecodes.has(t)) {
                            // Load chat messages for this time range
                            this.loadChatForTimeRange(videoId, Math.max(0, currentTime - 30), currentTime + 10);
                            break;
                        }
                    }
                }
                
                this.lastChatTime = currentTime;
            }
        });
        
        // Handle seeking
        player.on('seeked', () => {
            const currentTime = Math.floor(player.currentTime());
            if (this.chatOpen) {
                // Load chat around the seeked position
                this.loadChatForTimeRange(videoId, Math.max(0, currentTime - 30), currentTime + 10);
            }
        });
    }

    toggleChat() {
        if (this.chatOpen) {
            this.closeChat();
        } else {
            this.openChat();
        }
    }

    openChat() {
        const chatSidebar = document.getElementById('chatSidebar');
        const chatToggle = document.getElementById('chatToggle');
        const videoSection = document.querySelector('.video-section');
        
        chatSidebar.style.display = 'flex';
        chatToggle.textContent = 'Hide Chat';
        videoSection.classList.add('chat-open');
        this.chatOpen = true;
        
        // Load chat for current video if available
        if (this.currentVideo && this.player) {
            this.loadChatTimecodes(this.currentVideo.id);
        }
    }

    closeChat() {
        const chatSidebar = document.getElementById('chatSidebar');
        const chatToggle = document.getElementById('chatToggle');
        const videoSection = document.querySelector('.video-section');
        
        chatSidebar.style.display = 'none';
        chatToggle.textContent = 'Show Chat';
        videoSection.classList.remove('chat-open');
        this.chatOpen = false;
    }

    async loadChatTimecodes(videoId) {
        try {
            const response = await fetch(`/api/chat/${videoId}`);
            if (response.ok) {
                const timecodes = await response.json();
                this.chatTimecodes = new Set(timecodes);
                console.log(`Loaded ${timecodes.length} chat timecodes for video ${videoId}`);
            } else {
                console.log(`No chat data available for video ${videoId}`);
                this.chatTimecodes = new Set();
                this.showNoChatMessage();
            }
        } catch (error) {
            console.error('Failed to load chat timecodes:', error);
            this.chatTimecodes = new Set();
            this.showNoChatMessage();
        }
    }

    showNoChatMessage() {
        const chatMessages = document.getElementById('chatMessages');
        chatMessages.innerHTML = '<div class="chat-no-messages">No chat data available for this video</div>';
    }

    async loadChatForTimeRange(videoId, startTime, endTime) {
        try {
            const response = await fetch(`/api/chat/${videoId}/${startTime}/${endTime}`);
            if (response.ok) {
                const messages = await response.json();
                this.displayChatMessages(messages, startTime, endTime);
            }
        } catch (error) {
            console.error('Failed to load chat messages:', error);
        }
    }

    displayChatMessages(messages, startTime, endTime) {
        const chatMessages = document.getElementById('chatMessages');
        
        // Clear loading or existing messages for this time range
        chatMessages.innerHTML = '';
        
        if (messages.length === 0) {
            chatMessages.innerHTML = '<div class="chat-loading">No messages in this time range</div>';
            return;
        }
        
        messages.forEach(message => {
            const messageElement = this.createChatMessageElement(message);
            chatMessages.appendChild(messageElement);
        });
        
        // Scroll to bottom to show latest messages
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    createChatMessageElement(message) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message';
        
        const timestamp = document.createElement('span');
        timestamp.className = 'chat-timestamp';
        timestamp.textContent = formatTime(message.offset);
        
        const username = document.createElement('span');
        username.className = 'chat-username';
        username.textContent = message.commenter?.display_name || 'Anonymous';
        
        const text = document.createElement('span');
        text.className = 'chat-text';
        
        // Simple text for now - could be enhanced with emote parsing
        if (message.message && message.message.body) {
            text.textContent = message.message.body;
        } else {
            text.textContent = message.text || '';
        }
        
        messageDiv.appendChild(timestamp);
        messageDiv.appendChild(username);
        messageDiv.appendChild(text);
        
        return messageDiv;
    }

    checkURLForVideoAndTime() {
        const hash = window.location.hash.slice(1);
        if (hash) {
            const [videoId, timeParam] = hash.split('?t=');
            if (videoId) {
                this.loadVideo(videoId);
                if (timeParam) {
                    const seekTime = parseInt(timeParam, 10);
                    if (seekTime > 0 && this.player) {
                        this.player.ready(() => {
                            this.player.currentTime(seekTime);
                        });
                    }
                }
            }
        }
    }

    removeStartOverButton() {
        if (this.startOverBtn) {
            this.startOverBtn.remove();
            this.startOverBtn = null;
        }
    }

    checkURLForVideo() {
        this.checkURLForVideoAndTime();
    }
}

// Initialize the app
const archive = new VODArchive();

// Handle browser back/forward
window.addEventListener('popstate', (e) => {
    if (e.state && e.state.videoId) {
        archive.loadVideo(e.state.videoId);
    } else {
        // Back to main page
        if (archive.player) {
            archive.player.dispose();
            archive.player = null;
        }
        document.getElementById('videoPlaceholder').style.display = 'flex';
        document.getElementById('videoPlayer').style.display = 'none';
        document.getElementById('chatToggle').style.display = 'none';
        document.getElementById('infoSection').style.display = 'none';
        document.title = 'Macaw45 VOD Archive';
    }
});