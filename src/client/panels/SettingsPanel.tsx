import { useEffect, useMemo, useRef, useState } from "react";
import { isToolMcp, lessonHealth, type AgentId, type AgentProfile, type Appearance, type CleanupReport, type Gender, type Lesson, type ProjectInspection, type Provider, type RepositoryConfig, type UsageMetrics } from "../../shared/types";
import { api } from "../app/api";
import { useStore } from "../app/store";
import type { OfficeEngine } from "../office/OfficeEngine";

type Tab = "team" | "repos" | "data" | "memory" | "usage";

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
          <button className={tab === "memory" ? "on" : ""} onClick={() => setTab("memory")}>
            Lo que aprendió
          </button>
          <button className={tab === "usage" ? "on" : ""} onClick={() => setTab("usage")}>
            Uso y limpieza
          </button>
        </div>
        <div className="settings-body">
          {tab === "team" && <TeamTab engine={engine} />}
          {tab === "repos" && <ReposTab />}
          {tab === "data" && <DataTab />}
          {tab === "memory" && <MemoryTab />}
          {tab === "usage" && <UsageTab />}
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
  // null = cerrado; "new" = proyecto nuevo; si no, el repositorio que se edita.
  const [form, setForm] = useState<RepositoryConfig | "new" | null>(null);
  return (
    <div className="repos">
      <p className="fineprint">
        Indica dónde tienes clonado cada repositorio en esta PC. La oficina usará tu clon para hacer <code>git fetch</code> y crear los worktrees de cada misión:
        tu rama actual y tus cambios sin commitear <b>no se tocan</b>. Solo si una misión deja cambios se crea una rama <code>agentic/…</code> y se publica para evaluación. Si lo dejas vacío, la app mantiene su propio clon.
      </p>
      {form ? (
        <ProjectForm key={form === "new" ? "new" : form.id} initial={form === "new" ? null : form} onClose={() => setForm(null)} />
      ) : (
        <button className="btn primary" onClick={() => setForm("new")}>
          + Agregar proyecto
        </button>
      )}
      {repos.map((r) => (
        <RepoRow key={r.id} repo={r} onEdit={() => setForm(r)} />
      ))}
      <p className="fineprint">
        Con <b>+ Agregar proyecto</b> eliges la carpeta de tu PC y su repositorio de GitHub; la oficina detecta cómo está armado (tecnologías, tipo, ramas y
        comandos de prueba) y tú lo ajustas. También sirve para activar OfSystem, ERP u otros de <code>config/repositories.json</code>.
      </p>
    </div>
  );
}

function RepoRow({ repo, onEdit }: { repo: RepositoryConfig; onEdit: () => void }) {
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
  const remove = async () => {
    if (!confirm(`¿Quitar ${repo.name} de la oficina? Tu carpeta y el repositorio no se tocan.`)) return;
    setBusy(true);
    try {
      await api.removeProject(repo.id);
    } catch (e) {
      setMsg({ ok: false, message: (e as Error).message });
      setBusy(false);
    }
  };
  return (
    <div className={`repo-row ${repo.enabled ? "" : "disabled"}`}>
      <div className="repo-head">
        <b>{repo.name}</b>
        <span className="muted">{repo.github}</span>
        {repo.stack && <span className="muted">· {repo.stack}</span>}
        {repo.workdir && <span className="muted">· carpeta {repo.workdir}</span>}
        {!repo.enabled && <span className="mini-pill bad">deshabilitado</span>}
        {repo.custom && <span className="mini-pill">agregado por ti</span>}
        {repo.localPath && <span className="mini-pill ok">usa tu clon</span>}
        <span className="grow" />
        <button className="btn tiny ghost" disabled={busy} onClick={onEdit}>
          {repo.custom ? "Editar" : repo.enabled ? "Ajustar" : "Activar"}
        </button>
        {repo.custom && (
          <button className="btn tiny ghost" disabled={busy} onClick={remove}>
            Quitar
          </button>
        )}
      </div>
      <div className="repo-input">
        <input value={p} placeholder={`C:\\proyectos\\${repo.name}  o  ~/proyectos/${repo.name}`} onChange={(e) => setP(e.target.value)} />
        <button className="btn" disabled={busy || !p.trim()} onClick={() => save(p)}>
          {busy ? "Validando…" : "Guardar"}
        </button>
        {repo.localPath && (
          <button className="btn ghost" disabled={busy} onClick={() => save(null)}>
            Quitar ruta
          </button>
        )}
      </div>
      {msg && <div className={msg.ok ? "ok-text" : "err-text"}>{msg.message}</div>}
    </div>
  );
}

