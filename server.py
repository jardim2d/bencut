#!/usr/bin/env python3
"""EditorVideo — servidor local que serve a UI e executa operações FFmpeg.

Uso: python3 server.py  →  http://localhost:8765
"""
import bisect
import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import urllib.parse
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
HOME = os.path.expanduser("~")
START_DIR = os.path.join(HOME, "Vídeos") if os.path.isdir(os.path.join(HOME, "Vídeos")) else HOME

VIDEO_EXTS = {".mp4", ".mkv", ".m4v", ".mov", ".avi", ".webm", ".ts", ".flv", ".wmv", ".mpg", ".mpeg", ".3gp"}
PROJECT_EXT = ".evp"   # projeto do EditorVideo (JSON com os segmentos da timeline)
AUDIO_COPY = {"aac": ".m4a", "mp3": ".mp3", "opus": ".opus", "flac": ".flac", "vorbis": ".ogg"}

# formatos que o <video> do navegador reproduz nativamente; os demais (mkv,
# avi, wmv, flv, ts, mpg, 3gp…) precisam de uma prévia transcodificada
DIRECT_PLAYABLE_EXTS = {".mp4", ".m4v", ".mov", ".webm"}
PREVIEW_CACHE_DIR = os.path.join(HOME, ".cache", "editorvideo", "previews")
os.makedirs(PREVIEW_CACHE_DIR, exist_ok=True)
THUMB_CACHE_DIR = os.path.join(HOME, ".cache", "editorvideo", "thumbs")
os.makedirs(THUMB_CACHE_DIR, exist_ok=True)

FFMPEG = shutil.which("ffmpeg") or os.path.join(HOME, ".local/bin/ffmpeg")
FFPROBE = shutil.which("ffprobe") or os.path.join(HOME, ".local/bin/ffprobe")

# jobs[id] = {status, progress, output, error, op}
jobs = {}
jobs_lock = threading.Lock()
procs = {}   # job_id -> Popen do ffmpeg em execução (para cancelamento)


def has_nvenc():
    try:
        out = subprocess.run([FFMPEG, "-hide_banner", "-encoders"],
                             capture_output=True, text=True, timeout=10).stdout
        return "h264_nvenc" in out
    except Exception:
        return False


NVENC = None  # preenchido no main


def safe_path(path):
    """Restringe acesso a arquivos dentro do home do usuário."""
    real = os.path.realpath(path)
    if not real.startswith(HOME + os.sep) and real != HOME:
        raise PermissionError(f"acesso negado fora do home: {real}")
    return real


def unique_output(dirname, base, suffix, ext):
    """Gera nome de saída que não sobrescreve nada: base_suffix.ext, base_suffix2.ext…"""
    n = 0
    while True:
        tag = suffix if n == 0 else f"{suffix}{n + 1}"
        out = os.path.join(dirname, f"{base}_{tag}{ext}")
        if not os.path.exists(out):
            return out
        n += 1


def probe(path):
    r = subprocess.run(
        [FFPROBE, "-v", "error", "-print_format", "json",
         "-show_format", "-show_streams", path],
        capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[-400:])
    data = json.loads(r.stdout)
    fmt = data.get("format", {})
    info = {"duration": float(fmt.get("duration", 0) or 0),
            "size": int(fmt.get("size", 0) or 0),
            "format": fmt.get("format_name", ""),
            "video": None, "audio": None}
    for s in data.get("streams", []):
        if s["codec_type"] == "video" and not info["video"]:
            info["video"] = {"codec": s.get("codec_name"),
                             "width": s.get("width"), "height": s.get("height"),
                             "fps": s.get("avg_frame_rate")}
        elif s["codec_type"] == "audio" and not info["audio"]:
            info["audio"] = {"codec": s.get("codec_name"),
                             "channels": s.get("channels"),
                             "sample_rate": s.get("sample_rate")}
    return info


def needs_preview(path):
    return os.path.splitext(path)[1].lower() not in DIRECT_PLAYABLE_EXTS


def cache_key(src):
    """Chave de cache determinística por conteúdo (invalida se o arquivo mudar)."""
    st = os.stat(src)
    return hashlib.sha1(f"{src}|{st.st_mtime_ns}|{st.st_size}".encode()).hexdigest()


def preview_cache_path(src):
    return os.path.join(PREVIEW_CACHE_DIR, cache_key(src) + ".mp4")


_meta_cache = {}
_meta_lock = threading.Lock()


def quick_duration(src):
    """Duração em segundos lendo só o header (ffprobe rápido), com cache em memória."""
    key = cache_key(src)
    with _meta_lock:
        if key in _meta_cache:
            return _meta_cache[key]
    r = subprocess.run(
        [FFPROBE, "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", src],
        capture_output=True, text=True, timeout=20)
    try:
        dur = float(r.stdout.strip())
    except ValueError:
        dur = 0.0
    with _meta_lock:
        _meta_cache[key] = dur
    return dur


THUMB_SEM = threading.Semaphore(3)   # limita ffmpegs simultâneos gerando miniaturas


