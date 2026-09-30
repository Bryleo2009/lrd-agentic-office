# LRD Agentic Office — Arquitectura

> La oficina es el producto. Todo lo que un personaje hace **durante una misión** se deriva de un
> evento real emitido por Codex CLI, Claude Code CLI, Git, un comando de QA o GitHub.
> Fuera de misión, los personajes tienen vida ambiental propia (AgentBrain/AgentFSM) que **siempre cede**
> ante la actividad real.

```
CODEX CLI / CLAUDE CODE (trabajo real, stdout JSONL)
        │
        ▼
AgentExecutor ── parser desacoplado por versión ──► AgentRuntimeEvent
        │
        ▼
AgentEventBus ──► SQLite (runtime_events)  ──►  WebSocket /ws  ──► Zustand (estado de app)
                                                     │
                                                     ▼
                                        MissionVisualController
                                                     │
                                                     ▼
                                      OfficeEngine (PixiJS) → PERSONAJE REACCIONA
```

---

## 1. Procesos y stack

| Capa | Tecnología | Notas |
|---|---|---|
| Servidor | Node ≥ 20, TypeScript, Fastify 5, `@fastify/websocket` | Un solo puerto (`PORT`, por defecto 4173). En dev monta Vite en *middleware mode*; en prod sirve `dist/client`. |
| Persistencia | SQLite (`better-sqlite3`) + Drizzle ORM | `~/.lrd-agentic-office/office.db` |
| Motores IA | `codex` y `claude` locales vía `cross-spawn` (= `child_process.spawn`, compatible con `.cmd` en Windows) | **Nunca** `execSync`. Streaming línea a línea. |
| Cliente | React 19 + Vite + Zustand | React sólo pinta paneles. No renderiza frame a frame. |
| Oficina | PixiJS 8 | Mapa, objetos, personajes, animación, pathfinding, cámara. |

## 2. Estructura

```
src/
  shared/            tipos y eventos compartidos (cliente ↔ servidor)
    types.ts         AgentId, AgentDefinition, Mission, MissionStep, RuntimeStatus…
    events.ts        AgentRuntimeEvent, EventType, WsServerMessage
    agents.ts        roster de 8 agentes (rol, departamento, estación)
  server/
    index.ts         bootstrap Fastify, rutas REST, WS, Vite middleware
    config.ts        .env + config/repositories.json (sin secretos)
    runtime/
      AgentExecutor.ts        interfaz + tipos de sesión
      CodexCliExecutor.ts     spawn `codex exec --json` / `codex exec resume`
      ClaudeCodeExecutor.ts   spawn `claude -p --output-format stream-json --verbose`
      parsers/codexParser.ts  JSONL Codex → AgentRuntimeEvent (formato "thread/item" y legado "msg")
      parsers/claudeParser.ts stream-json Claude → AgentRuntimeEvent
      RuntimeDetector.ts      versión, flags soportados (lee --help), autenticación
      processUtils.ts         spawn con streaming, env saneado, cancelación de árbol de procesos
    agents/
      AgentOrchestrator.ts    ciclo de vida de misión (git → plan → DAG → QA → commit → push/PR)
      AgentSession.ts         registro de sesiones por (misión, agente)
      AgentMessageBus.ts      handoffs reales entre agentes (+ reuniones)
    maintenance.ts            limpieza de worktrees/logs de misiones terminadas (RETENTION_DAYS)
    metrics.ts                uso por motor (pasos, minutos, fallas, límites) desde SQLite
    missions/
      MissionPlanner.ts       Atlas genera un plan real (JSON) con el motor IA
      questions.ts            "PREGUNTA:/OPCIONES:" de los agentes y lectura de respuestas naturales
      guides.ts               tipo de tarea (ci-fix / data-lookup) → config/guides/<tipo>.md
      secrets.ts              revisión de secretos y migraciones en el diff antes de publicar
      lessons.ts              memoria del equipo + medición (usos, bien/mal, repeticiones, correcciones)
      MissionDagExecutor.ts   ejecuta nodos en paralelo respetando dependencias
      qa.ts                   detección y ejecución real de build/tests
    integrations/git/GitWorktreeManager.ts
    integrations/github/GitHubAdapter.ts
    events/AgentEventBus.ts
    websocket/wsHub.ts
    database/schema.ts, db.ts, repo.ts
  client/
    main.tsx, app/App.tsx, app/store.ts, app/ws.ts, app/api.ts
    office/  OfficeEngine.ts OfficeScene.ts CameraController.ts MissionVisualController.ts iso.ts
    agents/  AgentEntity.ts AgentBrain.ts AgentFSM.ts AgentRenderer.ts AgentAnimator.ts CharacterRig.ts
    navigation/ NavigationGraph.ts Pathfinder.ts CollisionMap.ts
    environment/ OfficeMap.ts Room.ts Desk.ts Chair.ts Props.ts
    panels/ drawers/        UI secundaria (drawers, bottom panel, floating panels)
assets/characters/<agente>/character.json   (rig) — o spritesheet.json + png (reemplazable)
config/repositories.json
scripts/doctor.ts
```

