"use client";

import { useState, type ReactNode } from "react";

/**
 * The Agent studio's section menu. Every section stays in the page (hidden, not removed), so the one
 * form still submits all of them: saving never drops a section you didn't open. Without JavaScript
 * every section shows.
 */
export function StudioTabs({ tabs, note, children }: { tabs: Array<{ id: string; label: string; hint: string }>; note?: ReactNode; children: ReactNode }) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");
  return (
    <>
      <nav className="studio-nav" aria-label="Agent sections">
        {tabs.map((t) => (
          <button key={t.id} type="button" aria-pressed={active === t.id} aria-controls={`tab-${t.id}`} onClick={() => setActive(t.id)}>
            {t.label}
            <span>{t.hint}</span>
          </button>
        ))}
        {note && <div className="hint">{note}</div>}
      </nav>
      <div className="studio-main" data-active={active}>
        <style>{`.studio-main[data-active="${active}"] section[data-tab]:not([data-tab="${active}"]){display:none}`}</style>
        {children}
      </div>
    </>
  );
}