def make_thumb(src):
    """Extrai 1 frame do vídeo como miniatura jpg, com cache em disco."""
    out = os.path.join(THUMB_CACHE_DIR, cache_key(src) + ".jpg")
    if os.path.exists(out):
        return out
    dur = quick_duration(src)
    # frame a 10% da duração (máx. 5 s): pula telas pretas de abertura sem
    # decodificar demais em arquivos com poucos keyframes (gravações de tela)
    t = min(dur * 0.1, 5.0) if dur > 0 else 0.0
    with THUMB_SEM:
        for ss in ([t, 0.0] if t > 0 else [0.0]):
            r = subprocess.run(
                [FFMPEG, "-nostdin", "-y", "-ss", f"{ss:.3f}", "-i", src,
                 "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", out],
                capture_output=True, text=True, timeout=60)
            if r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 0:
                return out
    raise RuntimeError("falha ao gerar miniatura")


def build_preview_cmd(src, out, info):
    """Gera uma prévia .mp4 tocável no navegador: remuxa (cópia) o que já for
    compatível e recodifica só o que não for, para ficar o mais rápido possível."""
    vcodec = info["video"]["codec"] if info["video"] else None
    acodec = info["audio"]["codec"] if info["audio"] else None
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-i", src]
    if vcodec == "h264":
        cmd += ["-c:v", "copy"]
    elif NVENC:
        cmd += ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "23"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"]
    if acodec is None:
        cmd += ["-an"]
    elif acodec == "aac":
        cmd += ["-c:a", "copy"]
    else:
        cmd += ["-c:a", "aac", "-b:a", "160k"]
    cmd += ["-movflags", "+faststart", out]
    return cmd


KEYFRAME_EPS = 0.05  # mesma tolerância usada no frontend (CUT_EPS)

