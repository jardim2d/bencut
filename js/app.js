// EditorVideo — UI que fala com server.py (FFmpeg local)
"use strict";

const $ = (id) => document.getElementById(id);
const api = async (path, opts) => {
  const r = await fetch(path, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || r.statusText);
  return data;
};

// ---------- estado com undo/redo ----------
// A timeline é uma lista de segmentos contíguos; "Corte" divide um segmento
// em dois e "Deletar" marca o segmento para ficar fora da exportação.
const state = {
  segments: [],   // [{start, end, deleted}] cobrindo o vídeo inteiro
  joinQueue: [],  // [paths]
};
const history = { past: [], future: [] };
const MAX_HISTORY = 50;

function apply(mutator) {
  history.past.push(JSON.stringify(state));
  if (history.past.length > MAX_HISTORY) history.past.shift();
  history.future = [];
  mutator(state);
  renderState();
}
function undo() {
  if (!history.past.length) return;
  history.future.push(JSON.stringify(state));
  Object.assign(state, JSON.parse(history.past.pop()));
  renderState();
}
function redo() {
  if (!history.future.length) return;
  history.past.push(JSON.stringify(state));
  Object.assign(state, JSON.parse(history.future.pop()));
  renderState();
}

// ---------- estado não-histórico ----------
let currentPath = null;   // vídeo carregado no player
let currentInfo = null;   // resultado do probe
let selectedSeg = null;   // índice do segmento selecionado na timeline
let nvenc = false;
const CUT_EPS = 0.05;     // distância mínima do corte até a borda do segmento

// ---------- helpers ----------
const fmtTime = (s) => {
  if (s == null || isNaN(s)) return "--:--";
  s = Math.max(0, s);
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  const sec = (s % 60).toFixed(1).padStart(4, "0");
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + sec;
};
const fmtSize = (b) => b > 1e9 ? (b / 1e9).toFixed(2) + " GB"
  : b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " kB";
const basename = (p) => p.split("/").pop();
const videoDur = () => currentInfo?.duration || player.duration || 0;

// ---------- navegador de arquivos ----------
let browseDir = null;

async function browse(dir) {
  const data = await api("/api/list?dir=" + encodeURIComponent(dir));
  browseDir = data.dir;
  $("browser-path").textContent = data.dir.replace(/^\/home\/[^/]+/, "~");
  const ul = $("browser-list");
  ul.innerHTML = "";

  const li = document.createElement("li");
  li.className = "dir";
  li.innerHTML = "<span>..</span>";
  li.onclick = () => browse(data.parent);
  ul.appendChild(li);

  for (const d of data.dirs) {
    const li = document.createElement("li");
    li.className = "dir";
    li.innerHTML = `<span class="name">${d}/</span>`;
    li.onclick = () => browse(data.dir + "/" + d);
    ul.appendChild(li);
  }
  for (const f of data.files) {
    const full = data.dir + "/" + f.name;
    const li = document.createElement("li");
    li.dataset.path = full;
    li.innerHTML = `<span class="name">${f.name}</span>` +
      `<span class="size">${fmtSize(f.size)}</span>` +
      `<button class="add-join" title="Adicionar à fila de junção">＋</button>`;
    li.querySelector(".add-join").onclick = (e) => {
      e.stopPropagation();
      apply(s => s.joinQueue.push(full));
    };
    li.onclick = () => loadVideo(full);
    ul.appendChild(li);
  }
}

// ---------- player ----------
const player = $("player");

