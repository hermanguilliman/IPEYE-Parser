package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/AlecAivazis/survey/v2"
	"github.com/pkg/browser"
)

type Config struct {
	AllDevicesURL   string
	DeviceInfoURL   string
	DeviceStreamURL string
	DataFile        string
	Workers         int
	RequestTimeout  time.Duration
	Retries         int
	WebServerPort   string
	UserAgent       string
}

type App struct {
	config      *Config
	deviceMgr   *DeviceManager
	webServer   *WebServer
	httpClient  *HTTPClient
	fileStorage *FileStorage

	devicesCache []*Device
	cacheMutex   sync.RWMutex
}

func NewApp() *App {
	cfg := &Config{
		AllDevicesURL:   "https://www.ipeye.ru/index.php?route=proc_cam_cart",
		DeviceInfoURL:   "https://ipeye.ru/webs/stream_info.php?devid=%s",
		DeviceStreamURL: "http://%s/api/v1/stream/%s/hls/index.m3u8",
		DataFile:        "./static/cameras.json",
		Workers:         50,
		RequestTimeout:  15 * time.Second,
		Retries:         3,
		WebServerPort:   ":8080",
		UserAgent:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
	}

	return &App{
		config:      cfg,
		httpClient:  NewHTTPClient(cfg),
		fileStorage: NewFileStorage(cfg.DataFile),
		deviceMgr:   NewDeviceManager(cfg),
		webServer:   NewWebServer(cfg),
	}
}

type HTTPClient struct {
	client *http.Client
	cfg    *Config
}

func NewHTTPClient(cfg *Config) *HTTPClient {

	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   30 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   100,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   10 * time.Second,
		ExpectContinueTimeout: 1 * time.Second,
	}

	return &HTTPClient{
		client: &http.Client{
			Timeout:   cfg.RequestTimeout,
			Transport: transport,
		},
		cfg: cfg,
	}
}

type DeviceManager struct {
	config     *Config
	httpClient *HTTPClient
	storage    *FileStorage
	app        *App
}

func NewDeviceManager(cfg *Config) *DeviceManager {
	return &DeviceManager{config: cfg}
}

type WebServer struct {
	config   *Config
	app      *App
	server   *http.Server
	stopChan chan struct{}
}

func NewWebServer(cfg *Config) *WebServer {
	return &WebServer{
		config:   cfg,
		stopChan: make(chan struct{}),
	}
}

type FileStorage struct {
	filename string
}

func NewFileStorage(filename string) *FileStorage {
	return &FileStorage{filename: filename}
}

type Device struct {
	IDUser    string `json:"id_user"`
	Devcode   string `json:"devcode"`
	Name      string `json:"name"`
	StreamURL string `json:"stream_url,omitempty"`
}

type DeviceInfo struct {
	Server string `json:"server"`
}

func main() {
	app := NewApp()
	app.InitDependencies()

	if err := app.LoadCache(); err != nil {
		log.Printf("Предупреждение: кэш не загружен (возможно, первый запуск): %v", err)
	}

	for {
		action, err := app.ShowMenu()
		if err != nil {
			log.Fatalf("Ошибка меню: %v", err)
		}

		switch action {
		case "Обновить камеры":
			start := time.Now()
			if err := app.deviceMgr.Update(); err != nil {
				log.Printf("Ошибка обновления камер: %v", err)
			} else {
				log.Printf("Обновление завершено за %v", time.Since(start))
			}
		case "Просмотр камер":

			go func() {
				if err := app.webServer.Start(); err != nil && err != http.ErrServerClosed {
					log.Printf("Ошибка сервера: %v", err)
				}
			}()

			time.Sleep(500 * time.Millisecond)
			_ = browser.OpenURL("http://localhost" + app.config.WebServerPort + "/index.html")

			app.waitForInput()
		case "Выйти":
			app.webServer.Stop()
			os.Exit(0)
		}
	}
}

func (a *App) InitDependencies() {
	a.deviceMgr.httpClient = a.httpClient
	a.deviceMgr.storage = a.fileStorage
	a.deviceMgr.app = a
	a.webServer.app = a
}

func (a *App) LoadCache() error {
	devices, err := a.fileStorage.Load()
	if err != nil {
		return err
	}
	a.cacheMutex.Lock()
	a.devicesCache = devices
	a.cacheMutex.Unlock()
	return nil
}

func (a *App) ShowMenu() (string, error) {
	var result string
	prompt := &survey.Select{
		Message: "*** IPEYE камеры ***\n\nВыберите действие:",
		Options: []string{"Обновить камеры", "Просмотр камер", "Выйти"},
	}
	if err := survey.AskOne(prompt, &result); err != nil {
		return "", fmt.Errorf("ошибка ввода: %w", err)
	}
	return result, nil
}

func (a *App) waitForInput() {
	fmt.Println("Сервер запущен. Нажмите Enter для остановки и возврата в меню...")
	_, _ = fmt.Scanln()
	a.webServer.Stop()
}

