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
  segments: [],   // [{start, end, deleted, speed}] cobrindo o vídeo inteiro
  joinQueue: [],  // [paths]
};
const history = { past: [], future: [] };
const MAX_HISTORY = 50;

function apply(mutator) {
  capturePanAnchor();   // fixa o conteúdo do centro da visão antes da junção
  history.past.push(JSON.stringify(state));
  if (history.past.length > MAX_HISTORY) history.past.shift();
  history.future = [];
  mutator(state);
  renderState();
}
function undo() {
  if (!history.past.length) return;
  capturePanAnchor();
  history.future.push(JSON.stringify(state));
  Object.assign(state, JSON.parse(history.past.pop()));
  renderState();
}
function redo() {
  if (!history.future.length) return;
  capturePanAnchor();
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

// rótulo da régua da timeline: mm:ss (ou h:mm:ss), sem décimos
const fmtRuler = (s) => {
  s = Math.round(Math.max(0, s));
  const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sec).padStart(2, "0");
};
// menor "passo bonito" (em segundos) ≥ ao alvo, para espaçar as marcas da régua
const RULER_STEPS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
const niceStep = (target) => RULER_STEPS.find(s => s >= target) || RULER_STEPS[RULER_STEPS.length - 1];

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
  tlZoom = 1; tlView = 0;   // reinicia zoom/pan da timeline
  gapVisible = null; gapHold = null; prevKeptIdx = -1; setGapOverlay(false);
  apply(s => { s.segments = []; });
  document.querySelectorAll("#browser-list li").forEach(li =>
    li.classList.toggle("selected", li.dataset.path === path));
  $("player-wrap").classList.add("has-video");
  player.removeAttribute("src");
  $("file-info").textContent = basename(path) + " — carregando info…";
  ["btn-convert", "btn-extract"].forEach(id => $(id).disabled = false);
  preparePreview(path);
  try {
    const info = await api("/api/probe?path=" + encodeURIComponent(path));
    if (path !== currentPath) return;
    currentInfo = info;
    const v = info.video, a = info.audio;
    $("file-info").textContent = basename(path) +
      ` — ${fmtTime(info.duration)}` +
      (v ? ` · ${v.width}×${v.height} ${v.codec}` : "") +
      (a ? ` · áudio ${a.codec}` : " · sem áudio") +
      ` · ${fmtSize(info.size)}`;
    if (info.duration > 0)
      apply(s => { s.segments = [{ start: 0, end: info.duration, deleted: false, speed: 1, gap: 0 }]; });
  } catch (e) {
    if (path !== currentPath) return;
    currentInfo = null;
    $("file-info").textContent = basename(path) + " — erro no probe: " + e.message;
  }
  drawTimeline();
}

// prepara o preview: formatos que o <video> não toca nativamente (mkv, avi,
// wmv, flv, ts, mpg, 3gp…) são transcodificados sob demanda pelo servidor
// (com cache) antes de virar o src do player.
async function preparePreview(path) {
  try {
    const r = await api("/api/preview?path=" + encodeURIComponent(path));
    if (path !== currentPath) return;
    if (r.ready) { player.src = "/api/media?path=" + encodeURIComponent(r.path); return; }
    startPolling();
    const job = await pollJob(r.job);
    if (path !== currentPath) return;
    player.src = "/api/media?path=" + encodeURIComponent(job.output);
  } catch (e) {
    if (path === currentPath)
      $("file-info").textContent += " · erro na pré-visualização: " + e.message;
  }
}

// espera um job terminar, consultando /api/jobs (mesma fonte usada pela
// barra de progresso) até status sair de "running".
function pollJob(jobId, intervalMs = 500) {
  return new Promise((resolve, reject) => {
    const iv = setInterval(async () => {
      try {
        const jobs = await api("/api/jobs");
        const j = jobs[jobId];
        if (!j || j.status === "running") return;
        clearInterval(iv);
        j.status === "done" ? resolve(j) : reject(new Error(j.error || "falha ao preparar pré-visualização"));
      } catch (e) {
        clearInterval(iv);
        reject(e);
      }
    }, intervalMs);
  });
}