async function loadVideo(path) {
  currentPath = path;
  selectedSeg = null;
  cancelAnimationFrame(layoutAnimId);
  animPos.clear();
  animDur = 0;
  apply(s => { s.segments = []; });
  document.querySelectorAll("#browser-list li").forEach(li =>
    li.classList.toggle("selected", li.dataset.path === path));
  $("player-wrap").classList.add("has-video");
  player.src = "/api/media?path=" + encodeURIComponent(path);
  $("file-info").textContent = basename(path) + " — carregando info…";
  ["btn-convert", "btn-extract"].forEach(id => $(id).disabled = false);
  try {
    currentInfo = await api("/api/probe?path=" + encodeURIComponent(path));
    const v = currentInfo.video, a = currentInfo.audio;
    $("file-info").textContent = basename(path) +
      ` — ${fmtTime(currentInfo.duration)}` +
      (v ? ` · ${v.width}×${v.height} ${v.codec}` : "") +
      (a ? ` · áudio ${a.codec}` : " · sem áudio") +
      ` · ${fmtSize(currentInfo.size)}`;
    if (currentInfo.duration > 0)
      apply(s => { s.segments = [{ start: 0, end: currentInfo.duration, deleted: false }]; });
  } catch (e) {
    currentInfo = null;
    $("file-info").textContent = basename(path) + " — erro no probe: " + e.message;
  }
  drawTimeline();
}

// fallback: se o probe falhar, cria o segmento inicial pela duração do player
player.addEventListener("loadedmetadata", () => {
  if (currentPath && !state.segments.length && player.duration)
    apply(s => { s.segments = [{ start: 0, end: player.duration, deleted: false }]; });
});

// ---------- timeline (ripple: deletados somem e o resto desliza) ----------
// A timeline mostra só os segmentos mantidos, compactados. animPos guarda a
// posição visível (em segundos) de cada segmento, interpolada a cada mudança
// para os segmentos deslizarem até a nova posição em vez de teleportar.
const canvas = $("timeline");
const ctx = canvas.getContext("2d");

let animPos = new Map();   // segKey -> início visível animado (s)
let animDur = 0;           // duração visível animada (s)
let layoutAnimId = null;

const segKey = (s) => s.start.toFixed(3) + ":" + s.end.toFixed(3);
const keptSegs = () => state.segments.filter(s => !s.deleted);

function targetLayout() {
  const pos = new Map();
  let acc = 0;
  for (const s of keptSegs()) {
    pos.set(segKey(s), acc);
    acc += s.end - s.start;
  }
  return { pos, dur: acc };
}

function syncLayout() {
  const { pos, dur } = targetLayout();
  for (const k of [...animPos.keys()]) if (!pos.has(k)) animPos.delete(k);
  let changed = Math.abs(dur - animDur) > 1e-6;
  for (const [k, v] of pos) {
    if (!animPos.has(k)) animPos.set(k, v); // segmento novo entra já no lugar
    else if (Math.abs(animPos.get(k) - v) > 1e-6) changed = true;
  }
  if (!changed) { drawTimeline(); return; }
  if (animDur === 0) { animPos = new Map(pos); animDur = dur; drawTimeline(); return; }
  startLayoutAnim(pos, dur);
}

function startLayoutAnim(target, targetDur) {
  cancelAnimationFrame(layoutAnimId);
  const from = new Map(animPos), fromDur = animDur;
  const t0 = performance.now(), MS = 300;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / MS);
    const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
    for (const [k, tv] of target) {
      const fv = from.has(k) ? from.get(k) : tv;
      animPos.set(k, fv + (tv - fv) * e);
    }
    animDur = fromDur + (targetDur - fromDur) * e;
    drawTimeline();
    if (p < 1) layoutAnimId = requestAnimationFrame(step);
  };
  layoutAnimId = requestAnimationFrame(step);
}

// tempo do arquivo → posição visível na timeline (usa o layout animado)
function sourceToVisible(t) {
  let prevEnd = 0;
  for (const s of keptSegs()) {
    const p = animPos.get(segKey(s)) ?? 0;
    if (t < s.start) return p;               // dentro de parte deletada
    if (t <= s.end) return p + (t - s.start);
    prevEnd = p + (s.end - s.start);
  }
  return prevEnd;
}

// posição visível → tempo do arquivo (usa o layout final, estável)
function visibleToSource(tv) {
  const kept = keptSegs();
  if (!kept.length) return Math.max(0, Math.min(1, tv / videoDur())) * videoDur();
  for (const s of kept) {
    const d = s.end - s.start;
    if (tv <= d) return s.start + Math.max(0, tv);
    tv -= d;
  }
  return kept[kept.length - 1].end;
}

