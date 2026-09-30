# LRD Data — MCP local de solo lectura (Producción y QA)

```
Codex / Claude Code ──MCP (stdio)──► mcp/lrd-data/server.mjs ──OAuth client_credentials──► lrd-back /api/v1/integrations/codex/* ──► BD solo lectura
                                              ├── Producción → https://back.rollsdediego.com
                                              └── QA         → https://back.qa.rollsdediego.com
```

Sin dependencias (Node ≥ 20). Guarda `client_id`/`client_secret` de cada entorno, pide tokens de 15 min a
`/oauth/token` (`scope=database:read`) y los renueva solo. Codex solo ve herramientas de lectura:

| Herramienta | Qué hace |
|---|---|
| `lrd_list_targets` | Entornos configurados y si la autenticación funciona |
| `lrd_find_order` | Busca órdenes **siempre con `LIKE`** en `numero_orden` y `correlativo` (número entero o últimos dígitos): primero hoy (Lima), luego la fecha AAMMDD del número, los últimos 7 días y sin fecha |
| `lrd_order_get` | Detalle de una orden; si el número no es exacto, la ubica con `LIKE` y trae la única coincidencia |
| `lrd_query_schema` | Tablas, o columnas/índices/llaves de una tabla |
| `lrd_select` | Una consulta `SELECT` / `WITH` con parámetros `?` (se rechaza localmente cualquier otra cosa; el backend valida de nuevo) |

## 1. Cliente OAuth en cada backend (una vez por entorno)

En el servidor de **Producción** y en el de **QA** (con `CODEX_QUERY_ENABLED=true` y la conexión `codex_readonly` configurada):

```bash
php artisan passport:client --client --name="Codex LRD"
```

Anota el `Client ID` y el `Client secret` de cada uno.

## 2. Credenciales en tu PC (fuera del repo)

`%USERPROFILE%\.lrd-agentic-office\lrd-mcp.json`:

```json
{
  "targets": {
    "production": { "baseUrl": "https://back.rollsdediego.com",    "clientId": "…", "clientSecret": "…" },
    "qa":         { "baseUrl": "https://back.qa.rollsdediego.com", "clientId": "…", "clientSecret": "…" }
  }
}
```

(O variables de entorno `LRD_PRODUCTION_CLIENT_ID`, `LRD_PRODUCTION_CLIENT_SECRET`, `LRD_QA_CLIENT_ID`, `LRD_QA_CLIENT_SECRET`;
`LRD_PRODUCTION_URL` / `LRD_QA_URL` para cambiar la URL.) Nunca pongas los secretos en `config.toml` ni en el repo.

## 3. Registrarlo en Codex (dos servidores: uno por entorno)

```powershell
codex mcp remove lrd-qa   # si quedó la entrada OAuth rota de antes
codex mcp add lrd-pr -- node "C:\Users\bryle\Downloads\lrd-agentic-office\mcp\lrd-data\server.mjs" --only production
codex mcp add lrd-qa -- node "C:\Users\bryle\Downloads\lrd-agentic-office\mcp\lrd-data\server.mjs" --only qa
codex mcp list
```

Con un servidor por entorno, la oficina marca `lrd-pr` como **Producción** y `lrd-qa` como **QA** y los agentes buscan
en Producción y luego en QA. (También puedes registrar uno solo sin `--only`: sus herramientas reciben `target`.)

Prueba rápida:

```powershell
codex exec "Con lrd-pr busca la orden 260930123604 y dime su número completo y total. Solo lectura."
```

En la oficina: *Ajustes → Datos (MCP) → Volver a detectar* y marca **Usar datos reales vía MCP** en la misión.
Claude Code: `claude mcp add lrd-pr -- node "…\server.mjs" --only production` (igual para QA).
