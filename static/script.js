// Объект конфигурации для констант и настроек
const CONFIG = {
    DEFAULT_CAMERAS_PER_PAGE: 12, // Количество камер на странице по умолчанию
    SELECTORS: {
        CONTAINER: '#container', // Селектор контейнера для карточек камер
        PAGE_SIZE: '#pageSize', // Селектор выпадающего меню количества камер
        PAGINATION_TOP: '#paginationTop', // Селектор верхней пагинации
        PAGINATION_BOTTOM: '#paginationBottom' // Селектор нижней пагинации
    },
    RETRY_ATTEMPTS: 3, // Количество попыток загрузки потока
    RETRY_DELAY_MS: 1000 // Задержка между попытками в миллисекундах
};

// Элементы DOM для быстрого доступа
const DOM = {
    container: document.querySelector(CONFIG.SELECTORS.CONTAINER), // Контейнер карточек камер
    pageSize: document.querySelector(CONFIG.SELECTORS.PAGE_SIZE), // Выпадающее меню количества камер
    paginationTop: document.querySelector(CONFIG.SELECTORS.PAGINATION_TOP), // Верхняя пагинация
    paginationBottom: document.querySelector(CONFIG.SELECTORS.PAGINATION_BOTTOM) // Нижняя пагинация
};

// Состояние приложения
let state = {
    allCameras: [], // Массив всех данных о камерах
    currentPage: 1, // Текущая страница
    camerasPerPage: CONFIG.DEFAULT_CAMERAS_PER_PAGE // Количество камер на странице
};

// Функция для ограничения частоты выполнения функции (debounce)
function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// Отображает сообщение об ошибке в DOM и логирует его в консоль
function handleError(message, element = document.body) {
    const errorDiv = document.createElement('div');
    errorDiv.className = 'error';
    errorDiv.textContent = message;
    element.appendChild(errorDiv);
    console.error(message);
}

// Переключает состояние загрузки, обновляя интерфейс
function setLoading(isLoading) {
    DOM.container.innerHTML = isLoading ? '<div class="loading">Загрузка камер...</div>' : '';
    DOM.pageSize.disabled = isLoading;
    DOM.paginationTop.style.pointerEvents = isLoading ? 'none' : 'auto';
    DOM.paginationBottom.style.pointerEvents = isLoading ? 'none' : 'auto';
}

// Декодирует HTML-сущности в строке
function decodeHtml(html) {
    const txt = document.createElement('textarea');
    txt.innerHTML = html;
    return txt.value;
}

// Проверяет объект камеры на наличие обязательных полей
function validateCamera(camera) {
    const requiredFields = ['id_user', 'devcode', 'stream_url'];
    const isValid = requiredFields.every(field => camera[field] !== undefined && camera[field] !== null);
    if (!isValid) {
        console.warn('Некорректная камера:', camera);
    }
    return isValid;
}

// Пытается загрузить видеопоток с повторными попытками при сбое
async function loadStreamWithRetry(hls, video, url, updateStatus) {
    for (let i = 0; i < CONFIG.RETRY_ATTEMPTS; i++) {
        try {
            console.log(`Попытка загрузки потока: ${url} (Попытка ${i + 1})`);
            hls.loadSource(url);
            hls.attachMedia(video);
            await new Promise((resolve, reject) => {
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    console.log(`Поток успешно загружен: ${url}`);
                    video.play().catch(error => {
                        console.error(`Ошибка воспроизведения для ${url}:`, error);
                        updateStatus('Воспроизведение заблокировано', true);
                    });
                    updateStatus('Онлайн');
                    resolve();
                });
                hls.on(Hls.Events.ERROR, (event, data) => {
                    console.error(`Ошибка HLS для ${url}:`, data);
                    if (data.fatal) reject(data);
                });
            });
            return;
        } catch (error) {
            console.error(`Попытка загрузки ${i + 1} не удалась для ${url}:`, error);
            if (i < CONFIG.RETRY_ATTEMPTS - 1) {
                await new Promise(res => setTimeout(res, CONFIG.RETRY_DELAY_MS * Math.pow(2, i)));
            } else {
                updateStatus(`Ошибка потока: ${error.type || 'Неизвестно'}`, true);
            }
        }
    }
}

