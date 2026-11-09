const { app, BrowserWindow, Tray, Menu, globalShortcut, screen, nativeImage, shell, ipcMain, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let hookOn = false;         // 鼠标钩子是否已装上
let takeover = true;        // 是否接管任务栏时钟
let tray = null;
let quitting = false;
let currentHeight = 520;
let focused = false;
let shownAt = 0;
let anchorDisplayId = null;   // 面板钉在哪块屏：渲染期间改高度时不能按鼠标位置重新判断
let anchorBottom = null;      // 任务栏顶边：改高度时别把它丢掉，否则面板会往下滑盖住任务栏

const WIN_W = 376;

// ---- 诊断日志（每次启动重置，上限 600 行）----
const logDir = path.join(app.getPath('userData'), 'logs');
const logPath = path.join(logDir, 'hook.log');
let logLines = 0;
function initLog() {
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(logPath, '');
  } catch (e) { /* ignore */ }
}
function ovlog(msg) {
  if (logLines >= 600) return;
  logLines++;
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(logPath, new Date().toTimeString().slice(0, 8) + ' ' + msg + '\n');
  } catch (e) { /* 日志失败不影响功能 */ }
}

// ---- 偏好设置（目前只存「是否接管任务栏时钟」）----
const configPath = path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    // 记事本 / PowerShell 存出来的 JSON 可能带 BOM，不去掉的话 JSON.parse 直接抛
    const raw = fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
    const o = JSON.parse(raw);
    if (o && typeof o.takeover === 'boolean') takeover = o.takeover;
  } catch (e) {
    /* 首次运行、文件损坏都走默认值：接管 */
  }
}

function saveConfig() {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ takeover: takeover }, null, 2));
  } catch (e) {
    ovlog('save config failed: ' + e.message);
  }
}

// 任何意外都不该让整个应用退出
process.on('uncaughtException', (e) => {
  try {
    ovlog('UNCAUGHT ' + (e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e)));
  } catch (_) { /* ignore */ }
});

const clockHook = require('./hook');

function place(h, bottomLimit) {
  if (!win) return;
  currentHeight = h;
  if (typeof bottomLimit === 'number' && Number.isFinite(bottomLimit)) anchorBottom = bottomLimit;

  // 优先用打开面板时记住的那块屏：之后 fitHeight 触发改高度时鼠标多半已经移开，
  // 再用光标判断会让面板在双屏之间瞬移
  const displays = screen.getAllDisplays();
  let disp = anchorDisplayId == null ? null : displays.find((d) => d.id === anchorDisplayId);
  if (!disp) {
    disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    anchorDisplayId = disp.id;
  }

  const wa = disp.workArea;
  const x = Math.round(wa.x + wa.width - WIN_W - 12);
  // 任务栏升起时，弹窗要贴在它上方，别把时钟盖住
  const bottom = (typeof anchorBottom === 'number' && anchorBottom > wa.y + 100)
    ? anchorBottom
    : wa.y + wa.height;
  const y = Math.round(bottom - h - 12);
  win.setBounds({ x, y, width: WIN_W, height: h });
}

function createWindow() {
  win = new BrowserWindow({
    width: WIN_W,
    height: currentHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    skipTaskbar: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  win.loadFile('index.html');
  win.setAlwaysOnTop(true, 'pop-up-menu');

  win.on('show', () => { shownAt = Date.now(); });

  win.on('focus', () => { focused = true; });
  // 兜底：焦点被别的窗口抢走就收起（主判据是钩子给的 onOutside，这里避免误关）
  win.on('blur', () => {
    const hadFocus = focused;
    focused = false;
    if (!hadFocus) return;
    if (Date.now() - shownAt < 250) return;
    if (!quitting && win && win.isVisible()) {
      win.hide();
      ovlog('blur -> hide');
    }
  });

  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  win.webContents.on('did-finish-load', () => {
    // 只定位不显示：开机静默驻留托盘，点任务栏时钟或热键才弹出
    place(currentHeight);
    // 把窗口句柄交给钩子，它才能判断一次点击是在面板里还是面板外
    clockHook.setWindow(win.getNativeWindowHandle());
  });
}

function toggle() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    anchorDisplayId = null;      // 重新按当前光标所在屏定位
    anchorBottom = null;         // 任务栏这会儿可能已收起，别沿用上次的顶边
    place(currentHeight);
    win.show();
    win.focus();
    win.webContents.send('refresh');
  }
}

