import { Fragment, type ReactNode } from "react";

/**
 * Markdown mínimo y seguro para los mensajes de los agentes (sin HTML crudo):
 * `código`, **negrita**, listas con - / • / 1., bloques ``` y enlaces http(s).
 */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*|https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${i++}`;
    if (t.startsWith("`")) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else if (t.startsWith("**")) out.push(<b key={k}>{t.slice(2, -2)}</b>);
    else
      out.push(
        <a key={k} href={t} target="_blank" rel="noreferrer">
          {t}
        </a>,
      );
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function RichText({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split(/\r?\n/);
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    const items = list.items;
    blocks.push(
      <Tag key={`l${blocks.length}`}>
        {items.map((it, j) => (
          <li key={j}>{inline(it, `li${blocks.length}-${j}`)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) code.push(lines[i]);
      blocks.push(<pre key={`c${blocks.length}`}>{code.join("\n")}</pre>);
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*•])\s+(.*)$/);
    const num = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || num) {
      const ordered = !!num;
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push((bullet ?? num)![1]);
      continue;
    }
    flush();
    if (!line.trim()) {
      blocks.push(<div key={`s${blocks.length}`} className="rt-gap" />);
      continue;
    }
    const h = line.match(/^\s*#{1,4}\s+(.*)$/);
    blocks.push(
      <p key={`p${blocks.length}`} className={h ? "rt-h" : undefined}>
        {inline(h ? h[1] : line, `p${blocks.length}`)}
      </p>,
    );
  }
  flush();
  return <Fragment>{blocks}</Fragment>;
}