## 3. Office Engine (PixiJS)

* **Proyección isométrica 2:1.** Mundo en *tiles* (`x`, `y` continuos). `iso(x,y) = ((x−y)·32, (x+y)·16)`.
  Profundidad: `zIndex = (x + y)·100 + capa`. Todos los objetos y personajes viven en el mismo
  contenedor `world` con `sortableChildren`, así un personaje queda detrás/delante de un escritorio correctamente.
* **OfficeScene** construye el piso, muros traseros opacos, divisiones de cristal bajas (para ver dentro de las salas),
  escritorios, sillas, monitores con pantalla emisiva, plantas, mesas, racks, cafetera, sofá, pizarras y rótulos.
* **Ticker único**: `OfficeEngine.update(dt)` → brains → entidades → animadores → cámara. React nunca participa.
* **Estado de animación ≠ estado de app.** Posiciones, fases de ciclo de caminata, etc. viven en `AgentEntity`.
  Zustand sólo guarda datos de negocio (misiones, eventos, estado de runtime, agente seleccionado).

### Floorplan (36 × 26 tiles)

```
 ┌─────────┬───────────────────────┬──────────────┐
 │ CONTROL │      INGENIERÍA       │      QA      │   y 1–10
 │  Atlas  │  Diego · Mica · Nora  │     Vega     │
 ├──door───┴────door──────door────┴────door──────┤
 │               PASILLO PRINCIPAL                 │   y 11–13
 ├────door────┬──────door─────────┬──door────────┤
 │ SALA DE    │    OPERACIONES     │   LOUNGE /   │   y 14–25
 │ MISIÓN     │ Rafa · Piero · Fiona│   CAFÉ      │
 └────────────┴────────────────────┴──────────────┘
```

## 4. Personajes (AgentRenderer / CharacterRig / AgentAnimator)

* **Rig 2.5D articulado** (no emoji, no avatares redondos, no CSS): sombra, piernas (muslo+pierna con zapato),
  torso con sombreado, brazos con pivote en hombro, cabeza, cabello por estilo, rostro y accesorio.
  Dos vistas (frente = SE, espalda = NE) espejadas → **4 direcciones** isométricas.
* Apariencia en `assets/characters/<id>/character.json`. Si existe `spritesheet.json` en esa carpeta,
  `AgentRenderer` usa sprites (`animations: idle_se, walk_se…`) en lugar del rig → arte reemplazable sin tocar código.
* **AgentAnimator** mezcla poses por parámetros: `idle, walk, sit, stand, type, read, think, talk, test, celebrate, blocked`.
  Transiciones con *blend* (0.25–0.45 s). El ciclo de caminata avanza **por distancia recorrida**, no por tiempo: no hay patinaje.

