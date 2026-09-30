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
3. El sistema hace de verdad: `git fetch` → crea un worktree aislado (sin rama) → Atlas planifica con el motor → los agentes trabajan (en paralelo cuando se puede) → Vega corre QA real (`npm run build`, `php artisan test`, …) → Atlas revisa el diff → si hubo cambios, crea **una rama nueva** `agentic/…`, hace **commit** y la **publica** para evaluación. Si no hubo cambios, no se crea ninguna rama.
   - **Back + Front en paralelo**: elige `lrd-back + lrd-front` en *Repositorio* (o menciona API y pantalla en modo Automático). Cada repo tiene su propio worktree: Diego y Mica editan a la vez, QA prueba cada repo en paralelo y se publica una rama `agentic/…` en cada uno.
   - **QA en paralelo**: build y pruebas corren a la vez (hasta `QA_PARALLEL` carriles) y se reportan todas las fallas juntas. En Laravel con ParaTest se usa `php artisan test --parallel`.
4. Puedes cambiarlo desde el texto de la misión: "no publiques" / "solo local" deja la rama sin push; "directo en la rama base" / "sin crear rama" hace commit sobre la base (solo si no está protegida). Para desactivar el push globalmente: `GITHUB_PUSH_ENABLED=false`. El PR sigue siendo opcional (`GITHUB_PR_ENABLED=true`).
5. Haz clic en un personaje para ver su drawer: **Actividad**, **Chat** (va a su sesión real de Codex/Claude), **Terminal** (comandos reales, exit code, *Ver output completo*) y **Perfil**.

### Repositorio y rama opcionales

En *Nueva misión* el repositorio y la rama pueden quedar en **Automático**: se elige el repo por el texto de la misión
(nombre del repo, "front"/"back", palabras como *checkout*, *webhook*, *Rappi*…) y la rama por defecto del repo (`release/fase2`).
La elección se anuncia en la oficina. Con **Sin repo (análisis / datos)** nadie toca código: el equipo sólo investiga y responde.

### Tus repos locales (Ajustes → Repositorios en esta PC)

Pon la ruta de tu clon de `lrd-front` y `lrd-back` (p. ej. `C:\proyectos\lrd-front`). La oficina usará tu clon para
`git fetch` y para crear los worktrees de cada misión: **tu rama actual y tus cambios sin commitear no se tocan**
(los worktrees viven en `~/.lrd-agentic-office/worktrees`) y, solo cuando hay cambios, las ramas `agentic/…` aparecen en tu repo (y en `origin`) para que las revises.

### Datos reales vía MCP (Ajustes → Datos)

Si tienes un servidor MCP configurado en Codex (`codex mcp list`) o Claude Code (`claude mcp list`), la oficina lo detecta
(sólo nombre y estado; nunca lee sus credenciales). Al crear una misión marca **Usar datos reales vía MCP (solo lectura)**.
Sin esa marca los MCP se desactivan para la misión. Con ella, los agentes reciben reglas estrictas: sólo lecturas, con límites,
sin exponer datos personales y citando la consulta usada. **Recomendación:** que el MCP de producción use un usuario de BD de solo lectura.

### Personalizar el equipo (Ajustes → Equipo, o *Personalizar* en el drawer)

Nombre, sexo, rol, descripción, responsabilidades, color, motor preferido y apariencia (piel, peinado, color de cabello,
vestimenta, colores, accesorio, barba, estatura, complexión) con vista previa. Se aplica en vivo en la oficina y en los prompts.
Se guarda en `~/.lrd-agentic-office/settings.json`.

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
| `GITHUB_PUSH_ENABLED` | `true` | Publica la rama `agentic/…` cuando la misión deja cambios (lo hace el orquestador, nunca la IA) |
| `GITHUB_PR_ENABLED` | `false` | Además abre un PR contra la rama base |
| `QA_PARALLEL` | `3` | Comandos de QA a la vez (build, pruebas…). `1` = en serie |
| `LRD_WORKSPACE_ROOT` | `~/.lrd-agentic-office` | Clones, worktrees, logs crudos y `office.db` |
| `AGENT_ENGINES` | — | Motor por agente en modo Automático, ej. `diego:claude,rafa:codex` |
| `ATLAS_REVIEW_ENABLED` | `true` | Revisión final de Atlas con el motor IA |
| `QA_FIX_ITERATIONS` | `1` | Ciclos de corrección si QA falla |
| `AGENT_STEP_TIMEOUT_MIN` | `30` | Tiempo máximo por paso |
| `VISUAL_PACING_MS` | `4000` | Pausa tras handoffs/reuniones para que la oficina los represente (0 = sin pausa) |

Repositorios en `config/repositories.json` (ya incluye `lrd-back`, `lrd-front` y, deshabilitados,
`OfSystem`, `erp-ofsystem-back`, `erp-ofsystem-front`, `lrd-deploy-scripts`). Para habilitar uno: `"enabled": true`.
Puedes fijar `qaCommands` (p. ej. `["npm run build"]`) o dejar que se autodetecten. Para controlar el orden usa
`qaStages`: las etapas van en orden y los comandos de cada etapa corren en paralelo. `checkCommand` es el chequeo
único del repo que los agentes usan para verificar sus cambios. Configuración actual:

- **lrd-back** (`bash scripts/check-backend`): etapa 1 en paralelo `composer validate --strict` · `bash scripts/pint-changed`
  · `php artisan optimize:clear` → etapa 2 `bash scripts/migrate-ci` → etapa 3 `php artisan test` (con `--parallel` si hay ParaTest).
- **lrd-front** (`npm run check-frontend`): en paralelo `npm run lint:check` · `npm run type-check` · `npm run test` · `npm run build`.

En Windows, `bash scripts/...` usa el bash de Git for Windows (`C:\Program Files\Git\bin\bash.exe`, o la ruta en `GIT_BASH`).

## Seguridad

- Nunca se almacenan contraseñas, cookies, tokens OAuth ni API keys. Sólo metadata de sesión.
- Ramas protegidas (`main`, `release/fase2`, `release/fase3.1`): el orquestador bloquea commit/push sobre ellas.
- Claude Code se lanza con `--disallowedTools` para `git push/commit/checkout/reset/rebase/merge` y los subcomandos de `gh` que publican o modifican (`gh api`, `gh pr create/merge/comment`, `gh issue`, `gh release`, …). En modo lectura solo se permiten consultas de CI (`gh run list/view`, `gh pr view/checks`).
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
