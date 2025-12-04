// Конфигурация приложения
const CONFIG = {
    DEFAULT_CAMERAS_PER_PAGE: 12,
    SELECTORS: {
        CONTAINER: '#container',
        PAGE_SIZE: '#pageSize',
        PAGINATION_TOP: '#paginationTop',
        PAGINATION_BOTTOM: '#paginationBottom'
    },
    // Настройки HLS.js для производительности
    HLS_CONFIG: {
        enableWorker: true,       // Использовать WebWorker для декодирования
        lowLatencyMode: true,     // Режим низкой задержки
        backBufferLength: 30,     // Хранить не более 30 сек назад (экономия RAM)
        maxBufferLength: 10,      // Буферизировать не более 10 сек вперед
    }
};

// Ссылки на DOM элементы
const DOM = {
    container: document.querySelector(CONFIG.SELECTORS.CONTAINER),
    pageSize: document.querySelector(CONFIG.SELECTORS.PAGE_SIZE),
    paginationTop: document.querySelector(CONFIG.SELECTORS.PAGINATION_TOP),
    paginationBottom: document.querySelector(CONFIG.SELECTORS.PAGINATION_BOTTOM)
};

// Состояние приложения
let state = {
    allCameras: [],
    currentPage: 1,
    camerasPerPage: CONFIG.DEFAULT_CAMERAS_PER_PAGE
};

// Глобальные переменные для управления ресурсами
let activePlayers = []; // Хранит ссылки на плееры для очистки памяти
let observer;           // IntersectionObserver для ленивой загрузки

// --- 1. Управление ресурсами и очистка ---

/**
 * Инициализирует Observer.
 * Он следит за карточками камер. Когда карточка появляется на экране,
 * запускается загрузка видео. Если карточка уходит — видео не останавливается 
 * (чтобы не дергалось при скролле), но изначально оно не грузится.
 */
function initObserver() {
    if (observer) observer.disconnect();

    observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const card = entry.target;
                const video = card.querySelector('video');
                const streamUrl = card.dataset.streamUrl;
                
                // Функция обновления статуса, привязанная к карточке
                const updateStatus = card._updateStatus;

                // Запускаем поток только если он еще не запущен
                if (video && !video._hlsInit && streamUrl) {
                    initStream(video, streamUrl, updateStatus);
                    video._hlsInit = true; // Помечаем как инициализированный
                    observer.unobserve(card); // Перестаем следить за этой карточкой
                }
            }
        });
    }, {
        rootMargin: '200px' // Начинать загрузку за 200px до появления на экране
    });
}

/**
 * Полная очистка страницы перед сменой контента.
 * Критически важна для предотвращения утечек памяти браузера.
 */
function cleanupPage() {
    // 1. Уничтожаем все экземпляры HLS и очищаем теги video
    activePlayers.forEach(player => {
        if (player.hls) {
            player.hls.destroy(); // Останавливаем загрузку фрагментов и воркеры
        }
        if (player.video) {
            player.video.pause();
            player.video.removeAttribute('src'); // Разрываем связь с буфером
            player.video.load(); // Форсируем сброс медиа-движка
        }
    });
    activePlayers = []; // Очищаем массив

    // 2. Очищаем DOM
    DOM.container.innerHTML = '';

    // 3. Перезапускаем Observer
    if (observer) {
        observer.disconnect();
        initObserver();
    }
}

// --- 2. Логика видео (HLS) ---

/**
 * Инициализация потока для конкретного видео-элемента
 */
async function initStream(video, url, updateStatus) {
    updateStatus('Загрузка потока...');

    if (Hls.isSupported()) {
        const hls = new Hls(CONFIG.HLS_CONFIG);
        
        // Сохраняем ссылку на плеер для последующей очистки
        activePlayers.push({ hls, video });

        hls.loadSource(url);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            const playPromise = video.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.warn('Autoplay blocked:', error);
                    updateStatus('Нажмите Play', true);
                });
            }
            updateStatus('Онлайн');
        });

        // Обработка ошибок HLS (восстановление при сбоях сети)
        hls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
                switch (data.type) {
                    case Hls.ErrorTypes.NETWORK_ERROR:
                        console.log('Network error, recovering...');
                        hls.startLoad();
                        break;
                    case Hls.ErrorTypes.MEDIA_ERROR:
                        console.log('Media error, recovering...');
                        hls.recoverMediaError();
                        break;
                    default:
                        console.error('Fatal error:', data);
                        updateStatus('Ошибка потока', true);
                        hls.destroy();
                        break;
                }
            }
        });

    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Для Safari (нативная поддержка HLS)
        video.src = url;
        video.addEventListener('loadedmetadata', () => {
            video.play();
            updateStatus('Онлайн');
        });
        video.addEventListener('error', () => updateStatus('Ошибка (Native)', true));
        
        // Сохраняем только видео элемент, так как hls инстанса нет
        activePlayers.push({ hls: null, video });
    } else {
        updateStatus('Не поддерживается', true);
    }
}

// --- 3. Рендеринг интерфейса ---

/**
 * Создает DOM-элемент карточки камеры
 */
