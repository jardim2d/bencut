"""Atualiza a conexão gráfica de processos iniciados por um servidor antigo."""
import os


def refresh_display_environment():
    # O GNOME troca o arquivo XAUTHORITY a cada login. Consulte a sessão
    # atual do próprio usuário, sem alterar permissões de acesso ao X11.
    try:
        import dbus
        bus = dbus.SessionBus()
        manager = bus.get_object('org.freedesktop.systemd1', '/org/freedesktop/systemd1')
        values = dbus.Interface(manager, 'org.freedesktop.DBus.Properties').Get(
            'org.freedesktop.systemd1.Manager', 'Environment', timeout=3)
        env = dict(str(value).split('=', 1) for value in values if '=' in value)
        for key in ('DISPLAY', 'XAUTHORITY'):
            if env.get(key):
                os.environ[key] = env[key]
    except (ImportError, OSError, RuntimeError):
        pass  # fora do GNOME/systemd, mantém o ambiente recebido
    except Exception:
        pass  # DBus indisponível: deixa o GTK verificar a conexão normal
