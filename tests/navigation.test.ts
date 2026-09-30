import assert from "node:assert/strict";
import { test } from "node:test";
import { POIS, STATIONS, stationGeometry } from "../src/client/environment/OfficeMap";
import { CollisionMap } from "../src/client/navigation/CollisionMap";
import { NavigationGraph } from "../src/client/navigation/NavigationGraph";

const cm = new CollisionMap();
const nav = new NavigationGraph(cm);

function targets() {
  const out: { id: string; p: { x: number; y: number } }[] = [];
  for (const s of STATIONS) {
    const g = stationGeometry(s);
    out.push({ id: `${s.id}.approach`, p: g.approach });
  }
  for (const p of POIS) out.push({ id: p.id, p: p.kind === "seat" ? nav.seatApproach(p) : p.pos });
  return out;
}

test("todos los puntos de destino son transitables", () => {
  for (const t of targets()) assert.ok(cm.isWalkablePoint(t.p), `${t.id} cae en celda bloqueada (${t.p.x},${t.p.y})`);
});

test("existe camino entre cada puesto y cada punto de interés, sin atravesar obstáculos", () => {
  const ts = targets();
  const starts = STATIONS.map((s) => ({ id: s.id, p: stationGeometry(s).approach }));
  for (const a of starts)
    for (const b of ts) {
      const path = nav.path(a.p, b.p);
      assert.ok(path, `sin camino ${a.id} → ${b.id}`);
      for (let i = 0; i < path!.length - 1; i++) {
        assert.ok(cm.hasClearance(path![i], path![i + 1], 0.05), `segmento atraviesa obstáculo en ${a.id} → ${b.id}: ${JSON.stringify(path![i])} → ${JSON.stringify(path![i + 1])}`);
      }
    }
});

test("Ingeniería → QA pasa por la puerta y el pasillo", () => {
  const diego = stationGeometry(STATIONS.find((s) => s.owner === "diego")!).approach;
  const qa = POIS.find((p) => p.id === "qa_terminal")!.pos;
  const path = nav.path(diego, qa)!;
  assert.ok(path.some((p) => p.y > 10.4 && p.y < 13), "debe salir al pasillo (y entre 10.5 y 13)");
});

test("visitas a escritorios tienen al menos un lado libre", () => {
  for (const s of STATIONS) {
    const g = stationGeometry(s);
    assert.ok(cm.isWalkablePoint(g.visitA) || cm.isWalkablePoint(g.visitB), `sin lugar de visita para ${s.id}`);
  }
});
