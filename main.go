package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/AlecAivazis/survey/v2"
	"github.com/pkg/browser"
)

// Конфигурация приложения
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

// Основная структура приложения
type App struct {
	config      *Config
	deviceMgr   *DeviceManager
	webServer   *WebServer
	httpClient  *HTTPClient
	fileStorage *FileStorage
}

func NewApp() *App {
	cfg := &Config{
		AllDevicesURL:   "https://www.ipeye.ru/index.php?route=proc_cam_cart",
		DeviceInfoURL:   "https://ipeye.ru/webs/stream_info.php?devid=%s",
		DeviceStreamURL: "http://%s/api/v1/stream/%s/hls/index.m3u8",
		DataFile:        "./static/cameras.json",
		Workers:         10,
		RequestTimeout:  10 * time.Second,
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

// Управление устройствами
type DeviceManager struct {
	config     *Config
	httpClient *HTTPClient
	storage    *FileStorage
}

func NewDeviceManager(cfg *Config) *DeviceManager {
	return &DeviceManager{
		config:     cfg,
		httpClient: NewHTTPClient(cfg),
		storage:    NewFileStorage(cfg.DataFile),
	}
}

// Веб-сервер
type WebServer struct {
	config   *Config
	devices  func() ([]*Device, error)
	stopChan chan struct{}
}

func NewWebServer(cfg *Config) *WebServer {
	return &WebServer{
		config:   cfg,
		stopChan: make(chan struct{}),
	}
}

// HTTP клиент с настройками
type HTTPClient struct {
	client *http.Client
	cfg    *Config
}

func NewHTTPClient(cfg *Config) *HTTPClient {
	return &HTTPClient{
		client: &http.Client{Timeout: cfg.RequestTimeout},
		cfg:    cfg,
	}
}

// Файловое хранилище
type FileStorage struct {
	filename string
}

func NewFileStorage(filename string) *FileStorage {
	return &FileStorage{filename: filename}
}

// Модели данных
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

	for {
		action, err := app.ShowMenu()
		if err != nil {
			log.Fatalf("Ошибка меню: %v", err)
		}

		switch action {
		case "Обновить камеры":
			if err := app.deviceMgr.Update(); err != nil {
				log.Printf("Ошибка обновления камер: %v", err)
			}
		case "Просмотр камер":
			if err := app.webServer.Start(app.deviceMgr.GetDevices); err != nil {
				log.Printf("Ошибка запуска сервера: %v", err)
			}
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
	a.webServer.devices = a.deviceMgr.GetDevices
}

func (a *App) ShowMenu() (string, error) {
	var result string
	prompt := &survey.Select{
		Message: "*** IPEYE камеры ***\n\nВыберите действие:",
		Options: []string{"Обновить камеры", "Просмотр камер", "Выйти"},
	}
	survey.AskOne(prompt, &result)
	return result, nil
}

func (a *App) waitForInput() {
	fmt.Println("Нажмите Enter для возврата в меню...")
	_, _ = fmt.Scanln()
	a.webServer.Stop()
}

// Методы DeviceManager
func (m *DeviceManager) Update() error {
	if !m.storage.Exists() {
		if err := m.downloadAllDevices(); err != nil {
			return fmt.Errorf("ошибка загрузки устройств: %w", err)
		}
	}

	devices, err := m.storage.Load()
	if err != nil {
		return fmt.Errorf("ошибка загрузки камер: %w", err)
	}

	m.processDevices(devices)

	if err := m.storage.Save(devices); err != nil {
		return fmt.Errorf("ошибка сохранения камер: %w", err)
	}

	fmt.Println("Камеры успешно обновлены!")
	return nil
}

func (m *DeviceManager) GetDevices() ([]*Device, error) {
	return m.storage.Load()
}

func (m *DeviceManager) processDevices(devices []*Device) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	ch := make(chan *Device, len(devices))
	var wg sync.WaitGroup

	for i := 0; i < m.config.Workers; i++ {
		wg.Add(1)
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
			break
		}
		log.Printf("Attempt %d failed for %s: %v", attempt+1, device.Devcode, err)
	}
}

func (m *DeviceManager) getDeviceServer(ctx context.Context, devcode string) (string, error) {
	url := fmt.Sprintf(m.config.DeviceInfoURL, devcode)
	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	req.Header.Set("User-Agent", m.config.UserAgent)

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var info DeviceInfo
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return "", err
	}

	if info.Server == "" {
		return "", fmt.Errorf("empty server in response")
	}

	return info.Server, nil
}

// Методы FileStorage
func (s *FileStorage) Exists() bool {
	info, err := os.Stat(s.filename)
	return !os.IsNotExist(err) && !info.IsDir()
}

func (s *FileStorage) Save(devices []*Device) error {
	data, err := json.MarshalIndent(devices, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal error: %w", err)
	}

	tmpFile := s.filename + ".tmp"
	if err := os.WriteFile(tmpFile, data, 0644); err != nil {
		return fmt.Errorf("write temp file error: %w", err)
	}

	return os.Rename(tmpFile, s.filename)
}

func (s *FileStorage) Load() ([]*Device, error) {
	data, err := os.ReadFile(s.filename)
	if err != nil {
		return nil, fmt.Errorf("read file error: %w", err)
	}

	var devices []*Device
	if err := json.Unmarshal(data, &devices); err != nil {
		return nil, fmt.Errorf("unmarshal error: %w", err)
	}

	return devices, nil
}

// Методы WebServer
func (s *WebServer) Start(getDevices func() ([]*Device, error)) error {
	http.HandleFunc("/cameras", func(w http.ResponseWriter, r *http.Request) {
		devices, err := getDevices()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(devices)
	})

	http.Handle("/", http.FileServer(http.Dir("./static")))

	fmt.Printf("Запуск веб-сервера на http://localhost%s\n", s.config.WebServerPort)
	go func() {
		if err := http.ListenAndServe(s.config.WebServerPort, nil); err != nil {
			log.Printf("Ошибка сервера: %v", err)
		}
	}()

	return browser.OpenURL("http://localhost" + s.config.WebServerPort + "/index.html")
}

func (s *WebServer) Stop() {
	close(s.stopChan)
}

// Методы HTTPClient
func (c *HTTPClient) Do(req *http.Request) (*http.Response, error) {
	return c.client.Do(req)
}

func (m *DeviceManager) downloadAllDevices() error {
	req, _ := http.NewRequest("GET", m.config.AllDevicesURL, nil)
	req.Header.Set("User-Agent", m.config.UserAgent)
	req.Header.Set("Accept", "application/json")

	resp, err := m.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request error: %w", err)
	}
	defer resp.Body.Close()

	rawBody, _ := io.ReadAll(resp.Body)
	var devices []*Device
	if err := json.Unmarshal(rawBody, &devices); err != nil {
		return fmt.Errorf("decode error: %w", err)
	}

	return m.storage.Save(devices)
}