func (m *DeviceManager) Update() error {
	fmt.Println("Загрузка списка устройств...")

	if err := m.downloadAllDevices(); err != nil {
		log.Printf("Не удалось скачать общий список, пробуем использовать локальный: %v", err)
	}

	devices, err := m.storage.Load()
	if err != nil {
		return fmt.Errorf("ошибка загрузки камер с диска: %w", err)
	}

	fmt.Printf("Найдено %d устройств. Начинаем проверку потоков...\n", len(devices))
	m.processDevices(devices)

	if err := m.storage.Save(devices); err != nil {
		return fmt.Errorf("ошибка сохранения камер: %w", err)
	}

	m.app.cacheMutex.Lock()
	m.app.devicesCache = devices
	m.app.cacheMutex.Unlock()

	fmt.Println("Камеры успешно обновлены!")
	return nil
}

func (m *DeviceManager) processDevices(devices []*Device) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := make(chan *Device, len(devices))
	var wg sync.WaitGroup

	workers := m.config.Workers
	wg.Add(workers)

	for i := 0; i < workers; i++ {
		go func() {
			defer wg.Done()
			for device := range ch {
				m.processSingleDevice(ctx, device)
			}
		}()
	}

	for _, d := range devices {
		ch <- d
	}
	close(ch)
	wg.Wait()
}

func (m *DeviceManager) processSingleDevice(ctx context.Context, device *Device) {

	for attempt := 0; attempt < m.config.Retries; attempt++ {
		server, err := m.getDeviceServer(ctx, device.Devcode)
		if err == nil {
			device.StreamURL = fmt.Sprintf(m.config.DeviceStreamURL, server, device.Devcode)
			return
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Duration(attempt+1) * 100 * time.Millisecond):
		}
	}

}

func (m *DeviceManager) getDeviceServer(ctx context.Context, devcode string) (string, error) {
	url := fmt.Sprintf(m.config.DeviceInfoURL, devcode)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("User-Agent", m.config.UserAgent)

	resp, err := m.httpClient.client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() {

		_, _ = io.Copy(io.Discard, resp.Body)
		if err := resp.Body.Close(); err != nil {
			log.Printf("Ошибка закрытия тела ответа: %v", err)
		}
	}()

	if resp.StatusCode != 200 {
		return "", fmt.Errorf("status code %d", resp.StatusCode)
	}

	var info DeviceInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", err
	}

	if info.Server == "" {
		return "", fmt.Errorf("empty server")
	}

	return info.Server, nil
}

func (m *DeviceManager) downloadAllDevices() error {
	req, err := http.NewRequest("GET", m.config.AllDevicesURL, nil)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("User-Agent", m.config.UserAgent)
	req.Header.Set("Accept", "application/json")

	resp, err := m.httpClient.client.Do(req)
	if err != nil {
		return fmt.Errorf("request error: %w", err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		if err := resp.Body.Close(); err != nil {
			log.Printf("Ошибка закрытия тела ответа: %v", err)
		}
	}()

	var devices []*Device
	if err := json.NewDecoder(resp.Body).Decode(&devices); err != nil {
		return fmt.Errorf("decode error: %w", err)
	}

	return m.storage.Save(devices)
}

func (s *FileStorage) Exists() bool {
	info, err := os.Stat(s.filename)
	return !os.IsNotExist(err) && !info.IsDir()
}

func (s *FileStorage) Save(devices []*Device) error {
	tmpFile := s.filename + ".tmp"
	f, err := os.Create(tmpFile)
	if err != nil {
		return err
	}

	success := false
	defer func() {
		if !success {
			if cerr := f.Close(); cerr != nil {
				log.Printf("Ошибка закрытия временного файла: %v", cerr)
			}
			_ = os.Remove(tmpFile)
		}
	}()

	enc := json.NewEncoder(f)
	enc.SetIndent("", "  ")
	if err := enc.Encode(devices); err != nil {
		return err
	}

	if err := f.Close(); err != nil {
		return fmt.Errorf("ошибка закрытия файла: %w", err)
	}

	success = true
	return os.Rename(tmpFile, s.filename)
}

func (s *FileStorage) Load() ([]*Device, error) {
	f, err := os.Open(s.filename)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err := f.Close(); err != nil {
			log.Printf("Ошибка закрытия файла %s: %v", s.filename, err)
		}
	}()

	var devices []*Device
	if err := json.NewDecoder(f).Decode(&devices); err != nil {
		return nil, err
	}
	return devices, nil
}

func (s *WebServer) Start() error {
	mux := http.NewServeMux()

	mux.HandleFunc("/cameras", func(w http.ResponseWriter, r *http.Request) {

		s.app.cacheMutex.RLock()
		devices := s.app.devicesCache
		s.app.cacheMutex.RUnlock()

		if devices == nil {

			var err error
			devices, err = s.app.fileStorage.Load()
			if err != nil {
				http.Error(w, err.Error(), http.StatusInternalServerError)
				return
			}
		}

		w.Header().Set("Content-Type", "application/json")

		if err := json.NewEncoder(w).Encode(devices); err != nil {
			log.Printf("Ошибка отправки JSON: %v", err)
		}
	})

	fs := http.FileServer(http.Dir("./static"))
	mux.Handle("/", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "public, max-age=3600")
		fs.ServeHTTP(w, r)
	}))

	s.server = &http.Server{
		Addr:    s.config.WebServerPort,
		Handler: mux,
	}

	fmt.Printf("Веб-сервер слушает на %s\n", s.config.WebServerPort)
	return s.server.ListenAndServe()
}

func (s *WebServer) Stop() {
	if s.server != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if err := s.server.Shutdown(ctx); err != nil {
			log.Printf("Ошибка при остановке сервера: %v", err)
		}
	}
	close(s.stopChan)
}
