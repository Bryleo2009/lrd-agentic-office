import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentId, AgentProfile, Appearance, Gender, Provider, RepositoryConfig } from "../../shared/types";
import { api } from "../app/api";
import { useStore } from "../app/store";
import type { OfficeEngine } from "../office/OfficeEngine";

type Tab = "team" | "repos" | "data";

const HAIR: [Appearance["hairStyle"], string][] = [
  ["side_part", "Corto con raya"],
  ["buzz", "Rapado"],
  ["curly", "Rizado"],
  ["wavy", "Ondulado"],
  ["bob", "Bob / melena corta"],
  ["long", "Largo"],
  ["ponytail", "Cola de caballo"],
  ["bun", "Moño"],
];
const OUTFIT: [Appearance["outfit"], string][] = [
  ["blazer", "Saco"],
  ["shirt", "Camisa"],
  ["polo", "Polo"],
  ["hoodie", "Polera con capucha"],
  ["sweater", "Chompa"],
  ["blouse", "Blusa"],
];
const ACC: [Appearance["accessory"], string][] = [
  ["none", "Ninguno"],
  ["glasses", "Lentes"],
  ["headphones", "Audífonos"],
  ["headset", "Headset con micrófono"],
  ["badge", "Fotocheck"],
  ["earrings", "Aretes"],
];
const SKINS = ["#f6d7c3", "#f1c7a8", "#e0ac82", "#c68c62", "#a86f47", "#8a5a3b", "#5f3b25"];

/** Sugerencia de apariencia al cambiar el sexo (el usuario puede ajustarla después). */
function suggest(g: Gender, a: Appearance): Partial<Appearance> {
  if (g === "female") return { hairStyle: ["long", "ponytail", "bob", "bun"].includes(a.hairStyle) ? a.hairStyle : "long", outfit: a.outfit === "blazer" || a.outfit === "shirt" ? "blouse" : a.outfit, beard: false, build: Math.min(a.build, 0.95) };
  if (g === "male") return { hairStyle: ["side_part", "buzz", "curly", "wavy"].includes(a.hairStyle) ? a.hairStyle : "side_part", outfit: a.outfit === "blouse" ? "shirt" : a.outfit, accessory: a.accessory === "earrings" ? "none" : a.accessory, build: Math.max(a.build, 1) };
  return {};
}

