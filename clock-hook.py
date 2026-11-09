"""【已弃用 / 仅作参考】任务栏时钟点击拦截器。

现在的实现是 hook.js（koffi 调 Win32），不再依赖 Python，打包发给别人也能直接用。
这个 Python 版本保留下来只为对照逻辑，主程序不会加载它。

原始说明：
用 WH_MOUSE_LL 低级鼠标钩子监视左键，当点击落在任务栏右下角的时间区域时，
把这一下点击吞掉（返回 1），并通过标准输出通知 Electron 打开日历。
1. 点击落在任务栏右下角的时间区域 -> 吞掉这一下（返回 1），通知 Electron 打开日历。
2. 日历窗口可见时，点击落在窗口之外 -> 通知 Electron 收起，但**不吞**这次点击，
   所以点别的程序、桌面、开始菜单都照常响应，只是日历顺手收起来。

不需要管理员权限，也不改动系统文件。标准输出每行一个事件：
    READY              钩子就绪
    CAPTURE x y top    截获并吞掉了一次时钟点击，top 是任务栏顶边 y 坐标
    OUTSIDE x y        点击落在日历窗口之外
    ERR <msg>          出错

标准输入接收 Electron 下发的命令（每行一条）：
    WIN <hwnd>         日历窗口的窗口句柄（十进制）
"""

import ctypes
import ctypes.wintypes as w
import os
import sys
import threading
import time

user32 = ctypes.WinDLL('user32', use_last_error=True)
kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

WH_MOUSE_LL = 14
HC_ACTION = 0
WM_LBUTTONDOWN = 0x0201
WM_LBUTTONUP = 0x0202
WM_RBUTTONDOWN = 0x0204
PM_REMOVE = 0x0001

HOT_W = 132          # 时钟热区宽度：屏幕右边缘往左这么多像素
TASKBAR_MAX_H = 90    # 任务栏最大高度，超出说明不是底部任务栏
TASKBAR_MIN_SHOWN = 20  # 露在屏幕内不足这么多像素，视为未升起
WIN_PAD = 1          # 命中窗口时允许的像素容差（给圆角描边留点余地）


class MSLLHOOKSTRUCT(ctypes.Structure):
    _fields_ = [
        ('pt', w.POINT),
        ('mouseData', w.DWORD),
        ('flags', w.DWORD),
        ('time', w.DWORD),
        ('dwExtraInfo', ctypes.c_void_p),
    ]


class RECT(ctypes.Structure):
    _fields_ = [
        ('left', ctypes.c_long),
        ('top', ctypes.c_long),
        ('right', ctypes.c_long),
        ('bottom', ctypes.c_long),
    ]


HOOKPROC = ctypes.WINFUNCTYPE(ctypes.c_ssize_t, ctypes.c_int, w.WPARAM, w.LPARAM)

user32.CallNextHookEx.restype = ctypes.c_ssize_t
user32.CallNextHookEx.argtypes = [w.HHOOK, ctypes.c_int, w.WPARAM, ctypes.c_void_p]
user32.SetWindowsHookExW.restype = w.HHOOK
user32.SetWindowsHookExW.argtypes = [ctypes.c_int, HOOKPROC, w.HINSTANCE, w.DWORD]
user32.FindWindowW.restype = w.HWND
user32.FindWindowW.argtypes = [w.LPCWSTR, w.LPCWSTR]
user32.GetWindowRect.argtypes = [w.HWND, ctypes.POINTER(RECT)]
user32.IsWindowVisible.argtypes = [w.HWND]
user32.IsWindowVisible.restype = w.BOOL
user32.PeekMessageW.argtypes = [ctypes.POINTER(w.MSG), w.HWND, w.UINT, w.UINT, w.UINT]

# 日历窗口句柄，由 Electron 通过标准输入下发；0 表示尚未就绪
window_hwnd = 0

# 排错用：设置 HOOK_TRACE=1 时对每次左键点击输出一行 DBG
TRACE = os.environ.get('HOOK_TRACE') == '1'


def set_dpi_aware():
    """统一坐标口径：钩子给的坐标是物理像素，这里也让窗口测量用物理像素。"""
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)   # per-monitor aware
        return
    except Exception:
        pass
    try:
        user32.SetProcessDPIAware()
    except Exception:
        pass


