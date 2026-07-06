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
// A timeline pode conter trechos de VÁRIOS arquivos (arrastar soma na timeline).
// Cada segmento carrega seu `src`; `sources` guarda o probe e a mídia tocável de
// cada arquivo; `activeSrc` é o arquivo atualmente carregado no <video>.
const sources = new Map();   // path -> { info, media, ready, err }
let activeSrc = null;        // arquivo carregado no player agora
let wantTime = 0;            // instante-alvo a buscar após trocar o src do player
let selectedSeg = null;      // índice do segmento selecionado na timeline
let nvenc = false;
const CUT_EPS = 0.05;     // distância mínima do corte até a borda do segmento

const activeInfo = () => sources.get(activeSrc)?.info || null;
const distinctSrcs = () => [...new Set(state.segments.filter(s => !s.deleted).map(s => s.src))];

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
const activeDur = () => activeInfo()?.duration || player.duration || 0;
const hasContent = () => state.segments.length > 0;   // há algo na timeline?

// cor própria de cada segmento: matiz gerado por ângulo áureo (cores sempre bem
// separadas) e guardado no segmento — assim acompanha o trecho ao reordenar e
// sobrevive a undo/redo. Início aleatório para variar entre sessões.
let hueSeed = Math.floor(Math.random() * 360);
const nextHue = () => { const h = Math.round(hueSeed) % 360; hueSeed += 137.508; return h; };

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
let selectedFile = null;   // arquivo destacado por clique na lista (não carrega nada)

// clicar num arquivo o SELECIONA (destaque persistente na lista), sem enviá-lo
// à timeline — carregar continua sendo só pelo arraste.
function selectFile(path) {
  selectedFile = path;
  document.querySelectorAll("#browser [data-path]").forEach(el =>
    el.classList.toggle("selected", el.dataset.path === path));
}

// duração por arquivo (badge do card), buscada aos poucos e cacheada
const metaCache = new Map();   // path -> duration (s)

async function fillDurations(grid) {
  for (const card of [...grid.querySelectorAll(".card:not(.project)")]) {
    if (!card.isConnected) return;       // usuário navegou p/ outra pasta
    const path = card.dataset.path;
    let dur = metaCache.get(path);
    if (dur === undefined) {
      try {
        dur = (await api("/api/meta?path=" + encodeURIComponent(path))).duration;
      } catch { dur = 0; }
      metaCache.set(path, dur);
    }
    if (dur > 0) card.querySelector(".dur").textContent = fmtRuler(dur);
  }
}

async function browse(dir) {
  const data = await api("/api/list?dir=" + encodeURIComponent(dir));
  browseDir = data.dir;
  $("browser-path").textContent = data.dir.replace(/^\/home\/[^/]+/, "~");
  const ul = $("browser-list");
  ul.innerHTML = "";

  const li = document.createElement("li");
  li.className = "dir up";
  li.title = "Voltar para a pasta anterior";
  li.innerHTML = `<img src="/icons/back.svg" alt="Voltar">`;
  li.onclick = () => browse(data.parent);
  ul.appendChild(li);

  for (const d of data.dirs) {
    const li = document.createElement("li");
    li.className = "dir";
    li.innerHTML = `<span class="name">${d}/</span>`;
    li.onclick = () => browse(data.dir + "/" + d);
    ul.appendChild(li);
  }

  // arquivos: cards com miniatura, duração e nome
  const grid = $("browser-grid");
  grid.innerHTML = "";
  for (const f of data.files) {
    const full = data.dir + "/" + f.name;
    const isProject = f.name.toLowerCase().endsWith(".evp");
    const card = document.createElement("div");
    card.className = isProject ? "card project" : "card";
    card.dataset.path = full;
    card.draggable = true;             // arraste para a timeline abre o vídeo p/ edição
    card.title = f.name + (isProject
      ? "\nProjeto salvo — clique para retomar a edição"
      : "\nClique para pré-visualizar · arraste para a timeline para editar");
    if (full === selectedFile) card.classList.add("selected");
    card.innerHTML =
      `<div class="thumb"><img loading="lazy" alt=""><span class="dur"></span></div>` +
      `<div class="name">${f.name}</div><div class="size">${fmtSize(f.size)}</div>`;
    const img = card.querySelector("img");
    img.src = isProject ? "/icons/save.svg" : "/api/thumb?path=" + encodeURIComponent(full);
    img.onerror = () => img.remove();  // sem miniatura: fica o ícone de fundo
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", full);
      e.dataTransfer.effectAllowed = "copy";
    });
    card.onclick = () => {                   // clicar seleciona; projeto retoma a
      selectFile(full);                      // edição, vídeo só pré-visualiza
      isProject ? loadProject(full) : previewFile(full);
    };
    card.addEventListener("contextmenu", (e) => showFileMenu(e, full, f.name));
    grid.appendChild(card);
  }
  fillDurations(grid);
}

// ---------- menu de contexto (botão direito nos cards) ----------
let ctxMenu = null;
function closeCtxMenu() { if (ctxMenu) { ctxMenu.remove(); ctxMenu = null; } }
document.addEventListener("click", closeCtxMenu);
document.addEventListener("scroll", closeCtxMenu, true);
window.addEventListener("blur", closeCtxMenu);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCtxMenu(); });