function drawTimeline() {
  const w = canvas.width = canvas.clientWidth * devicePixelRatio;
  const h = canvas.height = canvas.clientHeight * devicePixelRatio;
  ctx.clearRect(0, 0, w, h);
  if (!videoDur() || animDur <= 0) return;
  const kept = keptSegs();
  if (!kept.length) return;
  const scale = w / animDur;

  let first = true;
  for (const s of kept) {
    const i = state.segments.indexOf(s);
    const x0 = (animPos.get(segKey(s)) ?? 0) * scale;
    const wd = (s.end - s.start) * scale;
    ctx.fillStyle = i === selectedSeg ? "rgba(64,183,227,.5)" : "rgba(64,183,227,.28)";
    ctx.fillRect(x0, 0, wd, h);
    if (i === selectedSeg) {
      ctx.strokeStyle = "#40B7E3";
      ctx.lineWidth = 2 * devicePixelRatio;
      ctx.strokeRect(x0 + 1, 1, wd - 2, h - 2);
    }
    // linha sutil na emenda entre segmentos
    if (!first) {
      ctx.fillStyle = "rgba(255,255,255,.28)";
      ctx.fillRect(x0 - devicePixelRatio / 2, 0, devicePixelRatio, h);
    }
    first = false;
  }

  // cursor de reprodução (na posição compactada)
  const cx = sourceToVisible(player.currentTime) * scale;
  ctx.fillStyle = "#e87f0a";
  ctx.fillRect(cx - 1, 0, 3, h);

  // tempo do vídeo editado junto ao cursor (troca de lado perto da borda)
  const label = fmtTime(sourceToVisible(player.currentTime));
  ctx.font = `${11 * devicePixelRatio}px system-ui, sans-serif`;
  const pad = 4 * devicePixelRatio;
  const tw = ctx.measureText(label).width;
  const boxH = 16 * devicePixelRatio;
  const left = cx + tw + pad * 3 > w ? cx - tw - pad * 3 : cx + pad;
  ctx.fillStyle = "rgba(20,20,20,.85)";
  ctx.fillRect(left, pad, tw + pad * 2, boxH);
  ctx.fillStyle = "#e87f0a";
  ctx.textBaseline = "middle";
  ctx.fillText(label, left + pad, pad + boxH / 2);
}

// arraste do ponteiro (scrubbing): o vídeo acompanha em tempo real.
// Enquanto um seek está em curso, o próximo fica pendente para não enfileirar.
let scrubbing = false, wasPlaying = false, pendingSeek = null;

function timeFromEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  return visibleToSource(frac * targetLayout().dur);
}
function seekTo(t) {
  if (player.seeking) pendingSeek = t;
  else player.currentTime = t;
  drawTimeline();
}
player.addEventListener("seeked", () => {
  if (pendingSeek != null) { player.currentTime = pendingSeek; pendingSeek = null; }
  drawTimeline();
});

canvas.addEventListener("pointerdown", (e) => {
  if (!videoDur()) return;
  scrubbing = true;
  wasPlaying = !player.paused;
  player.pause();
  canvas.setPointerCapture(e.pointerId);
  const t = timeFromEvent(e);
  // clicar também seleciona o segmento (mantido) sob o ponteiro
  const i = state.segments.findIndex(s => !s.deleted && t >= s.start && t <= s.end);
  selectedSeg = i >= 0 ? i : null;
  seekTo(t);
  renderState();
});
canvas.addEventListener("pointermove", (e) => { if (scrubbing) seekTo(timeFromEvent(e)); });
canvas.addEventListener("pointerup", () => {
  if (!scrubbing) return;
  scrubbing = false;
  pendingSeek = null;
  if (wasPlaying) player.play();
});
player.addEventListener("timeupdate", drawTimeline);
new ResizeObserver(drawTimeline).observe(canvas);

