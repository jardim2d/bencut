#!/usr/bin/env python3
"""EditorVideo — servidor local que serve a UI e executa operações FFmpeg.

Uso: python3 server.py  →  http://localhost:8765
"""
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
AUDIO_COPY = {"aac": ".m4a", "mp3": ".mp3", "opus": ".opus", "flac": ".flac", "vorbis": ".ogg"}

FFMPEG = shutil.which("ffmpeg") or os.path.join(HOME, ".local/bin/ffmpeg")
FFPROBE = shutil.which("ffprobe") or os.path.join(HOME, ".local/bin/ffprobe")

# jobs[id] = {status, progress, output, error, op}
jobs = {}
jobs_lock = threading.Lock()


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
                             "channels": s.get("channels")}
    return info


def run_job(job_id, cmd, total_duration, output, cleanup=None):
    """Executa ffmpeg lendo -progress de stdout e atualiza jobs[job_id]."""
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
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
            if proc.returncode == 0:
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
        if cleanup and os.path.exists(cleanup):
            os.remove(cleanup)


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
    d, name = os.path.dirname(src), os.path.splitext(os.path.basename(src))
    out = unique_output(d, name[0], "corte", name[1])
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
           "-ss", str(start), "-to", str(end), "-i", src,
           "-c", "copy", "-avoid_negative_ts", "make_zero", out]
    return start_job("cut", cmd, end - start, out)


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
    cq = {"alta": "19", "media": "23", "baixa": "28"}[quality]
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats", "-i", src]
    if NVENC and p.get("gpu", True):
        cmd += ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", cq,
                "-b:v", "0"]
    else:
        cmd += ["-c:v", "libx264", "-preset", "medium", "-crf", cq]
    cmd += ["-c:a", "aac", "-b:a", "160k", out]
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
    dur = probe(src)["duration"]
    keep_head = start > 0.1
    keep_tail = end < dur - 0.1
    if not keep_head and not keep_tail:
        raise ValueError("o trecho marcado cobre o vídeo inteiro")
    d, name = os.path.dirname(src), os.path.splitext(os.path.basename(src))
    out = unique_output(d, name[0], "semtrecho", name[1])
    esc = src.replace("'", "'\\''")
    lst = out + ".txt"
    with open(lst, "w") as f:
        if keep_head:
            f.write(f"file '{esc}'\noutpoint {start}\n")
        if keep_tail:
            f.write(f"file '{esc}'\ninpoint {end}\n")
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
           "-f", "concat", "-safe", "0", "-i", lst,
           "-c", "copy", "-avoid_negative_ts", "make_zero", out]
    return start_job("delete", cmd, dur - (end - start), out, cleanup=lst)


def op_render(p):
    """Monta o vídeo a partir dos segmentos mantidos [[start, end], ...], com -c copy."""
    src = safe_path(p["input"])
    parts = [(float(s), float(e)) for s, e in p["parts"]]
    if not parts:
        raise ValueError("nenhum segmento restante para exportar")
    d, name = os.path.dirname(src), os.path.splitext(os.path.basename(src))
    out = unique_output(d, name[0], "editado", name[1])
    esc = src.replace("'", "'\\''")
    lst = out + ".txt"
    with open(lst, "w") as f:
        for s, e in parts:
            f.write(f"file '{esc}'\n")
            if s > 0.01:
                f.write(f"inpoint {s}\n")
            f.write(f"outpoint {e}\n")
    total = sum(e - s for s, e in parts)
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
           "-f", "concat", "-safe", "0", "-i", lst,
           "-c", "copy", "-avoid_negative_ts", "make_zero", out]
    return start_job("render", cmd, total, out, cleanup=lst)


def op_render_convert(p):
    """Exporta os segmentos e recodifica para um novo formato."""
    src = safe_path(p["input"])
    parts = [(float(s), float(e)) for s, e in p["parts"]]
    fmt = p.get("format", "mp4")
    if not parts:
        raise ValueError("nenhum segmento restante para exportar")
    d, name = os.path.dirname(src), os.path.splitext(os.path.basename(src))
    out = unique_output(d, name[0], "editado", "." + fmt)
    esc = src.replace("'", "'\\''")
    lst = out + ".txt"
    with open(lst, "w") as f:
        for s, e in parts:
            f.write(f"file '{esc}'\n")
            if s > 0.01:
                f.write(f"inpoint {s}\n")
            f.write(f"outpoint {e}\n")
    total = sum(e - s for s, e in parts)
    cmd = [FFMPEG, "-nostdin", "-y", "-progress", "pipe:1", "-nostats",
           "-f", "concat", "-safe", "0", "-i", lst,
           "-c:v", "libx264", "-preset", "medium", "-crf", "23",
           "-c:a", "aac", "-b:a", "160k", out]
    return start_job("render_convert", cmd, total, out, cleanup=lst)


OPS = {"cut": op_cut, "join": op_join, "convert": op_convert,
       "extract": op_extract_audio, "delete": op_delete, "render": op_render,
       "render_convert": op_render_convert}


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
        if route.startswith("/js/") or route.startswith("/css/"):
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
                    elif os.path.splitext(name)[1].lower() in VIDEO_EXTS:
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

        if route == "/api/jobs":
            with jobs_lock:
                return self._json(jobs)

        self._json({"error": "rota desconhecida"}, 404)

    def do_POST(self):
        if self.path != "/api/job":
            return self._json({"error": "rota desconhecida"}, 404)
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length))
            op = body["op"]
            job_id = OPS[op](body)
            return self._json({"job": job_id})
        except Exception as e:
            return self._json({"error": str(e)}, 400)


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
