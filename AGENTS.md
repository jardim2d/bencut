# AGENTS.md — BenCut

Instruções para agentes de código (Codex) trabalhando neste repositório.
Editor de vídeo web local. Stack: **Python (biblioteca padrão, `server.py`) + JavaScript (`js/app.js`) + FFmpeg**. Roda em `localhost:8765`.

**Tradeoff:** estas diretrizes priorizam **cautela sobre velocidade**. Para tarefas triviais, use o bom senso. O usuário cobra que estas diretrizes sejam seguidas — na dúvida, exponha o tradeoff **antes** de implementar.

---

## Setup, execução e validação

**Dependências:** Python 3 e **FFmpeg** no PATH (com `ffprobe`). NVENC é opcional: a inicialização testa uma codificação real; falhas de codificação NVENC permitem uma nova tentativa por software.

```bash
# rodar
python3 server.py            # sobe o servidor em http://localhost:8765
# ou
./run.sh                     # sobe o server e abre no navegador
```

**Como validar uma mudança (obrigatório antes de dizer "pronto"):**
1. Suba o `server.py` sem erros.
2. Para mudanças de **backend/FFmpeg**: exercite o endpoint afetado com um **arquivo de vídeo real** e confirme que o arquivo de saída abre e está correto (duração, áudio, corte). Não confie só em "o comando montou".
3. Para mudanças de **frontend/timeline**: confirme na UI que o `state` muda como esperado, que é **salvo/restaurado no `.evp`**, e que **undo/redo** funciona.
4. Não há suíte de testes automatizada — a validação é manual, rodando o app.

> Ambiente: o app é **local** (sem nuvem). Não adicione dependências de rede/externas sem pedir.

---

## Arquitetura

- `server.py` — backend HTTP com `ThreadingHTTPServer`; constrói e executa comandos FFmpeg; expõe API REST.
- `js/app.js` — frontend completo (~170 KB, **grande e coeso por design**): estado da timeline, UI, player, comunicação com o server.
- `css/style.css` — estilos globais.
- `screen_recorder.py` / `rec_overlay.py` / `screen_select.py` — gravação de tela (API do GNOME + overlay de parada).
- `run.sh` — inicialização.

**Estado da timeline** (em `app.js`): `state.segments`, `state.audioTrack`, `state.videoTrack`, `state.imageTrack`, `state.texts`. Edições discretas passam por **`apply(mutator)`** para garantir undo/redo. Os arrastes existentes registram um snapshot no início do gesto e atualizam o estado durante o movimento; `resetEditor()` limpa estado e histórico. Preserve essas exceções ao fazer correções pontuais.

---

## 1. Pense antes de codar

**Não assuma. Verbalize incertezas antes de agir.**

- Comandos FFmpeg têm comportamentos não óbvios (ordem de filtros, re-encode em bordas GOP, NVENC vs software). Se não tiver certeza do comportamento, **diga**.
- Se a tarefa alterar a estrutura de `state`, **alerte sobre o impacto nos arquivos `.evp`** (serialização de projetos salvos).
- Se houver múltiplas abordagens (ex.: recodificar vs. stream copy), **apresente o tradeoff antes** de implementar.

## 2. Simplicidade primeiro

**Código mínimo que resolve o problema. Nada especulativo.**

- Sem features além do pedido.
- Sem abstrações para código de uso único — o frontend é intencionalmente um arquivo grande e coeso.
- Sem tratamento de erro para cenários impossíveis no contexto do app local.
- FFmpeg: prefira o comando mais simples que funciona; não otimize prematuramente.

Pergunte-se: "Um dev sênior acharia isso complicado demais?" Se sim, simplifique.

## 3. Mudanças cirúrgicas

**Toque apenas o necessário.**

- **Não refatore** a estrutura de `app.js` ao implementar uma tarefa.
- Não altere lógica de FFmpeg não relacionada (risco de quebrar o pipeline de exportação).
- Mantenha o estilo existente (comentários em PT; nomes de variáveis em inglês/PT misto conforme já existe).
- Se notar algo errado não relacionado, **mencione — não corrija sem pedir**.
- Mudança no `state` exige verificar 3 pontos: serialização `.evp`, renderização da timeline e undo/redo.

**Teste:** cada linha alterada deve traçar diretamente à solicitação do usuário.

## 4. Execução guiada por objetivo

**Defina o critério de sucesso antes de implementar.**

- "Adicionar feature X na timeline" → aparece na UI, altera `state` corretamente, é salva/restaurada no `.evp`, e o export FFmpeg reflete a mudança.
- "Corrigir bug Y" → reproduza com um vídeo real, corrija, confirme.
- "Novo endpoint no `server.py`" → responde corretamente via `api()` no frontend.

Para tarefas multi-passo, **liste o plano antes de executar**.

---

## Convenções

- **Backend (`server.py`)**: comentários e strings em PT; comandos FFmpeg como **listas Python** (não string de shell).
- **Frontend (`js/app.js`)**: comentários em PT, nomes de variáveis em inglês.
- Use **`apply(mutator)`** nas edições discretas; preserve o histórico por gesto nos arrastes existentes e a limpeza explícita em `resetEditor()`.
- **Projetos `.evp`** (JSON): mudanças em `state` impactam compatibilidade de arquivos já salvos — trate com cuidado.
- **NVENC**: a inicialização testa uma codificação real; falhas de codificação NVENC permitem uma nova tentativa por software.
- **Idioma**: responda ao usuário em **português**.
