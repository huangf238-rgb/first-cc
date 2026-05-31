import tkinter as tk   # Python 内置 GUI 框架，用于创建窗口、按钮、画布等控件
import math             # 数学库（本文件暂未直接用到，可留作扩展）
import winsound         # Windows 专属音效库，用于播放系统提示音


class PomodoroTimer:
    """
    番茄钟主类。
    所有 UI 控件、计时逻辑、状态都封装在这里。
    使用流程：创建实例 → 调用 run() 进入 tkinter 事件循环。
    """

    # ── 各模式默认时长（单位：秒）────────────────────────────────────────────
    DURATIONS = {
        'pomodoro':    25 * 60,   # 专注工作 25 分钟
        'short_break':  5 * 60,   # 短休息 5 分钟
        'long_break':  15 * 60,   # 长休息 15 分钟（每完成 4 个番茄触发）
    }

    # ── 各模式的主题颜色（基于浅青色调）────────────────────────────────────
    COLORS = {
        'pomodoro':    '#A8E4EC',  # 主青色（与参考图一致）
        'short_break': '#6ECFDA',  # 中青色
        'long_break':  '#4AB8C8',  # 深青色
    }

    # ── 各模式在圆环中心显示的文字标签 ────────────────────────────────────────
    LABELS = {
        'pomodoro':    '🍅 番茄时间',
        'short_break': '☕ 短休息',
        'long_break':  '🌿 长休息',
    }

    # ── 各模式按钮按下时的深色（hover / active 状态）────────────────────────
    DARK_COLORS = {
        'pomodoro':    '#7ABEC8',  # 深一档的青色
        'short_break': '#4AADB8',
        'long_break':  '#2A96A8',
    }

    # ── 全局配色常量（深青色暗色主题）────────────────────────────────────────
    BG      = '#0D2830'   # 主背景色（极深青黑）
    BG2     = '#112F38'   # 次级背景色（深青，用于标签栏）
    PANEL   = '#1A4A55'   # 面板色（备用）
    TEXT    = '#E0F8FC'   # 主文字颜色（浅青白）
    SUBTEXT = '#6ABAC6'   # 次级文字颜色（中青灰）
    RING_BG = '#1A4A55'   # 圆环背景轨道颜色

    # ── 初始化 ───────────────────────────────────────────────────────────────

    def __init__(self):
        self.mode       = 'pomodoro'              # 当前模式，默认番茄时间
        self.time_left  = self.DURATIONS['pomodoro']  # 当前剩余秒数
        self.is_running = False                   # 计时器是否正在运行
        self.sessions   = 0                       # 今日已完成的番茄数
        self._after_id  = None                    # tkinter after() 回调的 ID，用于取消定时任务
        self._build_ui()                          # 构建所有 UI 控件

    # ══════════════════════════════════════════════════════════════════════════
    #  UI 构建
    # ══════════════════════════════════════════════════════════════════════════

    def _build_ui(self):
        """创建主窗口及所有子控件，按从上到下的顺序排列。"""

        # —— 主窗口 ——————————————————————————————————————————————————————————
        root = tk.Tk()
        self.root = root
        root.title('番茄钟')
        root.geometry('420x580')          # 固定窗口大小 420×580 像素
        root.resizable(False, False)      # 禁止用户拖拽改变窗口大小
        root.configure(bg=self.BG)
        root.protocol('WM_DELETE_WINDOW', self._on_close)  # 关闭窗口时先取消定时任务

        # —— 顶部标题区 ————————————————————————————————————————————————————
        header = tk.Frame(root, bg=self.BG)
        header.pack(fill='x', pady=(28, 0))
        tk.Label(header, text='番茄钟',
                 font=('Segoe UI', 22, 'bold'),
                 bg=self.BG, fg=self.TEXT).pack()
        tk.Label(header, text='专注 · 休息 · 循环',
                 font=('Segoe UI', 10),
                 bg=self.BG, fg=self.SUBTEXT).pack(pady=(2, 0))

        # —— 模式切换标签栏 ————————————————————————————————————————————————
        # 三个按钮横排，点击切换计时模式并重置倒计时
        tab_bg = tk.Frame(root, bg=self.BG2, pady=6)
        tab_bg.pack(fill='x', padx=24, pady=(20, 0))
        self.mode_btns = {}   # 保存三个模式按钮的引用，方便后续更新高亮状态
        modes = [
            ('pomodoro',    '番茄'),
            ('short_break', '短休'),
            ('long_break',  '长休'),
        ]
        for m, label in modes:
            btn = tk.Button(
                tab_bg, text=label,
                font=('Segoe UI', 10, 'bold'),
                width=7, relief='flat', bd=0,
                cursor='hand2',
                # lambda 默认参数 x=m 捕获当前循环变量，避免闭包陷阱
                command=lambda x=m: self.set_mode(x)
            )
            btn.pack(side='left', padx=6, pady=2)
            self.mode_btns[m] = btn

        # —— 圆环倒计时画布 ————————————————————————————————————————————————
        # Canvas 是 tkinter 的绘图控件，所有圆弧/文字都用它手动绘制
        self.canvas = tk.Canvas(root, width=300, height=300,
                                bg=self.BG, highlightthickness=0)
        self.canvas.pack(pady=(18, 0))
        self._draw_ring()   # 初始绘制（满圆弧 + 时间文字）

        # —— 操作按钮区（开始/暂停 + 重置）————————————————————————————————
        ctrl = tk.Frame(root, bg=self.BG)
        ctrl.pack(pady=(14, 0))

        # 开始/暂停按钮：颜色随模式变化，文字随状态切换
        self.start_btn = tk.Button(
            ctrl, text='  ▶  开始  ',
            font=('Segoe UI', 13, 'bold'),
            relief='flat', bd=0, cursor='hand2',
            padx=18, pady=8,
            command=self.toggle    # 每次点击在"运行/暂停"之间切换
        )
        self.start_btn.pack(side='left', padx=8)

        # 重置按钮：始终为深色样式，不随模式变色
        reset_btn = tk.Button(
            ctrl, text='  ↺  重置  ',
            font=('Segoe UI', 13),
            relief='flat', bd=0, cursor='hand2',
            padx=14, pady=8,
            bg='#1A4A55', fg=self.TEXT,
            activebackground='#2A6070',
            activeforeground=self.TEXT,
            command=self.reset
        )
        reset_btn.pack(side='left', padx=8)

        # —— 番茄计数区（小圆点 + 文字）————————————————————————————————————
        # 8 个小圆点，每完成一个番茄就点亮一个
        dot_frame = tk.Frame(root, bg=self.BG)
        dot_frame.pack(pady=(16, 0))
        self._dot_canvas = tk.Canvas(dot_frame, width=180, height=24,
                                     bg=self.BG, highlightthickness=0)
        self._dot_canvas.pack()

        # 文字标签显示今日番茄总数
        self._session_label = tk.Label(
            root, text='今日番茄数: 0',
            font=('Segoe UI', 10),
            bg=self.BG, fg=self.SUBTEXT
        )
        self._session_label.pack(pady=(4, 0))

        self._apply_colors()   # 根据当前模式设置初始按钮颜色

    # ══════════════════════════════════════════════════════════════════════════
    #  绘制逻辑
    # ══════════════════════════════════════════════════════════════════════════

    def _draw_ring(self):
        """
        重绘圆环计时器。每次倒计时走一秒都会调用一次。
        绘制顺序：阴影轮廓 → 灰色背景轨道 → 彩色进度弧 → 时间数字 → 模式标签。
        """
        c = self.canvas
        c.delete('all')          # 清空画布，避免图形叠加
        cx, cy, r = 150, 150, 115  # 圆心坐标 (cx,cy)，半径 r

        total     = self.DURATIONS[self.mode]
        remaining = self.time_left
        # 剩余比例：1.0 = 满格，0.0 = 空格
        frac  = remaining / total if total else 0
        color = self.COLORS[self.mode]

        # 阴影圆：比主圆略大，用深色描边，制造轻微立体感
        c.create_oval(cx - r - 2, cy - r - 2, cx + r + 2, cy + r + 2,
                      outline='#081820', width=18)

        # 背景轨道圆：灰色，始终完整显示，表示"总时长"
        c.create_oval(cx - r, cy - r, cx + r, cy + r,
                      outline=self.RING_BG, width=14)

        # 进度弧：从顶部（12点方向，tkinter 中对应 90°）顺时针绘制
        # extent 为负数 → 顺时针方向
        # extent 的绝对值 = 360° × 剩余比例，随时间减小而缩短
        if remaining > 0:
            extent = -360 * frac
            c.create_arc(cx - r, cy - r, cx + r, cy + r,
                         start=90, extent=extent,
                         outline=color, width=14, style='arc')

        # 时间数字（MM:SS 格式）显示在圆心略上方
        mins = remaining // 60
        secs = remaining % 60
        c.create_text(cx, cy - 18,
                      text=f'{mins:02d}:{secs:02d}',
                      font=('Segoe UI', 46, 'bold'),
                      fill=self.TEXT)

        # 模式标签显示在数字下方
        c.create_text(cx, cy + 32,
                      text=self.LABELS[self.mode],
                      font=('Segoe UI', 12),
                      fill=self.SUBTEXT)

    def _draw_dots(self):
        """
        重绘底部 8 个进度小圆点。
        已完成的番茄数对应点亮（主题色填充），其余为灰色。
        超过 8 个后循环重置视觉（但 sessions 计数继续累加）。
        """
        c = self._dot_canvas
        c.delete('all')
        color      = self.COLORS['pomodoro']
        total_dots = 8
        shown      = min(self.sessions, total_dots)   # 最多点亮 8 个
        spacing    = 20                               # 点间距 20 像素
        # 计算起始 x，使 8 个点在 180px 宽度内居中
        start_x    = (180 - (total_dots - 1) * spacing) // 2
        for i in range(total_dots):
            x    = start_x + i * spacing
            fill = color if i < shown else self.RING_BG
            c.create_oval(x - 6, 6, x + 6, 18, fill=fill, outline='')

    def _apply_colors(self):
        """
        根据当前模式刷新所有按钮的颜色。
        - 开始按钮：始终使用当前模式的主题色。
        - 模式标签按钮：当前模式高亮（主题色），其余置灰。
        """
        color = self.COLORS[self.mode]
        dark  = self.DARK_COLORS[self.mode]

        self.start_btn.configure(
            bg=color, fg='white',
            activebackground=dark, activeforeground='white'
        )

        for m, btn in self.mode_btns.items():
            if m == self.mode:
                btn.configure(bg=color, fg='white',
                              activebackground=dark, activeforeground='white')
            else:
                btn.configure(bg='#1A4A55', fg=self.SUBTEXT,
                              activebackground='#2A6070',
                              activeforeground=self.TEXT)

    # ══════════════════════════════════════════════════════════════════════════
    #  计时器核心逻辑
    # ══════════════════════════════════════════════════════════════════════════

    def set_mode(self, mode):
        """
        切换到指定模式（番茄 / 短休 / 长休）。
        会取消正在运行的倒计时，并将时间重置为新模式的默认时长。
        """
        if self._after_id:
            self.root.after_cancel(self._after_id)   # 取消已注册的下一次 tick 回调
            self._after_id = None
        self.is_running = False
        self.mode       = mode
        self.time_left  = self.DURATIONS[mode]
        self.start_btn.configure(text='  ▶  开始  ')
        self._draw_ring()
        self._apply_colors()

    def toggle(self):
        """
        开始/暂停 切换。
        - 若当前暂停 → 标记为运行状态，启动 _tick() 循环。
        - 若当前运行 → 标记为暂停状态，取消下一次 _tick() 调度。
        """
        self.is_running = not self.is_running
        if self.is_running:
            self.start_btn.configure(text='  ⏸  暂停  ')
            self._tick()
        else:
            self.start_btn.configure(text='  ▶  继续  ')
            if self._after_id:
                self.root.after_cancel(self._after_id)
                self._after_id = None

    def reset(self):
        """
        重置当前模式的倒计时到初始时长，停止运行。
        不切换模式，不清零今日番茄数。
        """
        if self._after_id:
            self.root.after_cancel(self._after_id)
            self._after_id = None
        self.is_running = False
        self.time_left  = self.DURATIONS[self.mode]
        self.start_btn.configure(text='  ▶  开始  ')
        self._draw_ring()

    def _tick(self):
        """
        计时核心：每隔 1000ms（1秒）被 tkinter 事件循环调用一次。

        工作原理：
          1. 检查 is_running 标志，若已暂停则直接退出（不再注册下一次调用）。
          2. 若还有剩余时间，将 time_left 减 1，重绘圆环，
             然后用 after(1000, self._tick) 注册 1 秒后的下一次调用。
          3. 若时间归零，调用 _on_complete() 处理结束逻辑。

        注意：tkinter 是单线程的，after() 是非阻塞的事件回调，
        不会阻塞 UI，也不需要多线程。
        """
        if not self.is_running:
            return
        if self.time_left > 0:
            self.time_left -= 1
            self._draw_ring()
            # 注册 1 秒后再次调用自身；保存 ID 以便随时取消
            self._after_id = self.root.after(1000, self._tick)
        else:
            self._on_complete()

    def _on_complete(self):
        """
        倒计时归零时的处理逻辑：
        - 停止计时器。
        - 若当前是番茄模式，累加 sessions 并刷新圆点。
        - 播放系统提示音（失败时降级为 tkinter 系统铃声）。
        - 弹出完成提示弹窗。
        """
        self.is_running = False
        self.start_btn.configure(text='  ▶  开始  ')

        if self.mode == 'pomodoro':
            self.sessions += 1
            self._session_label.configure(text=f'今日番茄数: {self.sessions}')
            self._draw_dots()

        # 播放 Windows 系统"感叹号"音效
        try:
            winsound.PlaySound('SystemExclamation', winsound.SND_ALIAS | winsound.SND_ASYNC)
        except Exception:
            self.root.bell()   # 降级：tkinter 内置蜂鸣

        self._show_popup()

    # ══════════════════════════════════════════════════════════════════════════
    #  完成弹窗
    # ══════════════════════════════════════════════════════════════════════════

    def _show_popup(self):
        """
        计时结束时弹出的提示窗口。
        - 番茄结束 → 提示休息，并根据是否完成 4 个番茄决定推荐短/长休息。
        - 休息结束 → 提示回到工作，切回番茄模式。
        点击主按钮会自动切换到下一个模式并关闭弹窗。
        """
        color = self.COLORS[self.mode]

        if self.mode == 'pomodoro':
            title     = '🎉 番茄完成！'
            body      = f'已完成第 {self.sessions} 个番茄，好好休息一下吧！'
            # 每 4 个番茄触发一次长休息
            next_mode = 'long_break' if self.sessions % 4 == 0 else 'short_break'
            next_text = '开始长休息' if self.sessions % 4 == 0 else '开始短休息'
        else:
            title     = '☀️ 休息结束！'
            body      = '准备好了吗？开始下一个番茄时间！'
            next_mode = 'pomodoro'
            next_text = '开始番茄'

        # 创建子窗口（Toplevel），grab_set() 使其成为模态（阻止操作主窗口）
        popup = tk.Toplevel(self.root)
        popup.title('')
        popup.geometry('300x170')
        popup.resizable(False, False)
        popup.configure(bg=self.BG)
        popup.grab_set()    # 模态：弹窗打开期间主窗口不可点击
        popup.focus_set()   # 自动获取焦点
        self._center_popup(popup, 300, 170)  # 居中显示在主窗口上方

        tk.Label(popup, text=title,
                 font=('Segoe UI', 15, 'bold'),
                 bg=self.BG, fg=color).pack(pady=(22, 6))
        tk.Label(popup, text=body,
                 font=('Segoe UI', 10),
                 bg=self.BG, fg=self.SUBTEXT,
                 wraplength=260).pack()

        btn_row = tk.Frame(popup, bg=self.BG)
        btn_row.pack(pady=16)

        def go_next():
            """关闭弹窗并切换到下一模式。"""
            popup.destroy()
            self.set_mode(next_mode)

        # 主操作按钮：切换到下一模式
        tk.Button(btn_row, text=next_text,
                  font=('Segoe UI', 11, 'bold'),
                  bg=color, fg='white', relief='flat', cursor='hand2',
                  padx=12, pady=6,
                  activebackground=self.DARK_COLORS[self.mode],
                  activeforeground='white',
                  command=go_next).pack(side='left', padx=6)

        # 次要按钮：仅关闭弹窗，不切换模式（用户手动决定下一步）
        tk.Button(btn_row, text='稍后',
                  font=('Segoe UI', 11),
                  bg='#1A4A55', fg=self.SUBTEXT, relief='flat', cursor='hand2',
                  padx=12, pady=6,
                  activebackground='#2A6070', activeforeground=self.TEXT,
                  command=popup.destroy).pack(side='left', padx=6)

    def _center_popup(self, popup, w, h):
        """将弹窗定位到主窗口的正中央。"""
        rx = self.root.winfo_x() + (self.root.winfo_width()  - w) // 2
        ry = self.root.winfo_y() + (self.root.winfo_height() - h) // 2
        popup.geometry(f'{w}x{h}+{rx}+{ry}')

    # ══════════════════════════════════════════════════════════════════════════
    #  生命周期
    # ══════════════════════════════════════════════════════════════════════════

    def _on_close(self):
        """
        用户点击窗口关闭按钮时触发。
        先取消所有待执行的 after() 回调，再销毁窗口，防止野指针引发报错。
        """
        if self._after_id:
            self.root.after_cancel(self._after_id)
        self.root.destroy()

    def run(self):
        """启动 tkinter 事件循环，程序在此阻塞直到窗口关闭。"""
        self.root.mainloop()


# ── 入口点 ────────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    # 只有直接运行本文件时才启动，作为模块导入时不执行
    PomodoroTimer().run()
