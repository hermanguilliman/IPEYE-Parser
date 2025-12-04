const CONFIG = {
    DEFAULT_CAMERAS_PER_PAGE: 12,
    SELECTORS: {
        CONTAINER: "#container",
        PAGE_SIZE: "#pageSize",
        PAGINATION_TOP: "#paginationTop",
        PAGINATION_BOTTOM: "#paginationBottom",
    },
    RETRY_ATTEMPTS: 3,
    RETRY_DELAY_MS: 1000,
};

const DOM = {
    container: document.querySelector(CONFIG.SELECTORS.CONTAINER),
    pageSize: document.querySelector(CONFIG.SELECTORS.PAGE_SIZE),
    paginationTop: document.querySelector(CONFIG.SELECTORS.PAGINATION_TOP),
    paginationBottom: document.querySelector(
        CONFIG.SELECTORS.PAGINATION_BOTTOM
    ),
};

let state = {
    allCameras: [],
    currentPage: 1,
    camerasPerPage: CONFIG.DEFAULT_CAMERAS_PER_PAGE,
};

let activePlayers = [];
let observer;

function initObserver() {
    if (observer) observer.disconnect();

    observer = new IntersectionObserver(
        (entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    const card = entry.target;
                    const video = card.querySelector("video");
                    const streamUrl = card.dataset.streamUrl;
                    const statusFn = card._updateStatus;

                    if (video && !video._hlsInit && streamUrl) {
                        initStream(video, streamUrl, statusFn);
                        video._hlsInit = true;
                        observer.unobserve(card);
                    }
                }
            });
        },
        {
            rootMargin: "100px",
        }
    );
}

function cleanupPage() {
    activePlayers.forEach((player) => {
        if (player.hls) {
            player.hls.destroy();
        }
        if (player.video) {
            player.video.pause();
            player.video.removeAttribute("src");
            player.video.load();
        }
    });
    activePlayers = [];
    DOM.container.innerHTML = "";
    if (observer) observer.disconnect();
    initObserver();
}

async function initStream(video, url, updateStatus) {
    if (Hls.isSupported()) {
        const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,
            backBufferLength: 30,
        });

        activePlayers.push({ hls, video });

        hls.loadSource(url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            video.play().catch(() => updateStatus("Autoplay blocked", true));
            updateStatus("Онлайн");
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        hls.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        hls.recoverMediaError();
                        break;
                    default:
                        updateStatus("Ошибка потока", true);
                        hls.destroy();
                        break;
                }
            }
        });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        video.addEventListener("loadedmetadata", () => video.play());
        video.addEventListener("error", () => updateStatus("Ошибка", true));
        activePlayers.push({ hls: null, video });
    }
}

function createCameraCard(camera) {
    const card = document.createElement("div");
    card.className = "camera-card";
    card.dataset.streamUrl = camera.stream_url;

    const info = document.createElement("div");
    info.className = "camera-info";
    info.innerHTML = `
        <div class="camera-name">${(camera.name || "Camera").replace(
            /</g,
            "&lt;"
        )}</div>
        <div class="camera-meta">ID: ${camera.id_user}</div>
        <div class="camera-status">
            <span class="status-indicator"></span>
            <span class="status-text">Ожидание...</span>
        </div>
    `;

    const videoContainer = document.createElement("div");
    videoContainer.className = "video-container";

    const video = document.createElement("video");
    video.controls = true;
    video.muted = true;
    video.playsInline = true;
    video.style.backgroundColor = "#000";

    videoContainer.appendChild(video);
    card.appendChild(videoContainer);
    card.appendChild(info);

    const statusElem = info.querySelector(".camera-status");
    card._updateStatus = (status, isError = false) => {
        const indicator = statusElem.querySelector(".status-indicator");
        const text = statusElem.querySelector(".status-text");
        if (indicator && text) {
            indicator.className = `status-indicator${
                isError ? " offline" : ""
            }`;
            text.textContent = status;
        }
    };

    observer.observe(card);
    return card;
}

function updateCameras() {
    cleanupPage();
    window.scrollTo(0, 0);

    const start = (state.currentPage - 1) * state.camerasPerPage;
    const end = start + state.camerasPerPage;
    const camerasToShow = state.allCameras.slice(start, end);

    const fragment = document.createDocumentFragment();

    camerasToShow.forEach((camera) => {
        if (camera.stream_url) {
            fragment.appendChild(createCameraCard(camera));
        }
    });

    DOM.container.appendChild(fragment);
    updatePaginationControls();
}

function updatePaginationControls() {
    const totalPages = Math.ceil(
        state.allCameras.length / state.camerasPerPage
    );
    const createBtn = (page) =>
        `<button data-page="${page}" ${
            page === state.currentPage ? 'disabled class="active"' : ""
        }>${page}</button>`;

    let btns = "";
    for (let i = 1; i <= totalPages; i++) {
        if (
            i === 1 ||
            i === totalPages ||
            (i >= state.currentPage - 2 && i <= state.currentPage + 2)
        ) {
            btns += createBtn(i);
        } else if (btns.slice(-3) !== "...") {
            btns += "...";
        }
    }

    DOM.paginationTop.innerHTML = btns;
    DOM.paginationBottom.innerHTML = btns;
}

DOM.pageSize.addEventListener("change", (e) => {
    state.camerasPerPage = parseInt(e.target.value);
    state.currentPage = 1;
    updateCameras();
});

[DOM.paginationTop, DOM.paginationBottom].forEach((el) => {
    el.addEventListener("click", (e) => {
        const btn = e.target.closest("button");
        if (btn && btn.dataset.page) {
            state.currentPage = parseInt(btn.dataset.page);
            updateCameras();
        }
    });
});

(async function init() {
    try {
        const res = await fetch("cameras.json");
        state.allCameras = await res.json();
        DOM.pageSize.value = state.camerasPerPage;
        initObserver();
        updateCameras();
    } catch (e) {
        DOM.container.innerHTML = `<div class="error">Ошибка загрузки: ${e.message}</div>`;
    }
})();