def emit(line):
    try:
        sys.stdout.write(line + '\n')
        sys.stdout.flush()
    except Exception:
        pass


def screen_size():
    # 用 DPI 感知后的屏幕尺寸；失败则退回系统指标
    try:
        return user32.GetSystemMetrics(0), user32.GetSystemMetrics(1)
    except Exception:
        return 1920, 1080


def taken_rect():
    """返回任务栏矩形与它当前在屏幕上露出的高度。

    自动隐藏的任务栏并没有变小，只是被推到屏幕下方（实测 top=1078、
    bottom=1126），所以要用「露在屏幕内的像素高度」判断它是否已升起。
    """
    hwnd = user32.FindWindowW('Shell_TrayWnd', None)
    if not hwnd:
        return None, 0
    r = RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None, 0
    sw, sh = screen_size()
    height = r.bottom - r.top
    if height <= 0 or height > TASKBAR_MAX_H:
        return None, 0
    shown = min(r.bottom, sh) - max(r.top, 0)
    return r, shown


def taskbar_rect():
    """底部任务栏真正升起时返回其矩形，否则 None。"""
    r, shown = taken_rect()
    if r is None:
        return None
    if shown < TASKBAR_MIN_SHOWN:      # 只露出几像素 = 仍处于隐藏状态
        return None
    return r


def calendar_rect():
    """日历窗口可见时返回它的屏幕矩形，否则 None。"""
    if not window_hwnd:
        return None
    if not user32.IsWindowVisible(window_hwnd):
        return None
    r = RECT()
    if not user32.GetWindowRect(window_hwnd, ctypes.byref(r)):
        return None
    if r.right - r.left <= 0 or r.bottom - r.top <= 0:
        return None
    return r


def in_clock_zone(x, y):
    r = taskbar_rect()
    if r is None:
        return False
    sw, _ = screen_size()
    if x < sw - HOT_W:
        return False
    return r.top - 4 <= y <= r.bottom + 4


def read_commands():
    """读取 Electron 发来的命令（窗口句柄），阻塞式逐行读。"""
    global window_hwnd
    try:
        for raw in sys.stdin:
            line = raw.strip()
            if not line:
                continue
            parts = line.split()
            if parts[0] == 'WIN' and len(parts) > 1:
                try:
                    window_hwnd = int(parts[1])
                except ValueError:
                    window_hwnd = 0
    except Exception:
        pass


def on_mouse(nCode, wParam, lParam):
    if nCode == HC_ACTION and wParam in (WM_LBUTTONDOWN, WM_RBUTTONDOWN):
        info = ctypes.cast(lParam, ctypes.POINTER(MSLLHOOKSTRUCT)).contents
        x, y = info.pt.x, info.pt.y
        if TRACE:
            emit('DBG down %d %d tb=%s win=%s hwnd=%d' % (
                x, y, taskbar_rect() is not None,
                calendar_rect() is not None, window_hwnd))
        if wParam == WM_LBUTTONDOWN:
            r = taskbar_rect()
            if r is not None and x >= screen_size()[0] - HOT_W:
                # 带上任务栏顶边，Electron 侧据此把弹窗贴在任务栏上方
                emit('CAPTURE %d %d %d' % (x, y, r.top))
                return 1          # 吞掉：系统与下层窗口都收不到这次点击
        wr = calendar_rect()
        if wr is not None:
            if not (wr.left - WIN_PAD <= x < wr.right + WIN_PAD and
                    wr.top - WIN_PAD <= y < wr.bottom + WIN_PAD):
                # 点在外面：照常放行这次点击，只是让日历收起
                emit('OUTSIDE %d %d' % (x, y))
    return user32.CallNextHookEx(None, nCode, wParam, ctypes.c_void_p(lParam))


def main():
    set_dpi_aware()

    callback = HOOKPROC(on_mouse)
    hook = user32.SetWindowsHookExW(WH_MOUSE_LL, callback, None, 0)
    if not hook:
        emit('ERR SetWindowsHookEx failed code=%d' % ctypes.get_last_error())
        return 1

    threading.Thread(target=read_commands, daemon=True).start()

    emit('READY')

    msg = w.MSG()
    while True:
        got = user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE)
        if got:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))
        else:
            time.sleep(0.008)


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