## 5. AgentBrain + AgentFSM (vida autónoma)

```
if (runtime.hasRealTask(agent)) { stopAmbientBehavior(); executeRealBehavior(); }
else executeAmbientBehavior();
```

* Estados ambientales: `IDLE_DESK, IDLE_STANDING, WALKING, READING, COFFEE, TALKING, RETURNING, SITTING, THINKING`.
* Rutinas con duraciones naturales (12–45 s en escritorio; 6–14 s de café; 5–9 s de charla).
  Ejemplo: `IDLE_DESK → STAND → WALK → COFFEE → TALK → RETURN → SIT`.
* Encuentros: un agente puede caminar al puesto de otro; si el otro está en ambiental, gira y conversan.
* La actividad real **interrumpe** cualquier rutina (se cancela el path en curso y se atiende la cola de intents reales).

## 6. Navegación

* **CollisionMap**: grilla booleana derivada del OfficeMap (muros, escritorios, mesas, plantas, racks, sofá…). Puertas explícitas.
* **NavigationGraph**: nodos con nombre (`backend_desk`, `engineering_exit`, `corridor_01`, `qa_entry`, `meeting_table`…)
  mapeados a tiles transitables; se usa para destinos semánticos y para depurar.
* **Pathfinder**: A* 8-direccional sin *corner cutting* + suavizado por línea de visión (string-pulling sobre la grilla).
  Ingeniería → QA sale por la puerta, recorre el pasillo y entra por la puerta de QA. Nunca interpola atravesando objetos.
* Movimiento: aceleración, deceleración al llegar, giro con pequeña pausa al cambiar de cuadrante, evitación simple (ceder paso).

## 7. AgentExecutor

```ts
interface AgentExecutor {
  provider: "codex" | "claude";
  checkAvailability(): Promise<RuntimeStatus>;
  startSession(config): Promise<AgentSession>;
  executeTask(session, task): AsyncIterable<AgentRuntimeEvent>;
  sendMessage(session, message): AsyncIterable<AgentRuntimeEvent>;
  cancel(session): Promise<void>;
  resume(session): Promise<void>;
  close(session): Promise<void>;
}
```

El resto del sistema sólo conoce esta interfaz.

### CodexCliExecutor
* Detecta: `codex --version`, `codex exec --help` (flags), `codex login status` (autenticación ChatGPT).
* Tarea: `codex exec --json [--cd <worktree>] [--sandbox workspace-write|read-only] [--skip-git-repo-check] <prompt>`
  — cada flag se incluye **sólo si aparece en `--help`** de la versión instalada.
* Continuación: `codex exec resume <thread_id> --json <mensaje>` si la versión lo soporta; si no, `MissionContext` reconstruye contexto.
* Parser: formato actual (`thread.started`, `item.started|completed` con `command_execution`, `file_change`,
  `agent_message`, `mcp_tool_call`, `web_search`, `turn.completed|failed`) y formato legado (`{msg:{type:"exec_command_begin"…}}`).
  Ítems `reasoning` se **descartan** (no se muestra razonamiento).

### ClaudeCodeExecutor
* Detecta: `claude --version`, `claude --help` (flags), `claude auth status` (JSON `loggedIn`, `authMethod`).
* Tarea: `claude -p --output-format stream-json --verbose --session-id <uuid> --permission-mode acceptEdits --allowedTools … <prompt>`
  ejecutado con `cwd = worktree`.
* Continuación / chat: `claude -p --resume <session_id> …`.
* Parser: `system/init` → SESSION_CONNECTED; `assistant.tool_use` (Read/Grep/Glob/Edit/Write/Bash/…) → FILE_READ / SEARCH_STARTED /
  FILE_CHANGED / COMMAND_STARTED…; `user.tool_result` → *_FINISHED; `assistant.text` → AGENT_MESSAGE; `result` → AGENT_FINISHED/ERROR.
  Bloques `thinking` se descartan.

