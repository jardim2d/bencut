// BenCut — UI que fala com server.py (FFmpeg local)
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
  segments: [],   // [{start, end, deleted, speed, volume, opacity}] cobrindo o vídeo inteiro
  texts: [],      // [{text, start, end, pos}] em tempo VISÍVEL da timeline (= tempo do export)
  transition: 0,  // fade preto entre trechos, em segundos (0 = sem transição)
  audioTrack: [], // [{src, start, end, at, volume, track, hue}] áudios em N lanes
  imageTrack: [], // [{src, at, duration, track, hue}] imagens em N lanes, default duration 3s
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
let selectedAudio = null;    // índice do clipe de áudio selecionado
let selectedImage = null;    // índice da imagem selecionada
let activeTrack = "video";   // faixa ativa ("video" | "audio" | "image"): Dividir/Excluir agem nela
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
// fps do probe vem como fração ("30000/1001") → "29.97 FPS"
const fmtFps = (fr) => {
  const [n, d] = String(fr).split("/").map(Number);
  const f = d ? n / d : n;
  return Number.isFinite(f) && f > 0 ? `${+f.toFixed(2)} FPS` : "—";
};
const activeDur = () => activeInfo()?.duration || player.duration || 0;
const hasVideo = () => state.segments.length > 0;     // há faixa de vídeo?
// há algo na timeline (vídeo, áudio OU imagem) — o projeto pode começar por qualquer faixa
const hasContent = () => state.segments.length > 0 || state.audioTrack.length > 0
  || state.imageTrack.length > 0;
// nº de lanes de áudio = maior índice de faixa + 1 (cada áudio arrastado = +1)
const audioLaneCount = () =>
  state.audioTrack.reduce((m, c) => Math.max(m, (c.track || 0) + 1), 0);
// nº de lanes de imagem (mesmo padrão)
const imageLaneCount = () =>
  state.imageTrack.reduce((m, c) => Math.max(m, (c.track || 0) + 1), 0);

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
let mediaFilter = "video"; // filtro do painel: "video" | "audio"
let lastBrowse = null;     // último /api/list, p/ re-render ao trocar o filtro
let dragKind = null;       // tipo do arquivo sendo arrastado ("video"/"audio"/"project")
// último diretório visitado em cada aba, persistido entre sessões: ao alternar
// Vídeo/Áudio o painel volta sozinho para onde o usuário estava naquela aba
const dirByKind = (() => {
  const base = { video: null, audio: null, image: null };
  try { return { ...base, ...JSON.parse(localStorage.getItem("dirByKind")) }; }
  catch { return base; }
})();

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
  lastBrowse = data;
  browseDir = data.dir;
  dirByKind[mediaFilter] = data.dir;    // memoriza o diretório da aba atual
  try { localStorage.setItem("dirByKind", JSON.stringify(dirByKind)); } catch {}
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
  renderGrid();
}

// desenha os cards do último /api/list, filtrando pelo tipo de mídia ativo.
// video → vídeos + projetos (.evp); audio → só áudios; image → só imagens.
function renderGrid() {
  const data = lastBrowse;
  if (!data) return;
  const grid = $("browser-grid");
  grid.innerHTML = "";
  const files = data.files.filter(f =>
    mediaFilter === "audio" ? f.kind === "audio"
    : mediaFilter === "image" ? f.kind === "image"
    : f.kind === "video" || f.kind === "project");
  for (const f of files) {
    const full = data.dir + "/" + f.name;
    const isProject = f.kind === "project";
    const isAudio = f.kind === "audio";
    const isImage = f.kind === "image";
    const card = document.createElement("div");
    card.className = "card" + (isProject ? " project" : isAudio ? " audio" : isImage ? " image" : "");
    card.dataset.path = full;
    card.draggable = !isProject;
    card.title = f.name + (isProject
      ? "\nProjeto salvo — clique para retomar a edição"
      : isAudio
      ? "\nClique para pré-visualizar · arraste para a trilha de áudio"
      : isImage
      ? "\nClique para pré-visualizar · arraste para a linha de imagens"
      : "\nClique para pré-visualizar · arraste para a timeline para editar");
    if (full === selectedFile) card.classList.add("selected");
    card.innerHTML =
      `<div class="thumb"><img loading="lazy" alt=""><span class="dur"></span></div>` +
      `<div class="name">${f.name}</div><div class="size">${fmtSize(f.size)}</div>`;
    const img = card.querySelector("img");
    img.src = isProject ? "/icons/save.svg"
      : isAudio ? "/icons/audio.svg"
      : "/api/thumb?path=" + encodeURIComponent(full);   // imagem também via ffmpeg
    img.onerror = () => img.remove();  // sem miniatura: fica o ícone de fundo
    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", full);
      e.dataTransfer.effectAllowed = "copy";
      dragKind = f.kind;      // roteia o drop (áudio → trilha; senão → vídeo)
    });
    card.onclick = () => {                   // clicar seleciona; projeto retoma a
      selectFile(full);                      // edição, mídias pré-visualizam
      if (isProject) loadProject(full);
      else if (isImage) previewImage(full);
      else previewFile(full);                // vídeo e áudio
    };
    card.addEventListener("contextmenu", (e) => showFileMenu(e, full, f.name));
    grid.appendChild(card);
  }
  fillDurations(grid);
}

// toggle Vídeo/Áudio: troca o filtro e volta para o último diretório daquela
// aba (se houver e for diferente do atual); senão só re-renderiza a lista atual
for (const b of document.querySelectorAll(".mf-btn")) {
  b.onclick = () => {
    if (mediaFilter === b.dataset.kind) return;
    mediaFilter = b.dataset.kind;
    document.querySelectorAll(".mf-btn").forEach(x =>
      x.classList.toggle("active", x === b));
    const target = dirByKind[mediaFilter];
    if (target && target !== browseDir) browse(target).catch(() => renderGrid());
    else renderGrid();
  };
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
  item("Mover…", "", () => moveFile(path, name));
  item("Deletar", "danger", () => deleteFile(path, name));
  document.body.appendChild(menu);
  // posiciona no cursor sem transbordar a janela
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(e.clientX, innerWidth - r.width - 6) + "px";
  menu.style.top = Math.min(e.clientY, innerHeight - r.height - 6) + "px";
  ctxMenu = menu;
}

// renomear/deletar quebrariam a edição se o arquivo estiver na timeline
const fileInTimeline = (path) => state.segments.some(s => !s.deleted && s.src === path);

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

async function moveFile(path, name) {
  if (fileInTimeline(path))
    return alert("Este arquivo está na timeline. Remova-o da edição antes de mover.");
  let picked;
  try {
    picked = await api("/api/pick-dir?title=" +
      encodeURIComponent(`Mover "${name}" para…`));
  } catch (e) { return alert("Erro ao escolher a pasta: " + e.message); }
  if (picked.cancelled) return;               // fechou o seletor
  try {
    const r = await api("/api/file-move", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, destDir: picked.path }),
    });
    forgetFile(path, r.path);                  // saiu da pasta atual → some do grid
    await browse(browseDir);
  } catch (e) { alert("Erro ao mover: " + e.message); }
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
    const railW = $("rail").offsetWidth;   // painel começa depois do rail
    const move = (ev) => {
      w = Math.min(Math.max(ev.clientX - railW, MIN_W), Math.round(window.innerWidth * 0.6));
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

// rail: cada aba mostra sua view no painel lateral; clicar na aba já ativa
// recolhe/mostra o painel inteiro
for (const btn of document.querySelectorAll(".rail-btn")) {
  btn.onclick = () => {
    const wasActive = btn.classList.contains("active");
    if (wasActive) {
      document.body.classList.toggle("no-side");
      return;
    }
    document.body.classList.remove("no-side");
    document.querySelectorAll(".rail-btn").forEach(b => b.classList.toggle("active", b === btn));
    document.querySelectorAll(".side-view").forEach(v =>
      v.classList.toggle("hidden", v.id !== btn.dataset.view));
  };
}

// ---------- fundo do app (aba "Fundo" no rail) ----------
// só troca a aparência do editor (não entra no vídeo); persistido em
// localStorage e aplicado via a custom property --bg-image (body no CSS)
function applyBgImage(name) {
  document.body.style.setProperty("--bg-image", `url("/icons/${name}")`);
  for (const el of document.querySelectorAll("#bg-grid .bg-thumb"))
    el.classList.toggle("selected", el.dataset.name === name);
}
(async () => {
  let names;
  try { ({ backgrounds: names } = await api("/api/backgrounds")); }
  catch { return; }   // painel fica vazio se a listagem falhar; resto do app não é afetado
  if (!names.length) return;
  const saved = localStorage.getItem("bgImage");
  const current = names.includes(saved) ? saved : names[0];
  const grid = $("bg-grid");
  for (const name of names) {
    const btn = document.createElement("button");
    btn.className = "bg-thumb";
    btn.dataset.name = name;
    btn.title = name;
    const img = document.createElement("img");
    img.src = "/icons/" + name;
    img.loading = "lazy";
    btn.appendChild(img);
    btn.onclick = () => { localStorage.setItem("bgImage", name); applyBgImage(name); };
    grid.appendChild(btn);
  }
  applyBgImage(current);
})();

// painel de propriedades redimensionável pela borda esquerda (como o lateral)
{
  const MIN_W = 220;
  const setW = (w) => document.body.style.setProperty("--props-w-user", w + "px");
  const saved = parseInt(localStorage.getItem("propsWidth"), 10);
  if (saved) setW(Math.max(MIN_W, saved));
  const rz = $("props-resizer");
  rz.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    rz.setPointerCapture(e.pointerId);
    rz.classList.add("dragging");
    let w = 0;
    const move = (ev) => {
      w = Math.min(Math.max(window.innerWidth - ev.clientX, MIN_W),
                   Math.round(window.innerWidth * 0.45));
      setW(w);
    };
    const up = () => {
      rz.classList.remove("dragging");
      rz.removeEventListener("pointermove", move);
      rz.removeEventListener("pointerup", up);
      if (w) localStorage.setItem("propsWidth", w);
    };
    rz.addEventListener("pointermove", move);
    rz.addEventListener("pointerup", up);
  });
  rz.addEventListener("dblclick", () => {
    document.body.style.removeProperty("--props-w-user");
    localStorage.removeItem("propsWidth");
  });
}

