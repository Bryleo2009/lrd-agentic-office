# LRD Agentic Office

Oficina virtual isométrica **viva** que representa en tiempo real el trabajo **real** de
**Codex CLI** y **Claude Code** sobre los repositorios LRD.

- 8 agentes con vida propia (caminan, se sientan, toman café, conversan, van a la pizarra…).
- Cuando hay una misión, cada animación proviene de un evento real: Codex/Claude (JSONL), Git, comandos de QA o GitHub.
- Usa tus **sesiones de suscripción** (ChatGPT para Codex, cuenta Claude para Claude Code). **No usa API de pago.**
- Cada misión trabaja en un **git worktree aislado** con rama `agentic/<area>/<slug>-<id>`. Las ramas base nunca se tocan.

> Arquitectura completa: [ARCHITECTURE.md](./ARCHITECTURE.md)

## Requisitos

- Node.js ≥ 20 y Git
- Al menos un motor IA autenticado:
  - **Codex CLI**: `npm i -g @openai/codex` y luego `codex login` (elige *Sign in with ChatGPT*)
  - **Claude Code**: `npm i -g @anthropic-ai/claude-code` y luego `claude` → `/login` (o `claude auth login`)
- Acceso SSH a `Bryleo2009/lrd-back` y `Bryleo2009/lrd-front` (el clon usa `git@github.com:…`)
- Opcional: **GitHub CLI** (`gh auth login`) para push/PR

## Inicio

```bash
npm install
cp .env.example .env        # ya viene con valores seguros por defecto
npm run doctor
npm run dev                 # → http://127.0.0.1:4173
```

`npm run doctor` muestra, por ejemplo:

```
✓ Node 22.x
✓ git version 2.4x
✓ gh autenticado como Bryleo2009
✓ Codex instalado (0.159.1)
✓ Codex autenticado · Logged in using ChatGPT
✓ Claude Code instalado (2.1.x)
✓ Claude Code autenticado · oauth_token
✓ Motores IA disponibles: Codex CLI, Claude Code
  API fallback: disabled
✓ Bryleo2009/lrd-back: release/fase2, release/fase3.1, main
✓ Bryleo2009/lrd-front: release/fase2, release/fase3.1, main
```

Basta con un motor disponible (`✓ Codex ✗ Claude` o al revés es válido).

## Uso

1. Abre la oficina. Los 8 agentes viven aunque no haya misión.
2. **Nueva misión**: escribe el pedido y elige *Repositorio*, *Rama base* (por defecto `release/fase2`) y *Motor IA* (Automático / Codex / Claude Code).
3. El sistema hace de verdad: `git fetch` → crea la rama `agentic/…` → crea el worktree → Atlas planifica con el motor → los agentes trabajan (en paralelo cuando se puede) → Vega corre QA real (`npm run build`, `php artisan test`, …) → Atlas revisa el diff → **commit**.
4. Push y PR sólo si los habilitas en `.env` (`GITHUB_PUSH_ENABLED=true`, `GITHUB_PR_ENABLED=true`).
5. Haz clic en un personaje para ver su drawer: **Actividad**, **Chat** (va a su sesión real de Codex/Claude), **Terminal** (comandos reales, exit code, *Ver output completo*) y **Perfil**.

Cámara: arrastra para mover; rueda del mouse, pinch de trackpad o pinch táctil para hacer zoom; **Centrar oficina** para encuadrar.

## Configuración (`.env`)

| Variable | Default | Descripción |
|---|---|---|
| `PORT` / `HOST` | `4173` / `127.0.0.1` | Servidor (UI + API + WebSocket en un solo puerto) |
| `AI_PROVIDER_MODE` | `cli` | Sólo CLIs oficiales |
| `AI_ENGINE_DEFAULT` | `codex` | Motor en modo *Automático* |
| `CODEX_ENABLED` / `CLAUDE_ENABLED` | `true` | Habilitar motores |
| `CODEX_COMMAND` / `CLAUDE_COMMAND` | `codex` / `claude` | Ruta de los binarios |
| `ALLOW_PAID_API_FALLBACK` | `false` | Si es `false`, se eliminan `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` del entorno de los CLIs |
| `GITHUB_PUSH_ENABLED` / `GITHUB_PR_ENABLED` | `false` | Push/PR controlados por el orquestador (nunca por la IA) |
| `LRD_WORKSPACE_ROOT` | `~/.lrd-agentic-office` | Clones, worktrees, logs crudos y `office.db` |
| `AGENT_ENGINES` | — | Motor por agente en modo Automático, ej. `diego:claude,rafa:codex` |
| `ATLAS_REVIEW_ENABLED` | `true` | Revisión final de Atlas con el motor IA |
| `QA_FIX_ITERATIONS` | `1` | Ciclos de corrección si QA falla |
| `AGENT_STEP_TIMEOUT_MIN` | `30` | Tiempo máximo por paso |
| `VISUAL_PACING_MS` | `4000` | Pausa tras handoffs/reuniones para que la oficina los represente (0 = sin pausa) |

Repositorios en `config/repositories.json` (ya incluye `lrd-back`, `lrd-front` y, deshabilitados,
`OfSystem`, `erp-ofsystem-back`, `erp-ofsystem-front`, `lrd-deploy-scripts`). Para habilitar uno: `"enabled": true`.
Puedes fijar `qaCommands` (p. ej. `["npm run build"]`) o dejar que se autodetecten.

## Seguridad

- Nunca se almacenan contraseñas, cookies, tokens OAuth ni API keys. Sólo metadata de sesión.
- Ramas protegidas (`main`, `release/fase2`, `release/fase3.1`): el orquestador bloquea commit/push sobre ellas.
- Claude Code se lanza con `--disallowedTools` para `git push/commit/checkout/reset/rebase/merge` y `gh`.
- Los agentes de investigación corren en modo sólo lectura (Codex `--sandbox read-only`, Claude sin herramientas de edición).
- Nunca se muestra razonamiento interno: sólo acciones observables (archivos, comandos, resultados).
- Si algo falla (CLI, git, build, tests…), el agente queda **BLOCKED** con el error real. No se inventa éxito.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor + Vite (HMR) en `:4173` |
| `npm run build` / `npm start` | Build de producción y servidor |
| `npm run doctor` | Diagnóstico de herramientas, sesiones y acceso a repos |
| `npm test` | Pruebas: parsers Codex/Claude, planner, DAG en paralelo, navegación A* |
| `npm run validate:visual` | Corre la oficina 65 s en Chromium y verifica movimiento, colisiones, encuentros, etc. (requiere `npm run dev` y un Chromium para `playwright-core`) |
| `node scripts/e2e-mission.mjs <url> "<misión>" <repo> <base> <motor>` | Prueba de aceptación end-to-end con motor real y capturas |

## Arte de personajes

Los personajes son rigs 2.5D articulados definidos en `assets/characters/<agente>/character.json`.
Para usar arte propio, agrega un `spritesheet.json` en la carpeta del agente (ver `assets/characters/README.md`).