function createCameraCard(camera) {
    const card = document.createElement('div');
    card.className = 'camera-card';
    // Сохраняем URL в dataset, чтобы Observer мог его прочитать
    card.dataset.streamUrl = camera.stream_url;

    // Безопасное экранирование имени
    const safeName = (camera.name || 'Без названия')
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const info = document.createElement('div');
    info.className = 'camera-info';
    info.innerHTML = `
        <div class="camera-name" title="${safeName}">${safeName}</div>
        <div class="camera-meta">ID: ${camera.id_user}</div>
        <div class="camera-meta camera-devcode">Код: ${camera.devcode}</div>
        <div class="camera-status">
            <span class="status-indicator"></span>
            <span class="status-text">Ожидание видимости...</span>
        </div>
    `;

    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-container';
    
    const video = document.createElement('video');
    video.controls = true;
    video.muted = true; // Важно для автовоспроизведения
    video.playsInline = true;
    video.poster = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSI5IiB2aWV3Qm94PSIwIDAgMTYgOSI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjkiIGZpbGw9IiMyMjIiLz48L3N2Zz4="; // Серый фон

    videoContainer.appendChild(video);
    card.appendChild(videoContainer);
    card.appendChild(info);

    // Хелпер для обновления статуса в UI
    const statusElem = info.querySelector('.camera-status');
    const indicator = statusElem.querySelector('.status-indicator');
    const statusText = statusElem.querySelector('.status-text');

    card._updateStatus = (text, isError = false) => {
        if (indicator && statusText) {
            indicator.className = `status-indicator${isError ? ' offline' : ''}`;
            statusText.textContent = text;
            if (isError) {
                // card.style.opacity = '0.7'; // Визуально гасим ошибочные
            }
        }
    };

    // Добавляем карточку в список наблюдения Observer'а
    observer.observe(card);

    return card;
}

/**
 * Основная функция обновления списка камер на странице
 */
function updateCameras() {
    // 1. Очищаем старое
    cleanupPage();
    window.scrollTo(0, 0);

    // 2. Вычисляем диапазон
    const start = (state.currentPage - 1) * state.camerasPerPage;
    const end = start + state.camerasPerPage;
    const camerasToShow = state.allCameras.slice(start, end);

    if (camerasToShow.length === 0) {
        DOM.container.innerHTML = '<div class="error">Нет камер для отображения</div>';
        return;
    }

    // 3. Создаем элементы в памяти (DocumentFragment) для минимизации перерисовок
    const fragment = document.createDocumentFragment();

    camerasToShow.forEach(camera => {
        // Пропускаем камеры без URL потока
        if (camera.stream_url && camera.stream_url.trim() !== "") {
            const card = createCameraCard(camera);
            fragment.appendChild(card);
        }
    });

    // 4. Вставляем всё в DOM одним махом
    DOM.container.appendChild(fragment);

    // 5. Обновляем пагинацию
    updatePaginationControls();
}

/**
 * Отрисовка кнопок пагинации с логикой "умного" скрытия (...)
 */
function updatePaginationControls() {
    const totalPages = Math.ceil(state.allCameras.length / state.camerasPerPage);
    
    const createButton = (page) => {
        const isActive = page === state.currentPage;
        return `<button data-page="${page}" ${isActive ? 'disabled class="active"' : ''}>${page}</button>`;
    };

    let paginationHTML = '';
    
    // Алгоритм отображения страниц: 1 ... [текущая-1] [текущая] [текущая+1] ... Последняя
    const range = 2; // Сколько страниц показывать вокруг текущей

    for (let i = 1; i <= totalPages; i++) {
        // Всегда показываем первую, последнюю и диапазон вокруг текущей
        if (i === 1 || i === totalPages || (i >= state.currentPage - range && i <= state.currentPage + range)) {
            paginationHTML += createButton(i);
        } else if (
            (i === state.currentPage - range - 1 && i > 1) || 
            (i === state.currentPage + range + 1 && i < totalPages)
        ) {
            paginationHTML += `<span style="color: white; padding: 0 5px;">...</span>`;
        }
    }

    if (totalPages <= 1) paginationHTML = '';

    DOM.paginationTop.innerHTML = paginationHTML;
    DOM.paginationBottom.innerHTML = paginationHTML;
}

// --- 4. Обработчики событий ---

// Изменение количества камер на странице
DOM.pageSize.addEventListener('change', (e) => {
    state.camerasPerPage = parseInt(e.target.value);
    state.currentPage = 1; // Сброс на первую страницу
    updateCameras();
});

// Обработка кликов по пагинации (делегирование событий)
function handlePaginationClick(e) {
    const btn = e.target.closest('button');
    if (btn && btn.dataset.page) {
        state.currentPage = parseInt(btn.dataset.page);
        updateCameras();
    }
}

DOM.paginationTop.addEventListener('click', handlePaginationClick);
DOM.paginationBottom.addEventListener('click', handlePaginationClick);

// --- 5. Инициализация приложения ---

async function loadCameras() {
    DOM.container.innerHTML = '<div class="loading">Загрузка списка камер...</div>';
    
    try {
        // Добавляем timestamp, чтобы избежать кэширования JSON браузером при обновлении
        const response = await fetch(`cameras.json?t=${new Date().getTime()}`);
        
        if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
        
        const data = await response.json();
        
        if (!Array.isArray(data)) throw new Error('Некорректный формат данных (ожидался массив)');

        state.allCameras = data;
        
        // Устанавливаем значение селектора
        DOM.pageSize.value = state.camerasPerPage;

        console.log(`Загружено ${state.allCameras.length} камер.`);
        
        // Первая инициализация Observer
        initObserver();
        // Первый рендер
        updateCameras();

    } catch (error) {
        console.error('Ошибка инициализации:', error);
        DOM.container.innerHTML = `<div class="error">Ошибка загрузки данных:<br>${error.message}</div>`;
    }
}

// Запуск
loadCameras();