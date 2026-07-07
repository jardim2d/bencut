#!/bin/bash
# Inicia o BenCut e abre no navegador
cd "$(dirname "$0")"
export PATH="$HOME/.local/bin:$PATH"
xdg-open http://localhost:8765 >/dev/null 2>&1 &
exec python3 server.py
