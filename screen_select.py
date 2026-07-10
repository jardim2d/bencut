#!/usr/bin/env python3
"""Janela flutuante para posicionamento e redimensionamento da área de gravação.

O usuário arrasta para mover e puxa as bordas/cantos para redimensionar.
Enter confirma, Esc cancela.

Uso: screen_select.py [PROPORÇÃO]   ex: 16:9
Saída: "x,y WxH"
"""
import os
os.environ['GDK_BACKEND'] = 'x11'

import sys
import gi
gi.require_version('Gtk', '3.0')
gi.require_version('Gdk', '3.0')
gi.require_version('GdkPixbuf', '2.0')
from gi.repository import Gtk, Gdk, GdkPixbuf
import cairo

CACHE_FILE = os.path.expanduser('~/.cache/bencut/areas.json')

def load_areas():
    try:
        import json
        with open(CACHE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def save_area(key, x, y, w, h):
    import json
    areas = load_areas()
    areas[key] = {'x': x, 'y': y, 'w': w, 'h': h}
    os.makedirs(os.path.dirname(CACHE_FILE), exist_ok=True)
    with open(CACHE_FILE, 'w') as f:
        json.dump(areas, f)

ICON_PATH = os.path.join(os.path.dirname(__file__), 'icons', 'move.svg')
ICON_SIZE = 64
try:
    MOVE_ICON = GdkPixbuf.Pixbuf.new_from_file_at_scale(ICON_PATH, ICON_SIZE, ICON_SIZE, True)
except Exception:
    MOVE_ICON = None

HANDLE = 16     # pixels de borda para redimensionamento
MIN_SIZE = 100  # tamanho mínimo utilizável em pixels

EDGE_CURSORS = {
    Gdk.WindowEdge.NORTH_WEST: 'nw-resize',
    Gdk.WindowEdge.NORTH_EAST: 'ne-resize',
    Gdk.WindowEdge.SOUTH_WEST: 'sw-resize',
    Gdk.WindowEdge.SOUTH_EAST: 'se-resize',
    Gdk.WindowEdge.NORTH:      'n-resize',
    Gdk.WindowEdge.SOUTH:      's-resize',
    Gdk.WindowEdge.WEST:       'w-resize',
    Gdk.WindowEdge.EAST:       'e-resize',
}

raw_aspect = sys.argv[1] if len(sys.argv) > 1 else None
aspect = None
if raw_aspect:
    wa, ha = map(int, raw_aspect.split(':'))
    aspect = wa / ha

AREA_KEY = raw_aspect or 'livre'

display = Gdk.Display.get_default()
monitor = display.get_primary_monitor() or display.get_monitor(0)
geo     = monitor.get_geometry()
SW, SH  = geo.width, geo.height

# tenta restaurar área salva; descarta se for menor que MIN_SIZE
saved = load_areas().get(AREA_KEY)
if saved and saved.get('w', 0) >= MIN_SIZE and saved.get('h', 0) >= MIN_SIZE:
    RW, RH     = saved['w'], saved['h']
    SAVED_X, SAVED_Y = saved['x'], saved['y']
else:
    saved = None
    if aspect:
        RH = int(SH * 0.6)
        RW = int(RH * aspect)
        if RW > SW:
            RW = SW
            RH = int(RW / aspect)
    else:
        RW = int(SW * 0.6)
        RH = int(SH * 0.6)
    SAVED_X = (SW - RW) // 2
    SAVED_Y = (SH - RH) // 2


def get_edge(x, y, w, h):
    left   = x < HANDLE
    right  = x > w - HANDLE
    top    = y < HANDLE
    bottom = y > h - HANDLE
    if top    and left:  return Gdk.WindowEdge.NORTH_WEST
    if top    and right: return Gdk.WindowEdge.NORTH_EAST
    if bottom and left:  return Gdk.WindowEdge.SOUTH_WEST
    if bottom and right: return Gdk.WindowEdge.SOUTH_EAST
    if top:              return Gdk.WindowEdge.NORTH
    if bottom:           return Gdk.WindowEdge.SOUTH
    if left:             return Gdk.WindowEdge.WEST
    if right:            return Gdk.WindowEdge.EAST
    return None


class PositionFrame(Gtk.Window):
    def __init__(self):
        super().__init__(type=Gtk.WindowType.TOPLEVEL)
        self.set_decorated(False)
        self.set_resizable(True)
        self.set_default_size(RW, RH)
        self.set_keep_above(True)
        self.set_app_paintable(True)

        rgba = self.get_screen().get_rgba_visual()
        if rgba:
            self.set_visual(rgba)

        if aspect:
            hints = Gdk.Geometry()
            hints.min_aspect = aspect
            hints.max_aspect = aspect
            self.set_geometry_hints(self, hints, Gdk.WindowHints.ASPECT)

        self.add_events(
            Gdk.EventMask.KEY_PRESS_MASK |
            Gdk.EventMask.BUTTON_PRESS_MASK |
            Gdk.EventMask.POINTER_MOTION_MASK
        )
        self._confirmed = False
        self.connect('draw', self._draw)
        self.connect('key-press-event', self._key)
        self.connect('button-press-event', self._press)
        self.connect('motion-notify-event', self._motion)
        self.connect('destroy', self._on_destroy)
        self.connect('delete-event', lambda *_: True)  # impede WM de fechar
        self.connect('realize', self._restore_position)

    def _current_size(self):
        return self.get_allocated_width(), self.get_allocated_height()

    def _draw(self, _, cr):
        w, h = self._current_size()
        cr.set_operator(cairo.OPERATOR_CLEAR)
        cr.paint()
        cr.set_operator(cairo.OPERATOR_OVER)

        cr.set_source_rgba(0.48, 0.36, 0.94, 0.12)
        cr.paint()

        cr.set_source_rgba(0.48, 0.36, 0.94, 0.9)
        cr.set_line_width(3)
        cr.rectangle(2, 2, w - 4, h - 4)
        cr.stroke()

        # marcadores de canto (indicam redimensionamento)
        c = 24
        cr.set_line_width(4)
        for cx, cy, dx, dy in [
            (2, 2, 1, 1), (w - 2, 2, -1, 1),
            (2, h - 2, 1, -1), (w - 2, h - 2, -1, -1)
        ]:
            cr.move_to(cx + dx * c, cy)
            cr.line_to(cx, cy)
            cr.line_to(cx, cy + dy * c)
        cr.stroke()

        # ícone de mover
        if MOVE_ICON:
            ix = (w - ICON_SIZE) / 2
            iy = (h - ICON_SIZE) / 2
            Gdk.cairo_set_source_pixbuf(cr, MOVE_ICON, ix, iy)
            cr.paint_with_alpha(0.7)

        # dimensões atuais
        cr.set_source_rgba(0.48, 0.36, 0.94, 0.7)
        cr.select_font_face('Sans', cairo.FONT_SLANT_NORMAL, cairo.FONT_WEIGHT_BOLD)
        cr.set_font_size(18)
        label = f'{w} × {h}'
        te = cr.text_extents(label)
        offset = (ICON_SIZE / 2 + 14) if MOVE_ICON else 0
        cr.move_to((w - te.width) / 2, h / 2 + offset + te.height / 2)
        cr.show_text(label)

    def _on_destroy(self, _):
        if not self._confirmed:
            sys.exit(1)

    def _restore_position(self, _):
        self.move(SAVED_X, SAVED_Y)

    def _press(self, _, ev):
        if ev.button != 1:
            return
        w, h = self._current_size()
        edge = get_edge(ev.x, ev.y, w, h)
        if edge is not None:
            self.get_window().begin_resize_drag(
                edge, ev.button, int(ev.x_root), int(ev.y_root), ev.time)
        else:
            self.get_window().begin_move_drag(
                ev.button, int(ev.x_root), int(ev.y_root), ev.time)

    def _motion(self, _, ev):
        w, h = self._current_size()
        edge = get_edge(ev.x, ev.y, w, h)
        name = EDGE_CURSORS.get(edge, 'fleur')
        cursor = Gdk.Cursor.new_from_name(self.get_display(), name)
        self.get_window().set_cursor(cursor)
        self.queue_draw()

    def _key(self, _, ev):
        if ev.keyval in (Gdk.KEY_Return, Gdk.KEY_KP_Enter):
            w, h = self._current_size()
            origin = self.get_window().get_origin()
            x, y = origin[-2], origin[-1]  # (rv,x,y) ou (x,y) — sempre pega os últimos dois
            x = max(0, min(x, SW - MIN_SIZE))
            y = max(0, min(y, SH - MIN_SIZE))
            w = max(MIN_SIZE, min(w, SW - x))
            h = max(MIN_SIZE, min(h, SH - y))
            save_area(AREA_KEY, x, y, w, h)
            self._confirmed = True
            print(f'{x},{y} {w}x{h}', flush=True)
            Gtk.main_quit()
        elif ev.keyval == Gdk.KEY_Escape:
            sys.exit(1)


win = PositionFrame()
win.show_all()
Gtk.main()