// Создает карточку камеры с видеоплеером и метаданными
function createCameraCard(camera) {
    console.log('Создание карточки для камеры:', camera);
    const card = document.createElement('div');
    card.className = 'camera-card';
    
    // Секция информации о камере
    const info = document.createElement('div');
    info.className = 'camera-info';
    
    const nameElem = document.createElement('div');
    nameElem.className = 'camera-name';
    nameElem.textContent = decodeHtml(camera.name) || 'Безымянная камера';

    const idElem = document.createElement('div');
    idElem.className = 'camera-meta';
    idElem.textContent = `ID: ${camera.id_user}`;

    const devcodeElem = document.createElement('div');
    devcodeElem.className = 'camera-meta camera-devcode';
    devcodeElem.textContent = `Код: ${camera.devcode}`;

    const statusElem = document.createElement('div');
    statusElem.className = 'camera-status';
    statusElem.innerHTML = `
        <span class="status-indicator"></span>
        <span class="status-text">Подключение...</span>
    `;

    info.appendChild(nameElem);
    info.appendChild(idElem);
    info.appendChild(devcodeElem);
    info.appendChild(statusElem);

    // Контейнер и плеер для видео
    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-container';
    
    const video = document.createElement('video');
    video.controls = true;
    video.muted = true;

    // Обновляет индикатор и текст статуса камеры
    const updateStatus = (status, isError = false) => {
        statusElem.querySelector('.status-indicator').className = 
            `status-indicator${isError ? ' offline' : ''}`;
        statusElem.querySelector('.status-text').textContent = status;
        card.style.backgroundColor = isError ? '#3a1a1a' : '#2a2a2a';
        console.log(`Статус обновлен для ${camera.id_user}: ${status}${isError ? ' (Ошибка)' : ''}`);
    };

    let hls = null;
    let isDestroyed = false;

    // Очистка ресурсов видео и HLS
    const cleanup = () => {
        if (hls && !isDestroyed) {
            console.log(`Очистка HLS для ${camera.id_user}`);
            hls.destroy();
            isDestroyed = true;
        }
        video.pause();
        video.src = '';
        video.remove();
    };

    // Настройка потокового видео через HLS или нативную поддержку
    if (Hls.isSupported()) {
        hls = new Hls();
        loadStreamWithRetry(hls, video, camera.stream_url, updateStatus);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        console.log(`Использование нативного HLS для ${camera.stream_url}`);
        video.src = camera.stream_url;
        video.addEventListener('loadeddata', () => updateStatus('Онлайн'));
        video.addEventListener('error', (error) => {
            console.error(`Ошибка нативного HLS для ${camera.stream_url}:`, error);
            updateStatus('Оффлайн', true);
        });
    } else {
        console.warn(`Неподдерживаемый формат для ${camera.stream_url}`);
        updateStatus('Неподдерживаемый формат', true);
    }

    video.addEventListener('play', () => updateStatus('Онлайн'));
    video.addEventListener('waiting', () => updateStatus('Буферизация...'));

    videoContainer.appendChild(video);
    card.appendChild(videoContainer);
    card.appendChild(info);
    
    card.addEventListener('remove', cleanup);
    DOM.container.appendChild(card);
    console.log(`Карточка камеры добавлена в контейнер для ${camera.id_user}`);
}

// Дебаунс-функция для обновления отображаемых камер
const debouncedUpdateCameras = debounce(function updateCameras() {
    console.log(`Обновление камер для страницы ${state.currentPage}, ${state.camerasPerPage} на странице`);
    window.scrollTo(0, 0);
    DOM.container.innerHTML = '';
    
    // Вычисление среза камер для отображения
    const start = (state.currentPage - 1) * state.camerasPerPage;
    const end = start + state.camerasPerPage;
    const camerasToShow = state.allCameras.slice(start, end);
    console.log(`Камер для показа: ${camerasToShow.length}`);

    // Создание карточек для валидных камер
    camerasToShow.forEach(camera => {
        if (validateCamera(camera)) {
            createCameraCard(camera);
        } else {
            handleError(`Некорректные данные камеры: ${JSON.stringify(camera)}`, DOM.container);
        }
    });

    updatePaginationControls();
}, 100);

// Обновляет кнопки пагинации на основе общего числа страниц
function updatePaginationControls() {
    const totalPages = Math.ceil(state.allCameras.length / state.camerasPerPage);
    console.log(`Всего страниц: ${totalPages}`);
    
    const buttonsHTML = Array.from({ length: totalPages }, (_, index) => {
        const pageNumber = index + 1;
        const isActive = pageNumber === state.currentPage;
        return `<button data-page="${pageNumber}" ${isActive ? 'disabled class="active"' : ''}>${pageNumber}</button>`;
    }).join('');

    DOM.paginationTop.innerHTML = buttonsHTML;
    DOM.paginationBottom.innerHTML = buttonsHTML;
}

// Настройка обработчиков событий для пагинации и изменения количества камер
function setupPagination() {
    DOM.pageSize.addEventListener('change', (e) => {
        state.camerasPerPage = parseInt(e.target.value);
        state.currentPage = 1;
        console.log(`Размер страницы изменен на ${state.camerasPerPage}`);
        debouncedUpdateCameras();
    });

    [DOM.paginationTop, DOM.paginationBottom].forEach(pagination => {
        pagination.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON' && e.target.dataset.page) {
                state.currentPage = parseInt(e.target.dataset.page);
                console.log(`Страница изменена на ${state.currentPage}`);
                debouncedUpdateCameras();
            }
        });
    });
}

// Загружает данные о камерах из JSON-файла и инициализирует интерфейс
async function loadCameras() {
    console.log('Загрузка камер...');
    setLoading(true);
    try {
        const response = await fetch('cameras.json');
        if (!response.ok) throw new Error(`Ошибка HTTP! Статус: ${response.status}`);
        state.allCameras = await response.json();
        console.log(`Загружено ${state.allCameras.length} камер`);
        DOM.pageSize.value = state.camerasPerPage;
        setupPagination();
        debouncedUpdateCameras();
    } catch (error) {
        console.error('Ошибка загрузки камер:', error);
        handleError(`Не удалось загрузить данные камер: ${error.message}`);
    } finally {
        setLoading(false);
    }
}

// Инициализация приложения
loadCameras();