# codec de origem -> args de recodificação de borda (mesmo codec, para permitir
# concatenar por stream copy com o restante do arquivo original)
EDGE_VIDEO_ENCODERS = {
    "h264": ["-c:v", "libx264", "-preset", "medium", "-crf", "12", "-pix_fmt", "yuv420p"],
    "hevc": ["-c:v", "libx265", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p"],
    "vp8": ["-c:v", "libvpx", "-crf", "10", "-b:v", "2M"],
    "vp9": ["-c:v", "libvpx-vp9", "-crf", "18", "-b:v", "0"],
}
EDGE_VIDEO_ENCODERS_NVENC = {
    "h264": ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "12"],
    "hevc": ["-c:v", "hevc_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "14"],
}
EDGE_AUDIO_ENCODERS = {
    "aac": ["-c:a", "aac", "-b:a", "192k"],
    "mp3": ["-c:a", "libmp3lame", "-q:a", "2"],
    "opus": ["-c:a", "libopus", "-b:a", "160k"],
    "vorbis": ["-c:a", "libvorbis", "-q:a", "5"],
    "flac": ["-c:a", "flac"],
}


def get_keyframes(path):
    """Lista os instantes (segundos) dos keyframes do vídeo, em ordem crescente."""
    r = subprocess.run(
        [FFPROBE, "-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey",
         "-show_entries", "frame=pts_time", "-of", "csv=p=0", path],
        capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        return []
    kfs = []
    for line in r.stdout.splitlines():
        line = line.strip()
        if line:
            try:
                kfs.append(float(line))
            except ValueError:
                pass
    kfs.sort()
    return kfs


def encode_edge(src, start, end, info, out_dir, tmp_files, use_nvenc):
    """Recodifica com precisão de frame um trecho curto [start, end) de `src`.

    Usado só nas bordas que não caem num keyframe: reencoda no MESMO codec de
    origem para que o resultado possa ser concatenado por stream copy com o
    restante do arquivo, sem quebrar a cadeia de referência de P-frames (causa
    dos blocos corrompidos no preview ao cortar/remover trechos no meio do vídeo).
    """
    vcodec = info["video"]["codec"] if info["video"] else None
    vargs = None
    if use_nvenc and vcodec in EDGE_VIDEO_ENCODERS_NVENC:
        vargs = EDGE_VIDEO_ENCODERS_NVENC[vcodec]
    elif vcodec in EDGE_VIDEO_ENCODERS:
        vargs = EDGE_VIDEO_ENCODERS[vcodec]
    if vargs is None:
        raise RuntimeError(
            f"corte preciso não suportado para o codec de vídeo '{vcodec}'")
    ext = os.path.splitext(src)[1]
    tmp_out = os.path.join(out_dir, f".edge_{uuid.uuid4().hex[:8]}{ext}")
    acodec = (EDGE_AUDIO_ENCODERS.get(info["audio"]["codec"], ["-c:a", "aac", "-b:a", "192k"])
              if info["audio"] else ["-an"])

    # busca de entrada (-ss antes de -i): rápida, mas alguns arquivos (ex.: gravações
    # de tela VFR com um único keyframe) têm índice de seek problemático e o ffmpeg
    # falha ao decodificar a partir do ponto buscado. Nesse caso cai para busca de
    # saída (decodifica do início e corta depois) — mais lenta, porém sempre confiável.
    fast_cmd = [FFMPEG, "-nostdin", "-y", "-ss", str(start), "-to", str(end),
                "-i", src] + vargs + acodec + [tmp_out]
    r = subprocess.run(fast_cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        slow_cmd = [FFMPEG, "-nostdin", "-y", "-i", src, "-ss", str(start), "-to", str(end)] \
            + vargs + acodec + [tmp_out]
        r = subprocess.run(slow_cmd, capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise RuntimeError(f"falha ao recodificar borda: {r.stderr.strip()[-300:]}")
    tmp_files.append(tmp_out)
    return tmp_out


def atempo_chain(speed):
    """O filtro atempo só aceita [0.5, 2.0]; encadeia para cobrir qualquer fator."""
    filters, remaining = [], speed
    while remaining > 2.0:
        filters.append("atempo=2.0")
        remaining /= 2.0
    while remaining < 0.5:
        filters.append("atempo=0.5")
        remaining /= 0.5
    filters.append(f"atempo={remaining:.6f}")
    return ",".join(filters)


def encode_speed(src, start, end, speed, info, out_dir, tmp_files, use_nvenc):
    """Recodifica [start, end) de `src` já acelerado/desacelerado por `speed`x.

    Sempre precisa recodificar (não dá pra mudar velocidade com stream copy);
    usa o mesmo codec de origem para poder concatenar o resultado com o resto
    do arquivo por stream copy quando o segmento vizinho não for alterado.
    """
    vcodec = info["video"]["codec"] if info["video"] else None
    vargs = None
    if use_nvenc and vcodec in EDGE_VIDEO_ENCODERS_NVENC:
        vargs = EDGE_VIDEO_ENCODERS_NVENC[vcodec]
    elif vcodec in EDGE_VIDEO_ENCODERS:
        vargs = EDGE_VIDEO_ENCODERS[vcodec]
    if vargs is None:
        raise RuntimeError(
            f"aceleração não suportada para o codec de vídeo '{vcodec}'")
    ext = os.path.splitext(src)[1]
    tmp_out = os.path.join(out_dir, f".speed_{uuid.uuid4().hex[:8]}{ext}")
    vf = ["-vf", f"setpts=PTS/{speed}"]
    if info["audio"]:
        acodec = EDGE_AUDIO_ENCODERS.get(info["audio"]["codec"], ["-c:a", "aac", "-b:a", "192k"])
        aargs = ["-af", atempo_chain(speed)] + acodec
    else:
        aargs = ["-an"]

    fast_cmd = [FFMPEG, "-nostdin", "-y", "-ss", str(start), "-to", str(end),
                "-i", src] + vf + vargs + aargs + [tmp_out]
    r = subprocess.run(fast_cmd, capture_output=True, text=True, timeout=600)
    if r.returncode != 0:
        slow_cmd = [FFMPEG, "-nostdin", "-y", "-i", src, "-ss", str(start), "-to", str(end)] \
            + vf + vargs + aargs + [tmp_out]
        r = subprocess.run(slow_cmd, capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            raise RuntimeError(f"falha ao acelerar trecho: {r.stderr.strip()[-300:]}")
    tmp_files.append(tmp_out)
    return tmp_out


def encode_black(dur, info, src, out_dir, tmp_files, use_nvenc):
    """Gera um clipe de `dur` s de tela preta + silêncio, no MESMO codec/resolução/
    fps/áudio do source, para representar uma lacuna e ser concatenado com os demais
    trechos (o concat demuxer exige mesmo codec)."""
    v = info.get("video") or {}
    vcodec = v.get("codec")
    if use_nvenc and vcodec in EDGE_VIDEO_ENCODERS_NVENC:
        vargs = EDGE_VIDEO_ENCODERS_NVENC[vcodec]
    elif vcodec in EDGE_VIDEO_ENCODERS:
        vargs = EDGE_VIDEO_ENCODERS[vcodec]
    else:
        raise RuntimeError(f"lacuna preta não suportada para o codec de vídeo '{vcodec}'")
    w = int(v.get("width") or 1920)
    h = int(v.get("height") or 1080)
    fps = str(v.get("fps") or "30/1")
    if "/" in fps:
        n, _, den = fps.partition("/")
        if not n or n == "0" or not den or den == "0":
            fps = "30/1"
    ext = os.path.splitext(src)[1]
    tmp_out = os.path.join(out_dir, f".black_{uuid.uuid4().hex[:8]}{ext}")
    inputs = ["-f", "lavfi", "-i", f"color=c=black:s={w}x{h}:r={fps}"]
    if info.get("audio"):
        sr = info["audio"].get("sample_rate") or "48000"
        cl = "mono" if (info["audio"].get("channels") or 2) == 1 else "stereo"
        inputs += ["-f", "lavfi", "-i", f"anullsrc=r={sr}:cl={cl}"]
        aargs = EDGE_AUDIO_ENCODERS.get(info["audio"]["codec"], ["-c:a", "aac", "-b:a", "192k"])
    else:
        aargs = ["-an"]
    cmd = [FFMPEG, "-nostdin", "-y"] + inputs + ["-t", f"{dur:.4f}"] \
        + vargs + ["-pix_fmt", "yuv420p"] + aargs + [tmp_out]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise RuntimeError(f"falha ao gerar lacuna preta: {r.stderr.strip()[-300:]}")
    tmp_files.append(tmp_out)
    return tmp_out


def build_segment(src, start, end, info, keyframes, out_dir, tmp_files, use_nvenc):
    """Gera as linhas do concat-list representando o trecho [start, end) de `src`.

    Se `start` já cai num keyframe (dentro de KEYFRAME_EPS), usa cópia direta
    (rápido, comportamento original). Caso contrário, insere antes um pedaço
    curto recodificado até o próximo keyframe, evitando que o restante — copiado
    sem recodificar — comece com um P-frame sem sua referência (o que corrompe
    o vídeo na reprodução).
    """
    esc = src.replace("'", "'\\''")
    i = bisect.bisect_left(keyframes, start - KEYFRAME_EPS)
    kf = keyframes[i] if i < len(keyframes) else None
    aligned = kf is not None and abs(kf - start) <= KEYFRAME_EPS

    if aligned:
        lines = [f"file '{esc}'\n"]
        if start > 0.01:
            lines.append(f"inpoint {start}\n")
        lines.append(f"outpoint {end}\n")
        return lines

    if kf is None or kf >= end:
        # nenhum keyframe alcançável dentro do trecho: recodifica ele inteiro
        edge = encode_edge(src, start, end, info, out_dir, tmp_files, use_nvenc)
        edge_esc = edge.replace("'", "'\\''")
        return [f"file '{edge_esc}'\n"]

    edge = encode_edge(src, start, kf, info, out_dir, tmp_files, use_nvenc)
    edge_esc = edge.replace("'", "'\\''")
    return [f"file '{edge_esc}'\n", f"file '{esc}'\n",
            f"inpoint {kf}\n", f"outpoint {end}\n"]


def run_job(job_id, cmd, total_duration, output, cleanup=None):
    """Executa ffmpeg lendo -progress de stdout e atualiza jobs[job_id]."""
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        with jobs_lock:
            procs[job_id] = proc
        stderr_tail = []

        def read_err():
            for line in proc.stderr:
                stderr_tail.append(line)
                if len(stderr_tail) > 30:
                    stderr_tail.pop(0)
        t = threading.Thread(target=read_err, daemon=True)
        t.start()

        for line in proc.stdout:
            line = line.strip()
            if line.startswith("out_time_ms=") and total_duration > 0:
                try:
                    ms = int(line.split("=")[1])
                    pct = min(99, ms / 1_000_000 / total_duration * 100)
                    with jobs_lock:
                        jobs[job_id]["progress"] = round(pct, 1)
                except ValueError:
                    pass
        proc.wait()
        t.join(timeout=5)
        with jobs_lock:
            if jobs[job_id].get("cancelled"):
                jobs[job_id].update(status="cancelled")
                if os.path.exists(output):
                    os.remove(output)     # descarta a saída parcial
            elif proc.returncode == 0:
                jobs[job_id].update(status="done", progress=100, output=output)
            else:
                jobs[job_id].update(status="error",
                                    error="".join(stderr_tail)[-500:])
                if os.path.exists(output):
                    os.remove(output)
    except Exception as e:
        with jobs_lock:
            jobs[job_id].update(status="error", error=str(e))
    finally:
        with jobs_lock:
            procs.pop(job_id, None)
        paths = cleanup if isinstance(cleanup, list) else ([cleanup] if cleanup else [])
        for c in paths:
            if c and os.path.exists(c):
                os.remove(c)


def start_job(op, cmd, duration, output, cleanup=None):
    job_id = uuid.uuid4().hex[:12]
    with jobs_lock:
        jobs[job_id] = {"status": "running", "progress": 0, "op": op,
                        "output": output, "error": None}
    threading.Thread(target=run_job, args=(job_id, cmd, duration, output, cleanup),
                     daemon=True).start()
    return job_id


# ---------- operações ----------

def op_cut(p):
    src = safe_path(p["input"])
    start, end = float(p["start"]), float(p["end"])
    info = probe(src)
    keyframes = get_keyframes(src)
    d, name = os.path.dirname(src), os.path.splitext(os.path.basename(src))
    out = unique_output(d, name[0], "corte", name[1])
    tmp_files = []
    lines = build_segment(src, start, end, info, keyframes, d, tmp_files, NVENC)
    lst = out + ".txt"
    with open(lst, "w") as f:
        f.writelines(lines)
    tmp_files.append(lst)
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
           "-f", "concat", "-safe", "0", "-i", lst,
           "-c", "copy", "-avoid_negative_ts", "make_zero", out]
    return start_job("cut", cmd, end - start, out, cleanup=tmp_files)


def op_join(p):
    srcs = [safe_path(f) for f in p["inputs"]]
    if len(srcs) < 2:
        raise ValueError("junte pelo menos 2 arquivos")
    total = sum(probe(s)["duration"] for s in srcs)
    d, name = os.path.dirname(srcs[0]), os.path.splitext(os.path.basename(srcs[0]))
    out = unique_output(d, name[0], "juntado", name[1])
    lst = out + ".txt"
    with open(lst, "w") as f:
        for s in srcs:
            f.write("file '" + s.replace("'", "'\\''") + "'\n")
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
           "-f", "concat", "-safe", "0", "-i", lst, "-c", "copy", out]
    return start_job("join", cmd, total, out, cleanup=lst)


def op_convert(p):
    src = safe_path(p["input"])
    ext = p.get("format", "mp4")
    quality = p.get("quality", "media")  # alta | media | baixa
    duration = probe(src)["duration"]
    d, name = os.path.dirname(src), os.path.splitext(os.path.basename(src))
    out = unique_output(d, name[0], "convertido", "." + ext)
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-i", src]
    if ext == "webm":
        # NVENC não codifica VP9 (só decodifica em algumas placas); sempre CPU.
        cq = {"alta": "24", "media": "31", "baixa": "37"}[quality]
        cmd += ["-c:v", "libvpx-vp9", "-crf", cq, "-b:v", "0",
                "-row-mt", "1", "-cpu-used", "2",
                "-c:a", "libopus", "-b:a", "128k"]
    else:
        cq = {"alta": "19", "media": "23", "baixa": "28"}[quality]
        if NVENC and p.get("gpu", True):
            # -forced-idr: sem ela o NVENC ignora o -force_key_frames abaixo
            cmd += ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", cq,
                    "-b:v", "0", "-forced-idr", "1"]
        else:
            cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", cq]
        cmd += ["-c:a", "aac", "-b:a", "160k"]
    # keyframe a cada 2 s DE TEMPO (não de quadros: gravações de tela são VFR e
    # emitem poucos quadros, então -g sozinho deixaria intervalos enormes); sem
    # isso a saída herda o padrão do encoder e vídeos convertidos continuariam
    # lentos de cortar/buscar depois
    cmd += ["-force_key_frames", "expr:gte(t,n_forced*2)", out]
    return start_job("convert", cmd, duration, out)


def op_extract_audio(p):
    src = safe_path(p["input"])
    info = probe(src)
    if not info["audio"]:
        raise ValueError("o arquivo não tem faixa de áudio")
    codec = info["audio"]["codec"]
    d, name = os.path.dirname(src), os.path.splitext(os.path.basename(src))
    if codec in AUDIO_COPY:
        out = unique_output(d, name[0], "audio", AUDIO_COPY[codec])
        acodec = ["-c:a", "copy"]
    else:
        out = unique_output(d, name[0], "audio", ".mp3")
        acodec = ["-c:a", "libmp3lame", "-q:a", "2"]
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
           "-i", src, "-vn"] + acodec + [out]
    return start_job("extract", cmd, info["duration"], out)


def op_delete(p):
    """Gera o vídeo SEM o intervalo [start, end], emendando o resto com -c copy."""
    src = safe_path(p["input"])
    start, end = float(p["start"]), float(p["end"])
    info = probe(src)
    dur = info["duration"]
    keep_head = start > 0.1
    keep_tail = end < dur - 0.1
    if not keep_head and not keep_tail:
        raise ValueError("o trecho marcado cobre o vídeo inteiro")
    keyframes = get_keyframes(src)
    d, name = os.path.dirname(src), os.path.splitext(os.path.basename(src))
    out = unique_output(d, name[0], "semtrecho", name[1])
    tmp_files = []
    lines = []
    if keep_head:
        lines += build_segment(src, 0.0, start, info, keyframes, d, tmp_files, NVENC)
    if keep_tail:
        lines += build_segment(src, end, dur, info, keyframes, d, tmp_files, NVENC)
    lst = out + ".txt"
    with open(lst, "w") as f:
        f.writelines(lines)
    tmp_files.append(lst)
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
           "-f", "concat", "-safe", "0", "-i", lst,
           "-c", "copy", "-avoid_negative_ts", "make_zero", out]
    return start_job("delete", cmd, dur - (end - start), out, cleanup=tmp_files)


