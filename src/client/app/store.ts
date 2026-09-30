import { create } from "zustand";
import type { AgentRuntimeEvent } from "../../shared/events";
import type { AgentId, AgentProfile, AgentSessionInfo, Mission, PublicConfig, RepositoryConfig, RuntimeStatus, Snapshot } from "../../shared/types";

export interface ChatLine {
  id: string;
  agentId: AgentId;
  from: "user" | "agent" | "system";
  text: string;
  at: string;
  pending?: boolean;
}

interface State {
  connected: boolean;
  runtime: RuntimeStatus[];
  missions: Record<string, Mission>;
  missionOrder: string[];
  repositories: RepositoryConfig[];
  config: PublicConfig | null;
  events: AgentRuntimeEvent[];
  sessions: AgentSessionInfo[];
  team: AgentProfile[];
  settingsOpen: boolean;
  chats: Partial<Record<AgentId, ChatLine[]>>;
  chatBusy: Partial<Record<AgentId, boolean>>;
  selected: AgentId | null;
  newMissionOpen: boolean;
  feedOpen: boolean;
  toast: { text: string; tone: "error" | "info" } | null;

  hydrate(s: Snapshot): void;
  addEvent(e: AgentRuntimeEvent): void;
  upsertMission(m: Mission): void;
  setRuntime(r: RuntimeStatus[]): void;
  setTeam(t: AgentProfile[]): void;
  setRepositories(r: RepositoryConfig[]): void;
  setSettingsOpen(v: boolean): void;
  upsertSession(s: AgentSessionInfo): void;
  setConnected(v: boolean): void;
  select(id: AgentId | null): void;
  setNewMission(v: boolean): void;
  setFeedOpen(v: boolean): void;
  pushChat(l: ChatLine): void;
  setChatBusy(id: AgentId, v: boolean): void;
  showToast(text: string, tone?: "error" | "info"): void;
}

const MAX_EVENTS = 600;

export const useStore = create<State>((set, get) => ({
  connected: false,
  runtime: [],
  missions: {},
  missionOrder: [],
  repositories: [],
  config: null,
  events: [],
  sessions: [],
  team: [],
  settingsOpen: false,
  chats: {},
  chatBusy: {},
  selected: null,
  newMissionOpen: false,
  feedOpen: false,
  toast: null,

  hydrate(s) {
    const missions: Record<string, Mission> = {};
    for (const m of s.missions) missions[m.id] = m;
    // reconstruir chats a partir de eventos reales persistidos
    const chats: State["chats"] = {};
    for (const e of s.recentEvents) {
      const meta = (e.metadata ?? {}) as Record<string, unknown>;
      if (!meta.chat || !e.agentId) continue;
      if (e.type === "MESSAGE_SENT" && meta.fromUser) (chats[e.agentId] ??= []).push({ id: e.id, agentId: e.agentId, from: "user", text: e.detail ?? e.title, at: e.timestamp });
      if (e.type === "AGENT_MESSAGE") (chats[e.agentId] ??= []).push({ id: e.id, agentId: e.agentId, from: "agent", text: e.detail ?? e.title, at: e.timestamp });
    }
    set({
      runtime: s.runtime,
      missions,
      missionOrder: s.missions.map((m) => m.id),
      repositories: s.repositories,
      config: s.config,
      events: s.recentEvents.slice(-MAX_EVENTS),
      sessions: s.sessions,
      team: s.team ?? [],
      chats,
    });
  },
  addEvent(e) {
    const events = get().events;
    const next = events.length >= MAX_EVENTS ? events.slice(-MAX_EVENTS + 1) : events.slice();
    next.push(e);
    const meta = (e.metadata ?? {}) as Record<string, unknown>;
    if (meta.chat && e.agentId && e.type === "AGENT_MESSAGE") {
      const chats = { ...get().chats };
      chats[e.agentId] = [...(chats[e.agentId] ?? []), { id: e.id, agentId: e.agentId, from: "agent", text: e.detail ?? e.title, at: e.timestamp }];
      set({ events: next, chats });
      return;
    }
    set({ events: next });
  },
  upsertMission(m) {
    const order = get().missionOrder.includes(m.id) ? get().missionOrder : [m.id, ...get().missionOrder];
    set({ missions: { ...get().missions, [m.id]: m }, missionOrder: order });
  },
  setRuntime(runtime) {
    set({ runtime });
  },
  setTeam(team) {
    set({ team });
  },
  setRepositories(repositories) {
    set({ repositories });
  },
  setSettingsOpen(settingsOpen) {
    set({ settingsOpen });
  },
  upsertSession(s) {
    const others = get().sessions.filter((x) => !(x.missionId === s.missionId && x.agentId === s.agentId));
    set({ sessions: [s, ...others] });
  },
  setConnected(connected) {
    set({ connected });
  },
  select(selected) {
    set({ selected });
  },
  setNewMission(newMissionOpen) {
    set({ newMissionOpen });
  },
  setFeedOpen(feedOpen) {
    set({ feedOpen });
  },
  pushChat(l) {
    const chats = { ...get().chats };
    chats[l.agentId] = [...(chats[l.agentId] ?? []), l];
    set({ chats });
  },
  setChatBusy(id, v) {
    set({ chatBusy: { ...get().chatBusy, [id]: v } });
  },
  showToast(text, tone = "error") {
    set({ toast: { text, tone } });
    setTimeout(() => {
      if (get().toast?.text === text) set({ toast: null });
    }, 6000);
  },
}));
