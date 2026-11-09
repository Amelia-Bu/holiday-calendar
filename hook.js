'use strict';
/*
 * 任务栏时钟点击拦截 + 面板外部点击监视（纯 JS，靠 koffi 调 Win32）。
 *
 * 用 WH_MOUSE_LL 低级鼠标钩子监听全局左/右键：
 *   - 点击落在任务栏右端的时间区域 -> 吞掉这次点击，回调 onClock(trayTop)
 *   - 日历面板可见时，点击落在面板之外 -> 回调 onOutside()，但**不吞**这次点击
 *
 * 任务栏不止一个：主屏是 Shell_TrayWnd，副屏是 Shell_SecondaryTrayWnd，
 * 两边都要能点。命中判定同时校验横纵坐标，否则任务栏升起时连右上角的
 * 关闭按钮都会被当成时钟。
 *
 * 低级鼠标钩子是系统特例：回调在安装它的线程（Electron 主进程的 UI 线程）
 * 里执行，不需要写 DLL、不需要管理员权限，也不改任何系统文件。
 */

const koffi = require('koffi');

const WH_MOUSE_LL = 14;
const HC_ACTION = 0;
const WM_LBUTTONDOWN = 0x0201;
const WM_RBUTTONDOWN = 0x0204;

const HOT_W = 132;            // 时钟热区：任务栏右边缘往左这么多像素
const TASKBAR_MAX_H = 90;     // 任务栏最大厚度，超出说明是竖排或异常，不接管
const TASKBAR_MIN_SHOWN = 20; // 露在屏幕内不足这么多像素，视为处于收起状态
const WIN_PAD = 1;            // 命中面板时允许的像素容差
const MONITOR_DEFAULTTONEAREST = 2;
const MONITORINFO_SIZE = 40;  // cbSize 必须是结构体真实大小：4 + 16 + 16 + 4

let ffi = null;
let hookHandle = 0;
let callbackPtr = null;
let rectBuf = null;
let monBuf = null;
let winHwnd = 0;
let handlers = { onClock: null, onOutside: null };

function setup() {
  if (ffi) return ffi;

  koffi.struct('POINT', { x: 'int32', y: 'int32' });
  koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
  koffi.struct('MSLLHOOKSTRUCT', {
    pt: 'POINT',
    mouseData: 'uint32',
    flags: 'uint32',
    time: 'uint32',
    dwExtraInfo: 'uintptr_t'
  });
  koffi.struct('MONITORINFO', {
    cbSize: 'uint32',
    rcMonitor: 'RECT',
    rcWork: 'RECT',
    dwFlags: 'uint32'
  });

  const u = koffi.load('user32.dll');
  ffi = {
    FindWindowW: u.func('uintptr_t __stdcall FindWindowW(str16 cls, str16 title)'),
    FindWindowExW: u.func('uintptr_t __stdcall FindWindowExW(uintptr_t parent, uintptr_t after, str16 cls, str16 title)'),
    GetWindowRect: u.func('bool __stdcall GetWindowRect(uintptr_t hwnd, void *rect)'),
    IsWindowVisible: u.func('bool __stdcall IsWindowVisible(uintptr_t hwnd)'),
    GetSystemMetrics: u.func('int __stdcall GetSystemMetrics(int index)'),
    MonitorFromWindow: u.func('uintptr_t __stdcall MonitorFromWindow(uintptr_t hwnd, uint32_t flags)'),
    GetMonitorInfoW: u.func('bool __stdcall GetMonitorInfoW(uintptr_t hmon, void *info)'),
    SetWindowsHookExW: u.func('uintptr_t __stdcall SetWindowsHookExW(int id, void *proc, uintptr_t hmod, uint32_t tid)'),
    CallNextHookEx: u.func('intptr_t __stdcall CallNextHookEx(uintptr_t hhk, int code, uintptr_t wParam, void *lParam)'),
    UnhookWindowsHookEx: u.func('bool __stdcall UnhookWindowsHookEx(uintptr_t hhk)')
  };

  rectBuf = koffi.alloc('RECT', 1);
  monBuf = koffi.alloc('MONITORINFO', 1);
  koffi.encode(monBuf, 'MONITORINFO', {
    cbSize: MONITORINFO_SIZE,
    rcMonitor: { left: 0, top: 0, right: 0, bottom: 0 },
    rcWork: { left: 0, top: 0, right: 0, bottom: 0 },
    dwFlags: 0
  });
  return ffi;
}

function readRect(hwnd) {
  if (!ffi.GetWindowRect(hwnd, rectBuf)) return null;
  const r = koffi.decode(rectBuf, 'RECT');
  if (r.right <= r.left || r.bottom <= r.top) return null;
  return r;
}

function monitorRect(hwnd) {
  const hmon = ffi.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
  if (!hmon) return null;
  if (!ffi.GetMonitorInfoW(hmon, monBuf)) return null;
  return koffi.decode(monBuf, 'MONITORINFO').rcMonitor;
}