def op_render(p):
    """Monta o vídeo a partir dos segmentos mantidos [[start, end, speed], ...], com
    -c copy — segmentos com speed != 1 são recodificados antes (não dá pra mudar
    velocidade com stream copy) e emendados aos demais igual às bordas de corte."""
    src = safe_path(p["input"])
    parts = [(float(x[0]), float(x[1]), float(x[2]), float(x[3]) if len(x) > 3 else 0.0)
             for x in p["parts"]]
    if not parts:
        raise ValueError("nenhum segmento restante para exportar")
    info = probe(src)
    keyframes = get_keyframes(src)
    d, name = os.path.dirname(src), os.path.splitext(os.path.basename(src))
    out = safe_path(p["output"]) if p.get("output") else unique_output(d, name[0], "editado", name[1])
    tmp_files = []
    lines = []
    for s, e, sp, gap in parts:
        if gap > 0.001:   # lacuna → trecho de preto+silêncio antes do segmento
            blk = encode_black(gap, info, src, d, tmp_files, NVENC)
            lines.append(f"file '{blk.replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'\n")
        if abs(sp - 1.0) > 1e-6:
            seg = encode_speed(src, s, e, sp, info, d, tmp_files, NVENC)
            lines.append(f"file '{seg.replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'\n")
        else:
            lines += build_segment(src, s, e, info, keyframes, d, tmp_files, NVENC)
    lst = out + ".txt"
    with open(lst, "w") as f:
        f.writelines(lines)
    tmp_files.append(lst)
    total = sum((e - s) / sp + gap for s, e, sp, gap in parts)
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
           "-f", "concat", "-safe", "0", "-i", lst,
           "-c", "copy", "-avoid_negative_ts", "make_zero", out]
    return start_job("render", cmd, total, out, cleanup=tmp_files)