// durante a reprodução, pula os segmentos deletados (o scrubbing manual
// continua vendo o vídeo inteiro). Checado a cada frame via rAF.
function skipDeleted() {
  if (scrubbing || !state.segments.length || player.paused) return;
  const t = player.currentTime;
  const cur = state.segments.find(s => s.deleted && t >= s.start && t < s.end);
  if (!cur) return;
  // procura o próximo segmento não-deletado depois do atual
  const next = state.segments.find(s => !s.deleted && s.start >= cur.end - 0.001);
  if (next) {
    player.currentTime = next.start + 0.001;
  } else {
    // nenhum segmento após este, pausa e volta ao começo do deletado
    player.pause();
    player.currentTime = cur.start;
  }
}

// O evento timeupdate dispara a cada frame durante a reprodução.
// Sincroniza melhor com o player do que rAF separado.
player.addEventListener("timeupdate", () => {
  skipDeleted();
  drawTimeline();
});
player.addEventListener("play", () => {
  skipDeleted();
});
player.addEventListener("pause", () => {
  drawTimeline();
});

// ---------- corte / deleção / exportação ----------
function doCut() {
  const t = player.currentTime;
  const i = state.segments.findIndex(s => t > s.start + CUT_EPS && t < s.end - CUT_EPS);
  if (i < 0) return; // em cima de uma borda ou fora do vídeo
  selectedSeg = null;
  apply(s => {
    const seg = s.segments[i];
    s.segments.splice(i, 1,
      { start: seg.start, end: t, deleted: seg.deleted },
      { start: t, end: seg.end, deleted: seg.deleted });
  });
}
function deleteSelected() {
  if (selectedSeg == null || state.segments[selectedSeg]?.deleted) return;
  const i = selectedSeg;
  selectedSeg = null;
  apply(s => { s.segments[i].deleted = true; });
}

$("btn-cut").onclick = doCut;
$("btn-del-seg").onclick = deleteSelected;
// Detecta o formato do arquivo original
function getOriginalFormat() {
  if (!currentPath) return "";
  const ext = currentPath.split(".").pop().toLowerCase();
  return ext === "webm" ? "webm" : ext === "mkv" ? "mkv" : "mp4";
}

$("btn-export").onclick = () => {
  $("export-opts").classList.remove("hidden");
  $("export-format").value = getOriginalFormat() ? "" : "mp4";
};
$("btn-export-cancel").onclick = () => {
  $("export-opts").classList.add("hidden");
};
$("btn-export-go").onclick = () => {
  const kept = state.segments.filter(s => !s.deleted);
  const format = $("export-format").value; // "" = manter original, ou "mp4"/"mkv"
  const op = format ? "render_convert" : "render";
  const body = { op, input: currentPath, parts: kept.map(s => [s.start, s.end]) };
  if (format) body.format = format;
  submitJob(body);
  $("export-opts").classList.add("hidden");
};

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;
  if (e.ctrlKey && e.key === "z") { e.preventDefault(); undo(); }
  else if (e.ctrlKey && (e.key === "y" || (e.shiftKey && e.key === "Z"))) { e.preventDefault(); redo(); }
  else if (e.key === "c" && !e.ctrlKey && !$("btn-cut").disabled) doCut();
  else if (e.key === "Delete") deleteSelected();
  else if (e.key === " " && currentPath && e.target.tagName !== "BUTTON") {
    e.preventDefault();
    player.paused ? player.play() : player.pause();
  }
});