function showFileMenu(e, path, name) {
  e.preventDefault();
  closeCtxMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  const item = (label, cls, fn) => {
    const b = document.createElement("button");
    b.className = "ctx-item" + (cls ? " " + cls : "");
    b.textContent = label;
    b.onclick = (ev) => { ev.stopPropagation(); closeCtxMenu(); fn(); };
    menu.appendChild(b);
  };
  item("Renomear", "", () => renameFile(path, name));
  item("Deletar", "danger", () => deleteFile(path, name));
  document.body.appendChild(menu);
  // posiciona no cursor sem transbordar a janela
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, innerWidth - r.width - 6) + "px";
  menu.style.top = Math.min(e.clientY, innerHeight - r.height - 6) + "px";
  ctxMenu = menu;
}

// renomear/deletar quebrariam a edição se o arquivo estiver na timeline
const fileInTimeline = (path) => state.segments.some(s => s.src === path);

// limpa caches/estado de um arquivo que sumiu (deletado → newPath null) ou mudou
// de caminho (renomeado); se ele estava só em pré-visualização, esvazia o player
function forgetFile(path, newPath) {
  sources.delete(path);
  metaCache.delete(path);
  if (selectedFile === path) selectedFile = newPath;
  if (activeSrc === path && !hasContent()) {
    activeSrc = null;
    player.removeAttribute("src");
    backPlayer.removeAttribute("src");
    $("player-wrap").classList.remove("has-video");
    $("file-info").textContent = "";
    updateActiveUI();
  }
}

async function renameFile(path, name) {
  if (fileInTimeline(path))
    return alert("Este arquivo está na timeline. Remova-o da edição antes de renomear.");
  const novo = prompt("Novo nome do arquivo:", name);
  if (novo == null) return;               // cancelou
  const nome = novo.trim();
  if (!nome || nome === name) return;
  try {
    const r = await api("/api/file-rename", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, newName: nome }),
    });
    forgetFile(path, r.path);
    await browse(browseDir);
  } catch (e) { alert("Erro ao renomear: " + e.message); }
}

async function deleteFile(path, name) {
  if (fileInTimeline(path))
    return alert("Este arquivo está na timeline. Remova-o da edição antes de deletar.");
  if (!confirm(`Mover para a lixeira?\n\n${name}`)) return;
  try {
    await api("/api/file-delete", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    forgetFile(path, null);
    await browse(browseDir);
  } catch (e) { alert("Erro ao deletar: " + e.message); }
}

// ---------- painel lateral redimensionável ----------
{
  const MIN_W = 220;
  const setSideW = (w) => document.body.style.setProperty("--side-w", w + "px");
  const saved = parseInt(localStorage.getItem("sideWidth"), 10);
  if (saved) setSideW(Math.max(MIN_W, saved));

  const rz = $("side-resizer");
  rz.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    rz.setPointerCapture(e.pointerId);
    rz.classList.add("dragging");
    let w = 0;
    const move = (ev) => {
      w = Math.min(Math.max(ev.clientX, MIN_W), Math.round(window.innerWidth * 0.6));
      setSideW(w);
    };
    const up = () => {
      rz.classList.remove("dragging");
      rz.removeEventListener("pointermove", move);
      rz.removeEventListener("pointerup", up);
      if (w) localStorage.setItem("sideWidth", w);
    };
    rz.addEventListener("pointermove", move);
    rz.addEventListener("pointerup", up);
  });
  rz.addEventListener("dblclick", () => {        // duplo clique restaura o padrão
    document.body.style.removeProperty("--side-w");
    localStorage.removeItem("sideWidth");
  });
}

// ---------- player ----------
// DOIS elementos <video> alternados: enquanto um toca, o outro (reserva,
// .standby) pré-carrega o próximo arquivo da timeline; na fronteira eles
// trocam de papel na hora — sem recarregar src, sem flash.
let player = $("player");        // elemento ATIVO (visível)
let backPlayer = $("player2");   // reserva escondido com o próximo arquivo
let backWant = null;             // instante a posicionar no reserva após carregar

// listeners do player ativo: registrados aqui para MIGRAREM junto na troca
const playerEvents = [];
function onPlayerEvent(ev, fn) {
  playerEvents.push([ev, fn]);
  player.addEventListener(ev, fn);
}

// o reserva se posiciona no ponto de entrada assim que os metadados chegam
for (const el of [player, backPlayer]) {
  el.addEventListener("loadedmetadata", () => {
    if (el === player || backWant == null) return;
    try { el.currentTime = backWant; } catch (_) { /* fora do alcance */ }
  });
}

// troca instantânea: reserva vira ativo (e vice-versa), listeners migram
function swapPlayers(t, resume) {
  for (const [ev, fn] of playerEvents) {
    player.removeEventListener(ev, fn);
    backPlayer.addEventListener(ev, fn);
  }
  backPlayer.volume = player.volume;
  backPlayer.muted = player.muted;
  player.pause();
  player.classList.add("standby");
  backPlayer.classList.remove("standby");
  const old = player;
  player = backPlayer;
  backPlayer = old;
  try { player.currentTime = t; } catch (_) { /* posiciona no que der */ }
  if (resume) player.play();
}