### Política de credenciales y costo
* `AI_PROVIDER_MODE=cli`, `ALLOW_PAID_API_FALLBACK=false` por defecto.
* El entorno de los procesos hijos se **sanea**: se eliminan `OPENAI_API_KEY` y `ANTHROPIC_API_KEY`
  (salvo `ALLOW_PAID_API_FALLBACK=true`) para garantizar que los CLIs usen la sesión de suscripción del usuario.
* No existe ningún cliente HTTP hacia `api.openai.com` ni `api.anthropic.com`. `ApiExecutor` es un *stub* desactivado.
* Nunca se leen, copian ni guardan tokens, cookies ni API keys. Sólo se guarda metadata de sesión (id, provider, cwd).

## 8. Eventos

`AgentRuntimeEvent { id, timestamp, missionId, agentId, provider, sessionId, type, title, detail, tool, command, file, status, metadata }`

Tipos: `SESSION_STARTED, SESSION_CONNECTED, AGENT_STARTED, AGENT_MESSAGE, AGENT_STATUS, SEARCH_STARTED, SEARCH_FINISHED,
FILE_READ, FILE_CHANGED, TOOL_STARTED, TOOL_FINISHED, COMMAND_STARTED, COMMAND_OUTPUT, COMMAND_FINISHED, TEST_STARTED,
TEST_OUTPUT, TEST_FINISHED, GIT_DIFF, GIT_COMMIT, GIT_PUSH, PR_CREATED, HANDOFF, AGENT_WAITING, AGENT_BLOCKED,
AGENT_FINISHED, AGENT_ERROR, MEETING_STARTED, AGENT_JOINED_MEETING, MESSAGE_SENT, HANDOFF_CREATED, MEETING_FINISHED,
MISSION_CREATED, MISSION_UPDATED, GIT_BRANCH, GIT_WORKTREE, GIT_FETCH, PLAN_CREATED`.

**AgentEventBus**: `publish(evt)` → persiste en `runtime_events` → difunde por WS. `COMMAND_OUTPUT` se agrupa (máx. 1 cada 250 ms por proceso).

## 9. Protocolo WebSocket (`/ws`)

Servidor → cliente (JSON):
```
{ kind: "hello",   snapshot: { runtime, agents, missions, repositories, config, recentEvents } }
{ kind: "event",   event: AgentRuntimeEvent }
{ kind: "mission", mission: Mission }            // estado completo al cambiar
{ kind: "runtime", runtime: RuntimeStatus[] }
{ kind: "chat",    agentId, missionId, delta, done }
```
Cliente → servidor: REST (`POST /api/missions`, `POST /api/missions/:id/cancel`, `POST /api/agents/:id/chat`,
`GET /api/missions/:id/events`, `GET /api/commands/:eventId/output`). Sin polling.

## 10. Mission DAG

1. **Atlas** (motor IA real, sólo lectura) recibe la misión, el roster y el repo, y devuelve un plan JSON:
   `{ steps: [{ id, agent, title, task, dependsOn[], writes }] }`. Se valida (agentes existentes, sin ciclos, IDs únicos).
   Si el JSON es inválido, se aplica un plan base por reglas **y se informa explícitamente** (`PLAN_CREATED.metadata.source="rules"`).
2. `MissionDagExecutor` lanza en paralelo los nodos cuyas dependencias terminaron.
   Nodos `writes=true` se serializan con un *mutex* por worktree (dos agentes no editan el mismo árbol a la vez).
   Nodos de investigación corren con permisos de sólo lectura.
3. Al terminar un nodo, su resultado real (mensaje final del agente) se convierte en **HANDOFF** hacia cada nodo dependiente
   y se inyecta en su prompt. Varias entradas hacia un nodo → **reunión** en la Sala de Misión.
