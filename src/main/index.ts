import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'

import type { SystemInfo } from '../shared/types'
import { createRepositories } from './db/repositories'
import { openDatabase } from './db/database'
import { registerWorkbenchIpc, makePushHandlers } from './ipc'
import { Logger } from './logger'
import { AdapterRegistry } from './adapters/registry'
import { SettingsStore } from './settings'
import { WorkbenchService } from './services/workbenchService'
import { existsSync, mkdirSync } from 'node:fs'

/**
 * 主进程入口。
 *
 * 顺序刻意如此：先建日志与设置（都容错），再开数据库（失败降级为内存库并提示），
 * 最后才建窗口与 IPC —— 保证任何单点故障都不会让应用打不开。
 */
const DEV_ROOT = process.cwd()
const APP_ROOT = app.isPackaged ? app.getPath('userData') : DEV_ROOT

const DATA_DIR = join(APP_ROOT, 'data')
const LOG_DIR = join(APP_ROOT, 'logs')
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')
const DB_FILE = join(DATA_DIR, 'workbench.db')

let mainWindow: BrowserWindow | null = null

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

async function bootstrap(): Promise<void> {
  ensureDir(DATA_DIR)
  ensureDir(LOG_DIR)

  const logger = new Logger(join(LOG_DIR, 'workbench.log'), 'info')
  logger.info('应用启动', { appRoot: APP_ROOT, dataDir: DATA_DIR })

  const settings = new SettingsStore({ filePath: SETTINGS_FILE, projectRoot: APP_ROOT })
  ensureDir(settings.get().taskCwd)

  const database = openDatabase(DB_FILE)
  if (database.mode === 'memory-fallback') {
    logger.error('数据库降级为内存库', { detail: database.detail })
    dialog.showErrorBox(
      '数据库不可用（已降级）',
      `${database.detail}\n\n应用仍可继续使用，但任务记录在退出后不会保留。` +
        '请在「设置」页查看详情。'
    )
  }

  const repos = createRepositories(database.db)
  const registry = new AdapterRegistry({
    getSettings: () => settings.get(),
    allowRealCall: () => {
      const current = settings.get()
      if (!current.allowRealModelCalls) {
        return {
          allowed: false,
          reason:
            '真实模型调用总开关为关闭状态。请在「设置」页开启，并在任务页显式确认后执行。'
        }
      }
      return { allowed: true, reason: '' }
    }
  })

  const environment: Omit<SystemInfo, 'database' | 'sessionNote'> = {
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron ?? 'unknown',
    nodeVersion: process.versions.node,
    chromeVersion: process.versions.chrome ?? 'unknown',
    platform: `${process.platform} ${process.arch}`,
    userDataDir: app.getPath('userData'),
    logDir: LOG_DIR
  }

  const push = makePushHandlers(() => mainWindow)
  const service = new WorkbenchService({
    repos,
    registry,
    settings,
    logger,
    databaseInfo: {
      filePath: database.filePath,
      mode: database.mode,
      detail: database.detail,
      schemaVersion: database.schemaVersion
    },
    environment,
    onTaskChanged: push.onTaskChanged,
    onRunEvent: push.onRunEvent
  })

  const initResult = service.initialize()
  logger.info('服务初始化完成', initResult)

  registerWorkbenchIpc(service)
  createWindow()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    title: 'AI 多 Agent 工作台（第 3 步骨架）',
    backgroundColor: '#111318',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 不允许渲染层自己跳走或开新窗口；外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (url !== current) event.preventDefault()
  })

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(
  () => {
    void bootstrap().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      dialog.showErrorBox('启动失败', message)
      app.quit()
    })
  },
  (error: unknown) => {
    dialog.showErrorBox('启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  }
)

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