// pré-carrega no reserva o próximo arquivo distinto da timeline
function preloadNext() {
  if (!state.segments.length || !activeSrc) return;
  const idx = keptIdxAt(activeSrc, player.currentTime);
  const seg = idx >= 0 ? state.segments[idx] : null;
  const nxt = seg ? nextKeptAfter(seg) : null;
  if (!nxt || nxt.src === activeSrc) return;
  const s = sources.get(nxt.src);
  if (!s || !s.media) return;
  backWant = nxt.start + 0.001;
  if (backPlayer.getAttribute("src") !== s.media) {
    backPlayer.src = s.media;      // loadedmetadata acima posiciona em backWant
  } else if (backPlayer.readyState >= 1 &&
             Math.abs(backPlayer.currentTime - backWant) > 0.3) {
    try { backPlayer.currentTime = backWant; } catch (_) { }
  }
}

// arrastar um arquivo SOMA-o ao fim da timeline (não substitui). Os appends são
// encadeados numa fila para preservar a ordem de solta mesmo com probes lentos.
let appendChain = Promise.resolve();
function addToTimeline(path) {
  appendChain = appendChain.then(() => appendOne(path)).catch(() => {});
  return appendChain;
}

// garante probe + preparo da mídia tocável de um arquivo; null se o probe falhar
async function ensureSource(path) {
  let s = sources.get(path);
  if (s) return s;
  $("file-info").textContent = basename(path) + " — carregando info…";
  let info;
  try {
    info = await api("/api/probe?path=" + encodeURIComponent(path));
  } catch (e) {
    $("file-info").textContent = basename(path) + " — erro no probe: " + e.message;
    return null;
  }
  s = { info, media: null, ready: false, err: null };
  sources.set(path, s);
  prepareSource(path);   // transcodifica a prévia em paralelo (se necessário)
  return s;
}

// pré-visualização: clique num card carrega o arquivo SÓ no player, sem tocar
// na timeline — serve para escolher o vídeo antes de editar. Desabilitada
// enquanto houver conteúdo na timeline (não atrapalha uma edição em curso).
async function previewFile(path) {
  if (hasContent()) return;
  const s = await ensureSource(path);
  if (!s) return;
  if (hasContent() || selectedFile !== path) return;   // situação mudou durante o await
  $("player-wrap").classList.add("has-video");
  switchPlayerTo(path, 0);
}

async function appendOne(path) {
  const s = await ensureSource(path);
  if (!s) return;
  const dur = s.info.duration || 0;
  if (dur <= 0) {
    $("file-info").textContent = basename(path) + " — duração desconhecida, não adicionado";
    return;
  }
  const first = state.segments.length === 0;
  $("player-wrap").classList.add("has-video");
  apply(st => st.segments.push(
    { src: path, start: 0, end: dur, deleted: false, speed: 1, gap: 0, hue: nextHue() }));
  if (first || !activeSrc) {           // primeiro conteúdo: carrega no player
    tlZoom = 1; tlView = 0;
    switchPlayerTo(path, 0);
  }
  updateActiveUI();
  drawTimeline();
}

// prepara a mídia tocável de um arquivo: formatos que o <video> não toca
// nativamente (mkv, avi, wmv, flv, ts, mpg, 3gp…) são transcodificados sob
// demanda pelo servidor (com cache). Guarda a URL final em sources[path].media.
async function prepareSource(path) {
  const s = sources.get(path);
  if (!s || s.media) return;
  try {
    const r = await api("/api/preview?path=" + encodeURIComponent(path));
    if (r.ready) {
      s.media = "/api/media?path=" + encodeURIComponent(r.path);
    } else {
      startPolling();
      const job = await pollJob(r.job);
      s.media = "/api/media?path=" + encodeURIComponent(job.output);
    }
    s.ready = true;
    // se este arquivo é o ativo e estava esperando a mídia, carrega agora
    if (activeSrc === path && !player.getAttribute("src")) switchPlayerTo(path, wantTime);
    preloadNext();   // a mídia recém-pronta pode ser o próximo da timeline
  } catch (e) {
    s.err = e.message;
    if (activeSrc === path)
      $("file-info").textContent += " · erro na pré-visualização: " + e.message;
  }
}

// troca o arquivo carregado no <video> (usado ao cruzar a fronteira entre
// trechos de arquivos diferentes). Se a mídia ainda não está pronta, aguarda —
// prepareSource re-chama quando terminar.
function switchPlayerTo(src, t) {
  const resume = activeSrc != null && !player.paused && !player.ended;
  activeSrc = src;
  wantTime = t || 0;
  const s = sources.get(src);
  if (s && s.media && backPlayer.getAttribute("src") === s.media &&
      backPlayer.readyState >= 2) {
    swapPlayers(wantTime, resume);   // reserva já tem este arquivo: troca sem flash
    drawTimeline();
  } else if (s && s.media) {
    if (player.getAttribute("src") !== s.media) player.src = s.media; // busca no loadedmetadata
    else { player.currentTime = wantTime; drawTimeline(); }
  } else {
    player.removeAttribute("src");
  }
  updateActiveUI();
  preloadNext();
}