// ---------- render do estado (undo/redo re-renderiza tudo) ----------
function renderState() {
  if (selectedSeg != null && selectedSeg >= state.segments.length) selectedSeg = null;

  // fila de junção
  const jl = $("join-list");
  jl.innerHTML = "";
  state.joinQueue.forEach((p, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="grow" title="${p}">${i + 1}. ${basename(p)}</span>` +
      `<button class="mv" title="Subir">▲</button><button class="mv" title="Descer">▼</button>` +
      `<button class="rm" title="Remover">✕</button>`;
    const [up, down, rm] = li.querySelectorAll("button");
    up.onclick = () => i > 0 && apply(st =>
      st.joinQueue.splice(i - 1, 0, st.joinQueue.splice(i, 1)[0]));
    down.onclick = () => i < state.joinQueue.length - 1 && apply(st =>
      st.joinQueue.splice(i + 1, 0, st.joinQueue.splice(i, 1)[0]));
    rm.onclick = () => apply(st => st.joinQueue.splice(i, 1));
    jl.appendChild(li);
  });
  $("btn-join").disabled = state.joinQueue.length < 2;

  // botões da timeline
  const segs = state.segments;
  const kept = segs.filter(s => !s.deleted).length;
  const del = segs.length - kept;
  $("btn-cut").disabled = !segs.length;
  $("btn-del-seg").disabled = selectedSeg == null || segs[selectedSeg]?.deleted;
  $("btn-export").disabled = !(del > 0 && kept > 0);
  $("mark-info").textContent = segs.length > 1
    ? `${segs.length} segmentos` + (del ? ` · ${del} deletado${del > 1 ? "s" : ""}` : "")
    : "";
  // duração editada
  const editedDur = segs.filter(s => !s.deleted).reduce((sum, s) => sum + (s.end - s.start), 0);
  const origDur = videoDur();
  if (origDur > 0 && editedDur > 0 && Math.abs(editedDur - origDur) > 0.1) {
    $("duration-info").textContent = `${fmtTime(editedDur)} de ${fmtTime(origDur)}`;
  } else {
    $("duration-info").textContent = "";
  }

  $("btn-undo").disabled = !history.past.length;
  $("btn-redo").disabled = !history.future.length;
  syncLayout();
}
$("btn-undo").onclick = undo;
$("btn-redo").onclick = redo;

// ---------- tarefas ----------
let polling = null;

async function submitJob(body) {
  try {
    await api("/api/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    startPolling();
  } catch (e) {
    alert("Erro: " + e.message);
  }
}

function startPolling() {
  if (polling) return;
  polling = setInterval(refreshJobs, 800);
  refreshJobs();
}

const OP_LABEL = {
  cut: "Corte", join: "Junção", convert: "Conversão",
  extract: "Áudio", delete: "Remoção", render: "Exportação", render_convert: "Exportação",
};

async function refreshJobs() {
  const jobs = await api("/api/jobs");
  const bar = $("jobs-bar");
  const all = Object.values(jobs);
  const running = all.filter(j => j.status === "running");
  bar.innerHTML = "";

  // tarefas em andamento: rótulo + barra + %
  for (const j of running) {
    const chip = document.createElement("div");
    chip.className = "job-chip";
    chip.innerHTML = `<span>${OP_LABEL[j.op] || j.op}</span>` +
      `<div class="bar"><div style="width:${j.progress}%"></div></div>` +
      `<span>${Math.round(j.progress)}%</span>`;
    bar.appendChild(chip);
  }

  // última tarefa finalizada (para ver o resultado)
  const finished = all.filter(j => j.status !== "running");
  if (finished.length) {
    const j = finished[finished.length - 1];
    const chip = document.createElement("div");
    chip.className = "job-chip";
    if (j.status === "done") {
      chip.title = j.output;
      chip.innerHTML = `<span class="job-ok">✔ ${OP_LABEL[j.op] || j.op}: ${basename(j.output)}</span>`;
    } else {
      chip.title = j.error || "";
      chip.innerHTML = `<span class="job-err">✖ ${OP_LABEL[j.op] || j.op} falhou</span>`;
    }
    bar.appendChild(chip);
  }

  if (!running.length && polling) { clearInterval(polling); polling = null; }
}

// ---------- botões de operação ----------
$("btn-join").onclick = () => submitJob({ op: "join", inputs: state.joinQueue });
$("btn-convert").onclick = () => submitJob({
  op: "convert", input: currentPath,
  format: $("conv-format").value,
  quality: $("conv-quality").value,
  gpu: $("conv-gpu").checked,
});
$("btn-extract").onclick = () => submitJob({ op: "extract", input: currentPath });

// ---------- init ----------
(async () => {
  const cfg = await api("/api/config");
  nvenc = cfg.nvenc;
  const badge = $("gpu-badge");
  badge.textContent = nvenc ? "NVENC" : "CPU";
  badge.classList.toggle("on", nvenc);
  if (!nvenc) { $("conv-gpu").checked = false; $("conv-gpu").disabled = true; }
  await browse(cfg.startDir);
  renderState();
  refreshJobs();
})();