// painel da timeline redimensionável pela borda superior
{
  const MIN_H = 120;
  const maxH = () => Math.round(window.innerHeight * 0.6);
  const setH = (h) => document.body.style.setProperty("--bottom-h", h + "px");
  const saved = parseInt(localStorage.getItem("bottomHeight"), 10);
  if (saved) setH(Math.min(Math.max(saved, MIN_H), maxH()));
  const rz = $("bottom-resizer");
  rz.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    rz.setPointerCapture(e.pointerId);
    rz.classList.add("dragging");
    let h = 0;
    const move = (ev) => {
      h = Math.min(Math.max(window.innerHeight - ev.clientY, MIN_H), maxH());
      setH(h);
    };
    const up = () => {
      rz.classList.remove("dragging");
      rz.removeEventListener("pointermove", move);
      rz.removeEventListener("pointerup", up);
      if (h) localStorage.setItem("bottomHeight", h);
    };
    rz.addEventListener("pointermove", move);
    rz.addEventListener("pointerup", up);
  });
  rz.addEventListener("dblclick", () => {
    document.body.style.removeProperty("--bottom-h");
    localStorage.removeItem("bottomHeight");
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
  $("player-wrap").classList.remove("showing-image");  // sai da prévia de imagem
  $("player-wrap").classList.add("has-video");
  switchPlayerTo(path, 0);
}

// pré-visualização de imagem: mostra o arquivo sobre a área do player (só com a
// timeline vazia, para não sobrepor uma edição em curso). Imagens não vão para a
// timeline por enquanto — a aba serve para navegar e visualizar.
function previewImage(path) {
  if (hasContent()) return;
  $("img-preview").src = "/api/media?path=" + encodeURIComponent(path);
  $("player-wrap").classList.remove("has-video");
  $("player-wrap").classList.add("showing-image");
  $("file-info").textContent = basename(path) + " — imagem (pré-visualização)";
}

async function appendOne(path) {
  const s = await ensureSource(path);
  if (!s) return;
  const dur = s.info.duration || 0;
  if (dur <= 0) {
    $("file-info").textContent = basename(path) + " — duração desconhecida, não adicionado";
    return;
  }
  if (!s.info.video) {   // áudio puro não tem trilha própria na timeline de vídeo (ainda)
    $("file-info").textContent = basename(path) +
      " — arquivo de áudio ainda não pode ser adicionado à timeline de vídeo";
    return;
  }
  const first = state.segments.length === 0;
  $("player-wrap").classList.remove("showing-image");
  $("player-wrap").classList.add("has-video");
  activeTrack = "video";              // adicionar vídeo torna a faixa de vídeo ativa
  apply(st => st.segments.push(
    { src: path, start: 0, end: dur, deleted: false, speed: 1, volume: 1, opacity: 1, gap: 0, hue: nextHue() }));
  tlView = 0;   // ancora a borda esquerda da timeline à tela sempre que uma faixa entra
  if (first || !activeSrc) {           // primeiro conteúdo: carrega no player
    tlZoom = 1;
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

// ---------- relógio de reprodução SEM vídeo (projeto só de áudio) ----------
// Sem um <video> não há timeupdate para mover o playhead; um relógio próprio
// baseado em requestAnimationFrame avança o tempo visível `noVidT`.
let noVidT = 0;            // posição visível do playhead quando não há vídeo
let noVidPlaying = false;
let noVidAnchorMs = 0, noVidAnchorT = 0;
// true quando o playhead está ALÉM do fim da faixa de vídeo (há vídeo, mas a
// trilha de áudio/imagem se estende mais — a agulha continua livre pelo
// relógio próprio nesse trecho, com o vídeo pausado/coberto pelo overlay preto)
let inTail = false;
function noVidTick() {
  if (!noVidPlaying) return;
  noVidT = noVidAnchorT + (performance.now() - noVidAnchorMs) / 1000;
  if (noVidT >= timelineDur()) { noVidT = timelineDur(); noVidPlaying = false; }
  drawTimeline();
  if (noVidPlaying) requestAnimationFrame(noVidTick);
}
function noVidPlay() {
  if (noVidT >= timelineDur() - 1e-3) {
    scrubToVisible(0);   // reinicia do começo — decide sozinho se é vídeo ou trecho livre
    playPlayback();
    return;
  }
  noVidPlaying = true;
  noVidAnchorMs = performance.now(); noVidAnchorT = noVidT;
  requestAnimationFrame(noVidTick);
}
function noVidPause() { noVidPlaying = false; drawTimeline(); }
function noVidSeek(t) {
  noVidT = Math.max(0, Math.min(t, timelineDur()));
  if (noVidPlaying) { noVidAnchorMs = performance.now(); noVidAnchorT = noVidT; }
  drawTimeline();
}
// controles unificados: roteiam para o <video> ou para o relógio livre —
// este último também toca o trecho além do fim do vídeo (inTail)
const usesFreeClock = () => !hasVideo() || inTail;
const isPlaying = () => usesFreeClock() ? noVidPlaying : !player.paused;
function pausePlayback() { usesFreeClock() ? noVidPause() : player.pause(); }
function playPlayback() { usesFreeClock() ? noVidPlay() : player.play(); }
function togglePlay() { isPlaying() ? pausePlayback() : playPlayback(); updatePlayButton(); }

// botão de Play/Pausa próprio: funciona com qualquer combinação de faixas
// (vídeo/áudio/imagem), ao contrário dos controles nativos do <video> (que só
// existem quando há um vídeo carregado de verdade)
const PLAY_ICON = `<img src="/icons/play.svg" alt="">`;
const PAUSE_ICON = `<img src="/icons/pause.svg" alt="">`;
// só mexe no DOM quando o estado realmente muda: chamada a ~60fps durante a
// reprodução (relógio livre/noVidTick), reescrever innerHTML sem necessidade
// recria o ícone sob o cursor a cada quadro e pode ENGOLIR o clique do mouse
// no meio do gesto (mousedown→mouseup) — o Espaço não é afetado por não
// depender de hit-testing do ponteiro, daí Pausar só "funcionar" pelo teclado.
let playBtnState = null;
function updatePlayButton() {
  const btn = $("btn-play");
  const disabled = !hasContent();
  const playing = !disabled && isPlaying();
  const key = disabled + ":" + playing;
  if (key === playBtnState) return;
  playBtnState = key;
  btn.disabled = disabled;
  btn.title = playing ? "Pausar (Espaço)" : "Tocar (Espaço)";
  btn.classList.toggle("playing", playing);
  btn.innerHTML = (playing ? PAUSE_ICON : PLAY_ICON) + (playing ? "Pausar" : "Tocar");
}
$("btn-play").onclick = togglePlay;

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
// duração NA TIMELINE de um clipe de áudio: o trecho de origem (end-start)
// encolhe/estica com a velocidade, igual ao segmento de vídeo (segVis)
const audioVis = (c) => (c.end - c.start) / (c.speed || 1);
// fim (em tempo visível) do clipe de áudio mais distante; 0 se não há trilha
function maxAudioEnd() {
  let m = 0;
  for (const c of state.audioTrack) m = Math.max(m, c.at + audioVis(c));
  return m;
}
// fim da imagem mais distante (mesma ideia)
function maxImageEnd() {
  let m = 0;
  for (const c of state.imageTrack) m = Math.max(m, c.at + c.duration);
  return m;
}
// DURAÇÃO DO PROJETO: o maior entre a faixa de vídeo (animDur), a trilha de
// áudio e as imagens. A régua e toda a escala se baseiam nela — cada faixa
// ocupa (sua duração / esta) da largura, então só a mais longa preenche 100%.
const timelineDur = () => Math.max(animDur, maxAudioEnd(), maxImageEnd());
const tlSpan = () => timelineDur() / tlZoom;   // segundos visíveis no viewport
const tlMaxZoom = () => Math.max(1, timelineDur() / TL_MIN_SPAN);
function clampView() {
  tlZoom = Math.max(TL_MIN_ZOOM, Math.min(tlMaxZoom(), tlZoom));
  const span = tlSpan();
  const td = timelineDur();
  // ampliado (span<dur): faixa [0, dur-span], desloca sobre o overflow.
  // encolhido (span>dur): faixa [dur-span, 0] (negativa), desliza o bloco pelo
  // espaço vazio. exatamente encaixado: 0.
  const lo = Math.min(0, td - span);
  const hi = Math.max(0, td - span);
  tlView = Math.max(lo, Math.min(hi, tlView));
}
// dá para arrastar sempre que o conteúdo não preenche exatamente o viewport
// (overflow com zoom in, ou espaço vazio com zoom out)
const tlCanPan = () => Math.abs(timelineDur() - tlSpan()) > 1e-6;
// registra o tempo-fonte que está no centro da visão, para reancorar a visão
// enquanto a timeline se compacta (evita a visão "fugir" durante a junção)
function capturePanAnchor() {
  panAnchorSrc = animDur > 0 ? visibleToSource(tlView + 0.5 * tlSpan()) : null;
}

// opacidade do vídeo no preview: sobre o fundo preto do player, CSS opacity
// reproduz a fusão para preto que o export aplica via filtro
function applyOpacity(op) {
  const v = op >= 0.999 ? "" : String(op);
  if (player.style.opacity !== v) player.style.opacity = v;
}
// aplica a opacidade do trecho sob o playhead mesmo pausado (scrub, seleção)
function syncScrubFx() {
  const i = keptIdxAt(activeSrc, player.currentTime);
  applyOpacity(i >= 0 ? (state.segments[i].opacity ?? 1) : 1);
}

// mostra os textos ativos no tempo visível vt sobre o player, espelhando o
// export: mesma âncora (h/12), mesma escala de fonte (altura/14) e fundo.
// Além dos 3 presets (topo/centro/base), o texto pode ser arrastado p/
// qualquer ponto (t.x/t.y, % do player) — quando presentes, sobrepõem `pos`.
function updateTextOverlay(vt) {
  const ov = $("text-overlay");
  const active = vt == null ? [] : state.texts.filter(t => vt >= t.start && vt <= t.end);
  if (!active.length) { if (ov.firstChild) ov.textContent = ""; return; }
  const fs = Math.max(10, $("player-wrap").clientHeight / 14);
  // reconstrução simples: são pouquíssimos nós e só quando há texto ativo
  ov.textContent = "";
  for (const t of active) {
    const d = document.createElement("div");
    d.dataset.idx = String(state.texts.indexOf(t));
    d.style.fontSize = fs + "px";
    d.textContent = t.text;
    if (t.x != null && t.y != null) {
      d.className = "tx free";
      d.style.left = t.x + "%";
      d.style.top = t.y + "%";
    } else {
      d.className = "tx pos-" + (t.pos || "bottom");
    }
    ov.appendChild(d);
  }
}

// arraste livre de um texto no preview: pega qualquer .tx visível (a área
// vazia do overlay continua com pointer-events:none, então não atrapalha o
// scrub/clique do player) e move em % do player-wrap. Escuta no CONTAINER
// (estável) em vez do próprio .tx (recriado a cada updateTextOverlay), então
// sobrevive a redraws no meio do gesto (ex.: arrastar durante a reprodução).
$("text-overlay").addEventListener("pointerdown", (e) => {
  const el = e.target.closest(".tx");
  if (!el) return;
  const idx = parseInt(el.dataset.idx, 10);
  const wrap = $("player-wrap").getBoundingClientRect();
  const r = el.getBoundingClientRect();
  textDrag = {
    idx,
    startX: e.clientX, startY: e.clientY,
    // ponto de partida em %: centro do texto tal como está renderizado agora
    // (preset ou já livre) — assim o arraste não "pula" no primeiro movimento
    origX: ((r.left + r.width / 2 - wrap.left) / wrap.width) * 100,
    origY: ((r.top + r.height / 2 - wrap.top) / wrap.height) * 100,
    hist: false,
  };
  $("text-overlay").setPointerCapture(e.pointerId);
  e.preventDefault();
});
$("text-overlay").addEventListener("pointermove", (e) => {
  if (!textDrag) return;
  const wrap = $("player-wrap").getBoundingClientRect();
  const dxPct = ((e.clientX - textDrag.startX) / wrap.width) * 100;
  const dyPct = ((e.clientY - textDrag.startY) / wrap.height) * 100;
  if (!textDrag.hist && (Math.abs(dxPct) > 0.3 || Math.abs(dyPct) > 0.3)) {
    history.past.push(JSON.stringify(state));
    if (history.past.length > MAX_HISTORY) history.past.shift();
    history.future = []; textDrag.hist = true;
  }
  const t = state.texts[textDrag.idx];
  if (!t) return;
  t.x = Math.max(0, Math.min(100, textDrag.origX + dxPct));
  t.y = Math.max(0, Math.min(100, textDrag.origY + dyPct));
  updateTextOverlay(currentVis());
});
function endTextDrag(e) {
  if (!textDrag) return;
  $("text-overlay").releasePointerCapture(e.pointerId);
  const moved = textDrag.hist;
  textDrag = null;
  if (moved) renderState();   // sincroniza o painel (dropdown de posição vira "Livre")
}
$("text-overlay").addEventListener("pointerup", endTextDrag);
$("text-overlay").addEventListener("pointercancel", endTextDrag);

// índice do clipe de áudio da lane `lane` no tempo visível vt (-1 se nenhum)
function audioIdxAtVisible(vt, lane) {
  for (let i = 0; i < state.audioTrack.length; i++) {
    const c = state.audioTrack[i];
    if ((c.track || 0) === lane && vt >= c.at && vt <= c.at + audioVis(c)) return i;
  }
  return -1;
}

// encaixe magnético: ao arrastar o clipe `movingIdx` para a posição `at`, se
// uma de suas bordas chegar a menos de SNAP_PX px da borda de outro clipe (ou
// do início 0), encosta exatamente nela. Devolve o `at` ajustado.
const SNAP_PX = 8;
function snapAudioAt(at, movingIdx) {
  const c = state.audioTrack[movingIdx];
  const len = audioVis(c);
  const thresh = SNAP_PX * (tlSpan() / Math.max(1, canvas.clientWidth));  // px → s
  const targets = [0];                              // início da timeline
  state.audioTrack.forEach((o, j) => {              // só encaixa em clipes da MESMA lane
    if (j !== movingIdx && (o.track || 0) === (c.track || 0))
      targets.push(o.at, o.at + audioVis(o));
  });
  let bestAt = at, bestDist = thresh;
  for (const t of targets) {
    let d = Math.abs(at - t);                        // borda esquerda encosta em t
    if (d < bestDist) { bestDist = d; bestAt = t; }
    d = Math.abs((at + len) - t);                    // borda direita encosta em t
    if (d < bestDist) { bestDist = d; bestAt = t - len; }
  }
  return Math.max(0, bestAt);
}

// pool de elementos <audio>, um por lane (várias trilhas tocam simultâneas)
const audioEls = [];
function audioEl(lane) {
  if (!audioEls[lane]) {
    const a = document.createElement("audio");
    a.style.display = "none";
    document.body.appendChild(a);
    audioEls[lane] = a;
  }
  return audioEls[lane];
}
function pauseAllAudioEls() { for (const a of audioEls) if (a && !a.paused) a.pause(); }

// ---------- trilhas de imagem ──
// nº de faixas existentes (vídeo conta como 1, se houver + cada lane de áudio/imagem)
const trackCount = () => (keptSegs().length > 0 ? 1 : 0) + audioLaneCount() + imageLaneCount();
// altura (px CSS) de UMA faixa: espaço abaixo da régua dividido em partes IGUAIS
// entre todas as faixas existentes — recalculada a cada chamada, então se ajusta
// em tempo real tanto ao redimensionar o painel quanto ao criar/remover faixas
function trackHeightCss() {
  const n = trackCount();
  return n > 0 ? (canvas.clientHeight - RULER_CSS_H) / n : 0;
}
// topo (px CSS) da área de mídia (áudio + imagem)
const mediaAreaTopCss = () => canvas.clientHeight - (audioLaneCount() + imageLaneCount()) * trackHeightCss();
// ponteiro está na área das lanes de mídia (áudio + imagem)?
const inMediaLane = (e) => (audioLaneCount() + imageLaneCount()) > 0 &&
  (e.clientY - canvas.getBoundingClientRect().top) >= mediaAreaTopCss();
// índice da lane (0..nAudio-1=áudio, nAudio..=imagem) sob o ponteiro
function mediaLaneAt(e) {
  const y = e.clientY - canvas.getBoundingClientRect().top - mediaAreaTopCss();
  return Math.max(0, Math.min(audioLaneCount() + imageLaneCount() - 1, Math.floor(y / trackHeightCss())));
}
// lane de ÁUDIO sob o ponteiro (arrastar p/ dentro da área de imagem prende
// na última lane de áudio — não cruza p/ o outro tipo de faixa)
function audioLaneAt(e) {
  const n = audioLaneCount();
  return n > 0 ? Math.max(0, Math.min(n - 1, mediaLaneAt(e))) : 0;
}
// lane de IMAGEM sob o ponteiro (mesma ideia, prende na 1ª lane de imagem
// se o ponteiro estiver na área de áudio)
function imageLaneAt(e) {
  const n = imageLaneCount();
  return n > 0 ? Math.max(0, Math.min(n - 1, mediaLaneAt(e) - audioLaneCount())) : 0;
}
// índice da imagem da lane `lane` no tempo visível vt (-1 se nenhuma)
function imageIdxAtVisible(vt, lane) {
  for (let i = 0; i < state.imageTrack.length; i++) {
    const c = state.imageTrack[i];
    if ((c.track || 0) === lane && vt >= c.at && vt <= c.at + c.duration) return i;
  }
  return -1;
}

// espelha o export: mostra sobre o player as imagens ativas no tempo visível.
// Reconciliação por chave (índice:src) para não recriar/re-baixar o <img> a
// cada frame do timeupdate.
function syncImageOverlay(vt) {
  const ov = $("image-overlay");
  const active = [];
  if (vt != null) state.imageTrack.forEach((c, i) => {
    if (vt >= c.at && vt < c.at + c.duration) active.push([i + ":" + c.src, c.opacity ?? 1]);
  });
  const wantKeys = active.map(([key]) => key);
  for (const el of [...ov.children])
    if (!wantKeys.includes(el.dataset.key)) el.remove();
  for (const [key, op] of active) {
    let img = [...ov.children].find(el => el.dataset.key === key);
    if (!img) {
      img = document.createElement("img");
      img.dataset.key = key;
      img.src = "/api/media?path=" + encodeURIComponent(key.slice(key.indexOf(":") + 1));
      ov.appendChild(img);
    }
    img.style.opacity = String(op);
  }
}

// encaixe magnético das imagens: início 0, bordas das outras imagens (qualquer
// lane), dos clipes de áudio e dos trechos de vídeo visíveis
function imageSnapTargets(movingIdx) {
  const targets = [0];
  state.imageTrack.forEach((o, j) => {
    if (j !== movingIdx) targets.push(o.at, o.at + o.duration);
  });
  for (const o of state.audioTrack) targets.push(o.at, o.at + audioVis(o));
  for (const s of keptSegs()) {
    const p = animPos.get(segKey(s)) ?? 0;
    targets.push(p, p + segVis(s));
  }
  return targets;
}
function snapImageAt(at, movingIdx) {
  const len = state.imageTrack[movingIdx].duration;
  const thresh = SNAP_PX * (tlSpan() / Math.max(1, canvas.clientWidth));  // px → s
  let bestAt = at, bestDist = thresh;
  for (const t of imageSnapTargets(movingIdx)) {
    let d = Math.abs(at - t);                        // borda esquerda encosta em t
    if (d < bestDist) { bestDist = d; bestAt = t; }
    d = Math.abs((at + len) - t);                    // borda direita encosta em t
    if (d < bestDist) { bestDist = d; bestAt = t - len; }
  }
  return Math.max(0, bestAt);
}
// encaixa uma borda isolada (usado ao aparar)
function snapImageEdge(t, movingIdx) {
  const thresh = SNAP_PX * (tlSpan() / Math.max(1, canvas.clientWidth));
  let best = t, bestDist = thresh;
  for (const tg of imageSnapTargets(movingIdx)) {
    const d = Math.abs(t - tg);
    if (d < bestDist) { bestDist = d; best = tg; }
  }
  return best;
}

// zona de aparar nas bordas do clipe de imagem: devolve "L"/"R" se o ponteiro
// está a até IMG_EDGE_PX px (CSS) de uma borda, senão null
const IMG_EDGE_PX = 6;
function imageEdgeAt(e, idx) {
  const rect = canvas.getBoundingClientRect();
  const c = state.imageTrack[idx];
  const scale = rect.width / tlSpan();               // px CSS por segundo
  const x = e.clientX - rect.left;
  const x0 = (c.at - tlView) * scale, x1 = (c.at + c.duration - tlView) * scale;
  if (Math.abs(x - x0) <= IMG_EDGE_PX) return "L";
  if (Math.abs(x - x1) <= IMG_EDGE_PX) return "R";
  return null;
}

// miniatura do arquivo de imagem para desenhar dentro do clipe na timeline
const tlThumbs = new Map();   // src -> { img, ready }
function tlThumb(src) {
  let t = tlThumbs.get(src);
  if (!t) {
    const img = new Image();
    t = { img, ready: false };
    img.onload = () => { t.ready = true; drawTimeline(); };
    img.src = "/api/thumb?path=" + encodeURIComponent(src);
    tlThumbs.set(src, t);
  }
  return t;
}

// adiciona um arquivo de imagem na posição visível `at`; cada arquivo entra numa FAIXA própria
async function addImageClip(path, at) {
  const s = await ensureSource(path);
  if (!s) return;
  const pos = Math.max(0, at ?? 0);
  const lane = imageLaneCount();       // nova lane para esta imagem
  const dur = 3;                       // duração padrão: 3 segundos
  const firstMedia = !hasContent();
  apply(st => st.imageTrack.push({ src: path, at: pos, duration: dur, opacity: 1, track: lane, hue: nextHue() }));
  selectedImage = state.imageTrack.length - 1;
  selectedSeg = null;
  selectedAudio = null;
  activeTrack = "image";
  tlView = 0;   // ancora a borda esquerda da timeline à tela sempre que uma faixa entra
  if (firstMedia) { tlZoom = 1; }
  renderState();
}

// mantém cada lane de áudio em sincronia com o playhead visível: em cada lane,
// toca o clipe ativo na posição certa. Espelha a mixagem que o export faz.
function syncAudioTrack(playVis) {
  const playing = gapHold != null ? true : isPlaying();
  const nAudio = audioLaneCount();
  for (let lane = 0; lane < nAudio; lane++) {
    const a = audioEl(lane);
    const c = playVis == null ? null : state.audioTrack.find(c =>
      (c.track || 0) === lane && playVis >= c.at && playVis < c.at + audioVis(c));
    if (!c) { if (!a.paused) a.pause(); continue; }
    if (a.dataset.src !== c.src) {
      a.src = "/api/media?path=" + encodeURIComponent(c.src);
      a.dataset.src = c.src;
    }
    a.volume = c.volume ?? 1;
    a.playbackRate = c.speed || 1;
    const want = c.start + (playVis - c.at) * (c.speed || 1);
    if (playing) {
      if (a.paused) a.play().catch(() => {});
      if (Math.abs(a.currentTime - want) > 0.3) { try { a.currentTime = want; } catch {} }
    } else {
      if (!a.paused) a.pause();
      if (Math.abs(a.currentTime - want) > 0.05) { try { a.currentTime = want; } catch {} }
    }
  }
  for (let lane = nAudio; lane < audioEls.length; lane++)
    if (audioEls[lane] && !audioEls[lane].paused) audioEls[lane].pause();
}

// adiciona um arquivo de áudio na posição visível `at`; cada arquivo arrastado
// entra numa FAIXA (lane) própria — não exige vídeo (pode iniciar o projeto)
async function addAudioClip(path, at) {
  const s = await ensureSource(path);
  if (!s) return;
  const dur = s.info.duration || 0;
  if (dur <= 0) return;
  const pos = Math.max(0, at ?? 0);           // livre; pode ser a mídia mais longa
  const lane = audioLaneCount();              // nova lane para este arquivo
  const firstMedia = !hasContent();
  apply(st => st.audioTrack.push(
    { src: path, start: 0, end: dur, at: pos, volume: 1, speed: 1, track: lane, hue: nextHue() }));
  selectedAudio = state.audioTrack.length - 1;
  selectedSeg = null;
  selectedImage = null;
  activeTrack = "audio";        // trabalhar no áudio recém-adicionado
  tlView = 0;   // ancora a borda esquerda da timeline à tela sempre que uma faixa entra
  if (firstMedia) { tlZoom = 1; }  // 1ª mídia: reancora também o zoom
  renderState();
}

function drawTimeline() {
  updatePlayButton();   // mantém o ícone em sincronia mesmo quando o play/pause
                        // vem de outro lugar (controles nativos, fim natural, tail)
  const dpr = devicePixelRatio;
  const w = canvas.width = canvas.clientWidth * dpr;
  const h = canvas.height = canvas.clientHeight * dpr;
  ctx.clearRect(0, 0, w, h);
  if (timelineDur() <= 0) { updateTextOverlay(null); syncImageOverlay(null); applyOpacity(1); return; }
  const kept = keptSegs();
  clampView();
  const scale = (w * tlZoom) / timelineDur(); // px por segundo (base = maior mídia)
  const sx = (vt) => (vt - tlView) * scale;  // tempo visível → x na tela (com pan)

  // geometria: régua no topo, faixa de vídeo (se houver) no meio, lanes de
  // áudio+imagem empilhadas embaixo (uma por arquivo arrastado) — TODAS as
  // faixas (vídeo + cada lane) dividem o espaço abaixo da régua em partes
  // iguais, recalculado a cada desenho (tempo real ao redimensionar o painel
  // ou ao entrar/sair uma faixa)
  const rulerH = RULER_CSS_H * dpr;
  const nAudio = audioLaneCount();
  const nImage = imageLaneCount();
  const hasVid = kept.length > 0;
  const nTracks = (hasVid ? 1 : 0) + nAudio + nImage;
  const trackH = nTracks > 0 ? (h - rulerH) / nTracks : 0;
  const mediaLaneH = trackH;
  const mediaAreaTop = h - (nAudio + nImage) * mediaLaneH;
  const segTop = rulerH, segH = trackH;

  let prevVisEnd = 0;
  for (const s of (hasVid ? kept : [])) {
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

  // ── lanes de áudio e imagem (embaixo), uma por faixa ──
  const audioActive = activeTrack === "audio";
  const imageActive = activeTrack === "image";
  // fundo das lanes
  for (let li = 0; li < nAudio + nImage; li++) {
    const laneTop = mediaAreaTop + li * mediaLaneH;
    const isAudioLane = li < nAudio;
    const isActive = isAudioLane ? audioActive : imageActive;
    ctx.fillStyle = isActive ? "rgba(122,92,240,.12)" : "rgba(255,255,255,.035)";
    ctx.fillRect(0, laneTop, w, mediaLaneH);
    ctx.fillStyle = isActive ? "#7a5cf0" : "rgba(255,255,255,.14)";
    ctx.fillRect(0, laneTop, w, (isActive ? 2 : 1) * dpr);
  }
  // clipes de áudio
  for (let i = 0; i < state.audioTrack.length; i++) {
    const c = state.audioTrack[i];
    const laneTop = mediaAreaTop + (c.track || 0) * mediaLaneH;
    const x0 = sx(c.at), wd = audioVis(c) * scale;
    const sel = i === selectedAudio;
    const hue = c.hue ?? 158;
    ctx.fillStyle = `hsla(${hue}, 60%, 45%, ${sel ? 0.92 : 0.62})`;
    ctx.fillRect(x0, laneTop + 3 * dpr, wd, mediaLaneH - 6 * dpr);
    if (sel) {
      ctx.strokeStyle = "rgba(255,255,255,.92)"; ctx.lineWidth = 2 * dpr;
      ctx.strokeRect(x0 + 1, laneTop + 3 * dpr + 1, wd - 2, mediaLaneH - 6 * dpr - 2);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, laneTop, wd, mediaLaneH); ctx.clip();
    ctx.fillStyle = "#eafff6"; ctx.font = `${9.5 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    const alabel = "🎵 " + basename(c.src) + (c.speed && c.speed !== 1 ? ` (${c.speed}x)` : "");
    ctx.fillText(alabel, x0 + 5 * dpr, laneTop + mediaLaneH / 2);
    ctx.restore();
  }
  // clipes de imagem: a própria imagem ladrilhada dentro do clipe (fallback:
  // bloco na cor do clipe enquanto a miniatura carrega)
  for (let i = 0; i < state.imageTrack.length; i++) {
    const c = state.imageTrack[i];
    const laneTop = mediaAreaTop + (nAudio + (c.track || 0)) * mediaLaneH;
    const x0 = sx(c.at), wd = c.duration * scale;
    const y0 = laneTop + 3 * dpr, hh = mediaLaneH - 6 * dpr;
    const sel = i === selectedImage;
    const hue = c.hue ?? 45;
    const th = tlThumb(c.src);
    if (th.ready && th.img.height > 0) {
      ctx.save();
      ctx.beginPath(); ctx.rect(x0, y0, wd, hh); ctx.clip();
      ctx.fillStyle = "#000";
      ctx.fillRect(x0, y0, wd, hh);
      const tw = Math.max(2 * dpr, hh * (th.img.width / th.img.height));
      for (let x = x0; x < x0 + wd; x += tw) ctx.drawImage(th.img, x, y0, tw, hh);
      ctx.restore();
      ctx.strokeStyle = sel ? "rgba(255,255,255,.92)" : `hsla(${hue}, 70%, 60%, .8)`;
      ctx.lineWidth = sel ? 2 * dpr : dpr;
      ctx.strokeRect(x0 + 1, y0 + 1, wd - 2, hh - 2);
    } else {
      ctx.fillStyle = `hsla(${hue}, 70%, 55%, ${sel ? 0.92 : 0.62})`;
      ctx.fillRect(x0, y0, wd, hh);
      if (sel) {
        ctx.strokeStyle = "rgba(255,255,255,.92)"; ctx.lineWidth = 2 * dpr;
        ctx.strokeRect(x0 + 1, y0 + 1, wd - 2, hh - 2);
      }
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(x0, laneTop, wd, mediaLaneH); ctx.clip();
    ctx.fillStyle = "#fffaed"; ctx.font = `${9.5 * dpr}px system-ui, sans-serif`;
    ctx.textBaseline = "middle";
    ctx.shadowColor = "rgba(0,0,0,.9)"; ctx.shadowBlur = 3 * dpr;  // legível sobre a miniatura
    ctx.fillText("🖼 " + basename(c.src), x0 + 5 * dpr, laneTop + mediaLaneH / 2);
    ctx.restore();
  }

  drawRuler(w, h, rulerH, scale);

  // cursor de reprodução: com vídeo segue o <video>; além do fim dele (inTail)
  // ou sem vídeo, o relógio próprio
  const playVis = inTail ? noVidT
    : gapVisible != null ? gapVisible
    : hasVid ? sourceToVisible(activeSrc, player.currentTime) : noVidT;
  updateTextOverlay(playVis);           // textos do preview seguem o playhead
  syncScrubFx();                        // opacidade também vale parado/no scrub
  syncAudioTrack(playVis);              // trilha de áudio segue o playhead
  syncImageOverlay(playVis);            // imagens da timeline aparecem no preview
  const cx = sx(playVis);
  ctx.fillStyle = "#b7a8ff";
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
  ctx.fillStyle = "#b7a8ff";
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
  const tEnd = Math.min(tlView + span, timelineDur());
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
// arraste de clipe de áudio na lane inferior (muda só o campo `at`)
let audioMoving = false, audioMoveIdx = -1, audioMoveBaseX = 0, audioMoveOrigAt = 0, audioMoveHist = false;
// arraste de clipe de imagem na lane (muda só o campo `at`)
let imageMoving = false, imageMoveIdx = -1, imageMoveBaseX = 0, imageMoveOrigAt = 0, imageMoveHist = false;
// aparar borda de clipe de imagem: {idx, edge:"L"|"R", origAt, origDur, baseX, span0, hist}
let imageTrim = null;
const IMG_MIN_DUR = 0.5;   // duração mínima de uma imagem ao aparar (s)
// arraste livre de um texto sobre o player: {idx, startX, startY, origX, origY, hist}
let textDrag = null;
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

// bordas (tempo visível) de TODOS os clipes de qualquer faixa — vídeo, áudio
// e imagem — usadas para o encaixe magnético da AGULHA ao raspar/arrastar
function allTrackEdges() {
  const edges = [0, timelineDur()];
  for (const s of keptSegs()) {
    const p = animPos.get(segKey(s)) ?? 0;
    edges.push(p, p + segVis(s));
  }
  for (const c of state.audioTrack) edges.push(c.at, c.at + audioVis(c));
  for (const c of state.imageTrack) edges.push(c.at, c.at + c.duration);
  return edges;
}
// encaixa a posição da agulha na borda mais próxima (de qualquer faixa), se
// estiver a menos de SNAP_PX px dela
function snapNeedleAt(vt) {
  const thresh = SNAP_PX * (tlSpan() / Math.max(1, canvas.clientWidth));
  let best = vt, bestDist = thresh;
  for (const t of allTrackEdges()) {
    const d = Math.abs(vt - t);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

// raspagem ciente de lacuna: se o ponteiro cai numa lacuna, mostra preto e
// estaciona o vídeo no início do próximo trecho (frame atrás do overlay).
// Além do fim da faixa de vídeo (trecho só com áudio/imagem), a agulha segue
// livre pelo relógio próprio (inTail) — não fica mais presa ao comprimento do vídeo.
// A posição também encaixa (snap) nas bordas de qualquer clipe de qualquer faixa.
function scrubToVisible(vt) {
  vt = snapNeedleAt(vt);
  const tail = hasVideo() && vt > animDur + 1e-6;
  if (!hasVideo() || tail) {
    inTail = tail;
    if (hasVideo()) {
      if (!player.paused) player.pause();
      setGapOverlay(true);
    }
    gapVisible = null;
    noVidSeek(vt);
    return;
  }
  inTail = false;
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
  selectedAudio = null;                // selecionar vídeo desmarca o clipe de áudio
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

// posição em tela (px CSS) da agulha (playhead) agora mesmo
const NEEDLE_GRAB_PX = 6;
function needleScreenX() {
  const rect = canvas.getBoundingClientRect();
  return rect.left + (currentVis() - tlView) * (rect.width / tlSpan());
}
// true se o ponteiro está perto o bastante da agulha para agarrá-la — isso tem
// PRIORIDADE sobre mover um clipe/faixa, permitindo raspar livremente por toda
// a timeline (mesmo em cima de um clipe selecionado, cuja área normalmente
// arrastaria o próprio clipe para abrir lacuna)
const nearNeedle = (e) => timelineDur() > 0 && Math.abs(e.clientX - needleScreenX()) <= NEEDLE_GRAB_PX;

canvas.addEventListener("pointerdown", (e) => {
  if (timelineDur() <= 0) return;
  canvas.setPointerCapture(e.pointerId);
  downX = e.clientX;
  dragMoved = false;
  // agarrar a agulha tem prioridade: raspa livremente por qualquer faixa,
  // mesmo sobre um clipe selecionado (senão arrastaria o clipe, não a agulha)
  if (!onRuler(e) && nearNeedle(e)) {
    scrubbing = true;
    wasPlaying = isPlaying();
    pausePlayback();
    if (inMediaLane(e)) {
      selectedAudio = null; selectedSeg = null; selectedImage = null;
      scrubToVisible(visibleAtEvent(e));
      renderState();
    } else {
      seekAndSelect(e);   // já chama scrubToVisible + renderState
    }
    canvas.style.cursor = "ew-resize";
    return;
  }
  // lanes de áudio+imagem: descubra qual tipo pela posição dentro da área de mídia
  if (inMediaLane(e)) {
    const lane = mediaLaneAt(e);
    const nAudio = audioLaneCount();
    // lane < nAudio = áudio, senão = imagem
    if (lane < nAudio) {
      activeTrack = "audio";
      const ai = audioIdxAtVisible(visibleAtEvent(e), lane);
      if (ai !== -1) {
        audioMoving = true; audioMoveIdx = ai; audioMoveBaseX = e.clientX;
        audioMoveOrigAt = state.audioTrack[ai].at; audioMoveHist = false;
        selectedAudio = ai; selectedSeg = null; selectedImage = null;
        canvas.style.cursor = "grabbing";
        renderState();
        return;
      }
      selectedAudio = null; selectedSeg = null; selectedImage = null;
      scrubbing = true; wasPlaying = isPlaying(); pausePlayback();
      scrubToVisible(visibleAtEvent(e)); renderState();
      return;
    } else {
      activeTrack = "image";
      const ii = imageIdxAtVisible(visibleAtEvent(e), lane - nAudio);
      if (ii !== -1) {
        const edge = imageEdgeAt(e, ii);
        if (edge) {          // perto da borda: aparar (muda a duração) em vez de mover
          imageTrim = { idx: ii, edge, origAt: state.imageTrack[ii].at,
                        origDur: state.imageTrack[ii].duration,
                        baseX: e.clientX, span0: tlSpan(), hist: false };
          selectedImage = ii; selectedSeg = null; selectedAudio = null;
          canvas.style.cursor = "col-resize";
          renderState();
          return;
        }
        imageMoving = true; imageMoveIdx = ii; imageMoveBaseX = e.clientX;
        imageMoveOrigAt = state.imageTrack[ii].at; imageMoveHist = false;
        selectedImage = ii; selectedSeg = null; selectedAudio = null;
        canvas.style.cursor = "grabbing";
        renderState();
        return;
      }
      selectedImage = null; selectedSeg = null; selectedAudio = null;
      scrubbing = true; wasPlaying = isPlaying(); pausePlayback();
      scrubToVisible(visibleAtEvent(e)); renderState();
      return;
    }
  }
  activeTrack = "video";
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
    wasPlaying = isPlaying();
    pausePlayback();
    seekAndSelect(e);
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (audioMoving) {
    if (Math.abs(e.clientX - downX) > 3) dragMoved = true;
    if (dragMoved && !audioMoveHist) {   // 1ª movimentação: 1 passo de undo
      history.past.push(JSON.stringify(state));
      if (history.past.length > MAX_HISTORY) history.past.shift();
      history.future = []; audioMoveHist = true;
    }
    const rect = canvas.getBoundingClientRect();
    const dSec = (e.clientX - audioMoveBaseX) / rect.width * tlSpan();
    const c = state.audioTrack[audioMoveIdx];
    // muda de lane ANTES de arredondar/encaixar `at`, p/ o snap já considerar
    // os vizinhos da lane de destino (arraste diagonal: horizontal + vertical)
    if (inMediaLane(e)) c.track = audioLaneAt(e);
    c.at = snapAudioAt(Math.max(0, audioMoveOrigAt + dSec), audioMoveIdx);
    clampView();
    drawTimeline();
    return;
  }
  if (imageMoving) {
    if (Math.abs(e.clientX - downX) > 3) dragMoved = true;
    if (dragMoved && !imageMoveHist) {   // 1ª movimentação: 1 passo de undo
      history.past.push(JSON.stringify(state));
      if (history.past.length > MAX_HISTORY) history.past.shift();
      history.future = []; imageMoveHist = true;
    }
    const rect = canvas.getBoundingClientRect();
    const dSec = (e.clientX - imageMoveBaseX) / rect.width * tlSpan();
    const c = state.imageTrack[imageMoveIdx];
    if (inMediaLane(e)) c.track = imageLaneAt(e);
    c.at = snapImageAt(Math.max(0, imageMoveOrigAt + dSec), imageMoveIdx);
    clampView();
    drawTimeline();
    return;
  }
  if (imageTrim) {
    if (Math.abs(e.clientX - downX) > 3) dragMoved = true;
    if (dragMoved && !imageTrim.hist) {   // 1ª movimentação: 1 passo de undo
      history.past.push(JSON.stringify(state));
      if (history.past.length > MAX_HISTORY) history.past.shift();
      history.future = []; imageTrim.hist = true;
    }
    const rect = canvas.getBoundingClientRect();
    // span fixado no início do gesto: aparar a borda direita estica a timeline
    // e um span vivo faria a escala mudar sob o cursor
    const dSec = (e.clientX - imageTrim.baseX) / rect.width * imageTrim.span0;
    const c = state.imageTrack[imageTrim.idx];
    if (imageTrim.edge === "L") {
      const end = imageTrim.origAt + imageTrim.origDur;
      let at = snapImageEdge(imageTrim.origAt + dSec, imageTrim.idx);
      at = Math.max(0, Math.min(at, end - IMG_MIN_DUR));
      c.at = at; c.duration = end - at;
    } else {
      const end = snapImageEdge(imageTrim.origAt + imageTrim.origDur + dSec, imageTrim.idx);
      c.duration = Math.max(IMG_MIN_DUR, end - imageTrim.origAt);
    }
    clampView();
    drawTimeline();
    return;
  }
  if (!panning && !scrubbing && !segMoving) {   // hover: cursor por zona
    if (!onRuler(e) && nearNeedle(e)) { canvas.style.cursor = "ew-resize"; return; }
    if (inMediaLane(e)) {
      const lane = mediaLaneAt(e);
      const nAudio = audioLaneCount();
      if (lane < nAudio) {
        canvas.style.cursor =
          audioIdxAtVisible(visibleAtEvent(e), lane) !== -1 ? "grab" : "crosshair";
      } else {
        const ii = imageIdxAtVisible(visibleAtEvent(e), lane - nAudio);
        canvas.style.cursor = ii === -1 ? "crosshair"
          : imageEdgeAt(e, ii) ? "col-resize" : "grab";
      }
      return;
    }
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
    tlZoom = timelineDur() / segMoveSpan0;
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
  if (audioMoving) {
    audioMoving = false;
    canvas.style.cursor = "grab";
    if (dragMoved) renderState();
    return;
  }
  if (imageMoving) {
    imageMoving = false;
    canvas.style.cursor = "grab";
    if (dragMoved) renderState();
    return;
  }
  if (imageTrim) {
    imageTrim = null;
    canvas.style.cursor = "col-resize";
    if (dragMoved) renderState();   // atualiza o slider de duração no painel
    return;
  }
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
    if (wasPlaying) playPlayback();
  }
});

// roda do mouse amplia/reduz ancorando a borda ESQUERDA da tela (tlView não
// se move por causa do zoom — só clampView() pode ajustá-lo se sair do range)
canvas.addEventListener("wheel", (e) => {
  if (timelineDur() <= 0) return;
  e.preventDefault();
  tlZoom = Math.max(TL_MIN_ZOOM, Math.min(tlMaxZoom(), tlZoom * (e.deltaY < 0 ? 1.25 : 1 / 1.25)));
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
  const kind = dragKind; dragKind = null;
  if (!path) return;
  if (path.toLowerCase().endsWith(".evp")) return loadProject(path);
  const rect = canvas.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const at = timelineDur() > 0 ? tlView + frac * tlSpan() : 0;
  if (kind === "audio") return addAudioClip(path, at);
  if (kind === "image") return addImageClip(path, at);
  addToTimeline(path);
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
  const vol = seg.volume ?? 1;          // …e o volume por segmento
  if (player.volume !== vol) player.volume = vol;
  applyOpacity(seg.opacity ?? 1);       // fusão para preto (fundo do player é preto)
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
  if (!gapHold && !inTail) { gapVisible = null; setGapOverlay(false); }
  drawTimeline();
});
// arquivo chegou ao fim: se o trecho tem sucessor na timeline, continua nele;
// se não há sucessor mas a trilha de áudio/imagem se estende além do vídeo,
// a reprodução continua nesse trecho pelo relógio livre (inTail)
onPlayerEvent("ended", () => {
  if (state.segments.length && jumpPastEnd(player.currentTime)) { player.play(); return; }
  if (timelineDur() > animDur + 1e-6) {
    inTail = true;
    setGapOverlay(true);
    noVidT = animDur;
    noVidPlaying = true;
    noVidAnchorMs = performance.now(); noVidAnchorT = noVidT;
    requestAnimationFrame(noVidTick);
  }
});

// ---------- corte / deleção / exportação ----------
// tempo VISÍVEL do playhead (compactado; além do fim do vídeo ou numa lacuna
// usa o playhead virtual; sem vídeo, o relógio próprio)
const currentVis = () =>
  inTail ? noVidT
  : gapVisible != null ? gapVisible
  : hasVideo() ? sourceToVisible(activeSrc, player.currentTime) : noVidT;

function doCut() {
  if (activeTrack === "audio") return doCutAudio();
  if (activeTrack === "image") return doCutImage();
  const t = player.currentTime;   // o playhead está sempre dentro do arquivo ativo
  const i = state.segments.findIndex(s =>
    s.src === activeSrc && !s.deleted && t > s.start + CUT_EPS && t < s.end - CUT_EPS);
  if (i < 0) return; // em cima de uma borda ou fora do trecho
  selectedSeg = null;
  apply(s => {
    const seg = s.segments[i];
    s.segments.splice(i, 1,
      { ...seg, end: t, gap: seg.gap || 0 },
      { ...seg, start: t, gap: 0, hue: nextHue() });
  });
}
// divide o clipe de áudio sob o playhead em dois (o ponto de corte na fonte
// leva a velocidade em conta: offset na fonte = offset visível × speed)
function doCutAudio() {
  const vt = currentVis();
  const i = state.audioTrack.findIndex(c =>
    vt > c.at + CUT_EPS && vt < c.at + audioVis(c) - CUT_EPS);
  if (i < 0) return;
  const c = state.audioTrack[i];
  const cut = c.start + (vt - c.at) * (c.speed || 1);
  selectedAudio = null;
  apply(s => {
    s.audioTrack.splice(i, 1,
      { ...c, end: cut },
      { ...c, start: cut, at: vt, hue: nextHue() });   // metade nova ganha cor própria
  });
}
// divide a imagem sob o playhead em duas: a 1ª mantém `at` e encolhe até o
// cursor, a 2ª começa no cursor e leva o restante da duração
function doCutImage() {
  const vt = currentVis();
  const i = state.imageTrack.findIndex(c =>
    vt > c.at + CUT_EPS && vt < c.at + c.duration - CUT_EPS);
  if (i < 0) return;
  const c = state.imageTrack[i];
  const cutDur = vt - c.at;
  selectedImage = null;
  apply(s => {
    s.imageTrack.splice(i, 1,
      { ...c, duration: cutDur },
      { ...c, at: vt, duration: c.duration - cutDur, hue: nextHue() });   // metade nova ganha cor própria
  });
}
function deleteSelected() {
  if (activeTrack === "image") {        // Excluir age só na faixa de imagem
    if (selectedImage == null) return;
    const i = selectedImage;
    selectedImage = null;
    apply(s => s.imageTrack.splice(i, 1));
    return;
  }
  if (activeTrack === "audio") {        // Excluir age só na faixa de áudio
    if (selectedAudio == null) return;
    const i = selectedAudio;
    selectedAudio = null;
    apply(s => s.audioTrack.splice(i, 1));
    return;
  }
  if (selectedSeg == null || state.segments[selectedSeg]?.deleted) return;
  const i = selectedSeg;
  selectedSeg = null;
  // era o único trecho aproveitado? apagá-lo deixaria a timeline só com lacunas
  // pretas, sem nada para editar. Remove só a FAIXA DE VÍDEO (preserva áudio/
  // imagem/textos/transição — resetEditor() zeraria tudo, o que apagaria
  // outras faixas que não têm nada a ver com este Excluir).
  if (keptSegs().length === 1) { clearVideoTrack(); return; }
  apply(s => { s.segments[i].deleted = true; });
}

// remove só a faixa de vídeo (usado ao excluir o último trecho restante),
// preservando áudio, imagem, textos e transição — diferente de resetEditor()
function clearVideoTrack() {
  apply(s => { s.segments = []; });
  activeSrc = null; wantTime = 0;
  inTail = false;
  for (const el of [player, backPlayer]) { el.pause(); el.removeAttribute("src"); el.load(); }
  $("player-wrap").classList.remove("has-video");
  $("file-info").textContent = "";
  activeTrack = state.audioTrack.length ? "audio" : state.imageTrack.length ? "image" : "video";
  updateActiveUI();
}

// volta ao estado inicial da edição — timeline, player, histórico, zoom/pan —
// como se a página tivesse sido recarregada. O navegador de arquivos fica onde
// está (um refresh de verdade voltaria à pasta inicial, mais atrapalha que ajuda).
function resetEditor() {
  state.segments = [];
  state.texts = [];
  state.transition = 0;
  state.audioTrack = [];
  state.imageTrack = [];
  pauseAllAudioEls();
  for (const a of audioEls) if (a) { a.removeAttribute("src"); delete a.dataset.src; }
  noVidPlaying = false; noVidT = 0; inTail = false;
  history.past = []; history.future = [];
  selectedSeg = null;
  selectedAudio = null;
  selectedImage = null;
  activeTrack = "video";
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

// sliders de ajuste: arrastar dá preview ao vivo; soltar grava no estado (undo)
const withSelected = (fn) => {
  if (selectedSeg == null || state.segments[selectedSeg]?.deleted) return;
  fn(selectedSeg);
};
$("seg-speed").oninput = () => {
  const sp = parseFloat($("seg-speed").value);
  $("seg-speed-val").textContent = sp + "x";
  // sensação imediata: no clipe de áudio ajusta o <audio> da lane, senão o player
  if (selectedAudio != null) audioEl(state.audioTrack[selectedAudio].track || 0).playbackRate = sp;
  else player.playbackRate = sp;
};
$("seg-speed").onchange = () => {
  if (selectedAudio != null) {
    const i = selectedAudio;
    apply(s => { s.audioTrack[i].speed = parseFloat($("seg-speed").value); });
    return;
  }
  setSpeedSelected();
};
$("seg-vol").oninput = () => {
  $("seg-vol-val").textContent = $("seg-vol").value + "%";
  const v = $("seg-vol").value / 100;
  // audição imediata: no clipe de áudio ajusta o <audio> da lane, senão o player
  if (selectedAudio != null) audioEl(state.audioTrack[selectedAudio].track || 0).volume = v;
  else player.volume = v;
};
$("seg-vol").onchange = () => {
  const v = parseInt($("seg-vol").value, 10) / 100;
  if (selectedAudio != null) {
    const i = selectedAudio;
    apply(s => { s.audioTrack[i].volume = v; });
    return;
  }
  withSelected(i => apply(s => { s.segments[i].volume = v; }));
};
$("seg-op").oninput = () => {
  $("seg-op-val").textContent = $("seg-op").value + "%";
  const v = $("seg-op").value / 100;
  // preview imediato: na imagem selecionada (se visível agora) ajusta o <img>, senão o player
  if (selectedImage != null) {
    const img = [...$("image-overlay").children]
      .find(el => el.dataset.key === selectedImage + ":" + state.imageTrack[selectedImage].src);
    if (img) img.style.opacity = String(v);
  } else applyOpacity(v);
};
$("seg-op").onchange = () => {
  const v = parseInt($("seg-op").value, 10) / 100;
  if (selectedImage != null) {
    const i = selectedImage;
    apply(s => { s.imageTrack[i].opacity = v; });
    return;
  }
  withSelected(i => apply(s => { s.segments[i].opacity = v; }));
};
$("btn-reset-adjust").onclick = () => {
  if (selectedAudio != null) {
    const i = selectedAudio;
    apply(s => Object.assign(s.audioTrack[i], { speed: 1, volume: 1 }));
    return;
  }
  if (selectedImage != null) {
    const i = selectedImage;
    apply(s => { s.imageTrack[i].opacity = 1; });
    return;
  }
  withSelected(i => apply(s => Object.assign(s.segments[i], { speed: 1, volume: 1, opacity: 1 })));
};

// ---------- textos sobre o vídeo ----------
$("btn-add-text").onclick = () => {
  if (!hasVideo()) { alert("Adicione um vídeo à timeline primeiro."); return; }
  const vt = sourceToVisible(activeSrc, player.currentTime);
  apply(s => s.texts.push({
    text: "Seu texto aqui",
    start: Math.round(vt * 10) / 10,
    end: Math.round(Math.min(vt + 3, animDur) * 10) / 10,
    pos: "bottom",
  }));
};

// lista de textos no painel: campos commitam no change (blur), com undo
function renderTexts() {
  const ul = $("texts-list");
  ul.textContent = "";
  state.texts.forEach((t, i) => {
    const li = document.createElement("li");
    const txt = document.createElement("input");
    txt.className = "t-text"; txt.value = t.text; txt.placeholder = "Texto…";
    txt.onchange = () => apply(s => { s.texts[i].text = txt.value; });
    const row = document.createElement("div");
    row.className = "t-row";
    const mkNum = (val, set) => {
      const n = document.createElement("input");
      n.type = "number"; n.step = "0.1"; n.min = "0"; n.value = val;
      n.onchange = () => apply(s => set(s.texts[i], Math.max(0, parseFloat(n.value) || 0)));
      return n;
    };
    const start = mkNum(t.start, (o, v) => { o.start = v; });
    const end = mkNum(t.end, (o, v) => { o.end = v; });
    const pos = document.createElement("select");
    // arrastado livremente (t.x/t.y setados): mostra um rótulo informativo,
    // sem nenhum preset marcado — escolher um preset abaixo volta a ancorar
    // o texto nele (limpa x/y) mesmo que seja o mesmo valor de antes do arraste
    const isFree = t.x != null && t.y != null;
    if (isFree) {
      const op = document.createElement("option");
      op.value = ""; op.textContent = "Livre (arrastado)"; op.selected = true; op.disabled = true;
      pos.appendChild(op);
    }
    for (const [v, label] of [["top", "Topo"], ["center", "Centro"], ["bottom", "Base"]]) {
      const op = document.createElement("option");
      op.value = v; op.textContent = label; op.selected = !isFree && (t.pos || "bottom") === v;
      pos.appendChild(op);
    }
    pos.onchange = () => apply(s => {
      s.texts[i].pos = pos.value; s.texts[i].x = null; s.texts[i].y = null;
    });
    const rm = document.createElement("button");
    rm.className = "rm"; rm.textContent = "✕"; rm.title = "Remover texto";
    rm.onclick = () => apply(s => s.texts.splice(i, 1));
    row.append(start, document.createTextNode("→"), end, pos, rm);
    li.append(txt, row);
    ul.appendChild(li);
  });
}

// ---------- transição (fade preto nas emendas, aplicado na exportação) ----------
$("trans-dur").onchange = () => {
  const d = parseFloat($("trans-dur").value) || 0;
  apply(s => { s.transition = d; });
};
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
  if (!hasContent()) return;
  const refSrc = (state.segments[0] || state.audioTrack[0] || state.imageTrack[0]).src;
  try {
    const picked = await api("/api/pick-save?input=" + encodeURIComponent(refSrc) +
      "&suffix=projeto&ext=evp&title=" + encodeURIComponent("Salvar projeto"));
    if (picked.cancelled) return;
    const project = { app: "BenCut", version: 4, savedAt: new Date().toISOString(),
                      segments: state.segments, texts: state.texts,
                      transition: state.transition || 0, audioTrack: state.audioTrack,
                      imageTrack: state.imageTrack };
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
      "&filter=" + encodeURIComponent("Projetos BenCut (*.evp) | *.evp"));
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
  const audioTrack = proj.audioTrack || [];
  const imageTrack = proj.imageTrack || [];
  if (!segs.length && !audioTrack.length && !imageTrack.length) { alert("Projeto vazio."); return; }
  const missing = [];
  for (const src of [...new Set([...segs.map(s => s.src), ...audioTrack.map(c => c.src), ...imageTrack.map(c => c.src)])]) {
    if (!await ensureSource(src)) missing.push(src);
  }
  if (missing.length) {
    alert("Arquivos do projeto não encontrados:\n" + missing.join("\n"));
    return;
  }
  apply(st => {                           // entra no histórico (dá para desfazer)
    st.segments = segs;
    st.texts = proj.texts || [];
    st.transition = proj.transition || 0;
    st.audioTrack = audioTrack;
    st.imageTrack = imageTrack;
  });
  selectedSeg = null;
  selectedAudio = null;
  selectedImage = null;
  activeTrack = segs.length ? "video" : (audioTrack.length ? "audio" : "image");
  noVidPlaying = false; noVidT = 0; inTail = false;
  tlZoom = 1; tlView = 0;
  $("player-wrap").classList.remove("showing-image");
  if (segs.length) {                          // projeto com vídeo: carrega no player
    const first = segs.find(s => !s.deleted) || segs[0];
    $("player-wrap").classList.add("has-video");
    switchPlayerTo(first.src, first.start);
  } else {                                     // projeto só de áudio: sem player
    $("player-wrap").classList.remove("has-video");
  }
  updateActiveUI();
  drawTimeline();
}
$("btn-export-cancel").onclick = () => setExportOptsVisible(false);
$("btn-export-go").onclick = async () => {
  const kept = state.segments.filter(s => !s.deleted);
  const images = state.imageTrack.map(c => [c.src, c.at, c.duration, c.opacity ?? 1]);
  const audios = state.audioTrack.map(c => [c.src, c.start, c.end, c.at, c.volume ?? 1, c.speed ?? 1]);
  // projeto SEM vídeo: base preta com as imagens gravadas e/ou mix das trilhas
  if (!kept.length) {
    if (!audios.length && !images.length) return;
    const btn = $("btn-export-go");
    btn.disabled = true;
    try {
      const refSrc = (state.audioTrack[0] || state.imageTrack[0]).src;
      const picked = await api("/api/pick-save?input=" +
        encodeURIComponent(refSrc) + "&suffix=editado&ext=mp4");
      if (picked.cancelled) return;
      setExportOptsVisible(false);
      if (images.length && audios.length) {
        // 2 passagens: base preta + imagens num temporário, depois mixa o áudio
        const tmp = picked.path.replace(/(\.[^.]+)$/, "") + ".basetmp.mp4";
        const j1 = await submitJob({ op: "overlay_images", output: tmp, format: "mp4",
                                     base_duration: timelineDur(), images });
        await pollJob(j1);
        submitJob({ op: "mix_audio", input: tmp, output: picked.path, format: "mp4",
                    tracks: audios });
      } else if (images.length) {
        submitJob({ op: "overlay_images", output: picked.path, format: "mp4",
                    base_duration: timelineDur(), images });
      } else {
        submitJob({ op: "mix_audio", output: picked.path, format: "mp4",
                    base_duration: timelineDur(), tracks: audios });
      }
    } catch (e) { alert("Erro na exportação: " + e.message); }
    finally { btn.disabled = false; }
    return;
  }
  const srcs = [...new Set(kept.map(s => s.src))];
  const multi = srcs.length > 1;
  const format = $("export-format").value; // "" = manter original, ou "mp4"/"webm"
  // textos gravados no vídeo exigem recodificar tudo (drawtext não sai em -c copy)
  const burnTexts = state.texts.length > 0;
  const origExt = activeSrc.split(".").pop().toLowerCase();
  const burnFormat = format || (["mp4", "webm"].includes(origExt) ? origExt : "mp4");
  // multi-arquivo sempre recodifica/normaliza (formatos podem diferir) → mp4 por padrão
  const ext = multi ? (format || "mp4")
    : (burnTexts ? burnFormat : (format || origExt));
  // fade preto nas emendas: metade na saída de um trecho, metade na entrada do outro
  const fd = state.transition || 0;
  const fades = (i) => [i > 0 && fd ? fd / 2 : 0,
                        i < kept.length - 1 && fd ? fd / 2 : 0];
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
        parts: kept.map((s, i) => [s.src, s.start, s.end, s.speed || 1, s.gap || 0,
                                   s.volume ?? 1, s.opacity ?? 1, ...fades(i)]),
      };
    } else {
      const conv = format || burnTexts;   // drawtext exige o caminho que recodifica
      body = {
        op: conv ? "render_convert" : "render",
        input: kept[0].src, output: picked.path,
        parts: kept.map((s, i) => [s.start, s.end, s.speed || 1, s.gap || 0,
                                   s.volume ?? 1, s.opacity ?? 1, ...fades(i)]),
      };
      if (conv) body.format = burnFormat;
    }
    if (burnTexts) body.texts = state.texts;

    // passadas extras encadeadas sobre o vídeo-base: primeiro as imagens
    // (overlay recodifica o vídeo e copia o áudio), depois a trilha de áudio
    // (mix copia o vídeo e só recodifica o áudio) — cada uma barata e isolada
    const outFmt = body.format || ext;
    const passes = [];
    if (images.length)
      passes.push({ op: "overlay_images", format: outFmt, images });
    if (audios.length)
      passes.push({ op: "mix_audio", format: outFmt, tracks: audios });
    if (passes.length) {
      const noExt = picked.path.replace(/(\.[^.]+)$/, "");
      setExportOptsVisible(false);
      let prevOut = noExt + ".basetmp." + outFmt;
      body.output = prevOut;
      const j1 = await submitJob(body);
      await pollJob(j1);
      for (let i = 0; i < passes.length; i++) {
        const last = i === passes.length - 1;
        const step = { ...passes[i], input: prevOut,
                       output: last ? picked.path : noExt + `.basetmp${i + 2}.` + outFmt };
        if (last) { submitJob(step); break; }   // última passada: barra de progresso cuida
        const j = await submitJob(step);
        await pollJob(j);
        prevOut = step.output;
      }
    } else {
      submitJob(body);
      setExportOptsVisible(false);
    }
  } catch (e) {
    alert("Erro na exportação: " + e.message);
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
  else if (e.key === " " && hasContent() && e.target.tagName !== "BUTTON") {
    e.preventDefault();
    togglePlay();
  }
  else if (e.ctrlKey && e.key === "Escape" && recPhase === 'recording') {
    e.preventDefault();
    stopRecordingUI();
  }
});

// ---------- render do estado (undo/redo re-renderiza tudo) ----------
function renderState() {
  // um undo pode reviver trechos de vídeo depois de clearVideoTrack() ter
  // esvaziado o player — religa automaticamente no primeiro trecho mantido
  if (state.segments.length && !activeSrc) {
    const first = state.segments.find(s => !s.deleted) || state.segments[0];
    $("player-wrap").classList.remove("showing-image");
    $("player-wrap").classList.add("has-video");
    switchPlayerTo(first.src, first.start);
  }
  if (selectedSeg != null && selectedSeg >= state.segments.length) selectedSeg = null;
  if (selectedAudio != null && selectedAudio >= state.audioTrack.length) selectedAudio = null;
  if (selectedImage != null && selectedImage >= state.imageTrack.length) selectedImage = null;

  // botões da timeline
  const segs = state.segments;
  const kept = segs.filter(s => !s.deleted).length;
  const del = segs.length - kept;
  const sped = segs.some(s => !s.deleted &&
    ((s.speed && s.speed !== 1) || (s.volume != null && s.volume !== 1) ||
     (s.opacity != null && s.opacity !== 1)));
  const gapped = segs.some(s => !s.deleted && (s.gap || 0) > 1e-6);
  const nFiles = distinctSrcs().length;   // arquivos distintos na timeline
  const audioSel = selectedAudio != null ? state.audioTrack[selectedAudio] : null;
  const imageSel = selectedImage != null ? state.imageTrack[selectedImage] : null;
  // Dividir/Excluir operam só na FAIXA ATIVA (a última clicada)
  const audioActive = activeTrack === "audio";
  const imageActive = activeTrack === "image";
  $("btn-cut").disabled = audioActive ? !state.audioTrack.length
    : imageActive ? !state.imageTrack.length
    : !segs.length;
  $("btn-del-seg").disabled = imageActive ? (selectedImage == null)
    : audioActive ? (selectedAudio == null)
    : (selectedSeg == null || segs[selectedSeg]?.deleted);
  $("btn-cut").title = audioActive ? "Dividir o clipe de áudio no cursor (tecla C)"
    : imageActive ? "Dividir a imagem no cursor (tecla C)"
    : "Dividir o segmento no cursor (tecla C)";
  $("btn-del-seg").title = imageActive ? "Excluir a imagem selecionada (Delete)"
    : audioActive ? "Excluir o clipe de áudio selecionado (Delete)"
    : "Excluir segmento (tecla Delete)";
  const segEditable = selectedSeg != null && !segs[selectedSeg]?.deleted;
  const spd = segEditable ? (segs[selectedSeg].speed || 1) : 1;
  $("seg-speed").disabled = !segEditable;
  $("seg-speed").value = String(spd);
  $("seg-speed-val").textContent = spd + "x";
  $("seg-vol").disabled = !segEditable;
  const volPct = segEditable ? Math.round((segs[selectedSeg].volume ?? 1) * 100) : 100;
  $("seg-vol").value = volPct;
  $("seg-vol-val").textContent = volPct + "%";
  $("seg-op").disabled = !segEditable;
  const opPct = segEditable ? Math.round((segs[selectedSeg].opacity ?? 1) * 100) : 100;
  $("seg-op").value = opPct;
  $("seg-op-val").textContent = opPct + "%";
  $("btn-reset-adjust").disabled = !segEditable;
  renderTexts();                                  // painel de textos segue o estado
  $("trans-dur").value = String(state.transition || 0);
  $("btn-add-text").disabled = !segs.length;

  // painel de propriedades: segmento de vídeo OU clipe de áudio OU imagem selecionada
  document.body.classList.toggle("has-props", segEditable || !!audioSel || !!imageSel);
  document.body.classList.toggle("audio-sel", !!audioSel);
  document.body.classList.toggle("image-sel", !!imageSel);
  if (imageSel) {
    const inf = sources.get(imageSel.src)?.info;
    $("prop-file").textContent = basename(imageSel.src);
    $("prop-file").title = imageSel.src;
    $("prop-dur").textContent = fmtTime(imageSel.duration);
    $("prop-res").textContent = "imagem";
    $("prop-size").textContent = inf?.size ? fmtSize(inf.size) : "—";
    $("prop-fps").textContent = "—";
    // duração não tem slider: ajusta-se arrastando a borda do clipe na timeline
    $("seg-op").disabled = false;
    const iop = Math.round((imageSel.opacity ?? 1) * 100);
    $("seg-op").value = iop; $("seg-op-val").textContent = iop + "%";
    $("btn-reset-adjust").disabled = false;
  } else if (audioSel) {
    const inf = sources.get(audioSel.src)?.info;
    $("prop-file").textContent = basename(audioSel.src);
    $("prop-file").title = audioSel.src;
    $("prop-dur").textContent = fmtTime(audioVis(audioSel));
    $("prop-res").textContent = "áudio";
    $("prop-size").textContent = inf?.size ? fmtSize(inf.size) : "—";
    $("prop-fps").textContent = "—";
    $("seg-speed").disabled = false;
    const aspd = audioSel.speed || 1;
    $("seg-speed").value = String(aspd); $("seg-speed-val").textContent = aspd + "x";
    $("seg-vol").disabled = false;
    $("seg-vol").min = 0; $("seg-vol").max = 100; $("seg-vol").step = 5;
    const avp = Math.round((audioSel.volume ?? 1) * 100);
    $("seg-vol").value = avp; $("seg-vol-val").textContent = avp + "%";
    $("btn-reset-adjust").disabled = false;
  } else if (segEditable) {
    const sg = segs[selectedSeg];
    const inf = sources.get(sg.src)?.info;
    const v = inf?.video;
    $("prop-file").textContent = basename(sg.src);
    $("prop-file").title = sg.src;
    $("prop-dur").textContent = fmtTime((sg.end - sg.start) / (sg.speed || 1));
    $("prop-res").textContent = v ? `${v.width} × ${v.height}` : "—";
    $("prop-size").textContent = inf?.size ? fmtSize(inf.size) : "—";
    $("prop-fps").textContent = v?.fps ? fmtFps(v.fps) : "—";
  }
  // com vídeo: exporta se houver algo a fazer; sem vídeo: basta ter áudio/imagem
  const videoExportable = kept > 0 && (del > 0 || sped || gapped || nFiles > 1
    || state.texts.length > 0 || (state.transition > 0 && kept > 1)
    || state.audioTrack.length > 0 || state.imageTrack.length > 0);
  const audioOnlyExportable = kept === 0 && (state.audioTrack.length > 0 || state.imageTrack.length > 0);
  $("btn-export").disabled = !(videoExportable || audioOnlyExportable);
  $("btn-save").disabled = !hasContent();   // salvar projeto: basta ter timeline
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
  render_multi: "Exportação", mix_audio: "Exportação", overlay_images: "Exportação",
  preview: "Pré-visualização",
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

// ---------- gravação de tela ----------
let recPhase = 'idle'; // 'idle' | 'selecting' | 'recording'
let recFile = null;
let recTimerInterval = null;
let recPollInterval = null;
let recElapsed = 0;

async function stopRecordingUI() {
  if (recPollInterval) { clearInterval(recPollInterval); recPollInterval = null; }
  if (recTimerInterval) { clearInterval(recTimerInterval); recTimerInterval = null; }
  try {
    const r = await api('/api/record/stop', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}',
    });
    recFile = r.file;
  } catch (e) {
    alert('Erro ao parar: ' + e.message);
  }
  recPhase = 'idle';
  renderRecUI();
  if (recFile) $('rec-result-file').textContent = recFile.split('/').pop();
}

for (const btn of document.querySelectorAll('.rec-asp')) {
  btn.onclick = () => {
    document.querySelectorAll('.rec-asp').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  };
}

function renderRecUI() {
  const idle = recPhase === 'idle';
  const selecting = recPhase === 'selecting';
  const recording = recPhase === 'recording';
  const startBtn = $('btn-rec-start');
  startBtn.disabled = selecting;
  if (recording) {
    startBtn.textContent = '■  Parar Gravação';
    startBtn.className = 'rec-btn-stop';
  } else {
    startBtn.textContent = idle ? '⬤  Iniciar Gravação' : 'Aguardando seleção...';
    startBtn.className = 'rec-btn-start';
  }
  $('rec-status-row').classList.toggle('hidden', !recording);
  $('rec-dot').classList.toggle('pulsing', recording);
  $('rec-hotkey-hint').classList.toggle('hidden', !recording);
  $('rec-result-row').classList.toggle('hidden', !(idle && recFile));
}

$('btn-rec-start').onclick = async () => {
  if (recPhase === 'recording') {
    await stopRecordingUI();
    return;
  }
  const aspBtn = document.querySelector('.rec-asp.active');
  const fullscreen = !!aspBtn?.dataset.full;
  const aspect = (!fullscreen && aspBtn?.dataset.asp) ? aspBtn.dataset.asp : null;
  const audio = $('rec-audio').checked;
  recPhase = 'selecting';
  recFile = null;
  renderRecUI();
  try {
    const r = await api('/api/record/start', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({aspect, audio, fullscreen}),
    });
    recPhase = 'recording';
    recElapsed = 0;
    $('rec-time').textContent = fmtTime(0);
    recTimerInterval = setInterval(() => {
      recElapsed++;
      $('rec-time').textContent = fmtTime(recElapsed);
    }, 1000);
    // polling: detecta parada externa (Ctrl+Alt+Shift+R)
    recPollInterval = setInterval(async () => {
      try {
        const s = await api('/api/record/status');
        if (!s.recording && recPhase === 'recording') {
          await stopRecordingUI();
        }
      } catch {}
    }, 2000);
    renderRecUI();
  } catch (e) {
    recPhase = 'idle';
    renderRecUI();
    alert('Erro: ' + e.message);
  }
};

$('btn-rec-add').onclick = () => {
  if (recFile) addToTimeline(recFile);
};

renderRecUI();

// ---------- init ----------
(async () => {
  const cfg = await api("/api/config");
  nvenc = cfg.nvenc;
  const badge = $("gpu-badge");
  badge.textContent = nvenc ? "NVENC" : "CPU";
  badge.classList.toggle("on", nvenc);
  if (!nvenc) { $("conv-gpu").checked = false; $("conv-gpu").disabled = true; }
  // retoma o último diretório salvo da aba de vídeo; se sumiu, cai no padrão
  try { await browse(dirByKind.video || cfg.startDir); }
  catch { await browse(cfg.startDir); }
  renderState();
  refreshJobs();
})();
