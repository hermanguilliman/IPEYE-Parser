const CONFIG = {
    DEFAULT_CAMERAS_PER_PAGE: 12,
    SELECTORS: {
        CONTAINER: '#container',
        PAGE_SIZE: '#pageSize',
        PAGINATION_TOP: '#paginationTop',
        PAGINATION_BOTTOM: '#paginationBottom'
    },
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY_MS: 1000
};

const DOM = {
    container: document.querySelector(CONFIG.SELECTORS.CONTAINER),
    pageSize: document.querySelector(CONFIG.SELECTORS.PAGE_SIZE),
    paginationTop: document.querySelector(CONFIG.SELECTORS.PAGINATION_TOP),
    paginationBottom: document.querySelector(CONFIG.SELECTORS.PAGINATION_BOTTOM)
};

let state = {
    allCameras: [],
    currentPage: 1,
    camerasPerPage: CONFIG.DEFAULT_CAMERAS_PER_PAGE
};

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

function handleError(message, element = document.body) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error';
    errorDiv.textContent = message;
    element.appendChild(errorDiv);
    console.error(message);
}

function setLoading(isLoading) {
    DOM.container.innerHTML = isLoading ? '<div class="loading">Loading cameras...</div>' : '';
    DOM.pageSize.disabled = isLoading;
    DOM.paginationTop.style.pointerEvents = isLoading ? 'none' : 'auto';
    DOM.paginationBottom.style.pointerEvents = isLoading ? 'none' : 'auto';
}

function decodeHtml(html) {
    return html
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function validateCamera(camera) {
    const requiredFields = ['id_user', 'devcode', 'stream_url'];
    const isValid = requiredFields.every(field => camera[field] !== undefined && camera[field] !== null);
    if (!isValid) {
        console.warn('Invalid camera:', camera);
    }
    return isValid;
}

async function loadStreamWithRetry(hls, video, url, updateStatus) {
    for (let i = 0; i < CONFIG.RETRY_ATTEMPTS; i++) {
        try {
            console.log(`Attempting to load stream: ${url} (Attempt ${i + 1})`);
            hls.loadSource(url);
            hls.attachMedia(video);
            await new Promise((resolve, reject) => {
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    console.log(`Stream loaded successfully: ${url}`);
                    video.play().catch(error => {
                        console.error(`Playback error for ${url}:`, error);
                        updateStatus('Playback Blocked', true);
                    });
                    updateStatus('Live');
                    resolve();
                });
                hls.on(Hls.Events.ERROR, (event, data) => {
                    console.error(`HLS error for ${url}:`, data);
                    if (data.fatal) reject(data);
                });
            });
            return;
        } catch (error) {
            console.error(`Stream load attempt ${i + 1} failed for ${url}:`, error);
            if (i < CONFIG.RETRY_ATTEMPTS - 1) {
                await new Promise(res => setTimeout(res, CONFIG.RETRY_DELAY_MS * Math.pow(2, i)));
            } else {
                updateStatus(`Stream Error: ${error.type || 'Unknown'}`, true);
            }
        }
    }
}

