const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("path");
const fs = require("fs");

const defaultConfig = {
  apiBaseUrl: "http://192.168.3.113:8000",
  asbp: {
    mainUrl: "http://192.168.3.113:8000",
    externalPassPath: "/api/v1/external_pass",
    rfidPathTemplate: "/api/v1/pass/{pass_id}/rfid",
    terminalToken: ""
  },
  dispenser: {
    cardUrl: "http://192.168.3.159:8082/card"
  },
  window: {
    startMode: "fullscreen",
    fullscreen: true,
    kiosk: false
  },
  pollIntervalMs: 1500,
  maxFileSizeMb: 75,
  sessionTimeoutMs: 120000,
  idleWarningMs: 90000,
  camera: {
    preferredFacingMode: "environment",
    width: 1280,
    height: 720
  },
  debugSaveEnabled: false,
  logsPath: "./logs"
};

function readConfig() {
  const configPath = path.join(app.getAppPath(), "config", "default.json");

  try {
    return {
      ...defaultConfig,
      ...JSON.parse(fs.readFileSync(configPath, "utf8"))
    };
  } catch (error) {
    console.warn("Config was not loaded, using defaults:", error.message);
    return defaultConfig;
  }
}

function createWindow() {
  const config = readConfig();
  const windowConfig = { ...defaultConfig.window, ...config.window };
  const { workAreaSize } = screen.getPrimaryDisplay();
  const mainWindow = new BrowserWindow({
    width: windowConfig.width || workAreaSize.width,
    height: windowConfig.height || workAreaSize.height,
    minWidth: 360,
    minHeight: 640,
    backgroundColor: "#f4f7f9",
    title: "OCR-Терминал",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  if (windowConfig.kiosk) {
    mainWindow.setKiosk(true);
  } else if (windowConfig.fullscreen || windowConfig.startMode === "fullscreen") {
    mainWindow.setFullScreen(true);
  } else if (windowConfig.startMode === "maximized") {
    mainWindow.maximize();
  }

  mainWindow.loadFile(path.join(__dirname, "..", "src", "index.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("app:get-config", () => readConfig());
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
