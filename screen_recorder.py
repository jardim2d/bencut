#!/usr/bin/env python3
"""Mantém uma conexão DBus persistente com org.gnome.Shell.Screencast.

Uso:
  screen_recorder.py start <arquivo_sem_extensao> [fullscreen|x,y,w,h]
  screen_recorder.py stop

start: escreve o PID em /tmp/bencut_rec.pid e grava até receber SIGTERM/SIGINT.
stop:  lê o PID e envia SIGTERM.

O arquivo resultante terá a extensão adicionada pelo GNOME (geralmente .webm).
"""
import sys
import os
import signal
import time as _time
import dbus
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

PID_FILE = "/tmp/bencut_rec.pid"
OUT_FILE_RECORD = "/tmp/bencut_rec_out.txt"


def do_start(file_template, area=None):
    DBusGMainLoop(set_as_default=True)
    loop = GLib.MainLoop()
    bus = dbus.SessionBus()
    proxy = bus.get_object("org.gnome.Shell.Screencast",
                           "/org/gnome/Shell/Screencast")
    iface = dbus.Interface(proxy, "org.gnome.Shell.Screencast")

    opts = dbus.Dictionary({}, signature='sv')
    if area:
        x, y, w, h = area
        ok, used = iface.ScreencastArea(
            dbus.Int32(x), dbus.Int32(y), dbus.Int32(w), dbus.Int32(h),
            file_template, opts)
    else:
        ok, used = iface.Screencast(file_template, opts)

    if not ok:
        print("ERRO: GNOME Screencast retornou false", file=sys.stderr)
        sys.exit(1)

    # grava o caminho real do arquivo para o servidor ler depois
    with open(OUT_FILE_RECORD, "w") as f:
        f.write(str(used))

    # salva o PID para o stop poder encontrar este processo
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))

    def _stop(signum=None, frame=None):
        try:
            iface.StopScreencast()
        except Exception:
            pass
        loop.quit()

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    # detecta parada externa (ex: Ctrl+Alt+Shift+R do GNOME):
    # o arquivo para de crescer quando o GNOME finaliza a gravação
    _last_size = [0]
    _last_change = [_time.time()]

    def _watch_file():
        try:
            out = str(used)
            if os.path.exists(out):
                sz = os.path.getsize(out)
                if sz != _last_size[0]:
                    _last_size[0] = sz
                    _last_change[0] = _time.time()
                elif sz > 0 and _time.time() - _last_change[0] > 10.0:
                    GLib.idle_add(_stop)
                    return False  # remove o timeout
        except Exception:
            pass
        return True  # continua verificando

    GLib.timeout_add(2000, _watch_file)

    # mantém a conexão DBus viva enquanto estiver gravando
    loop.run()


def do_stop():
    if not os.path.exists(PID_FILE):
        print("ERRO: nenhuma gravação em andamento", file=sys.stderr)
        sys.exit(1)
    with open(PID_FILE) as f:
        pid = int(f.read().strip())
    os.kill(pid, signal.SIGTERM)
    # aguarda o processo terminar (máx 10s)
    import time
    for _ in range(100):
        try:
            os.kill(pid, 0)
            time.sleep(0.1)
        except ProcessLookupError:
            break
    if os.path.exists(PID_FILE):
        os.remove(PID_FILE)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "start":
        file_template = sys.argv[2]
        area = None
        if len(sys.argv) > 3 and sys.argv[3] != "fullscreen":
            x, y, w, h = (int(v) for v in sys.argv[3].split(","))
            area = (x, y, w, h)
        do_start(file_template, area)
    elif cmd == "stop":
        do_stop()
    else:
        print(__doc__)
        sys.exit(1)