/** Etapas de QA ↔ texto: un comando por línea; una línea en blanco separa etapas (lo de una etapa corre en paralelo). */
const stagesToText = (st: string[][] | undefined) => (st ?? []).map((s) => s.join("\n")).join("\n\n");
const textToStages = (t: string) =>
  t
    .split(/\n\s*\n/)
    .map((b) => b.split("\n").map((c) => c.trim()).filter(Boolean))
    .filter((s) => s.length);
const listToText = (l: string[] | undefined) => (l ?? []).join(", ");
const textToList = (t: string) => t.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/**
 * Agregar o editar un proyecto: carpeta local + repositorio → la oficina analiza la estructura y propone la
 * configuración, que se puede ajustar antes de guardar.
 */
function ProjectForm({ initial, onClose }: { initial: RepositoryConfig | null; onClose: () => void }) {
  const [path, setPath] = useState(initial?.localPath ?? "");
  const [github, setGithub] = useState(initial?.github ?? "");
  const [info, setInfo] = useState<ProjectInspection | null>(null);
  const [d, setD] = useState<RepositoryConfig | null>(null);
  const [qa, setQa] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const analyze = async (workdir?: string | null) => {
    setBusy(true);
    setErr(null);
    setSaved(null);
    try {
      const r = await api.inspectProject({ path, github: github || null, workdir: workdir ?? initial?.workdir ?? null });
      setInfo(r);
      if (!r.ok || !r.draft) {
        setD(null);
        setErr(r.message);
        return;
      }
      setD(r.draft);
      setQa(stagesToText(r.draft.qaStages));
      if (!github) setGithub(r.draft.github);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  // Al editar uno existente con carpeta, se analiza de una vez para traer sus ramas.
  useEffect(() => {
    if (initial?.localPath) void analyze();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = <K extends keyof RepositoryConfig>(k: K, v: RepositoryConfig[K]) => setD((x) => (x ? { ...x, [k]: v } : x));
  const save = async () => {
    if (!d) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.saveProject({ ...d, qaStages: textToStages(qa) }, d.localPath ?? path);
      setSaved(`${r.project.name} listo: ya puedes elegirlo en Nueva misión. ${r.status.message}`);
      setTimeout(onClose, 1500);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggleBase = (b: string) => d && set("allowedBases", d.allowedBases.includes(b) ? d.allowedBases.filter((x) => x !== b) : [...d.allowedBases, b]);

  return (
    <div className="repo-row project-form editor">
      <div className="section-title">{initial ? `Configurar ${initial.name}` : "Nuevo proyecto"}</div>
      <div className="row2">
        <label>
          <span>Carpeta en esta PC</span>
          <input className="mono" value={path} placeholder="C:\proyectos\mi-api  o  ~/proyectos/mi-api" onChange={(e) => setPath(e.target.value)} />
        </label>
        <label>
          <span>Repositorio de GitHub (opcional si la carpeta ya tiene origin)</span>
          <input className="mono" value={github} placeholder="Bryleo2009/mi-api  o  https://github.com/…" onChange={(e) => setGithub(e.target.value)} />
        </label>
      </div>
      <div className="repo-input">
        <button className="btn" disabled={busy || !path.trim()} onClick={() => analyze(null)}>
          {busy && !d ? "Analizando…" : d ? "Volver a analizar" : "Analizar carpeta"}
        </button>
        <button className="btn ghost" disabled={busy} onClick={onClose}>
          Cancelar
        </button>
      </div>
      {info?.ok && <div className="ok-text">{info.message}</div>}
      {info?.warnings.map((w) => (
        <div key={w} className="warn-text fineprint">
          ⚠ {w}
        </div>
      ))}
      {!!info?.subprojects.length && (
        <div className="fineprint">
          Proyectos dentro del repositorio (clic para registrar solo esa carpeta):{" "}
          {info.subprojects.map((s) => (
            <button key={s.dir} className="chip" disabled={busy} onClick={() => analyze(s.dir)}>
              {s.dir} · {s.stack}
            </button>
          ))}
        </div>
      )}
      {err && <div className="err-text">{err}</div>}

      {d && (
        <>
          <div className="row3">
            <label>
              <span>Nombre</span>
              <input value={d.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />
            </label>
            <label>
              <span>Nombre corto (carpeta del worktree)</span>
              <input value={d.shortName} maxLength={20} onChange={(e) => set("shortName", e.target.value)} />
            </label>
            <label>
              <span>Tipo</span>
              <select value={d.kind ?? "other"} onChange={(e) => set("kind", e.target.value as RepositoryConfig["kind"])}>
                <option value="backend">Backend / API (Diego)</option>
                <option value="frontend">Frontend / app (Mica)</option>
                <option value="other">Otro (scripts, librería…)</option>
              </select>
            </label>
          </div>
          <div className="row3">
            <label>
              <span>Tecnologías</span>
              <input value={d.stack ?? ""} maxLength={120} onChange={(e) => set("stack", e.target.value)} />
            </label>
            <label>
              <span>Subcarpeta del proyecto (monorepo)</span>
              <input className="mono" value={d.workdir ?? ""} placeholder="vacío = raíz del repo" onChange={(e) => set("workdir", e.target.value)} />
            </label>
            <label>
              <span>Rama base por defecto</span>
              <select value={d.defaultBase} onChange={(e) => set("defaultBase", e.target.value)}>
                {(info?.branches ?? [d.defaultBase]).map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div>
            <span className="label-text">Ramas base permitidas al crear misiones</span>
            <div className="chips">
              {[...new Set([...d.allowedBases, ...(info?.branches ?? [])])].slice(0, 30).map((b) => (
                <button key={b} className={`chip ${d.allowedBases.includes(b) ? "on" : ""}`} onClick={() => toggleBase(b)}>
                  {d.allowedBases.includes(b) ? "✓ " : ""}
                  {b}
                </button>
              ))}
            </div>
          </div>
          <label>
            <span>Ramas protegidas (nunca se hace commit/push directo en ellas)</span>
            <input className="mono" value={listToText(d.protectedBranches)} onChange={(e) => set("protectedBranches", textToList(e.target.value))} />
          </label>
          <label>
            <span>Comandos de QA — uno por línea; una línea en blanco separa etapas (lo de una misma etapa corre en paralelo)</span>
            <textarea className="mono" rows={5} value={qa} placeholder={"npm run lint\nnpm test\n\nnpm run build"} onChange={(e) => setQa(e.target.value)} />
          </label>
          <div className="row2">
            <label>
              <span>Chequeo rápido para los agentes (opcional)</span>
              <input className="mono" value={d.checkCommand ?? ""} placeholder="npm run check" onChange={(e) => set("checkCommand", e.target.value)} />
            </label>
            <label>
              <span>Palabras que lo identifican en modo Automático</span>
              <input value={listToText(d.keywords)} placeholder="facturación, erp" onChange={(e) => set("keywords", textToList(e.target.value))} />
            </label>
          </div>
          <label>
            <span>Indicaciones para el equipo (estructura, convenciones, qué no tocar, cómo se prueba…)</span>
            <textarea
              rows={4}
              value={d.notes ?? ""}
              maxLength={4000}
              placeholder={"Ej.: Los módulos están en src/modules/<nombre>. No modificar src/legacy.\nLas pruebas necesitan Docker levantado (docker compose up -d db)."}
              onChange={(e) => set("notes", e.target.value)}
            />
          </label>
          <div className="repo-input">
            <button className="btn primary" disabled={busy} onClick={save}>
              {busy ? "Guardando…" : initial ? "Guardar cambios" : "Agregar proyecto"}
            </button>
          </div>
          {saved && <div className="ok-text">{saved}</div>}
        </>
      )}
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
              {isToolMcp(m.name) && <span className="muted">herramienta, no datos</span>}
              <span className="grow" />
              {m.hidden && <span className="muted">oculto en misiones</span>}
              <button
                className="btn"
                title={m.hidden ? "Volver a ofrecerlo al crear misiones" : "No ofrecerlo al crear misiones (queda desactivado en ellas)"}
                onClick={() => void api.setMcpHidden(m.name, !m.hidden).then((r) => useStore.getState().setRuntime(r))}
              >
                {m.hidden ? "Mostrar" : "Ocultar"}
              </button>
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

// ---------------------------------------------------------------- Memoria del equipo

const HEALTH: Record<ReturnType<typeof lessonHealth>, string> = {
  nueva: "aún sin datos",
  util: "sirve",
  regular: "ayuda a medias",
  no_sirve: "no está sirviendo · en pausa",
};

/** ¿Sirve la lección? Usos en misiones, cuántas salieron bien y si el problema se repitió igual. */
function LessonStats({ l }: { l: Lesson }) {
  const h = lessonHealth(l);
  const uses = l.uses ?? 0;
  const tip = uses
    ? `Usada en ${uses} misión(es): ${l.ok ?? 0} bien, ${l.failed ?? 0} fallidas, ${l.corrected ?? 0} corregidas por ti después. El problema se repitió ${l.repeats ?? 0} vez/veces aunque el equipo la tenía.${h === "no_sirve" ? " Ya no se envía a los agentes; reescríbela u olvídala." : ""}`
    : "Todavía no se usó en misiones terminadas.";
  return (
    <span className={`lesson-health ${h}`} title={tip}>
      {uses ? `${uses} uso${uses === 1 ? "" : "s"} · ${Math.round(((l.ok ?? 0) / uses) * 100)}% bien${l.repeats ? ` · se repitió ${l.repeats}` : ""} · ` : ""}
      {HEALTH[h]}
    </span>
  );
}

const SCOPE_LABEL: Record<string, string> = { datos: "Datos", general: "General" };

function MemoryTab() {
  const [items, setItems] = useState<Lesson[] | null>(null);
  const [text, setText] = useState("");
  const [scope, setScope] = useState("general");
  const repos = useStore((s) => s.repositories).filter((r) => r.enabled);
  const load = () => void api.lessons().then(setItems).catch(() => setItems([]));
  useEffect(load, []);
  const add = async () => {
    if (!text.trim()) return;
    await api.addLesson(text.trim(), scope);
    setText("");
    load();
  };
  return (
    <div className="repos">
      <p className="fineprint">
        Cuando el equipo pierde tiempo en algo evitable (una herramienta que falla, un dato difícil de ubicar, pasos de más), lo anota aquí. Antes de cada misión, Atlas y los agentes leen
        estas lecciones para ir directo. Puedes borrar las que no sirvan o agregar las tuyas.
      </p>
      {items === null ? (
        <div className="empty">Cargando…</div>
      ) : items.length === 0 ? (
        <div className="empty">Todavía no hay lecciones. Se irán sumando con cada misión.</div>
      ) : (
        items.map((l) => (
          <div key={l.id} className="repo-row">
            <div className="repo-head">
              <span className="mini-pill ok">{SCOPE_LABEL[l.scope] ?? l.scope}</span>
              <span className="grow">{l.text}</span>
              <span className="muted" title="Veces que se volvió a aprender">
                {l.source === "usuario" ? "tuya" : l.source === "auto" ? "automática" : l.source === "correccion" ? "de tu corrección" : "del equipo"}
                {l.hits > 1 ? ` · ×${l.hits}` : ""}
              </span>
              <LessonStats l={l} />
              <button className="btn" onClick={() => void api.deleteLesson(l.id).then(load)} aria-label="Olvidar esta lección">
                Olvidar
              </button>
            </div>
          </div>
        ))
      )}
      <div className="repo-row">
        <div className="repo-head">
          <input className="grow" value={text} placeholder="Ej.: Para buscar un pedido por número usa numero_orden o correlativo" onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void add()} />
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="general">General</option>
            <option value="datos">Datos</option>
            {repos.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!text.trim()} onClick={() => void add()}>
            Enseñar
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- Uso por motor y limpieza

function UsageTab() {
  const [days, setDays] = useState(30);
  const [m, setM] = useState<UsageMetrics | null>(null);
  const [preview, setPreview] = useState<CleanupReport | null>(null);
  const [busy, setBusy] = useState(false);
  const retention = useStore((s) => s.config?.retentionDays ?? 14);
  const toast = useStore((s) => s.showToast);
  useEffect(() => {
    setM(null);
    void api.usage(days).then(setM).catch(() => setM(null));
  }, [days]);
  const clean = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await api.cleanup(dryRun);
      setPreview(r);
      if (!dryRun) toast(`Limpieza lista: ${r.removed.length} carpeta(s), ${r.freedMb} MB liberados`, "info");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const label = (p: Provider) => (p === "codex" ? "Codex" : "Claude Code");
  const KIND: Record<string, string> = { plan: "planes", agent: "pasos", xreview: "revisiones cruzadas", review: "revisiones", qa: "QA", ci: "CI" };
  return (
    <div className="repos">
      <div className="repo-row">
        <div className="repo-head">
          <b className="grow">Uso por motor</b>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Últimos 7 días</option>
            <option value={30}>Últimos 30 días</option>
            <option value={90}>Últimos 90 días</option>
          </select>
        </div>
      </div>
      {!m ? (
        <div className="empty">Cargando…</div>
      ) : (
        <>
          <div className="usage-grid">
            {m.engines.map((e) => (
              <div key={e.provider} className="usage-card">
                <h4>{label(e.provider)}</h4>
                <dl>
                  <dt>Pasos</dt>
                  <dd>
                    {e.steps} ({e.done} bien{e.failed ? `, ${e.failed} fallidos` : ""})
                  </dd>
                  <dt>Tiempo de trabajo</dt>
                  <dd>{e.minutes} min</dd>
                  <dt>Promedio por paso</dt>
                  <dd>{e.avgStepMin} min</dd>
                  <dt>Motor principal en</dt>
                  <dd>{e.missions} misión(es)</dd>
                  <dt>Llegó a su límite</dt>
                  <dd>{e.saturations} vez/veces</dd>
                </dl>
                {Object.keys(e.byKind).length > 0 && (
                  <div className="muted tiny">
                    {Object.entries(e.byKind)
                      .map(([k, n]) => `${n} ${KIND[k] ?? k}`)
                      .join(" · ")}
                  </div>
                )}
              </div>
            ))}
          </div>
          <p className="fineprint">
            {m.missions.total} misión(es) en el periodo: {m.missions.done} completadas, {m.missions.failed} fallidas, {m.missions.cancelled} canceladas · {m.missions.questions} pregunta(s) de agentes y {m.missions.approvals}{" "}
            aprobación(es) pedidas.
          </p>
        </>
      )}

      <div className="repo-row">
        <div className="repo-head">
          <b className="grow">Limpieza de carpetas viejas</b>
          <button className="btn" disabled={busy} onClick={() => void clean(true)}>
            Ver qué se borraría
          </button>
          <button className="btn primary" disabled={busy || !preview?.dryRun || !preview.removed.length} onClick={() => void clean(false)}>
            Limpiar ahora
          </button>
        </div>
        <p className="fineprint">
          Borra la carpeta de trabajo (worktree) de una misión apenas su trabajo ya está en una rama principal (merge o squash), y los worktrees y logs de misiones terminadas hace más de{" "}
          {retention} días (<code>RETENTION_DAYS</code>). Se hace sola al arrancar y cada 3 horas. Nunca toca misiones en curso, carpetas con cambios sin commit ni commits sin publicar. En GitHub no se
          borra ninguna rama; en tu PC solo la rama local agentic/… ya integrada.
        </p>
        {preview && (
          <div className="muted tiny">
            {preview.dryRun ? "Se borrarían" : "Se borraron"} {preview.removed.length} carpeta(s) · {preview.freedMb} MB
            {preview.removed.length > 0 &&
              ` (${Object.entries(preview.removed.reduce<Record<string, number>>((acc, r) => ((acc[r.reason ?? "otro"] = (acc[r.reason ?? "otro"] ?? 0) + 1), acc), {}))
                .map(([why, n]) => `${n} ${why}`)
                .join(" · ")})`}
            {preview.kept.length ? ` · se conservan ${preview.kept.length}: ${preview.kept.map((k) => `${k.path.split(/[\\/]/).slice(-2).join("/")} (${k.reason})`).join(", ")}` : ""}
          </div>
        )}
      </div>
    </div>
  );
}