function createCameraCard(camera) {
    console.log('Creating camera card for:', camera);
    const card = document.createElement('div');
    card.className = 'camera-card';
    
    const info = document.createElement('div');
    info.className = 'camera-info';
    
    const nameElem = document.createElement('div');
    nameElem.className = 'camera-name';
    nameElem.textContent = decodeHtml(camera.name) || 'Unnamed Camera';

    const idElem = document.createElement('div');
    idElem.className = 'camera-meta';
    idElem.textContent = `ID: ${camera.id_user}`;

    const devcodeElem = document.createElement('div');
    devcodeElem.className = 'camera-meta camera-devcode';
    devcodeElem.textContent = `Code: ${camera.devcode}`;

    const statusElem = document.createElement('div');
    statusElem.className = 'camera-status';
    statusElem.innerHTML = `
        <span class="status-indicator"></span>
        <span class="status-text">Connecting...</span>
    `;

    info.appendChild(nameElem);
    info.appendChild(idElem);
    info.appendChild(devcodeElem);
    info.appendChild(statusElem);

    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-container';
    
    const video = document.createElement('video');
    video.controls = true;
    video.muted = true;

    const updateStatus = (status, isError = false) => {
        statusElem.querySelector('.status-indicator').className = 
            `status-indicator${isError ? ' offline' : ''}`;
        statusElem.querySelector('.status-text').textContent = status;
        card.style.backgroundColor = isError ? '#3a1a1a' : '#2a2a2a';
        console.log(`Status updated for ${camera.id_user}: ${status}${isError ? ' (Error)' : ''}`);
    };

    let hls = null;
    let isDestroyed = false;

    const cleanup = () => {
        if (hls && !isDestroyed) {
            console.log(`Cleaning up HLS for ${camera.id_user}`);
            hls.destroy();
            isDestroyed = true;
        }
        video.pause();
        video.src = '';
        video.remove();
    };

    if (Hls.isSupported()) {
        hls = new Hls();
        loadStreamWithRetry(hls, video, camera.stream_url, updateStatus);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        console.log(`Using native HLS for ${camera.stream_url}`);
        video.src = camera.stream_url;
        video.addEventListener('loadeddata', () => updateStatus('Live'));
        video.addEventListener('error', (error) => {
            console.error(`Native HLS error for ${camera.stream_url}:`, error);
            updateStatus('Offline', true);
        });
    } else {
        console.warn(`Unsupported format for ${camera.stream_url}`);
        updateStatus('Unsupported Format', true);
    }

    video.addEventListener('play', () => updateStatus('Live'));
    video.addEventListener('waiting', () => updateStatus('Buffering...'));

    videoContainer.appendChild(video);
    card.appendChild(videoContainer);
    card.appendChild(info);
    
    card.addEventListener('remove', cleanup);
    DOM.container.appendChild(card);
    console.log(`Camera card added to container for ${camera.id_user}`);
}

const debouncedUpdateCameras = debounce(function updateCameras() {
    console.log(`Updating cameras for page ${state.currentPage}, ${state.camerasPerPage} per page`);
    window.scrollTo(0, 0);
    DOM.container.innerHTML = '';
    
    const start = (state.currentPage - 1) * state.camerasPerPage;
    const end = start + state.camerasPerPage;
    const camerasToShow = state.allCameras.slice(start, end);
    console.log(`Cameras to show: ${camerasToShow.length}`);

    camerasToShow.forEach(camera => {
        if (validateCamera(camera)) {
            createCameraCard(camera);
        } else {
            handleError(`Invalid camera data: ${JSON.stringify(camera)}`, DOM.container);
        }
    });

    updatePaginationControls();
}, 100);

function updatePaginationControls() {
    const totalPages = Math.ceil(state.allCameras.length / state.camerasPerPage);
    console.log(`Total pages: ${totalPages}`);
    
    const buttonsHTML = Array.from({ length: totalPages }, (_, index) => {
        const pageNumber = index + 1;
        const isActive = pageNumber === state.currentPage;
        return `<button data-page="${pageNumber}" ${isActive ? 'disabled class="active"' : ''}>${pageNumber}</button>`;
    }).join('');

    DOM.paginationTop.innerHTML = buttonsHTML;
    DOM.paginationBottom.innerHTML = buttonsHTML;
}

function setupPagination() {
    DOM.pageSize.addEventListener('change', (e) => {
        state.camerasPerPage = parseInt(e.target.value);
        state.currentPage = 1;
        console.log(`Page size changed to ${state.camerasPerPage}`);
        debouncedUpdateCameras();
    });

    [DOM.paginationTop, DOM.paginationBottom].forEach(pagination => {
        pagination.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON' && e.target.dataset.page) {
                state.currentPage = parseInt(e.target.dataset.page);
                console.log(`Page changed to ${state.currentPage}`);
                debouncedUpdateCameras();
            }
        });
    });
}

async function loadCameras() {
    console.log('Loading cameras...');
    setLoading(true);
    try {
        const response = await fetch('cameras.json');
        if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
        state.allCameras = await response.json();
        console.log(`Loaded ${state.allCameras.length} cameras`);
        DOM.pageSize.value = state.camerasPerPage;
        setupPagination();
        debouncedUpdateCameras();
    } catch (error) {
        console.error('Error loading cameras:', error);
        handleError(`Failed to load camera data: ${error.message}`);
    } finally {
        setLoading(false);
    }
}

loadCameras();