// fallback: se o probe falhar, cria o segmento inicial pela duração do player
player.addEventListener("loadedmetadata", () => {
  if (currentPath && !state.segments.length && player.duration)
    apply(s => { s.segments = [{ start: 0, end: player.duration, deleted: false, speed: 1, gap: 0 }]; });
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
    acc += s.gap || 0;          // lacuna (preta) antes do segmento
    pos.set(segKey(s), acc);    // início visível do segmento é depois da lacuna
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
  if (!changed) { panAnchorSrc = null; drawTimeline(); return; }
  if (animDur === 0) { animPos = new Map(pos); animDur = dur; panAnchorSrc = null; drawTimeline(); return; }
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
    // reancora: mantém o conteúdo do centro parado enquanto a junção compacta
    if (panAnchorSrc != null) {
      tlView = sourceToVisible(panAnchorSrc) - 0.5 * tlSpan();
      clampView();
    }
    drawTimeline();
    if (p < 1) layoutAnimId = requestAnimationFrame(step);
    else panAnchorSrc = null;
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

// posição visível → tempo do arquivo (usa o layout final, estável).
// Se cair numa lacuna, devolve o início (fonte) do próximo trecho.
function visibleToSource(tv) {
  const kept = keptSegs();
  if (!kept.length) return Math.max(0, Math.min(1, tv / videoDur())) * videoDur();
  let acc = 0;
  for (const s of kept) {
    acc += s.gap || 0;               // pula a lacuna preta antes do trecho
    const d = s.end - s.start;
    if (tv < acc) return s.start;     // dentro da lacuna → início do trecho seguinte
    if (tv <= acc + d) return s.start + (tv - acc);
    acc += d;
  }
  return kept[kept.length - 1].end;
}

// true se a posição visível tv cai numa lacuna preta (entre trechos)
function visibleGapAt(tv) {
  let acc = 0;
  for (const s of keptSegs()) {
    const g = s.gap || 0;
    if (tv < acc + g) return tv >= acc - 1e-6;   // dentro da faixa da lacuna
    acc += g + (s.end - s.start);
  }
  return false;
}

// ---------- zoom e deslocamento (pan) da timeline ----------
let tlZoom = 1;     // 1 = timeline inteira visível; >1 amplia
let tlView = 0;     // segundos no canto esquerdo do viewport
let panning = false, dragMoved = false, downX = 0, downView = 0;
let panAnchorSrc = null;   // tempo-fonte a manter no centro durante a junção pós-edição
const RULER_CSS_H = 18;                          // altura da régua (px CSS) = zona de scrub
const TL_MIN_SPAN = 0.5;                       // menor trecho visível (s), limita o zoom in
const TL_MIN_ZOOM = 0.2;                        // zoom out além do original (timeline encolhe)
const tlSpan = () => animDur / tlZoom;         // segundos visíveis no viewport
const tlMaxZoom = () => Math.max(1, animDur / TL_MIN_SPAN);
function clampView() {
  tlZoom = Math.max(TL_MIN_ZOOM, Math.min(tlMaxZoom(), tlZoom));
  const span = tlSpan();
  // ampliado (span<dur): faixa [0, dur-span], desloca sobre o overflow.
  // encolhido (span>dur): faixa [dur-span, 0] (negativa), desliza o bloco pelo
  // espaço vazio. exatamente encaixado: 0.
  const lo = Math.min(0, animDur - span);
  const hi = Math.max(0, animDur - span);
  tlView = Math.max(lo, Math.min(hi, tlView));
}
// dá para arrastar sempre que o conteúdo não preenche exatamente o viewport
// (overflow com zoom in, ou espaço vazio com zoom out)
const tlCanPan = () => Math.abs(animDur - tlSpan()) > 1e-6;
// registra o tempo-fonte que está no centro da visão, para reancorar a visão
// enquanto a timeline se compacta (evita a visão "fugir" durante a junção)
function capturePanAnchor() {
  panAnchorSrc = animDur > 0 ? visibleToSource(tlView + 0.5 * tlSpan()) : null;
}

function drawTimeline() {
  const dpr = devicePixelRatio;
  const w = canvas.width = canvas.clientWidth * dpr;
  const h = canvas.height = canvas.clientHeight * dpr;
  ctx.clearRect(0, 0, w, h);
  if (!videoDur() || animDur <= 0) return;
  const kept = keptSegs();
  if (!kept.length) return;
  clampView();
  const scale = (w * tlZoom) / animDur;      // px por segundo (amplia com o zoom)
  const sx = (vt) => (vt - tlView) * scale;  // tempo visível → x na tela (com pan)

  // faixa reservada no topo para a régua de tempo (também é a zona de scrub)
  const rulerH = RULER_CSS_H * dpr;
  const segTop = rulerH, segH = h - rulerH;

  let prevVisEnd = 0;
  for (const s of kept) {
    const i = state.segments.indexOf(s);
    const visStart = animPos.get(segKey(s)) ?? 0;
    // lacuna preta antes deste trecho (espaço criado ao afastá-lo)
    if (visStart > prevVisEnd + 1e-6) {
      const gx0 = sx(prevVisEnd), gx1 = sx(visStart);
      ctx.fillStyle = "#000";
      ctx.fillRect(gx0, segTop, gx1 - gx0, segH);
      ctx.strokeStyle = "rgba(255,255,255,.16)";
      ctx.lineWidth = dpr;
      ctx.strokeRect(gx0 + dpr / 2, segTop + dpr / 2, gx1 - gx0 - dpr, segH - dpr);
    } else if (prevVisEnd > 1e-6) {
      // trechos encostados: linha sutil na emenda
      const x = sx(visStart);
      ctx.fillStyle = "rgba(255,255,255,.28)";
      ctx.fillRect(x - dpr / 2, segTop, dpr, segH);
    }
    const x0 = sx(visStart);
    const wd = (s.end - s.start) * scale;
    const isSped = s.speed && s.speed !== 1;
    ctx.fillStyle = isSped
      ? (i === selectedSeg ? "rgba(232,127,10,.55)" : "rgba(232,127,10,.3)")
      : (i === selectedSeg ? "rgba(64,183,227,.5)" : "rgba(64,183,227,.28)");
    ctx.fillRect(x0, segTop, wd, segH);
    if (i === selectedSeg) {
      ctx.strokeStyle = "#40B7E3";
      ctx.lineWidth = 2 * dpr;
      ctx.strokeRect(x0 + 1, segTop + 1, wd - 2, segH - 2);
    }
    if (isSped && wd > 20 * dpr) {
      ctx.fillStyle = "#ffa733";
      ctx.font = `${10 * dpr}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(`${s.speed}x`, x0 + 4 * dpr, segTop + 2 * dpr);
    }
    prevVisEnd = visStart + (s.end - s.start);
  }

  drawRuler(w, h, rulerH, scale);

  // cursor de reprodução (posição compactada; numa lacuna usa o playhead virtual)
  const playVis = gapVisible != null ? gapVisible : sourceToVisible(player.currentTime);
  const cx = sx(playVis);
  ctx.fillStyle = "#e87f0a";
  ctx.fillRect(cx - 1, 0, 3, h);

  // tempo exato do playhead junto ao cursor (troca de lado perto da borda)
  const label = fmtTime(playVis);
  ctx.font = `${13 * dpr}px system-ui, sans-serif`;
  const pad = 4 * dpr;
  const tw = ctx.measureText(label).width;
  const boxH = 18 * dpr;
  const boxTop = h - boxH - pad;
  const left = cx + tw + pad * 3 > w ? cx - tw - pad * 3 : cx + pad;
  ctx.fillStyle = "rgba(20,20,20,.85)";
  ctx.fillRect(left, boxTop, tw + pad * 2, boxH);
  ctx.fillStyle = "#e87f0a";
  ctx.textBaseline = "middle";
  ctx.fillText(label, left + pad, boxTop + boxH / 2);
}

// régua de tempo distribuída de 0:00 até o fim (duração compactada), com marcas
// espaçadas em passos "bonitos" conforme a largura disponível
function drawRuler(w, h, rulerH, scale) {
  const dpr = devicePixelRatio;
  ctx.fillStyle = "rgba(0,0,0,.35)";
  ctx.fillRect(0, 0, w, rulerH);
  ctx.fillStyle = "rgba(255,255,255,.12)";
  ctx.fillRect(0, rulerH - dpr, w, dpr); // linha separando régua da faixa

  // passo baseado no trecho visível: com zoom, o span diminui e as marcas
  // ficam mais finas (mostrando subdivisões menores de tempo)
  const span = tlSpan();
  const minLabelPx = 56 * dpr;           // espaço mínimo entre rótulos
  const step = niceStep(span / Math.max(1, w / minLabelPx));
  ctx.font = `${10 * dpr}px system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  // não passa do fim real da timeline (com zoom out há espaço vazio à direita)
  const tEnd = Math.min(tlView + span, animDur);
  for (let t = Math.max(0, Math.ceil(tlView / step) * step); t <= tEnd + 1e-6; t += step) {
    const x = (t - tlView) * scale;
    ctx.fillStyle = "rgba(255,255,255,.25)";
    ctx.fillRect(x, 0, dpr, rulerH);            // marca vertical
    const lbl = fmtRuler(t);
    const tw = ctx.measureText(lbl).width;
    let lx = x + 3 * dpr;
    if (lx + tw > w) lx = x - tw - 3 * dpr;      // último rótulo cabe à esquerda
    ctx.fillStyle = "#a8a8a8";
    ctx.fillText(lbl, lx, rulerH / 2);
  }
}

// arraste do ponteiro (scrubbing): o vídeo acompanha em tempo real.
// Enquanto um seek está em curso, o próximo fica pendente para não enfileirar.
let scrubbing = false, wasPlaying = false, pendingSeek = null;
// arraste de um segmento SELECIONADO para afastá-lo (criar/ajustar lacuna preta)
let segMoving = false, segMoveIdx = -1, segMoveOrigGap = 0, segMoveSpan0 = 0, segMoveHist = false;
let segMoveNextIdx = -1, segMoveOrigNextGap = 0;   // próximo trecho mantido e sua lacuna

const nextKeptIdx = (idx) => {
  for (let j = idx + 1; j < state.segments.length; j++) if (!state.segments[j].deleted) return j;
  return -1;
};
// lacunas na reprodução: overlay preto + playhead virtual passando pela lacuna
let gapVisible = null;   // posição visível do playhead quando está numa lacuna (senão null)
let gapHold = null;      // reprodução temporizada do preto durante uma lacuna
let prevKeptIdx = -1;    // último trecho tocado (evita retriggar a mesma lacuna)

const setGapOverlay = (show) => $("gap-overlay").classList.toggle("show", show);
const keptIdxAt = (t) => state.segments.findIndex(s => !s.deleted && t >= s.start && t <= s.end);

// raspagem ciente de lacuna: se o ponteiro cai numa lacuna, mostra preto e
// estaciona o vídeo no início do próximo trecho (frame atrás do overlay).
function scrubToVisible(vt) {
  const inGap = visibleGapAt(vt);
  gapVisible = inGap ? vt : null;
  setGapOverlay(inGap);
  const src = visibleToSource(vt);
  prevKeptIdx = keptIdxAt(src);
  seekTo(src);
}
function startGapHold(seg) {
  player.pause();
  setGapOverlay(true);
  const visStart = animPos.get(segKey(seg)) ?? 0;      // início visível (pós-lacuna)
  gapHold = { t0: performance.now(), dur: seg.gap || 0, base: visStart - (seg.gap || 0) };
  requestAnimationFrame(gapHoldStep);
}
function gapHoldStep() {
  if (!gapHold) return;
  const el = (performance.now() - gapHold.t0) / 1000;
  if (el < gapHold.dur) {
    gapVisible = gapHold.base + el;   // playhead virtual atravessando o preto
    drawTimeline();
    requestAnimationFrame(gapHoldStep);
  } else {
    gapHold = null; gapVisible = null; setGapOverlay(false);
    player.play();
  }
}

function visibleAtEvent(e) {
  const rect = canvas.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  return tlView + frac * tlSpan();     // tempo VISÍVEL (compactado) sob o ponteiro
}
function segIndexAtVisible(vt) {
  for (const s of keptSegs()) {
    const p = animPos.get(segKey(s)) ?? 0;
    if (vt >= p && vt <= p + (s.end - s.start)) return state.segments.indexOf(s);
  }
  return -1;
}
function selectSegAt(t) {
  const i = state.segments.findIndex(s => !s.deleted && t >= s.start && t <= s.end);
  selectedSeg = i >= 0 ? i : null;
}
function seekAndSelect(e) {
  const vt = visibleAtEvent(e);
  selectSegAt(visibleToSource(vt));   // clicar seleciona o trecho sob o ponteiro
  scrubToVisible(vt);
  renderState();
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

const onRuler = (e) => (e.clientY - canvas.getBoundingClientRect().top) < RULER_CSS_H;

canvas.addEventListener("pointerdown", (e) => {
  if (!videoDur() || animDur <= 0) return;
  canvas.setPointerCapture(e.pointerId);
  downX = e.clientX;
  dragMoved = false;
  const overIdx = onRuler(e) ? -1 : segIndexAtVisible(visibleAtEvent(e));
  if (overIdx !== -1 && overIdx === selectedSeg) {
    // arrastar o segmento SELECIONADO → afasta criando/ajustando a lacuna
    segMoving = true;
    segMoveIdx = overIdx;
    segMoveOrigGap = state.segments[overIdx].gap || 0;
    segMoveNextIdx = nextKeptIdx(overIdx);          // trecho seguinte (não se move)
    segMoveOrigNextGap = segMoveNextIdx !== -1 ? (state.segments[segMoveNextIdx].gap || 0) : 0;
    segMoveSpan0 = tlSpan();     // mapeamento px→s fixo durante o arraste
    segMoveHist = false;
    canvas.style.cursor = "grabbing";
  } else if (!onRuler(e) && tlCanPan()) {
    // régua = raspar o playhead; corpo (fora do selecionado) = arrastar a visão (pan)
    panning = true;
    downView = tlView;
    canvas.style.cursor = "grabbing";
  } else {
    scrubbing = true;
    wasPlaying = !player.paused;
    player.pause();
    seekAndSelect(e);
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (!panning && !scrubbing && !segMoving) {   // hover: cursor por zona
    const overSel = !onRuler(e) && selectedSeg != null
      && segIndexAtVisible(visibleAtEvent(e)) === selectedSeg;
    canvas.style.cursor = onRuler(e) ? "ew-resize"
      : overSel ? "move" : (tlCanPan() ? "grab" : "crosshair");
    return;
  }
  if (Math.abs(e.clientX - downX) > 3) dragMoved = true;
  if (segMoving) {
    if (dragMoved && !segMoveHist) {   // 1ª movimentação: registra 1 passo de undo
      history.past.push(JSON.stringify(state));
      if (history.past.length > MAX_HISTORY) history.past.shift();
      history.future = [];
      segMoveHist = true;
    }
    const rect = canvas.getBoundingClientRect();
    const dxSec = (e.clientX - downX) / rect.width * segMoveSpan0;
    // move SÓ este trecho: consome a lacuna de um lado e devolve do outro, sem
    // mexer nos vizinhos. Limitado pelo espaço preto disponível de cada lado:
    //  à esquerda até encostar no anterior (−lacuna deste), à direita até o
    //  seguinte (+lacuna do seguinte); o último trecho pode ir livre p/ a direita.
    let d = Math.max(dxSec, -segMoveOrigGap);
    if (segMoveNextIdx !== -1) d = Math.min(d, segMoveOrigNextGap);
    state.segments[segMoveIdx].gap = segMoveOrigGap + d;
    if (segMoveNextIdx !== -1) state.segments[segMoveNextIdx].gap = segMoveOrigNextGap - d;
    const tl = targetLayout();
    animPos = new Map(tl.pos); animDur = tl.dur;
    // ESCALA FIXA: a régua não recomprime; a timeline só estica e o segmento
    // desliza acompanhando o cursor (o restante além da largura vê-se com pan/zoom).
    tlZoom = animDur / segMoveSpan0;
    clampView();
    drawTimeline();
  } else if (panning) {
    const rect = canvas.getBoundingClientRect();
    const dxFrac = (e.clientX - downX) / rect.width;
    tlView = downView - dxFrac * tlSpan();   // arrastar p/ direita mostra o trecho anterior
    clampView();
    drawTimeline();
  } else if (scrubbing) {
    scrubToVisible(visibleAtEvent(e));
  }
});
canvas.addEventListener("pointerup", (e) => {
  if (segMoving) {
    segMoving = false;
    canvas.style.cursor = "move";
    if (!dragMoved) seekAndSelect(e);  // clique sem mover: reposiciona o playhead
    else renderState();                // arrastou: atualiza botões (export com lacuna)
  } else if (panning) {
    panning = false;
    canvas.style.cursor = "grab";
    if (!dragMoved) seekAndSelect(e); // clique sem arrastar: posiciona o playhead
  } else if (scrubbing) {
    scrubbing = false;
    pendingSeek = null;
    if (wasPlaying) player.play();
  }
});

// roda do mouse amplia/reduz mantendo o ponto sob o cursor fixo
canvas.addEventListener("wheel", (e) => {
  if (!videoDur() || animDur <= 0) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const tAt = tlView + frac * tlSpan();          // tempo sob o cursor
  tlZoom = Math.max(TL_MIN_ZOOM, Math.min(tlMaxZoom(), tlZoom * (e.deltaY < 0 ? 1.25 : 1 / 1.25)));
  tlView = tAt - frac * tlSpan();                // mantém tAt sob o cursor
  clampView();
  drawTimeline();
}, { passive: false });

// duplo-clique volta ao zoom padrão (timeline inteira)
canvas.addEventListener("dblclick", () => { tlZoom = 1; tlView = 0; drawTimeline(); });

new ResizeObserver(drawTimeline).observe(canvas);

// Durante a reprodução: pula os trechos deletados e, ao entrar num trecho que
// foi afastado, toca a lacuna como preto+silêncio pela sua duração.
function advancePlayback() {
  if (scrubbing || segMoving || gapHold || !state.segments.length || player.paused) return;
  const t = player.currentTime;
  // 1) região deletada → salta para o próximo trecho mantido
  const del = state.segments.find(s => s.deleted && t >= s.start && t < s.end);
  if (del) {
    const nxt = state.segments.find(s => !s.deleted && s.start >= del.end - 0.001);
    if (nxt) {
      prevKeptIdx = state.segments.indexOf(nxt);
      player.currentTime = nxt.start + 0.001;
      if ((nxt.gap || 0) > 0.02) startGapHold(nxt);
    } else { player.pause(); player.currentTime = del.start; }
    return;
  }
  // 2) entrou num novo trecho mantido → se tem lacuna antes, toca o preto
  const idx = keptIdxAt(t);
  if (idx !== -1 && idx !== prevKeptIdx) {
    prevKeptIdx = idx;
    if ((state.segments[idx].gap || 0) > 0.02) startGapHold(state.segments[idx]);
  }
}

// timeupdate dispara a cada quadro durante a reprodução.
player.addEventListener("timeupdate", () => {
  advancePlayback();
  if (gapHold == null) drawTimeline();   // durante a lacuna quem desenha é o gapHoldStep
});
player.addEventListener("play", () => {
  prevKeptIdx = keptIdxAt(player.currentTime);
  advancePlayback();
});
player.addEventListener("pause", () => {
  if (!gapHold) { gapVisible = null; setGapOverlay(false); }
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
      { start: seg.start, end: t, deleted: seg.deleted, speed: seg.speed, gap: seg.gap || 0 },
      { start: t, end: seg.end, deleted: seg.deleted, speed: seg.speed, gap: 0 });
  });
}
function deleteSelected() {
  if (selectedSeg == null || state.segments[selectedSeg]?.deleted) return;
  const i = selectedSeg;
  selectedSeg = null;
  apply(s => { s.segments[i].deleted = true; });
}
// a própria escolha no seletor já aplica a velocidade ao segmento selecionado
function setSpeedSelected() {
  if (selectedSeg == null || state.segments[selectedSeg]?.deleted) return;
  const factor = parseFloat($("seg-speed").value);
  const i = selectedSeg;
  apply(s => { s.segments[i].speed = factor; });
}

$("btn-cut").onclick = doCut;
$("btn-del-seg").onclick = deleteSelected;
$("seg-speed").onchange = setSpeedSelected;
// Detecta o formato do arquivo original
function getOriginalFormat() {
  if (!currentPath) return "";
  const ext = currentPath.split(".").pop().toLowerCase();
  return ext === "webm" ? "webm" : ext === "mkv" ? "mkv" : "mp4";
}

function setExportOptsVisible(show) {
  $("export-opts").classList.toggle("hidden", !show);
  $("btn-export").classList.toggle("hidden", show);
}
$("btn-export").onclick = () => {
  setExportOptsVisible(true);
  $("export-format").value = getOriginalFormat() ? "" : "mp4";
};
$("btn-export-cancel").onclick = () => setExportOptsVisible(false);
$("btn-export-go").onclick = async () => {
  const kept = state.segments.filter(s => !s.deleted);
  const format = $("export-format").value; // "" = manter original, ou "mp4"/"mkv"
  const op = format ? "render_convert" : "render";
  const ext = format || currentPath.split(".").pop();
  const btn = $("btn-export-go");
  btn.disabled = true;
  try {
    const picked = await api("/api/pick-save?input=" + encodeURIComponent(currentPath) +
      "&suffix=editado&ext=" + encodeURIComponent(ext));
    if (picked.cancelled) return; // usuário cancelou no seletor, painel continua aberto
    const body = {
      op, input: currentPath, output: picked.path,
      parts: kept.map(s => [s.start, s.end, s.speed || 1, s.gap || 0]),
    };
    if (format) body.format = format;
    submitJob(body);
    setExportOptsVisible(false);
  } catch (e) {
    alert("Erro ao escolher local de exportação: " + e.message);
  } finally {
    btn.disabled = false;
  }
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
  const sped = segs.some(s => !s.deleted && s.speed && s.speed !== 1);
  const gapped = segs.some(s => !s.deleted && (s.gap || 0) > 1e-6);
  $("btn-cut").disabled = !segs.length;
  $("btn-del-seg").disabled = selectedSeg == null || segs[selectedSeg]?.deleted;
  const segEditable = selectedSeg != null && !segs[selectedSeg]?.deleted;
  $("seg-speed").disabled = !segEditable;
  $("seg-speed").value = segEditable ? String(segs[selectedSeg].speed || 1) : "1";
  $("btn-export").disabled = !(kept > 0 && (del > 0 || sped || gapped));
  $("mark-info").textContent = segs.length > 1
    ? `${segs.length} segmentos` + (del ? ` · ${del} deletado${del > 1 ? "s" : ""}` : "")
      + (gapped ? " · com lacuna" : "")
    : (gapped ? "com lacuna" : "");

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
    const r = await api("/api/job", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    startPolling();
    return r.job;
  } catch (e) {
    alert("Erro: " + e.message);
    return null;
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
  preview: "Pré-visualização",
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

  // última tarefa finalizada (para ver o resultado; preview fica de fora,
  // o nome do arquivo em cache não interessa mostrar ao usuário)
  const finished = all.filter(j => j.status !== "running" && j.op !== "preview");
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
$("btn-convert").onclick = async () => {
  const jobId = await submitJob({
    op: "convert", input: currentPath,
    format: $("conv-format").value,
    quality: $("conv-quality").value,
    gpu: $("conv-gpu").checked,
  });
  if (!jobId) return;
  try {
    // ao terminar, já abre o arquivo convertido pronto para edição
    const job = await pollJob(jobId, 800);
    const dir = job.output.slice(0, job.output.lastIndexOf("/"));
    if (dir === browseDir) await browse(browseDir); // revela o novo arquivo na lista
    loadVideo(job.output);
  } catch (_) { /* falha já sinalizada na barra de tarefas */ }
};
$("btn-extract").onclick = () => submitJob({ op: "extract", input: currentPath });

// WebM/VP9 não tem aceleração de GPU nesta ferramenta (NVENC não codifica VP9)
let gpuCheckedBeforeWebm = true;
$("conv-format").addEventListener("change", () => {
  const gpu = $("conv-gpu");
  const isWebm = $("conv-format").value === "webm";
  $("gpu-label").title = isWebm ? "VP9 não tem aceleração de GPU nesta máquina" : "";
  if (isWebm) {
    gpuCheckedBeforeWebm = gpu.checked;
    gpu.checked = false;
    gpu.disabled = true;
  } else {
    gpu.disabled = !nvenc;
    if (nvenc) gpu.checked = gpuCheckedBeforeWebm;
  }
});

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