def op_render_convert(p):
    """Exporta os segmentos e recodifica para um novo formato. Segmentos com
    speed != 1 passam antes por encode_speed (todo o resto já é recodificado
    aqui mesmo, então não precisa casar codec nem alinhar keyframe)."""
    src = safe_path(p["input"])
    parts = [(float(x[0]), float(x[1]), float(x[2]), float(x[3]) if len(x) > 3 else 0.0)
             for x in p["parts"]]
    fmt = p.get("format", "mp4")
    if not parts:
        raise ValueError("nenhum segmento restante para exportar")
    info = probe(src)
    d, name = os.path.dirname(src), os.path.splitext(os.path.basename(src))
    out = safe_path(p["output"]) if p.get("output") else unique_output(d, name[0], "editado", "." + fmt)
    esc = src.replace("'", "'\\''")
    tmp_files = []
    lst = out + ".txt"
    with open(lst, "w") as f:
        for s, e, sp, gap in parts:
            if gap > 0.001:
                blk = encode_black(gap, info, src, d, tmp_files, NVENC)
                f.write(f"file '{blk.replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'\n")
            if abs(sp - 1.0) > 1e-6:
                seg = encode_speed(src, s, e, sp, info, d, tmp_files, NVENC)
                f.write(f"file '{seg.replace(chr(39), chr(39) + chr(92) + chr(39) + chr(39))}'\n")
            else:
                f.write(f"file '{esc}'\n")
                if s > 0.01:
                    f.write(f"inpoint {s}\n")
                f.write(f"outpoint {e}\n")
    tmp_files.append(lst)
    total = sum((e - s) / sp + gap for s, e, sp, gap in parts)
    if fmt == "webm":
        enc = ["-c:v", "libvpx-vp9", "-crf", "31", "-b:v", "0",
               "-row-mt", "1", "-cpu-used", "2", "-c:a", "libopus", "-b:a", "128k"]
    else:
        enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "23",
               "-c:a", "aac", "-b:a", "160k"]
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
           "-f", "concat", "-safe", "0", "-i", lst] + enc + \
        ["-force_key_frames", "expr:gte(t,n_forced*2)", out]
    return start_job("render_convert", cmd, total, out, cleanup=tmp_files)