function startHook() {
  if (hookOn || !takeover) return;
  try {
    hookOn = clockHook.start({
      onClock: (trayTop) => {
        ovlog('clock click');
        openCalendar(Number.isFinite(trayTop) ? trayTop : undefined);
      },
      onOutside: () => {
        if (win && win.isVisible()) {
          win.hide();
          ovlog('outside -> hide');
        }
      }
    });
    ovlog(hookOn ? 'hook ready ' + JSON.stringify(clockHook.probe()) : 'hook install failed');
  } catch (e) {
    hookOn = false;
    ovlog('hook error: ' + e.message);
  }
}

function stopHook() {
  try { clockHook.stop(); } catch (e) { /* ignore */ }
  hookOn = false;
  ovlog('hook stopped');
}

function setTakeover(on) {
  takeover = !!on;
  saveConfig();
  if (takeover) startHook();
  else stopHook();
}

function openCalendar(trayTop) {
  if (!win) return;
  if (win.isVisible()) {              // 已经开着就收起，和系统日历行为一致
    win.hide();
    return;
  }
  anchorDisplayId = null;                 // 点时钟时以当时光标所在屏为准
  anchorBottom = Number.isFinite(trayTop) ? trayTop : null;
  place(currentHeight, anchorBottom === null ? undefined : anchorBottom);
  win.show();
  win.focus();
  win.webContents.send('refresh');
  ovlog('open at ' + JSON.stringify(win.getBounds()));
}

function buildTray() {
  const iconPath = path.join(__dirname, 'assets', 'tray.png');
  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('节假日日历');

  const menu = Menu.buildFromTemplate([
    { label: '打开日历', accelerator: 'Ctrl+Alt+C', click: () => toggle() },
    { type: 'separator' },
    {
      label: '接管任务栏时钟',
      type: 'checkbox',
      checked: takeover,
      click: (item) => setTakeover(item.checked)
    },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked })
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => toggle());
}

ipcMain.on('set-height', (e, h) => {
  const v = Math.max(240, Math.min(900, Math.round(h)));
  if (Math.abs(v - currentHeight) > 0.5) place(v);
});

ipcMain.on('hide', () => { if (win) win.hide(); });

ipcMain.on('open-url', (e, url) => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) shell.openExternal(url);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => toggle());

  app.whenReady().then(() => {
    initLog();
    loadConfig();               // 先恢复上次的开关状态，托盘菜单才勾得对
    ovlog('start v' + app.getVersion() + ' theme=' + (process.env.HOLIDAY_THEME || 'system') +
      ' takeover=' + takeover);
    app.setAppUserModelId('com.holidaycalendar.app');
    nativeTheme.themeSource = process.env.HOLIDAY_THEME || 'system';
    createWindow();
    buildTray();
    if (takeover) startHook();
    if (!globalShortcut.register('Control+Alt+C', toggle)) {
      ovlog('hotkey Ctrl+Alt+C 注册失败，可能被其它程序占用');
    }
    if (process.env.HOLIDAY_AUTOSHOW === '1') setTimeout(toggle, 900);
  });

  app.on('window-all-closed', () => {
    // 面板只做 hide、窗口从不真正销毁；注册这个监听器本身就是阻止 Electron 默认退出，
    // 事件对象上没有可用的 preventDefault
  });

  app.on('before-quit', () => {
    quitting = true;
    stopHook();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
