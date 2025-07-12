// Video position saving settings
const VIDEO_POSITION_CONFIG = {
    saveInterval: 10,
    minSaveTime: 30,
    expireDays: 30,
    resumeThreshold: 60
};

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

function saveVideoPosition(videoId, currentTime, duration) {
    if (currentTime < VIDEO_POSITION_CONFIG.minSaveTime) return;
    if (currentTime > duration - 30) return;
    
    const positionData = {
        time: currentTime,
        duration: duration,
        timestamp: Date.now()
    };
    
    localStorage.setItem(`video_position_${videoId}`, JSON.stringify(positionData));
}

function getSavedVideoPosition(videoId) {
    try {
        const data = localStorage.getItem(`video_position_${videoId}`);
        return data ? JSON.parse(data) : null;
    } catch (e) {
        return null;
    }
}

function clearVideoPosition(videoId) {
    localStorage.removeItem(`video_position_${videoId}`);
}

function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (hours > 0) {
        return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    }
    return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function autoResumeVideo(player, savedTime) {
    const onFirstPlay = () => {
        player.off('play', onFirstPlay);
        player.pause();
        
        const onSeeked = () => {
            player.isResuming = false;
            player.off('seeked', onSeeked);
            player.play();
        };
        
        player.isResuming = true;
        player.on('seeked', onSeeked);
        player.currentTime(savedTime);
    };
    
    player.isResuming = true;
    player.on('play', onFirstPlay);
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
        this.maxCachedItems = 200;
        this.itemAccessTimes = new Map();
        
        this.chatOpen = false;
        this.chatTimecodes = new Set();
        this.lastChatTime = -1;
        this.chatSeekThreshold = 5;
        
        // Chat caching
        this.emoteCache = { firstParty: {}, thirdParty: {}, cheers: {} }; // Cache emote mappings
        
        this.init();
        cleanupOldPositions();
    }

    async init() {
        await this.loadVideos();
        await this.loadEmoteMappings(); // Load emote mappings upfront
        this.setupEventListeners();
        this.filterAndPaginate();
        this.checkURLForVideo();
    }

    async loadEmoteMappings() {
        try {
            const [firstPartyResponse, thirdPartyResponse, cheersResponse] = await Promise.all([
                fetch('/api/emotes/first-party'),
                fetch('/api/emotes/third-party'),
                fetch('/api/emotes/cheers')
            ]);
            
            if (firstPartyResponse.ok) {
                this.emoteCache.firstParty = await firstPartyResponse.json();
            }
            if (thirdPartyResponse.ok) {
                this.emoteCache.thirdParty = await thirdPartyResponse.json();
            }
            if (cheersResponse.ok) {
                this.emoteCache.cheers = await cheersResponse.json();
            }
            
            console.log(`Loaded ${Object.keys(this.emoteCache.firstParty).length} first-party, ${Object.keys(this.emoteCache.thirdParty).length} third-party emotes, and ${Object.keys(this.emoteCache.cheers).length} cheer providers`);
        } catch (error) {
            console.error('Failed to load emote mappings:', error);
        }
    }

    async loadVideos() {
        try {
            const response = await fetch('/api/videos');
            const data = await response.json();
            
            this.videos = data.map(video => ({
                id: video.vodid,
                title: video.title,
                description: video.description,
                date: new Date(video.date),
                duration: video.duration
            })).sort((a, b) => b.date - a.date);
            
            document.getElementById('loadingState').style.display = 'none';
            document.getElementById('videoGrid').style.display = 'block';
            document.getElementById('bottomPagination').style.display = 'block';
        } catch (error) {
            console.error('Failed to load videos:', error);
            document.getElementById('loadingState').textContent = 'Failed to load videos. Please try again later.';
        }
    }

    setupEventListeners() {
        document.getElementById('titleFilter').addEventListener('input', () => {
            this.currentPage = 1;
            this.filterAndPaginate();
        });

        ['fromMonth', 'fromDay', 'fromYear', 'toMonth', 'toDay', 'toYear'].forEach(id => {
            document.getElementById(id).addEventListener('input', () => {
                this.currentPage = 1;
                this.filterAndPaginate();
            });
        });

        document.getElementById('clearFilters').addEventListener('click', () => {
            document.getElementById('titleFilter').value = '';
            ['fromMonth', 'fromDay', 'fromYear', 'toMonth', 'toDay', 'toYear'].forEach(id => {
                document.getElementById(id).value = '';
            });
            this.currentPage = 1;
            this.filterAndPaginate();
        });

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

        document.getElementById('chatToggle').addEventListener('click', () => {
            this.toggleChat();
        });
        
        document.getElementById('chatClose').addEventListener('click', () => {
            this.closeChat();
        });

        window.addEventListener('resize', () => {
            this.updatePagination();
            // Sync chat sidebar height on resize
            setTimeout(() => this.syncChatSidebarHeight(), 100);
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
            toDate.setHours(23, 59, 59, 999);
        }

        this.filteredVideos = this.videos.filter(video => {
            if (titleFilter && !video.title.toLowerCase().includes(titleFilter)) {
                return false;
            }

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
        
        const isPhone = window.innerWidth <= 480;
        const videoCountText = isPhone ? '' : ` (${this.filteredVideos.length} videos)`;
        
        document.getElementById('pageInput').value = this.currentPage;
        document.getElementById('pageInput').max = totalPages;
        document.getElementById('pageInfo').textContent = `of ${totalPages}${videoCountText}`;
        document.getElementById('prevBtn').disabled = this.currentPage <= 1;
        document.getElementById('nextBtn').disabled = this.currentPage >= totalPages;
        
        document.getElementById('bottomPageInput').value = this.currentPage;
        document.getElementById('bottomPageInput').max = totalPages;
        document.getElementById('bottomPageInfo').textContent = `of ${totalPages}${videoCountText}`;
        document.getElementById('bottomPrevBtn').disabled = this.currentPage <= 1;
        document.getElementById('bottomNextBtn').disabled = this.currentPage >= totalPages;
    }

    renderVideos() {
        const grid = document.getElementById('videoGrid');
        const startIndex = (this.currentPage - 1) * this.itemsPerPage;
        const endIndex = startIndex + this.itemsPerPage;
        const videosToShow = this.filteredVideos.slice(startIndex, endIndex);

        const existingItems = grid.querySelectorAll('.video-item');
        const shouldRebuild = existingItems.length === 0;

        if (shouldRebuild) {
            this.buildVideoGrid(grid, videosToShow);
        } else {
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
                        <div class="video-item-date">
                            ${video.date.toLocaleDateString('en-US', { 
                                year: 'numeric', 
                                month: 'long', 
                                day: 'numeric' 
                            })}${video.duration ? ` • ${formatTime(video.duration)}` : ''}
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    updateVideoGrid(grid, videosToShow) {
        const existingItems = Array.from(grid.querySelectorAll('.video-item'));
        const now = Date.now();
        
        videosToShow.forEach(video => {
            this.itemAccessTimes.set(video.id, now);
        });
        
        if (existingItems.length > this.maxCachedItems) {
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
        
        remainingItems.forEach(item => item.style.display = 'none');
        
        videosToShow.forEach((video, index) => {
            let item = remainingItems.find(el => el.dataset.videoId === video.id);
            
            if (!item) {
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
                        <div class="video-item-date">
                            ${video.date.toLocaleDateString('en-US', { 
                                year: 'numeric', 
                                month: 'long', 
                                day: 'numeric' 
                            })}${video.duration ? ` • ${formatTime(video.duration)}` : ''}
                        </div>
                    </div>
                `;
                grid.appendChild(item);
                this.itemAccessTimes.set(video.id, now);
            } else {
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
                
                this.itemAccessTimes.set(video.id, now);
            }
            
            item.style.display = 'flex';
        });
    }

    async loadVideo(videoId) {
        const video = this.videos.find(v => v.id === videoId);
        if (!video) return;

        this.currentVideo = video;
        this.hasResumed = false;
        this.shouldResume = false;

        if (this.saveTimer) {
            clearInterval(this.saveTimer);
            this.saveTimer = null;
        }

        history.pushState({ videoId }, video.title, `#${videoId}`);
        document.title = `Macaw45 VOD Archive: ${video.title}`;

        document.getElementById('videoTitle').textContent = video.title;
        document.getElementById('videoSource').innerHTML = `originally from <a href="https://twitch.tv/videos/${videoId}" target="_blank">twitch.tv/videos/${videoId}</a>`;
        document.getElementById('videoDate').textContent = video.date.toLocaleDateString('en-US', { 
            year: 'numeric', 
            month: 'long', 
            day: 'numeric' 
        });
        document.getElementById('videoDesc').textContent = video.description || '(no description)';
        document.getElementById('infoSection').style.display = 'block';

        if (this.player) {
            this.player.dispose();
            this.player = null;
        }

        const existingPlayer = videojs.getPlayer('videoPlayer');
        if (existingPlayer) {
            existingPlayer.dispose();
        }

        this.removeStartOverButton();

        const placeholder = document.getElementById('videoPlaceholder');
        const playerElement = document.getElementById('videoPlayer');
        const chatToggle = document.getElementById('chatToggle');
        const videoContainer = document.getElementById('videoContainer');
        
        if (placeholder) placeholder.style.display = 'none';
        if (chatToggle) chatToggle.style.display = 'none';

        if (playerElement) {
            playerElement.remove();
        }

        const newVideoElement = document.createElement('video');
        newVideoElement.id = 'videoPlayer';
        newVideoElement.className = 'video-js vjs-default-skin';
        newVideoElement.setAttribute('controls', '');
        newVideoElement.setAttribute('preload', 'auto');
        newVideoElement.setAttribute('data-setup', '{}');
        newVideoElement.setAttribute('poster', `/api/thumbnail/720/${videoId}`);

        videoContainer.appendChild(newVideoElement);

        const loadingIndicator = document.createElement('div');
        loadingIndicator.className = 'video-loading-indicator';
        loadingIndicator.innerHTML = '<div class="video-loading-spinner"></div>';
        videoContainer.appendChild(loadingIndicator);

        this.player = videojs('videoPlayer', {
            fluid: true,
            responsive: true,
            aspectRatio: '16:9'
        });

        this.setupVideoPositionTracking(videoId);
        this.setupVideoTimeTracking(this.player, videoId);

        this.player.ready(() => {
            this.player.src({
                src: `/api/video/${videoId}`,
                type: 'application/x-mpegURL'
            });
            
            // Sync chat sidebar height when player is ready
            setTimeout(() => this.syncChatSidebarHeight(), 200);
        });

        // Always load chat timecodes when video loads
        this.loadChatTimecodes(videoId);

        // Create chat toggle button if no start over button exists
        if (!this.startOverBtn) {
            const titleElement = document.getElementById('videoTitle');
            this.createChatToggleButton(titleElement);
        }

        document.querySelector('.video-section').scrollIntoView({ behavior: 'smooth' });
        
        this.renderVideos();
    }

    setupVideoPositionTracking(videoId) {
        const player = this.player;
        
        player.controls(false);
        
        const savedPosition = getSavedVideoPosition(videoId);
        const shouldAutoResume = savedPosition && savedPosition.time > VIDEO_POSITION_CONFIG.resumeThreshold;
        
        if (shouldAutoResume) {
            const titleElement = document.getElementById('videoTitle');
            if (titleElement && !this.startOverBtn) {
                this.startOverBtn = document.createElement('button');
                this.startOverBtn.textContent = `Start Over (was at ${formatTime(savedPosition.time)})`;
                this.startOverBtn.className = 'start-over-btn';
                
                this.startOverBtn.addEventListener('click', () => {
                    clearVideoPosition(videoId);
                    
                    this.hasResumed = false;
                    this.shouldResume = false;
                    player.isResuming = false;
                    
                    player.off('play');
                    
                    player.currentTime(0);
                    
                    this.setupNormalEventListeners(player, videoId);
                    
                    this.removeStartOverButton();
                    this.renderVideos();
                });
                
                titleElement.appendChild(this.startOverBtn);
            }
            
            // Create chat toggle button next to start over button
            this.createChatToggleButton(titleElement);
            
            this.shouldResume = true;
        }

        const savePosition = () => {
            if (player.isResuming) return;
            
            const currentTime = player.currentTime();
            const duration = player.duration();
            
            if (currentTime && duration && !isNaN(currentTime) && !isNaN(duration)) {
                saveVideoPosition(videoId, currentTime, duration);
            }
        };

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

        const doAutoResume = () => {
            if (this.hasResumed || player.isResuming || !this.shouldResume) return;
            
            this.hasResumed = true;
            autoResumeVideo(player, savedPosition.time);
        };

        const onMetadataLoaded = () => {
            const loadingIndicator = document.querySelector('.video-loading-indicator');
            if (loadingIndicator) {
                loadingIndicator.remove();
            }
            
            player.controls(true);
            
            setTimeout(doAutoResume, 50);
        };

        player.on('loadedmetadata', onMetadataLoaded);
        
        // Sync chat sidebar height when video metadata loads
        player.on('loadedmetadata', () => {
            setTimeout(() => this.syncChatSidebarHeight(), 100);
        });

        player.on('play', () => {
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
            this.renderVideos();
        });

        window.addEventListener('beforeunload', savePosition);

        if (player.readyState() >= 1) {
            onMetadataLoaded();
        }
    }

    setupNormalEventListeners(player, videoId) {
        const savePosition = () => {
            if (player.isResuming) return;
            
            const currentTime = player.currentTime();
            const duration = player.duration();
            
            if (currentTime && duration && !isNaN(currentTime) && !isNaN(duration)) {
                saveVideoPosition(videoId, currentTime, duration);
            }
        };

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
        let hasStartedPlaying = false;
        let lastDisplayedSecond = -1;
        
        player.on('play', () => {
            hasStartedPlaying = true;
        });
        
        player.on('timeupdate', () => {
            const currentTime = Math.floor(player.currentTime());
            
            if (currentTime !== this.lastChatTime && currentTime > 0) {
                history.replaceState({}, '', `#${videoId}?t=${currentTime}`);
                
                // Load and display messages for this second if we haven't already
                if (hasStartedPlaying && currentTime !== lastDisplayedSecond) {
                    this.loadAndDisplayChatForSecond(videoId, currentTime);
                    lastDisplayedSecond = currentTime;
                }
                
                this.lastChatTime = currentTime;
            }
        });
        
        player.on('seeked', () => {
            const currentTime = Math.floor(player.currentTime());
            if (hasStartedPlaying) {
                // Clear chat and load messages for the new position
                const chatMessages = document.getElementById('chatMessages');
                chatMessages.innerHTML = '';
                this.loadAndDisplayChatForSecond(videoId, currentTime);
                lastDisplayedSecond = currentTime;
            }
        });
    }

    async loadAndDisplayChatForSecond(videoId, currentTime) {
        try {
            const response = await fetch(`/api/chat/${videoId}/${currentTime}/${currentTime}`);
            if (response.ok) {
                const messages = await response.json();
                this.appendChatMessages(messages);
            }
        } catch (error) {
            console.error('Failed to load chat messages:', error);
        }
    }

    appendChatMessages(messages) {
        const chatMessages = document.getElementById('chatMessages');
        
        if (messages.length === 0) {
            return;
        }
        
        // Simply append new messages 
        messages.forEach(message => {
            const messageElement = this.createChatMessageElement(message);
            chatMessages.appendChild(messageElement);
        });
        
        // Remove old messages to keep memory usage reasonable (keep last 50)
        const allMessages = Array.from(chatMessages.children);
        if (allMessages.length > 50) {
            const messagesToRemove = allMessages.slice(0, allMessages.length - 50);
            messagesToRemove.forEach(msg => msg.remove());
        }
        
        // Always scroll to bottom
        chatMessages.scrollTo(0, chatMessages.scrollHeight);
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
        const videoSection = document.querySelector('.video-section');
        
        // Show sidebar immediately without animation
        chatSidebar.style.display = 'flex';
        videoSection.classList.add('chat-open');
        this.chatOpen = true;
        
        // Update button state
        const chatToggleBtn = document.getElementById('chatToggleBtn');
        if (chatToggleBtn) {
            chatToggleBtn.classList.add('chat-open');
        }
        
        // Sync chat sidebar height to match video container
        setTimeout(() => this.syncChatSidebarHeight(), 50);
        
        // Chat timecodes are already loaded when video loads
    }

    closeChat() {
        const chatSidebar = document.getElementById('chatSidebar');
        const videoSection = document.querySelector('.video-section');
        
        // Hide sidebar immediately without animation
        chatSidebar.style.display = 'none';
        videoSection.classList.remove('chat-open');
        this.chatOpen = false;
        
        // Update button state
        const chatToggleBtn = document.getElementById('chatToggleBtn');
        if (chatToggleBtn) {
            chatToggleBtn.classList.remove('chat-open');
        }
    }

    createChatToggleButton(titleElement) {
        // Check if chat toggle button already exists
        let chatToggleBtn = document.getElementById('chatToggleBtn');
        if (chatToggleBtn) {
            return chatToggleBtn;
        }

        // Create new chat toggle button with icon style
        chatToggleBtn = document.createElement('div');
        chatToggleBtn.id = 'chatToggleBtn';
        chatToggleBtn.className = 'chat-drawer-toggle';
        chatToggleBtn.style.position = 'relative';
        chatToggleBtn.style.display = 'inline-flex';
        chatToggleBtn.style.marginLeft = '10px';
        chatToggleBtn.style.top = 'auto';
        chatToggleBtn.style.right = 'auto';
        chatToggleBtn.style.transform = 'none';
        chatToggleBtn.innerHTML = '<div class="chat-drawer-icon"></div>';
        
        // Add click handler
        chatToggleBtn.addEventListener('click', () => {
            this.toggleChat();
        });
        
        // Add to title element
        if (titleElement) {
            titleElement.appendChild(chatToggleBtn);
        }

        return chatToggleBtn;
    }

    createChatDrawerToggle() {
        // This method is no longer used but kept for compatibility
        return null;
    }
    
    syncChatSidebarHeight() {
        const videoContainer = document.getElementById('videoContainer');
        const chatSidebar = document.getElementById('chatSidebar');
        
        if (videoContainer && chatSidebar && this.chatOpen) {
            const videoHeight = videoContainer.offsetHeight;
            chatSidebar.style.height = `${videoHeight}px`;
        }
    }

    async loadChatTimecodes(videoId) {
        try {
            const response = await fetch(`/api/chat/${videoId}`);
            if (response.ok) {
                const data = await response.json();
                // Check if data is an array (valid timecodes) or an error object
                if (Array.isArray(data)) {
                    this.chatTimecodes = new Set(data);
                } else {
                    // Handle case where server returns an error object
                    this.chatTimecodes = new Set();
                    console.log('No chat timecodes available for this video');
                }
            } else {
                this.chatTimecodes = new Set();
                // Don't show "no chat" message immediately, wait for actual playback
            }
        } catch (error) {
            console.error('Failed to load chat timecodes:', error);
            this.chatTimecodes = new Set();
            // Don't show "no chat" message immediately, wait for actual playback
        }
    }

    showNoChatMessage() {
        const chatMessages = document.getElementById('chatMessages');
        chatMessages.innerHTML = '<div class="chat-no-messages">No chat data available for this video</div>';
    }

    async loadChatForTimeRange(videoId, startTime, endTime) {
        // This method is no longer used, keeping for compatibility
        return;
    }

    displayChatMessages(messages, startTime, endTime) {
        // This method is no longer used, keeping for compatibility  
        return;
    }

    createChatMessageElement(message) {
        const messageDiv = document.createElement('div');
        messageDiv.className = 'chat-message';
        
        // Add badges (if any)
        if (message.message && message.message.user_badges) {
            message.message.user_badges.forEach(badge => {
                const badgeImg = document.createElement('img');
                badgeImg.className = 'chat-badge';
                badgeImg.src = `/api/emote/twitchBadges/${badge._id}/${badge.version}`;
                badgeImg.title = badge._id;
                badgeImg.style.height = '16px';
                badgeImg.style.marginRight = '4px';
                badgeImg.style.verticalAlign = 'middle';
                messageDiv.appendChild(badgeImg);
            });
        }
        
        // Create username
        const username = document.createElement('span');
        username.className = 'chat-username';
        username.textContent = (message.message && message.message.display_name) || 
                              message.commenter?.display_name || 
                              'Anonymous';
        // Use user's color if available
        if (message.message && message.message.user_color) {
            username.style.color = message.message.user_color;
        }
        messageDiv.appendChild(username);
        
        // Add colon separator
        const colon = document.createElement('span');
        colon.className = 'colon';
        colon.textContent = ': ';
        messageDiv.appendChild(colon);
        
        // Create message text with emotes
        const messageText = document.createElement('span');
        messageText.className = 'chat-text';
        
        if (message.message && message.message.fragments) {
            // Process message fragments (text and emotes)
            message.message.fragments.forEach(fragment => {
                if (fragment.emoticon) {
                    // This is an emote with a direct ID - use it as-is
                    const emoteImg = document.createElement('img');
                    emoteImg.className = 'chat-emote';
                    const emoteId = fragment.emoticon.emoticon_id;
                    
                    // Use the direct emote ID from chat data
                    emoteImg.src = `/api/emote/firstParty/${emoteId}`;
                    emoteImg.alt = fragment.text;
                    emoteImg.title = fragment.text;
                    emoteImg.style.height = '20px';
                    emoteImg.style.verticalAlign = 'middle';
                    emoteImg.style.margin = '0 2px';
                    emoteImg.onerror = function() {
                        // If first-party fails, try third-party
                        if (this.src.includes('firstParty')) {
                            this.src = `/api/emote/thirdParty/${emoteId}`;
                        } else {
                            // Both failed, log it and show text fallback
                            console.warn(`Direct emote not found: ${emoteId} (${fragment.text})`);
                            this.style.display = 'none';
                            const textSpan = document.createElement('span');
                            textSpan.textContent = fragment.text;
                            this.parentNode.insertBefore(textSpan, this.nextSibling);
                        }
                    };
                    messageText.appendChild(emoteImg);
                } else {
                    // This is text - check for emote names and cheers using our cached mappings
                    const words = fragment.text.split(/\s+/);
                    words.forEach((word, index) => {
                        // Check if word is a cheer (bits) like "cheer100"
                        const cheerMatch = word.match(/^([a-zA-Z]+)(\d+)$/);
                        if (cheerMatch && this.emoteCache.cheers[cheerMatch[1]]) {
                            const provider = cheerMatch[1];
                            const bits = parseInt(cheerMatch[2]);
                            
                            // Round cheer amount to available tiers
                            let cheerAmount = 1;
                            for (const value of this.emoteCache.cheers[provider]) {
                                if (bits >= value) cheerAmount = value;
                            }
                            
                            // Create cheer image
                            const cheerImg = document.createElement('img');
                            cheerImg.className = 'chat-emote';
                            cheerImg.src = `/api/emote/twitchBits/${provider}/${cheerAmount}`;
                            cheerImg.alt = word;
                            cheerImg.title = word;
                            cheerImg.style.height = '20px';
                            cheerImg.style.verticalAlign = 'middle';
                            cheerImg.style.margin = '0 2px';
                            cheerImg.onerror = function() {
                                console.warn(`Cheer not found: ${provider}/${cheerAmount} (${word})`);
                                this.style.display = 'none';
                                const textSpan = document.createElement('span');
                                textSpan.textContent = word;
                                textSpan.style.fontFamily = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Roboto", "Helvetica", "Arial", sans-serif';
                                this.parentNode.insertBefore(textSpan, this.nextSibling);
                            };
                            messageText.appendChild(cheerImg);
                            
                            // Add the number after the cheer image
                            const numberSpan = document.createElement('span');
                            numberSpan.textContent = bits + ' ';
                            numberSpan.style.color = '#ff6347'; // Orange-red for bit numbers
                            numberSpan.style.fontWeight = 'bold';
                            messageText.appendChild(numberSpan);
                            
                            return; // Skip other checks for this word
                        }
                        
                        // Check if word is an emote using cached mappings
                        let emoteId = null;
                        let emoteType = null;
                        
                        if (this.emoteCache.thirdParty[word]) {
                            emoteId = this.emoteCache.thirdParty[word];
                            emoteType = 'thirdParty';
                        } else if (this.emoteCache.firstParty[word]) {
                            emoteId = this.emoteCache.firstParty[word];
                            emoteType = 'firstParty';
                        }
                        
                        if (emoteId && emoteType) {
                            // This is an emote - create image
                            const emoteImg = document.createElement('img');
                            emoteImg.className = 'chat-emote';
                            emoteImg.src = `/api/emote/${emoteType}/${emoteId}`;
                            emoteImg.alt = word;
                            emoteImg.title = word;
                            emoteImg.style.height = '20px';
                            emoteImg.style.verticalAlign = 'middle';
                            emoteImg.style.margin = '0 2px';
                            emoteImg.onerror = function() {
                                // Fallback to text if emote fails to load
                                console.warn(`Mapped emote not found: ${word} -> ${emoteType}/${emoteId}`);
                                this.style.display = 'none';
                                const textSpan = document.createElement('span');
                                textSpan.textContent = word + (index < words.length - 1 ? ' ' : '');
                                textSpan.style.fontFamily = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Roboto", "Helvetica", "Arial", sans-serif';
                                this.parentNode.insertBefore(textSpan, this.nextSibling);
                            };
                            messageText.appendChild(emoteImg);
                        } else {
                            // Regular text
                            const textSpan = document.createElement('span');
                            textSpan.textContent = word;
                            textSpan.style.fontFamily = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Roboto", "Helvetica", "Arial", sans-serif';
                            messageText.appendChild(textSpan);
                        }
                        
                        // Add space after word if not last
                        if (index < words.length - 1) {
                            messageText.appendChild(document.createTextNode(' '));
                        }
                    });
                }
            });
        } else {
            // Fallback to simple text - ensure emojis work here too
            const textSpan = document.createElement('span');
            textSpan.textContent = message.message?.body || message.body || '';
            textSpan.style.fontFamily = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", "Roboto", "Helvetica", "Arial", sans-serif';
            messageText.appendChild(textSpan);
        }
        
        messageDiv.appendChild(messageText);
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
        // Also remove chat toggle button
        const chatToggleBtn = document.getElementById('chatToggleBtn');
        if (chatToggleBtn) {
            chatToggleBtn.remove();
        }
    }

    checkURLForVideo() {
        this.checkURLForVideoAndTime();
    }
}

const archive = new VODArchive();

window.addEventListener('popstate', (e) => {
    if (e.state && e.state.videoId) {
        archive.loadVideo(e.state.videoId);
    } else {
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

document.ondblclick = function (e) {
    e.preventDefault();
};