export function SettingsPanel({ engine }: { engine: OfficeEngine | null }) {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<Tab>("team");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);
  if (!open) return null;
  return (
    <div className="sheet-backdrop" onPointerDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="settings-panel glass" role="dialog" aria-label="Ajustes">
        <div className="panel-head">
          <div>
            <div className="eyebrow">Ajustes</div>
            <h2>Tu oficina</h2>
          </div>
          <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Cerrar">
            ×
          </button>
        </div>
        <div className="tabs">
          <button className={tab === "team" ? "on" : ""} onClick={() => setTab("team")}>
            Equipo
          </button>
          <button className={tab === "repos" ? "on" : ""} onClick={() => setTab("repos")}>
            Repositorios en esta PC
          </button>
          <button className={tab === "data" ? "on" : ""} onClick={() => setTab("data")}>
            Datos (MCP)
          </button>
        </div>
        <div className="settings-body">
          {tab === "team" && <TeamTab engine={engine} />}
          {tab === "repos" && <ReposTab />}
          {tab === "data" && <DataTab />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Equipo

function TeamTab({ engine }: { engine: OfficeEngine | null }) {
  const team = useStore((s) => s.team);
  const selected = useStore((s) => s.selected);
  const [id, setId] = useState<AgentId>(selected ?? "atlas");
  const current = team.find((t) => t.id === id);
  return (
    <div className="team-grid">
      <div className="team-list">
        {team.map((t) => (
          <button key={t.id} className={`team-item ${t.id === id ? "on" : ""}`} onClick={() => setId(t.id)}>
            <i style={{ background: t.color }} />
            <span>
              <b>{t.name}</b>
              <small>{t.role}</small>
            </span>
            {t.customized && <em>editado</em>}
          </button>
        ))}
      </div>
      {current && <ProfileEditor key={current.id + JSON.stringify(current)} profile={current} engine={engine} />}
    </div>
  );
}

function ProfileEditor({ profile, engine }: { profile: AgentProfile; engine: OfficeEngine | null }) {
  const toast = useStore((s) => s.showToast);
  const [d, setD] = useState<AgentProfile>(profile);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!engine) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void engine.portrait(profile.id, d.appearance).then(setPreview).catch(() => undefined), 120);
  }, [d.appearance, engine, profile.id]);

  const set = <K extends keyof AgentProfile>(k: K, v: AgentProfile[K]) => setD((x) => ({ ...x, [k]: v }));
  const setA = (patch: Partial<Appearance>) => setD((x) => ({ ...x, appearance: { ...x.appearance, ...patch } }));
  const dirty = JSON.stringify(d) !== JSON.stringify(profile);

  const save = async () => {
    setBusy(true);
    try {
      await api.updateProfile(profile.id, {
        name: d.name,
        gender: d.gender,
        role: d.role,
        tagline: d.tagline,
        color: d.color,
        engine: d.engine,
        responsibilities: d.responsibilities,
        appearance: d.appearance,
      });
      toast(`${d.name} actualizado`, "info");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="editor">
      <div className="editor-top">
        <div className="big-portrait" style={{ borderColor: d.color }}>
          {preview && <img src={preview} alt="" />}
        </div>
        <div className="grow">
          <div className="row2">
            <label>
              <span>Nombre</span>
              <input value={d.name} maxLength={24} onChange={(e) => set("name", e.target.value)} />
            </label>
            <label>
              <span>Sexo</span>
              <select
                value={d.gender}
                onChange={(e) => {
                  const g = e.target.value as Gender;
                  setD((x) => ({ ...x, gender: g, appearance: { ...x.appearance, ...suggest(g, x.appearance) } }));
                }}
              >
                <option value="female">Femenino</option>
                <option value="male">Masculino</option>
                <option value="other">Otro / prefiero no decir</option>
              </select>
            </label>
          </div>
          <label>
            <span>Rol / cargo</span>
            <input value={d.role} maxLength={60} onChange={(e) => set("role", e.target.value)} />
          </label>
          <div className="fineprint">Puesto: {deptLabel(d.department)} · escritorio fijo en la oficina</div>
        </div>
      </div>

      <label>
        <span>Descripción (se usa en su perfil)</span>
        <input value={d.tagline} maxLength={140} onChange={(e) => set("tagline", e.target.value)} />
      </label>
      <label>
        <span>Responsabilidades (una por línea)</span>
        <textarea rows={3} value={d.responsibilities.join("\n")} onChange={(e) => set("responsibilities", e.target.value.split("\n"))} />
      </label>
      <div className="row3">
        <label>
          <span>Color de identidad</span>
          <input type="color" value={d.color} onChange={(e) => set("color", e.target.value)} />
        </label>
        <label>
          <span>Motor preferido</span>
          <select value={d.engine ?? ""} onChange={(e) => set("engine", (e.target.value || null) as Provider | null)}>
            <option value="">El de la misión</option>
            <option value="codex">Codex CLI</option>
            <option value="claude">Claude Code</option>
          </select>
        </label>
        <label>
          <span>Estatura</span>
          <input type="range" min={0.9} max={1.1} step={0.01} value={d.appearance.height} onChange={(e) => setA({ height: Number(e.target.value) })} />
        </label>
      </div>

      <div className="section-title">Apariencia</div>
      <div className="row3">
        <label>
          <span>Tono de piel</span>
          <div className="swatches">
            {SKINS.map((c) => (
              <button key={c} className={d.appearance.skin === c ? "on" : ""} style={{ background: c }} onClick={() => setA({ skin: c })} aria-label={c} />
            ))}
          </div>
        </label>
        <label>
          <span>Peinado</span>
          <select value={d.appearance.hairStyle} onChange={(e) => setA({ hairStyle: e.target.value as Appearance["hairStyle"] })}>
            {HAIR.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Color de cabello</span>
          <input type="color" value={d.appearance.hair} onChange={(e) => setA({ hair: e.target.value })} />
        </label>
        <label>
          <span>Vestimenta</span>
          <select value={d.appearance.outfit} onChange={(e) => setA({ outfit: e.target.value as Appearance["outfit"] })}>
            {OUTFIT.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Color de ropa</span>
          <input type="color" value={d.appearance.shirt} onChange={(e) => setA({ shirt: e.target.value })} />
        </label>
        <label>
          <span>Color de detalle</span>
          <input type="color" value={d.appearance.shirtAccent} onChange={(e) => setA({ shirtAccent: e.target.value })} />
        </label>
        <label>
          <span>Pantalón</span>
          <input type="color" value={d.appearance.pants} onChange={(e) => setA({ pants: e.target.value })} />
        </label>
        <label>
          <span>Accesorio</span>
          <select value={d.appearance.accessory} onChange={(e) => setA({ accessory: e.target.value as Appearance["accessory"] })}>
            {ACC.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Complexión</span>
          <input type="range" min={0.85} max={1.15} step={0.01} value={d.appearance.build} onChange={(e) => setA({ build: Number(e.target.value) })} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={!!d.appearance.beard} onChange={(e) => setA({ beard: e.target.checked })} /> Barba
      </label>

      <div className="panel-actions">
        {profile.customized && (
          <button
            className="btn ghost"
            onClick={async () => {
              await api.resetProfile(profile.id);
              toast(`Se restableció el perfil original`, "info");
            }}
          >
            Restablecer original
          </button>
        )}
        <button className="btn primary" disabled={!dirty || busy || !d.name.trim()} onClick={save}>
          {busy ? "Guardando…" : "Guardar cambios"}
        </button>
      </div>
    </div>
  );
}

function deptLabel(d: string) {
  return d === "INGENIERIA" ? "Ingeniería" : d === "OPERACIONES" ? "Operaciones" : d === "CONTROL" ? "Control" : "QA";
}

// ---------------------------------------------------------------- Repositorios

function ReposTab() {
  const repos = useStore((s) => s.repositories);
  return (
    <div className="repos">
      <p className="fineprint">
        Indica dónde tienes clonado cada repositorio en esta PC. La oficina usará tu clon para hacer <code>git fetch</code> y crear los worktrees de cada misión:
        tu rama actual y tus cambios sin commitear <b>no se tocan</b>. Solo si una misión deja cambios se crea una rama <code>agentic/…</code> y se publica para evaluación. Si lo dejas vacío, la app mantiene su propio clon.
      </p>
      {repos.map((r) => (
        <RepoRow key={r.id} repo={r} />
      ))}
      <p className="fineprint">
        Para habilitar OfSystem, ERP u otros, cambia <code>"enabled": true</code> en <code>config/repositories.json</code>.
      </p>
    </div>
  );
}

function RepoRow({ repo }: { repo: RepositoryConfig }) {
  const [p, setP] = useState(repo.localPath ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; message: string } | null>(repo.localStatus ?? null);
  const [busy, setBusy] = useState(false);
  const save = async (value: string | null) => {
    setBusy(true);
    try {
      const r = await api.setRepoPath(repo.id, value);
      setMsg(r.status);
      if (!value) setP("");
    } catch (e) {
      setMsg({ ok: false, message: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={`repo-row ${repo.enabled ? "" : "disabled"}`}>
      <div className="repo-head">
        <b>{repo.name}</b>
        <span className="muted">{repo.github}</span>
        {!repo.enabled && <span className="mini-pill bad">deshabilitado</span>}
        {repo.localPath && <span className="mini-pill ok">usa tu clon</span>}
      </div>
      <div className="repo-input">
        <input value={p} placeholder={repo.kind === "frontend" ? "C:\\proyectos\\lrd-front  o  ~/proyectos/lrd-front" : "C:\\proyectos\\lrd-back  o  ~/proyectos/lrd-back"} onChange={(e) => setP(e.target.value)} />
        <button className="btn" disabled={busy || !p.trim()} onClick={() => save(p)}>
          {busy ? "Validando…" : "Guardar"}
        </button>
        {repo.localPath && (
          <button className="btn ghost" disabled={busy} onClick={() => save(null)}>
            Quitar
          </button>
        )}
      </div>
      {msg && <div className={msg.ok ? "ok-text" : "err-text"}>{msg.message}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- Datos / MCP

function DataTab() {
  const runtime = useStore((s) => s.runtime);
  const all = useMemo(() => runtime.flatMap((r) => r.mcpServers.map((m) => ({ ...m, engine: r.label }))), [runtime]);
  return (
    <div className="repos">
      <p className="fineprint">
        Los agentes pueden consultar datos reales usando los servidores <b>MCP</b> que ya tienes configurados en Codex o Claude Code. La oficina no guarda credenciales:
        sólo lee el nombre y el estado de cada servidor.
      </p>
      {all.length === 0 ? (
        <div className="empty">
          No se detectaron servidores MCP. Si tu MCP de producción está en Codex, verifica con <code>codex mcp list</code> en esta PC y luego pulsa “Volver a detectar”.
        </div>
      ) : (
        all.map((m) => (
          <div key={m.engine + m.name} className="repo-row">
            <div className="repo-head">
              <b>{m.name}</b>
              <span className="muted">
                {m.engine} · {m.transport}
              </span>
              <span className={`mini-pill ${m.enabled ? "ok" : "bad"}`}>{m.enabled ? "habilitado" : "deshabilitado"}</span>
            </div>
          </div>
        ))
      )}
      <button className="btn" onClick={() => void api.runtime(true).then((r) => useStore.getState().setRuntime(r))}>
        Volver a detectar
      </button>
      <div className="note">
        <b>Cómo se usa.</b> Al crear una misión marca “Usar datos reales (MCP)”. Si no la marcas, los MCP se desactivan para esa misión (Codex:{" "}
        <code>-c mcp_servers.&lt;nombre&gt;.enabled=false</code>; Claude: <code>--strict-mcp-config</code>). Con datos habilitados, los agentes reciben reglas de sólo lectura
        (sólo SELECT, con límites, sin exponer datos personales).
        <br />
        <b>Recomendado:</b> que el MCP de producción use un usuario de base de datos con permisos de <b>solo lectura</b>. Las reglas del prompt ayudan, pero la garantía real
        es el permiso del usuario de la base de datos.
      </div>
    </div>
  );
}
