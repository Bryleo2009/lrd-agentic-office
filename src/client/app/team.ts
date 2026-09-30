import { AGENTS } from "../../shared/agents";
import type { AgentId, AgentProfile } from "../../shared/types";
import { DEFAULT_APPEARANCE } from "../agents/CharacterRig";
import { useStore } from "./store";

/** Perfil actual del empleado (personalizado por el usuario) con fallback a la definición base. */
export function agentOf(id: AgentId): AgentProfile {
  const p = useStore.getState().team.find((t) => t.id === id);
  if (p) return p;
  const a = AGENTS.find((x) => x.id === id)!;
  return { ...a, gender: "other", appearance: DEFAULT_APPEARANCE, engine: null, customized: false };
}

/** Hook: se re-renderiza cuando cambia el equipo. */
export function useAgentProfile(id: AgentId): AgentProfile {
  useStore((s) => s.team);
  return agentOf(id);
}