/** 主任务栏 + 所有副屏任务栏。explorer 重启后句柄会变，所以每次点击都重新枚举。 */
function taskbarList() {
  const list = [];
  const main = ffi.FindWindowW('Shell_TrayWnd', null);
  if (main) list.push(main);
  let cur = 0;
  for (let i = 0; i < 16; i++) {
    cur = ffi.FindWindowExW(0, cur, 'Shell_SecondaryTrayWnd', null);
    if (!cur || cur === main) break;
    list.push(cur);
  }
  return list;
}

/**
 * 点击落在某条任务栏的时钟热区上时，返回那条任务栏的矩形，否则 null。
 * 副屏任务栏同样支持；竖排任务栏（厚度 > 90）保守跳过。
 */
function taskbarHit(x, y) {
  if (!ffi) return null;
  for (const hwnd of taskbarList()) {
    if (!ffi.IsWindowVisible(hwnd)) continue;
    const r = readRect(hwnd);
    if (!r) continue;
    const h = r.bottom - r.top;
    if (h <= 0 || h > TASKBAR_MAX_H) continue;

    // 自动隐藏的任务栏并没有变矮，只是被推到屏幕外，所以看露在屏幕内的部分。
    // 每块屏底边不同，用该任务栏所属显示器的矩形来算，不能用主屏高度。
    const mon = monitorRect(hwnd);
    const monTop = mon ? mon.top : 0;
    const monBottom = mon ? mon.bottom : ffi.GetSystemMetrics(1);
    const shown = Math.min(r.bottom, monBottom) - Math.max(r.top, monTop);
    if (shown < TASKBAR_MIN_SHOWN) continue;

    if (x >= r.left && x < r.right &&
        y >= r.top && y <= r.bottom + WIN_PAD &&
        x >= r.right - HOT_W) {
      return r;
    }
  }
  return null;
}

/** 日历面板可见时返回它的屏幕矩形，否则 null。 */
function calendarRect() {
  if (!ffi || !winHwnd) return null;
  if (!ffi.IsWindowVisible(winHwnd)) return null;
  return readRect(winHwnd);
}

function safeCall(fn, arg) {
  // 低级钩子回调有超时限制（LowLevelHooksTimeout），里面直接 show/hide 窗口一旦超时，
  // Windows 会把这个钩子从链上摘掉、之后再也收不到点击。所以 GUI 操作一律丢到下一个 tick。
  setImmediate(() => {
    try { fn(arg); } catch (e) { /* 回调异常不能影响钩子链 */ }
  });
}

function onMouse(nCode, wParam, lParam) {
  try {
    if (nCode === HC_ACTION && (wParam === WM_LBUTTONDOWN || wParam === WM_RBUTTONDOWN)) {
      const info = koffi.decode(lParam, 'MSLLHOOKSTRUCT');
      const x = info.pt.x;
      const y = info.pt.y;

      if (wParam === WM_LBUTTONDOWN) {
        const tb = taskbarHit(x, y);
        if (tb) {
          if (handlers.onClock) safeCall(handlers.onClock, tb.top);
          return 1;                     // 吞掉：系统和下层窗口都收不到这次点击
        }
      }

      const wr = calendarRect();
      if (wr && !(x >= wr.left - WIN_PAD && x < wr.right + WIN_PAD &&
                  y >= wr.top - WIN_PAD && y < wr.bottom + WIN_PAD)) {
        if (handlers.onOutside) safeCall(handlers.onOutside);
      }
    }
  } catch (e) {
    /* 钩子回调里绝不能抛，否则调用链会断 */
  }
  return ffi.CallNextHookEx(0, nCode, wParam, lParam);
}

const PROTO = 'intptr_t __stdcall LowLevelMouseProc(int code, uintptr_t wParam, void *lParam)';

/**
 * 开始拦截。handlers: { onClock(trayTop), onOutside() }
 * 返回 true 表示钩子已装上。
 */
function start(list) {
  if (hookHandle) return true;
  try {
    setup();
    handlers = { onClock: list.onClock, onOutside: list.onOutside };
    if (!callbackPtr) {
      const proto = koffi.proto(PROTO);
      callbackPtr = koffi.register(onMouse, koffi.pointer(proto));
    }
    hookHandle = ffi.SetWindowsHookExW(WH_MOUSE_LL, callbackPtr, 0, 0);
    return !!hookHandle;
  } catch (e) {
    handlers = { onClock: null, onOutside: null };
    throw e;
  }
}

function stop() {
  if (hookHandle && ffi) {
    try { ffi.UnhookWindowsHookEx(hookHandle); } catch (e) { /* ignore */ }
  }
  hookHandle = 0;
  handlers = { onClock: null, onOutside: null };
}

/** 面板窗口句柄，换了窗口（重建）时重新设置。 */
function setWindow(hwndBuf) {
  try {
    winHwnd = Number(hwndBuf.readBigUInt64LE(0));
  } catch (e) {
    winHwnd = 0;
  }
}

/** 诊断用：屏幕尺寸、各任务栏矩形、面板句柄。 */
function probe() {
  if (!ffi) setup();
  const bars = taskbarList().map((hwnd) => {
    const r = readRect(hwnd);
    return r ? [r.left, r.top, r.right, r.bottom] : null;
  });
  return {
    screen: [ffi.GetSystemMetrics(0), ffi.GetSystemMetrics(1)],
    taskbars: bars,
    win: winHwnd
  };
}

module.exports = { start, stop, setWindow, probe };
