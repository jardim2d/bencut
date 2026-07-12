# CLAUDE.md — BenCut

Editor de vídeo web local. Stack: Python (Flask, server.py) + JavaScript (app.js) + FFmpeg. Roda em `localhost:8765`.

**Tradeoff:** Estas diretrizes priorizam cautela sobre velocidade. Para tarefas triviais, use o bom senso.

---

## Arquitetura

- `server.py` — backend Flask, constrói e executa comandos FFmpeg, expõe API REST
- `js/app.js` — frontend completo: estado da timeline, UI, player, comunicação com server
- `css/style.css` — estilos globais
- `run.sh` — inicialização

**Estado da timeline** (em `app.js`): `state.segments`, `state.audioTrack`, `state.videoTrack`, `state.imageTrack`, `state.texts`. Toda mutação de estado passa pela função `apply(mutator)` para garantir undo/redo. Nunca mute `state` diretamente fora de `apply()`.

---

## 1. Think Before Coding

**Não assuma. Verbalize incertezas antes de agir.**

- Comandos FFmpeg têm comportamentos não óbvios (ordem de filtros, re-encode em bordas GOP, NVENC vs software). Se não tiver certeza do comportamento, diga.
- Se a tarefa alterar a estrutura de `state`, alerte sobre o impacto nos arquivos `.evp` (serialização de projetos salvos).
- Se múltiplas abordagens existirem (ex: recodificar vs. stream copy), apresente o tradeoff antes de implementar.

---

## 2. Simplicity First

**Código mínimo que resolve o problema. Nada especulativo.**

- Sem features além do que foi pedido.
- Sem abstrações para código de uso único — o frontend é intencionalmente um arquivo grande e coeso.
- Sem tratamento de erros para cenários impossíveis no contexto do app local.
- Comandos FFmpeg: prefira o mais simples que funciona; não otimize prematuramente.

Pergunta-se: "Um dev sênior acharia isso complicado demais?" Se sim, simplifique.

---

## 3. Surgical Changes

**Toque apenas o que for necessário.**

- `app.js` é grande e coeso por design — não refatore a estrutura ao implementar uma tarefa.
- Não altere lógica de FFmpeg não relacionada à tarefa (risco de quebrar pipeline de exportação).
- Mantenha o estilo existente (comentários em PT, variáveis em inglês/PT misto conforme já existe).
- Se notar algo errado não relacionado, mencione — não corrija sem pedir.
- Mudanças no `state` exigem verificar: serialização `.evp`, renderização da timeline, e undo/redo.

**Teste:** cada linha alterada deve traçar diretamente à solicitação do usuário.

---

## 4. Goal-Driven Execution

**Defina critério de sucesso antes de implementar.**

- "Adicionar feature X na timeline" → "Feature aparece na UI, altera `state` corretamente, é salva/restaurada no `.evp`, e o export FFmpeg reflete a mudança"
- "Corrigir bug Y" → "Reproduza o bug com um arquivo de vídeo real, corrija, confirme"
- "Novo endpoint no server.py" → "Endpoint responde corretamente via `api()` no frontend"

Para tarefas multi-passo, liste o plano antes de executar.

---

## Convenções

- Backend (`server.py`): comentários e strings em PT; construção de comandos FFmpeg como listas Python
- Frontend (`app.js`): comentários em PT, nomes de variáveis em inglês
- Toda mutação de `state` via `apply(mutator)` — nunca diretamente
- Projetos salvos: formato `.evp` (JSON); mudanças em `state` impactam compatibilidade de arquivos existentes
- NVENC: sempre cheque disponibilidade antes de usar — o server já tem lógica para fallback software
