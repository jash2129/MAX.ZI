"use client";

import { useState } from "react";

/** A read-only value with a Copy button (a just-made client test link) */
export function CopyField({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="row" style={{ flexWrap: "nowrap" }}>
      <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: 0, fontFamily: "ui-monospace, monospace", fontSize: 13 }} />
      <button
        type="button"
        className="primary"
        onClick={() => {
          void navigator.clipboard?.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          });
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
