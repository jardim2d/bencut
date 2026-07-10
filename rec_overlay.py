#!/usr/bin/env python3
"""Botão flutuante sempre-no-topo para parar gravação de tela do BenCut.
Clique em qualquer lugar para parar. Arraste para reposicionar.
Uso: rec_overlay.py [PORT]
"""
import os
os.environ.setdefault('GDK_BACKEND', 'x11')

import json
import math
import sys
import threading
import time
import urllib.request
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
from gi.repository import Gtk, Gdk, GLib
import cairo

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
W, H = 148, 42
PI = math.pi
CACHE_FILE = os.path.expanduser('~/.cache/bencut/rec_overlay_pos.json')


def _load_pos():
    try:
        with open(CACHE_FILE) as f:
            d = json.load(f)
            return d['x'], d['y']
    except Exception:
        return None, None


def _save_pos(x, y):
    try:
        os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
        with open(CACHE_FILE, 'w') as f:
            json.dump({'x': x, 'y': y}, f)
    except Exception:
        pass


def _do_stop():
    try:
        req = urllib.request.Request(
            f'http://localhost:{PORT}/api/record/stop',
            data=b'{}',
            headers={'Content-Type': 'application/json'},
            method='POST',
        )
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        print(f'[overlay] erro ao parar: {e}', file=sys.stderr)
    GLib.idle_add(Gtk.main_quit)


class RecOverlay(Gtk.Window):
    def __init__(self):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.set_decorated(False)
        self.set_resizable(False)
        self.set_keep_above(True)
        self.set_app_paintable(True)
        self.set_skip_taskbar_hint(True)
        self.set_skip_pager_hint(True)
        self.set_default_size(W, H)

        rgba = self.get_screen().get_rgba_visual()
        if rgba:
            self.set_visual(rgba)

        self._start = time.time()
        self._pulse = 0.0
        self._pulse_dir = 1.0
        self._hover = False
        self._press_x = self._press_y = 0.0
        self._drag_ox = self._drag_oy = 0
        self._dragging = False

        self.add_events(
            Gdk.EventMask.BUTTON_PRESS_MASK |
            Gdk.EventMask.BUTTON_RELEASE_MASK |
            Gdk.EventMask.POINTER_MOTION_MASK |
            Gdk.EventMask.ENTER_NOTIFY_MASK |
            Gdk.EventMask.LEAVE_NOTIFY_MASK
        )
        self.connect('draw', self._draw)
        self.connect('button-press-event', self._on_press)
        self.connect('button-release-event', self._on_release)
        self.connect('motion-notify-event', self._on_motion)
        self.connect('enter-notify-event', lambda *_: self._set_hover(True))
        self.connect('leave-notify-event', lambda *_: self._set_hover(False))
        self.connect('realize', self._place)

        GLib.timeout_add(50, self._tick)

    def _place(self, _):
        x, y = _load_pos()
        if x is None:
            display = Gdk.Display.get_default()
            mon = display.get_primary_monitor() or display.get_monitor(0)
            geo = mon.get_geometry()
            x = geo.x + geo.width - W - 20
            y = geo.y + geo.height - H - 60
        self.move(x, y)

    def _set_hover(self, val):
        self._hover = val
        name = 'pointer' if val else 'default'
        self.get_window().set_cursor(
            Gdk.Cursor.new_from_name(self.get_display(), name))
        self.queue_draw()

    def _tick(self):
        self._pulse += 0.06 * self._pulse_dir
        if self._pulse >= 1.0:
            self._pulse, self._pulse_dir = 1.0, -1.0
        elif self._pulse <= 0.0:
            self._pulse, self._pulse_dir = 0.0, 1.0
        self.queue_draw()
        return True

    def _elapsed(self):
        s = int(time.time() - self._start)
        return f'{s // 60:02d}:{s % 60:02d}'

    def _draw(self, _, cr):
        r = H / 2
        bg_a = 0.93 if self._hover else 0.84

        cr.set_operator(cairo.OPERATOR_CLEAR)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)

        # pill background
        cr.set_source_rgba(0.10, 0.07, 0.18, bg_a)
        cr.arc(r, r, r, PI / 2, 3 * PI / 2)
        cr.arc(W - r, r, r, -PI / 2, PI / 2)
        cr.close_path()
        cr.fill()

        # pill border
        border_a = 0.85 if self._hover else 0.50
        cr.set_source_rgba(0.85, 0.18, 0.18, border_a)
        cr.set_line_width(1.5)
        cr.arc(r, r, r - 1, PI / 2, 3 * PI / 2)
        cr.arc(W - r, r, r - 1, -PI / 2, PI / 2)
        cr.close_path()
        cr.stroke()

        # pulsing red dot
        dot_a = 0.35 + 0.65 * self._pulse
        cr.set_source_rgba(0.95, 0.18, 0.18, dot_a)
        cr.arc(18, H / 2, 5, 0, 2 * PI)
        cr.fill()

        # timer
        cr.set_source_rgba(1.0, 1.0, 1.0, 0.92)
        cr.select_font_face('monospace', cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(14)
        t = self._elapsed()
        te = cr.text_extents(t)
        cr.move_to((W - te.width) / 2 - 5, H / 2 + te.height / 2 - 1)
        cr.show_text(t)

        # stop square (■)
        sq = 9
        stop_a = 1.0 if self._hover else 0.80
        cr.set_source_rgba(0.95, 0.18, 0.18, stop_a)
        cr.rectangle(W - r - sq / 2 - 1, H / 2 - sq / 2, sq, sq)
        cr.fill()

    def _on_press(self, _, ev):
        if ev.button == 1:
            self._press_x = ev.x_root
            self._press_y = ev.y_root
            self._drag_ox, self._drag_oy = self.get_position()
            self._dragging = True

    def _on_motion(self, _, ev):
        if self._dragging:
            dx = ev.x_root - self._press_x
            dy = ev.y_root - self._press_y
            self.move(int(self._drag_ox + dx), int(self._drag_oy + dy))

    def _on_release(self, _, ev):
        if ev.button != 1 or not self._dragging:
            return
        self._dragging = False
        dx = abs(ev.x_root - self._press_x)
        dy = abs(ev.y_root - self._press_y)
        if dx < 6 and dy < 6:
            threading.Thread(target=_do_stop, daemon=True).start()
        else:
            x, y = self.get_position()
            _save_pos(x, y)


win = RecOverlay()
win.show_all()
Gtk.main()
