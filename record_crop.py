"""Recorte da gravação completa usando os instantes de reposicionamento."""
import math


def crop_filter(metadata, video_width, video_height, commands_path=None):
    if metadata.get('mode') == 'cursor-layer':
        return cursor_layer_filter(metadata, video_width, video_height, commands_path)
    monitor, area = metadata['monitor'], metadata['area']
    sx = video_width / monitor['width']
    sy = video_height / monitor['height']
    width = max(2, min(video_width, round(area['width'] * sx))) // 2 * 2
    height = max(2, min(video_height, round(area['height'] * sy))) // 2 * 2
    events = metadata['events']
    if not events or events[0]['t'] != 0:
        raise ValueError('registro de posições incompleto')
    positions = []
    last_t = -1
    for event in events:
        t = float(event['t'])
        if not math.isfinite(t) or t < last_t:
            raise ValueError('instantes de recorte inválidos')
        last_t = t
        x = round((event['x'] - monitor['x']) * sx)
        y = round((event['y'] - monitor['y']) * sy)
        x = max(0, min(video_width - width, x))
        y = max(0, min(video_height - height, y))
        positions.append((t, x, y))
    commands = ';'.join(f'{t:.6f} crop x {x}, crop y {y}' for t, x, y in positions)
    # Acompanhamento contínuo pode ultrapassar o limite de argumentos do sistema.
    if commands_path:
        with open(commands_path, 'w') as f:
            f.write(commands)
        sendcmd = f"sendcmd=f='{commands_path}'"
    else:
        sendcmd = f"sendcmd=c='{commands}'"
    _, x, y = positions[0]
    return f"setpts=PTS-STARTPTS,{sendcmd},crop={width}:{height}:{x}:{y}:exact=1"


def cursor_layer_filter(metadata, video_width, video_height, commands_path=None):
    m, a = metadata['monitor'], metadata['area']
    sx, sy = video_width / m['width'], video_height / m['height']
    w = round(a['width'] * sx) // 2 * 2
    h = round(a['height'] * sy) // 4 * 4
    if w < 2 or h < 4 or w > video_width or h > video_height:
        raise ValueError('Dimensões inválidas para a camada do cursor')
    bx = max(0, min(video_width - w, round((a['x'] - m['x']) * sx)))
    by = max(0, min(video_height - h, round((a['y'] - m['y']) * sy)))
    events = metadata['events']
    if not events or events[0]['t'] != 0:
        raise ValueError('registro de posições incompleto')
    commands = []
    last_t = -1
    for e in events:
        t = float(e['t'])
        if not math.isfinite(t) or t < last_t:
            raise ValueError('instantes de recorte inválidos')
        last_t = t
        x = max(0, min(video_width - w, round((e['x'] - m['x']) * sx)))
        y = max(0, min(video_height - h // 2, round((e['y'] - m['y']) * sy)))
        commands.append(f"{t:.6f} crop@follow x {x}, crop@follow y {y}, overlay@panel y {h // 2 if e['visible'] else h}")
    data = ';'.join(commands)
    if commands_path:
        with open(commands_path, 'w') as f:
            f.write(data)
        sendcmd = f"sendcmd=f='{commands_path}'"
    else:
        sendcmd = f"sendcmd=c='{data}'"
    return (f'setpts=PTS-STARTPTS,{sendcmd},split=2[base][cursor];'
            f'[base]crop={w}:{h}:{bx}:{by}:exact=1[fixed];'
            f'[cursor]crop@follow={w}:{h // 2}:0:0:exact=1[detail];'
            f'[fixed][detail]overlay@panel=x=0:y={h}:eval=frame:format=auto')