4. **Vega (QA)** ejecuta realmente los comandos de QA del repo (`npm run build`, `php artisan test`, …).
   Si fallan y hubo cambios, se hace **un** ciclo de corrección con el último agente escritor y se re-ejecuta QA.
5. **Atlas** revisa `git diff` real y resume. El **orquestador** (no la IA) hace `git add/commit`, y `push`/`PR` sólo con flags.

## 11. AgentMessageBus

`handoff(from, to, payload)` guarda en `handoffs`, emite `HANDOFF` + `HANDOFF_CREATED` y lo encola en el `MissionContext`
del destinatario. No existen conversaciones generadas en el cliente: la burbuja muestra el `title` real del handoff.

## 12. Ciclo Git / worktree

```
~/.lrd-agentic-office/
  repos/<repo>/                 clon base (git clone la primera vez)
  worktrees/<missionId>/<short>/ worktree aislado
  runs/<missionId>/<agent>/      stdout crudo (.jsonl) y prompts por agente
  office.db
```
1. `git fetch origin`
2. validar rama base ∈ `allowedBases`
3. `git worktree add --detach <path> origin/<base>` (sin rama)
4. agentes trabajan en el worktree
5. `git status --porcelain`, `git diff --stat` → `GIT_DIFF`
6. QA real
7. sin cambios → no se crea rama. Con cambios → `git switch -c agentic/<area>/<slug>-<id>` → `GIT_BRANCH`
   (o commit directo sobre la base si la misión lo pide y la base no está protegida)
8. `git add -A && git commit` → `GIT_COMMIT` (sha real)
9. `GITHUB_PUSH_ENABLED=true` (por defecto) y la misión no dice "no publiques" → `git push -u origin <branch>` → `GIT_PUSH`
10. `GITHUB_PR_ENABLED=true` → `gh pr create` → `PR_CREATED`

Guardas: nunca `checkout`/`commit`/`push` sobre `main`, `release/fase2`, `release/fase3.1` (lista `PROTECTED_BRANCHES`).
Los prompts prohíben a los CLIs hacer `git push/commit`; además Claude se lanza con `--disallowedTools "Bash(git push*)" "Bash(git commit*)"…`.

## 13. Modelo de datos (SQLite / Drizzle)

`repositories, branches, missions, mission_steps, agent_sessions, runtime_events, handoffs, deliveries`.
`missions` guarda además `questions`, `task_kind` y `lesson_ids` (JSON).
No se persisten API keys, OAuth tokens, contraseñas ni razonamiento.

## 14. Seguridad

* Sólo escucha en `127.0.0.1` por defecto (`HOST`).
* Sin secretos en `.env.example`; `doctor` muestra `API fallback: disabled`.
* Worktrees aislados; ramas protegidas; push/PR controlados por el orquestador con flags explícitos.
* Errores reales: cualquier fallo (CLI, git, gh, build, tests) → `AGENT_BLOCKED/AGENT_ERROR` con el mensaje real. Nunca éxito inventado.

## 15. Ajustes locales, repos opcionales y datos MCP

* `src/server/settings.ts` → `<LRD_WORKSPACE_ROOT>/settings.json` (fuera del repo, sin secretos):
  * `repoPaths`: ruta de tu clon por repo. `GitWorktreeManager.repoPath()` la usa en vez del clon gestionado.
    Sólo `git fetch origin` (sin `--prune`) y `git worktree add` en tu repo: tu checkout y tus cambios no se tocan.
  * `team`: overrides por agente (nombre, sexo, rol, descripción, responsabilidades, color, motor, apariencia).
    `profile(id)` los combina con la definición base y `assets/characters/<id>/character.json`. Los prompts usan el nombre/rol personalizados.
* `POST /api/missions`: `repositoryId` = id | `"auto"` | `"none"`; `baseBranch` opcional (default del repo).
  `inferRepo()` elige el repo y la decisión se publica como evento. `"none"` ejecuta `runWithoutRepo()`: sin git, sin QA, sin commit.