// reflete o arquivo ativo na UI: seleção na lista, info e botões de operação
function updateActiveUI() {
  ["btn-convert", "btn-extract"].forEach(id => $(id).disabled = !activeSrc);
  const info = activeInfo();
  if (!info) return;
  const v = info.video, a = info.audio, n = distinctSrcs().length;
  $("file-info").textContent = basename(activeSrc) +
    ` — ${fmtTime(info.duration)}` +
    (v ? ` · ${v.width}×${v.height} ${v.codec}` : "") +
    (a ? ` · áudio ${a.codec}` : " · sem áudio") +
    ` · ${fmtSize(info.size)}` +
    (n > 1 ? `  ·  ${n} arquivos na timeline` : "") +
    (!hasContent() ? "  ·  pré-visualização — arraste para a timeline para editar" : "");
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

// ao (re)carregar um arquivo no player, posiciona no instante pedido pela troca
onPlayerEvent("loadedmetadata", () => {
  if (wantTime && Math.abs(player.currentTime - wantTime) > 0.05) {
    try { player.currentTime = wantTime; } catch (_) { /* fora do alcance */ }
  }
  drawTimeline();
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

const segKey = (s) => s.src + "@" + s.start.toFixed(3) + ":" + s.end.toFixed(3);
const keptSegs = () => state.segments.filter(s => !s.deleted);
// duração VISÍVEL do trecho, já com a aceleração aplicada: um trecho a 2x ocupa
// metade da largura na timeline — igual ao que sai na exportação.
const segVis = (s) => (s.end - s.start) / (s.speed || 1);

function targetLayout() {
  const pos = new Map();
  let acc = 0;
  for (const s of keptSegs()) {
    acc += s.gap || 0;          // lacuna (preta) antes do segmento
    pos.set(segKey(s), acc);    // início visível do segmento é depois da lacuna
    acc += segVis(s);
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
      tlView = sourceToVisible(panAnchorSrc.src, panAnchorSrc.t) - 0.5 * tlSpan();
      clampView();
    }
    drawTimeline();
    if (p < 1) layoutAnimId = requestAnimationFrame(step);
    else panAnchorSrc = null;
  };
  layoutAnimId = requestAnimationFrame(step);
}

// tempo (arquivo `src`, instante `t`) → posição visível na timeline (layout animado)
function sourceToVisible(src, t) {
  let prevEnd = 0;
  for (const s of keptSegs()) {
    const p = animPos.get(segKey(s)) ?? 0;
    if (s.src === src) {
      if (t < s.start) return p;             // dentro de parte deletada deste arquivo
      if (t <= s.end) return p + (t - s.start) / (s.speed || 1);
    }
    prevEnd = p + segVis(s);
  }
  return prevEnd;
}

// posição visível → { src, t } do arquivo (usa o layout final, estável).
// Se cair numa lacuna, devolve o início (fonte) do próximo trecho.
function visibleToSource(tv) {
  const kept = keptSegs();
  if (!kept.length) return { src: activeSrc, t: 0 };
  let acc = 0;
  for (const s of kept) {
    acc += s.gap || 0;               // pula a lacuna preta antes do trecho
    const d = segVis(s), sp = s.speed || 1;
    if (tv < acc) return { src: s.src, t: s.start };     // na lacuna → início do trecho seguinte
    if (tv <= acc + d) return { src: s.src, t: s.start + (tv - acc) * sp };
    acc += d;
  }
  const l = kept[kept.length - 1];
  return { src: l.src, t: l.end };
}

// true se a posição visível tv cai numa lacuna preta (entre trechos)
function visibleGapAt(tv) {
  let acc = 0;
  for (const s of keptSegs()) {
    const g = s.gap || 0;
    if (tv < acc + g) return tv >= acc - 1e-6;   // dentro da faixa da lacuna
    acc += g + segVis(s);
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
  if (!hasContent() || animDur <= 0) return;
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
    const wd = segVis(s) * scale;
    const sel = i === selectedSeg;
    const hue = s.hue ?? 210;                    // cor própria e estável do segmento
    ctx.fillStyle = `hsla(${hue}, 62%, 55%, ${sel ? 0.82 : 0.55})`;
    ctx.fillRect(x0, segTop, wd, segH);
    if (sel) {                                   // seleção: borda branca destacada
      ctx.strokeStyle = "rgba(255,255,255,.92)";
      ctx.lineWidth = 2 * dpr;
      ctx.strokeRect(x0 + 1, segTop + 1, wd - 2, segH - 2);
    }
    if (s.speed && s.speed !== 1 && wd > 20 * dpr) {
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${10 * dpr}px system-ui, sans-serif`;
      ctx.textBaseline = "top";
      ctx.fillText(`${s.speed}x`, x0 + 4 * dpr, segTop + 2 * dpr);
    }
    prevVisEnd = visStart + segVis(s);
  }

  drawRuler(w, h, rulerH, scale);

  // cursor de reprodução (posição compactada; numa lacuna usa o playhead virtual)
  const playVis = gapVisible != null ? gapVisible : sourceToVisible(activeSrc, player.currentTime);
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
let segMoveBaseX = 0;   // clientX de referência do arraste (re-ancorado a cada troca de ordem)

const nextKeptIdx = (idx) => {
  for (let j = idx + 1; j < state.segments.length; j++) if (!state.segments[j].deleted) return j;
  return -1;
};
const prevKeptIdxOf = (idx) => {
  for (let j = idx - 1; j >= 0; j--) if (!state.segments[j].deleted) return j;
  return -1;
};
// lacunas na reprodução: overlay preto + playhead virtual passando pela lacuna
let gapVisible = null;   // posição visível do playhead quando está numa lacuna (senão null)
let gapHold = null;      // reprodução temporizada do preto durante uma lacuna
let prevKeptIdx = -1;    // último trecho tocado (evita retriggar a mesma lacuna)

const setGapOverlay = (show) => $("gap-overlay").classList.toggle("show", show);
const keptIdxAt = (src, t) =>
  state.segments.findIndex(s => !s.deleted && s.src === src && t >= s.start && t <= s.end);

// próximo trecho mantido (em ordem de timeline) depois de `seg`
function nextKeptAfter(seg) {
  const i = state.segments.indexOf(seg);
  for (let j = i + 1; j < state.segments.length; j++)
    if (!state.segments[j].deleted) return state.segments[j];
  return null;
}
// posiciona o player em (src, t): busca no mesmo arquivo, ou troca o <video>
// quando o alvo está num arquivo diferente do carregado.
function seekSource(src, t) {
  if (src && src !== activeSrc) switchPlayerTo(src, t);
  else { seekTo(t); preloadNext(); }
}

// raspagem ciente de lacuna: se o ponteiro cai numa lacuna, mostra preto e
// estaciona o vídeo no início do próximo trecho (frame atrás do overlay).
function scrubToVisible(vt) {
  const inGap = visibleGapAt(vt);
  gapVisible = inGap ? vt : null;
  setGapOverlay(inGap);
  const { src, t } = visibleToSource(vt);
  prevKeptIdx = keptIdxAt(src, t);
  seekSource(src, t);
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
    if (vt >= p && vt <= p + segVis(s)) return state.segments.indexOf(s);
  }
  return -1;
}
function selectSegAt(src, t) {
  const i = state.segments.findIndex(s => !s.deleted && s.src === src && t >= s.start && t <= s.end);
  selectedSeg = i >= 0 ? i : null;
}
function seekAndSelect(e) {
  const vt = visibleAtEvent(e);
  const { src, t } = visibleToSource(vt);
  selectSegAt(src, t);                 // clicar seleciona o trecho sob o ponteiro
  scrubToVisible(vt);
  renderState();
}
function seekTo(t) {
  if (player.seeking) pendingSeek = t;
  else player.currentTime = t;
  drawTimeline();
}
onPlayerEvent("seeked", () => {
  if (pendingSeek != null) { player.currentTime = pendingSeek; pendingSeek = null; }
  drawTimeline();
});

const onRuler = (e) => (e.clientY - canvas.getBoundingClientRect().top) < RULER_CSS_H;

canvas.addEventListener("pointerdown", (e) => {
  if (!hasContent() || animDur <= 0) return;
  canvas.setPointerCapture(e.pointerId);
  downX = e.clientX;
  dragMoved = false;
  const overIdx = onRuler(e) ? -1 : segIndexAtVisible(visibleAtEvent(e));
  if (overIdx !== -1 && overIdx === selectedSeg) {
    // arrastar o segmento SELECIONADO → desliza na lacuna preta e, ao passar
    // por cima de um vizinho, troca de ordem com ele (reordenação)
    segMoving = true;
    segMoveIdx = overIdx;
    segMoveBaseX = e.clientX;
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
    // 1) REORDENAR: se o arraste passar do meio de um vizinho, troca de posição
    //    com ele no array. Re-ancora a referência do arraste (segMoveBaseX) para
    //    o gesto continuar contínuo e poder cruzar vários trechos em sequência.
    const rebase = () => {
      segMoveBaseX = e.clientX;
      segMoveOrigGap = state.segments[segMoveIdx].gap || 0;
      segMoveNextIdx = nextKeptIdx(segMoveIdx);
      segMoveOrigNextGap = segMoveNextIdx !== -1 ? (state.segments[segMoveNextIdx].gap || 0) : 0;
      selectedSeg = segMoveIdx;
    };
    const dxr = (e.clientX - segMoveBaseX) / rect.width * segMoveSpan0;
    const ni = nextKeptIdx(segMoveIdx), pi = prevKeptIdxOf(segMoveIdx);
    if (dxr > 0 && ni !== -1 &&
        dxr - segMoveOrigNextGap >= segVis(state.segments[ni]) / 2) {
      const seg = state.segments.splice(segMoveIdx, 1)[0];  // dragado passa p/ depois do próximo
      state.segments.splice(ni, 0, seg);
      segMoveIdx = ni;
      const f = state.segments.find(s => !s.deleted); if (f) f.gap = 0; // sem preto solto no início
      rebase();
    } else if (dxr < 0 && pi !== -1 &&
        -dxr - segMoveOrigGap >= segVis(state.segments[pi]) / 2) {
      const seg = state.segments.splice(segMoveIdx, 1)[0];  // dragado passa p/ antes do anterior
      state.segments.splice(pi, 0, seg);
      segMoveIdx = pi;
      const f = state.segments.find(s => !s.deleted); if (f) f.gap = 0;
      rebase();
    }
    // 2) DESLIZAR na lacuna: dentro do espaço preto ajusta o gap (comportamento
    //    original). Consome a lacuna de um lado e devolve do outro, sem mexer nos
    //    vizinhos; limitado pelo preto disponível (o último trecho vai livre p/ direita).
    const dxSec = (e.clientX - segMoveBaseX) / rect.width * segMoveSpan0;
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
  if (!hasContent() || animDur <= 0) return;
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

// arrastar um arquivo da lista para a faixa da timeline abre-o para edição
const dropZone = $("bottom");
dropZone.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  canvas.classList.add("drag-over");
});
dropZone.addEventListener("dragleave", (e) => {
  if (!dropZone.contains(e.relatedTarget)) canvas.classList.remove("drag-over");
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  canvas.classList.remove("drag-over");
  const path = e.dataTransfer.getData("text/plain");
  if (!path) return;
  path.toLowerCase().endsWith(".evp") ? loadProject(path) : addToTimeline(path);
});

// Durante a reprodução: pula os trechos deletados e, ao entrar num trecho que
// foi afastado, toca a lacuna como preto+silêncio pela sua duração.
function advancePlayback() {
  if (scrubbing || segMoving || gapHold || !state.segments.length || player.paused) return;
  const t = player.currentTime;
  // 1) região deletada do arquivo ativo → salta para o próximo trecho mantido
  const del = state.segments.find(s => s.deleted && s.src === activeSrc && t >= s.start && t < s.end);
  if (del) {
    const nxt = nextKeptAfter(del);
    if (nxt) goToKept(nxt);
    else { player.pause(); player.currentTime = del.start; }
    return;
  }
  // 2) dentro de um trecho mantido do arquivo ativo
  const idx = keptIdxAt(activeSrc, t);
  if (idx === -1) { jumpPastEnd(t); return; }   // janela do timeupdate perdida
  if (idx !== prevKeptIdx) {            // entrou num novo trecho → toca a lacuna anterior
    prevKeptIdx = idx;
    if ((state.segments[idx].gap || 0) > 0.02) startGapHold(state.segments[idx]);
    preloadNext();                      // e já deixa o próximo arquivo pronto no reserva
  }
  // ao fim deste trecho, se o próximo é de OUTRO arquivo, pula para ele (senão o
  // <video> continuaria tocando o resto do arquivo ativo além do trecho).
  const seg = state.segments[idx];
  const rate = seg.speed || 1;          // preview honra a aceleração do trecho tocado
  if (player.playbackRate !== rate) player.playbackRate = rate;
  if (t >= seg.end - 0.05) {
    const nxt = nextKeptAfter(seg);
    if (nxt && nxt.src !== activeSrc) goToKept(nxt);
  }
}

// o playhead passou do fim do trecho que tocava (timeupdate pulou a janela de
// disparo, ou o arquivo acabou): segue para o próximo trecho mantido, se houver
function jumpPastEnd(t) {
  const seg = state.segments[prevKeptIdx];
  if (!seg || seg.deleted || seg.src !== activeSrc) return false;
  if (t < seg.end - 0.05) return false;
  const nxt = nextKeptAfter(seg);
  if (!nxt) return false;
  goToKept(nxt);
  return true;
}

// salta a reprodução para o início de um trecho mantido (troca de arquivo se preciso)
function goToKept(seg) {
  prevKeptIdx = state.segments.indexOf(seg);
  seekSource(seg.src, seg.start + 0.001);
  if ((seg.gap || 0) > 0.02) startGapHold(seg);
}

// timeupdate dispara a cada quadro durante a reprodução.
onPlayerEvent("timeupdate", () => {
  advancePlayback();
  if (gapHold == null) drawTimeline();   // durante a lacuna quem desenha é o gapHoldStep
});
onPlayerEvent("play", () => {
  prevKeptIdx = keptIdxAt(activeSrc, player.currentTime);
  advancePlayback();
  preloadNext();
});
onPlayerEvent("pause", () => {
  if (!gapHold) { gapVisible = null; setGapOverlay(false); }
  drawTimeline();
});
// arquivo chegou ao fim: se o trecho tem sucessor na timeline, continua nele
onPlayerEvent("ended", () => {
  if (state.segments.length && jumpPastEnd(player.currentTime)) player.play();
});

// ---------- corte / deleção / exportação ----------
function doCut() {
  const t = player.currentTime;   // o playhead está sempre dentro do arquivo ativo
  const i = state.segments.findIndex(s =>
    s.src === activeSrc && !s.deleted && t > s.start + CUT_EPS && t < s.end - CUT_EPS);
  if (i < 0) return; // em cima de uma borda ou fora do trecho
  selectedSeg = null;
  apply(s => {
    const seg = s.segments[i];
    s.segments.splice(i, 1,
      { src: seg.src, start: seg.start, end: t, deleted: seg.deleted, speed: seg.speed, gap: seg.gap || 0, hue: seg.hue },
      { src: seg.src, start: t, end: seg.end, deleted: seg.deleted, speed: seg.speed, gap: 0, hue: nextHue() });
  });
}
function deleteSelected() {
  if (selectedSeg == null || state.segments[selectedSeg]?.deleted) return;
  const i = selectedSeg;
  selectedSeg = null;
  // era o único trecho aproveitado? apagá-lo deixaria a timeline só com lacunas
  // pretas, sem nada para editar ou exportar. Zera tudo, como recarregar a página.
  if (keptSegs().length === 1) { resetEditor(); return; }
  apply(s => { s.segments[i].deleted = true; });
}

// volta ao estado inicial da edição — timeline, player, histórico, zoom/pan —
// como se a página tivesse sido recarregada. O navegador de arquivos fica onde
// está (um refresh de verdade voltaria à pasta inicial, mais atrapalha que ajuda).
function resetEditor() {
  state.segments = [];
  history.past = []; history.future = [];
  selectedSeg = null;
  activeSrc = null; wantTime = 0;
  sources.clear();
  tlZoom = 1; tlView = 0;
  cancelAnimationFrame(layoutAnimId);
  animPos.clear(); animDur = 0;
  for (const el of [player, backPlayer]) { el.pause(); el.removeAttribute("src"); el.load(); }
  $("player-wrap").classList.remove("has-video");
  $("file-info").textContent = "";
  updateActiveUI();
  renderState();
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
  if (!activeSrc) return "";
  const ext = activeSrc.split(".").pop().toLowerCase();
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
// salvar PROJETO (.evp): grava os segmentos da timeline em JSON para retomar depois
$("btn-save").onclick = async () => {
  if (!state.segments.length) return;
  try {
    const picked = await api("/api/pick-save?input=" + encodeURIComponent(state.segments[0].src) +
      "&suffix=projeto&ext=evp&title=" + encodeURIComponent("Salvar projeto"));
    if (picked.cancelled) return;
    const project = { app: "EditorVideo", version: 1, savedAt: new Date().toISOString(),
                      segments: state.segments };
    const r = await api("/api/project-save", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: picked.path, project }),
    });
    $("file-info").textContent = "✔ Projeto salvo em " + r.path;
    if (r.path.slice(0, r.path.lastIndexOf("/")) === browseDir) browse(browseDir);
  } catch (e) { alert("Erro ao salvar projeto: " + e.message); }
};

// abrir projeto pelo seletor de arquivos (zenity filtrado em .evp)
$("btn-open").onclick = async () => {
  try {
    const picked = await api("/api/pick-open?title=" + encodeURIComponent("Abrir projeto") +
      "&filter=" + encodeURIComponent("Projetos EditorVideo (*.evp) | *.evp"));
    if (picked.cancelled) return;
    loadProject(picked.path);
  } catch (e) { alert("Erro ao abrir projeto: " + e.message); }
};

// retomar um projeto .evp: restaura os segmentos (substitui a timeline atual)
async function loadProject(path) {
  if (hasContent() &&
      !confirm("Carregar o projeto substitui a timeline atual. Continuar?")) return;
  let proj;
  try {
    proj = await api("/api/project-load?path=" + encodeURIComponent(path));
  } catch (e) { alert("Erro ao abrir projeto: " + e.message); return; }
  const segs = proj.segments || [];
  if (!segs.length) { alert("Projeto vazio."); return; }
  const missing = [];
  for (const src of [...new Set(segs.map(s => s.src))]) {
    if (!await ensureSource(src)) missing.push(src);
  }
  if (missing.length) {
    alert("Arquivos do projeto não encontrados:\n" + missing.join("\n"));
    return;
  }
  apply(st => { st.segments = segs; });   // entra no histórico (dá para desfazer)
  selectedSeg = null;
  tlZoom = 1; tlView = 0;
  const first = segs.find(s => !s.deleted) || segs[0];
  $("player-wrap").classList.add("has-video");
  switchPlayerTo(first.src, first.start);
  updateActiveUI();
  drawTimeline();
}
$("btn-export-cancel").onclick = () => setExportOptsVisible(false);
$("btn-export-go").onclick = async () => {
  const kept = state.segments.filter(s => !s.deleted);
  if (!kept.length) return;
  const srcs = [...new Set(kept.map(s => s.src))];
  const multi = srcs.length > 1;
  const format = $("export-format").value; // "" = manter original, ou "mp4"/"webm"
  // multi-arquivo sempre recodifica/normaliza (formatos podem diferir) → mp4 por padrão
  const ext = multi ? (format || "mp4") : (format || activeSrc.split(".").pop());
  const btn = $("btn-export-go");
  btn.disabled = true;
  try {
    const picked = await api("/api/pick-save?input=" + encodeURIComponent(kept[0].src) +
      "&suffix=editado&ext=" + encodeURIComponent(ext));
    if (picked.cancelled) return; // usuário cancelou no seletor, painel continua aberto
    let body;
    if (multi) {
      body = {
        op: "render_multi", output: picked.path, format: format || "mp4",
        parts: kept.map(s => [s.src, s.start, s.end, s.speed || 1, s.gap || 0]),
      };
    } else {
      body = {
        op: format ? "render_convert" : "render",
        input: kept[0].src, output: picked.path,
        parts: kept.map(s => [s.start, s.end, s.speed || 1, s.gap || 0]),
      };
      if (format) body.format = format;
    }
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
  else if (e.key === " " && activeSrc && e.target.tagName !== "BUTTON") {
    e.preventDefault();
    player.paused ? player.play() : player.pause();
  }
});

// ---------- render do estado (undo/redo re-renderiza tudo) ----------
function renderState() {
  if (selectedSeg != null && selectedSeg >= state.segments.length) selectedSeg = null;

  // botões da timeline
  const segs = state.segments;
  const kept = segs.filter(s => !s.deleted).length;
  const del = segs.length - kept;
  const sped = segs.some(s => !s.deleted && s.speed && s.speed !== 1);
  const gapped = segs.some(s => !s.deleted && (s.gap || 0) > 1e-6);
  const nFiles = distinctSrcs().length;   // arquivos distintos na timeline
  $("btn-cut").disabled = !segs.length;
  $("btn-del-seg").disabled = selectedSeg == null || segs[selectedSeg]?.deleted;
  const segEditable = selectedSeg != null && !segs[selectedSeg]?.deleted;
  $("seg-speed").disabled = !segEditable;
  $("seg-speed").value = segEditable ? String(segs[selectedSeg].speed || 1) : "1";
  // multi-arquivo já é motivo para exportar (junta os arquivos), além de cortes/velocidade/lacuna
  $("btn-export").disabled = !(kept > 0 && (del > 0 || sped || gapped || nFiles > 1));
  $("btn-save").disabled = !segs.length;   // salvar projeto: basta ter timeline
  $("mark-info").textContent = (nFiles > 1 ? `${nFiles} arquivos · ` : "")
    + (segs.length > 1
      ? `${segs.length} segmentos` + (del ? ` · ${del} deletado${del > 1 ? "s" : ""}` : "")
        + (gapped ? " · com lacuna" : "")
      : (gapped ? "com lacuna" : ""));

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
  cut: "Corte", convert: "Conversão",
  extract: "Áudio", delete: "Remoção", render: "Exportação", render_convert: "Exportação",
  render_multi: "Exportação", preview: "Pré-visualização",
};

async function refreshJobs() {
  const jobs = await api("/api/jobs");
  const bar = $("jobs-bar");
  const all = Object.values(jobs);
  const running = Object.entries(jobs).filter(([, j]) => j.status === "running");
  bar.innerHTML = "";

  // tarefas em andamento: rótulo + barra + % (+ Stop nas conversões)
  for (const [jid, j] of running) {
    const chip = document.createElement("div");
    chip.className = "job-chip";
    chip.innerHTML = `<span>${OP_LABEL[j.op] || j.op}</span>` +
      `<div class="bar"><div style="width:${j.progress}%"></div></div>` +
      `<span>${Math.round(j.progress)}%</span>`;
    if (j.op === "convert") {
      const stop = document.createElement("button");
      stop.className = "stop";
      stop.textContent = "Stop";
      stop.title = "Cancelar a conversão";
      stop.onclick = () => api("/api/cancel?job=" + jid);
      chip.insertBefore(stop, chip.querySelector(".bar"));   // à esquerda da barra
    }
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
    } else if (j.status === "cancelled") {
      chip.innerHTML = `<span class="job-cancel">■ ${OP_LABEL[j.op] || j.op} cancelada</span>`;
    } else {
      chip.title = j.error || "";
      chip.innerHTML = `<span class="job-err">✖ ${OP_LABEL[j.op] || j.op} falhou</span>`;
    }
    bar.appendChild(chip);
  }

  if (!running.length && polling) { clearInterval(polling); polling = null; }
}

// ---------- botões de operação ----------
$("btn-convert").onclick = async () => {
  const jobId = await submitJob({
    op: "convert", input: activeSrc,
    format: $("conv-format").value,
    quality: $("conv-quality").value,
    gpu: $("conv-gpu").checked,
  });
  if (!jobId) return;
  try {
    // ao terminar, soma o arquivo convertido à timeline pronto para edição
    const job = await pollJob(jobId, 800);
    const dir = job.output.slice(0, job.output.lastIndexOf("/"));
    if (dir === browseDir) await browse(browseDir); // revela o novo arquivo na lista
    addToTimeline(job.output);
  } catch (_) { /* falha/cancelamento já sinalizados na barra de tarefas */ }
};
$("btn-extract").onclick = () => submitJob({ op: "extract", input: activeSrc });

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