def op_render_multi(p):
    """Exporta uma timeline que mistura VÁRIOS arquivos-fonte.

    Como os arquivos podem ter codec/resolução/fps/áudio diferentes, o -c copy do
    concat demuxer não serve. Aqui cada trecho é normalizado (escala+pad para um
    tamanho comum, fps e samplerate fixos, aceleração aplicada) e todos são unidos
    pelo filtro concat, recodificando uma única vez. As lacunas viram trechos de
    preto+silêncio já no tamanho-alvo.

    parts = [[src, start, end, speed, gap], ...]
    """
    parts = [(safe_path(x[0]), float(x[1]), float(x[2]), float(x[3]),
              float(x[4]) if len(x) > 4 else 0.0) for x in p["parts"]]
    if not parts:
        raise ValueError("nenhum segmento para exportar")
    fmt = p.get("format") or "mp4"
    infos = {}
    for src, *_ in parts:
        if src not in infos:
            infos[src] = probe(src)
    # tamanho-alvo: primeiro vídeo disponível define WxH; fps/samplerate fixos
    W = H = None
    for src, *_ in parts:
        v = infos[src]["video"]
        if v and v.get("width") and v.get("height"):
            W, H = int(v["width"]), int(v["height"])
            break
    if not W:
        W, H = 1920, 1080
    W -= W % 2   # dimensões pares: yuv420p exige, e evita o scale arredondar 1px
    H -= H % 2   # para cima e estourar o pad ("padded dims smaller than input")
    FPS, SR = 30, 48000

    inputs, vfilters, afilters, labels = [], [], [], []
    idx = 0

    def add_black(gap):
        nonlocal idx
        inputs.extend(["-f", "lavfi", "-t", f"{gap:.4f}",
                       "-i", f"color=c=black:s={W}x{H}:r={FPS}"])
        vi = idx
        idx += 1
        inputs.extend(["-f", "lavfi", "-t", f"{gap:.4f}",
                       "-i", f"anullsrc=r={SR}:cl=stereo"])
        ai = idx
        idx += 1
        vfilters.append(f"[{vi}:v]setsar=1,format=yuv420p[v{vi}]")
        afilters.append(f"[{ai}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a{ai}]")
        labels.append((f"v{vi}", f"a{ai}"))

    def add_clip(src, s, e, sp):
        nonlocal idx
        # trim por -ss/-to na entrada (rápido); depois normaliza no grafo
        inputs.extend(["-ss", f"{s}", "-to", f"{e}", "-i", src])
        vi = idx
        idx += 1
        vfilters.append(
            f"[{vi}:v]setpts=PTS/{sp:.6f},"
            f"scale={W}:{H}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
            f"pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,fps={FPS},setsar=1,format=yuv420p[v{vi}]")
        if infos[src]["audio"]:
            afilters.append(
                f"[{vi}:a]{atempo_chain(sp)},aresample={SR},"
                f"aformat=sample_fmts=fltp:channel_layouts=stereo[a{vi}]")
            labels.append((f"v{vi}", f"a{vi}"))
        else:  # arquivo sem áudio: gera silêncio da mesma duração para o concat casar
            dur = (e - s) / sp
            inputs.extend(["-f", "lavfi", "-t", f"{dur:.4f}",
                           "-i", f"anullsrc=r={SR}:cl=stereo"])
            ai = idx
            idx += 1
            afilters.append(f"[{ai}:a]aformat=sample_fmts=fltp:channel_layouts=stereo[a{ai}]")
            labels.append((f"v{vi}", f"a{ai}"))

    for src, s, e, sp, gap in parts:
        if gap > 0.001:
            add_black(gap)
        add_clip(src, s, e, sp)

    n = len(labels)
    concat_in = "".join(f"[{v}][{a}]" for v, a in labels)
    graph = ";".join(vfilters + afilters +
                     [f"{concat_in}concat=n={n}:v=1:a=1[vout][aout]"])

    d = os.path.dirname(parts[0][0])
    base = os.path.splitext(os.path.basename(parts[0][0]))[0]
    out = safe_path(p["output"]) if p.get("output") else unique_output(d, base, "editado", "." + fmt)

    if fmt == "webm":
        venc = ["-c:v", "libvpx-vp9", "-crf", "31", "-b:v", "0", "-row-mt", "1", "-cpu-used", "2"]
        aenc = ["-c:a", "libopus", "-b:a", "128k"]
        tail = []
    else:
        venc = (["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "23", "-b:v", "0"]
                if NVENC else ["-c:v", "libx264", "-preset", "medium", "-crf", "23"])
        aenc = ["-c:a", "aac", "-b:a", "160k"]
        tail = ["-movflags", "+faststart"]

    total = sum((e - s) / sp + gap for _, s, e, sp, gap in parts)
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats"] + inputs + \
        ["-filter_complex", graph, "-map", "[vout]", "-map", "[aout]"] + venc + aenc + tail + [out]
    return start_job("render_multi", cmd, total, out)


OPS = {"cut": op_cut, "join": op_join, "convert": op_convert,
       "extract": op_extract_audio, "delete": op_delete, "render": op_render,
       "render_convert": op_render_convert, "render_multi": op_render_multi}


# ---------- HTTP ----------

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass  # silencia log de cada request

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _static(self, rel):
        path = os.path.realpath(os.path.join(ROOT, rel.lstrip("/")))
        if not path.startswith(ROOT) or not os.path.isfile(path):
            self._json({"error": "não encontrado"}, 404)
            return
        ctype = {"html": "text/html", "js": "text/javascript",
                 "css": "text/css", "svg": "image/svg+xml"}.get(
                     path.rsplit(".", 1)[-1], "application/octet-stream")
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _media(self, path):
        """Serve vídeo com suporte a Range (necessário para seek no <video>)."""
        try:
            path = safe_path(path)
        except PermissionError:
            self._json({"error": "acesso negado"}, 403)
            return
        if not os.path.isfile(path):
            self._json({"error": "não encontrado"}, 404)
            return
        size = os.path.getsize(path)
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                if m.group(2):
                    end = min(int(m.group(2)), size - 1)
        length = end - start + 1
        self.send_response(206 if rng else 200)
        self.send_header("Content-Type", "video/mp4")
        self.send_header("Accept-Ranges", "bytes")
        if rng:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(length))
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1024 * 512, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                remaining -= len(chunk)

    def do_GET(self):
        url = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(url.query)
        route = url.path

        if route == "/":
            return self._static("index.html")
        if route.startswith("/js/") or route.startswith("/css/") or route.startswith("/icons/"):
            return self._static(route)

        if route == "/api/config":
            return self._json({"nvenc": NVENC, "startDir": START_DIR,
                               "ffmpeg": FFMPEG})

        if route == "/api/list":
            try:
                d = safe_path(q.get("dir", [START_DIR])[0])
                entries = {"dir": d, "parent": os.path.dirname(d),
                           "dirs": [], "files": []}
                for name in sorted(os.listdir(d), key=str.lower):
                    if name.startswith("."):
                        continue
                    full = os.path.join(d, name)
                    if os.path.isdir(full):
                        entries["dirs"].append(name)
                    elif os.path.splitext(name)[1].lower() in VIDEO_EXTS \
                            or name.lower().endswith(PROJECT_EXT):
                        entries["files"].append(
                            {"name": name, "size": os.path.getsize(full)})
                return self._json(entries)
            except (PermissionError, FileNotFoundError) as e:
                return self._json({"error": str(e)}, 403)

        if route == "/api/probe":
            try:
                return self._json(probe(safe_path(q["path"][0])))
            except Exception as e:
                return self._json({"error": str(e)}, 400)

        if route == "/api/media":
            return self._media(q.get("path", [""])[0])

        if route == "/api/thumb":
            try:
                thumb = make_thumb(safe_path(q["path"][0]))
                with open(thumb, "rb") as f:
                    data = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(data)
                return
            except Exception as e:
                return self._json({"error": str(e)}, 404)

        if route == "/api/meta":
            try:
                return self._json(
                    {"duration": quick_duration(safe_path(q["path"][0]))})
            except Exception as e:
                return self._json({"error": str(e)}, 400)

        if route == "/api/preview":
            try:
                src = safe_path(q["path"][0])
                if not needs_preview(src):
                    return self._json({"ready": True, "path": src})
                out = preview_cache_path(src)
                if os.path.exists(out):
                    return self._json({"ready": True, "path": out})
                info = probe(src)
                job_id = start_job("preview", build_preview_cmd(src, out, info),
                                   info["duration"], out)
                return self._json({"ready": False, "job": job_id})
            except Exception as e:
                return self._json({"error": str(e)}, 400)

        if route == "/api/pick-open":
            try:
                title = q.get("title", ["Abrir arquivo"])[0]
                pattern = q.get("filter", ["*"])[0]
                cmd = ["zenity", "--file-selection", f"--title={title}",
                       f"--filename={START_DIR}/", f"--file-filter={pattern}"]
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
                if r.returncode != 0:
                    return self._json({"cancelled": True})
                return self._json({"path": safe_path(r.stdout.strip())})
            except FileNotFoundError:
                return self._json(
                    {"error": "zenity não encontrado (instale: sudo apt install zenity)"}, 500)
            except Exception as e:
                return self._json({"error": str(e)}, 400)

        if route == "/api/pick-save":
            try:
                src = safe_path(q["input"][0])
                ext = (q.get("ext", [None])[0] or os.path.splitext(src)[1].lstrip(".")).lstrip(".")
                suffix = q.get("suffix", ["editado"])[0]
                title = q.get("title", ["Salvar vídeo exportado"])[0]
                d, name = os.path.dirname(src), os.path.splitext(os.path.basename(src))
                suggested = unique_output(d, name[0], suffix, "." + ext)
                r = subprocess.run(
                    ["zenity", "--file-selection", "--save", "--confirm-overwrite",
                     f"--title={title}", f"--filename={suggested}"],
                    capture_output=True, text=True, timeout=600)
                if r.returncode != 0:
                    return self._json({"cancelled": True})
                chosen = safe_path(r.stdout.strip())
                return self._json({"path": chosen})
            except FileNotFoundError:
                return self._json(
                    {"error": "zenity não encontrado (instale: sudo apt install zenity)"}, 500)
            except Exception as e:
                return self._json({"error": str(e)}, 400)

        if route == "/api/project-load":
            try:
                path = safe_path(q["path"][0])
                with open(path, encoding="utf-8") as f:
                    proj = json.load(f)
                if not isinstance(proj.get("segments"), list):
                    raise ValueError("arquivo de projeto inválido")
                return self._json(proj)
            except Exception as e:
                return self._json({"error": str(e)}, 400)

        if route == "/api/jobs":
            with jobs_lock:
                return self._json(jobs)

        if route == "/api/cancel":
            job_id = q.get("job", [""])[0]
            with jobs_lock:
                j = jobs.get(job_id)
                if not j or j["status"] != "running":
                    return self._json({"ok": False})
                j["cancelled"] = True
                proc = procs.get(job_id)
            if proc:
                proc.terminate()   # run_job percebe, marca "cancelled" e limpa a saída
            return self._json({"ok": True})

        self._json({"error": "rota desconhecida"}, 404)

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
        except Exception as e:
            return self._json({"error": str(e)}, 400)

        if self.path == "/api/project-save":
            try:
                path = safe_path(body["path"])
                if not path.lower().endswith(PROJECT_EXT):
                    path += PROJECT_EXT
                with open(path, "w", encoding="utf-8") as f:
                    json.dump(body["project"], f, ensure_ascii=False, indent=1)
                return self._json({"path": path})
            except Exception as e:
                return self._json({"error": str(e)}, 400)

        if self.path == "/api/job":
            try:
                op = body["op"]
                job_id = OPS[op](body)
                return self._json({"job": job_id})
            except Exception as e:
                return self._json({"error": str(e)}, 400)

        return self._json({"error": "rota desconhecida"}, 404)


def main():
    global NVENC
    if not os.path.isfile(FFMPEG):
        print("ERRO: ffmpeg não encontrado. Instale com: sudo apt install ffmpeg")
        return
    NVENC = has_nvenc()
    print(f"FFmpeg: {FFMPEG}")
    print(f"NVENC (GPU): {'disponível' if NVENC else 'indisponível — usando CPU'}")
    print(f"EditorVideo rodando em http://localhost:{PORT}")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