* MCP: `codex mcp list --json` / `claude mcp list` → `RuntimeStatus.mcpServers` (nombre/estado/transporte).
  Por misión (`allowMcp`): si es `false`, Codex recibe `-c mcp_servers.<n>.enabled=false` y Claude `--strict-mcp-config`;
  si es `true`, Claude recibe `--allowedTools mcp__<n>` y todos los prompts incluyen reglas de sólo lectura (`mcpRules`).
  Las llamadas MCP se muestran como "Consultando datos: servidor · herramienta".
* API: `GET/PUT /api/team/:id`, `POST /api/team/:id/reset`, `GET /api/repositories`, `PUT /api/repositories/:id/local-path`.
  WS: `{kind:"team"}`, `{kind:"repositories"}` → la oficina reconstruye el rig del personaje en vivo.

## 16. Preguntas, guías, aprendizaje medido, seguridad y mantenimiento

* **Preguntas (pausa y respuesta).** `runAgentAsking()` ejecuta al agente; si su respuesta trae `PREGUNTA: …`
  (`OPCIONES: a | b`), `ask()` guarda una `MissionQuestion` en la misión, pone la misión en `waiting` y el paso en
  `waiting`, emite `AGENT_WAITING` y espera. `POST /api/missions/:id/questions/:qid/answer` (o escribir en el chat del
  agente) la responde; el agente continúa con su prompt + la respuesta. Cada pregunta tiene una clave estable
  (paso + texto): al retomar tras un reinicio, lo ya respondido se reutiliza. Sin respuesta en `QUESTION_TIMEOUT_MIN`
  el agente sigue con lo más prudente. Máximo `MAX_QUESTIONS_PER_STEP` por paso. El planificador también puede preguntar.
* **Guías.** `taskKind()` clasifica la misión (`ci-fix` si cita un run de CI o pide arreglar un pipeline en rojo;
  `data-lookup` para consultas sin repo). `guideFor()` agrega `config/guides/<tipo>.md` al plan y a cada tarea; la
  corrección automática de GitHub Actions usa siempre la guía `ci-fix`.
* **Aprendizaje medido.** Cada misión recuerda qué lecciones recibió (`missions.lesson_ids`). Al terminar,
  `recordOutcome()` suma un uso y si salió bien o falló (una vez por misión). Si una falla de herramienta o una corrección
  del usuario vuelve a producir una lección que ya estaba en el prompt, cuenta como *repetición*. Un ajuste por chat es
  una corrección: el agente propone una `LECCIÓN` (fuente `correccion`) y `recordCorrection()` lo anota en las lecciones
  usadas. `lessonHealth()` (≥3 usos): *sirve*, *a medias* o *no sirve*; las que no sirven dejan de enviarse.
* **Seguridad antes de publicar** (`deliverRepo`, corrección de CI, ajustes por chat):
  1. `scanSecrets()` sobre `git diff origin/<base>` (solo líneas agregadas + archivos de credenciales). Con hallazgos no
     hay commit: se pregunta *que el agente lo quite* (se reescanea) / *falso positivo: publicar* / *no publicar*.
  2. `approvePublish()`: entrega directa en la rama base y/o `migrationFiles()` → aprobación (*publicar* / *rama nueva* /
     *no publicar*). Sin respuesta a tiempo o una respuesta ambigua: no se publica (commit local).
* **Mantenimiento.** `cleanupOld()` al arrancar, cada 24 h y desde *Ajustes → Uso y limpieza* (con vista previa):
  borra `worktrees/<misión>` (con `git worktree remove` + `prune`) y `runs/<misión>` de misiones terminadas hace más de
  `RETENTION_DAYS` días; conserva lo que tiene cambios sin commit o commits sin publicar. `usageMetrics()` →
  `GET /api/metrics/usage?days=N`: pasos, minutos, fallas, límites alcanzados (`engineSwitch`) y misiones por motor.
